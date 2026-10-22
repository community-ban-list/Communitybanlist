import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import Validators from '../../scbl-lib/validators.js';

// Checks for the limit on the players an export ban list can have (mutation/check-size.js). Part 1
// loads check-size.js on its own, with stand-ins for the counts and a clock the checks set. Part 2
// makes changes through mutation/index.js to the real resolvers, with stand-ins for the database,
// the counts, Discord and BattleMetrics.

// Load a module in a context. The imports in `stubs` get those exports, and other relative imports
// load the real files.
async function load(path, stubs, context) {
  const create = async (url) =>
    new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  const linker = async (specifier, referencingModule) => {
    if (Object.hasOwn(stubs, specifier)) {
      const exports = stubs[specifier];
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    }
    assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    return create(new URL(specifier, referencingModule.identifier));
  };
  const module = await create(new URL(path, import.meta.url));
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

// Stand-ins for the counts in scbl-lib/db/export-membership.js. Each count is recorded, as
// { settings, configs, options } for a list and { bans, options } for the players with that many
// bans, copied out of the module's context to compare them. It is answered at once by `answer`,
// when that is set, with what it returns or throws, and otherwise waits until the checks finish it,
// so they can see which counts run at once.
function countStandIns() {
  const calls = [];
  const waiting = [];
  const counts = {
    calls,
    waiting,
    answer: undefined,
    // Finish the count that has waited longest, with a number or an error.
    finish(result) {
      const { resolve, reject } = waiting.shift();
      if (result instanceof Error) reject(result);
      else resolve(result);
    }
  };
  const count = (call) => {
    calls.push(JSON.parse(JSON.stringify(call)));
    if (counts.answer) return Promise.resolve().then(() => counts.answer(call));
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  counts.exports = {
    countMembers: (settings, configs, options) => count({ settings, configs, options }),
    countPlayersWithBans: (bans, options) => count({ bans, options })
  };
  return counts;
}

// Timers for a module's context that only go off when the checks set them off, so a count can go
// unanswered for as long as the checks need. Each is recorded with its wait, in milliseconds.
function fakeTimers() {
  const pending = new Set();
  return {
    // The waits of the timers that are set and have not been cleared or set off.
    waits: () => [...pending].map(({ ms }) => ms),
    // Set off every timer that is waiting now.
    fire() {
      for (const timer of [...pending]) {
        pending.delete(timer);
        timer.callback();
      }
    },
    globals: {
      setTimeout: (callback, ms) => {
        const timer = { callback, ms };
        pending.add(timer);
        return timer;
      },
      clearTimeout: (timer) => pending.delete(timer)
    }
  };
}

// Answers for the counts, given in turn.
const inTurn =
  (...numbers) =>
  () => {
    assert.ok(numbers.length > 0, 'A count ran that was not expected.');
    return numbers.shift();
  };

// The error Sequelize gives for a count that MySQL stops at its time limit.
const timedOut = () =>
  Object.assign(
    new Error('Query execution was interrupted, maximum statement execution time exceeded'),
    { name: 'SequelizeDatabaseError', original: { code: 'ER_QUERY_TIMEOUT', errno: 3024 } }
  );

// What a change or a check comes to: 'allowed', or the message it was refused with. Every refusal
// is marked as one, so guard-changes.js does not count a refused creation towards its limits.
const outcome = (checking) =>
  checking.then(
    () => 'allowed',
    (error) => {
      assert.strictEqual(error.refusal, true, `Not marked as a refusal: ${error.message}`);
      return error.message;
    }
  );

// Let the checks in progress run until they wait for something the checks here control.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const SECOND = 1000;
const as = (id) => ({ user: { id } });
const settingsOf = (settings) => ({ ...exportListLimits.DEFAULT_SETTINGS, ...settings });
const listOf = (settings, configs = []) => ({ settings: settingsOf(settings), configs });
// One ban is enough with these settings, which is allowed when the points rules are turned off.
const ANY_BAN = { threshold: 4, defaultActivePoints: 1, defaultExpiredPoints: 1 };

// The points rules turned off for both types, as their environment variables set it.
const NONE = { EXPORT_BM_NEVER_ENOUGH: 'none', EXPORT_REMOTE_NEVER_ENOUGH: 'none' };

// The messages, with the default limits of 20,000 players for BattleMetrics lists and 40,000 for
// remote lists.
const BATTLEMETRICS_LIMIT =
  'A BattleMetrics export ban list can have at most 20,000, as each player is added to BattleMetrics separately.';
const REMOTE_LIMIT = 'A remote export ban list can have at most 40,000.';
const SETTINGS_INSTEAD = 'Raise the threshold, lower the points or set a max ban age.';
const REMOTE_INSTEAD =
  'Or create a remote export ban list instead, which can have up to 40,000: your Squad servers download it from its address, shown under Install.';
const ANY_REMOTE_INSTEAD =
  'Or create a remote export ban list instead, which has no limit on its players: your Squad servers download it from its address, shown under Install.';
const BUSY =
  'Too many export ban list changes are being checked right now. Please try again in a minute.';
const COULD_NOT_COUNT =
  'We could not work out how many players this change would put on your export ban list. Please try again shortly.';
const POPULATION = (players, type, limit, over) =>
  over
    ? `Export ban list sizes: ${players} players have two or more bans, over the ${type} cap of ${limit}, so ${type} list changes are now counted one by one.`
    : `Export ban list sizes: ${players} players have two or more bans, within the ${type} cap of ${limit} again, so ${type} list changes are no longer counted one by one.`;
const TIMED_OUT =
  'SequelizeDatabaseError: Query execution was interrupted, maximum statement execution time exceeded';

// Part 1: check-size.js on its own, with a clock the checks set.

let time = 0;
const now = () => time;

// Load check-size.js with the limits these environment variables set. `check` makes a change by a
// user as resolver.js gives it to checkSize, from the list before (null for a new list) and after
// it, with what checkChange gives for it. The list's ID is 7, and the user has room for another.
// The module's timers only go off when the checks set them off.
async function sizeChecks(env) {
  const limits = exportListLimits.readLimits(env).limits;
  const counts = countStandIns();
  const timers = fakeTimers();
  const logged = [];
  const { default: checkSize, ...constants } = await load(
    '../src/graphql-api/mutation/check-size.js',
    {
      'scbl-lib/config': { EXPORT_LIST_LIMITS: limits },
      'scbl-lib/db/export-membership': counts.exports,
      'scbl-lib/export-list-limits': exportListLimits
    },
    vm.createContext({
      console: { log: (line) => logged.push(line), error: (line) => logged.push(line) },
      ...timers.globals
    })
  );
  const check = (user, type, before, after, more) =>
    outcome(
      checkSize(
        as(user),
        {
          type,
          exportBanList: before ? 7 : undefined,
          kind: before ? 'update' : 'create',
          before,
          after,
          change: exportListLimits.checkChange(type, before, after, limits),
          hasRoomForList: async () => true,
          ...more
        },
        now
      )
    );
  return { check, constants, counts, logged, timers };
}

const { constants } = await sizeChecks({});
const {
  POPULATION_KEPT,
  COUNTS_PER_USER,
  COUNTS_PERIOD,
  COUNTS_WAITING,
  TIME_LIMIT,
  ANSWER_LIMIT
} = constants;
// The checks below work out their times and counts from these, so they can be tuned within these
// bounds without changing the checks.
assert.ok(POPULATION_KEPT >= 60 * SECOND, 'The checks need the population kept for a minute.');
assert.ok(COUNTS_PER_USER >= 2, 'Creating a list and adding a config takes 2 counts.');
assert.ok(COUNTS_PERIOD > (COUNTS_PER_USER + 1) * SECOND, 'The checks need a longer period.');
assert.ok(COUNTS_WAITING > COUNTS_PER_USER, 'The checks need room for more counts to wait.');
assert.strictEqual(TIME_LIMIT, 3000, 'Each count stops after 3 seconds.');
assert.ok(ANSWER_LIMIT > TIME_LIMIT, 'MySQL stops a count before the web server gives up on it.');
const counting = { timeLimit: TIME_LIMIT };
const twoBans = { bans: 2, options: counting };
const rateLimit = (wait) =>
  `Saving this change needs a count of the players it would list, and each user can run ${COUNTS_PER_USER} counts every ${COUNTS_PERIOD / SECOND} seconds. Please try again in ${wait}.`;
// What is logged of a count the database did not answer in time.
const NO_ANSWER = `Error: The database did not answer the count within ${ANSWER_LIMIT / SECOND} seconds.`;

// With the default limits, one active ban plus one expired ban is never enough to put a player on
// a list, so a list within the rules holds only players with two or more bans. Those players are
// counted once for POPULATION_KEPT, and changes at the same time share the count. While they are
// within a type's limit, no list of that type is counted.
{
  const { check, counts, logged, timers } = await sizeChecks({});
  time = 0;
  const finished = [];
  const together = [
    check('a', 'battlemetrics', null, listOf({ threshold: 9 })),
    check('b', 'remote', null, listOf({ threshold: 6 }))
  ].map((checking, i) => checking.finally(() => finished.push(i)));
  await settle();
  assert.deepStrictEqual(counts.calls, [twoBans]);
  assert.deepStrictEqual(finished, [], 'Both changes wait for the count.');
  counts.finish(13289);
  assert.deepStrictEqual(await Promise.all(together), ['allowed', 'allowed']);

  // Until the count is POPULATION_KEPT old, changes use it, and then it is counted again.
  counts.answer = inTurn(13300);
  const before = listOf({ threshold: 9 });
  const lower = listOf({ threshold: 6 });
  time = POPULATION_KEPT - 1;
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.strictEqual(counts.calls.length, 1);
  time = POPULATION_KEPT;
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.deepStrictEqual(counts.calls.slice(1), [twoBans]);
  assert.deepStrictEqual(logged, []);

  // Once they are over a type's limit, which the log says once, changes to its lists are counted
  // one by one, while the other type's lists still need no count.
  time = 2 * POPULATION_KEPT;
  counts.answer = inTurn(21034, 9000);
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.deepStrictEqual(counts.calls.slice(2), [
    twoBans,
    { settings: lower.settings, configs: [], options: counting }
  ]);
  assert.deepStrictEqual(logged, [POPULATION('21,034', 'BattleMetrics', '20,000', true)]);
  assert.strictEqual(await check('a', 'remote', before, lower), 'allowed');
  assert.strictEqual(counts.calls.length, 4);
  time = 3 * POPULATION_KEPT;
  counts.answer = inTurn(21500, 9000);
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.strictEqual(counts.calls.length, 6);
  assert.strictEqual(logged.length, 1);

  // Back at the limit, which is within it, as the log also says, lists need no count again.
  time = 4 * POPULATION_KEPT;
  counts.answer = inTurn(20000);
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.strictEqual(counts.calls.length, 7);
  assert.deepStrictEqual(logged.slice(1), [POPULATION('20,000', 'BattleMetrics', '20,000', false)]);

  // When a count fails, the last one is used until the next, here one over the limit.
  time = 5 * POPULATION_KEPT;
  counts.answer = inTurn(25000, 9000);
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  time = 6 * POPULATION_KEPT;
  counts.answer = (call) => {
    if (call.bans) throw timedOut();
    return 9000;
  };
  logged.length = 0;
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.deepStrictEqual(
    counts.calls.slice(9).map((call) => call.bans ?? 'list'),
    [2, 'list']
  );
  assert.deepStrictEqual(logged, [
    `Export ban list sizes: could not count the players who have two or more bans, so the last count, 25,000, is used until they are counted again in ${POPULATION_KEPT / 60000} minutes: ${TIMED_OUT}`
  ]);
  time = 7 * POPULATION_KEPT - 1;
  assert.strictEqual(await check('a', 'battlemetrics', before, lower), 'allowed');
  assert.deepStrictEqual(
    counts.calls.slice(11).map((call) => call.bans ?? 'list'),
    ['list']
  );

  // Changes that can only make a list smaller, or keep it the same, need no count.
  for (const after of [listOf({ threshold: 10 }), listOf({ maxBanAge: 365 }), before])
    assert.strictEqual(await check('a', 'battlemetrics', before, after), 'allowed');
  assert.strictEqual(counts.calls.length, 12);
  // Each count's timer was cleared once the count was answered or failed.
  assert.deepStrictEqual(timers.waits(), []);
}

// With no count of them yet, as it failed, a change within the rules is allowed and the failure
// logged. They are counted again POPULATION_KEPT later.
{
  const { check, counts, logged } = await sizeChecks({});
  time = 0;
  counts.answer = () => {
    throw timedOut();
  };
  assert.strictEqual(await check('a', 'battlemetrics', null, listOf()), 'allowed');
  assert.deepStrictEqual(logged, [
    `Export ban list sizes: could not count the players who have two or more bans, so changes within the points rules are allowed without counting their players until they are counted again in ${POPULATION_KEPT / 60000} minutes: ${TIMED_OUT}`
  ]);
  time = POPULATION_KEPT - 1;
  assert.strictEqual(await check('b', 'remote', null, listOf()), 'allowed');
  assert.strictEqual(counts.calls.length, 1);
  time = POPULATION_KEPT;
  counts.answer = inTurn(13289);
  assert.strictEqual(await check('b', 'remote', null, listOf()), 'allowed');
  assert.deepStrictEqual(counts.calls.slice(1), [twoBans]);
  assert.strictEqual(logged.length, 1);
}

// With a type's rules turned off, every change that could make one of its lists bigger is counted,
// with the settings and configs it would have, and is refused if they would put it over the limit.
{
  const { check, counts, logged } = await sizeChecks(NONE);
  time = 0;
  const anyBan = listOf(ANY_BAN);

  // A new list. A BattleMetrics list can be a remote list instead, when one would be within the
  // limit on remote lists and the user has room for another list.
  counts.answer = inTurn(25692, 45120, 25692, 45120, 40000);
  assert.strictEqual(
    await check('a', 'battlemetrics', null, anyBan),
    `These settings would put 25,692 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${REMOTE_INSTEAD}`
  );
  assert.deepStrictEqual(counts.calls, [
    { settings: anyBan.settings, configs: [], options: counting }
  ]);
  assert.strictEqual(
    await check('b', 'battlemetrics', null, anyBan),
    `These settings would put 45,120 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD}`
  );
  assert.strictEqual(
    await check('c', 'battlemetrics', null, anyBan, { hasRoomForList: async () => false }),
    `These settings would put 25,692 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD}`
  );
  let askedForRoom = false;
  const room = async () => (askedForRoom = true);
  assert.strictEqual(
    await check('d', 'remote', null, anyBan, { hasRoomForList: room }),
    `These settings would put 45,120 players on your export ban list. ${REMOTE_LIMIT} ${SETTINGS_INSTEAD}`
  );
  assert.strictEqual(askedForRoom, false);
  // A list at the limit is allowed.
  assert.strictEqual(await check('e', 'remote', null, anyBan), 'allowed');
  assert.deepStrictEqual(logged, [
    'Export ban list sizes: refused a change that would put 25,692 players on a new BattleMetrics export ban list, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 45,120 players on a new BattleMetrics export ban list, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 25,692 players on a new BattleMetrics export ban list, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 45,120 players on a new remote export ban list, over the cap of 40,000.'
  ]);

  // A list that exists is also counted as it is when the change would put it over the limit, so
  // a change that leaves it no bigger is allowed. The two counts take one of the user's.
  logged.length = 0;
  counts.calls.length = 0;
  const configs = [
    { id: 1, banList: 1, activePoints: 3, expiredPoints: 1 },
    { id: 2, banList: 1, activePoints: 3, expiredPoints: 1 }
  ];
  const stored = listOf({ threshold: 9 }, configs);
  const growing = listOf({ threshold: 5 }, configs);
  counts.answer = inTurn(25692, 7943, 25692, 25692, 19000);
  assert.strictEqual(
    await check('f', 'battlemetrics', stored, growing),
    `These changes would put 25,692 players on this export ban list, up from 7,943. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${REMOTE_INSTEAD}`
  );
  assert.deepStrictEqual(counts.calls, [
    { settings: growing.settings, configs, options: counting },
    { settings: stored.settings, configs, options: counting }
  ]);
  assert.strictEqual(await check('f', 'battlemetrics', stored, growing), 'allowed');
  // Within the limit, the list is not counted as it is.
  assert.strictEqual(await check('f', 'battlemetrics', stored, growing), 'allowed');
  assert.strictEqual(counts.calls.length, 5);
  assert.deepStrictEqual(logged, [
    'Export ban list sizes: refused a change that would put 25,692 players on BattleMetrics export ban list 7, up from 7,943, over the cap of 20,000.'
  ]);

  // A remote list is only suggested when its points rules would allow one. Here only BattleMetrics
  // lists have their rules turned off, and one active ban is enough with 5/5/1.
  const remoteRules = await sizeChecks({ EXPORT_BM_NEVER_ENOUGH: 'none' });
  remoteRules.counts.answer = inTurn(28337, 21000);
  const fiveFive = (threshold) => listOf({ threshold, defaultActivePoints: 5 });
  assert.strictEqual(
    await remoteRules.check('a', 'battlemetrics', null, fiveFive(5)),
    `These settings would put 28,337 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD}`
  );
  assert.strictEqual(
    await remoteRules.check('a', 'battlemetrics', null, fiveFive(7)),
    `These settings would put 21,000 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${REMOTE_INSTEAD}`
  );
  // With no limit on remote lists, the suggestion says so, and remote lists are never counted.
  const noRemoteLimit = await sizeChecks({ ...NONE, EXPORT_REMOTE_MAX_PLAYERS: '0' });
  noRemoteLimit.counts.answer = inTurn(65000);
  assert.strictEqual(
    await noRemoteLimit.check('a', 'battlemetrics', null, anyBan),
    `These settings would put 65,000 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${ANY_REMOTE_INSTEAD}`
  );
  assert.strictEqual(await noRemoteLimit.check('a', 'remote', null, anyBan), 'allowed');
  assert.strictEqual(noRemoteLimit.counts.calls.length, 1);
}

// Each user can start COUNTS_PER_USER counts every COUNTS_PERIOD. The limit is checked when a
// change arrives, and a change it refuses uses none of them.
{
  const { check, counts } = await sizeChecks(NONE);
  const start = 1000 * SECOND;
  counts.answer = () => 100;
  const lower = listOf({ threshold: 6 });
  for (let i = 0; i < COUNTS_PER_USER; i++) {
    time = start + i * SECOND;
    assert.strictEqual(await check('user', 'remote', listOf(), lower), 'allowed');
  }
  time = start + COUNTS_PER_USER * SECOND;
  assert.strictEqual(
    await check('user', 'remote', listOf(), lower),
    rateLimit(`${COUNTS_PERIOD / SECOND - COUNTS_PER_USER} seconds`)
  );
  assert.strictEqual(counts.calls.length, COUNTS_PER_USER);
  // Other users are not limited by it.
  assert.strictEqual(await check('another user', 'remote', listOf(), lower), 'allowed');
  // Once the first count is COUNTS_PERIOD old, the user can start one more, as the refused change
  // used none.
  time = start + COUNTS_PERIOD - 1;
  assert.strictEqual(await check('user', 'remote', listOf(), lower), rateLimit('1 second'));
  time = start + COUNTS_PERIOD;
  assert.strictEqual(await check('user', 'remote', listOf(), lower), 'allowed');
  assert.strictEqual(await check('user', 'remote', listOf(), lower), rateLimit('1 second'));

  // The limit is checked again, and the count recorded, when a count starts. Without the guard on
  // mutations, a user can ask for more counts at once than they can start, and those beyond the
  // limit are refused as their turns come.
  time = 2000 * SECOND;
  counts.answer = undefined;
  const running = check('someone', 'remote', listOf(), lower);
  await settle();
  const atOnce = Array.from({ length: COUNTS_PER_USER + 1 }, () =>
    check('eager', 'remote', listOf(), lower)
  );
  await settle();
  for (let i = 0; i <= COUNTS_PER_USER; i++) {
    counts.finish(100);
    await settle();
  }
  assert.strictEqual(await running, 'allowed');
  assert.deepStrictEqual(await Promise.all(atOnce), [
    ...Array(COUNTS_PER_USER).fill('allowed'),
    rateLimit(`${COUNTS_PERIOD / SECOND} seconds`)
  ]);
  assert.strictEqual(counts.waiting.length, 0);

  // A user who has started all the counts they can for now is refused as soon as their change
  // arrives, rather than when its turn would come: here while another user's count runs. The
  // refused change takes no place among those waiting, and the user is told when to try again
  // even when every place is taken.
  const another = check('someone', 'remote', listOf(), lower);
  await settle();
  const refusedAtOnce = [];
  check('eager', 'remote', listOf(), lower).then((result) => refusedAtOnce.push(result));
  await settle();
  assert.deepStrictEqual(refusedAtOnce, [rateLimit(`${COUNTS_PERIOD / SECOND} seconds`)]);
  const waiting = Array.from({ length: COUNTS_WAITING }, (_, i) =>
    check(`waiting ${i}`, 'remote', listOf(), lower)
  );
  await settle();
  assert.strictEqual(await check('busy', 'remote', listOf(), lower), BUSY);
  assert.strictEqual(
    await check('eager', 'remote', listOf(), lower),
    rateLimit(`${COUNTS_PERIOD / SECOND} seconds`)
  );
  for (let i = 0; i <= COUNTS_WAITING; i++) {
    counts.finish(100);
    await settle();
  }
  assert.deepStrictEqual(
    await Promise.all([another, ...waiting]),
    Array(COUNTS_WAITING + 1).fill('allowed')
  );
  assert.strictEqual(counts.waiting.length, 0);
}

// One count runs at a time, server-wide, and COUNTS_WAITING can wait for it. A change that would
// wait beyond that is refused as busy, and uses none of the user's counts. A count that fails
// refuses its change with a plain message, and the next one still runs.
{
  const { check, counts, logged } = await sizeChecks(NONE);
  time = 0;
  const growing = [listOf(), listOf({ threshold: 6 })];
  const changes = Array.from({ length: COUNTS_WAITING + 1 }, (_, i) =>
    check(`user ${i}`, 'battlemetrics', ...growing)
  );
  await settle();
  assert.strictEqual(counts.calls.length, 1, 'Only one count runs.');
  assert.strictEqual(await check('busy', 'battlemetrics', ...growing), BUSY);

  // The first count fails, and the others run in turn.
  counts.finish(timedOut());
  await settle();
  for (let i = 1; i <= COUNTS_WAITING; i++) {
    assert.deepStrictEqual([counts.calls.length, counts.waiting.length], [i + 1, 1]);
    counts.finish(100);
    await settle();
  }
  assert.deepStrictEqual(await Promise.all(changes), [
    COULD_NOT_COUNT,
    ...Array(COUNTS_WAITING).fill('allowed')
  ]);
  assert.deepStrictEqual(logged, [
    `Export ban list sizes: could not count the players for BattleMetrics export ban list 7, so the change was refused: ${TIMED_OUT}`
  ]);

  // The user refused as busy can start all their counts.
  counts.answer = () => 100;
  for (let i = 0; i < COUNTS_PER_USER; i++)
    assert.strictEqual(await check('busy', 'battlemetrics', ...growing), 'allowed');

  // The count of the players with two or more bans takes its turn too, but is never refused. Here
  // BattleMetrics lists have their rules turned off, so their changes are counted, and fill the
  // turns while a change to a remote list waits for that count. Those players are over the
  // BattleMetrics limit and within the remote one. The log leaves the BattleMetrics limit out, as
  // BattleMetrics lists are counted one by one however many there are, and the remote list is not
  // counted.
  const mixed = await sizeChecks({ EXPORT_BM_NEVER_ENOUGH: 'none' });
  const full = Array.from({ length: COUNTS_WAITING + 1 }, (_, i) =>
    mixed.check(`user ${i}`, 'battlemetrics', ...growing)
  );
  const remote = mixed.check('remote user', 'remote', ...growing);
  await settle();
  assert.strictEqual(mixed.counts.calls.length, 1);
  for (let i = 0; i <= COUNTS_WAITING; i++) {
    mixed.counts.finish(100);
    await settle();
  }
  assert.deepStrictEqual(mixed.counts.calls.at(-1), twoBans);
  mixed.counts.finish(21034);
  assert.deepStrictEqual(
    await Promise.all([...full, remote]),
    Array(COUNTS_WAITING + 2).fill('allowed')
  );
  assert.strictEqual(mixed.counts.calls.length, COUNTS_WAITING + 2);
  assert.deepStrictEqual(mixed.logged, []);
}

// A count the database does not answer within ANSWER_LIMIT, as on a connection that has stopped
// answering, is given up on as a count that failed. The changes waiting for it go on, and the next
// count takes its turn.
{
  // Remote lists keep their rules, so their changes use the count of the players with two or more
  // bans. BattleMetrics lists have theirs turned off, so their changes are counted one by one.
  const { check, counts, logged, timers } = await sizeChecks({ EXPORT_BM_NEVER_ENOUGH: 'none' });
  time = 0;
  const growing = [listOf(), listOf({ threshold: 6 })];
  const remote = [check('a', 'remote', null, listOf()), check('b', 'remote', ...growing)];
  const battlemetrics = check('c', 'battlemetrics', null, listOf(ANY_BAN));
  await settle();
  assert.deepStrictEqual(counts.calls, [twoBans]);
  assert.deepStrictEqual(timers.waits(), [ANSWER_LIMIT]);

  // With no count of the players with two or more bans, the remote changes are allowed, as when
  // the count fails, and the BattleMetrics list's count runs.
  timers.fire();
  assert.deepStrictEqual(await Promise.all(remote), ['allowed', 'allowed']);
  await settle();
  assert.deepStrictEqual(counts.calls.slice(1), [
    { settings: settingsOf(ANY_BAN), configs: [], options: counting }
  ]);
  assert.deepStrictEqual(timers.waits(), [ANSWER_LIMIT]);
  // A list's count with no answer refuses its change with the plain message.
  timers.fire();
  assert.strictEqual(await battlemetrics, COULD_NOT_COUNT);
  assert.deepStrictEqual(logged, [
    `Export ban list sizes: could not count the players who have two or more bans, so changes within the points rules are allowed without counting their players until they are counted again in ${POPULATION_KEPT / 60000} minutes: ${NO_ANSWER}`,
    `Export ban list sizes: could not count the players for a new BattleMetrics export ban list, so the change was refused: ${NO_ANSWER}`
  ]);

  // Answers that come late are not used. These would put the players with two or more bans over
  // the limit on remote lists, which would then be counted one by one.
  counts.finish(45120);
  counts.finish(25692);
  await settle();
  assert.strictEqual(await check('a', 'remote', null, listOf()), 'allowed');
  assert.strictEqual(counts.calls.length, 2);
  assert.strictEqual(logged.length, 2);

  // When a list would be over its limit, its count as it is now is given up on in the same way.
  // An answered count's timer is cleared.
  const overLimit = check('d', 'battlemetrics', ...growing);
  await settle();
  counts.finish(25692);
  await settle();
  assert.strictEqual(counts.calls.length, 4);
  assert.deepStrictEqual(timers.waits(), [ANSWER_LIMIT]);
  timers.fire();
  assert.strictEqual(await overLimit, COULD_NOT_COUNT);
  counts.finish(7943);
  await settle();
  assert.deepStrictEqual([timers.waits(), counts.waiting.length], [[], 0]);
}

// Lists of a type with no limit, or changes that can only make a list smaller, are not counted.
{
  const { check, counts } = await sizeChecks({ ...NONE, EXPORT_BM_MAX_PLAYERS: '0' });
  counts.answer = () => assert.fail('A list was counted.');
  assert.strictEqual(await check('a', 'battlemetrics', null, listOf(ANY_BAN)), 'allowed');
  assert.strictEqual(
    await check('a', 'remote', listOf({ threshold: 4 }), listOf({ threshold: 5 })),
    'allowed'
  );
  assert.strictEqual(counts.calls.length, 0);

  // Nor does the log compare the players with two or more bans with a type that has no limit.
  const noRemoteLimit = await sizeChecks({ EXPORT_REMOTE_MAX_PLAYERS: '0' });
  noRemoteLimit.counts.answer = inTurn(45120, 9000);
  assert.strictEqual(await noRemoteLimit.check('a', 'battlemetrics', null, listOf()), 'allowed');
  assert.deepStrictEqual(noRemoteLimit.logged, [
    POPULATION('45,120', 'BattleMetrics', '20,000', true)
  ]);
}

// Part 2: changes through mutation/index.js to the real resolvers.

// Stand-ins for the models, over rows kept here. Like Sequelize, lookups hand out copies of the
// rows that match the whole where clause, with the rows they include, and only save, create and
// destroy write back. Every query, write and request to BattleMetrics is recorded.
function database() {
  const rows = {
    Organisation: [{ id: 1, name: 'Partner Org 1' }],
    BanList: [
      { id: 1, name: 'Ban List 1', organisation: 1 },
      { id: 2, name: 'Ban List 2', organisation: 1 },
      { id: 3, name: 'Ban List 3', organisation: 1 }
    ],
    ExportBanList: [],
    ExportBanListConfig: []
  };
  const queries = [];
  const writes = [];
  const battlemetrics = [];
  let nextID = 100;

  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field !== '$ExportBanList.owner$') return row[field] === value;
      const list = rows.ExportBanList.find((list) => list.id === row.exportBanList);
      return list !== undefined && list.owner === value;
    });

  function copy(model, row) {
    const methods = {
      async save() {
        writes.push(`save ${model} ${this.id}`);
        const { ExportBanList, BanList, ...values } = this;
        Object.assign(row, values);
      },
      async destroy() {
        writes.push(`destroy ${model} ${this.id}`);
        rows[model].splice(rows[model].indexOf(row), 1);
      },
      async createBattlemetricsBanList() {
        battlemetrics.push(`create the ban list for ${this.id}`);
        this.battlemetricsID = `bm-${this.id}`;
        await this.save();
      },
      async createBattlemetricsInvite() {}
    };
    return Object.assign(Object.create(methods), row);
  }

  // The rows a lookup includes, as Sequelize adds them.
  function withIncluded(found, include = []) {
    for (const included of include) {
      if (included === models.ExportBanList)
        found.ExportBanList = copy(
          'ExportBanList',
          rows.ExportBanList.find((list) => list.id === found.exportBanList)
        );
      else if (included === models.Organisation)
        found.Organisation = { ...rows.Organisation.find(({ id }) => id === found.organisation) };
      else if (included.model === models.BanList)
        found.BanList = withIncluded(
          { ...rows.BanList.find(({ id }) => id === found.banList) },
          included.include
        );
      else assert.fail('A lookup has an unexpected include.');
    }
    return found;
  }

  const model = (name) => ({
    async count({ where }) {
      queries.push(`${name}.count`);
      return rows[name].filter((row) => matches(row, where)).length;
    },
    async findOne({ where, include }) {
      queries.push(`${name}.findOne`);
      const row = rows[name].find((row) => matches(row, where));
      return row ? withIncluded(copy(name, row), include) : null;
    },
    async findAll({ where, include }) {
      queries.push(`${name}.findAll`);
      return rows[name]
        .filter((row) => matches(row, where))
        .map((row) => withIncluded(copy(name, row), include));
    },
    async create(values) {
      const row = { id: nextID++, ...values };
      rows[name].push(row);
      writes.push(`create ${name} ${row.id}`);
      return copy(name, row);
    }
  });
  const models = {
    BanList: model('BanList'),
    ExportBanList: model('ExportBanList'),
    ExportBanListConfig: model('ExportBanListConfig'),
    Organisation: model('Organisation')
  };
  return { rows, queries, writes, battlemetrics, models };
}

