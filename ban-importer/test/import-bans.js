import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import classifyBanReason from '../../scbl-lib/utils/classify-ban-reason.js';
import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise BanImporter and BanFetcher together without a database or network requests. The
// database is a stand-in that keeps ban lists, Steam users and bans in memory, BattleMetrics and
// remote lists answer from the tables below, and waits between attempts are skipped. The run holds
// its run lock, so the importer may remove bans.

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
// Called with each ban's ID as it starts being saved.
let onSave = null;
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
// or a function that returns either when the page is fetched.
const battlemetricsLists = new Map();
const battlemetricsRequests = [];
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
  return { data: { data: page.map(record), links: { next } } };
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
  'scbl-lib/apis': { battlemetrics },
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/models': { Ban, BanList, SteamUser },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: (err) => err instanceof ConnectionError
  },
  'scbl-lib/utils': {
    classifyBanReason,
    describeError,
    Logger: {
      verbose: (module, level, message) => {
        if (level === 1) verboseLevelOneLines++;
        logs.push({ level, message });
      },
      important: (module, message) => logs.push({ level: 1, message, important: true }),
      discordProgressBar: () => ({})
    }
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
  for (const store of [banLists, steamUsers, bans, saveErrors, remoteLists, battlemetricsLists])
    store.clear();
  for (const list of [events, logs, delays, findOrCreateCalls, remoteRequests]) list.length = 0;
  battlemetricsRequests.length = 0;
  slowSaves.clear();
  onSave = null;
  transactions = 0;
  delete env.IMPORTER_ALLOW_MASS_REMOVAL;
}

// Add a BattleMetrics ban list with stored bans, each [uid, SteamID], and the pages it will return.
function battlemetricsList(id, stored, pages) {
  banLists.set(id, { id, type: 'battlemetrics', source: `bm-${id}` });
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
  battlemetricsLists.set(`bm-${id}`, pages);
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

// Each run ends with one important level-1 line, posted to Discord, that sums up the import. Other
// level-1 lines are about lists that need looking at.
const SUMMARY =
  /^Got [\d,]+ deleted bans?\. Imported [\d,]+ (of [\d,]+ )?ban lists?( before the run stopped)?: /;
const warnings = () => logs.filter((log) => log.level === 1 && !SUMMARY.test(log.message));
function summary() {
  const lines = logs.filter((log) => SUMMARY.test(log.message));
  assert.strictEqual(lines.length, 1, 'One summary line per run');
  assert.strictEqual(lines[0].level, 1);
  assert.ok(lines[0].important);
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
results = await run();
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
const stopped = await run().catch((err) => err);
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

assert.strictEqual(verboseLevelOneLines, 0, 'Lines for the log channel are logged as important');

console.log(
  'Ban import checks passed: complete lists only, awaited saves, holds, empty lists, second attempts, retries, source changes, stops and the run summary.'
);
