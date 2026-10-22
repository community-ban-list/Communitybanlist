import { battlemetricsRequestCount } from 'scbl-lib/apis';
import { connect, disconnect, takeRunLock } from 'scbl-lib/db';
import { describeError, Logger } from 'scbl-lib/utils';

import startHealthCheckServer, { checkHealth } from './health-check-server.js';
import { readService, saveService, succeeded } from './run-record.js';
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
// service, in the Portainer stack, rather than once per start. It takes the run lock once and keeps
// it, and runs a cycle every IMPORTER_CYCLE_SECONDS, from the start of one to the start of the
// next, or at once after one that took longer. Each cycle runs the steps as a run in once mode
// does (see run.js): the same steps and stop points, its own run record, saved as a run's is, and
// its own JSON line, with the cycle's number. The service stops only when it is asked to, by
// SIGTERM or SIGINT, or when it can no longer go on safely: when it loses the run lock, or when a
// cycle does not stop within 60 seconds of its time limit. It then exits 1, for Docker to start it
// again, as Docker never restarts a container that is only unhealthy.

// How the importer runs (IMPORTER_MODE): once, the default, runs the steps once and exits, as the
// script that starts the importer has it, and loop runs them as the importer service.
export const MODES = ['once', 'loop'];

// A cycle starts every 10 minutes, unless IMPORTER_CYCLE_SECONDS says otherwise, and one that takes
// longer than 15 minutes (IMPORTER_MAX_CYCLE_SECONDS) stops at its next safe point.
const DEFAULT_CYCLE_SECONDS = 10 * 60;
const DEFAULT_MAX_CYCLE_SECONDS = 15 * 60;

// While another run holds the run lock, e.g. one started by hand, or the database cannot be
// reached to take it, the service tries again this often, and says so in the console at most this
// often.
const LOCK_RETRY_DELAY = 15 * 1000;
const STANDBY_LOG_INTERVAL = 5 * 60 * 1000;

// A cycle waits for the database for as long as it takes, trying again after 5, 10, 20 and 40
// seconds, and then every minute.
const DATABASE_MAX_DELAY = 60 * 1000;

// The service's status message is edited at most once a minute, and its final edit is sent at
// once. The web server and the bot post to the same webhook, and Discord limits each webhook.
const STATUS_EDIT_INTERVAL = 60 * 1000;

// docker stop gives the service 60 seconds (stop_grace_period) before it kills it. Once the service
// is asked to stop, its end, from saving the last cycle's record to releasing the lock, waits for
// nothing beyond 55 seconds after it was asked, nor beyond END_TIMEOUT after the end began, as a
// run's end does, so a cycle that reaches its safe point late leaves its end less time.
const STOP_GRACE = 55 * 1000;

