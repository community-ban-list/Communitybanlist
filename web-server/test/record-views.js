import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import graphql from 'graphql';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Errors the resolvers and the background saves leave unhandled. There must be none.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// Timers the modules start, which the checks run by hand, as if the time had passed: the save that
// is due, and the time limit of a save that is running.
const timers = [];
function fakeSetTimeout(callback, delay, ...args) {
  const timer = {
    callback: () => callback(...args),
    delay,
    unrefed: false,
    unref() {
      this.unrefed = true;
      return this;
    }
  };
  timers.push(timer);
  return timer;
}
function fakeClearTimeout(timer) {
  if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1);
}

// The time the modules see, which the checks move on by hand.
let now = Date.UTC(2026, 9, 28, 12);
class FakeDate extends Date {
  static now() {
    return now;
  }
}

// What the modules log as errors.
const logged = [];
const fakeConsole = { error: (...args) => logged.push(args) };

// A stand-in for the players table. Every Steam ID that starts with 7656 is a player, with
// reputation points, except the player without any below. Each row
// records any save made on it, which never finishes, as when the row is locked. A transaction runs
// its callback with the transaction below. query records how it was called, and locks and returns
// the rows asked for, except those the checks have locked. update records how it was called and
// answers with the next of the answers the checks give it. Its database quotes values, and Dates as
// ISO strings, and keeps SQL it is given as it is.
const NO_POINTS = '76561198000000099';
const TRANSACTION = { transaction: 'the save' };
const saves = [];
const queries = [];
const updates = [];
const answers = [];
const lockedRows = new Set();
const SteamUser = {
  async findByPk(id) {
    if (!id.startsWith('7656')) return null;
    return {
      id,
      reputationPoints: id === NO_POINTS ? 0 : 1,
      save() {
        saves.push(id);
        return new Promise(() => {});
      }
    };
  },
  update(values, options) {
    updates.push({ values, options });
    const answer = answers.shift();
    assert.ok(answer, 'A save was made that the checks did not expect.');
    return answer();
  },
  sequelize: {
    escape: (value) => `'${value instanceof Date ? value.toISOString() : value}'`,
    literal: (sql) => ({ sql }),
    transaction: (callback) => callback(TRANSACTION),
    async query(sql, options) {
      queries.push({ sql, options });
      return [options.replacements.ids.filter((id) => !lockedRows.has(id)).map((id) => ({ id }))];
    }
  }
};

const packages = {
  graphql: { default: graphql },
  'scbl-lib/db/models': { Ban: {}, BanList: {}, Organisation: {}, SteamUser },
  'scbl-lib/db/sequelize': { Op: { ne: Symbol('ne'), gt: Symbol('gt') } },
  'scbl-lib/utils': { describeError }
};

// Load the query resolvers in a context of their own, with the timers and console above. Package
// imports are the stand-ins above, and relative imports load the real files, each once.
const context = vm.createContext({
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  Date: FakeDate,
  console: fakeConsole
});
const modules = new Map();
async function moduleFor(specifier, referencingURL) {
  const exports = packages[specifier];
  assert.ok(exports || specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
  const url = exports ? specifier : new URL(specifier, referencingURL).href;
  if (!modules.has(url)) {
    modules.set(
      url,
      exports
        ? new vm.SyntheticModule(
            Object.keys(exports),
            function () {
              for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            },
            { context }
          )
        : new vm.SourceTextModule(await readFile(new URL(url), 'utf8'), {
            context,
            identifier: url
          })
    );
  }
  return modules.get(url);
}
const resolverModule = await moduleFor('../src/graphql-api/query/resolver.js', import.meta.url);
await resolverModule.link((specifier, referencingModule) =>
  moduleFor(specifier, referencingModule.identifier)
);
await resolverModule.evaluate();
const { Query } = resolverModule.namespace.default;

// Let the background saves run as far as they can.
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Look up a player as their profile page does, and check that the answer comes at once.
async function view(id) {
  let timeout;
  const late = Symbol('late');
  const result = await Promise.race([
    Query.steamUser(null, { id }),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1000, late);
    })
  ]);
  clearTimeout(timeout);
  assert.notStrictEqual(result, late, `Looking up ${id} waited for the database to save the view.`);
  return result;
}

