import { sequelize } from 'scbl-lib/db';
import { ImporterState } from 'scbl-lib/db/importer-models';
import { QueryTypes } from 'scbl-lib/db/sequelize';
import { Logger, logText } from 'scbl-lib/utils';

import { BATCH_SIZE, retryOperation, timeOf } from './apply-list.js';
import { FIND_MISMATCHED } from './reputation-points.js';
import { checkRunLock, reportProgress, stopIfRequested } from './run-control.js';

// The reputation check, a safety net for players' reputation points. A player's points, and from
// them their rank and risk rating, are recalculated only when the player is queued for it: the
// import queues the players whose bans it changes, the expiry step those whose bans expire, and
// the bot's /banlist remove the players of the lists it removes. Bans removed any other way queue
// nobody, e.g. those of a ban list deleted by hand in phpMyAdmin, whose bans the database deletes
// with it, so their players would keep the points of bans they no longer have. So once every
// IMPORTER_REPUTATION_CHECK_HOURS, the check works out every player's points from their bans, by
// the same rule as the recalculation (see reputation-points.js), and queues the players whose
// stored points differ for a recalculation of their points, rank and export bans, which the steps
// after it make in the same run. A player who is queued already is left out, as they are
// recalculated anyway, e.g. the players of bans the import has just saved.
//
// Only players' points now are compared. Their points a month before, and the change since then,
// change as their bans pass the one-month mark, with or without a change to the bans, and are
// recalculated only when a player is queued, so comparing them would queue every player whose bans
// passed that mark since they were last recalculated, as if bans had been removed. A player whose
// points the check finds wrong is recalculated in full, their points a month before too.
//
// The check runs right after the expiry step, which queues the players whose bans' expiry has
// passed, and compares points by the time the check runs: only a ban whose expiry passes in the
// moment between the two could be taken for a removed one.
//
// A run's check queues at most MAX_QUEUED players, so the recalculation after it stays short, and
// leaves the others for the next runs, which check again until none are left (see MAX_QUEUED).

// The ImporterState row that keeps when the run that last checked started, when it checked, and
// what it found.
export const STATE_ROW = 'reputationCheck';

// The check is due every 24 hours, unless IMPORTER_REPUTATION_CHECK_HOURS says otherwise, from 0,
// which turns it off, to a year.
export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 365 * 24;

const HOUR = 60 * 60 * 1000;

// Runs start a little before or after their time, e.g. when Docker takes longer to start one, so a
// run is due the check once it starts this long before IMPORTER_REPUTATION_CHECK_HOURS after the
// start of the run that last checked, or a tenth of the cadence if that is less, as the stale alert
// allows (see run-record.js). Runs every 6 hours then check every 24 hours, rather than every 30.
const LEEWAY = 5 * 60 * 1000;

// How often runs start, in seconds, when the step is not told: every 6 hours, as run.js takes it
// when IMPORTER_CADENCE_SECONDS is not set.
const DEFAULT_CADENCE_SECONDS = 6 * 60 * 60;

// The players compared: those not queued for a recalculation already.
const COUNT_CHECKED =
  'SELECT COUNT(*) AS checked FROM SteamUsers WHERE lastRefreshedReputationPoints IS NOT NULL';

// Queue players for a recalculation of their reputation points and rank and their export bans, as
// the expiry step queues them, which the later steps make for players whose time of their last one
// is NULL. Their Steam profile is not refreshed for it, as it has nothing to do with their points.
const QUEUE_RECALCULATION =
  'UPDATE SteamUsers SET lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';

// A run's check queues at most this many players, the first by ID. The reputation step after it
// recalculates the players queued in one statement, about 7 milliseconds a player at production
// scale, which locks every SteamUsers row, and the bans it reads, until it ends: meanwhile the
// website's player pages and sign-ins, which write to SteamUsers, and writes to the bans wait for
// it, a wait longer than MySQL's lock wait timeout (innodb_lock_wait_timeout, 50 seconds by
// default) fails, and the bot's /banlist remove can end in a deadlock. So a check that finds more,
// e.g. the first after a deploy, or one after a large ban list was deleted by hand, queues them a
// run at a time, at most about 8 seconds of recalculation each, and saves no row while any are
// left, so the next run checks again and queues the next ones.
export const MAX_QUEUED = 1000;

// The log channel's line names this many of the players queued.
const MAX_EXAMPLES = 5;

