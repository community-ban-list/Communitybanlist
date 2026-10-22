import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isSameBattlemetricsID, {
  normaliseBattlemetricsID
} from '../../scbl-lib/utils/battlemetrics-id.js';
import classifyBanReason from '../../scbl-lib/utils/classify-ban-reason.js';
import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise BanImporter and BanFetcher together without a database or network requests. The
// database is a stand-in that keeps ban lists, Steam users, bans, the lists' sync state and CBL's
// export ban lists in memory, BattleMetrics and remote lists answer from the tables below, and
// waits between attempts are skipped. The run holds its run lock, so the importer may remove bans.

// Stand-ins for Sequelize's errors.
class DatabaseError extends Error {
  constructor(message, original = {}) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = original;
  }
}
class ForeignKeyConstraintError extends DatabaseError {
  constructor(field) {
    super('Cannot add or update a child row: a foreign key constraint fails', { errno: 1452 });
    this.name = 'SequelizeForeignKeyConstraintError';
    this.fields = [field];
  }
}
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SequelizeValidationError';
  }
}
class ConnectionError extends Error {
  constructor() {
    super('connect ECONNREFUSED 10.0.0.2:3306');
    this.name = 'SequelizeConnectionRefusedError';
  }
}

const banLists = new Map();
const steamUsers = new Map();
const bans = new Map();
const events = [];
const logs = [];
const delays = [];
const findOrCreateCalls = [];
// Errors to throw from Ban.findOrCreate, by ban ID, one for each attempt.
const saveErrors = new Map();
// Ban IDs whose saves are slow.
const slowSaves = new Set();
// Called with each ban's ID as it starts being saved, and with a list's ID as its bans are counted
// for its sync state, after its import.
let onSave = null;
let onCount = null;
let pendingSaves = 0;
let transactions = 0;
// Lines for the log channel must be logged as important, which none of the importer's level-1
// lines may skip.
let verboseLevelOneLines = 0;

const tick = (ticks = 1) =>
  new Promise((resolve) => {
    const next = (left) => (left > 0 ? setImmediate(() => next(left - 1)) : resolve());
    next(ticks);
  });
const time = (value) => (value && typeof value.getTime === 'function' ? value.getTime() : value);
const FIELDS = ['expires', 'expired', 'reason', 'rawReason', 'rawNote'];

// A stored ban as Sequelize returns it: only fields whose value changed are saved, and a missing
// value does not match NULL.
function banInstance(id) {
  const stored = bans.get(id);
  const ban = { ...stored };
  ban.changed = () => {
    const changed = FIELDS.filter((field) => time(ban[field]) !== time(stored[field]));
    return changed.length > 0 ? changed : false;
  };
  ban.save = async () => {
    for (const field of FIELDS) stored[field] = ban[field];
    events.push(['update', id]);
  };
  return ban;
}

const Ban = {
  async findOrCreate({ where, defaults }) {
    findOrCreateCalls.push(where.id);
    if (onSave) onSave(where.id);
    pendingSaves++;
    try {
      await tick(slowSaves.has(where.id) ? 50 : 1);
      const error = saveErrors.get(where.id)?.shift();
      if (error) throw error;
      if (bans.has(where.id)) return [banInstance(where.id), false];
      if (!banLists.has(defaults.banList)) throw new ForeignKeyConstraintError('banList');
      if (!steamUsers.has(defaults.steamUser)) throw new ForeignKeyConstraintError('steamUser');
      bans.set(where.id, { ...defaults });
      events.push(['create', where.id]);
      return [banInstance(where.id), true];
    } finally {
      pendingSaves--;
      events.push(['saved', where.id]);
    }
  },
  // Resolves with the number of bans removed, as MySQL counts them.
  async destroy({ where, transaction }) {
    events.push(['destroy', transaction, [...where.id]]);
    let removed = 0;
    for (const id of where.id)
      if (bans.get(id)?.banList === where.banList) {
        bans.delete(id);
        removed++;
      }
    return removed;
  },
  async count({ where }) {
    if (onCount) onCount(where.banList);
    return [...bans.values()].filter((ban) => ban.banList === where.banList).length;
  }
};

// The lists' BanListSyncs rows, by list. A row is saved as MySQL's INSERT ... ON DUPLICATE KEY
// UPDATE saves it: a new row with all the values given, and an existing one with only the fields
// named. The row of a list that is gone fails its foreign key, as in MySQL. Each save is recorded,
// and syncError, if set, fails every save.
const syncRows = new Map();
const syncSaves = [];
let syncError = null;
const BanListSync = {
  async findAll({ raw }) {
    assert.strictEqual(raw, true);
    return Array.from(syncRows.values(), (row) => ({ ...row }));
  },
  async upsert(values, { fields }) {
    syncSaves.push({ values: { ...values }, fields: [...fields] });
    if (syncError) throw syncError;
    if (!banLists.has(values.banList)) throw new ForeignKeyConstraintError('banList');
    const row = syncRows.get(values.banList);
    if (!row) syncRows.set(values.banList, { ...values });
    else for (const field of fields) row[field] = values[field];
  }
};

// CBL's export ban lists, as { id, battlemetricsID }.
const exportBanLists = [];
const ExportBanList = {
  async findAll({ attributes, raw }) {
    assert.deepStrictEqual([...attributes], ['id', 'battlemetricsID']);
    assert.strictEqual(raw, true);
    return exportBanLists.map((exportBanList) => ({ ...exportBanList }));
  }
};

const BanList = {
  async findAll() {
    return Array.from(banLists.values(), ({ id }) => ({ id }));
  },
  async findByPk(id) {
    events.push(['read list', id]);
    return banLists.get(id) || null;
  }
};

const SteamUser = {
  async bulkCreate(rows, options) {
    assert.deepStrictEqual([...options.updateOnDuplicate], ['id']);
    events.push(['add users', rows.length]);
    for (const { id } of rows) if (!steamUsers.has(id)) steamUsers.set(id, user(id));
  },
  async update(values, { where, transaction }) {
    const ids = Array.isArray(where.id) ? [...where.id] : [where.id];
    events.push(['flags', transaction, ids, Object.keys(values).sort()]);
    for (const id of ids) if (steamUsers.has(id)) Object.assign(steamUsers.get(id), values);
  }
};

const QueryTypes = { SELECT: 'SELECT' };
const sequelize = {
  async query(sql, { replacements, type }) {
    assert.strictEqual(sql, 'SELECT id, steamUser FROM Bans WHERE banList = ?');
    assert.strictEqual(type, QueryTypes.SELECT);
    events.push(['select', replacements[0]]);
    return Array.from(bans.values())
      .filter((ban) => ban.banList === replacements[0])
      .map(({ id, steamUser }) => ({ id, steamUser }));
  },
  async transaction(callback) {
    const transaction = { id: ++transactions };
    events.push(['begin', transaction]);
    try {
      const value = await callback(transaction);
      events.push(['commit', transaction]);
      return value;
    } catch (err) {
      events.push(['rollback', transaction]);
      throw err;
    }
  }
};

// BattleMetrics lists, by source: each page is a list of [uid, SteamID, reason] entries, an error,
// or a function that returns either when the page is fetched. A list in battlemetricsTotals gives
// that count of its bans with each page.
const battlemetricsLists = new Map();
const battlemetricsTotals = new Map();
const battlemetricsRequests = [];

// BattleMetrics' list of the ban lists CBL can see, read a page at a time by
// readBattlemetricsPages: the sources of all the BattleMetrics lists, unless visibleBanLists is set
// to the IDs it gives instead, or to an error.
let visibleBanLists = null;
const banListReads = [];
async function readBattlemetricsPages(endpoint, params) {
  banListReads.push([endpoint, params]);
  const visible =
    visibleBanLists ??
    Array.from(battlemetricsLists.keys()).filter((source) =>
      Array.from(banLists.values()).some((banList) => banList.source === source)
    );
  if (visible instanceof Error) throw visible;
  return visible.map((id) => ({ type: 'banList', id, attributes: { name: `List ${id}` } }));
}
const record = ([uid, steamUser, reason = 'Cheating']) => ({
  type: 'ban',
  attributes: {
    uid,
    timestamp: '2026-01-01T00:00:00.000Z',
    expires: null,
    reason,
    note: null,
    identifiers: [{ type: 'steamID', identifier: steamUser }]
  }
});
async function battlemetrics(method, endpoint, params) {
  battlemetricsRequests.push(params['filter[banList]']);
  const pages = battlemetricsLists.get(params['filter[banList]']);
  const index = Number(params['page[key]'] || 0);
  const page = typeof pages[index] === 'function' ? pages[index]() : pages[index];
  if (page instanceof Error) throw page;
  const next =
    index + 1 < pages.length
      ? `https://api.battlemetrics.com/bans?filter[banList]=${params['filter[banList]']}&page[key]=${index + 1}&page[size]=100`
      : null;
  const total = battlemetricsTotals.get(params['filter[banList]']);
  const meta = total === undefined ? undefined : { total };
  return { data: { meta, data: page.map(record), links: { next } } };
}
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
// A page that fails the first time it is fetched, and returns the entries after that.
const failsOnce = (entries, error = httpError(502)) => {
  let fetched = false;
  return () => {
    if (fetched) return entries;
    fetched = true;
    return error;
  };
};

// Remote lists, by URL: the body of the file, or an error.
const remoteLists = new Map();
const remoteRequests = [];

const env = {};
const dependencies = {
  axios: {
    default: {
      async get(url) {
        remoteRequests.push(url);
        const body = remoteLists.get(url);
        if (body instanceof Error) throw body;
        return { status: 200, data: body };
      }
    }
  },
  crypto: { createHash },
  'scbl-lib/apis': { battlemetrics, readBattlemetricsPages },
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/importer-models': { BanListSync },
  'scbl-lib/db/models': { Ban, BanList, ExportBanList, SteamUser },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: (err) => err instanceof ConnectionError
  },
  'scbl-lib/utils': {
    classifyBanReason,
    describeError,
    isSameBattlemetricsID,
    Logger: {
      verbose: (module, level, message) => {
        if (level === 1) verboseLevelOneLines++;
        logs.push({ level, message });
      },
      // The import no longer posts a progress bar, as the run's status shows how far it has got,
      // so the logger has none to give it.
      important: (module, message) => logs.push({ level: 1, message, important: true })
    },
    normaliseBattlemetricsID
  }
};