// Load the mutations, as mutation/index.js guards them, with the limits these environment
// variables set. Webhook tests are recorded, and all of them pass. No list is counted unless the
// checks give the counts an answer, and the timers only go off when the checks set them off.
async function mutations(env) {
  const db = database();
  const counts = countStandIns();
  counts.answer = () => assert.fail('A list was counted.');
  const timers = fakeTimers();
  const tested = [];
  const logged = [];
  const { resolver } = await load(
    '../src/graphql-api/mutation/index.js',
    {
      './typedef.js': { default: { kind: 'Document' } },
      'scbl-lib/config': { EXPORT_LIST_LIMITS: exportListLimits.readLimits(env).limits },
      'scbl-lib/db/export-membership': counts.exports,
      'scbl-lib/db/models': db.models,
      'scbl-lib/export-list-limits': exportListLimits,
      'scbl-lib/utils': {
        isDiscordWebhookUrl,
        async testDiscordWebhook(url) {
          tested.push(url);
        }
      },
      'scbl-lib/validators': { default: Validators }
    },
    vm.createContext({
      console: { log: (line) => logged.push(line), error: (line) => logged.push(line) },
      ...timers.globals
    })
  );
  const { Mutation } = resolver;
  const change = (name, args, user) => outcome(Mutation[name](null, args, as(user), {}));

  // Check that a change is refused with a message, and that nothing was saved, no webhook was
  // tested and BattleMetrics was asked for nothing.
  async function refused(name, args, user, message) {
    const before = [db.writes.length, tested.length, db.battlemetrics.length];
    assert.strictEqual(await change(name, args, user), message);
    assert.deepStrictEqual([db.writes.length, tested.length, db.battlemetrics.length], before);
  }
  return { db, counts, timers, tested, logged, Mutation, change, refused };
}

