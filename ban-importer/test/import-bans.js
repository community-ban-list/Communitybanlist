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
  async destroy({ where, transaction }) {
    events.push(['destroy', transaction, [...where.id]]);
    for (const id of where.id) if (bans.get(id)?.banList === where.banList) bans.delete(id);
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

// BattleMetrics lists, by source: each page is a list of [uid, SteamID] pairs, or an error.
const battlemetricsLists = new Map();
const battlemetricsRequests = [];
const record = ([uid, steamUser]) => ({
  type: 'ban',
  attributes: {
    uid,
    timestamp: '2026-01-01T00:00:00.000Z',
    expires: null,
    reason: 'Cheating',
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

// Remote lists, by URL: the body of the file.
const remoteLists = new Map();
const remoteRequests = [];

const env = {};
const dependencies = {
  axios: {
    default: {
      async get(url) {
        remoteRequests.push(url);
        return { status: 200, data: remoteLists.get(url) };
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
  }
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
const pairs = (prefix, from, to) =>
  Array.from({ length: to - from }, (_, i) => [`${prefix}${from + i}`, steamID(from + i)]);
const storedIDs = (list) =>
  [...bans.values()].filter((ban) => ban.banList === list).map((b) => b.id);
const logged = (level, pattern) =>
  logs.filter((log) => log.level === level && pattern.test(log.message));
const run = (options) => new BanImporter(options).importBans();

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
assert.deepStrictEqual(storedIDs(2), ['2,b0', '2,b1', '2,b3', '2,b9']);
const destroyed = events.filter(([type]) => type === 'destroy');
assert.strictEqual(destroyed.length, 1);
assert.deepStrictEqual(destroyed[0][2], ['2,b2']);
// The players who lost a ban are queued for an update in the same transaction as the removal.
const sweep = events.slice(events.findIndex(([type]) => type === 'begin'));
assert.deepStrictEqual(
  sweep.map(([type]) => type),
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

// Every save has finished before the list's stored bans are compared with what it returned.
reset();
battlemetricsList(3, pairs('c', 0, 6), [
  pairs('c', 0, 3),
  [...pairs('c', 4, 6), ['c7', steamID(7)]]
]);
slowSaves.add('3,c7');
slowSaves.add('3,c0');
await run();
const select = events.findIndex(([type, list]) => type === 'select' && list === 3);
assert.ok(select > events.findLastIndex(([type, id]) => type === 'saved' && id.startsWith('3,')));
assert.ok(select > events.findIndex(([type, id]) => type === 'create' && id === '3,c7'));
assert.strictEqual(pendingSaves, 0);
assert.deepStrictEqual(storedIDs(3), ['3,c0', '3,c1', '3,c2', '3,c4', '3,c5', '3,c7']);

// A list that returns no bans keeps its stored bans, with a warning.
reset();
battlemetricsList(4, pairs('d', 0, 5), [[]]);
await run();
assert.strictEqual(storedIDs(4).length, 5);
assert.ok(!events.some(([type]) => type === 'destroy'));
assert.strictEqual(
  logged(1, /^Imported ban list \(ID: 4\): it returned no bans, so its 5 stored bans were kept/)
    .length,
  1
);

// Removing at least 25 bans and 10% of a list waits for IMPORTER_ALLOW_MASS_REMOVAL.
for (const [stored, kept, held] of [
  [30, 4, true],
  [30, 6, false],
  [300, 270, true],
  [300, 271, false]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, stored), [pairs('e', 0, kept)]);
  await run();
  assert.strictEqual(storedIDs(5).length, held ? stored : kept, `${stored} stored, ${kept} kept`);
  assert.strictEqual(
    events.some(([type]) => type === 'destroy'),
    !held
  );
  const holds = logged(
    1,
    new RegExp(
      `^Imported ban list \\(ID: 5\\): ${kept} bans fetched, 0 new, 0 updated\\. Kept the ${stored - kept} of its ${stored} stored bans that it no longer has, .* set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run\\.$`
    )
  );
  assert.strictEqual(holds.length, held ? 1 : 0);
  assert.strictEqual(logs.filter((log) => log.level === 1).length, held ? 1 : 0);
}

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

// Remote lists: an empty file keeps the list's bans, after a single request, and an error page
// fails the list.
reset();
for (const [id, body] of [
  [7, ''],
  [8, '<html><body>Please sign in</body></html>']
]) {
  const source = `https://bans.example/${id}.txt`;
  banLists.set(id, { id, type: 'remote', source });
  remoteLists.set(source, body);
  steamUsers.set(steamID(id), user(steamID(id)));
  bans.set(`${id},${steamID(id)},null`, {
    id: `${id},${steamID(id)},null`,
    expires: null,
    expired: false,
    reason: classifyBanReason('Cheating'),
    rawReason: 'Cheating',
    rawNote: null,
    steamUser: steamID(id),
    banList: id
  });
}
await run();
assert.strictEqual(remoteRequests.length, 2);
assert.strictEqual(storedIDs(7).length, 1);
assert.strictEqual(storedIDs(8).length, 1);
assert.strictEqual(logged(1, /^Imported ban list \(ID: 7\): it returned no bans/).length, 1);
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 8\) while fetching it, .*error page/).length,
  1
);

// An unchanged remote ban has no note, which matches the NULL stored for it, so it is not saved
// again. A changed one is.
reset();
banLists.set(9, { id: 9, type: 'remote', source: 'https://bans.example/9.txt' });
remoteLists.set(
  'https://bans.example/9.txt',
  `${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Teamkilling`
);
for (const n of [1, 2]) {
  steamUsers.set(steamID(n), user(steamID(n)));
  bans.set(`9,${steamID(n)},null`, {
    id: `9,${steamID(n)},null`,
    expires: null,
    expired: false,
    reason: classifyBanReason('Cheating'),
    rawReason: 'Cheating',
    rawNote: null,
    steamUser: steamID(n),
    banList: 9
  });
}
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
assert.ok(!events.some(([type, list]) => type === 'select' && list === 11));
assert.strictEqual(
  logged(2, /^Skipped ban list \(ID: 11\), as it was removed during the run\.$/).length,
  1
);
assert.strictEqual(logs.filter((log) => log.level === 1).length, 0);
assert.deepStrictEqual(storedIDs(12), ['12,i0', '12,i1']);

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

// A list whose bans cannot be saved because the database stays unavailable stops after the
// retries, and keeps its stored bans.
reset();
battlemetricsList(15, pairs('l', 0, 4), [pairs('l', 0, 3)]);
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
assert.ok(!events.some(([type]) => type === 'select'));
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 15\) while saving its bans, so none of its bans were removed \(3 bans fetched, 0 new, 0 updated\)\. SequelizeConnectionRefusedError: connect ECONNREFUSED/
  ).length,
  1
);

// A run asked to stop while a list's bans are being saved finishes the saves under way, each with
// its player's update, and starts no more. None of the list's bans are removed, as the bans it did
// not save would look removed, and no other list is imported. This stops the importer's run
// control, so it comes last.
reset();
battlemetricsList(30, pairs('s', 0, 4), [pairs('s', 2, 10)]);
battlemetricsList(31, pairs('t', 0, 2), [pairs('t', 0, 2)]);
onSave = (id) => {
  if (id === '30,s5') control.requestStop('it received SIGTERM');
};
const stopped = await run().catch((err) => err);
assert.strictEqual(stopped.name, 'RunStopped');
assert.strictEqual(stopped.reason, 'it received SIGTERM');
assert.deepStrictEqual(findOrCreateCalls, ['30,s2', '30,s3', '30,s4', '30,s5']);
assert.strictEqual(pendingSaves, 0);
assert.deepStrictEqual(storedIDs(30), ['30,s0', '30,s1', '30,s2', '30,s3', '30,s4', '30,s5']);
assert.strictEqual(steamUsers.get(steamID(5)).lastRefreshedExport, null);
assert.strictEqual(steamUsers.get(steamID(6)).lastRefreshedExport, FRESH);
assert.ok(!events.some(([type]) => type === 'begin' || type === 'destroy'));
assert.ok(!events.some(([type, id]) => type === 'read list' && id === 31));
assert.deepStrictEqual(battlemetricsRequests, ['bm-30']);
// The list's line says what it saved.
assert.deepStrictEqual(
  logs.filter(({ level }) => level === 1).map(({ message, important }) => [message, important]),
  [
    [
      'Stopped importing ban list (ID: 30) while saving its bans, as the run is stopping, so none of its bans were removed (8 bans fetched, 2 new, 0 updated).',
      true
    ]
  ]
);

assert.strictEqual(verboseLevelOneLines, 0, 'Lines for the log channel are logged as important');

console.log(
  'Ban import checks passed: complete lists only, awaited saves, holds, empty lists, retries and stops.'
);