const context = vm.createContext({
  URL,
  AbortSignal,
  process: { env },
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  },
  clearTimeout: () => {}
});
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const module = await load('../src/ban-importer.js');
// The importer and the fetcher share the real run-control.js.
const runControl = load('../src/run-control.js');
await module.link(async (specifier) => {
  if (specifier === './ban-fetcher.js') return load('../src/ban-fetcher.js');
  if (specifier === './ban-list-sync.js') return load('../src/ban-list-sync.js');
  if (specifier === './run-control.js') return runControl;
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const BanImporter = module.namespace.default;
const control = (await runControl).namespace;
control.setRunLock({ isHeld: async () => true });

const FRESH = 'refreshed';
function user(id) {
  return {
    id,
    lastRefreshedInfo: FRESH,
    lastRefreshedExport: FRESH,
    lastRefreshedReputationPoints: FRESH,
    lastRefreshedReputationRank: FRESH
  };
}
const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;

function reset() {
  for (const store of [
    banLists,
    steamUsers,
    bans,
    saveErrors,
    remoteLists,
    battlemetricsLists,
    battlemetricsTotals,
    syncRows
  ])
    store.clear();
  for (const list of [
    events,
    logs,
    delays,
    findOrCreateCalls,
    remoteRequests,
    battlemetricsRequests,
    banListReads,
    syncSaves,
    exportBanLists
  ])
    list.length = 0;
  slowSaves.clear();
  onSave = null;
  onCount = null;
  syncError = null;
  visibleBanLists = null;
  transactions = 0;
  delete env.IMPORTER_ALLOW_MASS_REMOVAL;
  delete env.IMPORTER_ACCESS_CHECK;
}

// Add a BattleMetrics ban list with stored bans, each [uid, SteamID], and the pages it will return.
function battlemetricsList(id, stored, pages, source = `bm-${id}`) {
  banLists.set(id, { id, type: 'battlemetrics', source });
  for (const [uid, steamUser] of stored) {
    steamUsers.set(steamUser, user(steamUser));
    bans.set(`${id},${uid}`, {
      id: `${id},${uid}`,
      created: new Date('2026-01-01T00:00:00.000Z'),
      expires: null,
      expired: false,
      reason: classifyBanReason('Cheating', null),
      rawReason: 'Cheating',
      rawNote: null,
      steamUser,
      banList: id
    });
  }
  battlemetricsLists.set(source, pages);
}
// Add a remote ban list with a stored ban for each of the players, and the body it will return.
function remoteList(id, players, body) {
  const source = `https://bans.example/${id}.txt`;
  banLists.set(id, { id, type: 'remote', source });
  remoteLists.set(source, body);
  for (const n of players) {
    steamUsers.set(steamID(n), user(steamID(n)));
    bans.set(`${id},${steamID(n)},null`, {
      id: `${id},${steamID(n)},null`,
      expires: null,
      expired: false,
      reason: classifyBanReason('Cheating'),
      rawReason: 'Cheating',
      rawNote: null,
      steamUser: steamID(n),
      banList: id
    });
  }
}
const pairs = (prefix, from, to) =>
  Array.from({ length: to - from }, (_, i) => [`${prefix}${from + i}`, steamID(from + i)]);
const storedIDs = (list) =>
  [...bans.values()].filter((ban) => ban.banList === list).map((b) => b.id);
const logged = (level, pattern) =>
  logs.filter((log) => log.level === level && pattern.test(log.message));
const run = (options) => new BanImporter(options).importBans();

// Each run ends with one line that sums up the import, printed to the console only, as the run's
// status message in Discord shows the same totals. Level-1 lines are about lists that need looking
// at.
const SUMMARY =
  /^Got [\d,]+ deleted bans?\. Imported [\d,]+ (of [\d,]+ )?ban lists?( before the run stopped)?: /;
const warnings = () => logs.filter((log) => log.level === 1 && !SUMMARY.test(log.message));
function summary() {
  const lines = logs.filter((log) => SUMMARY.test(log.message));
  assert.strictEqual(lines.length, 1, 'One summary line per run');
  assert.strictEqual(lines[0].level, 2, 'The summary line is not posted to Discord');
  assert.ok(!lines[0].important);
  return lines[0].message;
}

// A list that fails part-way through keeps every stored ban, and none of its bans are saved, while
// a complete list in the same run loses exactly the bans it no longer has.
reset();
battlemetricsList(1, pairs('a', 0, 5), [
  pairs('a', 0, 2),
  new Error('Request failed with status code 500')
]);
battlemetricsList(2, pairs('b', 0, 4), [
  pairs('b', 0, 2),
  [...pairs('b', 3, 4), ['b9', steamID(9)]]
]);
let results = await run();
assert.deepStrictEqual(storedIDs(1), ['1,a0', '1,a1', '1,a2', '1,a3', '1,a4']);
assert.ok(!findOrCreateCalls.some((id) => id.startsWith('1,')));
assert.strictEqual(results[0].error, 'Error: Request failed with status code 500');
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 1\) while fetching it, so none of its bans were removed\. Error: Request failed with status code 500$/
  ).length,
  1
);
// It is tried again after the other list, a minute later, and fails the same way.
assert.deepStrictEqual(battlemetricsRequests, ['bm-1', 'bm-1', 'bm-2', 'bm-2', 'bm-1', 'bm-1']);
assert.deepStrictEqual(delays, [60 * 1000]);
assert.strictEqual(results[0].attempt, 2);
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 1\) again while fetching it, so none of its bans were removed\. Error: Request failed with status code 500$/
  ).length,
  1
);
assert.deepStrictEqual(storedIDs(2), ['2,b0', '2,b1', '2,b3', '2,b9']);
const destroyed = events.filter(([type]) => type === 'destroy');
assert.strictEqual(destroyed.length, 1);
assert.deepStrictEqual(destroyed[0][2], ['2,b2']);
// The players who lost a ban are queued for an update in the same transaction as the removal.
const sweep = events.slice(events.findIndex(([type]) => type === 'begin'));
assert.deepStrictEqual(
  sweep.slice(0, 4).map(([type]) => type),
  ['begin', 'flags', 'destroy', 'commit']
);
assert.strictEqual(sweep[1][1], sweep[0][1]);
assert.strictEqual(sweep[2][1], sweep[0][1]);
assert.deepStrictEqual(sweep[1][2], [steamID(2)]);
assert.deepStrictEqual(sweep[1][3], [
  'lastRefreshedExport',
  'lastRefreshedInfo',
  'lastRefreshedReputationPoints',
  'lastRefreshedReputationRank'
]);
assert.strictEqual(steamUsers.get(steamID(2)).lastRefreshedInfo, null);
assert.strictEqual(steamUsers.get(steamID(3)).lastRefreshedInfo, FRESH);
// The new ban's player is queued for an update too, and unchanged bans are not saved again.
assert.strictEqual(steamUsers.get(steamID(9)).lastRefreshedReputationPoints, null);
assert.ok(!events.some(([type]) => type === 'update'));
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 2\): 4 bans fetched, 1 new, 0 updated, 1 removed\.$/).length,
  1
);
assert.deepStrictEqual(
  Array.from(results, ({ id, fetched, created, removed }) => [id, fetched, created, removed]),
  [
    [1, 0, 0, 0],
    [2, 4, 1, 1]
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 2 ban lists: 4 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 1 list failed.'
);

// The import reports the same totals for the run record, with each list's own counts and what went
// wrong. Before it has run, it reports nothing.
reset();
battlemetricsList(1, pairs('a', 0, 5), [
  pairs('a', 0, 2),
  new Error('Request failed with status code 500')
]);
battlemetricsList(2, pairs('b', 0, 4), [
  pairs('b', 0, 2),
  [...pairs('b', 3, 4), ['b9', steamID(9)]]
]);
const reporter = new BanImporter();
// Copied into this test's own objects, as the report is made in the importer's context.
const report = () => JSON.parse(JSON.stringify(reporter.report()));
assert.deepStrictEqual(report(), {
  lists: 0,
  imported: 0,
  fetched: 0,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  failedLists: 0,
  selfImports: 0,
  accessLost: 0,
  accessCheck: 'unused',
  banLists: []
});
await reporter.importBans();
// A list's state is given when it is not ok, and the access check was read.
assert.deepStrictEqual(report(), {
  lists: 2,
  imported: 2,
  fetched: 4,
  new: 1,
  updated: 0,
  removed: 1,
  held: 0,
  failedLists: 1,
  selfImports: 0,
  accessLost: 0,
  accessCheck: 'ok',
  banLists: [
    {
      id: 1,
      fetched: 0,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      state: 'failing',
      attempt: 2,
      error: 'Error: Request failed with status code 500',
      stage: 'fetching it'
    },
    { id: 2, fetched: 4, new: 1, updated: 0, removed: 1, held: 0, stored: 4 }
  ]
});

// Every save has finished before any of the list's bans are removed. The bans it had are read
// before its bans are saved, so what it lost is measured against the bans it had before the run.
reset();
battlemetricsList(3, pairs('c', 0, 6), [
  pairs('c', 0, 3),
  [...pairs('c', 4, 6), ['c7', steamID(7)]]
]);
slowSaves.add('3,c7');
slowSaves.add('3,c0');
await run();
const select = events.findIndex(([type, list]) => type === 'select' && list === 3);
assert.ok(select >= 0 && select < events.findIndex(([type]) => type === 'saved'));
const begin = events.findIndex(([type]) => type === 'begin');
assert.ok(begin > events.findLastIndex(([type, id]) => type === 'saved' && id.startsWith('3,')));
assert.ok(begin > events.findIndex(([type, id]) => type === 'create' && id === '3,c7'));
assert.strictEqual(pendingSaves, 0);
assert.deepStrictEqual(storedIDs(3), ['3,c0', '3,c1', '3,c2', '3,c4', '3,c5', '3,c7']);

// A list that returns no bans keeps its stored bans, with a warning that says how to remove them.
reset();
battlemetricsList(4, pairs('d', 0, 5), [[]]);
await run();
assert.strictEqual(storedIDs(4).length, 5);
assert.ok(!events.some(([type]) => type === 'destroy'));
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 4\): it returned no bans, so its 5 stored bans were kept in case the list is broken\. If the list really is empty, set IMPORTER_ALLOW_MASS_REMOVAL=4 for one run\.$/
  ).length,
  1
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 0 bans fetched, 0 new, 0 updated, 0 removed, 5 held, 0 lists failed.'
);

