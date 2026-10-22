import { connect, disconnect, sequelize, takeRunLock } from 'scbl-lib/db';
import { isDatabaseUnavailable } from 'scbl-lib/db/sequelize';
import { describeError, Logger } from 'scbl-lib/utils';

import RunRecord, {
  alertIfStale,
  readRunMessage,
  readSavedRun,
  saveRecord,
  saveRunMessage,
  succeeded
} from './run-record.js';
import {
  LOCK_LOST,
  pause,
  requestStop,
  RunStopped,
  setProgressListener,
  setRunLock,
  stopIfRequested
} from './run-control.js';
import renderRunStatus, { markEnded, markUnfinished } from './run-status.js';
import migrate from './schema/migrate.js';

// What the importer's exit code tells the script that starts it.
export const EXIT_CODES = {
  FINISHED: 0,
  FAILED: 1,
  // Stopped part-way by SIGTERM, SIGINT or the time limit.
  INTERRUPTED: 3,
  // Skipped, as another run holds the run lock. 75 is EX_TEMPFAIL: try again later.
  SKIPPED: 75
};

// How the run record names each exit code.
const OUTCOMES = {
  [EXIT_CODES.FINISHED]: 'finished',
  [EXIT_CODES.FAILED]: 'failed',
  [EXIT_CODES.INTERRUPTED]: 'interrupted',
  [EXIT_CODES.SKIPPED]: 'skipped'
};

// A run that takes longer than this stops at its next safe point, so it ends cleanly before the
// next run, started 6 hours after it, has to stop it. IMPORTER_MAX_RUN_SECONDS changes it.
const DEFAULT_MAX_RUN_SECONDS = 5 * 60 * 60;

// How often the script that starts the importer starts a run. Once no run has succeeded for 3 times
// this long, the importer posts that it is stale, and the Steam step refreshes enough profiles each
// run to keep up at this schedule. IMPORTER_CADENCE_SECONDS changes it, e.g. to 3600 when runs start
// every hour.
const DEFAULT_CADENCE_SECONDS = 6 * 60 * 60;

// The longest time a timer can wait for, about 24 days, which limits both settings.
const MAX_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

// A run that has not ended this long after reaching its time limit exits at once.
export const HARD_EXIT_DELAY = 60 * 1000;

// The database may be restarting when the run starts, so it is tried up to 5 more times, waiting
// 5, 10, 20, 40 and then 80 seconds.
const DATABASE_RETRIES = 5;
const DATABASE_RETRY_DELAY = 5 * 1000;

// How long to wait at the end of a run for Discord log messages still waiting to be sent.
const LOG_FLUSH_TIMEOUT = 30 * 1000;

// At the end of a run, saving its record and checking whether the importer is stale each wait at
// most RECORD_TIMEOUT, and closing the database connections at most DISCONNECT_TIMEOUT, so a slow
// or stuck database can never hold up the end of a run, nor make a run that finished fail.
export const RECORD_TIMEOUT = 15 * 1000;
export const DISCONNECT_TIMEOUT = 10 * 1000;

// The end of a run that holds the run lock, from saving its record to releasing the lock, takes at
// most END_TIMEOUT, so a run that docker stop stops, which it gives 60 seconds with
// --stop-timeout 60, exits in time once it reaches its next safe point. The last RELEASE_RESERVE of
// it is kept for releasing the lock, which takes at most 5 seconds, and the log messages are sent
// in what is left after the database.
export const END_TIMEOUT = 45 * 1000;
export const RELEASE_RESERVE = 5 * 1000;

// Why a run failed that was left waiting for something that can never happen.
export const LEFT_WAITING = 'The run was left waiting for something that can never happen';

// Why a run stopped that lost its run lock, as its record gives it.
const STOPPED_LOCK_LOST = `Stopped, as ${LOCK_LOST}`;

// While a run goes, its status in the log channel is drawn again this often, so the time it has
// taken stays current while nothing else changes. The logger edits it no more often than this.
const STATUS_REFRESH = 15 * 1000;

