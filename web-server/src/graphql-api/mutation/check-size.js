import { EXPORT_LIST_LIMITS } from 'scbl-lib/config';
import { countMembers, countPlayersWithBans } from 'scbl-lib/db/export-membership';
import { createPool, Transaction } from 'scbl-lib/db/sequelize';
import { checkRules, formatNumber } from 'scbl-lib/export-list-limits';

import refusal from './refusal.js';

// The limits on the players an export ban list can have, EXPORT_BM_MAX_PLAYERS and
// EXPORT_REMOTE_MAX_PLAYERS. Each player on a BattleMetrics list is a request to BattleMetrics, and
// each player on a remote list is a row the web server reads whenever the list is downloaded. A
// change that could make a list bigger comes here from resolver.js before anything is saved, a
// webhook is tested or BattleMetrics is asked for anything.
//
// Counting the players a list would hold reads every ban, so it is only done when it has to be:
// - A list within its type's points rules (scbl-lib/export-list-limits.js) holds only players with
//   two or more bans, as the rules keep one ban from being enough. Those players are counted at
//   most once every 10 minutes, server-wide, and while there are no more of them than a type's
//   limit, no list of that type within the rules can pass it, so none needs counting.
// - Otherwise, when the type's rules are turned off or those players are over its limit, the
//   players the list would hold are counted. A change that would put the list over the limit and
//   make it bigger is refused. The list is counted as it would be and as it is in one snapshot of
//   the database, so bans saved in between cannot make a change look smaller or bigger than it is.
// Counts run one at a time, server-wide, on a database connection of their own, so they never wait
// for or take up the connections the web server's requests share, and each user can only start a
// few. A count that cannot get the connection soon (CONNECTION_WAIT), or that the database does
// not answer in time (ANSWER_LIMIT), is given up on, so no change waits for it for good. A count
// given up on starts nothing more, though the connection stays in use until the database answers
// it, so the counts after it fail rather than pile up on the database.

// How long a count of the players with two or more bans is used for, in milliseconds. In that time,
// a list within the rules can only pass its limit by the players who get a second ban.
export const POPULATION_KEPT = 10 * 60 * 1000;

// How many counts of the players a list would hold each user can start in a period, given in
// milliseconds. Creating a list and then adding its configs can take a few.
export const COUNTS_PER_USER = 3;
export const COUNTS_PERIOD = 30 * 1000;

// How many counts can wait while one runs, server-wide. A change that needs a count beyond that is
// refused rather than kept waiting.
export const COUNTS_WAITING = 5;

// How long MySQL may take over each count, in milliseconds.
export const TIME_LIMIT = 3000;

// How long the web server waits for the answer to each count, in milliseconds, from when the count
// starts on its connection, before it gives up on the count as one that failed. MySQL stops a
// count at TIME_LIMIT, so a count with no answer well after that is on a connection that has
// stopped answering. Without this, the changes waiting for it, those whose turn comes after it, and
// the same users' later changes would wait for good. The connection stays in use until the
// database answers, and the next count waits for it for at most CONNECTION_WAIT.
export const ANSWER_LIMIT = TIME_LIMIT + 2000;

// How long a count waits for the counts' connection, and for its transaction to start there, in
// milliseconds, before it is given up on as a count that failed. Counts run one at a time, so one
// only waits that long while the database has not answered a count given up on, which still holds
// the connection, or while a new connection is slow to open. A count given up on here never runs.
export const CONNECTION_WAIT = 2000;

const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

const BUSY =
  'Too many export ban list changes are being checked right now. Please try again in a minute.';
const COULD_NOT_COUNT =
  'We could not work out how many players this change would put on your export ban list. Please try again shortly.';

// How the message for each kind of change starts, and what it suggests doing instead.
const CHANGES = {
  create: 'These settings would put',
  update: 'These changes would put',
  'add config': 'This points setting would put',
  'delete config': 'Deleting this points setting would put'
};
const INSTEAD = {
  create: 'Raise the threshold, lower the points or set a max ban age.',
  update: 'Raise the threshold, lower the points or set a max ban age.',
  'add config': "Use fewer points, or raise the list's threshold or set a max ban age first.",
  'delete config':
    "Keep this points setting, or raise the list's threshold or set a max ban age first."
};