// Once IMPORTER_ALLOW_MASS_REMOVAL names it, an empty list loses all its bans.
reset();
battlemetricsList(4, pairs('d', 0, 5), [[]]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '4';
await run();
assert.deepStrictEqual(storedIDs(4), []);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 4\): 0 bans fetched, 0 new, 0 updated, 5 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list\. Remove it from the setting once the removal is done\.$/
  ).length,
  1
);
assert.strictEqual(warnings().length, 1);
assert.strictEqual(
  summary(),
  'Got 5 deleted bans. Imported 1 ban list: 0 bans fetched, 0 new, 0 updated, 5 removed, 0 held, 0 lists failed.'
);

// Removing at least 25 bans and 10% of the bans a list had before the run waits for
// IMPORTER_ALLOW_MASS_REMOVAL, however many bans it gained. A list that now returns only other
// bans, as when its source was changed to a bigger list, keeps all its old ones.
for (const [stored, kept, added, held] of [
  [30, 4, 0, true],
  [30, 6, 0, false],
  [300, 270, 0, true],
  [300, 271, 0, false],
  [300, 270, 5, true],
  [300, 271, 5, false],
  [30, 0, 400, true]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, stored), [
    [...pairs('e', 0, kept), ...pairs('n', 1000, 1000 + added)]
  ]);
  const [result] = await run();
  const label = `${stored} stored, ${kept} kept, ${added} added`;
  assert.strictEqual(storedIDs(5).length, (held ? stored : kept) + added, label);
  assert.strictEqual(
    events.some(([type]) => type === 'destroy'),
    !held,
    label
  );
  assert.deepStrictEqual(
    [result.stored, result.held, result.removed],
    held ? [stored, stored - kept, 0] : [stored, 0, stored - kept],
    label
  );
  const holds = logged(
    1,
    new RegExp(
      `^Imported ban list \\(ID: 5\\): ${kept + added} bans fetched, ${added} new, 0 updated\\. Kept the ${stored - kept} of its ${stored} stored bans that it no longer has, .* set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run\\.$`
    )
  );
  assert.strictEqual(holds.length, held ? 1 : 0, label);
  assert.strictEqual(warnings().length, held ? 1 : 0, label);
  assert.match(
    summary(),
    new RegExp(`, ${held ? 0 : stored - kept} removed, ${held ? stored - kept : 0} held, `),
    label
  );
}

// Named in IMPORTER_ALLOW_MASS_REMOVAL, the list that now returns only other bans loses its old ones.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
await run();
assert.strictEqual(storedIDs(5).length, 400);
assert.ok(!storedIDs(5).some((id) => id.startsWith('5,e')));
assert.strictEqual(
  logged(1, /^Imported ban list \(ID: 5\): 400 bans fetched, 400 new, 0 updated, 30 removed, as/)
    .length,
  1
);

reset();
battlemetricsList(5, pairs('e', 0, 2600), [pairs('e', 0, 50)]);
battlemetricsList(6, pairs('f', 0, 30), [pairs('f', 0, 2)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = ' 9, 5 ';
await run();
assert.deepStrictEqual(storedIDs(5).length, 50);
assert.deepStrictEqual(storedIDs(6).length, 30);
// The removal is made in chunks of 1,000 bans, each in its own transaction.
assert.deepStrictEqual(
  events
    .filter(([type]) => type === 'destroy')
    .map(([, transaction, ids]) => [transaction.id, ids.length]),
  [
    [1, 1000],
    [2, 1000],
    [3, 550]
  ]
);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 5\): 50 bans fetched, 0 new, 0 updated, 2550 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list/
  ).length,
  1
);
assert.strictEqual(logged(1, /IMPORTER_ALLOW_MASS_REMOVAL=6 for one run/).length, 1);
assert.strictEqual(
  summary(),
  'Got 2,550 deleted bans. Imported 2 ban lists: 52 bans fetched, 0 new, 0 updated, 2,550 removed, 28 held, 0 lists failed.'
);

// Remote lists: an empty file keeps the list's bans, after a single request, and an error page
// fails the list, which is tried once more after the other list.
reset();
remoteList(7, [7], '');
remoteList(8, [8], '<html><body>Please sign in</body></html>');
await run();
assert.deepStrictEqual(remoteRequests, [
  'https://bans.example/7.txt',
  'https://bans.example/8.txt',
  'https://bans.example/8.txt'
]);
assert.strictEqual(storedIDs(7).length, 1);
assert.strictEqual(storedIDs(8).length, 1);
assert.strictEqual(logged(1, /^Imported ban list \(ID: 7\): it returned no bans/).length, 1);
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 8\) while fetching it, .*error page/).length,
  1
);
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 8\) again while fetching it, .*error page/).length,
  1
);

// An unchanged remote ban has no note, which matches the NULL stored for it, so it is not saved
// again. A changed one is.
reset();
remoteList(9, [1, 2], `${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Teamkilling`);
await run();
assert.deepStrictEqual(
  events.filter(([type]) => type === 'update'),
  [['update', `9,${steamID(2)},null`]]
);
assert.strictEqual(bans.get(`9,${steamID(2)},null`).rawReason, 'Teamkilling');
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 9\): 2 bans fetched, 0 new, 1 updated\.$/).length,
  1
);

// Errors that would only happen again are not retried. A ban that cannot be saved is counted, and
// the rest of the list is still saved and checked for removed bans.
reset();
battlemetricsList(10, pairs('g', 0, 6), [pairs('g', 0, 5)]);
battlemetricsLists.get('bm-10')[0].push(['g8', steamID(8)], ['g9', steamID(9)]);
saveErrors.set('10,g1', [new ValidationError('Validation error: reason cannot be null')]);
saveErrors.set('10,g2', [new ForeignKeyConstraintError('steamUser')]);
// Deadlocks and lock wait timeouts are retried, including the error findOrCreate reports when
// MySQL rolled its transaction back for a deadlock.
saveErrors.set('10,g3', [
  new DatabaseError('Deadlock found when trying to get lock', { errno: 1213 })
]);
saveErrors.set('10,g4', [
  new Error('Transaction cannot be committed because it has been finished with state: rollback'),
  new DatabaseError('Lock wait timeout exceeded', { errno: 1205 })
]);
saveErrors.set('10,g8', [new ConnectionError()]);
results = await run();
const attempts = (id) => findOrCreateCalls.filter((call) => call === id).length;
assert.deepStrictEqual(
  ['10,g0', '10,g1', '10,g2', '10,g3', '10,g4', '10,g8', '10,g9'].map(attempts),
  [1, 1, 1, 2, 3, 2, 1]
);
assert.deepStrictEqual(delays, [5000, 5000, 5000, 5000]);
assert.deepStrictEqual(storedIDs(10), [
  '10,g0',
  '10,g1',
  '10,g2',
  '10,g3',
  '10,g4',
  '10,g8',
  '10,g9'
]);
assert.strictEqual(results[0].failed, 2);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 10\): 7 bans fetched, 2 new, 0 updated, 1 removed, 2 failed to save \(SequelizeValidationError: Validation error: reason cannot be null\)\.$/
  ).length,
  1
);
assert.strictEqual(logged(1, /Attempt/).length, 0);

// A list removed during the run, so that its bans fail its foreign key, is dropped once the list
// is confirmed gone, without retries or a sweep.
reset();
battlemetricsList(11, pairs('h', 0, 3), [
  () => {
    banLists.delete(11);
    for (const id of storedIDs(11)) bans.delete(id);
    return pairs('h', 0, 8);
  }
]);
battlemetricsList(12, [], [pairs('i', 0, 2)]);
await run();
assert.strictEqual(findOrCreateCalls.filter((id) => id.startsWith('11,')).length, 2);
assert.ok(!events.some(([type]) => type === 'begin' || type === 'destroy'));
assert.strictEqual(
  logged(2, /^Skipped ban list \(ID: 11\), as it was removed during the run\.$/).length,
  1
);
assert.strictEqual(warnings().length, 0);
assert.deepStrictEqual(storedIDs(12), ['12,i0', '12,i1']);
assert.deepStrictEqual(delays, []);

// A list removed before it is read is skipped without being fetched.
reset();
battlemetricsList(13, pairs('j', 0, 2), [pairs('j', 0, 2)]);
battlemetricsList(14, pairs('k', 0, 2), [pairs('k', 0, 2)]);
const importer = new BanImporter();
const originalFindAll = BanList.findAll;
BanList.findAll = async () => {
  const lists = await originalFindAll();
  banLists.delete(13);
  return lists;
};
await importer.importBans();
BanList.findAll = originalFindAll;
assert.deepStrictEqual(battlemetricsRequests, ['bm-14']);
assert.strictEqual(logged(2, /^Skipped ban list \(ID: 13\)/).length, 1);

// So is a list removed once its bans are saved, when it is read again before it is swept.
reset();
battlemetricsList(13, pairs('j', 0, 3), [pairs('j', 0, 2)]);
const originalFindByPk = BanList.findByPk;
BanList.findByPk = async (id, options) => {
  if (options?.attributes) {
    banLists.delete(id);
    for (const banID of storedIDs(id)) bans.delete(banID);
  }
  return originalFindByPk(id);
};
results = await run();
BanList.findByPk = originalFindByPk;
assert.deepStrictEqual(
  events.filter(([type]) => type === 'read list'),
  [
    ['read list', 13],
    ['read list', 13]
  ]
);
assert.ok(!events.some(([type]) => type === 'begin' || type === 'destroy'));
assert.ok(results[0].gone);
assert.strictEqual(logged(2, /^Skipped ban list \(ID: 13\)/).length, 1);
assert.strictEqual(warnings().length, 0);

// A list whose bans cannot be saved because the database stays unavailable stops after the
// retries, and keeps its stored bans. It is not fetched again later in the run.
reset();
battlemetricsList(15, pairs('l', 0, 4), [pairs('l', 0, 3)]);
battlemetricsList(16, [], [[]]);
for (const id of ['15,l0', '15,l1', '15,l2'])
  saveErrors.set(
    id,
    Array.from({ length: 5 }, () => new ConnectionError())
  );
await run();
assert.deepStrictEqual([...findOrCreateCalls].sort(), [
  ...Array(5).fill('15,l0'),
  ...Array(5).fill('15,l1')
]);
assert.deepStrictEqual(storedIDs(15), ['15,l0', '15,l1', '15,l2', '15,l3']);
assert.ok(!events.some(([type]) => type === 'begin' || type === 'destroy'));
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 15\) while saving its bans, so none of its bans were removed \(3 bans fetched, 0 new, 0 updated\)\. SequelizeConnectionRefusedError: connect ECONNREFUSED/
  ).length,
  1
);
assert.deepStrictEqual(battlemetricsRequests, ['bm-15', 'bm-16']);
assert.ok(!delays.includes(60 * 1000));

