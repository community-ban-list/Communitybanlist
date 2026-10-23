import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';
import { FIND_MISMATCHED } from '../src/reputation-points.js';

// Check the reputation check without a database: when it is due, from the setting,
// IMPORTER_REPUTATION_CHECK_HOURS, and the ImporterState row it keeps, that it queues exactly the
// players whose stored reputation points are not what their bans give, in batches by ID, with their
// retries, and what it counts and logs. The database is a stand-in that keeps players, bans and the
// importer's state in memory and answers the statements the check sends as MySQL would, working
// out each player's points by the rule in reputation-points.js, whose test checks the statements
// themselves, and the production-scale run checks them on MySQL. Waits between attempts are skipped
// but recorded. Where the check stops, and that it checks the run lock before it writes, is checked
// in stop-points.js.

// Stand-ins for Sequelize's errors, with MySQL's error number, as Sequelize gives it.
class DatabaseError extends Error {
  constructor(message, errno) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = { errno };
  }
}
class ForeignKeyConstraintError extends DatabaseError {}
class ValidationError extends Error {}
const deadlock = () =>
  new DatabaseError('Deadlock found when trying to get lock; try restarting transaction', 1213);
const syntaxError = () => new DatabaseError('You have an error in your SQL syntax', 1064);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse('2026-10-23T12:00:00.000Z');

// The database: players by ID, their bans, the importer's state by name, and the time it takes as
// NOW(). A player is { reputationPoints, lastRefreshedReputationPoints,
// lastRefreshedReputationRank, lastRefreshedExport, lastRefreshedInfo }, and a ban { banList,
// steamUser, expires }.
const players = new Map();
let bans = [];
const state = new Map();
let databaseNow = START;
// What the database was sent, in order, and the errors each kind of statement fails with, one each
// time it is sent.
const statements = [];
const failures = new Map();
const delays = [];
const logs = [];

const COUNT_CHECKED =
  'SELECT COUNT(*) AS checked FROM SteamUsers WHERE lastRefreshedReputationPoints IS NOT NULL';
const QUEUE_RECALCULATION =
  'UPDATE SteamUsers SET lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';

// A player's points by the rule: on each ban list, 3 if any of their bans there is active, as it
// has no expiry or its expiry is now or later, and 1 for each of their bans there that is not.
function pointsByRule(steamUser) {
  const lists = new Map();
  for (const ban of bans.filter((ban) => ban.steamUser === steamUser)) {
    const list = lists.get(ban.banList) ?? { active: 0, expired: 0 };
    if (ban.expires === null || ban.expires >= databaseNow) list.active++;
    else list.expired++;
    lists.set(ban.banList, list);
  }
  return [...lists.values()].reduce(
    (total, { active, expired }) => total + (active > 0 ? 3 : 0) + expired,
    0
  );
}

const fail = (kind, ...errors) => failures.set(kind, errors);
function send(kind, details) {
  statements.push(details === undefined ? [kind] : [kind, details]);
  const error = failures.get(kind)?.shift();
  if (error) throw error;
}

const QueryTypes = { SELECT: 'SELECT' };
const sequelize = {
  async query(sql, { type, replacements } = {}) {
    await new Promise(setImmediate);
    if (sql === COUNT_CHECKED) {
      assert.strictEqual(type, QueryTypes.SELECT);
      send('count');
      const checked = [...players.values()].filter(
        (player) => player.lastRefreshedReputationPoints !== null
      ).length;
      return [{ checked }];
    }
    if (sql === FIND_MISMATCHED) {
      assert.strictEqual(type, QueryTypes.SELECT);
      send('find');
      // MySQL gives a SUM as a DECIMAL, which mysql2 gives as text.
      return [...players.entries()]
        .filter(([, player]) => player.lastRefreshedReputationPoints !== null)
        .map(([id, { reputationPoints }]) => ({ id, reputationPoints, points: pointsByRule(id) }))
        .filter(({ reputationPoints, points }) => reputationPoints !== points)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(({ id, reputationPoints, points }) => ({
          id,
          reputationPoints,
          points: String(points)
        }));
    }
    if (sql === QUEUE_RECALCULATION) {
      const ids = [...replacements[0]];
      send('queue', ids);
      for (const id of ids)
        if (players.has(id))
          Object.assign(players.get(id), {
            lastRefreshedExport: null,
            lastRefreshedReputationPoints: null,
            lastRefreshedReputationRank: null
          });
      return [{ affectedRows: ids.length }, { affectedRows: ids.length }];
    }
    throw new Error(`Unexpected statement: ${sql}`);
  }
};
const ImporterState = {
  async findByPk(name) {
    send('read state', name);
    return state.has(name) ? { name, value: structuredClone(state.get(name)) } : null;
  },
  async upsert({ name, value }) {
    send('save state', name);
    state.set(name, JSON.parse(JSON.stringify(value)));
  }
};

