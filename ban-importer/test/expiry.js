import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the step that marks bans expired once their expiry has passed, without a database: which
// bans it marks, that it compares their expiries with the time in UTC, that it queues their players
// for a recalculation in the same transaction, in batches, with their retries, and where it stops.
// The database is a stand-in that keeps bans and players in memory and runs the statements the
// step sends as MySQL would, in transactions that a failure rolls back. Waits between attempts are
// skipped but recorded.

// Stand-ins for Sequelize's errors.
class DatabaseError extends Error {
  constructor(message, original = {}) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = original;
  }
}
class ForeignKeyConstraintError extends DatabaseError {}
class ValidationError extends Error {}
const deadlock = () =>
  new DatabaseError('Deadlock found when trying to get lock; try restarting transaction', {
    errno: 1213
  });

const bans = new Map();
const players = new Map();
// What the database did: each statement, as [what, transaction], and each transaction's start and
// end.
const events = [];
const delays = [];
const logs = [];
// Errors for the statements that mark bans expired, and that queue players, to fail with, one each
// time, in order.
const markErrors = [];
const queueErrors = [];
// Called before the statement that marks bans expired writes them, with their IDs.
let onMark = null;
// The times the step compared the bans' expiries with, as it sent them.
const times = [];
let transactions = 0;

// A time as MySQL reads text in DATETIME's format: in UTC, as the importer's connections use UTC.
const timeOf = (text) => {
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  return Date.parse(`${text.replace(' ', 'T')}Z`);
};
// Whether a ban is marked as not expired, as 0 or NULL, and whether its expiry has passed by then.
const notMarked = (ban) => ban.expired === 0 || ban.expired === null;
const hasPassed = (ban, time) => ban.expires !== null && ban.expires <= time;

const FIND_EXPIRED =
  'SELECT id, steamUser FROM Bans WHERE (expired = 0 OR expired IS NULL) AND expires IS NOT NULL AND expires <= CAST(? AS DATETIME(3))';
const MARK_EXPIRED =
  'UPDATE Bans SET expired = 1, updatedAt = ? WHERE id IN (?) AND (expired = 0 OR expired IS NULL) AND expires IS NOT NULL AND expires <= CAST(? AS DATETIME(3))';
const QUEUE_RECALCULATION =
  'UPDATE SteamUsers SET lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';