// A list that could not be fetched, e.g. during a short BattleMetrics outage, is tried again a
// minute after the other lists, and its second attempt is imported as usual.
reset();
battlemetricsList(17, pairs('m', 0, 3), [
  pairs('m', 0, 1),
  failsOnce([...pairs('m', 2, 3), ['m5', steamID(5)]])
]);
battlemetricsList(18, pairs('o', 0, 2), [pairs('o', 0, 2)]);
// The import says how many lists it has done, for the run's status: before the first and after
// each one, and then how many of the lists it tried again.
const progress = [];
control.setProgressListener((report) => progress.push({ ...report }));
results = await run();
control.setProgressListener(null);
assert.deepStrictEqual(progress, [
  { done: 0, total: 2, unit: 'ban lists' },
  { done: 1, total: 2, unit: 'ban lists' },
  { done: 2, total: 2, unit: 'ban lists' },
  { done: 0, total: 1, unit: 'ban lists tried again' },
  { done: 1, total: 1, unit: 'ban lists tried again' }
]);
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-17', 'bm-18', 'bm-17', 'bm-17']);
assert.deepStrictEqual(delays, [60 * 1000]);
assert.deepStrictEqual(storedIDs(17), ['17,m0', '17,m2', '17,m5']);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, error }) => [id, attempt, error]),
  [
    [17, 2, undefined],
    [18, 1, undefined]
  ]
);
assert.deepStrictEqual(
  warnings().map((log) => log.message),
  [
    'Failed to import ban list (ID: 17) while fetching it, so none of its bans were removed. Error: Request failed with status code 502',
    'Imported ban list (ID: 17) at the second attempt: 3 bans fetched, 1 new, 0 updated, 1 removed.'
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 2 ban lists: 5 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);

// When no list could be fetched, the source is down, so nothing is tried again.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(502)]);
battlemetricsList(18, pairs('o', 0, 2), [new Error('timeout')]);
await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
assert.deepStrictEqual(delays, []);
assert.strictEqual(warnings().length, 2);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 2 ban lists: 0 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 2 lists failed.'
);
// Nor when the only other list imports one of CBL's export ban lists, as that list is never
// fetched, so says nothing about whether the source is down.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(503)]);
battlemetricsList(18, pairs('o', 0, 2), [httpError(503)]);
battlemetricsList(19, pairs('p', 0, 2), [pairs('p', 0, 2)], 'c0ffee00-cb1e-4a00-b000-0000000000dd');
exportBanLists.push({ id: 3, battlemetricsID: 'c0ffee00-cb1e-4a00-b000-0000000000dd' });
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
assert.deepStrictEqual(delays, []);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, selfImport }) => [id, attempt, selfImport]),
  [
    [17, 1, undefined],
    [18, 1, undefined],
    [19, 1, 3]
  ]
);

// Nor is a list its source refused, e.g. as it was deleted, as that would happen again.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(404)]);
remoteList(19, [1], new Error('getaddrinfo ENOTFOUND bans.example'));
remoteList(20, [2], Object.assign(httpError(403), { code: 'ERR_BAD_REQUEST' }));
battlemetricsList(18, pairs('o', 0, 2), [pairs('o', 0, 2)]);
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
// The remote list that could not be reached is tried 3 times, and 3 more after the other lists.
assert.deepStrictEqual(remoteRequests, [
  ...Array(3).fill('https://bans.example/19.txt'),
  'https://bans.example/20.txt',
  ...Array(3).fill('https://bans.example/19.txt')
]);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, error }) => [id, attempt, Boolean(error)]),
  [
    [17, 1, true],
    [19, 2, true],
    [20, 1, true],
    [18, 1, false]
  ]
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 4 ban lists: 2 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 3 lists failed.'
);

// One line sums up the run, however each list went, and lists without problems are only logged
// to the console.
reset();
battlemetricsList(21, pairs('p', 0, 10), [
  [
    ...pairs('p', 0, 4),
    ['p4', steamID(4), 'Teamkilling'],
    ...pairs('p', 5, 9),
    ['p20', steamID(20)],
    ['p21', steamID(21)]
  ]
]);
battlemetricsList(22, pairs('q', 0, 30), [pairs('q', 0, 2)]);
battlemetricsList(23, pairs('r', 0, 2), [httpError(404)]);
battlemetricsList(24, pairs('s', 0, 3), [[]]);
await run();
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 21\): 11 bans fetched, 2 new, 1 updated, 1 removed\.$/)
    .length,
  1
);
assert.deepStrictEqual(
  warnings().map((log) => Number(log.message.match(/ban list \(ID: (\d+)\)/)[1])),
  [22, 23, 24]
);
assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 23\) while fetching it/).length, 1);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 4 ban lists: 13 bans fetched, 2 new, 1 updated, 1 removed, 31 held, 1 list failed.'
);

// A list given a new type or source while its bans are being saved, with its bans deleted in the
// same transaction as /banlist update does, has the bans fetched from its old source removed, with
// their players queued for an update, instead of being checked for the bans it no longer has.
// Nothing is held, and the next run imports the new source. One worker saves the bans in order
// here, so the change comes between two saves.
for (const change of [{ type: 'remote' }, { source: 'bm-99' }]) {
  reset();
  battlemetricsList(
    25,
    [...pairs('u', 0, 40), ...pairs('x', 100, 105)],
    [pairs('u', 0, 30), pairs('u', 30, 60)]
  );
  onSave = (id) => {
    if (id !== '25,u10') return;
    for (const banID of storedIDs(25)) bans.delete(banID);
    banLists.set(25, { ...banLists.get(25), ...change });
  };
  const [result] = await run({ workers: 1 });
  const label = JSON.stringify(change);
  // The bans saved before the change were deleted with it, and those saved after it are removed.
  assert.deepStrictEqual(storedIDs(25), [], label);
  assert.deepStrictEqual(
    events.filter(([type]) => type === 'destroy').map(([, , ids]) => ids),
    [pairs('u', 0, 60).map(([uid]) => `25,${uid}`)],
    label
  );
  const removal = events.slice(events.findIndex(([type]) => type === 'begin'));
  assert.deepStrictEqual(
    removal.slice(0, 4).map(([type]) => type),
    ['begin', 'flags', 'destroy', 'commit'],
    label
  );
  assert.strictEqual(steamUsers.get(steamID(0)).lastRefreshedInfo, null, label);
  assert.strictEqual(steamUsers.get(steamID(59)).lastRefreshedInfo, null, label);
  // Nothing is swept: the player of an old ban that was not fetched, deleted with the change, is
  // not queued by the run.
  assert.strictEqual(steamUsers.get(steamID(100)).lastRefreshedInfo, FRESH, label);
  assert.deepStrictEqual(
    [result.sourceChanged, result.fetched, result.created, result.removed, result.held],
    [true, 60, 50, 50, 0],
    label
  );
  assert.deepStrictEqual(
    warnings().map(({ message, important }) => [message, important]),
    [
      [
        'Removed the bans fetched for ban list (ID: 25), as its type or source was changed while it was imported (60 bans fetched, 50 new, 0 updated, 50 removed). Its new source is imported on the next run.',
        true
      ]
    ],
    label
  );
  assert.strictEqual(
    summary(),
    'Got 50 deleted bans. Imported 1 ban list: 60 bans fetched, 50 new, 0 updated, 50 removed, 0 held, 0 lists failed.',
    label
  );
}
// The next run imports the new source, and has no bans of the old one to hold.
logs.length = 0;
onSave = null;
battlemetricsLists.set('bm-99', [pairs('v', 0, 20)]);
await run();
assert.deepStrictEqual(
  storedIDs(25),
  pairs('v', 0, 20).map(([uid]) => `25,${uid}`)
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 20 bans fetched, 20 new, 0 updated, 0 removed, 0 held, 0 lists failed.'
);

// Each list's sync state is saved in its BanListSyncs row after its import. row(id) copies a row
// into this test's own objects, with its times as numbers.
function row(id) {
  const saved = syncRows.get(id);
  if (!saved) return undefined;
  const time = (value) => (value && typeof value.getTime === 'function' ? value.getTime() : value);
  return Object.fromEntries(Object.entries(saved).map(([field, value]) => [field, time(value)]));
}
const sha256 = (type, source) =>
  createHash('sha256')
    .update(JSON.stringify([type, source]))
    .digest('hex');
// The columns the import saves on every run, and those a new row, or the row of a list whose type
// or source was changed, also starts with.
const IMPORT_FIELDS = [
  'banList',
  'sourceKey',
  'state',
  'lastAttemptAt',
  'lastSuccessAt',
  'consecutiveFailures',
  'lastError',
  'storedCount',
  'headTotal'
];
const FRESH_FIELDS = {
  lastHeadPollAt: null,
  lastFullScanAt: null,
  nextFullScanAt: null,
  scanReason: null,
  incompleteScans: 0,
  headUids: null,
  replacePending: false,
  allowFullRemovalUntil: null,
  remoteEtag: null,
  remoteLastModified: null,
  remoteBodyHash: null
};
const savedFields = (id) =>
  syncSaves.filter(({ values }) => values.banList === id).map(({ fields }) => [...fields].sort());
// The alerts about lists, posted once each: a list failing 3 runs in a row, CBL losing access to
// one, or to many at once, and one importing a CBL export ban list.
const ALERT =
  /^(Ban list \(ID: \d+\) (has failed to import|is not imported|is not among)|CBL (can no longer read|cannot read|lost access))/;
const alerts = () => logged(1, ALERT).map((log) => log.message);