// The invalid IMPORTER_REPUTATION_CHECK_HOURS that was last posted about.
let warnedHours;

// A count written with thousands separators, e.g. 4,376.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

function plural(count, noun) {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// Read IMPORTER_REPUTATION_CHECK_HOURS: a whole number of hours from 0, which turns the check off,
// to MAX_HOURS, with spaces or one pair of quotes around it, as docker run --env-file keeps them.
// It is DEFAULT_HOURS when it is not set, and an invalid value is taken as that, with a warning to
// log.
export function readCheckHours(value) {
  const setting = String(value ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim();
  if (setting === '') return { hours: DEFAULT_HOURS };
  if (/^\d+$/.test(setting) && Number(setting) <= MAX_HOURS) return { hours: Number(setting) };
  return {
    hours: DEFAULT_HOURS,
    warning: `Warning: IMPORTER_REPUTATION_CHECK_HOURS must be a whole number from 0 to ${MAX_HOURS}, not "${value}", so the reputation check runs every ${DEFAULT_HOURS} hours.`
  };
}

// When a run is due the check, in milliseconds: hours after the start of the run that last checked
// (last, in milliseconds, or null when no run has), less the leeway for runs that start every
// cadenceSeconds. With no last check, or one whose time is later than this run's start (startedAt),
// which no earlier run can have, it is due at once.
export function dueAt({ last, hours, cadenceSeconds, startedAt }) {
  if (!Number.isFinite(last) || last > startedAt) return startedAt;
  return last + hours * HOUR - Math.min(LEEWAY, (cadenceSeconds * 1000) / 10);
}

// The log channel's line about players the check queued, given as { id, reputationPoints, points },
// with their stored points and those their bans give, in the order they were queued, and about
// those it left for the next runs (left), as it stopped part-way (stopped) or queues at most
// maxQueued a run. A player's ID is shown as written (logText), as players saved before SteamIDs
// were checked can have other IDs, e.g. the address of a Steam profile named by its player.
function describeQueued(players, { left = 0, stopped = false, maxQueued = MAX_QUEUED } = {}) {
  const examples = players.slice(0, MAX_EXAMPLES).map(({ id, reputationPoints, points }) => {
    const had =
      reputationPoints === null || reputationPoints === undefined
        ? 'no points'
        : plural(Number(reputationPoints), 'point');
    return `${logText(id)} (${had}, ${formatCount(Number(points))} by their bans)`;
  });
  const more =
    players.length > MAX_EXAMPLES ? ` and ${formatCount(players.length - MAX_EXAMPLES)} more` : '';
  let rest = '';
  if (left > 0 && stopped)
    rest = ` The check stopped before it queued the other ${formatCount(left)}, which are left for the next runs, as the check is due again until none are left.`;
  else if (left > 0)
    rest = ` It queues at most ${plural(maxQueued, 'player')} a run, so the recalculation after it stays short: the other ${formatCount(left)} are left for the next runs, as the check is due again until none are left.`;
  return `Queued ${plural(players.length, 'player')} for a recalculation, as their reputation points did not match their bans: ${examples.join(', ')}${more}. This means bans were removed, or changed, without queueing their players, e.g. as a ban list was deleted by hand rather than with /banlist remove.${rest}`;
}

// Check every player's reputation points against their bans, if the check is due, and queue those
// whose points do not match for a recalculation, at most maxQueued of them, the first by ID, in
// batches of batchSize players by ID, each one statement, run again while it fails in a way that
// could pass, such as a deadlock with the bot. It counts in counts whether it ran (ran), and if
// not, why: it is off (off) or not due until a time (dueAt, in UTC). Once it has found the players,
// it counts how many it compared (checked), how many did not match (mismatched), how many it has
// queued (queued) and how many of those that did not match it has not (left), also when the run is
// asked to stop, which it does before it writes and between batches. It checks that the run still
// holds its locks before it writes. Once it has queued them all, it saves when the run started, for
// the next run to tell when the check is due: a check that left players for the next runs, as it
// queued as many as it may, stopped part-way or failed, saves no row, so the next run checks
// again. hours is the setting, cadenceSeconds how often runs start and startedAt when this one did.
export async function checkReputationPoints(
  counts = {},
  {
    hours = process.env.IMPORTER_REPUTATION_CHECK_HOURS,
    cadenceSeconds = DEFAULT_CADENCE_SECONDS,
    startedAt = Date.now(),
    batchSize = BATCH_SIZE,
    maxQueued = MAX_QUEUED
  } = {}
) {
  const startTime = Date.now();
  const setting = readCheckHours(hours);
  // An invalid setting is posted the first time, and then only printed in the console, as the
  // importer service runs this step every cycle with the same settings.
  if (setting.warning && hours === warnedHours) Logger.verbose('Reputation', 2, setting.warning);
  else if (setting.warning) {
    warnedHours = hours;
    Logger.important('Reputation', setting.warning);
  }

  if (setting.hours === 0) {
    Object.assign(counts, { ran: false, off: true });
    Logger.verbose(
      'Reputation',
      2,
      'Skipped the reputation check, as IMPORTER_REPUTATION_CHECK_HOURS is 0, which turns it off.'
    );
    return;
  }

  const row = await retryOperation(() => ImporterState.findByPk(STATE_ROW));
  const due = dueAt({
    last: timeOf(row?.value?.startedAt),
    hours: setting.hours,
    cadenceSeconds,
    startedAt
  });
  if (startedAt < due) {
    Object.assign(counts, { ran: false, dueAt: new Date(due).toISOString() });
    Logger.verbose(
      'Reputation',
      2,
      `Skipped the reputation check, as it is not due until ${counts.dueAt}: it runs every ${plural(setting.hours, 'hour')} (IMPORTER_REPUTATION_CHECK_HOURS).`
    );
    return;
  }

  Logger.verbose('Reputation', 2, "Checking players' reputation points against their bans...");
  const [{ checked } = {}] = await retryOperation(() =>
    sequelize.query(COUNT_CHECKED, { type: QueryTypes.SELECT })
  );
  const mismatched = await retryOperation(() =>
    sequelize.query(FIND_MISMATCHED, { type: QueryTypes.SELECT })
  );
  // Only now are there counts, so a check that could not read the players does not say that every
  // player's points matched.
  Object.assign(counts, {
    ran: true,
    checked: Number(checked ?? 0),
    mismatched: mismatched.length,
    queued: 0,
    left: mismatched.length
  });
  // The players this run queues, the first by ID: the next runs queue the others.
  const players = mismatched.slice(0, Math.max(0, maxQueued));

  // Two runs must never write at once, so the check stops here if the run was asked to, or no
  // longer holds its locks.
  stopIfRequested();
  await checkRunLock();

  let stopped = true;
  try {
    for (let i = 0; i < players.length; i += batchSize) {
      reportProgress(i, players.length, 'players');
      // A run that is asked to stop does so between batches.
      stopIfRequested();
      const batch = players.slice(i, i + batchSize).map(({ id }) => id);
      await retryOperation(() => sequelize.query(QUEUE_RECALCULATION, { replacements: [batch] }));
      counts.queued += batch.length;
      counts.left -= batch.length;
    }
    reportProgress(players.length, players.length, 'players');
    stopped = false;
  } finally {
    if (counts.queued > 0)
      Logger.verbose(
        'Reputation',
        1,
        describeQueued(players.slice(0, counts.queued), { left: counts.left, stopped, maxQueued })
      );
  }

  const took = () => `Took ${((Date.now() - startTime) / 1000).toFixed(2)}s`;
  // Players are left for the next runs, so the next run checks again, as no row says this one did.
  if (counts.left > 0) {
    Logger.verbose(
      'Reputation',
      2,
      `Checked the reputation points of ${plural(counts.checked, 'player')} against their bans, and queued ${formatCount(counts.queued)} of the ${formatCount(counts.mismatched)} whose points did not match for a recalculation, as many as it queues a run. The other ${formatCount(counts.left)} are left for the next runs. ${took()}`
    );
    return;
  }

  // The next check is due from when this run started.
  await retryOperation(() =>
    ImporterState.upsert({
      name: STATE_ROW,
      value: {
        startedAt: new Date(startedAt).toISOString(),
        checkedAt: new Date().toISOString(),
        checked: counts.checked,
        queued: counts.queued
      }
    })
  );

  const found =
    counts.queued === 0
      ? 'and all matched'
      : `and queued the ${formatCount(counts.queued)} whose points did not match for a recalculation`;
  Logger.verbose(
    'Reputation',
    2,
    `Checked the reputation points of ${plural(counts.checked, 'player')} against their bans, ${found}. ${took()}`
  );
}