// Ends the run under way as one that was left waiting, while a run is under way.
let endLeftWaiting = null;

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for a promise, but for no longer than ms milliseconds, failing with what took too long, in an
// error marked timedOut.
export function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} took longer than ${Math.round(ms / 100) / 10}s`);
      reject(Object.assign(err, { timedOut: true }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Send the progress bars' latest values and wait for queued Discord log messages, but for no longer
// than until deadline, by default LOG_FLUSH_TIMEOUT from now, so a slow or unreachable Discord
// cannot keep the run from ending.
export async function flushLogs(deadline = Date.now() + LOG_FLUSH_TIMEOUT) {
  Logger.flush();
  while (Date.now() < deadline && Object.values(Logger.getLogQueue()).some((count) => count > 0))
    await doSleep(Math.min(500, deadline - Date.now()));
}

// End the run under way as failed, as it was left waiting for something that can never happen,
// e.g. an answer on a connection that is gone. index.js calls this when Node finds nothing left to
// wait for before the run has ended. The failure is posted, and a run that holds the run lock ends
// as a failed run does, printing and saving its record. Resolves with the exit code.
export async function leftWaiting() {
  return endLeftWaiting ? endLeftWaiting() : EXIT_CODES.FAILED;
}

// Set how leftWaiting ends what is under way, e.g. the importer service, or null once nothing is.
export function setLeftWaiting(handler) {
  endLeftWaiting = handler;
}

// Read a setting given in seconds, or use its default when it is not set. An invalid value is
// replaced with the default, with a warning.
export function readSeconds(name, defaultSeconds) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return defaultSeconds;

  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_SECONDS) return seconds;
  console.warn(
    `Warning: ${name} must be a whole number from 1 to ${MAX_SECONDS}, not "${value}", so the default of ${defaultSeconds} is used.`
  );
  return defaultSeconds;
}

// How a run's status names the way the run ended, from its record: a run that lost its run lock
// failed, but is named for that.
function outcomeOf({ exitCode, reason }) {
  if (exitCode === EXIT_CODES.FINISHED) return 'finished';
  if (exitCode === EXIT_CODES.INTERRUPTED) return 'stopped';
  return reason === STOPPED_LOCK_LOST ? 'lockLost' : 'failed';
}

// The status of an earlier run, drawn from the record it saved, for a run whose last edit did not
// reach Discord. The record does not say which steps were still to run, so steps gives them, nor
// whether the phase a run that did not finish ended in had finished, as it has when the run stopped
// between two steps, so that phase is shown as the one it ended in.
function savedStatus(saved, steps) {
  const phases = saved.phases && typeof saved.phases === 'object' ? saved.phases : {};
  const finished = saved.exitCode === EXIT_CODES.FINISHED;
  return {
    outcome: outcomeOf(saved),
    startedAt: Date.parse(saved.startedAt),
    at: Date.parse(saved.endedAt),
    seconds: saved.seconds,
    gitSha: saved.gitSha,
    steps,
    phases,
    phase: saved.phase,
    completed: Object.keys(phases).filter((name) => finished || name !== saved.phase),
    progress: {},
    counts: saved.counts,
    migrations: saved.migrations,
    reason: saved.reason
  };
}

// Correct the status message of the run before this one if it still says that run is in progress,
// as that run's last edit did not reach Discord. A run that saved its record is shown as it ended,
// from its record, e.g. when Discord was down as it ended, and one that saved none ended without
// saying how, e.g. as it was killed, so it is marked as having ended without finishing. steps names
// this run's steps, and foundAt is when it started. The logger does it in the background.
export async function reviseLastRun(steps, foundAt) {
  const last = await readRunMessage();
  if (!last) return;
  const saved = await readSavedRun(last.startedAt);
  Logger.reviseMessage(last.messageId, (message) =>
    saved ? markEnded(message, savedStatus(saved, steps)) : markUnfinished(message, { foundAt })
  );
}

// Wait for the database to answer, as the script that starts the importer may have just restarted
// it, trying again up to retries times, waiting twice as long each time, up to maxDelay. The
// importer service waits for as long as it takes (retries Infinity). onRetry(err), if given, is
// told each time the database is not available. A run asked to stop stops waiting.
export async function waitForDatabase({
  retries = DATABASE_RETRIES,
  maxDelay = Infinity,
  onRetry = null
} = {}) {
  for (let retry = 1; ; retry++) {
    try {
      await sequelize.authenticate();
      return;
    } catch (err) {
      if (!isDatabaseUnavailable(err) || retry > retries) throw err;

      const delay = Math.min(maxDelay, DATABASE_RETRY_DELAY * 2 ** Math.min(retry - 1, 20));
      const count = Number.isFinite(retries) ? `retry ${retry} of ${retries}` : `retry ${retry}`;
      console.log(
        `The database is not available (${describeError(err)}). Trying again in ${delay / 1000}s (${count}).`
      );
      onRetry?.(err);
      await pause(delay);
      stopIfRequested();
    }
  }
}

// Save the record of a run that ended, waiting at most ms. A save that fails, or takes too long, is
// warned about in the console, and never fails the run. Resolves with whether the database seemed
// to be down: unavailable, or too slow to answer in time.
export async function saveRunRecord(ended, ms) {
  try {
    await withTimeout(saveRecord(ended), ms, 'Saving the run record');
    return false;
  } catch (err) {
    console.warn(`Warning: could not save the run record: ${describeError(err)}`);
    return err?.timedOut === true || isDatabaseUnavailable(err);
  }
}

// Check whether the importer is stale, and post if it is, waiting at most ms (see alertIfStale).
// This never fails or holds up the run. Resolves with whether it posted.
export async function checkStaleness(options, ms = RECORD_TIMEOUT) {
  try {
    return await withTimeout(alertIfStale(options), ms, 'Checking whether the CBL update is stale');
  } catch (err) {
    console.warn(`Warning: could not check whether the CBL update is stale: ${describeError(err)}`);
    return false;
  }
}

// One run of the importer's steps, or in loop mode one cycle of the importer service: its record,
// which phases finished, and how far each step got, as the steps report it. Each step is
// { name, run, counts }: run(settings) does the step's work, given the run's settings that steps
// use, { cadenceSeconds }, and counts(), if given, returns the counts the run record keeps for it.
// onChange, when set, is told whenever a phase starts or ends.
export class RunState {
  constructor(steps) {
    this.steps = steps;
    this.record = new RunRecord();
    this.completed = new Set();
    this.progress = {};
    this.onChange = null;
  }

  changed() {
    this.onChange?.();
  }

  // Time a phase of the run, and note when the phase starts and once it finished.
  async time(name, work) {
    const timed = this.record.time(name, work);
    this.changed();
    const result = await timed;
    this.completed.add(name);
    this.changed();
    return result;
  }

  // Note how far the step under way has got, as it reports it.
  reportProgress(report) {
    if (this.record.phase) this.progress[this.record.phase] = report;
  }

  // Run the steps in order, keeping the counts each gives, also when it fails or stops part-way. A
  // run that is asked to stop does so between steps, as well as at the steps' own safe points.
  async runSteps(settings) {
    for (const step of this.steps) {
      stopIfRequested();
      await this.time(step.name, async () => {
        try {
          await step.run(settings);
        } finally {
          if (step.counts) this.record.count(step.name, step.counts);
        }
      });
    }
  }

  // The run's status, while it runs or once it has ended, as run-status.js draws it.
  state() {
    const { record } = this;
    const { ended } = record;
    return {
      outcome: ended ? outcomeOf(ended) : 'running',
      startedAt: record.startedAt,
      at: ended ? Date.parse(ended.endedAt) : Date.now(),
      seconds: ended?.seconds,
      gitSha: record.gitSha,
      steps: this.steps.map((step) => step.name),
      phases: record.phases,
      phase: record.phase,
      phaseStartedAt: record.phaseStartedAt,
      completed: [...this.completed],
      progress: this.progress,
      counts: record.counts,
      migrations: record.migrations,
      reason: ended?.reason
    };
  }

  // End the run's record and print it as the run's JSON line, once. Returns the exit code it ended
  // with: a run that finished exits 1 after a promise failed with nothing to handle it, as index.js
  // then exits 1, and its record says so.
  end(exitCode, reason) {
    const { record } = this;
    if (record.ended) return record.ended.exitCode;
    let code = exitCode;
    if (code === EXIT_CODES.FINISHED && process.exitCode) {
      code = EXIT_CODES.FAILED;
      reason = 'A promise failed with nothing to handle it';
    }
    const ended = record.end(OUTCOMES[code], code, reason);
    try {
      console.log(JSON.stringify(ended));
    } catch (err) {
      console.warn(`Warning: could not print the run record: ${describeError(err)}`);
    }
    return code;
  }
}

// Run the importer's steps once, holding the run lock, and resolve with the exit code. Each step is
// { name, run, counts } (see RunState). A run that is asked to stop does so between steps. Once the
// run holds the lock, the importer's migrations are applied before the first step.
//
// The run's lines about problems, such as why it failed or is stopping, are logged as important, so
// they reach the log channel even when the run's other messages fill its queue. Its start and its
// end, when it finishes, are only printed in the console, as is the JSON line with its record that
// every run prints when it ends.
//
// Once a run holds the lock, it also posts its status to the log channel: one message, edited at
// most every 15 seconds while the run goes, with each finished phase and the progress of the one
// under way, and edited a last time to show how the run ended, at the start of its end, before the
// lock is released. A run that is skipped, or fails before it holds the lock, posts no status.
export default async function run(steps) {
  const current = new RunState(steps);
  const { record } = current;
  const maxRunSeconds = readSeconds('IMPORTER_MAX_RUN_SECONDS', DEFAULT_MAX_RUN_SECONDS);
  const cadenceSeconds = readSeconds('IMPORTER_CADENCE_SECONDS', DEFAULT_CADENCE_SECONDS);
  let lock = null;

  // The run's status message, once the run holds the lock, and the timer that draws it again. It
  // shows the phases that finished, and how far each step got, as the steps report it.
  let status = null;
  let statusTimer = null;

  // Draw the run's status, while it runs or once it has ended.
  const drawStatus = () => ({ embeds: [renderRunStatus(current.state())] });

  // Say that the run's status changed, which its next edit shows. It is drawn only then.
  const showStatus = () => status?.update(drawStatus);
  current.onChange = showStatus;

  // Time a phase of the run, and note in its status when the phase starts and once it finished.
  const time = (name, work) => current.time(name, work);

  // Post the run's status, now that the run holds the lock, and keep it up to date: the steps say
  // how far they have got, and it is drawn again every 15 seconds. Without Discord logging there is
  // nothing to keep up to date, nor once the message could not be posted or edited.
  const postStatus = () => {
    status = Logger.statusMessage(drawStatus);
    if (status.stopped) return;
    setProgressListener((report) => {
      current.reportProgress(report);
      showStatus();
    });
    const refresh = () => {
      if (status.stopped) return;
      showStatus();
      statusTimer = setTimeout(refresh, STATUS_REFRESH);
      // It must not keep the process running.
      statusTimer.unref();
    };
    statusTimer = setTimeout(refresh, STATUS_REFRESH);
    statusTimer.unref();
  };

  // Show how the run ended: drawn now and sent at once, ahead of the run's other log messages.
  // Drawing it never fails the end of the run.
  const finishStatus = () => {
    clearTimeout(statusTimer);
    statusTimer = null;
    setProgressListener(null);
    if (!status || status.stopped) return;
    try {
      status.finish(drawStatus());
    } catch (err) {
      console.warn(
        `Warning: could not show how the run ended in its status: ${describeError(err)}`
      );
    }
  };

  // The status message of the run before this one is corrected if it still says that run is in
  // progress (see reviseLastRun). This run's own message is then saved in its place, once it is
  // posted, for the next run to check. It is all done in the background, and nothing of it holds up
  // or fails the run.
  const checkLastStatus = async () => {
    if (!status || status.stopped) return;
    try {
      await reviseLastRun(
        steps.map((step) => step.name),
        record.startedAt
      );
      const messageId = await status.posted;
      if (messageId && !finishing) await saveRunMessage({ messageId, startedAt: record.startedAt });
    } catch (err) {
      console.warn(`Warning: could not check the last run's status message: ${describeError(err)}`);
    }
  };

  // Report on the run: in the Discord log once the run holds the lock, and before that only in the
  // console, so a run that is stopped before it starts posts nothing.
  const report = (message) => {
    if (lock) Logger.important('Core', message);
    else console.log(message);
  };

  // End the run's record and print it as the run's JSON line, once (see RunState).
  const end = (exitCode, reason) => current.end(exitCode, reason);

  // Post why the run failed before it held the lock, and wait for the line to be sent. Only a run
  // that is skipped posts nothing, unless the importer is stale, and a failed run must be seen.
  const failBeforeLock = async (message, err) => {
    Logger.important('Core', message, err);
    await flushLogs();
    return EXIT_CODES.FAILED;
  };

  // End a run that holds the lock, once: print its record, show how it ended in its status, save
  // its record, check whether the importer is now stale if the run did not succeed, close the
  // database connections if it finished, then send the log messages still waiting, the status's
  // last edit among them, and release the lock, all within END_TIMEOUT. A database that could not
  // save the record in time, or is unavailable, is not asked whether the importer is stale, which
  // leaves the time for the log messages. Resolves with the exit code.
  let finishing = null;
  const finish = (exitCode, reason) => {
    finishing ??= (async () => {
      const code = end(exitCode, reason);
      finishStatus();
      const releaseBy = Date.now() + END_TIMEOUT - RELEASE_RESERVE;
      // The time left before the lock is released, but at most limit.
      const left = (limit) => Math.max(0, Math.min(limit, releaseBy - Date.now()));
      try {
        const databaseDown = await saveRunRecord(record.ended, left(RECORD_TIMEOUT));
        if (!succeeded(record.ended) && !databaseDown)
          await checkStaleness(
            { cadenceSeconds, skipped: false, startedAt: record.startedAt },
            left(RECORD_TIMEOUT)
          );
        if (code === EXIT_CODES.FINISHED) {
          try {
            await withTimeout(
              disconnect(),
              left(DISCONNECT_TIMEOUT),
              'Closing the database connections'
            );
          } catch (err) {
            console.warn(
              `Warning: could not close the database connections: ${describeError(err)}`
            );
          }
        }
        return code;
      } finally {
        try {
          await flushLogs(releaseBy);
        } finally {
          await lock.release();
        }
      }
    })();
    return finishing;
  };

  // A run left waiting for something that can never happen failed, and is posted as failed runs
  // are. If any of it is still under way, it stops at its next safe point.
  endLeftWaiting = async () => {
    requestStop('it was left waiting for something that can never happen');
    Logger.important(
      'Core',
      'The CBL update run failed, as it was left waiting for something that can never happen.'
    );
    if (lock) return finish(EXIT_CODES.FAILED, LEFT_WAITING);
    await flushLogs();
    return end(EXIT_CODES.FAILED, LEFT_WAITING);
  };

  // Exit straight away. Closing the lock's connection frees the lock. There is no time to save the
  // run's record, but its JSON line is printed. A run that has already ended, and is only saving its
  // record or sending its log messages, exits with its own code.
  const exitNow = (why) => {
    console.error(`${why}, so the run is ending now.`);
    const exitCode = end(EXIT_CODES.INTERRUPTED, `${why}, so it ended at once`);
    if (lock) lock.destroy();
    process.exit(exitCode);
  };

  // The first SIGTERM or SIGINT asks the run to stop at its next safe point, and a second one ends
  // it at once.
  let signals = 0;
  const onSignal = (signal) => {
    signals++;
    if (signals > 1) {
      exitNow(`Received ${signal} again`);
      return;
    }
    report(
      `Received ${signal}, so the run will stop at its next safe point. Send it again to stop at once.`
    );
    requestStop(`it received ${signal}`);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // The time limit, which ends a run that is stuck as well as one that is slow.
  let hardExitTimer = null;
  const watchdog = setTimeout(() => {
    report(
      `The run has taken longer than ${maxRunSeconds}s (IMPORTER_MAX_RUN_SECONDS), so it will stop at its next safe point.`
    );
    requestStop(`it took longer than ${maxRunSeconds}s`);
    hardExitTimer = setTimeout(
      () => exitNow(`The run did not stop within ${HARD_EXIT_DELAY / 1000}s of its time limit`),
      HARD_EXIT_DELAY
    );
    hardExitTimer.unref();
  }, maxRunSeconds * 1000);
  // Neither timer may keep the process running.
  watchdog.unref();

  try {
    try {
      await time('waitForDatabase', () => waitForDatabase());
    } catch (err) {
      if (err instanceof RunStopped) {
        console.log(err.message);
        return end(EXIT_CODES.INTERRUPTED, `Stopped, as ${err.reason}`);
      }
      return end(
        await failBeforeLock(
          'The CBL update run failed, as it could not reach the database: ',
          err
        ),
        `Could not reach the database: ${describeError(err)}`
      );
    }

    // Take the lock before anything else is posted to Discord, so a run that is skipped as another
    // run holds it posts nothing, unless the importer is stale.
    try {
      lock = await time('takeRunLock', () =>
        takeRunLock({
          onLost: (reason) => {
            report(
              `The run lost its run lock (${reason}), so it will stop at its next safe point.`
            );
            requestStop(LOCK_LOST);
          }
        })
      );
    } catch (err) {
      return end(await failBeforeLock('The CBL update run failed: ', err), describeError(err));
    }
    if (!lock) {
      console.log('Skipped this CBL update run, as another run holds the run lock.');
      // A run that holds the lock for too long, e.g. as it is stuck, would otherwise make every
      // later start skip without a word. The check needs no run lock, and an alert is sent before
      // the run ends.
      if (await checkStaleness({ cadenceSeconds, skipped: true, startedAt: record.startedAt }))
        await flushLogs();
      return end(EXIT_CODES.SKIPPED, 'Another run holds the run lock');
    }
    setRunLock(lock);
    postStatus();

    let exitCode = EXIT_CODES.FAILED;
    let reason;
    try {
      Logger.verbose(
        'Core',
        2,
        `Starting new CBL Update run (commit ${record.gitSha}, time limit ${maxRunSeconds}s, cadence ${cadenceSeconds}s)...`
      );
      await time('connect', connect);

      stopIfRequested();
      // Each migration is recorded as it is applied, as a later one may fail.
      const migrations = await time('migrate', () =>
        migrate({
          onApplied: (id) => {
            record.migrations.push(id);
            showStatus();
          }
        })
      );
      // The importer's tables are there now, with the last run's status message.
      checkLastStatus();
      logMigrations(migrations);

      await current.runSteps({ cadenceSeconds });

      exitCode = EXIT_CODES.FINISHED;
      console.log(
        `Finished All Tasks. Complete CBL run Took ${(
          (Date.now() - record.startedAt) /
          1000
        ).toFixed(2)}s. Garbage Collection Completed.`
      );
    } catch (err) {
      if (err instanceof RunStopped) {
        Logger.important('Core', err.message);
        exitCode = err.reason === LOCK_LOST ? EXIT_CODES.FAILED : EXIT_CODES.INTERRUPTED;
        reason = `Stopped, as ${err.reason}`;
      } else {
        Logger.important('Core', 'The CBL update run failed: ', err);
        reason = describeError(err);
      }
    }

    return await finish(exitCode, reason);
  } finally {
    endLeftWaiting = null;
    clearTimeout(watchdog);
    clearTimeout(hardExitTimer);
    clearTimeout(statusTimer);
    setProgressListener(null);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

// Print which of the importer's migrations a run applied, and which the database has from a newer
// version, if any.
export function logMigrations(migrations) {
  if (migrations.applied.length > 0)
    Logger.verbose(
      'Core',
      2,
      `Applied the importer's migrations ${migrations.applied.join(', ')}.`
    );
  if (migrations.unknown.length > 0)
    Logger.verbose(
      'Core',
      2,
      `The database also has importer migrations from a newer version, which are left as they are: ${migrations.unknown.join(', ')}.`
    );
}