// After one run, every list that was not removed during it has a row: imported (ok), failed
// (failing), or imported with its removals held (held). It says when the list was tried and last
// imported, how many runs in a row it failed and why, how many bans it has here and BattleMetrics'
// count of them, and the key of its type and source. A new row starts with every column.
reset();
battlemetricsList(1, pairs('a', 0, 3), [pairs('a', 0, 4)]);
battlemetricsTotals.set('bm-1', 4);
battlemetricsList(2, pairs('b', 0, 2), [httpError(503)]);
battlemetricsList(3, pairs('c', 0, 30), [pairs('c', 0, 2)]);
remoteList(4, [1, 2], `${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Cheating`);
battlemetricsList(5, pairs('e', 0, 1), [
  () => {
    banLists.delete(5);
    return pairs('e', 0, 2);
  }
]);
const started = Date.now();
const firstRun = new BanImporter();
await firstRun.importBans();
const ended = Date.now();
assert.deepStrictEqual(
  [...syncRows.keys()].sort((a, b) => a - b),
  [1, 2, 3, 4]
);
const imported = row(1);
assert.ok(imported.lastAttemptAt >= started && imported.lastAttemptAt <= ended);
assert.deepStrictEqual(imported, {
  ...FRESH_FIELDS,
  banList: 1,
  sourceKey: sha256('battlemetrics', 'bm-1'),
  state: 'ok',
  lastAttemptAt: imported.lastAttemptAt,
  lastSuccessAt: imported.lastAttemptAt,
  consecutiveFailures: 0,
  lastError: null,
  storedCount: 4,
  headTotal: 4
});
// Both of the failed list's attempts count as one failed run.
assert.deepStrictEqual(row(2), {
  ...FRESH_FIELDS,
  banList: 2,
  sourceKey: sha256('battlemetrics', 'bm-2'),
  state: 'failing',
  lastAttemptAt: row(2).lastAttemptAt,
  lastSuccessAt: null,
  consecutiveFailures: 1,
  lastError: 'Error: Request failed with status code 503',
  storedCount: 2,
  headTotal: null
});
assert.ok(row(2).lastAttemptAt >= imported.lastAttemptAt);
assert.deepStrictEqual(
  [row(3).state, row(3).storedCount, row(3).consecutiveFailures, row(3).lastError],
  ['held', 30, 0, null]
);
assert.strictEqual(row(3).lastSuccessAt, row(3).lastAttemptAt);
assert.deepStrictEqual(
  [row(4).state, row(4).sourceKey, row(4).storedCount, row(4).headTotal],
  ['ok', sha256('remote', 'https://bans.example/4.txt'), 2, null]
);
assert.deepStrictEqual(savedFields(1), [[...IMPORT_FIELDS, ...Object.keys(FRESH_FIELDS)].sort()]);
// Saving a row posts nothing.
assert.deepStrictEqual(alerts(), []);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(firstRun.report())).banLists.map(({ id, state }) => [id, state]),
  [
    [1, undefined],
    [2, 'failing'],
    [3, 'held'],
    [4, undefined],
    [5, undefined]
  ]
);

// A list that fails 3 runs in a row is posted about once, at the 3rd, and not at the runs after.
// A run's second attempt at it counts with its first. Once it imports again, it is back to ok, with
// a line in the console, and is posted about again only after another 3 failed runs in a row.
reset();
battlemetricsList(6, pairs('f', 0, 2), [httpError(503)]);
// The other list keeps the second attempts going.
battlemetricsList(7, [], [pairs('g', 0, 1)]);
const failureAlert = (lastImported) =>
  `Ban list (ID: 6) has failed to import 3 runs in a row, so its bans may be out of date: ${lastImported}. Its latest error: Error: Request failed with status code 503`;
for (let run = 1; run <= 5; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  await new BanImporter().importBans();
  assert.deepStrictEqual(battlemetricsRequests, ['bm-6', 'bm-7', 'bm-6'], `run ${run}`);
  assert.deepStrictEqual(
    [row(6).state, row(6).consecutiveFailures, row(6).lastSuccessAt],
    ['failing', run, null],
    `run ${run}`
  );
  assert.deepStrictEqual(
    alerts(),
    run === 3
      ? [failureAlert('the importer has no record of importing it from its current source')]
      : [],
    `run ${run}`
  );
  // Its failures are still posted, as on every run.
  assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 6\)/).length, 2, `run ${run}`);
  // Its row is saved once a run, by its second attempt.
  assert.strictEqual(savedFields(6).length, run, `run ${run}`);
}
logs.length = 0;
battlemetricsLists.set('bm-6', [pairs('f', 0, 2)]);
await run();
assert.deepStrictEqual(
  [row(6).state, row(6).consecutiveFailures, row(6).lastError],
  ['ok', 0, null]
);
const lastImported = row(6).lastSuccessAt;
assert.strictEqual(lastImported, row(6).lastAttemptAt);
assert.strictEqual(
  logged(
    2,
    /^Ban list \(ID: 6\) is back to normal: it was imported again, after failing 5 runs in a row\.$/
  ).length,
  1
);
assert.deepStrictEqual(alerts(), []);
battlemetricsLists.set('bm-6', [httpError(503)]);
for (let run = 1; run <= 3; run++) {
  logs.length = 0;
  await new BanImporter().importBans();
  assert.strictEqual(row(6).lastSuccessAt, lastImported);
  assert.deepStrictEqual(
    alerts(),
    run === 3
      ? [failureAlert(`it was last imported at ${new Date(lastImported).toISOString()}`)]
      : [],
    `run ${run} after it imported`
  );
}

// A list's row is saved once the run knows how its import ended. In a list's 3rd run that may fail,
// a first attempt that fails waits for the second, so when the second imports the list, the run is
// not counted as failed, and nothing is posted. When no list can be tried again, as every list
// failed, the first attempt is final: its row is saved after the first pass, and posted about.
const failedTwice = (id, lastSuccessAt) => ({
  banList: id,
  sourceKey: sha256('battlemetrics', `bm-${id}`),
  state: 'failing',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt,
  consecutiveFailures: 2,
  lastError: 'Error: Request failed with status code 503',
  storedCount: 2,
  headTotal: 2
});
const IMPORTED_AT = new Date('2026-10-15T18:00:00.000Z');
reset();
battlemetricsList(40, pairs('a', 0, 2), [failsOnce(pairs('a', 0, 2), httpError(503))]);
battlemetricsList(41, [], [pairs('b', 0, 1)]);
syncRows.set(40, failedTwice(40, IMPORTED_AT));
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-40', 'bm-41', 'bm-40']);
assert.deepStrictEqual([results[0].attempt, results[0].error], [2, undefined]);
assert.deepStrictEqual(
  [row(40).state, row(40).consecutiveFailures, row(40).lastError],
  ['ok', 0, null]
);
assert.strictEqual(savedFields(40).length, 1);
assert.deepStrictEqual(alerts(), []);
assert.strictEqual(logged(2, /is back to normal/).length, 0);
// Its two lines say what happened, as before.
assert.deepStrictEqual(
  warnings().map(({ message }) => message.split(',')[0]),
  [
    'Failed to import ban list (ID: 40) while fetching it',
    'Imported ban list (ID: 40) at the second attempt: 2 bans fetched'
  ]
);
reset();
battlemetricsList(40, pairs('a', 0, 2), [httpError(503)]);
battlemetricsList(41, [], [httpError(503)]);
syncRows.set(40, failedTwice(40, IMPORTED_AT));
await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-40', 'bm-41']);
assert.deepStrictEqual(delays, []);
assert.deepStrictEqual(
  [row(40).state, row(40).consecutiveFailures, row(41).state, row(41).consecutiveFailures],
  ['failing', 3, 'failing', 1]
);
assert.strictEqual(savedFields(40).length, 1);
assert.deepStrictEqual(alerts(), [
  'Ban list (ID: 40) has failed to import 3 runs in a row, so its bans may be out of date: it was last imported at 2026-10-15T18:00:00.000Z. Its latest error: Error: Request failed with status code 503'
]);

// The access check reads BattleMetrics' list of the ban lists CBL can see, once a run, and compares
// their IDs with the lists' sources ignoring case, hyphens and spaces. A list whose source is not
// among them is still fetched and its new bans saved, but none of its bans are removed, even when
// IMPORTER_ALLOW_MASS_REMOVAL names it. It is posted about once, when CBL loses access, without the
// advice to remove it, as its fetch worked, and its row says why. Once CBL can see it again, it is
// checked for removed bans again.
reset();
battlemetricsList(8, pairs('h', 0, 3), [[...pairs('h', 0, 1), ['h9', steamID(9)]]]);
battlemetricsList(9, pairs('i', 0, 3), [pairs('i', 0, 2)], 'C0FFEE00-cb1e-4a00-b000-0000000000cc');
battlemetricsList(10, pairs('j', 0, 3), [pairs('j', 0, 3)]);
visibleBanLists = [' c0ffee00cb1e4a00b0000000000000cc ', 'BM-10', 'another-list'];
env.IMPORTER_ALLOW_MASS_REMOVAL = '8';
let checked = new BanImporter();
results = await checked.importBans();
assert.deepStrictEqual(banListReads, [['ban-lists', undefined]]);
assert.deepStrictEqual(battlemetricsRequests, [
  'bm-8',
  'C0FFEE00-cb1e-4a00-b000-0000000000cc',
  'bm-10'
]);
assert.deepStrictEqual(storedIDs(8), ['8,h0', '8,h1', '8,h2', '8,h9']);
assert.deepStrictEqual(storedIDs(9), ['9,i0', '9,i1']);
assert.ok(
  !events.some(([type, , ids]) => type === 'destroy' && ids.some((id) => id.startsWith('8,')))
);
const NOT_SEEN = 'its source is not among the BattleMetrics ban lists the CBL organisation can see';
assert.deepStrictEqual(
  [row(8).state, row(8).consecutiveFailures, row(8).storedCount, row(8).lastError],
  [
    'access_lost',
    0,
    4,
    'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.'
  ]
);
// The list was fetched in full and its bans saved, so it was last imported now.
assert.strictEqual(row(8).lastSuccessAt, row(8).lastAttemptAt);
assert.deepStrictEqual([row(9).state, row(10).state], ['ok', 'ok']);
assert.deepStrictEqual(alerts(), [
  'Ban list (ID: 8) is not among the BattleMetrics ban lists the CBL organisation can see, although CBL could still read it. Its new bans are saved, but none of its 4 stored bans are removed from it until BattleMetrics lists it again.'
]);
// The list's own line goes only to the console, as the alert says what needs looking at.
assert.strictEqual(
  logged(
    2,
    new RegExp(
      `^Imported ban list \\(ID: 8\\): 2 bans fetched, 1 new, 0 updated\\. None of its bans were checked for removal, as ${NOT_SEEN}\\.$`
    )
  ).length,
  1
);
assert.deepStrictEqual(warnings(), logged(1, ALERT));
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 3 ban lists: 7 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);
let counts = JSON.parse(JSON.stringify(checked.report()));
assert.deepStrictEqual(
  [counts.accessLost, counts.accessCheck, counts.banLists[0].state],
  [1, 'ok', 'access_lost']
);
assert.ok(results[0].accessLost);
// The next run is not posted about again.
logs.length = 0;
await run();
assert.deepStrictEqual([row(8).state, storedIDs(8).length], ['access_lost', 4]);
assert.deepStrictEqual(alerts(), []);
// Once CBL can see the list again, it loses the bans it no longer has.
logs.length = 0;
visibleBanLists = null;
delete env.IMPORTER_ALLOW_MASS_REMOVAL;
await run();
assert.deepStrictEqual(storedIDs(8), ['8,h0', '8,h9']);
assert.deepStrictEqual([row(8).state, row(8).lastError], ['ok', null]);
assert.strictEqual(
  logged(2, /^Ban list \(ID: 8\) is back to normal: CBL can read it on BattleMetrics again\.$/)
    .length,
  1
);
assert.deepStrictEqual(alerts(), []);