const tick = () => new Promise(setImmediate);
const QueryTypes = { SELECT: 'SELECT' };
const sequelize = {
  async query(sql, { replacements, transaction, type } = {}) {
    const tx = transaction?.id ?? null;
    await tick();
    if (sql === FIND_EXPIRED) {
      assert.strictEqual(type, QueryTypes.SELECT);
      events.push(['find', tx]);
      times.push(replacements[0]);
      const time = timeOf(replacements[0]);
      return [...bans.values()]
        .filter((ban) => notMarked(ban) && hasPassed(ban, time))
        .map(({ id, steamUser }) => ({ id, steamUser }));
    }
    if (sql === MARK_EXPIRED) {
      const [updatedAt, ids, time] = replacements;
      times.push(time);
      if (onMark) await onMark([...ids]);
      if (markErrors.length > 0) throw markErrors.shift();
      events.push(['mark', [...ids], tx]);
      let affectedRows = 0;
      for (const id of ids) {
        const ban = bans.get(id);
        if (!ban || !notMarked(ban) || !hasPassed(ban, timeOf(time))) continue;
        Object.assign(ban, { expired: 1, updatedAt: timeOf(updatedAt) });
        affectedRows++;
      }
      // Sequelize resolves with [result, result] for an UPDATE.
      return [{ affectedRows }, { affectedRows }];
    }
    if (sql === QUEUE_RECALCULATION) {
      const ids = [...replacements[0]];
      if (queueErrors.length > 0) throw queueErrors.shift();
      events.push(['queue', ids, tx]);
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
  },
  async transaction(work) {
    const transaction = { id: ++transactions };
    const saved = {
      bans: new Map([...bans].map(([id, ban]) => [id, { ...ban }])),
      players: new Map([...players].map(([id, player]) => [id, { ...player }]))
    };
    events.push(['begin', transaction.id]);
    try {
      const value = await work(transaction);
      events.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      for (const [store, copy] of [
        [bans, saved.bans],
        [players, saved.players]
      ]) {
        store.clear();
        for (const [key, value] of copy) store.set(key, value);
      }
      events.push(['rollback', transaction.id]);
      throw err;
    }
  }
};

const context = vm.createContext({
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const dependencies = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: () => false
  },
  'scbl-lib/utils': {
    describeError,
    Logger: { verbose: (module, level, message) => logs.push({ level, message }) }
  }
};
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const runControl = await load('../src/run-control.js');
const applyList = load('../src/apply-list.js');
const module = await load('../src/expiry.js');
const link = async (specifier) => {
  if (specifier === './run-control.js') return runControl;
  if (specifier === './apply-list.js') return applyList;
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
};
await module.link(link);
await module.evaluate();
const { expireBans } = module.namespace;
const control = runControl.namespace;
// How far the step said it had got, for the run's status, as [done, total, unit].
const progress = [];
control.setProgressListener(({ done, total, unit }) => progress.push([done, total, unit]));

const NOW = Date.parse('2026-10-22T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;
const FRESH = 'refreshed';

// A player whose times of update are all set, as after a run.
function addPlayer(id) {
  players.set(id, {
    id,
    lastRefreshedInfo: FRESH,
    lastRefreshedExport: FRESH,
    lastRefreshedReputationPoints: FRESH,
    lastRefreshedReputationRank: FRESH
  });
}
// A ban of the player, with its expiry as milliseconds or null, and whether it is marked expired, as
// MySQL gives it: 1, 0 or NULL.
function addBan(id, steamUser, expires, expired = 0) {
  if (!players.has(steamUser)) addPlayer(steamUser);
  bans.set(id, { id, steamUser, expires, expired, updatedAt: null });
}
function reset() {
  bans.clear();
  players.clear();
  for (const array of [events, delays, logs, markErrors, queueErrors, times, progress])
    array.length = 0;
  onMark = null;
  transactions = 0;
}
// Mark the expired bans, at NOW unless another time is given. Resolves with what the step counted.
async function expire(options = {}) {
  const counts = {};
  await expireBans(counts, { now: new Date(NOW), ...options });
  return { ...counts };
}
const queued = (id) => players.get(id).lastRefreshedReputationPoints === null;

// Only bans whose expiry has passed, and that are marked as not expired, by 0 or NULL, are marked
// expired: not those that expire later, not permanent bans, and not those marked already. A ban
// whose expiry is the time compared with has expired, as the import takes it. Each is marked with
// the time, and its player is queued for a recalculation of their reputation and export bans, but
// not for a refresh of their Steam profile, as their bans did not change.
{
  reset();
  addBan('1,a', steamID(1), NOW - HOUR);
  addBan('1,b', steamID(2), NOW);
  addBan('1,c', steamID(3), NOW - 30 * 24 * HOUR, null);
  addBan('1,d', steamID(4), NOW + 1);
  addBan('1,e', steamID(5), null);
  addBan('1,f', steamID(6), NOW - HOUR, 1);
  // A player with two bans that expired is queued once.
  addBan('2,a', steamID(1), NOW - 2 * HOUR);
  const counts = await expire();
  assert.deepStrictEqual(counts, { due: 4, expired: 4, players: 3 });
  assert.deepStrictEqual(
    [...bans.values()].map(({ id, expired }) => [id, expired]),
    [
      ['1,a', 1],
      ['1,b', 1],
      ['1,c', 1],
      ['1,d', 0],
      ['1,e', 0],
      ['1,f', 1],
      ['2,a', 1]
    ]
  );
  for (const id of ['1,a', '1,b', '1,c', '2,a']) assert.strictEqual(bans.get(id).updatedAt, NOW);
  assert.strictEqual(bans.get('1,f').updatedAt, null);
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5, 6].map((n) => queued(steamID(n))),
    [true, true, true, false, false, false]
  );
  for (const n of [1, 2, 3]) {
    const player = players.get(steamID(n));
    assert.deepStrictEqual(
      [player.lastRefreshedExport, player.lastRefreshedReputationRank, player.lastRefreshedInfo],
      [null, null, FRESH]
    );
  }
  // The bans are read outside any transaction, without locking them, and marked in one
  // transaction that also queues their players.
  assert.deepStrictEqual(events, [
    ['find', null],
    ['begin', 1],
    ['mark', ['1,a', '1,b', '1,c', '2,a'], 1],
    ['queue', [steamID(1), steamID(2), steamID(3)], 1],
    ['commit', 1]
  ]);
  // The step says how far it has got, for the run's status, and what it did, in the console.
  assert.deepStrictEqual(progress, [
    [0, 4, 'bans'],
    [4, 4, 'bans']
  ]);
  assert.match(
    logs.at(-1).message,
    /^Marked 4 of 4 bans whose expiry has passed as expired, and queued their 3 players for a recalculation\. Took \d+\.\d{2}s$/
  );
  assert.ok(logs.every(({ level }) => level === 2));
}

// The time is compared in UTC, to the millisecond, whatever the time zone it is given in: the step
// sends the time as text in UTC, which MySQL reads as it is, whatever the time zone of the
// database or of the connection. A ban that expires a millisecond after it has not expired, and one
// that expired a millisecond before it has.
{
  reset();
  addBan('1,a', steamID(1), NOW - 1);
  addBan('1,b', steamID(2), NOW + 1);
  addBan('1,c', steamID(3), NOW + 5 * HOUR);
  const counts = await expire({ now: new Date('2026-10-22T10:00:00.000-05:00') });
  assert.deepStrictEqual(counts, { due: 1, expired: 1, players: 1 });
  assert.deepStrictEqual(
    [...bans.values()].map(({ expired }) => expired),
    [1, 0, 0]
  );
  assert.deepStrictEqual(times, ['2026-10-22 15:00:00.000', '2026-10-22 15:00:00.000']);
}