// The timers that are waiting, with the given delay. None keeps the web server running.
function timersOf(delay) {
  const found = timers.filter((timer) => timer.delay === delay);
  for (const timer of found) assert.ok(timer.unrefed, 'A timer does not keep the server running.');
  return found;
}

// The views waiting to be saved are saved by one timer at a time.
function runTimer() {
  assert.strictEqual(timersOf(VIEW_SAVE_INTERVAL).length, 1, 'One save is waiting.');
  assert.strictEqual(timers.length, 1, 'No save is running.');
  const [timer] = timers.splice(0);
  timer.callback();
}

// A save first locks the rows of the players it saves, in a transaction, skipping rows another query
// has locked rather than waiting for them.
async function assertLocked(ids, what) {
  await settle();
  assert.strictEqual(queries.length, 1, what);
  const [{ sql, options }] = queries.splice(0);
  assert.strictEqual(sql, 'SELECT id FROM SteamUsers WHERE id IN (:ids) FOR UPDATE SKIP LOCKED');
  assert.deepStrictEqual(Object.keys(options).sort(), ['replacements', 'transaction'], what);
  assert.strictEqual(options.transaction, TRANSACTION, what);
  assert.deepStrictEqual([...options.replacements.ids].sort(), [...ids].sort(), what);
}

// The save a check expects next: of these players, each as viewed at the time of their own last
// view, given as { id: time }, or as a list of IDs all viewed now. Times are saved to the second, as
// the database stores them. It locks the rows of the players given, or of those in `asked` when some
// were locked already. It leaves updatedAt as it is.
async function assertSaved(expected, what, asked) {
  await settle();
  if (Array.isArray(expected)) expected = Object.fromEntries(expected.map((id) => [id, now]));
  for (const id in expected) expected[id] -= expected[id] % 1000;
  await assertLocked(asked ?? Object.keys(expected), what);
  assert.strictEqual(updates.length, 1, what);
  const [{ values, options }] = updates.splice(0);
  assert.deepStrictEqual(Object.keys(values), ['lastViewed'], what);
  const sql = values.lastViewed?.sql;
  assert.strictEqual(typeof sql, 'string', `${what} It sets each player's own time.`);
  const match = /^CASE ((?:WHEN id IN \('\d+'(?:, '\d+')*\) THEN '[^']+' ?)+) END$/.exec(sql);
  assert.ok(match, `${what} It sets each player's own time: ${sql.slice(0, 200)}`);
  const times = {};
  for (const [, list, time] of match[1].matchAll(/WHEN id IN \(([^)]+)\) THEN '([^']+)'/g)) {
    assert.ok(!Object.values(times).includes(new Date(time).getTime()), `${what} Each time once.`);
    for (const id of list.split(', ').map((quoted) => quoted.slice(1, -1))) {
      assert.ok(!Object.hasOwn(times, id), `${what} Each player is set once.`);
      times[id] = new Date(time).getTime();
    }
  }
  assert.deepStrictEqual(times, expected, what);
  assert.deepStrictEqual(Object.keys(options).sort(), ['silent', 'transaction', 'where'], what);
  assert.strictEqual(options.silent, true, what);
  assert.strictEqual(options.transaction, TRANSACTION, what);
  assert.deepStrictEqual(Object.keys(options.where), ['id'], what);
  assert.deepStrictEqual([...options.where.id].sort(), Object.keys(expected).sort(), what);
}

const A = '76561198000000001';
const B = '76561198000000002';

// A lookup answers with the player as soon as they are read, with the time of this view as
// lastViewed, and saves nothing itself. The view is saved later, in the background.
const player = await view(A);
assert.strictEqual(player.id, A);
assert.strictEqual(player.lastViewed.getTime(), now, 'A lookup answers with its own time.');
assert.deepStrictEqual(saves, [], 'A lookup saves nothing itself.');
assert.strictEqual(updates.length, 0, 'A lookup does not wait for its view to be saved.');