// A failed read of BattleMetrics' ban lists never holds up the import: the run goes without the
// check, so no list is marked for it, and says so in the console and the run record.
reset();
battlemetricsList(11, pairs('k', 0, 3), [pairs('k', 0, 2)]);
battlemetricsList(12, pairs('l', 0, 3), [pairs('l', 0, 3)]);
visibleBanLists = new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503');
checked = new BanImporter();
await checked.importBans();
assert.strictEqual(banListReads.length, 1);
assert.deepStrictEqual(battlemetricsRequests, ['bm-11', 'bm-12']);
assert.deepStrictEqual(storedIDs(11), ['11,k0', '11,k1']);
assert.deepStrictEqual([row(11).state, row(12).state], ['ok', 'ok']);
assert.strictEqual(
  logged(
    2,
    /^Could not read which BattleMetrics ban lists the CBL organisation can see, so this run does not check them: Error: BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503$/
  ).length,
  1
);
assert.deepStrictEqual(warnings(), []);
assert.strictEqual(checked.report().accessCheck, 'failed');
// Nor does a read that has a ban list without an ID.
reset();
battlemetricsList(11, pairs('k', 0, 3), [pairs('k', 0, 2)]);
visibleBanLists = ['bm-11', ''];
checked = new BanImporter();
await checked.importBans();
assert.deepStrictEqual([storedIDs(11).length, row(11).state], [2, 'ok']);
assert.strictEqual(checked.report().accessCheck, 'failed');
assert.strictEqual(
  logged(2, /^Could not read .*: Error: BattleMetrics returned a ban list without an ID\.$/).length,
  1
);

// A list CBL had lost access to stays so in a run that cannot tell whether CBL can read it again:
// one whose access check could not be made, or whose fetch failed for another reason. It is not
// swept, posted about again, or said to be back to normal, and its row keeps why it lost access.
// Here the list is not among those BattleMetrics lists, then the check cannot be made, then it is
// not among them again, as its first fetch fails, and at last it is. That failure, and so its
// second attempt, are posted as for any list, as they are not about its access.
reset();
battlemetricsList(50, pairs('t', 0, 3), [pairs('t', 0, 1)]);
battlemetricsList(51, [], [pairs('u', 0, 1)]);
const UNLISTED_ERROR =
  'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.';
for (const [run, visible] of [
  [1, ['bm-51']],
  [2, new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503')],
  [3, ['bm-51']],
  [4, null]
]) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  visibleBanLists = visible;
  battlemetricsLists.set('bm-50', [
    run === 3 ? failsOnce(pairs('t', 0, 1), httpError(503)) : pairs('t', 0, 1)
  ]);
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    battlemetricsRequests,
    run === 3 ? ['bm-50', 'bm-51', 'bm-50'] : ['bm-50', 'bm-51'],
    label
  );
  assert.deepStrictEqual(
    [row(50).state, row(50).lastError, storedIDs(50).length],
    run < 4 ? ['access_lost', UNLISTED_ERROR, 3] : ['ok', null, 1],
    label
  );
  assert.strictEqual(alerts().length, run === 1 ? 1 : 0, label);
  assert.strictEqual(logged(2, /is back to normal/).length, run === 4 ? 1 : 0, label);
  // The start of each line posted about the list: its alert, its failure, and its import.
  assert.deepStrictEqual(
    warnings()
      .filter(({ message }) => message.includes('(ID: 50)'))
      .map(({ message }) => message.replace(/ \(ID: 50\).*$/, '')),
    { 1: ['Ban list'], 2: [], 3: ['Failed to import ban list', 'Imported ban list'], 4: [] }[run],
    label
  );
  if (run === 2)
    assert.strictEqual(
      logged(
        2,
        /^Imported ban list \(ID: 50\): 1 bans fetched, 0 new, 0 updated\. None of its bans were checked for removal, as CBL had lost access to it, and this run could not tell whether it has access again\.$/
      ).length,
      1
    );
}

// With the access check off, a list CBL had lost access to is back to normal once its fetch works,
// as nothing else can show that CBL can read it.
reset();
battlemetricsList(54, pairs('x', 0, 3), [pairs('x', 0, 2)]);
syncRows.set(54, {
  banList: 54,
  sourceKey: sha256('battlemetrics', 'bm-54'),
  state: 'access_lost',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-16T06:00:00.000Z'),
  consecutiveFailures: 0,
  lastError: UNLISTED_ERROR,
  storedCount: 3,
  headTotal: 3
});
await run({ accessCheck: '0' });
assert.deepStrictEqual([row(54).state, storedIDs(54).length], ['ok', 2]);
assert.strictEqual(
  logged(2, /^Ban list \(ID: 54\) is back to normal: CBL can read it on BattleMetrics again\.$/)
    .length,
  1
);
// A list whose source was changed starts afresh, even if CBL had lost access to its old source,
// so a run that cannot tell treats it as it would any new list: it is swept, and not posted about.
reset();
battlemetricsList(55, pairs('y', 0, 3), [pairs('y', 0, 2)], 'bm-55-new');
syncRows.set(55, {
  banList: 55,
  sourceKey: sha256('battlemetrics', 'bm-55'),
  state: 'access_lost',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: null,
  consecutiveFailures: 2,
  lastError: UNLISTED_ERROR,
  storedCount: 3,
  headTotal: 3
});
visibleBanLists = new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503');
await run();
assert.deepStrictEqual(
  [row(55).state, row(55).sourceKey, row(55).lastError, storedIDs(55).length],
  ['ok', sha256('battlemetrics', 'bm-55-new'), null, 2]
);
assert.deepStrictEqual(alerts(), []);

// IMPORTER_ACCESS_CHECK turns the check off with 0, false, off or no, and the import then reads no
// list of ban lists and marks no list for it. It is on by default, and an invalid value leaves it
// on, with a warning in the console. A run without BattleMetrics lists has no need to read it.
for (const [setting, on] of [
  [undefined, true],
  ['', true],
  ['1', true],
  [' yes ', true],
  ['0', false],
  ['false', false],
  ['OFF', false],
  ['no', false],
  ['maybe', true]
]) {
  reset();
  battlemetricsList(13, pairs('m', 0, 3), [pairs('m', 0, 2)]);
  visibleBanLists = [];
  if (setting !== undefined) env.IMPORTER_ACCESS_CHECK = setting;
  checked = new BanImporter();
  await checked.importBans();
  const label = JSON.stringify(setting);
  assert.strictEqual(banListReads.length, on ? 1 : 0, label);
  assert.strictEqual(checked.report().accessCheck, on ? 'ok' : 'off', label);
  assert.deepStrictEqual(
    [row(13).state, storedIDs(13).length],
    on ? ['access_lost', 3] : ['ok', 2],
    label
  );
  assert.strictEqual(
    logged(
      2,
      /^IMPORTER_ACCESS_CHECK is off, so this run does not check which BattleMetrics ban lists the CBL organisation can see\.$/
    ).length,
    on ? 0 : 1,
    label
  );
  assert.strictEqual(
    logged(
      2,
      /^Warning: IMPORTER_ACCESS_CHECK must be 1 or 0, not "maybe", so the access check stays on\.$/
    ).length,
    setting === 'maybe' ? 1 : 0,
    label
  );
}
reset();
remoteList(14, [1], `${steamID(1)}:0 //Cheating`);
checked = new BanImporter();
await checked.importBans();
assert.deepStrictEqual([banListReads.length, checked.report().accessCheck], [0, 'unused']);