// A cycle that has not stopped 60 seconds after its time limit ends the service at once, after
// waiting at most this long for its log messages to be sent, so the log channel says why.
const HARD_EXIT_FLUSH = 5 * 1000;

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
// on, and resolve with its exit code: 0 once it stopped as it was asked to, 1 once it lost the run
// lock, a cycle did not stop within 60 seconds of its time limit, or it failed, and 3 when a second
// signal ended it at once. Each step is { name, run, counts } (see RunState in run.js).
//
// While it goes, it keeps a health server, for the Docker health check (see
// health-check-server.js). It posts the alerts that runs post, in every mode, and, as
// IMPORTER_LOOP_DISCORD says, the embed of each cycle that changed something or had a problem,
// and its status message and hourly summary (see service-status.js). Nothing it posts waits for
// Discord.
export default async function runLoop(steps) {
  const cycleSeconds = readSeconds('IMPORTER_CYCLE_SECONDS', DEFAULT_CYCLE_SECONDS);
  const maxCycleSeconds = readSeconds('IMPORTER_MAX_CYCLE_SECONDS', DEFAULT_MAX_CYCLE_SECONDS);
  // Staleness and the Steam step's budget go by how often cycles start, unless
  // IMPORTER_CADENCE_SECONDS says otherwise.
  const cadenceSeconds = readSeconds('IMPORTER_CADENCE_SECONDS', cycleSeconds);
  const discord = readDiscordMode(process.env.IMPORTER_LOOP_DISCORD);
  const postsCycles = discord.mode !== 'status';
  const postsStatus = discord.mode !== 'changes';
  const gitSha = process.env.GIT_SHA || 'unknown';

  // What the service is doing, for the health check: when it took the run lock, the cycle under
  // way and the last one that ended, and what it is waiting for, if anything. A cycle that ended
  // within two cycles and the time limit keeps it healthy.
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
    memory: memoryNow()
  }));

  let lock = null;
  // Why the service is stopping, once it is, with the exit code that gives and when it was asked.
  let stopping = null;
  let exitCode = EXIT_CODES.FINISHED;
  let stopAt = null;
  // The cycle under way, as a RunState, and when it started waiting for the database, while it is.
  let current = null;
  let waitingSince = null;
  // Whether a cycle has connected and applied the importer's migrations, which the first does.
  let prepared = false;
  // When the service took the run lock, the totals since its last hourly summary, the last cycle
  // that ended, and when the next starts, between cycles.
  let startedAt = null;
  let totals = newTotals(Date.now());
  let last = null;
  let nextAt = null;
  // The service's status message, its ID, and the timer for the next hourly summary.
  let statusMessage = null;
  let statusID = null;
  let summaryTimer = null;
  // The end of the service, once it is ending, and by when the lock is released.
  let finishing = null;
  let releaseBy = null;

  // Report on the service: in the Discord log once it holds the lock, and before that only in the
  // console.
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
    stopAt = Date.now();
    requestStop(reason);
  };

  // How long the service's end may still wait for something, at most limit. Once it is stopping,
  // it ends by STOP_GRACE after it was asked, or END_TIMEOUT after it began to end, if that is
  // sooner, keeping the last RELEASE_RESERVE for releasing the lock.
  const left = (limit) => {
    if (stopping === null) return limit;
    releaseBy ??= Math.min(Date.now() + END_TIMEOUT, stopAt + STOP_GRACE) - RELEASE_RESERVE;
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
            waitingSince
          },
          last,
          nextAt,
          totals,
          reason: stopping
        })
      ]
    };
  };
  // Say that the service's status changed, which its next edit shows, at most once a minute.
  const updateStatus = () => statusMessage?.update(drawStatus);

  // Post the hourly summary when it is due, and start the next hour's totals.
  const scheduleSummary = () => {
    if (!postsStatus) return;
    summaryTimer = setTimeout(
      () => {
        const until = Date.now();
        try {
          Logger.post({ embeds: [renderHourlySummary(totals, until)] });
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

  // Once the importer's tables are there, in the first cycle: read the service's row, say if the
  // process before this one ended without saying how, e.g. as it was killed or ran out of memory,
  // save this one's, and post the status message, or edit the one the last process kept up to date,
  // if it is still there. It never holds up or fails the cycle for long.
  const startStatus = async () => {
    let saved = null;
    try {
      saved = await withTimeout(readService(), RECORD_TIMEOUT, 'Reading the importer service row');
    } catch (err) {
      console.warn(`Warning: could not read the importer service row: ${describeError(err)}`);
    }
    if (saved?.startedAt && !saved.endedAt)
      Logger.important(
        'Core',
        `The importer service's last process, which started at ${saved.startedAt}, ended without saying how, e.g. as it was killed, ran out of memory, was ended at once by a second signal, or could not reach the database as it ended.`
      );
    statusID = saved?.messageId ?? null;
    const save = () => saveService({ messageId: statusID, startedAt });
    try {
      await withTimeout(save(), RECORD_TIMEOUT, 'Saving the importer service row');
    } catch (err) {
      console.warn(`Warning: could not save the importer service row: ${describeError(err)}`);
    }
    if (postsStatus) {
      statusMessage = Logger.statusMessage(drawStatus, {
        messageID: statusID,
        editInterval: STATUS_EDIT_INTERVAL,
        repostIfDeleted: true,
        // A message posted again once the service is ending is saved with how it ended.
        onPosted: (id) => {
          statusID = id;
          return health.stopping ? undefined : save();
        }
      });
      scheduleSummary();
    }
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

  // End the service, once: show how it ended in its status message, save that it ended as it
  // should, close the database connections, then send the log messages still waiting and release
  // the lock, all in the time left (see left). Resolves with the exit code.
  const endService = () => {
    finishing ??= (async () => {
      health.stopping = true;
      clearTimeout(summaryTimer);
      current = null;
      nextAt = null;
      finishStatus();
      try {
        if (prepared) {
          try {
            await withTimeout(
              saveService({
                messageId: statusID,
                startedAt,
                endedAt: Date.now(),
                outcome: exitCode === EXIT_CODES.FINISHED ? 'stopped' : 'failed'
              }),
              left(RECORD_TIMEOUT),
              'Saving how the importer service ended'
            );
          } catch (err) {
            console.warn(`Warning: could not save how the service ended: ${describeError(err)}`);
          }
        }
        try {
          await withTimeout(
            disconnect(),
            left(DISCONNECT_TIMEOUT),
            'Closing the database connections'
          );
        } catch (err) {
          console.warn(`Warning: could not close the database connections: ${describeError(err)}`);
        }
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

  // Exit straight away, closing the lock's connection, which frees the lock. The JSON line of a
  // cycle under way is printed, but there is no time to save it, and it exits 3. A service that is
  // only ending, between cycles, exits with its own code.
  const exitNow = (why) => {
    console.error(`${why}, so the importer service is ending now.`);
    let code = exitCode;
    if (current && !current.record.ended)
      code = current.end(EXIT_CODES.INTERRUPTED, `${why}, so it ended at once`);
    lock?.destroy();
    process.exit(code);
  };

  // A cycle that did not stop within 60 seconds of its time limit, e.g. as a step is stuck, ends the
  // service: the cycle's JSON line is printed, the failure posted and shown in the status message,
  // and the process exits 1, once the log messages are sent and the service's row says how it
  // ended, or 5 seconds have passed.
  const exitStuck = async (cycle) => {
    const why = `Cycle ${cycle.record.cycle} did not stop within ${HARD_EXIT_DELAY / 1000}s of its time limit`;
    Logger.important(
      'Core',
      `${why}, so the importer service is exiting, for Docker to start it again.`
    );
    stopService(`cycle ${cycle.record.cycle} did not stop at its time limit`, EXIT_CODES.FAILED);
    cycle.end(EXIT_CODES.FAILED, `${why}, so the importer exited`);
    finishing ??= Promise.resolve(EXIT_CODES.FAILED);
    health.stopping = true;
    finishStatus();
    const by = Date.now() + HARD_EXIT_FLUSH;
    await Promise.allSettled([
      flushLogs(by),
      prepared &&
        withTimeout(
          saveService({ messageId: statusID, startedAt, endedAt: Date.now(), outcome: 'failed' }),
          HARD_EXIT_FLUSH,
          'Saving how the importer service ended'
        )
    ]);
    lock?.destroy();
    process.exit(EXIT_CODES.FAILED);
  };

  // The first SIGTERM or SIGINT asks the service to stop at its next safe point, and a second one
  // ends it at once.
  let signals = 0;
  const onSignal = (signal) => {
    signals++;
    if (signals > 1) {
      exitNow(`Received ${signal} again`);
      return;
    }
    report(
      `Received ${signal}, so the importer service will stop at its next safe point. Send it again to stop at once.`
    );
    stopService(`it received ${signal}`, EXIT_CODES.FINISHED);
  };

  // A lost lock means another run may now hold it, so the service stops at its next safe point and
  // exits 1, for Docker to start it again.
  const onLost = (reason) => {
    report(
      `The importer service lost its run lock (${reason}), so it will stop at its next safe point and exit, for Docker to start it again.`
    );
    stopService(LOCK_LOST, EXIT_CODES.FAILED);
  };

  // Take the run lock, standing by while another run holds it, or the database cannot be reached
  // to take it, and trying again every 15 seconds, for as long as it takes. While another run holds
  // it, the service checks whether the importer is stale once a cadence, as a skipped start does.
  // Resolves with the lock, or with null once the service is asked to stop.
  const standBy = async () => {
    let loggedAt = -Infinity;
    let checkedAt = -Infinity;
    for (;;) {
      // A signal may have asked the service to stop while it waited.
      if (stopping !== null) return null;
      let taken = null;
      let problem = null;
      try {
        taken = await takeRunLock({ onLost });
      } catch (err) {
        problem = err;
      }
      if (taken && stopping !== null) await taken.release();
      if (stopping !== null) return null;
      if (taken) return taken;

      const waitingFor = problem ? 'database' : 'lock';
      if (health.waitingFor !== waitingFor) {
        Object.assign(health, { waitingFor, waitingSince: Date.now() });
        loggedAt = -Infinity;
      }
      if (Date.now() - loggedAt >= STANDBY_LOG_INTERVAL) {
        loggedAt = Date.now();
        console.log(
          problem
            ? `The importer service could not take the run lock (${describeError(problem)}), so it tries again every ${LOCK_RETRY_DELAY / 1000}s.`
            : `Another run holds the run lock, so the importer service stands by, trying again every ${LOCK_RETRY_DELAY / 1000}s.`
        );
      }
      if (!problem && Date.now() - checkedAt >= cadenceSeconds * 1000) {
        checkedAt = Date.now();
        await checkStaleness({
          cadenceSeconds,
          skipped: true,
          startedAt: checkedAt,
          service: true
        });
      }
      await pause(LOCK_RETRY_DELAY);
    }
  };

  // End a cycle: print its JSON line, show it in the status message and post its embed if it is
  // worth one, then save its record, and check whether the importer is stale if the cycle did not
  // succeed, unless the service is stopping, which leaves the time for its last messages. before
  // holds the log channel's lines and the BattleMetrics requests when the cycle started.
  const endCycle = async (cycle, code, reason, before) => {
    const { record } = cycle;
    record.memory = memoryNow();
    cycle.end(code, reason);
    // A promise that failed with nothing to handle it fails the cycle it ended, which end() has
    // done, rather than every cycle after it.
    process.exitCode = undefined;
    const { ended } = record;
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
        Logger.post({ embeds: [renderRunStatus({ ...cycle.state(), cycle: ended.cycle })] });
      } catch (err) {
        console.warn(`Warning: could not post the cycle's embed: ${describeError(err)}`);
      }
    current = null;
    waitingSince = null;
    updateStatus();

    const databaseDown = await saveRunRecord(ended, left(RECORD_TIMEOUT));
    if (!succeeded(ended) && !databaseDown && stopping === null)
      await checkStaleness({
        cadenceSeconds,
        skipped: false,
        startedAt: record.startedAt,
        service: true
      });
  };

  // Run one cycle, numbered number, and end it (see endCycle). It waits for the database first, for
  // as long as it takes. Its time limit starts once the database answers. The first cycle also
  // connects and applies the importer's migrations, as a run does, and so does each cycle after
  // it until one has. Never throws.
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
            waitingSince ??= Date.now();
            if (health.waitingFor !== 'database')
              Object.assign(health, { waitingFor: 'database', waitingSince });
            updateStatus();
          }
        })
      );
      waitingSince = null;
      Object.assign(health, { waitingFor: null, waitingSince: null });
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
          () => exitStuck(cycle).catch(() => process.exit(EXIT_CODES.FAILED)),
          HARD_EXIT_DELAY
        );
      }, maxCycleSeconds * 1000);

      // The lock goes with its connection, which says so when it closes, but it is checked too,
      // as it is before every step that deletes or exports bans.
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
        await startStatus();
      }

      await cycle.runSteps({ cadenceSeconds });
      code = EXIT_CODES.FINISHED;
      console.log(
        `Finished CBL update cycle ${number} in ${((Date.now() - record.startedAt) / 1000).toFixed(2)}s.`
      );
    } catch (err) {
      if (err instanceof RunStopped) {
        Logger.important(
          'Core',
          `The CBL update cycle ${number} stopped before it finished, as ${err.reason}.`
        );
        code = err.reason === LOCK_LOST ? EXIT_CODES.FAILED : EXIT_CODES.INTERRUPTED;
        reason = `Stopped, as ${err.reason}`;
        if (err.reason === LOCK_LOST) stopService(LOCK_LOST, EXIT_CODES.FAILED);
      } else {
        Logger.important('Core', `The CBL update cycle ${number} failed: `, err);
        reason = describeError(err);
      }
    } finally {
      clearTimeout(watchdog);
      clearTimeout(hardExit);
    }
    await endCycle(cycle, code, reason, before);
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
    lock = await standBy();
    if (!lock) {
      console.log(`The importer service stopped before it took the run lock, as ${stopping}.`);
      return exitCode;
    }
    setRunLock(lock);
    startedAt = Date.now();
    totals = newTotals(startedAt);
    Object.assign(health, { lockedAt: startedAt, waitingFor: null, waitingSince: null });
    if (discord.warning) Logger.important('Core', discord.warning);
    console.log(
      `Started the CBL importer service (commit ${gitSha}): a cycle every ${cycleSeconds}s, time limit ${maxCycleSeconds}s, cadence ${cadenceSeconds}s, posting ${discord.mode} to Discord.`
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
    setProgressListener(null);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    server.close();
  }
}