// The views are recorded by query/record-view.js, whose limits the checks below work from.
const recordView = modules.get(
  new URL('../src/graphql-api/query/record-view.js', import.meta.url).href
);
assert.ok(recordView, 'Player lookups record views with query/record-view.js.');
const { VIEW_SAVE_INTERVAL, MAX_WAITING_VIEWS, SAVE_TIME_LIMIT, flushViews } = recordView.namespace;
assert.ok(VIEW_SAVE_INTERVAL >= 1000 && VIEW_SAVE_INTERVAL <= 60 * 1000);
assert.ok(MAX_WAITING_VIEWS >= 1000 && MAX_WAITING_VIEWS <= 10000);
assert.ok(SAVE_TIME_LIMIT > VIEW_SAVE_INTERVAL && SAVE_TIME_LIMIT <= 5 * 60 * 1000);

// A lookup of no player answers null and records no view. Nor does a lookup of a player without
// reputation points, who is not listed under Recently Viewed Players: it answers with the player
// as they are stored, and the next save leaves them out.
assert.strictEqual(await view('not-a-player'), null);
const withoutPoints = await view(NO_POINTS);
assert.strictEqual(withoutPoints.id, NO_POINTS);
assert.strictEqual(withoutPoints.lastViewed, undefined, 'A player without points is not recorded.');

// Ten views of two players, a second apart, wait for one save, which saves both in one statement.
// Each is saved as viewed at the time of their last view, so the player viewed last is listed
// first under Recently Viewed Players, whatever their Steam ID.
const viewedAt = {};
for (const id of [B, A, A, B, A, B, B, A, A]) {
  now += 1000;
  viewedAt[id] = now;
  assert.strictEqual((await view(id)).id, id);
}
assert.strictEqual(updates.length, 0);
now += VIEW_SAVE_INTERVAL;
let finishSave;
answers.push(() => new Promise((resolve) => (finishSave = resolve)));
runTimer();
await assertSaved(
  viewedAt,
  'Ten views of two players make one save of both, each at its own time.'
);
assert.ok(viewedAt[A] > viewedAt[B]);

// While a save has not finished, as when the database has locked the rows, lookups still answer at
// once, and no other save starts. The players viewed meanwhile wait for the next save.
const C = '76561198000000003';
const D = '76561198000000004';
for (const id of [C, D, C]) assert.strictEqual((await view(id)).id, id);
await settle();
assert.strictEqual(timersOf(VIEW_SAVE_INTERVAL).length, 0, 'No save is due while one is running.');
assert.strictEqual(timersOf(SAVE_TIME_LIMIT).length, 1, 'A running save has a time limit.');
assert.strictEqual(updates.length, 0, 'No save starts while one is running.');

finishSave([1]);
await settle();
answers.push(async () => [2]);
runTimer();
await assertSaved([C, D], 'The views made during a save are saved next.');
await settle();
assert.strictEqual(timers.length, 0, 'Nothing is due when no view is waiting.');

// A save skips the rows another query has locked, e.g. an importer transaction, and saves the rest.
// The skipped views wait for the next save, at the time they were made, unless the player has been
// viewed again since. A save that finds every row locked saves nothing and tries again later.
const J = '76561198000000010';
const K = '76561198000000011';
const L = '76561198000000012';
lockedRows.add(J).add(K);
const jViewedAt = now;
for (const id of [J, K, L]) await view(id);
answers.push(async () => [1]);
runTimer();
await assertSaved([L], 'A save skips the locked rows.', [J, K, L]);
await settle();
now += 2000;
await view(K);
runTimer();
await assertLocked([J, K], 'A skipped view is saved next time.');
assert.strictEqual(updates.length, 0, 'A save that finds every row locked saves nothing.');
await settle();
lockedRows.clear();
answers.push(async () => [2]);
runTimer();
await assertSaved(
  { [J]: jViewedAt, [K]: now },
  'Skipped views are saved once their rows are free, with the newest view of each player.'
);
await settle();
assert.strictEqual(timers.length, 0);
assert.deepStrictEqual(logged, []);