// BattleMetrics gives a list that CBL may see, but not its bans, with no bans that it still
// counts. That is not an emptied list: its fetch fails as hidden bans, it is not tried again, none
// of its bans are removed even when IMPORTER_ALLOW_MASS_REMOVAL names it, and CBL is taken to have
// lost access to it, with BattleMetrics' count kept in its row. A list that gives no bans and
// counts none really is empty, and keeps its bans as before, held for confirmation.
reset();
battlemetricsList(15, pairs('n', 0, 5), [[]]);
battlemetricsTotals.set('bm-15', 4376);
battlemetricsList(16, pairs('o', 0, 5), [[]]);
battlemetricsTotals.set('bm-16', 0);
battlemetricsList(17, [], [pairs('p', 0, 1)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '15';
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-15', 'bm-16', 'bm-17']);
assert.deepStrictEqual([storedIDs(15).length, storedIDs(16).length], [5, 5]);
assert.ok(!events.some(([type]) => type === 'destroy'));
const HIDDEN =
  'Error: BattleMetrics counts 4,376 bans on the list but gave none of them, so CBL may no longer be allowed to see its bans.';
assert.deepStrictEqual(
  [row(15).state, row(15).headTotal, row(15).consecutiveFailures, row(15).lastError],
  ['access_lost', 4376, 1, HIDDEN]
);
assert.deepStrictEqual([row(16).state, row(16).headTotal], ['held', 0]);
assert.strictEqual(
  logged(
    1,
    new RegExp(
      `^Failed to import ban list \\(ID: 15\\) while fetching it, so none of its bans were removed\\. ${RegExp.escape(HIDDEN)}$`
    )
  ).length,
  1
);
assert.deepStrictEqual(alerts(), [
  "CBL cannot read ban list (ID: 15) on BattleMetrics, as BattleMetrics counts 4,376 bans on it but gave none of them, so none of its 5 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
]);
assert.strictEqual(logged(1, /^Imported ban list \(ID: 16\): it returned no bans/).length, 1);
assert.deepStrictEqual(
  [results[0].retry, Boolean(results[0].accessLost), Boolean(results[1].accessLost)],
  [false, true, false]
);

// BattleMetrics answers HTTP 404, Unknown ban list, for a list CBL cannot see. That list is taken
// to have lost access, and is not tried again. Its failed runs go on counting, without the alert
// for 3 failed runs in a row, as its loss of access was posted. Its failure is posted in the run
// that finds it, and after that only goes to the console. Any other 404 is a failure, posted on
// every run.
const unknownBanList = () =>
  Object.assign(new Error('BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'), {
    name: 'ApiError',
    status: 404,
    titles: ['Unknown ban list'],
    response: { status: 404, data: { errors: [{ status: '404', title: 'Unknown ban list' }] } }
  });
reset();
battlemetricsList(18, pairs('q', 0, 2), [unknownBanList()]);
battlemetricsList(19, pairs('r', 0, 2), [httpError(404)]);
battlemetricsList(20, [], [pairs('s', 0, 1)]);
for (let run = 1; run <= 3; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  await new BanImporter().importBans();
  assert.deepStrictEqual(battlemetricsRequests, ['bm-18', 'bm-19', 'bm-20'], `run ${run}`);
  assert.deepStrictEqual(
    [row(18).state, row(18).consecutiveFailures, row(19).state, row(19).consecutiveFailures],
    ['access_lost', run, 'failing', run],
    `run ${run}`
  );
  assert.deepStrictEqual(
    alerts(),
    {
      1: [
        "CBL cannot read ban list (ID: 18) on BattleMetrics, as BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list), so none of its 2 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
      ],
      2: [],
      3: [
        'Ban list (ID: 19) has failed to import 3 runs in a row, so its bans may be out of date: the importer has no record of importing it from its current source. Its latest error: Error: Request failed with status code 404'
      ]
    }[run],
    `run ${run}`
  );
  const failure = /^Failed to import ban list \(ID: 18\) while fetching it, .*Unknown ban list\)$/;
  assert.deepStrictEqual(
    [logged(1, failure).length, logged(2, failure).length],
    run === 1 ? [1, 0] : [0, 1],
    `run ${run}`
  );
  assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 19\)/).length, 1, `run ${run}`);
}
assert.strictEqual(
  row(18).lastError,
  'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'
);
// A list imported before it is said to be one CBL can no longer read, and its failure is posted,
// as its row was ok.
reset();
battlemetricsList(18, pairs('q', 0, 2), [unknownBanList()]);
syncRows.set(18, {
  banList: 18,
  sourceKey: sha256('battlemetrics', 'bm-18'),
  state: 'ok',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-16T06:00:00.000Z'),
  consecutiveFailures: 0,
  lastError: null,
  storedCount: 2,
  headTotal: 2
});
await run();
assert.match(alerts()[0], /^CBL can no longer read ban list \(ID: 18\) on BattleMetrics, as /);
assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 18\)/).length, 1);

// A 404 Unknown ban list, then a 503, then the 404 again: the list stays access_lost, its failures
// count 1, 2, 3, and it is posted about once. The 404's failure is posted in the first run only,
// and the 503's at both attempts, as for any list, as it says something new. Both attempts of the
// run with the 503 count as one run, which keeps why the list lost access.
reset();
battlemetricsList(52, pairs('v', 0, 2), [unknownBanList()]);
battlemetricsList(53, [], [pairs('w', 0, 1)]);
for (const [run, page] of [
  [1, unknownBanList()],
  [2, httpError(503)],
  [3, unknownBanList()]
]) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  battlemetricsLists.set('bm-52', [page]);
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    battlemetricsRequests,
    run === 2 ? ['bm-52', 'bm-53', 'bm-52'] : ['bm-52', 'bm-53'],
    label
  );
  assert.deepStrictEqual(
    [row(52).state, row(52).consecutiveFailures, row(52).lastError],
    ['access_lost', run, 'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'],
    label
  );
  assert.strictEqual(alerts().length, run === 1 ? 1 : 0, label);
  const failures = /^Failed to import ban list \(ID: 52\)/;
  assert.deepStrictEqual(
    [logged(1, failures).length, logged(2, failures).length],
    { 1: [1, 0], 2: [2, 0], 3: [0, 1] }[run],
    label
  );
  assert.deepStrictEqual(storedIDs(52), ['52,v0', '52,v1'], label);
}

// When at least 3 lists, and at least half of the BattleMetrics lists the run tried, lose access
// in the same run, CBL's own BattleMetrics token, or its role in the CBL organisation, is the
// likelier cause, so they are posted about together, once, with the advice to check the token
// before removing any of them. Their rows and their failures are as for one list. Here BattleMetrics
// gives 3 lists' counts but not their bans, does not know a 4th, and does not list a 5th, of 7.
reset();
for (const id of [60, 61, 62]) {
  battlemetricsList(id, pairs(`h${id}-`, 0, 2), [[]]);
  battlemetricsTotals.set(`bm-${id}`, 40);
}
battlemetricsList(63, pairs('i', 0, 2), [pairs('i', 0, 2)]);
battlemetricsList(64, pairs('j', 0, 2), [unknownBanList()]);
battlemetricsList(65, [], [pairs('k', 0, 1)]);
battlemetricsList(66, [], [pairs('l', 0, 1)]);
visibleBanLists = ['bm-60', 'bm-61', 'bm-62', 'bm-64', 'bm-65', 'bm-66'];
for (let run = 1; run <= 2; run++) {
  logs.length = 0;
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    [60, 61, 62, 63, 64, 65].map((id) => row(id).state),
    [...Array(5).fill('access_lost'), 'ok'],
    label
  );
  assert.deepStrictEqual(
    alerts(),
    run === 1
      ? [
          "CBL lost access to 5 of the 7 BattleMetrics ban lists it tried in this run (IDs: 60, 61, 62, 63, 64): it cannot read them, or BattleMetrics does not list them among the ban lists the CBL organisation can see. So many at once points at CBL's BattleMetrics token, or its role in the CBL organisation, rather than at the lists' owners, so check the token before removing any of these lists. None of their bans are removed while this lasts."
        ]
      : [],
    label
  );
  assert.strictEqual(logged(1, /^Failed to import ban list/).length, run === 1 ? 4 : 0, label);
}
assert.deepStrictEqual([storedIDs(60).length, storedIDs(64).length], [2, 2]);
// Fewer are posted about one by one.
reset();
for (const id of [60, 61]) {
  battlemetricsList(id, pairs(`h${id}-`, 0, 2), [[]]);
  battlemetricsTotals.set(`bm-${id}`, 40);
}
for (const id of [62, 63, 64]) battlemetricsList(id, [], [pairs(`m${id}-`, 0, 1)]);
await run();
assert.deepStrictEqual(
  alerts().map((alert) => alert.slice(0, 32)),
  ['CBL cannot read ban list (ID: 60', 'CBL cannot read ban list (ID: 61']
);

// If CBL's export ban lists, or the lists' rows, cannot be read, nothing is imported: a list that
// imports an export ban list could not be told from the others, and every list's row would look
// new, so its alerts would be posted again. No list is read, fetched, saved or swept, and no row is
// saved or posted about.
for (const [model, error] of [
  [ExportBanList, new Error('SELECT command denied to user for table ExportBanLists')],
  [BanListSync, new Error("Table 'cbl.BanListSyncs' doesn't exist")]
]) {
  reset();
  battlemetricsList(70, pairs('n', 0, 2), [pairs('n', 0, 1)]);
  battlemetricsList(71, pairs('o', 0, 2), [[]]);
  battlemetricsTotals.set('bm-71', 2);
  exportBanLists.push({ id: 5, battlemetricsID: 'bm-70' });
  syncRows.set(71, { ...failedTwice(71, IMPORTED_AT), state: 'access_lost' });
  const findAll = model.findAll;
  model.findAll = async () => {
    throw error;
  };
  await assert.rejects(run(), { message: error.message });
  model.findAll = findAll;
  const label = error.message;
  assert.deepStrictEqual([battlemetricsRequests, findOrCreateCalls], [[], []], label);
  assert.ok(!events.some(([type]) => ['read list', 'begin', 'destroy'].includes(type)), label);
  assert.deepStrictEqual([storedIDs(70).length, storedIDs(71).length], [2, 2], label);
  assert.deepStrictEqual(syncSaves, [], label);
  assert.deepStrictEqual(alerts(), [], label);
}

// An alert is posted only once its row is saved, so a row that cannot be saved is posted about by
// the next run that saves it, once.
reset();
battlemetricsList(72, pairs('p', 0, 2), [[]]);
battlemetricsTotals.set('bm-72', 2);
battlemetricsList(73, pairs('q', 0, 1), [pairs('q', 0, 1)], 'c0ffee00-cb1e-4a00-b000-0000000000ee');
exportBanLists.push({ id: 6, battlemetricsID: 'c0ffee00-cb1e-4a00-b000-0000000000ee' });
syncError = new ValidationError('Validation error: Validation len on lastError failed');
await run();
assert.deepStrictEqual([syncRows.size, alerts()], [0, []]);
assert.strictEqual(logged(2, /^Could not save the sync state of ban list/).length, 2);
for (let run = 1; run <= 2; run++) {
  syncError = null;
  logs.length = 0;
  await new BanImporter().importBans();
  // The list that imports an export ban list is posted about at once, and the one CBL cannot read
  // once every list has been tried.
  assert.deepStrictEqual(
    alerts().map((alert) => alert.slice(0, 32)),
    run === 1 ? ['Ban list (ID: 73) is not importe', 'CBL cannot read ban list (ID: 72'] : [],
    `run ${run} after the failed save`
  );
}
// A failed fetch that never got BattleMetrics' count of the list's bans keeps the count the row has.
reset();
battlemetricsList(74, pairs('r', 0, 2), [httpError(500)]);
syncRows.set(74, {
  ...failedTwice(74, IMPORTED_AT),
  state: 'ok',
  consecutiveFailures: 0,
  lastError: null,
  headTotal: 4
});
await run();
assert.deepStrictEqual([row(74).state, row(74).headTotal], ['failing', 4]);