// The players with two or more bans at the last count that worked, when the last count started,
// and the count in progress, which changes at the same time share.
let population;
let populationCountedAt = -Infinity;
let populationCount;

// The types whose limit the players with two or more bans were over at the last count.
const overLimit = new Set();

// When each user's counts in the last period started, oldest first, by Steam ID. They are only kept
// in memory, so the limit starts afresh when the web server restarts.
const recentCounts = new Map();

// The last count to run or wait for its turn, which the next one waits for, and how many counts
// have not finished: the one running and those waiting.
let lastCount = Promise.resolve();
let unfinished = 0;

// The counts' own pool of database connections, which holds one. A count that asks for it waits at
// most CONNECTION_WAIT, and then no longer waits, so it cannot take the connection later.
// If the connection stops answering altogether, e.g. after a network fault that leaves it open with
// no answer ever coming, the changes that need their list's players counted are refused until the
// operating system gives up on the connection, which can take many minutes. That is accepted: a
// new connection in its place could put a second count on the database while the first still
// runs. The rest of the web server keeps its own connections meanwhile, and other changes are
// still saved.
const countPool = createPool({ max: 1, min: 0, acquire: CONNECTION_WAIT });

// Close the counts' connection, as the web server stops. It waits for the database to answer a
// count still running on it, which may never come (see above), so the stop gives it a time limit
// of its own, apart from the other database connections'.
export function closeCountPool() {
  return countPool.close();
}

// Check a change that could make an export ban list bigger against its type's limit on players, and
// refuse it if it would put the list over the limit. check describes the change:
// - type: the list's type;
// - exportBanList: the list's ID, or undefined for a new list;
// - kind: 'create', 'update', 'add config' or 'delete config', for the message;
// - before and after: the list before and after the change, as checkChange takes them, with before
//   null for a new list. The counts take their settings and configs as they are, so they are the
//   stored ones with the change applied, duplicates included;
// - change: what checkChange gave for it;
// - hasRoomForList: a function that says whether the user could create another list, as a
//   refusal can suggest a remote list instead.
// `now` gives the time in milliseconds.
export default async function checkSize(context, check, now = Date.now) {
  const { type, exportBanList, before, change } = check;
  const { maxPlayers, neverEnough } = EXPORT_LIST_LIMITS[type];
  // A change that can only make the list smaller, or keep it the same, needs no check, and a limit
  // of 0 means there is none.
  if (!change.mayGrow || !maxPlayers) return;

  if (neverEnough !== 'none' && change.withinRules) {
    const players = await playersWithTwoBans(now);
    // With no count of them yet, as it failed, which was logged, the change is allowed: within the
    // rules, the list is still no bigger than these players.
    if (players === undefined || players <= maxPlayers) return;
  }

  const { players, current } = await countPlayers(context.user.id, check, now);
  if (players <= maxPlayers || (before && players <= current)) return;

  console.log(
    `Export ban list sizes: refused a change that would put ${formatNumber(players)} players on ${describeList(type, exportBanList)}${before ? `, up from ${formatNumber(current)}` : ''}, over the cap of ${formatNumber(maxPlayers)}.`
  );
  throw refusal(await tooManyPlayers(check, players, current));
}

// Count the players a list would hold after a change, and, when that is over the limit and the
// list exists, the players it would hold as it is, so a change that leaves it no bigger is
// allowed. Together they take one of the user's counts and one turn, and they read one snapshot.
async function countPlayers(user, { type, exportBanList, before, after }, now) {
  // A user who has started all the counts they can for now is refused before the change waits for
  // a turn, and so is any change while one count runs and COUNTS_WAITING wait. Neither takes one
  // of the user's counts.
  const wait = waitForCount(user, now());
  if (wait > 0) throw tooManyCounts(wait);
  if (unfinished > COUNTS_WAITING) throw refusal(BUSY);

  try {
    return await oneAtATime(() => {
      startCount(user, now());
      return inOneSnapshot(async (nextCount) => {
        const count = (list) => countMembers(list.settings, list.configs, nextCount());
        const players = await count(after);
        if (!before || players <= EXPORT_LIST_LIMITS[type].maxPlayers) return { players };
        return { players, current: await count(before) };
      });
    });
  } catch (error) {
    if (error?.refusal === true) throw error;
    // This count only runs when the limit is what keeps the list small, so a change that cannot be
    // counted is refused. MySQL's message would mean nothing to the user.
    console.error(
      `Export ban list sizes: could not count the players for ${describeList(type, exportBanList)}, so the change was refused: ${describeError(error)}`
    );
    throw refusal(COULD_NOT_COUNT);
  }
}

