import { battlemetricsRequestCount } from 'scbl-lib/apis';
import {
  connect,
  disconnect,
  readLogMessage,
  sequelize,
  stopRecordingLogMessages,
  takeServiceLock
} from 'scbl-lib/db';
import { describeError, isNewerMessage, Logger, newerMessage } from 'scbl-lib/utils';

import startHealthCheckServer, { checkHealth } from './health-check-server.js';
import { isMissingTable, readService, saveService, succeeded } from './run-record.js';
import {
  clearStop,
  isStopping,
  LOCK_LOST,
  pause,
  requestStop,
  RunStopped,
  setProgressListener,
  setRunLock,
  stopIfRequested
} from './run-control.js';
import renderRunStatus from './run-status.js';
import {
  checkStaleness,
  DISCONNECT_TIMEOUT,
  END_TIMEOUT,
  EXIT_CODES,
  flushLogs,
  HARD_EXIT_DELAY,
  LEFT_WAITING,
  logMigrations,
  readSeconds,
  RECORD_TIMEOUT,
  recordNewestMessage,
  RELEASE_RESERVE,
  reviseLastRun,
  RunState,
  saveRunRecord,
  setLeftWaiting,
  waitForDatabase,
  withTimeout
} from './run.js';
import renderServiceStatus, {
  addCycle,
  cycleNumbers,
  DEFAULT_DISCORD_MODE,
  DISCORD_MODES,
  isNoteworthy,
  newTotals,
  nextSummaryAt,
  renderHourlySummary
} from './service-status.js';
import migrate from './schema/migrate.js';

// The importer service: in loop mode (IMPORTER_MODE=loop), the importer runs as a long-running
// service, in the Portainer stack, rather than once per start. It takes the service lock once and
// keeps it, so no other importer runs while it does, and runs a cycle every
// IMPORTER_CYCLE_SECONDS, from the start of one to the start of the next, or at once after one
// that took longer. Each cycle holds the run lock while it goes, and frees it when it ends, so the
// bot's commands that must not overlap a run work between cycles (see scbl-lib/db/run-lock.js).
// Each cycle runs the steps as a run in once mode does (see run.js): the same steps and stop
// points, its own run record, saved as a run's is, and its own JSON line, with the cycle's number.
// The service stops only when it is asked to, by SIGTERM or SIGINT, or when it can no longer go on
// safely: when it loses its locks, or when a cycle does not stop within 60 seconds of its time
// limit. It then exits 1, for Docker to start it again, as Docker never restarts a container that
// is only unhealthy. Once a signal asks it to stop, a cycle that has not reached a safe point within
// 45 seconds is ended there, so the service still exits before docker stop kills it. Before it
// frees the locks, it stops the statements it still has running on the database, so none of them
// can change it once another importer holds the locks.

// How the importer runs (IMPORTER_MODE): once, the default, runs the steps once and exits, as the
// script that starts the importer has it, and loop runs them as the importer service.
export const MODES = ['once', 'loop'];

// A cycle starts every 10 minutes, unless IMPORTER_CYCLE_SECONDS says otherwise, and one that takes
// longer than 15 minutes (IMPORTER_MAX_CYCLE_SECONDS) stops at its next safe point.
const DEFAULT_CYCLE_SECONDS = 10 * 60;
const DEFAULT_MAX_CYCLE_SECONDS = 15 * 60;

// While another run holds the service lock or the run lock, e.g. one started by hand, or the
// database cannot be reached to take the service lock, the service tries again this often, and says
// so in the console at most this often.
const LOCK_RETRY_DELAY = 15 * 1000;
const STANDBY_LOG_INTERVAL = 5 * 60 * 1000;

// A cycle waits for the database for as long as it takes, trying again after 5, 10, 20 and 40
// seconds, and then every minute.
const DATABASE_MAX_DELAY = 60 * 1000;

// The service's status message is edited at most once a minute, and its final edit is sent at
// once. The web server and the bot post to the same webhook, and Discord limits each webhook.
const STATUS_EDIT_INTERVAL = 60 * 1000;

// With IMPORTER_STATUS_AT_BOTTOM, the status message is kept below the other messages CBL's
// services post to the log channel (see keepAtBottom). Once a minute the service checks whether a
// newer one is there: one it posted itself, which it knows of at once, or one the web server, the
// bot or an earlier process of its own posted, which each writes to the database (see
// scbl-lib/db/log-channel.js). If so, it posts its status message again, below it, and deletes the
// old one, at most once a minute, except that its own embed of a cycle and its hourly summary are
// followed within seconds, once they are in the channel, after a pause that lets the lines posted
// with them go first.
const BOTTOM_CHECK_INTERVAL = 60 * 1000;
const REPORT_MOVE_DELAY = 3 * 1000;

// What an old copy of the status message that could not be deleted is changed to, so it no longer
// looks like the current one. Its delete is tried again with the next check or move.
const MOVED_PAYLOAD = {
  content: "The CBL importer service's status has moved to the bottom of the channel.",
  embeds: []
};

// An old copy that still looks like the current one, as Discord failed both its delete and that
// change, is tried again this long after each try, rather than only at the next check, and then
// with each check (see retryOldCopies).
const COPY_RETRY_DELAYS = [5 * 1000, 15 * 1000, 30 * 1000];

// docker stop gives the service 60 seconds (stop_grace_period) before it kills it. Once a signal
// asks the service to stop, its end, from saving the last cycle's record to releasing the locks,
// waits for nothing beyond 55 seconds after the signal, nor beyond END_TIMEOUT after the end began,
// as a run's end does, so a cycle that reaches its safe point late leaves its end less time. An end
// for any other reason, e.g. lost locks, takes up to END_TIMEOUT, as nothing kills the service then.
const STOP_GRACE = 55 * 1000;

// Once a signal asks the service to stop, a cycle that has not reached a safe point this long after
// it is ended there, and the service ends at once (see onStopDeadline), in the 5 seconds left before
// STOP_GRACE less RELEASE_RESERVE. The next safe point can be minutes away: a BattleMetrics request
// waits for the budget, for a minute once BattleMetrics says few of the key's requests are left,
// for as long as it asks after a 429, up to 5 minutes, and for up to 3 attempts, each cut off after
// 30 seconds, or for the import's reads of pages of bans, up to 5, cut off after 15, 15, 20, 30 and
// 45 seconds, though once the cycle is asked to stop, the import's reads of pages make no more
// attempts, and stop waiting within a second, so only an attempt already sent, of at most 45
// seconds, holds them up. The cycle's step is not stopped, and goes on until the service exits: the
// cycle's record keeps what the step had done when the cycle was ended, and what it does after is
// in no record. A statement it still has running on the database, e.g. one that waits for a row
// lock, is stopped before the locks are freed, as MySQL would otherwise carry it out, also once
// another importer holds them (see stopStatements). A BattleMetrics request still waiting for its
// answer is cut off, as by docker stop's kill: an export ban claimed for it stays claimed, and the
// next run looks for its ban before it makes it again.
const STOP_DEADLINE = 45 * 1000;

// An end gives the locks' connection at most this long to stop the statements the service still
// has running on its other database connections (see stopStatements). At the stop's deadline it
// comes out of RELEASE_RESERVE, which an end that closes the locks' connection at once does not
// need, so the service still exits within STOP_GRACE.
const STOP_STATEMENTS_TIMEOUT = 2 * 1000;