const webhook = (id) => `https://discord.com/api/webhooks/${id}/token-${id}`;
const newList = (type, values) => ({
  name: 'New',
  server: 'Server',
  type,
  discordWebhook: webhook(1),
  ...values
});
const exportBanList = (owner, id, values) => ({
  id,
  owner,
  name: `List ${id}`,
  server: 'Server',
  type: 'battlemetrics',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: null,
  battlemetricsID: `bm-${id}`,
  battlemetricsInvite: 'invite',
  generated: true,
  ...values
});
// Configs as the counts are given them: what decides who is on a list, with the names for the
// messages.
const counted = (configs) =>
  configs.map(({ id, banList, activePoints, expiredPoints }) => ({
    id,
    banList,
    activePoints,
    expiredPoints,
    banListName: `Ban List ${banList}`,
    organisationName: 'Partner Org 1'
  }));
// A stored list's settings.
const scoringOf = ({ threshold, defaultActivePoints, defaultExpiredPoints, maxBanAge }) => ({
  threshold,
  defaultActivePoints,
  defaultExpiredPoints,
  maxBanAge
});

// With the rules turned off, creating a list is refused when it would be over its type's limit,
// before its webhook is tested or its BattleMetrics ban list created. A BattleMetrics list can be
// a remote list instead when one would be within the limit on those.
{
  const { db, counts, tested, logged, change, refused } = await mutations(NONE);
  counts.answer = inTurn(25692, 45120, 45120, 40000);
  await refused(
    'createExportBanList',
    newList('battlemetrics', ANY_BAN),
    'creator',
    `These settings would put 25,692 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${REMOTE_INSTEAD}`
  );
  assert.deepStrictEqual(counts.calls, [
    { settings: settingsOf(ANY_BAN), configs: [], options: counting }
  ]);
  await refused(
    'createExportBanList',
    newList('battlemetrics', ANY_BAN),
    'creator',
    `These settings would put 45,120 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD}`
  );
  await refused(
    'createExportBanList',
    newList('remote', ANY_BAN),
    'creator',
    `These settings would put 45,120 players on your export ban list. ${REMOTE_LIMIT} ${SETTINGS_INSTEAD}`
  );
  // Each creation counts the user's lists for the limit of 4, and only the refusal that suggests a
  // remote list counts them again.
  assert.strictEqual(db.queries.filter((query) => query === 'ExportBanList.count').length, 4);
  // A list within the limit is created, with the settings it was counted with. The user above has
  // run all their counts for now.
  assert.strictEqual(
    await change('createExportBanList', newList('remote', ANY_BAN), 'another creator'),
    'allowed'
  );
  assert.deepStrictEqual(db.writes, ['create ExportBanList 100']);
  assert.deepStrictEqual(tested, [webhook(1)]);
  assert.deepStrictEqual(scoringOf(db.rows.ExportBanList[0]), settingsOf(ANY_BAN));
  assert.deepStrictEqual(logged, [
    'Export ban list sizes: refused a change that would put 25,692 players on a new BattleMetrics export ban list, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 45,120 players on a new BattleMetrics export ban list, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 45,120 players on a new remote export ban list, over the cap of 40,000.'
  ]);
}