const stubs = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/importer-models': { ImporterState },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    isDatabaseUnavailable: () => false,
    QueryTypes,
    ValidationError
  },
  'scbl-lib/utils': {
    describeError,
    Logger: {
      verbose: (module, level, message) => logs.push({ module, level, message }),
      important: (module, message) => logs.push({ module, level: 1, message, important: true })
    }
  }
};

// Load the check once, with the real modules of the importer it imports, apply-list.js,
// reputation-points.js and run-control.js, and the stand-ins above for packages, in a context
// whose waits are skipped and recorded.
const context = vm.createContext({
  process: { env: {} },
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const loaded = new Map();
function moduleFor(specifier, referencingModule) {
  const key = specifier.startsWith('.')
    ? new URL(specifier, referencingModule.identifier).href
    : specifier;
  if (!loaded.has(key))
    loaded.set(
      key,
      specifier.startsWith('.')
        ? readFile(new URL(key), 'utf8').then(
            (source) => new vm.SourceTextModule(source, { context, identifier: key })
          )
        : Promise.resolve().then(() => {
            const exports = stubs[specifier];
            assert.ok(exports, `Unexpected dependency: ${specifier}`);
            return new vm.SyntheticModule(
              Object.keys(exports),
              function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
              },
              { context }
            );
          })
    );
  return loaded.get(key);
}
const check = await moduleFor('../src/reputation-check.js', { identifier: import.meta.url });
await check.link(moduleFor);
await check.evaluate();
const { checkReputationPoints, DEFAULT_HOURS, dueAt, MAX_HOURS, readCheckHours, STATE_ROW } =
  check.namespace;
const control = (await moduleFor('../src/run-control.js', { identifier: import.meta.url }))
  .namespace;
// The run holds its locks, which the check makes sure of before it writes.
control.setRunLock({ isHeld: async () => true });

const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;

// A player, with their stored points, recalculated at the time given, or queued with null.
const player = (reputationPoints, refreshed = START - 3 * DAY) => ({
  reputationPoints,
  lastRefreshedReputationPoints: refreshed,
  lastRefreshedReputationRank: refreshed,
  lastRefreshedExport: refreshed,
  lastRefreshedInfo: refreshed
});

function reset() {
  players.clear();
  bans = [];
  state.clear();
  databaseNow = START;
  statements.length = 0;
  failures.clear();
  delays.length = 0;
  logs.length = 0;
}

// Run the check as a run that started at startedAt, with the setting given, and resolve with its
// counts, as the run record keeps them.
async function run({ hours, startedAt = START, cadenceSeconds = 600, batchSize } = {}) {
  const counts = {};
  await checkReputationPoints(counts, { hours, startedAt, cadenceSeconds, batchSize });
  return { ...counts };
}
const queued = () => statements.filter(([kind]) => kind === 'queue').map(([, ids]) => ids);
const lines = (level) =>
  logs.filter((line) => line.level === level && line.module === 'Reputation');
const queuedFlags = (id) => {
  const { lastRefreshedReputationPoints, lastRefreshedReputationRank, lastRefreshedExport } =
    players.get(id);
  return [lastRefreshedReputationPoints, lastRefreshedReputationRank, lastRefreshedExport];
};

// The players of a production-like case, by ID:
// 1 has 9 points but bans on two lists only, as a third list was deleted by hand: 6 by their bans;
// 2 has 6 points and bans on two lists, as it should;
// 3 has 4 points and no bans left at all;
// 4 has no points and no bans;
// 5 is queued for a recalculation already, e.g. as the import just saved a ban of theirs, so their
//   points are not compared, though they differ;
// 6 has NULL points and an active ban: 3 by their bans;
// 7 has 5 points: an active ban and two expired ones on one list, as it should;
// 8 has 3 points, but their only ban's expiry passed without them being queued: 1 by their bans;
// 9 has 3 points and a ban that expires now, which is still active.
function seed() {
  players.set(steamID(1), player(9));
  bans.push(
    { banList: 1, steamUser: steamID(1), expires: null },
    { banList: 2, steamUser: steamID(1), expires: START + DAY }
  );
  players.set(steamID(2), player(6));
  bans.push(
    { banList: 1, steamUser: steamID(2), expires: null },
    { banList: 3, steamUser: steamID(2), expires: null }
  );
  players.set(steamID(3), player(4));
  players.set(steamID(4), player(0));
  players.set(steamID(5), player(3, null));
  players.set(steamID(6), player(null));
  bans.push({ banList: 2, steamUser: steamID(6), expires: null });
  players.set(steamID(7), player(5));
  bans.push(
    { banList: 1, steamUser: steamID(7), expires: null },
    { banList: 1, steamUser: steamID(7), expires: START - 40 * DAY },
    { banList: 1, steamUser: steamID(7), expires: START - 400 * DAY }
  );
  players.set(steamID(8), player(3));
  bans.push({ banList: 3, steamUser: steamID(8), expires: START - HOUR });
  players.set(steamID(9), player(3));
  bans.push({ banList: 3, steamUser: steamID(9), expires: START });
}
const MISMATCHED = [steamID(1), steamID(3), steamID(6), steamID(8)];

// The first check, with no row yet, as after the version with the check is deployed, runs at once.
// It compares every player not queued already, and queues exactly those whose points are not what
// their bans give, with no bans counting as none, and NULL points as not matching: their
// reputation points, rank and export bans are recalculated, but not their Steam profile. Nobody
// else is changed, and the player queued already stays as they were. It saves when the run
// started, and what it found, posts how many it queued with examples and what that means, and
// prints what it did.
{
  reset();
  seed();
  const before = structuredClone(Object.fromEntries(players));
  const counts = await run();
  assert.deepStrictEqual(counts, { ran: true, checked: 8, mismatched: 4, queued: 4 });
  assert.deepStrictEqual(statements, [
    ['read state', STATE_ROW],
    ['count'],
    ['find'],
    ['queue', MISMATCHED],
    ['save state', STATE_ROW]
  ]);
  for (const [id, was] of Object.entries(before)) {
    const now = players.get(id);
    if (MISMATCHED.includes(id)) {
      assert.deepStrictEqual(queuedFlags(id), [null, null, null], id);
      assert.strictEqual(now.lastRefreshedInfo, was.lastRefreshedInfo, id);
      assert.strictEqual(now.reputationPoints, was.reputationPoints, id);
    } else assert.deepStrictEqual(now, was, id);
  }
  const saved = state.get(STATE_ROW);
  assert.deepStrictEqual(
    { ...saved, checkedAt: null },
    {
      startedAt: '2026-10-23T12:00:00.000Z',
      checkedAt: null,
      checked: 8,
      queued: 4
    }
  );
  assert.ok(Date.parse(saved.checkedAt) >= START);
  assert.strictEqual(STATE_ROW, 'reputationCheck');

  assert.deepStrictEqual(
    lines(1).map(({ message }) => message),
    [
      `Queued 4 players for a recalculation, as their reputation points did not match their bans: ${steamID(1)} (9 points, 6 by their bans), ${steamID(3)} (4 points, 0 by their bans), ${steamID(6)} (no points, 3 by their bans), ${steamID(8)} (3 points, 1 by their bans). This means bans were removed, or changed, without queueing their players, e.g. as a ban list was deleted by hand rather than with /banlist remove.`
    ]
  );
  assert.ok(lines(1).every(({ important }) => !important));
  assert.match(
    lines(2).at(-1).message,
    /^Checked the reputation points of 8 players against their bans, and queued the 4 whose points did not match for a recalculation\. Took \d+\.\d\ds$/
  );
  // No retries were needed.
  assert.deepStrictEqual(delays, []);
}

// A check that finds every player's points matching their bans queues nobody and posts nothing, but
// saves that it ran, so the next run is not due one.
{
  reset();
  players.set(steamID(1), player(3));
  bans.push({ banList: 1, steamUser: steamID(1), expires: null });
  players.set(steamID(2), player(0));
  const counts = await run();
  assert.deepStrictEqual(counts, { ran: true, checked: 2, mismatched: 0, queued: 0 });
  assert.deepStrictEqual(statements, [
    ['read state', STATE_ROW],
    ['count'],
    ['find'],
    ['save state', STATE_ROW]
  ]);
  assert.deepStrictEqual(lines(1), []);
  assert.match(
    lines(2).at(-1).message,
    /^Checked the reputation points of 2 players against their bans, and all matched\. Took /
  );
  assert.deepStrictEqual(await run({ startedAt: START + 10 * MINUTE }), {
    ran: false,
    dueAt: '2026-10-24T11:59:00.000Z'
  });
}

// Players are queued in batches of the batch size, each one statement, by ID, in order. The line
// names the first 5 of them, with how many more there were.
{
  reset();
  for (let n = 1; n <= 12; n++) players.set(steamID(n), player(n));
  const counts = await run({ batchSize: 5 });
  assert.deepStrictEqual(counts, { ran: true, checked: 12, mismatched: 12, queued: 12 });
  const ids = Array.from({ length: 12 }, (_, index) => steamID(index + 1));
  assert.deepStrictEqual(queued(), [ids.slice(0, 5), ids.slice(5, 10), ids.slice(10)]);
  const [line] = lines(1);
  assert.ok(
    line.message.startsWith(
      `Queued 12 players for a recalculation, as their reputation points did not match their bans: ${steamID(1)} (1 point, 0 by their bans), ${steamID(2)} (2 points, 0 by their bans), ${steamID(3)} (3 points, 0 by their bans), ${steamID(4)} (4 points, 0 by their bans), ${steamID(5)} (5 points, 0 by their bans) and 7 more. This means bans were removed`
    ),
    line.message
  );
  // By default, a batch is 500 players, as the import's are.
  reset();
  for (let n = 1; n <= 1201; n++) players.set(steamID(n), player(3));
  await run();
  assert.deepStrictEqual(
    queued().map((batch) => batch.length),
    [500, 500, 201]
  );
}

// A batch that ends in a deadlock, e.g. with the bot's /banlist remove queueing the same players,
// or a lock wait timeout, is sent again as a whole 5 seconds later, and each player is queued once.
// A failure that would only fail again fails the step, after it posts the players it did queue,
// and it saves no row, so the next run checks again.
{
  reset();
  for (let n = 1; n <= 4; n++) players.set(steamID(n), player(3));
  fail('queue', deadlock(), new DatabaseError('Lock wait timeout exceeded', 1205));
  assert.deepStrictEqual(await run({ batchSize: 2 }), {
    ran: true,
    checked: 4,
    mismatched: 4,
    queued: 4
  });
  assert.deepStrictEqual(queued(), [
    [steamID(1), steamID(2)],
    [steamID(1), steamID(2)],
    [steamID(1), steamID(2)],
    [steamID(3), steamID(4)]
  ]);
  assert.deepStrictEqual(delays, [5000, 5000]);
  assert.ok(state.has(STATE_ROW));

  reset();
  for (let n = 1; n <= 4; n++) players.set(steamID(n), player(3));
  failures.set('queue', [undefined, syntaxError()]);
  const counts = {};
  await assert.rejects(
    checkReputationPoints(counts, { startedAt: START, batchSize: 2 }),
    /error in your SQL syntax/
  );
  assert.deepStrictEqual({ ...counts }, { ran: true, checked: 4, mismatched: 4, queued: 2 });
  assert.ok(!state.has(STATE_ROW));
  assert.deepStrictEqual(
    lines(1).map(({ message }) => message.match(/^Queued \d+ players?|The check stopped.*$/g)),
    [
      [
        'Queued 2 players',
        "The check stopped before it queued the other 2, which the next run's check queues, as it is then due again."
      ]
    ]
  );
  // The next run checks again, and queues the others, as the first two are queued already.
  assert.deepStrictEqual(await run({ startedAt: START + MINUTE }), {
    ran: true,
    checked: 2,
    mismatched: 2,
    queued: 2
  });
  assert.deepStrictEqual(queued().at(-1), [steamID(3), steamID(4)]);

  // A check that cannot read the players, e.g. as the database is gone, counts nothing, rather
  // than that every player matched, and fails the step.
  reset();
  seed();
  fail('find', syntaxError());
  const failed = {};
  await assert.rejects(checkReputationPoints(failed, { startedAt: START }), /SQL syntax/);
  assert.deepStrictEqual({ ...failed }, {});
  assert.deepStrictEqual(queued(), []);
  assert.ok(!state.has(STATE_ROW));
}

// The check is due once every IMPORTER_REPUTATION_CHECK_HOURS, 24 by default, from the start of the
// run that last checked: a run that starts sooner skips it, saying when it is next due, and sends
// nothing to the database but the read of the row. Runs start a little before or after their time,
// so a run is due it from 5 minutes before then, or a tenth of the cadence if that is less.
{
  reset();
  seed();
  await run();
  const checkedOnce = statements.length;
  for (const [startedAt, cadenceSeconds, due] of [
    [START + 10 * MINUTE, 600, false],
    [START + 23 * HOUR, 600, false],
    // A cycle every 10 minutes: a minute of leeway.
    [START + DAY - MINUTE - 1, 600, false],
    [START + DAY - MINUTE, 600, true],
    // Runs every 6 hours: 5 minutes of leeway.
    [START + DAY - 5 * MINUTE - 1, 21600, false],
    [START + DAY - 5 * MINUTE, 21600, true],
    [START + DAY, 21600, true],
    [START + 3 * DAY, 21600, true]
  ]) {
    statements.length = 0;
    state.set(STATE_ROW, { ...state.get(STATE_ROW), startedAt: new Date(START).toISOString() });
    const counts = await run({ startedAt, cadenceSeconds });
    assert.strictEqual(counts.ran, due, `${(startedAt - START) / MINUTE} minutes`);
    if (due) assert.strictEqual(state.get(STATE_ROW).startedAt, new Date(startedAt).toISOString());
    else {
      const leeway = Math.min(5 * MINUTE, (cadenceSeconds * SECOND) / 10);
      assert.deepStrictEqual(counts, {
        ran: false,
        dueAt: new Date(START + DAY - leeway).toISOString()
      });
      assert.deepStrictEqual(statements, [['read state', STATE_ROW]]);
      assert.strictEqual(
        lines(2).at(-1).message,
        `Skipped the reputation check, as it is not due until ${counts.dueAt}: it runs every 24 hours (IMPORTER_REPUTATION_CHECK_HOURS).`
      );
    }
  }
  assert.ok(checkedOnce > 1);
  assert.strictEqual(DEFAULT_HOURS, 24);
}

// So runs every 6 hours check every 24 hours, the 4th run after the one that last checked, though
// each starts a few seconds early or late, and cycles every 10 minutes check every 144 cycles. A
// check due more often than runs start is due on every run.
for (const [cadenceSeconds, hours, runs, jitter, expected] of [
  [21600, undefined, 13, [0, 3, -2, 1, -4, 2, -3, 0, -5, 4, 1, -1, -3], [0, 4, 8, 12]],
  [600, undefined, 300, [0], [0, 144, 288]],
  [21600, '1', 4, [0, -2, 3, -1], [0, 1, 2, 3]],
  [3600, '12', 49, [0, 2, -3], [0, 12, 24, 36, 48]]
]) {
  reset();
  const checked = [];
  for (let k = 0; k < runs; k++) {
    const startedAt = START + k * cadenceSeconds * SECOND + jitter[k % jitter.length] * SECOND;
    if ((await run({ hours, startedAt, cadenceSeconds })).ran) checked.push(k);
  }
  assert.deepStrictEqual(checked, expected, `every ${cadenceSeconds}s, ${hours ?? 24} hours`);
}

// A row that cannot be read as when a run checked, or one whose time is later than the run's
// start, which no earlier run can have, e.g. one changed by hand, makes the check due at once.
for (const value of [
  { startedAt: 'yesterday' },
  { startedAt: null },
  'not an object',
  { startedAt: new Date(START + HOUR).toISOString() }
]) {
  reset();
  seed();
  state.set(STATE_ROW, value);
  assert.strictEqual((await run()).ran, true, JSON.stringify(value));
}

// IMPORTER_REPUTATION_CHECK_HOURS is a whole number of hours, with spaces or one pair of quotes
// around it, from 0, which turns the check off, to a year. Not set, it is 24. An invalid value is
// taken as 24, with a warning, which is posted the first time and only printed in the console after
// that, as the importer service runs the check every cycle with the same setting.
for (const [value, hours, warning] of [
  [undefined, 24, false],
  ['', 24, false],
  ['  ', 24, false],
  ['12', 12, false],
  [' 48 ', 48, false],
  ['"6"', 6, false],
  ["'72'", 72, false],
  ['0', 0, false],
  ['0024', 24, false],
  [String(MAX_HOURS), MAX_HOURS, false],
  [String(MAX_HOURS + 1), 24, true],
  ['-1', 24, true],
  ['1.5', 24, true],
  ['abc', 24, true],
  ['24 # daily', 24, true]
]) {
  const setting = readCheckHours(value);
  assert.strictEqual(setting.hours, hours, `${JSON.stringify(value)}`);
  assert.strictEqual(Boolean(setting.warning), warning, `${JSON.stringify(value)}`);
  if (warning)
    assert.strictEqual(
      setting.warning,
      `Warning: IMPORTER_REPUTATION_CHECK_HOURS must be a whole number from 0 to 8760, not "${value}", so the reputation check runs every 24 hours.`
    );
}
assert.strictEqual(MAX_HOURS, 8760);
{
  reset();
  seed();
  assert.strictEqual((await run({ hours: 'daily' })).ran, true);
  assert.strictEqual((await run({ hours: 'daily', startedAt: START + HOUR })).ran, false);
  const warnings = logs.filter(({ message }) => message.startsWith('Warning:'));
  assert.deepStrictEqual(
    warnings.map(({ level, important }) => [level, Boolean(important)]),
    [
      [1, true],
      [2, false]
    ]
  );
  assert.match(warnings[0].message, /not "daily", so the reputation check runs every 24 hours\.$/);
  // Another invalid value is posted too.
  await run({ hours: 'weekly', startedAt: START + 2 * HOUR });
  assert.strictEqual(logs.filter(({ important }) => important).length, 2);
}

// With 0 the check is off: it reads and writes nothing, and says so in its counts, which the run's
// status leaves it out for. It runs again at once once the setting is taken off.
for (const value of ['0', ' "0" ']) {
  reset();
  seed();
  assert.deepStrictEqual(await run({ hours: value }), { ran: false, off: true });
  assert.deepStrictEqual(statements, []);
  assert.deepStrictEqual(lines(1), []);
  assert.strictEqual(
    lines(2).at(-1).message,
    'Skipped the reputation check, as IMPORTER_REPUTATION_CHECK_HOURS is 0, which turns it off.'
  );
  assert.strictEqual((await run({ startedAt: START + MINUTE })).ran, true);
}

// When it is due, a run with no last check is due at once, and one is next due the setting's hours
// after the last, less the leeway.
assert.strictEqual(dueAt({ last: null, hours: 24, cadenceSeconds: 600, startedAt: START }), START);
assert.strictEqual(
  dueAt({ last: START, hours: 24, cadenceSeconds: 21600, startedAt: START + HOUR }),
  START + DAY - 5 * MINUTE
);

console.log(
  'Reputation check checks passed: exactly the players whose points do not match their bans queued, in batches with their retries, its schedule from the row it keeps, IMPORTER_REPUTATION_CHECK_HOURS, and what it counts and posts.'
);