// With IMPORTER_ACCESS_CHECK=0, the other two signs of lost access still count: a 404 Unknown ban
// list, and a list that gives no bans but counts some. Neither list is swept.
reset();
battlemetricsList(75, pairs('s', 0, 2), [unknownBanList()]);
battlemetricsList(76, pairs('t', 0, 2), [[]]);
battlemetricsTotals.set('bm-76', 9);
battlemetricsList(77, [], [pairs('u', 0, 1)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '76';
checked = new BanImporter({ accessCheck: '0' });
await checked.importBans();
assert.deepStrictEqual(
  [row(75).state, row(76).state, storedIDs(75).length, storedIDs(76).length],
  ['access_lost', 'access_lost', 2, 2]
);
assert.deepStrictEqual([checked.report().accessCheck, banListReads.length], ['off', 0]);
assert.ok(!events.some(([type]) => type === 'destroy'));

// A BattleMetrics list whose source is one of CBL's own export ban lists, however its case, hyphens
// and spaces are written, is neither fetched nor swept, so its bans stay as they are until it is
// removed. It is posted about once, and its row says so, without a time it was tried. A remote
// list with the same source, an export ban list without a BattleMetrics ID, and a source that is
// only part of an export ban list's ID are imported as usual.
const EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000aa';
const OTHER_EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000bb';
reset();
exportBanLists.push(
  { id: 12, battlemetricsID: EXPORT_ID },
  { id: 13, battlemetricsID: null },
  { id: 14, battlemetricsID: ' - ' },
  { id: 15, battlemetricsID: ` ${OTHER_EXPORT_ID.toUpperCase()} ` }
);
battlemetricsList(21, pairs('t', 0, 3), [pairs('t', 0, 1)], EXPORT_ID.toUpperCase());
battlemetricsList(22, pairs('u', 0, 2), [pairs('u', 0, 1)], EXPORT_ID.replace(/-/g, ''));
battlemetricsList(23, pairs('v', 0, 2), [pairs('v', 0, 1)], ` ${OTHER_EXPORT_ID} `);
battlemetricsList(24, pairs('w', 0, 3), [pairs('w', 0, 2)], EXPORT_ID.slice(0, 8));
banLists.set(25, { id: 25, type: 'remote', source: EXPORT_ID });
remoteLists.set(EXPORT_ID, `${steamID(1)}:0 //Cheating`);
for (let run = 1; run <= 2; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  remoteRequests.length = 0;
  checked = new BanImporter();
  await checked.importBans();
  assert.deepStrictEqual(battlemetricsRequests, [EXPORT_ID.slice(0, 8)], `run ${run}`);
  assert.deepStrictEqual(remoteRequests, [EXPORT_ID], `run ${run}`);
  assert.deepStrictEqual(
    [21, 22, 23].map((id) => storedIDs(id).length),
    [3, 2, 2],
    `run ${run}`
  );
  for (const id of [21, 22, 23])
    assert.deepStrictEqual(
      [row(id).state, row(id).lastAttemptAt, row(id).lastSuccessAt, row(id).consecutiveFailures],
      ['self_import', null, null, 0],
      `run ${run}, list ${id}`
    );
  assert.deepStrictEqual(
    [row(21).storedCount, row(23).storedCount, row(24).state, row(25).state],
    [3, 2, 'ok', 'ok'],
    `run ${run}`
  );
  assert.deepStrictEqual(storedIDs(24), ['24,w0', '24,w1']);
  assert.deepStrictEqual(
    alerts(),
    run === 1
      ? [
          "Ban list (ID: 21) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 3 stored bans are kept until the list is removed with /banlist remove, which removes them too.",
          "Ban list (ID: 22) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 2 stored bans are kept until the list is removed with /banlist remove, which removes them too.",
          "Ban list (ID: 23) is not imported, as its source is CBL's own export ban list (#15), and importing it would feed the players CBL exports back in as new bans. Its 2 stored bans are kept until the list is removed with /banlist remove, which removes them too."
        ]
      : [],
    `run ${run}`
  );
  assert.strictEqual(
    logged(
      2,
      /^Skipped ban list \(ID: 21\), as its source is CBL's own export ban list \(#12\), so none of its bans were fetched or removed\.$/
    ).length,
    1,
    `run ${run}`
  );
  counts = JSON.parse(JSON.stringify(checked.report()));
  assert.deepStrictEqual(
    [counts.selfImports, counts.banLists.map(({ state }) => state)],
    [3, ['self_import', 'self_import', 'self_import', undefined, undefined]],
    `run ${run}`
  );
  assert.strictEqual(
    summary(),
    run === 1
      ? 'Got 1 deleted ban. Imported 5 ban lists: 3 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
      : 'Got 0 deleted bans. Imported 5 ban lists: 3 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 0 lists failed.',
    `run ${run}`
  );
}

// A list whose type or source was changed since its row was saved, as /banlist update does, starts
// afresh: what was known about its old source, such as its failures, is forgotten, and every
// column of its row is saved again. Otherwise only the import's own columns are saved, so a value
// the bot set in another column is kept.
reset();
battlemetricsList(26, pairs('x', 0, 2), [httpError(503)]);
battlemetricsList(27, [], [pairs('y', 0, 1)]);
await run();
await run();
const due = new Date('2026-10-16T12:00:00.000Z');
syncRows.get(26).nextFullScanAt = due;
syncSaves.length = 0;
await run();
assert.deepStrictEqual([row(26).consecutiveFailures, row(26).nextFullScanAt], [3, due.getTime()]);
// The row is saved once, by the list's second attempt.
assert.deepStrictEqual(savedFields(26), [[...IMPORT_FIELDS].sort()]);
for (const id of storedIDs(26)) bans.delete(id);
banLists.set(26, { ...banLists.get(26), source: 'bm-new' });
battlemetricsLists.set('bm-new', [httpError(503)]);
logs.length = 0;
syncSaves.length = 0;
await run();
assert.deepStrictEqual(
  [row(26).sourceKey, row(26).consecutiveFailures, row(26).nextFullScanAt, row(26).storedCount],
  [sha256('battlemetrics', 'bm-new'), 1, null, 0]
);
assert.deepStrictEqual(savedFields(26).at(-1), [
  ...[...IMPORT_FIELDS, ...Object.keys(FRESH_FIELDS)].sort()
]);
assert.deepStrictEqual(alerts(), []);

// A list removed after its import, before its row is saved, has no row: its foreign key fails, as
// the list is gone, which is not tried again and needs no warning. So does a list removed during
// its import.
reset();
battlemetricsList(28, pairs('z', 0, 2), [pairs('z', 0, 2)]);
battlemetricsList(29, [], [pairs('a', 0, 1)]);
onCount = (id) => {
  if (id === 28) banLists.delete(28);
};
await run();
assert.deepStrictEqual([...syncRows.keys()], [29]);
assert.strictEqual(savedFields(28).length, 1);
assert.strictEqual(logged(2, /Could not save the sync state/).length, 0);
assert.deepStrictEqual(warnings(), []);

// A row that cannot be saved, as the database stays unavailable, costs the list only its row: its
// import is unaffected, and the console says so.
reset();
battlemetricsList(30, pairs('b', 0, 3), [pairs('b', 0, 2)]);
syncError = new ConnectionError();
results = await run();
assert.deepStrictEqual(storedIDs(30), ['30,b0', '30,b1']);
assert.strictEqual(results[0].error, undefined);
assert.strictEqual(syncSaves.length, 5);
assert.deepStrictEqual(delays, [5000, 5000, 5000, 5000]);
assert.strictEqual(
  logged(
    2,
    /^Could not save the sync state of ban list \(ID: 30\): SequelizeConnectionRefusedError: connect ECONNREFUSED/
  ).length,
  1
);
assert.deepStrictEqual(warnings(), []);

// A run asked to stop while a list's bans are being saved finishes the saves under way, each with
// its player's update, and starts no more. None of the list's bans are removed, as the bans it did
// not save would look removed, and no other list is imported. The summary counts the lists
// imported before the run stopped. This stops the importer's run control, so it comes last.
reset();
battlemetricsList(29, pairs('r', 0, 2), [pairs('r', 0, 1)]);
battlemetricsList(30, pairs('s', 0, 4), [pairs('s', 2, 10)]);
battlemetricsList(31, pairs('t', 0, 2), [pairs('t', 0, 2)]);
onSave = (id) => {
  if (id === '30,s5') control.requestStop('it received SIGTERM');
};
const stoppedImporter = new BanImporter();
const stopped = await stoppedImporter.importBans().catch((err) => err);
assert.strictEqual(stopped.name, 'RunStopped');
assert.strictEqual(stopped.reason, 'it received SIGTERM');
assert.deepStrictEqual(findOrCreateCalls, ['29,r0', '30,s2', '30,s3', '30,s4', '30,s5']);
assert.strictEqual(pendingSaves, 0);
assert.deepStrictEqual(storedIDs(29), ['29,r0']);
assert.deepStrictEqual(storedIDs(30), ['30,s0', '30,s1', '30,s2', '30,s3', '30,s4', '30,s5']);
assert.strictEqual(steamUsers.get(steamID(5)).lastRefreshedExport, null);
assert.strictEqual(steamUsers.get(steamID(6)).lastRefreshedExport, FRESH);
assert.deepStrictEqual(
  events.filter(([type]) => type === 'destroy').map(([, , ids]) => ids),
  [['29,r1']]
);
assert.ok(!events.some(([type, id]) => type === 'read list' && id === 31));
assert.deepStrictEqual(battlemetricsRequests, ['bm-29', 'bm-30']);
// The list imported before the stop has its row, and the one stopped part-way has none, as its
// import neither failed nor finished.
assert.deepStrictEqual([...syncRows.keys()], [29]);
assert.strictEqual(row(29).state, 'ok');
// The list it stopped in the middle of has a line of its own, which says what it saved.
assert.deepStrictEqual(
  warnings().map(({ message, important }) => [message, important]),
  [
    [
      'Stopped importing ban list (ID: 30) while saving its bans, as the run is stopping, so none of its bans were removed (8 bans fetched, 2 new, 0 updated).',
      true
    ]
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 1 of 3 ban lists before the run stopped: 1 ban fetched, 0 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);
// Its report for the run record counts the same lists as its summary.
assert.deepStrictEqual(JSON.parse(JSON.stringify(stoppedImporter.report())), {
  lists: 3,
  imported: 1,
  fetched: 1,
  new: 0,
  updated: 0,
  removed: 1,
  held: 0,
  failedLists: 0,
  selfImports: 0,
  accessLost: 0,
  accessCheck: 'ok',
  banLists: [{ id: 29, fetched: 1, new: 0, updated: 0, removed: 1, held: 0, stored: 2 }]
});

assert.strictEqual(verboseLevelOneLines, 0, 'Lines for the log channel are logged as important');

console.log(
  'Ban import checks passed: complete lists only, awaited saves, holds, empty lists, second attempts, retries, source changes, sync state, the access check, lost access, self-imports, stops and the run summary.'
);