// Saving a list, and adding or deleting a config, are counted with the list's stored settings and
// configs with the change applied, duplicates included, and then as the list is. A change is
// refused when it would put the list over the limit and make it bigger.
{
  const { db, counts, timers, logged, change, refused } = await mutations(NONE);
  const { rows } = db;
  let configID = 1000;
  const configOf = (exportBanList, banList, activePoints, expiredPoints) => {
    const config = { id: configID++, exportBanList, banList, activePoints, expiredPoints };
    rows.ExportBanListConfig.push(config);
    return config;
  };

  // A user with 4 lists, so a refusal does not suggest creating a remote list.
  for (let id = 1; id <= 4; id++) rows.ExportBanList.push(exportBanList('full', id));
  const configs = [configOf(1, 1, 3, 1), configOf(1, 1, 3, 1), configOf(1, 2, 5, 1)];
  counts.answer = inTurn(25692, 7943);
  await refused(
    'updateExportBanList',
    { id: 1, name: 'List 1', threshold: 7 },
    'full',
    `These changes would put 25,692 players on this export ban list, up from 7,943. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD}`
  );
  assert.deepStrictEqual(counts.calls, [
    { settings: settingsOf({ threshold: 7 }), configs: counted(configs), options: counting },
    { settings: settingsOf({ threshold: 9 }), configs: counted(configs), options: counting }
  ]);

  // A user with room for another list. Saving a list with settings that leave it no bigger is
  // allowed, though it is over the limit.
  rows.ExportBanList.push(exportBanList('owner', 5));
  counts.answer = inTurn(25692, 7943, 21000, 21000);
  await refused(
    'updateExportBanList',
    { id: 5, threshold: 5, maxBanAge: 0 },
    'owner',
    `These changes would put 25,692 players on this export ban list, up from 7,943. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${REMOTE_INSTEAD}`
  );
  assert.strictEqual(
    await change('updateExportBanList', { id: 5, threshold: 6 }, 'owner'),
    'allowed'
  );
  assert.deepStrictEqual(
    [rows.ExportBanList[4].threshold, rows.ExportBanList[4].generated],
    [6, false]
  );

  // Adding a config is counted with the list's other configs, duplicates included.
  rows.ExportBanList.push(exportBanList('adder', 6));
  const adderConfigs = [configOf(6, 1, 3, 1), configOf(6, 1, 3, 1)];
  counts.answer = inTurn(25692, 7943);
  await refused(
    'createExportBanListConfig',
    { exportBanList: 6, banList: 2, activePoints: 5, expiredPoints: 2 },
    'adder',
    `This points setting would put 25,692 players on this export ban list, up from 7,943. ${BATTLEMETRICS_LIMIT} Use fewer points, or raise the list's threshold or set a max ban age first. ${REMOTE_INSTEAD}`
  );
  const added = {
    banList: 2,
    activePoints: 5,
    expiredPoints: 2,
    banListName: 'Ban List 2',
    organisationName: 'Partner Org 1'
  };
  assert.deepStrictEqual(counts.calls.slice(-2), [
    { settings: settingsOf(), configs: [...counted(adderConfigs), added], options: counting },
    { settings: settingsOf(), configs: counted(adderConfigs), options: counting }
  ]);

  // Deleting a config leaves its ban list with the list's default points. It is counted with the
  // other configs, duplicates included. This is a remote list.
  rows.ExportBanList.push(
    exportBanList('deleter', 8, {
      type: 'remote',
      defaultActivePoints: 5,
      defaultExpiredPoints: 2,
      battlemetricsID: null
    })
  );
  const low = configOf(8, 1, 1, 0);
  const others = [configOf(8, 2, 1, 0), configOf(8, 2, 1, 0)];
  counts.answer = inTurn(45120, 30000);
  await refused(
    'deleteExportBanListConfig',
    { id: low.id },
    'deleter',
    `Deleting this points setting would put 45,120 players on this export ban list, up from 30,000. ${REMOTE_LIMIT} Keep this points setting, or raise the list's threshold or set a max ban age first.`
  );
  const deleterSettings = settingsOf({ defaultActivePoints: 5, defaultExpiredPoints: 2 });
  assert.deepStrictEqual(counts.calls.slice(-2), [
    { settings: deleterSettings, configs: counted(others), options: counting },
    { settings: deleterSettings, configs: counted([low, ...others]), options: counting }
  ]);
  assert.ok(rows.ExportBanListConfig.includes(low));
  assert.deepStrictEqual(logged, [
    'Export ban list sizes: refused a change that would put 25,692 players on BattleMetrics export ban list 1, up from 7,943, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 25,692 players on BattleMetrics export ban list 5, up from 7,943, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 25,692 players on BattleMetrics export ban list 6, up from 7,943, over the cap of 20,000.',
    'Export ban list sizes: refused a change that would put 45,120 players on remote export ban list 8, up from 30,000, over the cap of 40,000.'
  ]);

  // None of these is counted: a rename, a new webhook, changes that can only make the list
  // smaller, adding a config with no more points than the defaults, and deleting one of two
  // configs for a ban list that give no expired points.
  const callsBefore = counts.calls.length;
  counts.answer = () => assert.fail('A list was counted.');
  for (const args of [
    { id: 5, name: 'Renamed' },
    { id: 5, discordWebhook: webhook(5) },
    { id: 5, threshold: 8 },
    { id: 5, maxBanAge: 30 }
  ])
    assert.strictEqual(await change('updateExportBanList', args, 'owner'), 'allowed');
  assert.strictEqual(
    await change(
      'createExportBanListConfig',
      { exportBanList: 6, banList: 3, activePoints: 3, expiredPoints: 1 },
      'adder'
    ),
    'allowed'
  );
  assert.strictEqual(
    await change('deleteExportBanListConfig', { id: others[1].id }, 'deleter'),
    'allowed'
  );
  assert.strictEqual(counts.calls.length, callsBefore);
  assert.strictEqual(logged.length, 4);
  // Each count's timer was cleared once the count was answered.
  assert.deepStrictEqual(timers.waits(), []);
}