// Record a count the user starts now, or throw the error to show them if they cannot start one.
// Nothing here waits, so the user cannot start more counts at once than the limit allows.
function startCount(user, time) {
  const wait = waitForCount(user, time);
  if (wait > 0) throw tooManyCounts(wait);
  recentCounts.set(user, [...(recentCounts.get(user) || []), time]);
}

// How long until a user can start another count. It is 0 when they can start one now.
function waitForCount(user, time) {
  // Forget counts from over a period ago, and the users with none left, so the map stays small.
  for (const [id, times] of recentCounts) {
    const recent = times.filter((started) => time - started < COUNTS_PERIOD);
    if (recent.length > 0) recentCounts.set(id, recent);
    else recentCounts.delete(id);
  }

  const times = recentCounts.get(user) || [];
  return times.length < COUNTS_PER_USER
    ? 0
    : times[times.length - COUNTS_PER_USER] + COUNTS_PERIOD - time;
}

// Run a count once those before it have finished, whether or not they worked, or been given up on,
// so only one runs at a time, server-wide.
function oneAtATime(count) {
  unfinished += 1;
  const result = lastCount.then(count);
  const finished = () => {
    unfinished -= 1;
  };
  lastCount = result.then(finished, finished);
  return result;
}

// Run counts on the counts' connection, in one REPEATABLE READ transaction, so they all read the
// bans as they were when the first one started, whatever the importer or the bot saves meanwhile,
// and take no locks. counts(nextCount) runs them, each with the options nextCount() gives: the time
// limit and the transaction. This resolves with what counts resolves with as soon as it does, as
// the transaction then ends on its own.
// The counts are given up on, as counts that failed, when the connection is not theirs within
// CONNECTION_WAIT, or when the database has not answered a count within ANSWER_LIMIT of its start.
// nextCount() then throws, so they start nothing more, and a late answer is not used.
function inOneSnapshot(counts) {
  return new Promise((resolve, reject) => {
    let timer;
    let givenUp = false;
    // Give up on the counts in ms, unless they finish first or this is called again.
    const giveUpIn = (ms, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        givenUp = true;
        reject(new Error(message));
      }, ms);
    };
    const finish = (settle, value) => {
      clearTimeout(timer);
      settle(value);
    };

    giveUpIn(
      CONNECTION_WAIT,
      `The count could not get a database connection within ${CONNECTION_WAIT / 1000} seconds.`
    );
    countPool
      .transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
        async (transaction) => {
          const nextCount = () => {
            if (givenUp) throw new Error('The counts were given up on.');
            giveUpIn(
              ANSWER_LIMIT,
              `The database did not answer the count within ${ANSWER_LIMIT / 1000} seconds.`
            );
            return { timeLimit: TIME_LIMIT, transaction };
          };
          try {
            finish(resolve, await counts(nextCount));
          } catch (error) {
            finish(reject, error);
            // Sequelize rolls the transaction back.
            throw error;
          }
        }
      )
      // Not getting the connection, or the transaction not starting, fails the counts. Once they
      // are answered, the transaction not ending does not.
      .catch((error) => finish(reject, error));
  });
}

// How many players have two or more bans, counted at most once every POPULATION_KEPT. Changes at
// the same time share a count, which waits for its turn like the others. When a count fails, the
// last one is used, or undefined when there is none, until the next count.
function playersWithTwoBans(now) {
  if (populationCount) return populationCount;
  const time = now();
  if (time - populationCountedAt < POPULATION_KEPT) return population;

  populationCountedAt = time;
  populationCount = oneAtATime(() =>
    inOneSnapshot((nextCount) => countPlayersWithBans(2, nextCount()))
  )
    .then(
      (players) => {
        population = players;
        logLimitsPassed(players);
        return players;
      },
      (error) => {
        const instead =
          population === undefined
            ? 'changes within the points rules are allowed without counting their players'
            : `the last count, ${formatNumber(population)}, is used`;
        console.error(
          `Export ban list sizes: could not count the players who have two or more bans, so ${instead} until they are counted again in ${POPULATION_KEPT / 60000} minutes: ${describeError(error)}`
        );
        return population;
      }
    )
    .finally(() => {
      populationCount = undefined;
    });
  return populationCount;
}