// A cycle that has not stopped 60 seconds after its time limit ends the service at once, after
// waiting at most this long for its log messages to be sent, so the log channel says why.
const HARD_EXIT_FLUSH = 5 * 1000;

// The end waits for the status message's final edit to be sent until this long before it releases
// the locks, which leaves the time to save the service's row again, with the ID of a message that
// the edit found deleted and posted again.
const SENT_RESERVE = 5 * 1000;

// Before the end writes the newest message the service posted to the database, it waits at most
// this long for the lines still waiting to be sent, e.g. the one that says it is stopping, which
// its final edit went ahead of (see recordNewest).
const LINES_TIMEOUT = 2 * 1000;

// The text of a setting, without spaces or one pair of quotes around it, in lower case, as the
// importer reads its switches (see unquote in ban-list-sync.js).
function settingText(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim()
    .toLowerCase();
}

// How IMPORTER_MODE says the importer runs: { loop } or, for a value that is neither once nor
// loop, { error }, as either could be the wrong one.
export function readMode(value) {
  const mode = settingText(value) || 'once';
  if (MODES.includes(mode)) return { loop: mode === 'loop' };
  return {
    error: `IMPORTER_MODE must be once or loop, not "${value}", so the importer did not start.`
  };
}

// What the service posts to the log channel besides its alerts (IMPORTER_LOOP_DISCORD): changes,
// status or both (see service-status.js). An invalid value is taken as both, with a warning.
export function readDiscordMode(value) {
  const mode = settingText(value) || DEFAULT_DISCORD_MODE;
  if (DISCORD_MODES.includes(mode)) return { mode };
  return {
    mode: DEFAULT_DISCORD_MODE,
    warning: `Warning: IMPORTER_LOOP_DISCORD must be changes, status or both, not "${value}", so the importer service posts both.`
  };
}

// Whether IMPORTER_STATUS_AT_BOTTOM keeps the status message at the bottom of the log channel, as
// { on }: on with 1, true, on or yes, or when it is not set, and off with 0, false, off or no, which
// edits the message where it is. An invalid value is taken as on, the default, with a warning.
export function readStatusAtBottom(value) {
  const setting = settingText(value);
  if (setting === '' || ['1', 'true', 'on', 'yes'].includes(setting)) return { on: true };
  if (['0', 'false', 'off', 'no'].includes(setting)) return { on: false };
  return {
    on: true,
    warning: `Warning: IMPORTER_STATUS_AT_BOTTOM must be 1 or 0, not "${value}", so the importer service keeps its status message at the bottom of the log channel.`
  };
}

// The process's memory, in megabytes, as each cycle's record and the health check give it.
export function memoryOf({ rss, heapTotal, heapUsed, external }) {
  const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    rssMB: mb(rss),
    heapUsedMB: mb(heapUsed),
    heapTotalMB: mb(heapTotal),
    externalMB: mb(external)
  };
}

// The process's memory now, or null if it cannot be read, which never fails a cycle.
function memoryNow() {
  try {
    return memoryOf(process.memoryUsage());
  } catch {
    return null;
  }
}