// A count that MySQL stops at its time limit, or that fails, refuses the change with a plain
// message, and nothing is saved. Refused creations, whatever refused them, do not count towards
// the limits on creating lists. Here BattleMetrics lists have their rules turned off, and remote
// lists have no limit on their players.
{
  const { db, counts, tested, logged, Mutation, change, refused } = await mutations({
    EXPORT_BM_NEVER_ENOUGH: 'none',
    EXPORT_REMOTE_MAX_PLAYERS: '0'
  });
  counts.answer = () => {
    if (counts.calls.length === 1) throw timedOut();
    return 25692;
  };
  await refused(
    'createExportBanList',
    newList('battlemetrics', ANY_BAN),
    'mistaken',
    COULD_NOT_COUNT
  );
  assert.deepStrictEqual(logged, [
    `Export ban list sizes: could not count the players for a new BattleMetrics export ban list, so the change was refused: ${TIMED_OUT}`
  ]);
  for (let i = 1; i < COUNTS_PER_USER; i++)
    await refused(
      'createExportBanList',
      newList('battlemetrics', ANY_BAN),
      'mistaken',
      `These settings would put 25,692 players on your export ban list. ${BATTLEMETRICS_LIMIT} ${SETTINGS_INSTEAD} ${ANY_REMOTE_INSTEAD}`
    );
  // The user has run all their counts for now, and is refused more often than the hourly limit
  // on creating lists allows changes.
  const { CREATES_AND_DELETES_PER_MINUTE: PER_MINUTE, CREATES_AND_DELETES_PER_HOUR: PER_HOUR } =
    await load('../src/graphql-api/mutation/guard-changes.js', {}, vm.createContext({}));
  for (let i = 0; i <= PER_HOUR; i++)
    assert.match(
      await change('createExportBanList', newList('battlemetrics', ANY_BAN), 'mistaken'),
      /^Saving this change needs a count of the players it would list, /
    );
  assert.strictEqual(counts.calls.length, COUNTS_PER_USER);
  // None of these counted, so the user can create the minute's worth of lists.
  for (let i = 0; i < PER_MINUTE; i++)
    assert.strictEqual(
      await change('createExportBanList', newList('remote', ANY_BAN), 'mistaken'),
      'allowed'
    );
  await assert.rejects(
    Mutation.createExportBanList(null, newList('remote', ANY_BAN), as('mistaken'), {}),
    { message: /^Export ban lists can only be created or deleted \d+ times a minute\./ }
  );
  assert.strictEqual(db.rows.ExportBanList.length, PER_MINUTE);
  assert.strictEqual(tested.length, PER_MINUTE);
  assert.strictEqual(counts.calls.length, COUNTS_PER_USER);
}