// Nothing to mark, nothing to write.
{
  reset();
  addBan('1,a', steamID(1), NOW + HOUR);
  const counts = await expire();
  assert.deepStrictEqual(counts, { due: 0, expired: 0, players: 0 });
  assert.deepStrictEqual(events, [['find', null]]);
  assert.deepStrictEqual(progress, [[0, 0, 'bans']]);
}

// The bans are marked in transactions of 500, each of which queues the players of its bans.
{
  reset();
  for (let n = 1; n <= 1201; n++) addBan(`3,${n}`, steamID(n), NOW - n * 1000);
  const counts = await expire();
  assert.deepStrictEqual(counts, { due: 1201, expired: 1201, players: 1201 });
  const marks = events.filter(([what]) => what === 'mark');
  assert.deepStrictEqual(
    marks.map(([, ids, tx]) => [ids.length, tx]),
    [
      [500, 1],
      [500, 2],
      [201, 3]
    ]
  );
  const queues = events.filter(([what]) => what === 'queue');
  assert.deepStrictEqual(
    queues.map(([, ids, tx]) => [ids.length, tx]),
    [
      [500, 1],
      [500, 2],
      [201, 3]
    ]
  );
  assert.deepStrictEqual(
    progress.map(([done]) => done),
    [0, 500, 1000, 1201]
  );
  assert.ok([...bans.values()].every(({ expired }) => expired === 1));
}

// A transaction that ends in a deadlock is rolled back and run again as a whole, after 5 seconds,
// so no ban is left marked expired without its player queued.
{
  reset();
  addBan('1,a', steamID(1), NOW - HOUR);
  addBan('1,b', steamID(2), NOW - HOUR);
  queueErrors.push(deadlock());
  const counts = await expire();
  assert.deepStrictEqual(counts, { due: 2, expired: 2, players: 2 });
  assert.deepStrictEqual(delays, [5000]);
  assert.deepStrictEqual(events.slice(1), [
    ['begin', 1],
    ['mark', ['1,a', '1,b'], 1],
    ['rollback', 1],
    ['begin', 2],
    ['mark', ['1,a', '1,b'], 2],
    ['queue', [steamID(1), steamID(2)], 2],
    ['commit', 2]
  ]);
  assert.ok(queued(steamID(1)) && queued(steamID(2)));
}

// An error that running the transaction again cannot fix fails the step, which leaves the batch as
// it was.
{
  reset();
  addBan('1,a', steamID(1), NOW - HOUR);
  const error = new ForeignKeyConstraintError('Cannot add or update a child row');
  markErrors.push(error);
  await assert.rejects(expire(), (thrown) => thrown === error);
  assert.deepStrictEqual(delays, []);
  assert.strictEqual(bans.get('1,a').expired, 0);
  assert.ok(!queued(steamID(1)));
}

// A ban changed since it was read, e.g. one whose expiry was moved, or that was marked by something
// else, is left as it is, and not counted as marked by the step. Its player is still queued, which
// does no harm.
{
  reset();
  addBan('1,a', steamID(1), NOW - HOUR);
  addBan('1,b', steamID(2), NOW - HOUR);
  addBan('1,c', steamID(3), NOW - HOUR);
  onMark = () => {
    bans.get('1,a').expires = NOW + HOUR;
    bans.get('1,b').expired = 1;
  };
  const counts = await expire();
  assert.deepStrictEqual(counts, { due: 3, expired: 1, players: 3 });
  assert.deepStrictEqual(
    [...bans.values()].map(({ expired, updatedAt }) => [expired, updatedAt]),
    [
      [0, null],
      [1, null],
      [1, NOW]
    ]
  );
}

// A run that is asked to stop does so between transactions. The bans marked so far, and their
// players, are counted.
{
  reset();
  for (let n = 1; n <= 700; n++) addBan(`4,${n}`, steamID(n), NOW - HOUR);
  onMark = () => control.requestStop('it received SIGTERM');
  const counts = {};
  await assert.rejects(expireBans(counts, { now: new Date(NOW) }), { name: 'RunStopped' });
  assert.deepStrictEqual({ ...counts }, { due: 700, expired: 500, players: 500 });
  assert.strictEqual(events.filter(([what]) => what === 'commit').length, 1);
  assert.strictEqual([...bans.values()].filter(({ expired }) => expired === 1).length, 500);
}

console.log(
  'Expiry checks passed: bans whose expiry has passed are marked expired in UTC, in batches with their players queued, retried as a whole, and stopped between batches.'
);