// Run the importer's steps as the importer service, until it is asked to stop or can no longer go
// on, and resolve with its exit code: 0 once it stopped as it was asked to, 1 once it lost its
// locks, a cycle did not stop within 60 seconds of its time limit, or it failed, and 3 when a
// second signal ended it at once during a cycle. A second signal between cycles, or while the
// service ends, exits with the code it was stopping with, and so does a service whose cycle did not
// reach a safe point within 45 seconds of the first signal. Each step is { name, run, counts } (see
// RunState in run.js).
//
// While it goes, it keeps a health server, for the Docker health check (see
// health-check-server.js). It posts the alerts that runs post, in every mode, and, as
// IMPORTER_LOOP_DISCORD says, the embed of each cycle that changed something or had a problem,
// and its status message and hourly summary (see service-status.js). With
// IMPORTER_STATUS_AT_BOTTOM, on unless it is 0, it keeps its status message below the other
// messages CBL's services post to the log channel (see keepAtBottom). Nothing it posts waits for
// Discord.
export default async function runLoop(steps) {
  const cycleSeconds = readSeconds('IMPORTER_CYCLE_SECONDS', DEFAULT_CYCLE_SECONDS);
  const maxCycleSeconds = readSeconds('IMPORTER_MAX_CYCLE_SECONDS', DEFAULT_MAX_CYCLE_SECONDS);
  // Staleness and the Steam step's budget go by how often cycles start, unless
  // IMPORTER_CADENCE_SECONDS says otherwise. The import's full reads always go by how often cycles
  // start (see importBans in ban-importer.js).
  const cadenceSeconds = readSeconds('IMPORTER_CADENCE_SECONDS', cycleSeconds);
  const discord = readDiscordMode(process.env.IMPORTER_LOOP_DISCORD);
  const postsCycles = discord.mode !== 'status';
  const postsStatus = discord.mode !== 'changes';
  const atBottom = readStatusAtBottom(process.env.IMPORTER_STATUS_AT_BOTTOM);
  const gitSha = process.env.GIT_SHA || 'unknown';

  // What the service is doing, for the health check: when it took the service lock, the cycle
  // under way and the last one that ended, and what it is waiting for, if anything: the database,
  // or the service lock or the run lock (lock). A cycle that ended within two cycles and the time
  // limit keeps it healthy. The status message shows what the cycle under way waits for too.
  const health = {
    stopping: false,
    lockedAt: null,
    cycles: 0,
    cycle: null,
    lastCycle: null,
    waitingFor: 'lock',
    waitingSince: Date.now(),
    window: (2 * cycleSeconds + maxCycleSeconds) * 1000
  };
  const server = startHealthCheckServer(() => ({
    ...checkHealth(health, Date.now()),
    // What the service posts besides its alerts, or off when it posts nothing at all, as without
    // DISCORD_LOG_WEBHOOK, which docker inspect then shows.
    discord: Logger.discordWebhook ? discord.mode : 'off',
    memory: memoryNow()
  }));

  let lock = null;
  // Why the service is stopping, once it is, with the exit code that gives.
  let stopping = null;
  let exitCode = EXIT_CODES.FINISHED;
  // How many signals asked the service to stop, the first one's name and when it came, and the
  // timer that ends a cycle that has not reached a safe point in time after it (see STOP_DEADLINE).
  let signals = 0;
  let signalName = null;
  let signalAt = null;
  let stopTimer = null;
  // The cycle under way, as a RunState, and the log channel's lines and the BattleMetrics requests
  // when it started, which say what it posted and sent (see noteEnded).
  let current = null;
  let currentBefore = null;
  // Whether a cycle has connected and applied the importer's migrations, which the first does.
  let prepared = false;
  // When the service took the service lock, the totals since its last hourly summary, the last
  // cycle that ended, and when the next starts, between cycles.
  let startedAt = null;
  let totals = newTotals(Date.now());
  let last = null;
  let nextAt = null;
  // Whether the service has read and saved its row, and posted its status message if it posts one
  // (see startStatus), the message, its ID, and the timer for the next hourly summary.
  let statusStarted = false;
  let statusMessage = null;
  let statusID = null;
  let summaryTimer = null;
  // The saves of the service's row, one at a time, in turn (see saveRow).
  let rowSaves = Promise.resolve();
  // The old copies of the status message, posted before it was posted again below newer messages,
  // that are still to be deleted, by ID, each with whether it may be deleted yet, as the ID of the
  // message that replaced it has been saved, whether it was changed to say the status moved, as it
  // could not be deleted, whether Discord refused to delete it or to change it, and whether it
  // still looks like the current one, as its last try neither deleted it nor changed it (see
  // deleteOldCopies). Then the pass that is deleting them, if one is under way, and the timer of
  // the next try of a copy that still looks current, with how many such tries there have been (see
  // retryOldCopies). Then, with IMPORTER_STATUS_AT_BOTTOM, when the message was last posted again,
  // the timers of the next check and of the move after the service's own embed or summary, and
  // whether a check is reading the database (see keepAtBottom).
  const oldCopies = new Map();
  let copiesPass = null;
  let copiesTimer = null;
  let copiesRetries = 0;
  let movedAt = -Infinity;
  let bottomTimer = null;
  let reportTimer = null;
  let readingNewest = false;
  // The end of the service, once it is ending, and by when the locks are released.
  let finishing = null;
  let releaseBy = null;
  // The Sequelize pool's connections, from when each is opened until it is closed, whose
  // statements the service stops before it frees the locks (see stopStatements), and whether it
  // has, after which the pool opens no more connections.
  const connections = new Set();
  let statementsStopped = false;
  const onConnect = (connection) => {
    if (statementsStopped) {
      try {
        connection.destroy();
      } catch {
        // It was never used, and the service is ending.
      }
      throw new Error('The importer service is ending, so it opens no more database connections.');
    }
    connections.add(connection);
  };
  const onDisconnect = (connection) => {
    connections.delete(connection);
  };
  sequelize.addHook('afterConnect', onConnect);
  sequelize.addHook('afterDisconnect', onDisconnect);

  // Report on the service: in the Discord log once it holds the service lock, and before that only
  // in the console.
  const report = (message) => {
    if (lock) Logger.important('Core', message);
    else console.log(message);
  };

  // Ask the service to stop: the cycle under way stops at its next safe point, and the wait
  // between cycles ends. The first reason given is kept.
  const stopService = (reason, code) => {
    if (stopping !== null) return;
    stopping = reason;
    exitCode = code;
    requestStop(reason);
  };

  // How long the service's end may still wait for something, at most limit. Once it is stopping,
  // it ends by END_TIMEOUT after it began to end, or, once a signal asked it to stop, by
  // STOP_GRACE after the signal, if that is sooner, keeping the last RELEASE_RESERVE for releasing
  // the locks.
  const left = (limit) => {
    if (stopping === null) return limit;
    releaseBy ??=
      Math.min(Date.now() + END_TIMEOUT, signalAt === null ? Infinity : signalAt + STOP_GRACE) -
      RELEASE_RESERVE;
    return Math.max(0, Math.min(limit, releaseBy - Date.now()));
  };

  // The service's status, as service-status.js draws it.
  const drawStatus = () => {
    const record = current?.record;
    return {
      embeds: [
        renderServiceStatus({
          outcome: health.stopping
            ? exitCode === EXIT_CODES.FINISHED
              ? 'stopped'
              : 'failed'
            : 'running',
          startedAt,
          at: Date.now(),
          gitSha,
          cycleSeconds,
          maxCycleSeconds,
          current: record && {
            cycle: record.cycle,
            startedAt: record.startedAt,
            phase: record.phase,
            progress: current.progress[record.phase],
            waitingFor: health.waitingFor,
            waitingSince: health.waitingFor ? health.waitingSince : null
          },
          last,
          nextAt,
          totals,
          reason: stopping,
          // Docker starts again a service that exits by itself, but not one that docker stop or a
          // stack update stopped, with a signal.
          restarts: signals === 0
        })
      ]
    };
  };
  // Say that the service's status changed, which its next edit shows, at most once a minute.
  const updateStatus = () => statusMessage?.update(drawStatus);

  // The ID of the newest message in the log channel that CBL's services wrote to the database
  // (see scbl-lib/db/log-channel.js), null when none has, or undefined when it could not be read,
  // waiting at most RECORD_TIMEOUT. It never fails.
  const readNewest = async () => {
    try {
      return await withTimeout(
        readLogMessage(),
        RECORD_TIMEOUT,
        'Reading the newest message in the log channel'
      );
    } catch (err) {
      console.warn(
        `Warning: could not read the newest message in the log channel: ${describeError(err)}`
      );
      return undefined;
    }
  };

  // Whether the status message may be moved to the bottom of the log channel now: it is kept there,
  // it has been posted, and the service is not ending, as its end only edits it.
  const movable = () =>
    atBottom.on &&
    statusMessage !== null &&
    !statusMessage.stopped &&
    statusID !== null &&
    stopping === null &&
    !health.stopping;

  // Try each old copy of the status message that may be deleted once, one at a time, also those
  // that may be meanwhile, as the pass under way (see deleteOldCopies). A copy that cannot be
  // deleted is changed to say that the status moved, so it no longer looks like the current one,
  // and its delete is tried again with the next try, until it works. A copy that Discord refuses to
  // delete, as it would again, is only changed, and is left once it is, or once Discord refuses that
  // too. Until then it stays among the copies still to be deleted, which the service's row keeps
  // for the next process. It never fails.
  const tryOldCopies = async () => {
    const tried = new Set();
    try {
      for (;;) {
        const next = [...oldCopies].find(([id, copy]) => copy.ready && !tried.has(id));
        if (!next || !Logger.discordWebhook) break;
        const [id, copy] = next;
        tried.add(id);
        let outcome = copy.refused ? 'refused' : await Logger.deleteMessage(id);
        copy.refused = outcome === 'refused';
        if (outcome !== 'deleted' && outcome !== 'gone' && !copy.marked && !copy.unchangeable) {
          const changed = await Logger.editMessage(id, MOVED_PAYLOAD);
          if (changed === 'gone') outcome = 'gone';
          copy.marked = changed === 'edited';
          copy.unchangeable = changed === 'refused';
        }
        const gone = outcome === 'deleted' || outcome === 'gone';
        copy.looksCurrent = !gone && !copy.marked;
        if (gone)
          console.log(
            outcome === 'deleted'
              ? `Deleted the old copy of the status message, ${id}.`
              : `The old copy of the status message, ${id}, was deleted already.`
          );
        else if (copy.refused && copy.marked)
          console.log(
            `Discord refused to delete the old copy of the status message, ${id}, so it is left, saying that the status moved.`
          );
        else if (copy.refused && copy.unchangeable)
          console.warn(
            `Warning: Discord refused to delete the old copy of the status message, ${id}, and to change it, so it is left as it is.`
          );
        if (gone || (copy.refused && (copy.marked || copy.unchangeable))) oldCopies.delete(id);
      }
    } catch (err) {
      console.warn(
        `Warning: could not delete the old copies of the status message: ${describeError(err)}`
      );
    }
    // The pass ends as it finds no copy left to try, so one that may be deleted from now on gets a
    // pass of its own.
    copiesPass = null;
    retryOldCopies();
  };

  // Delete the old copies of the status message that may be deleted, in the background (see
  // tryOldCopies), unless that is under way already, and resolve once they have been tried. The
  // pass starts once it is kept as the one under way. It never fails.
  const deleteOldCopies = () => {
    if (copiesPass === null && oldCopies.size > 0 && Logger.discordWebhook)
      copiesPass = Promise.resolve().then(tryOldCopies);
    return copiesPass ?? Promise.resolve();
  };

  // Whether an old copy still looks like the current status message, as its last try neither
  // deleted it nor changed it to say the status moved, e.g. as Discord failed both.
  const copyLooksCurrent = () => [...oldCopies.values()].some((copy) => copy.looksCurrent);

  // While an old copy still looks current, it is tried again 5, 15 and then 30 seconds after each
  // try, rather than only at the next check, a minute later, and then with each check, until it
  // works. Once none does, the next such copy starts at 5 seconds again. Not once the service is
  // ending, as its end saves the copies left, for the next process.
  const retryOldCopies = () => {
    if (!copyLooksCurrent()) {
      copiesRetries = 0;
      return;
    }
    if (
      copiesTimer !== null ||
      copiesRetries >= COPY_RETRY_DELAYS.length ||
      stopping !== null ||
      health.stopping
    )
      return;
    copiesTimer = setTimeout(() => {
      copiesTimer = null;
      deleteOldCopies();
    }, COPY_RETRY_DELAYS[copiesRetries++]);
    // It must not keep the process running.
    copiesTimer.unref?.();
  };

  // Move the status message to the bottom of the log channel if a newer message is there: post it
  // again, below that one, and delete the old one once the new one's ID is saved (see startStatus).
  // The newest is the newest the service posted itself, which it knows at once, or, unless this is
  // the move after its own embed or summary (report), the newest in the database, which also has
  // the web server's and the bot's. It moves at most once a minute, but for that move. It first
  // tries again the old copies that are left, and does not move while one still looks current, as
  // that would leave one more. It never fails.
  const keepAtBottom = async ({ report = false } = {}) => {
    if (!movable()) return;
    const deleting = deleteOldCopies();
    let newest = Logger.newestMessageID ?? null;
    if (!report && !readingNewest) {
      readingNewest = true;
      try {
        newest = newerMessage(newest, await readNewest());
      } finally {
        readingNewest = false;
      }
    }
    await deleting;
    if (!movable() || !isNewerMessage(newerMessage(newest, Logger.newestMessageID), statusID))
      return;
    if (!report && Date.now() - movedAt < BOTTOM_CHECK_INTERVAL) return;
    if (copyLooksCurrent()) return;
    if (statusMessage.repost(drawStatus)) {
      movedAt = Date.now();
      scheduleBottomCheck();
    }
  };

  // Check once a minute, from the last check or move on, whether the status message is still at the
  // bottom of the log channel, until the service ends or the message stops.
  const scheduleBottomCheck = () => {
    clearTimeout(bottomTimer);
    bottomTimer = setTimeout(() => {
      bottomTimer = null;
      keepAtBottom()
        .catch((err) =>
          console.warn(
            `Warning: could not keep the status message at the bottom: ${describeError(err)}`
          )
        )
        .finally(() => {
          if (
            bottomTimer === null &&
            stopping === null &&
            !health.stopping &&
            !statusMessage?.stopped
          )
            scheduleBottomCheck();
        });
    }, BOTTOM_CHECK_INTERVAL);
    // It must not keep the process running.
    bottomTimer.unref?.();
  };

  // Once the service's own embed of a cycle, or its hourly summary, is in the log channel, as
  // posting, which Logger.post returned, says with its ID, move the status message below it within
  // seconds, rather than at the next check.
  const moveBelow = (posting) => {
    if (!atBottom.on) return;
    Promise.resolve(posting)
      .then((id) => {
        if (!id || reportTimer !== null || !movable()) return;
        reportTimer = setTimeout(() => {
          reportTimer = null;
          keepAtBottom({ report: true }).catch((err) =>
            console.warn(
              `Warning: could not keep the status message at the bottom: ${describeError(err)}`
            )
          );
        }, REPORT_MOVE_DELAY);
        reportTimer.unref?.();
      })
      .catch(() => {});
  };

  // Post the hourly summary when it is due, and start the next hour's totals.
  const scheduleSummary = () => {
    if (!postsStatus) return;
    summaryTimer = setTimeout(
      () => {
        const until = Date.now();
        try {
          moveBelow(Logger.post({ embeds: [renderHourlySummary(totals, until)] }));
        } catch (err) {
          console.warn(`Warning: could not post the hourly summary: ${describeError(err)}`);
        }
        totals = newTotals(until);
        updateStatus();
        scheduleSummary();
      },
      Math.max(0, nextSummaryAt(totals.since) - Date.now())
    );
    // It must not keep the process running.
    summaryTimer.unref?.();
  };

  // Save the service's row, as write() does, once the saves asked for before it are done, or have
  // failed, so a save never lands after a later one, e.g. one with the ID of a status message that
  // has moved on, after the one with the ID it moved to, or after the end's, which says how the
  // service ended. Each save writes the row as it is when its turn comes. A save that has not ended
  // RECORD_TIMEOUT after the next was asked for, e.g. on a connection that was cut off, holds that
  // one up no longer. Settles as write() does.
  const saveRow = (write) => {
    const saving = withTimeout(rowSaves, RECORD_TIMEOUT, 'The save before')
      .catch(() => {})
      .then(write);
    rowSaves = saving.catch(() => {});
    return saving;
  };

  // Whether the message with this ID is known to be the newest that CBL's services posted to the
  // log channel: the database has one no newer, and the service has posted none newer itself. It is
  // not known when the database has none, or cannot say.
  const isNewest = async (id) => {
    const recorded = await readNewest();
    return Boolean(recorded) && !isNewerMessage(newerMessage(recorded, Logger.newestMessageID), id);
  };

  // Once the importer's tables are there, in the first cycle: read the service's row, say if the
  // process before this one ended without saying how, e.g. as it was killed or ran out of memory,
  // save this one's, and post the status message, or edit the one the last process kept up to date,
  // if it is still there. With IMPORTER_STATUS_AT_BOTTOM, that one is edited only when it is known
  // to be the newest message in the log channel, and otherwise posted again at once, below the
  // others, and deleted, as a move does (see keepAtBottom). The old copies the last process left
  // are deleted. It never holds up or fails the cycle for long. A first cycle that waits for the run
  // lock does it early, before its migrations, so the status message shows the wait (see
  // waitForRunLock), unless the importer's tables are not there yet, when it waits for the
  // migrations to make them. Resolves with whether it was done.
  const startStatus = async ({ early = false } = {}) => {
    let saved = null;
    try {
      saved = await withTimeout(readService(), RECORD_TIMEOUT, 'Reading the importer service row');
    } catch (err) {
      if (early && isMissingTable(err)) return false;
      console.warn(`Warning: could not read the importer service row: ${describeError(err)}`);
    }
    statusStarted = true;
    const endedUnsaid = Boolean(saved?.startedAt && !saved.endedAt);
    if (endedUnsaid)
      Logger.important(
        'Core',
        `The importer service's last process, which started at ${saved.startedAt}, ended without saying how, e.g. as it was killed, ran out of memory, was ended at once by a second signal, or could not reach the database as it ended.`
      );
    statusID = saved?.messageId ?? null;
    for (const id of saved?.oldMessageIds ?? [])
      if (id !== statusID) oldCopies.set(id, { ready: true, marked: false });
    const save = () =>
      saveRow(() =>
        saveService({ messageId: statusID, startedAt, oldMessageIds: [...oldCopies.keys()] })
      );
    try {
      await withTimeout(save(), RECORD_TIMEOUT, 'Saving the importer service row');
    } catch (err) {
      console.warn(`Warning: could not save the importer service row: ${describeError(err)}`);
    }
    if (postsStatus) {
      // The last process's message is below every other only if nothing newer is known. A process
      // that says how it ended posts a line below it as it stops, which the database has, unless
      // writing it failed. One that did not, e.g. as it was killed, posted none, but this process
      // has just logged one below it, which the logger may not have posted yet, so the message is
      // not the newest then either.
      const repost =
        atBottom.on &&
        Boolean(Logger.discordWebhook) &&
        statusID !== null &&
        (endedUnsaid || !(await isNewest(statusID))) &&
        !health.stopping;
      statusMessage = Logger.statusMessage(drawStatus, {
        messageID: statusID,
        editInterval: STATUS_EDIT_INTERVAL,
        repostIfDeleted: true,
        repost,
        // Each message posted, e.g. as the last one was deleted, is saved for the next process at
        // once. One posted again below newer messages replaces an old copy, which is saved with it,
        // and deleted only once that save is done, or could not be. Once the service is ending, its
        // end saves the ID with how it ended, once the message's final edit has been sent (see
        // endService), and the old copy is deleted at once.
        onPosted: (id, replaced) => {
          statusID = id;
          const old = replaced && replaced !== id ? { ready: false, marked: false } : null;
          if (old) {
            oldCopies.set(replaced, old);
            console.log(
              `Posted the status message again, below newer messages in the log channel, as ${id}, so its old copy, ${replaced}, is deleted.`
            );
          }
          const deleteOld = () => {
            if (old) old.ready = true;
            return deleteOldCopies();
          };
          if (health.stopping) {
            deleteOld();
            return undefined;
          }
          return withTimeout(save(), RECORD_TIMEOUT, 'Saving the importer service row').finally(
            deleteOld
          );
        }
      });
      if (repost) movedAt = Date.now();
      scheduleSummary();
      if (atBottom.on && !statusMessage.stopped) scheduleBottomCheck();
    }
    deleteOldCopies();
    return true;
  };

  // Show how the service ended in its status message, sent at once. Drawing it never fails the end.
  const finishStatus = () => {
    if (!statusMessage || statusMessage.stopped) return;
    try {
      statusMessage.finish(drawStatus());
    } catch (err) {
      console.warn(`Warning: could not show how the service ended: ${describeError(err)}`);
    }
  };

  // Save how the service ended in its row, ended being { startedAt, endedAt, outcome }, with the
  // ID of the status message and the old copies of it still to be deleted, waiting at most ms. It
  // never fails the end.
  const saveEnded = async (ended, messageId, ms) => {
    try {
      await withTimeout(
        saveRow(() => saveService({ ...ended, messageId, oldMessageIds: [...oldCopies.keys()] })),
        ms,
        'Saving how the importer service ended'
      );
    } catch (err) {
      console.warn(`Warning: could not save how the service ended: ${describeError(err)}`);
    }
  };

  // Write the newest message the service posted to the database now, if it has not been written
  // yet, e.g. the line that says the service is stopping, so the next process knows that this
  // one's status message is not the newest. That line may still be waiting to be sent, as the
  // status message's final edit goes ahead of lines, so the lines waiting are given half of ms, and
  // at most LINES_TIMEOUT, to be sent first (see flushLogs), and the write the rest, and never more
  // than 2 seconds (see recordNewestMessage in run.js). Only a service with a status message needs
  // it. It never fails the end.
  const recordNewest = async (ms) => {
    if (!statusMessage) return;
    const until = Date.now() + ms;
    await flushLogs(Date.now() + Math.min(ms / 2, LINES_TIMEOUT));
    await recordNewestMessage(Math.max(0, until - Date.now()), 'the service');
  };

  // Stop the statements the service still has running on the Sequelize pool's connections, e.g. as
  // the step of a cycle ended at once waits for a row lock, before it frees the locks: MySQL would
  // otherwise carry them out, also once another importer holds the locks. The locks' connection
  // closes those connections on MySQL's side, which ends their statements and rolls back what
  // they had not committed (see killConnections in run-lock.js), waiting at most ms. From then on,
  // the pool opens no new connection, so no statement can start after them. It never fails the end.
  const stopStatements = async (ms) => {
    statementsStopped = true;
    const ids = [...connections].map(({ threadId }) => threadId);
    if (ids.length === 0) return;
    let missed = ids;
    try {
      if (lock) missed = await lock.killConnections(ids, ms);
    } catch (err) {
      console.warn(`Warning: ${describeError(err)}`);
    }
    const killed = ids.length - missed.length;
    if (killed > 0)
      console.log(
        `Closed ${killed} database connection${killed === 1 ? '' : 's'} on MySQL's side before freeing the locks, which ends any statement still running on them.`
      );
    if (missed.length > 0)
      console.warn(
        `Warning: could not stop the statements of database connections ${missed.join(', ')}, which may still change the database once the locks are free.`
      );
  };

  // End the service, once: show how it ended in its status message, save that it ended as it
  // should, close the database connections, then send the log messages still waiting and release
  // the locks, all in the time left (see left). The status message's final edit may find it
  // deleted, and post it again, so the end waits for that edit to be sent for as long as it can,
  // keeping SENT_RESERVE, and then saves the row again with the new ID, for the next process to
  // edit the message that says how this one ended. Meanwhile it writes the newest message it
  // posted to the database (see recordNewest), and then writes no more, as it closes the
  // connections: a message posted after that, as the end sends its log messages, is not written,
  // rather than tried on a closed pool. It never moves the status message: the end only edits it.
  // A connection that did not close in time, as its statement is still running, has the statement
  // stopped before the locks are released (see stopStatements). Resolves with the exit code.
  const endService = () => {
    finishing ??= (async () => {
      health.stopping = true;
      clearTimeout(summaryTimer);
      clearTimeout(bottomTimer);
      clearTimeout(reportTimer);
      clearTimeout(copiesTimer);
      current = null;
      currentBefore = null;
      nextAt = null;
      finishStatus();
      try {
        if (prepared || statusStarted) {
          const ended = {
            startedAt,
            endedAt: Date.now(),
            outcome: exitCode === EXIT_CODES.FINISHED ? 'stopped' : 'failed'
          };
          const saved = statusID;
          await saveEnded(ended, saved, left(RECORD_TIMEOUT));
          if (statusMessage) {
            try {
              await withTimeout(
                statusMessage.sent(),
                Math.max(0, left(Infinity) - SENT_RESERVE),
                "Sending the status message's final edit"
              );
            } catch (err) {
              console.warn(`Warning: ${describeError(err)}`);
            }
          }
          await Promise.all([
            statusID !== saved && saveEnded(ended, statusID, left(RECORD_TIMEOUT)),
            recordNewest(left(RECORD_TIMEOUT))
          ]);
        }
        stopRecordingLogMessages();
        try {
          await withTimeout(
            disconnect(),
            left(DISCONNECT_TIMEOUT),
            'Closing the database connections'
          );
        } catch (err) {
          console.warn(`Warning: could not close the database connections: ${describeError(err)}`);
        }
        await stopStatements(left(STOP_STATEMENTS_TIMEOUT));
        console.log(
          `The importer service stopped, as ${stopping}, after ${health.cycles} cycle${health.cycles === 1 ? '' : 's'}.`
        );
        return exitCode;
      } finally {
        try {
          await flushLogs(Date.now() + left(Infinity));
        } finally {
          await lock?.release();
        }
      }
    })();
    return finishing;
  };

  // Exit straight away, closing the locks' connection, which frees them. The JSON line of a cycle
  // under way is printed, but there is no time to save it, and it exits 3. A service that is only
  // waiting between cycles, or ending, exits with the code it was stopping with.
  const exitNow = (why) => {
    console.error(`${why}, so the importer service is ending now.`);
    let code = exitCode;
    if (current && !current.record.ended)
      code = current.end(EXIT_CODES.INTERRUPTED, `${why}, so it ended at once`);
    lock?.destroy();
    process.exit(code);
  };

  // End the service at once, without waiting for the cycle under way, which has been ended (see
  // endCycleAtOnce), to stop: show how the service ended in its status message, save its row with
  // how it ended, and, with record, the cycle's record, and send the log messages, all by the time
  // given, as at its end (see endService), with a status message that its final edit posted again
  // saved in the row in the time left. Then write no more of the newest messages it posts to the
  // database, stop the statements the cycle's step still has running (see stopStatements), close
  // the locks' connection, which frees them, and exit with the code the service is stopping with.
  // This is the service's end, which the service waits for when the cycle's step ends meanwhile,
  // and which that adds nothing to (see endCycle).
  const endAtOnce = (record, by) => {
    finishing ??= (async () => {
      health.stopping = true;
      clearTimeout(summaryTimer);
      clearTimeout(stopTimer);
      clearTimeout(bottomTimer);
      clearTimeout(reportTimer);
      clearTimeout(copiesTimer);
      finishStatus();
      const saves = prepared || statusStarted;
      const ended = {
        startedAt,
        endedAt: Date.now(),
        outcome: exitCode === EXIT_CODES.FINISHED ? 'stopped' : 'failed'
      };
      const saved = statusID;
      const until = () => Math.max(0, by - Date.now());
      await Promise.allSettled([
        flushLogs(by),
        saves && saveEnded(ended, saved, until()),
        record && saveRunRecord(record, until()),
        statusMessage &&
          withTimeout(statusMessage.sent(), until(), "Sending the status message's final edit"),
        recordNewest(until())
      ]);
      if (saves && statusID !== saved && until() > 0) await saveEnded(ended, statusID, until());
      stopRecordingLogMessages();
      await stopStatements(STOP_STATEMENTS_TIMEOUT);
      lock?.destroy();
      process.exit(exitCode);
      return exitCode;
    })();
    return finishing;
  };

  // A cycle that did not stop within 60 seconds of its time limit, e.g. as a step is stuck, ends the
  // service: the cycle's JSON line is printed, the failure posted and shown in the status message,
  // with the cycle as the last one, and the process exits 1, once the log messages are sent and the
  // service's row says how it ended, or 5 seconds have passed, and the statements the cycle still
  // has running are stopped (see endAtOnce). It failed, also when a signal had asked it to stop
  // before, as its row and exit code say, and Docker then does not start it again. An end that has
  // begun ends in time by itself. before is as for endCycle.
  const exitStuck = async (cycle, before) => {
    if (finishing !== null) return;
    const why = `Cycle ${cycle.record.cycle} did not stop within ${HARD_EXIT_DELAY / 1000}s of its time limit`;
    Logger.important(
      'Core',
      `${why}, so the importer service is exiting${signals === 0 ? ', for Docker to start it again' : ''}.`
    );
    stopping = `cycle ${cycle.record.cycle} did not stop at its time limit`;
    exitCode = EXIT_CODES.FAILED;
    requestStop(stopping);
    endCycleAtOnce(cycle, before, EXIT_CODES.FAILED, `${why}, so the importer exited`);
    await endAtOnce(null, Date.now() + HARD_EXIT_FLUSH);
  };

  // STOP_DEADLINE after the first signal: a cycle that has not reached a safe point, e.g. as a
  // BattleMetrics request waits for the budget, is ended there, as stopped (see endCycleAtOnce),
  // and the service ends at once, saving the cycle's record too, by STOP_GRACE after the signal
  // less RELEASE_RESERVE, and then stops the statements the cycle still has running. It exits with
  // the code it was stopping with, 0 after the signal. A service that has not taken the service
  // lock yet exits at once. One that is ending, or between cycles, ends in time by itself.
  const onStopDeadline = () => {
    stopTimer = null;
    if (finishing !== null) return;
    if (current && !current.record.ended) {
      const why = `Cycle ${current.record.cycle} did not reach a safe point within ${STOP_DEADLINE / 1000}s of ${signalName}`;
      Logger.important(
        'Core',
        `${why}, so the importer service is ending it there, and stopping now.`
      );
      const ended = endCycleAtOnce(
        current,
        currentBefore,
        exitCode === EXIT_CODES.FINISHED ? EXIT_CODES.INTERRUPTED : EXIT_CODES.FAILED,
        `${why}, so it ended there`
      );
      endAtOnce(ended, signalAt + STOP_GRACE - RELEASE_RESERVE).catch(() => process.exit(exitCode));
    } else if (!lock) {
      console.log(`The importer service stopped before it took the service lock, as ${stopping}.`);
      process.exit(exitCode);
    }
  };

  // The first SIGTERM or SIGINT asks the service to stop at its next safe point, which it must
  // reach within STOP_DEADLINE (see onStopDeadline), and a second one ends it at once.
  const onSignal = (signal) => {
    signals++;
    if (signals > 1) {
      exitNow(`Received ${signal} again`);
      return;
    }
    signalName = signal;
    signalAt = Date.now();
    stopTimer = setTimeout(onStopDeadline, STOP_DEADLINE);
    // It must not keep the process running, which would hide a service left waiting for something
    // that can never happen (see setLeftWaiting).
    stopTimer.unref?.();
    report(
      `Received ${signal}, so the importer service will stop at its next safe point. Send it again to stop at once.`
    );
    stopService(`it received ${signal}`, EXIT_CODES.FINISHED);
  };

  // Lost locks mean another run may now hold them, so the service stops at its next safe point and
  // exits 1, for Docker to start it again, unless a signal asked it to stop first. Both locks go
  // with their connection, and between cycles the service holds only the service lock.
  const onLost = (reason) => {
    report(
      `The importer service lost its locks (${reason}), so it will stop at its next safe point${signals === 0 ? ' and exit, for Docker to start it again' : ''}.`
    );
    stopService(LOCK_LOST, EXIT_CODES.FAILED);
  };

  // Take a lock, standing by while another run holds it, or the database cannot be reached to take
  // it, and trying again every 15 seconds, for as long as it takes: the service lock as the service
  // starts, and the run lock at the start of each cycle (see waitForRunLock), as held names it,
  // 'service' or 'run'. take() resolves with the lock, or with nothing while another run holds it,
  // and fails while the database cannot be reached. describe(problem) says why it waits, which the
  // console is told at most every 5 minutes, and with post, the log channel the first time, after
  // which onWait, if given, is called. The health check and the status message show what it waits
  // for, and while another run holds the lock, the service checks once a cadence whether the
  // importer is stale, as a skipped start does. Resolves with what take() gave, also when the
  // service was asked to stop as it took the lock, or with null once the service is asked to stop.
  const standBy = async (take, { held, describe, post = false, onWait = null }) => {
    let loggedAt = -Infinity;
    let checkedAt = -Infinity;
    let waited = false;
    for (;;) {
      // A signal may have asked the service to stop while it waited.
      if (stopping !== null) return null;
      let taken = null;
      let problem = null;
      try {
        taken = await take();
      } catch (err) {
        problem = err;
      }
      if (taken) return taken;
      if (stopping !== null) return null;

      const waitingFor = problem ? 'database' : 'lock';
      if (health.waitingFor !== waitingFor) {
        Object.assign(health, { waitingFor, waitingSince: Date.now() });
        loggedAt = -Infinity;
        updateStatus();
      }
      if (Date.now() - loggedAt >= STANDBY_LOG_INTERVAL) {
        loggedAt = Date.now();
        if (post && !waited) Logger.important('Core', describe(problem));
        else console.log(describe(problem));
      }
      if (!waited && onWait) await onWait();
      waited = true;
      if (!problem && Date.now() - checkedAt >= cadenceSeconds * 1000) {
        checkedAt = Date.now();
        await checkStaleness({
          cadenceSeconds,
          skipped: held,
          startedAt: checkedAt,
          service: true
        });
      }
      await pause(LOCK_RETRY_DELAY);
    }
  };

  // Take the run lock for a cycle, numbered number, which the cycle holds while it works, so the
  // bot refuses the changes that must not overlap a run until it ends. Another run may hold it,
  // e.g. one that an importer from before the service lock started by hand, which took only the
  // run lock, and the cycle then waits for it to end (see standBy). The service's first cycle
  // shows the wait in the status message, which it then posts, as later cycles do (see
  // startStatus). A cycle asked to stop meanwhile, or whose locks are lost, stops here.
  const waitForRunLock = async (number) => {
    await standBy(() => lock.beginCycle(), {
      held: 'run',
      describe: () =>
        `Another run holds the run lock, e.g. one started by hand with an importer from before the importer service, so cycle ${number} waits for it, trying again every ${LOCK_RETRY_DELAY / 1000}s.`,
      post: true,
      onWait: async () => {
        if (!statusStarted) await startStatus({ early: true });
      }
    });
    stopIfRequested();
    Object.assign(health, { waitingFor: null, waitingSince: null });
  };

  // Show a cycle whose record has ended: add it to the totals, show it as the last cycle in the
  // status message and the health check, and post its embed if it is worth one. before holds the
  // log channel's lines and the BattleMetrics requests when the cycle started.
  const noteEnded = (cycle, before) => {
    const { ended } = cycle.record;
    const numbers = cycleNumbers(ended, {
      battlemetricsRequests: battlemetricsRequestCount() - before.requests
    });
    addCycle(totals, ended, numbers);
    last = {
      cycle: ended.cycle,
      outcome: ended.outcome,
      seconds: ended.seconds,
      endedAt: Date.parse(ended.endedAt),
      reason: ended.reason,
      numbers
    };
    Object.assign(health, {
      cycles: health.cycles + 1,
      cycle: null,
      lastCycle: {
        cycle: ended.cycle,
        outcome: ended.outcome,
        endedAt: last.endedAt,
        seconds: ended.seconds
      },
      waitingFor: null,
      waitingSince: null
    });
    if (postsCycles && isNoteworthy(ended, numbers, { lines: Logger.channelLines - before.lines }))
      try {
        moveBelow(
          Logger.post({ embeds: [renderRunStatus({ ...cycle.state(), cycle: ended.cycle })] })
        );
      } catch (err) {
        console.warn(`Warning: could not post the cycle's embed: ${describeError(err)}`);
      }
    current = null;
    currentBefore = null;
    updateStatus();
  };

  // End the cycle under way at once, while its step is still running, e.g. as a BattleMetrics
  // request waits for the budget, as the service is ending at once (see endAtOnce): its record
  // keeps what the phase under way has done so far (see keepPhaseSoFar), its JSON line is printed,
  // and it is shown as an ended cycle is, but its record is saved, if it is, by the service's end.
  // Its step carries on until the service exits, and what it does meanwhile is in no record.
  // Returns the record as it ended. before is as for endCycle.
  const endCycleAtOnce = (cycle, before, code, reason) => {
    cycle.keepPhaseSoFar();
    cycle.record.memory = memoryNow();
    cycle.end(code, reason);
    noteEnded(cycle, before);
    return cycle.record.ended;
  };

  // End a cycle: print its JSON line, show it in the status message and post its embed if it is
  // worth one (see noteEnded), then save its record, and check whether the importer is stale if
  // the cycle did not succeed, unless the service is stopping, which leaves the time for its last
  // messages. before holds the log channel's lines and the BattleMetrics requests when the cycle
  // started. A cycle that ends once the service has begun to end without it, e.g. at once (see
  // endAtOnce), has been dealt with by that end.
  const endCycle = async (cycle, code, reason, before) => {
    if (finishing !== null) return;
    const { record } = cycle;
    record.memory = memoryNow();
    cycle.end(code, reason);
    // A promise that failed with nothing to handle it fails the cycle it ended, which end() has
    // done, rather than every cycle after it.
    process.exitCode = undefined;
    const { ended } = record;
    noteEnded(cycle, before);

    const databaseDown = await saveRunRecord(ended, left(RECORD_TIMEOUT));
    if (!succeeded(ended) && !databaseDown && stopping === null)
      await checkStaleness({
        cadenceSeconds,
        skipped: false,
        startedAt: record.startedAt,
        service: true
      });
  };

  // Run one cycle, numbered number, and end it (see endCycle). It waits for the database first, and
  // then for the run lock, each for as long as it takes, and holds the run lock until it has ended,
  // when it frees it, unless the service is stopping, which frees both locks as it ends. Its time
  // limit starts once it holds the run lock. The first cycle also connects and applies the
  // importer's migrations, as a run does, and so does each cycle after it until one has. Never
  // throws.
  const runCycle = async (number) => {
    // A cycle the last one was stopped for, e.g. by its time limit, does not stop this one, unless
    // the service is stopping.
    clearStop();
    if (stopping !== null) requestStop(stopping);
    const cycle = new RunState(steps);
    const { record } = cycle;
    record.cycle = number;
    cycle.onChange = updateStatus;
    current = cycle;
    health.cycle = number;
    const before = { lines: Logger.channelLines, requests: battlemetricsRequestCount() };
    currentBefore = before;
    updateStatus();

    let watchdog = null;
    let hardExit = null;
    let code = EXIT_CODES.FAILED;
    let reason;
    try {
      await cycle.time('waitForDatabase', () =>
        waitForDatabase({
          retries: Infinity,
          maxDelay: DATABASE_MAX_DELAY,
          onRetry: () => {
            if (health.waitingFor !== 'database')
              Object.assign(health, { waitingFor: 'database', waitingSince: Date.now() });
            updateStatus();
          }
        })
      );
      Object.assign(health, { waitingFor: null, waitingSince: null });
      updateStatus();
      await cycle.time('takeRunLock', () => waitForRunLock(number));
      updateStatus();

      // The time limit, which ends a cycle that is stuck as well as one that is slow. A cycle that
      // is stopping already, e.g. after SIGTERM, still exits at once if it does not stop in time.
      watchdog = setTimeout(() => {
        if (!isStopping())
          report(
            `Cycle ${number} has taken longer than ${maxCycleSeconds}s (IMPORTER_MAX_CYCLE_SECONDS), so it will stop at its next safe point.`
          );
        requestStop(`it took longer than ${maxCycleSeconds}s`);
        hardExit = setTimeout(
          () => exitStuck(cycle, before).catch(() => process.exit(EXIT_CODES.FAILED)),
          HARD_EXIT_DELAY
        );
      }, maxCycleSeconds * 1000);

      // The locks go with their connection, which says so when it closes, but they are checked
      // too, as they are before every step that deletes or exports bans.
      if (!(await lock.isHeld())) stopService(LOCK_LOST, EXIT_CODES.FAILED);
      stopIfRequested();

      Logger.verbose(
        'Core',
        2,
        `Starting CBL update cycle ${number} (commit ${record.gitSha}, time limit ${maxCycleSeconds}s, cadence ${cadenceSeconds}s)...`
      );
      if (!prepared) {
        await cycle.time('connect', connect);
        stopIfRequested();
        const migrations = await cycle.time('migrate', () =>
          migrate({
            onApplied: (id) => {
              record.migrations.push(id);
              updateStatus();
            }
          })
        );
        prepared = true;
        logMigrations(migrations);
        // The status message of the run before the service is corrected if it still says that
        // run is in progress (see reviseLastRun), in the background.
        if (Logger.discordWebhook)
          reviseLastRun(
            steps.map((step) => step.name),
            record.startedAt
          ).catch((err) =>
            console.warn(
              `Warning: could not check the last run's status message: ${describeError(err)}`
            )
          );
        // Unless the cycle has started it already, as it waited for the run lock.
        if (!statusStarted) await startStatus();
      }

      // The steps are also told how often cycles really start, which the import plans its full
      // reads by, whatever IMPORTER_CADENCE_SECONDS says.
      await cycle.runSteps({ cadenceSeconds, cycleSeconds });
      code = EXIT_CODES.FINISHED;
      console.log(
        `Finished CBL update cycle ${number} in ${((Date.now() - record.startedAt) / 1000).toFixed(2)}s.`
      );
    } catch (err) {
      // A cycle that the service has ended at once already, e.g. at the stop's deadline, has said
      // why, so how its step ended after all is only printed.
      const tell = (message, ...extras) =>
        record.ended
          ? console.log(`${message}${extras.map(describeError).join('')}`)
          : Logger.important('Core', message, ...extras);
      if (err instanceof RunStopped) {
        tell(`The CBL update cycle ${number} stopped before it finished, as ${err.reason}.`);
        code = err.reason === LOCK_LOST ? EXIT_CODES.FAILED : EXIT_CODES.INTERRUPTED;
        reason = `Stopped, as ${err.reason}`;
        if (err.reason === LOCK_LOST) stopService(LOCK_LOST, EXIT_CODES.FAILED);
      } else {
        tell(`The CBL update cycle ${number} failed: `, err);
        reason = describeError(err);
      }
    } finally {
      clearTimeout(watchdog);
      clearTimeout(hardExit);
    }
    await endCycle(cycle, code, reason, before);
    // Between cycles, the service holds only the service lock. Freeing the run lock fails only with
    // the locks' connection, which stops the service as a lost lock does.
    if (stopping === null) await lock.endCycle();
  };

  // A service left waiting for something that can never happen, which index.js tells it, failed:
  // the cycle under way prints its JSON line as failed, and the service ends.
  setLeftWaiting(async () => {
    Logger.important(
      'Core',
      'The importer service failed, as it was left waiting for something that can never happen.'
    );
    stopService('it was left waiting for something that can never happen', EXIT_CODES.FAILED);
    if (current && !current.record.ended) current.end(EXIT_CODES.FAILED, LEFT_WAITING);
    return endService();
  });
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  setProgressListener((progress) => {
    current?.reportProgress(progress);
    updateStatus();
  });

  try {
    lock = await standBy(
      async () => {
        const taken = await takeServiceLock({ onLost });
        // Another run, or another service, holds the service lock.
        return taken.busy ? null : taken;
      },
      {
        held: 'service',
        describe: (problem) =>
          problem
            ? `The importer service could not take the service lock (${describeError(problem)}), so it tries again every ${LOCK_RETRY_DELAY / 1000}s.`
            : `Another run holds the service lock, so the importer service stands by, trying again every ${LOCK_RETRY_DELAY / 1000}s.`
      }
    );
    // A signal may have asked the service to stop as it took the lock.
    if (lock && stopping !== null) {
      await lock.release();
      lock = null;
    }
    if (!lock) {
      console.log(`The importer service stopped before it took the service lock, as ${stopping}.`);
      return exitCode;
    }
    setRunLock(lock);
    startedAt = Date.now();
    totals = newTotals(startedAt);
    Object.assign(health, { lockedAt: startedAt, waitingFor: null, waitingSince: null });
    if (discord.warning) Logger.important('Core', discord.warning);
    if (atBottom.warning) Logger.important('Core', atBottom.warning);
    const statusPlace = atBottom.on
      ? ', its status message kept at the bottom of the log channel'
      : ', its status message edited where it is';
    console.log(
      `Started the CBL importer service (commit ${gitSha}): a cycle every ${cycleSeconds}s, time limit ${maxCycleSeconds}s, cadence ${cadenceSeconds}s, ${
        Logger.discordWebhook
          ? `posting ${discord.mode} to Discord${postsStatus ? statusPlace : ''}`
          : 'posting nothing to Discord, not even alerts, as Discord logging is off'
      }.`
    );

    try {
      for (let number = 1; ; number++) {
        const cycleStart = Date.now();
        await runCycle(number);
        // The service stops after the cycle under way, once a signal or a lost lock asked it to.
        if (stopping !== null) break;
        // The next cycle starts a cycle after this one started, or at once after one that took
        // longer.
        nextAt = cycleStart + cycleSeconds * 1000;
        updateStatus();
        clearStop();
        await pause(Math.max(0, nextAt - Date.now()));
        nextAt = null;
        if (stopping !== null) break;
      }
    } catch (err) {
      Logger.important('Core', 'The importer service failed: ', err);
      stopService(describeError(err), EXIT_CODES.FAILED);
    }
    return await endService();
  } finally {
    setLeftWaiting(null);
    clearTimeout(summaryTimer);
    clearTimeout(stopTimer);
    clearTimeout(bottomTimer);
    clearTimeout(reportTimer);
    clearTimeout(copiesTimer);
    setProgressListener(null);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    sequelize.removeHook('afterConnect', onConnect);
    sequelize.removeHook('afterDisconnect', onDisconnect);
    server.close();
  }
}