// With the default limits, changes within the rules are not counted while the players with two or
// more bans, counted once, are within the limits. Once they are over a type's limit, which the log
// says, its lists are counted.
{
  const { db, counts, logged, change } = await mutations({});
  counts.answer = inTurn(13289);
  assert.strictEqual(
    await change('createExportBanList', newList('battlemetrics', {}), 'creator'),
    'allowed'
  );
  const created = db.rows.ExportBanList[0].id;
  for (const args of [
    { id: created, threshold: 6 },
    { id: created, maxBanAge: 0 }
  ])
    assert.strictEqual(await change('updateExportBanList', args, 'creator'), 'allowed');
  assert.strictEqual(
    await change(
      'createExportBanListConfig',
      { exportBanList: created, banList: 1, activePoints: 4, expiredPoints: 1 },
      'creator'
    ),
    'allowed'
  );
  assert.strictEqual(
    await change('createExportBanList', newList('remote', { threshold: 5 }), 'creator'),
    'allowed'
  );
  assert.deepStrictEqual(counts.calls, [twoBans]);
  assert.deepStrictEqual(logged, []);
  assert.deepStrictEqual(db.battlemetrics, [`create the ban list for ${created}`]);
  assert.deepStrictEqual(scoringOf(db.rows.ExportBanList[0]), settingsOf({ threshold: 6 }));

  const over = await mutations({});
  over.counts.answer = inTurn(21034, 967);
  assert.strictEqual(
    await over.change('createExportBanList', newList('battlemetrics', {}), 'creator'),
    'allowed'
  );
  assert.deepStrictEqual(over.counts.calls, [
    twoBans,
    { settings: settingsOf(), configs: [], options: counting }
  ]);
  assert.deepStrictEqual(over.logged, [POPULATION('21,034', 'BattleMetrics', '20,000', true)]);
}

// A change that could make a list bigger and breaks the points rules is refused with the rules'
// message before its size is checked, so it uses none of the user's counts and waits for no turn.
// Here 3 points for an active ban and 1 for an expired ban reach the threshold of 4.
{
  const { db, counts, refused } = await mutations({});
  db.rows.ExportBanList.push(exportBanList('owner', 1));
  await refused(
    'updateExportBanList',
    { id: 1, threshold: 4 },
    'owner',
    'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
  );
  assert.deepStrictEqual(counts.calls, []);
}

console.log(
  'Export ban list size checks passed: the players with two or more bans, counts of lists, their limits, the messages and the log.'
);