// A save that does not finish in time, e.g. as its database connection stopped answering, is logged
// once and given up on, so that later views are still saved.
const M = '76561198000000013';
await view(M);
let finishLate;
answers.push(() => new Promise((resolve) => (finishLate = resolve)));
runTimer();
await assertSaved([M], 'A save is running.');
await view(L);
await settle();
assert.strictEqual(timersOf(VIEW_SAVE_INTERVAL).length, 0, 'No save is due while one is running.');
assert.strictEqual(timersOf(SAVE_TIME_LIMIT).length, 1, 'A running save has a time limit.');
timers.splice(0)[0].callback();
await settle();
assert.deepStrictEqual(logged, [
  [
    `Could not save which players were viewed: Error: The save took longer than ${SAVE_TIME_LIMIT / 1000} seconds.`
  ]
]);
logged.length = 0;
answers.push(async () => [1]);
runTimer();
await assertSaved([L], 'The views made during a save that ran out of time are saved next.');
finishLate([1]);
await settle();
assert.strictEqual(timers.length, 0);
assert.deepStrictEqual(logged, [], 'A save that finishes after its time limit logs nothing.');

// A save that fails is logged once, by its error's name and message only, and its views are
// dropped. The next save works, whether the last failed with a rejected promise or by throwing.
const failure = Object.assign(new Error('Connection lost: The server closed the connection.'), {
  name: 'SequelizeDatabaseError',
  sql: 'UPDATE `SteamUsers` SET `lastViewed`=? WHERE `id` IN (?)'
});
const E = '76561198000000005';
const F = '76561198000000006';
const G = '76561198000000007';
for (const [id, answer] of [
  [E, () => Promise.reject(failure)],
  [
    F,
    () => {
      throw failure;
    }
  ]
]) {
  await view(id);
  answers.push(answer);
  runTimer();
  await assertSaved([id], 'A failing save is made.');
  await settle();
  assert.deepStrictEqual(logged, [
    [
      'Could not save which players were viewed: SequelizeDatabaseError: Connection lost: The server closed the connection.'
    ]
  ]);
  logged.length = 0;
  assert.strictEqual(timers.length, 0, 'The views of a failed save are not saved again.');
}
await view(G);
answers.push(async () => [1]);
runTimer();
await assertSaved([G], 'A save after a failed one works.');
await settle();
assert.deepStrictEqual(logged, []);

// flushViews saves the views waiting now without waiting for the timer, and leaves no timer.
const H = '76561198000000008';
const I = '76561198000000009';
await view(H);
now += 1400;
await view(I);
answers.push(async () => [2]);
await flushViews();
await assertSaved({ [H]: now - 1400, [I]: now }, 'flushViews saves the waiting views.');
assert.strictEqual(timers.length, 0, 'No save is due after flushViews.');
await flushViews();
assert.strictEqual(updates.length, 0, 'flushViews saves nothing when no view is waiting.');

// While a save is running, flushViews waits for it to end, then saves the views made meanwhile.
await view(H);
answers.push(() => new Promise((resolve) => (finishSave = resolve)));
runTimer();
await assertSaved([H], 'A save is running.');
await view(I);
let flushed = false;
const flushing = flushViews().then(() => (flushed = true));
await settle();
assert.strictEqual(updates.length, 0, 'flushViews does not start a save while one is running.');
assert.strictEqual(flushed, false);
answers.push(async () => [1]);
finishSave([1]);
await flushing;
await assertSaved([I], 'flushViews saves the views made during the running save.');
assert.strictEqual(timers.length, 0, 'No save is due after flushViews.');

// At most MAX_WAITING_VIEWS players wait to be saved. When more are viewed, the ones viewed
// longest ago are left out. A player viewed again counts as viewed last.
const many = Array.from(
  { length: MAX_WAITING_VIEWS + 10 },
  (_, i) => `7656${String(i).padStart(13, '0')}`
);
for (const id of many) await view(id);
await view(many[0]);
answers.push(async () => [MAX_WAITING_VIEWS]);
runTimer();
await assertSaved([many[0], ...many.slice(11)], 'The players viewed last wait to be saved.');
await settle();

assert.deepStrictEqual(saves, [], 'No lookup saved its player itself.');
assert.deepStrictEqual(logged, []);
assert.deepStrictEqual(unhandled, [], 'No error was left unhandled.');

console.log(
  'Player view checks passed: lookups answer at once, and views are saved together, one save at a time.'
);