// Log when the players with two or more bans go over a type's limit, from when changes to that
// type's lists are counted one by one, and when they are back within it. These players decide
// nothing for a type with no limit, whose lists are never counted, or with its rules turned off,
// whose lists always are, so those types are left out.
function logLimitsPassed(players) {
  for (const [type, { maxPlayers, neverEnough }] of Object.entries(EXPORT_LIST_LIMITS)) {
    if (!maxPlayers || neverEnough === 'none') continue;
    const over = players > maxPlayers;
    if (over === overLimit.has(type)) continue;

    if (over) overLimit.add(type);
    else overLimit.delete(type);
    const name = TYPE_NAMES[type];
    const limit = `the ${name} cap of ${formatNumber(maxPlayers)}`;
    console.log(
      over
        ? `Export ban list sizes: ${formatNumber(players)} players have two or more bans, over ${limit}, so ${name} list changes are now counted one by one.`
        : `Export ban list sizes: ${formatNumber(players)} players have two or more bans, within ${limit} again, so ${name} list changes are no longer counted one by one.`
    );
  }
}

// The message for a change that would put too many players on a list, with the numbers.
async function tooManyPlayers({ type, kind, before, after, hasRoomForList }, players, current) {
  const { maxPlayers } = EXPORT_LIST_LIMITS[type];
  const message = [
    before
      ? `${CHANGES[kind]} ${formatNumber(players)} players on this export ban list, up from ${formatNumber(current)}.`
      : `${CHANGES[kind]} ${formatNumber(players)} players on your export ban list.`,
    type === 'battlemetrics'
      ? `A BattleMetrics export ban list can have at most ${formatNumber(maxPlayers)}, as each player is added to BattleMetrics separately.`
      : `A remote export ban list can have at most ${formatNumber(maxPlayers)}.`,
    INSTEAD[kind]
  ];

  // A BattleMetrics list can be a remote list instead, as the type can't be changed, when one
  // with these settings would be allowed and the user has room for it.
  if (type === 'battlemetrics' && (await remoteListFits(after, players, hasRoomForList))) {
    const { maxPlayers: remoteMax } = EXPORT_LIST_LIMITS.remote;
    const most = remoteMax
      ? `can have up to ${formatNumber(remoteMax)}`
      : 'has no limit on its players';
    message.push(
      `Or create a remote export ban list instead, which ${most}: your Squad servers download it from its address, shown under Install.`
    );
  }
  return message.join(' ');
}

// Whether a remote list with a list's settings and configs would be within the limit on remote
// lists and their points rules, and the user has room for another list.
async function remoteListFits(list, players, hasRoomForList) {
  const { maxPlayers } = EXPORT_LIST_LIMITS.remote;
  if (maxPlayers && players > maxPlayers) return false;
  if (checkRules('remote', list, EXPORT_LIST_LIMITS).length > 0) return false;
  try {
    return await hasRoomForList();
  } catch {
    return false;
  }
}

// The error for a user who has started all the counts they can for now.
function tooManyCounts(wait) {
  return refusal(
    `Saving this change needs a count of the players it would list, and each user can run ${COUNTS_PER_USER} counts every ${COUNTS_PERIOD / 1000} seconds. Please try again in ${describeWait(wait)}.`
  );
}

// A wait in words, rounded up to whole seconds.
function describeWait(milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

// The list a change is to, for the log: its type, and its ID or that it is new. Nothing about the
// user is logged.
function describeList(type, exportBanList) {
  return exportBanList === undefined
    ? `a new ${TYPE_NAMES[type]} export ban list`
    : `${TYPE_NAMES[type]} export ban list ${exportBanList}`;
}

// An error for the log: its name and message, as Sequelize's errors carry MySQL's.
function describeError(error) {
  return typeof error?.message === 'string' ? `${error.name}: ${error.message}` : String(error);
}
