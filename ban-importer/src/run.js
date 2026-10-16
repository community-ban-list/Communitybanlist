import { connect, disconnect, sequelize, takeRunLock } from 'scbl-lib/db';
import { isDatabaseUnavailable } from 'scbl-lib/db/sequelize';
import { describeError, Logger } from 'scbl-lib/utils';

import {
  LOCK_LOST,
  requestStop,
  RunStopped,
  setRunLock,
  stopIfRequested,
  stopRequest
} from './run-control.js';

// What the importer's exit code tells the script that starts it.
export const EXIT_CODES = {
  FINISHED: 0,
  FAILED: 1,
  // Stopped part-way by SIGTERM, SIGINT or the time limit.
  INTERRUPTED: 3,
  // Skipped, as another run holds the run lock. 75 is EX_TEMPFAIL: try again later.
  SKIPPED: 75
};

// A run that takes longer than this stops at its next safe point, so it ends cleanly before the
// next run, started 6 hours after it, has to stop it. IMPORTER_MAX_RUN_SECONDS changes it.
const DEFAULT_MAX_RUN_SECONDS = 5 * 60 * 60;
// The longest time limit a timer can wait for, about 24 days.
const MAX_RUN_SECONDS_LIMIT = Math.floor((2 ** 31 - 1) / 1000);

// A run that has not ended this long after reaching its time limit exits at once.
const HARD_EXIT_DELAY = 60 * 1000;

// The database may be restarting when the run starts, so it is tried up to 5 more times, waiting
// 5, 10, 20, 40 and then 80 seconds.
const DATABASE_RETRIES = 5;
const DATABASE_RETRY_DELAY = 5 * 1000;

// How long to wait at the end of a run for Discord log messages still waiting to be sent.
const LOG_FLUSH_TIMEOUT = 30 * 1000;

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait, but no longer than until the run is asked to stop.
function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopRequest.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Send the progress bars' latest values and wait for queued Discord log messages, but for no longer
// than LOG_FLUSH_TIMEOUT, so a slow or unreachable Discord cannot keep the run from ending.
async function flushLogs() {
  Logger.flush();
  const deadline = Date.now() + LOG_FLUSH_TIMEOUT;
  while (Date.now() < deadline && Object.values(Logger.getLogQueue()).some((count) => count > 0))
    await doSleep(500);
}

function readMaxRunSeconds() {
  const value = process.env.IMPORTER_MAX_RUN_SECONDS;
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_RUN_SECONDS;

  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds > 0 && seconds <= MAX_RUN_SECONDS_LIMIT) return seconds;
  console.warn(
    `Warning: IMPORTER_MAX_RUN_SECONDS must be a whole number from 1 to ${MAX_RUN_SECONDS_LIMIT}, not "${value}", so the default of ${DEFAULT_MAX_RUN_SECONDS} is used.`
  );
  return DEFAULT_MAX_RUN_SECONDS;
}

// Wait for the database to answer, as the script that starts the importer may have just restarted
// it.
async function waitForDatabase() {
  for (let retry = 1; ; retry++) {
    try {
      await sequelize.authenticate();
      return;
    } catch (err) {
      if (!isDatabaseUnavailable(err) || retry > DATABASE_RETRIES) throw err;

      const delay = DATABASE_RETRY_DELAY * 2 ** (retry - 1);
      console.log(
        `The database is not available (${describeError(err)}). Trying again in ${delay / 1000}s (retry ${retry} of ${DATABASE_RETRIES}).`
      );
      await pause(delay);
      stopIfRequested();
    }
  }
}

// Run the importer's steps once, holding the run lock, and resolve with the exit code. Each step is
// a function, and a run that is asked to stop does so between them.
//
// The lines about the whole run, such as its start, why it is stopping, how it ended or why it
// failed, are logged as important, so they reach the log channel even when the run's other messages
// fill its queue.
export default async function run(steps) {
  const maxRunSeconds = readMaxRunSeconds();
  let lock = null;

  // Report on the run: in the Discord log once the run holds the lock, and before that only in the
  // console, so a run that is stopped before it starts posts nothing.
  const report = (message) => {
    if (lock) Logger.important('Core', message);
    else console.log(message);
  };

  // Post why the run failed before it held the lock, and wait for the line to be sent. Only a run
  // that is skipped must post nothing, and a failed run must be seen.
  const failBeforeLock = async (message, err) => {
    Logger.important('Core', message, err);
    await flushLogs();
    return EXIT_CODES.FAILED;
  };

  // Exit straight away. Closing the lock's connection frees the lock.
  const exitNow = (why) => {
    console.error(`${why}, so the run is ending now.`);
    if (lock) lock.destroy();
    process.exit(EXIT_CODES.INTERRUPTED);
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
      await waitForDatabase();
    } catch (err) {
      if (err instanceof RunStopped) {
        console.log(err.message);
        return EXIT_CODES.INTERRUPTED;
      }
      return await failBeforeLock(
        'The CBL update run failed, as it could not reach the database: ',
        err
      );
    }

    // Take the lock before anything else is posted to Discord, so a run that is skipped as another
    // run holds it posts nothing.
    try {
      lock = await takeRunLock({
        onLost: (reason) => {
          report(`The run lost its run lock (${reason}), so it will stop at its next safe point.`);
          requestStop(LOCK_LOST);
        }
      });
    } catch (err) {
      return await failBeforeLock('The CBL update run failed: ', err);
    }
    if (!lock) {
      console.log('Skipped this CBL update run, as another run holds the run lock.');
      return EXIT_CODES.SKIPPED;
    }
    setRunLock(lock);

    try {
      const profileStartTime = Date.now();
      Logger.important(
        'Core',
        `Starting new CBL Update run (commit ${process.env.GIT_SHA || 'unknown'}, time limit ${maxRunSeconds}s)...`
      );
      await connect();

      for (const step of steps) {
        stopIfRequested();
        await step();
      }

      await disconnect();
      const message = `Finished All Tasks. Complete CBL run Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s. Garbage Collection Completed.`;
      Logger.important('Core', message);
      console.log(message);
      return EXIT_CODES.FINISHED;
    } catch (err) {
      if (err instanceof RunStopped) {
        Logger.important('Core', err.message);
        return err.reason === LOCK_LOST ? EXIT_CODES.FAILED : EXIT_CODES.INTERRUPTED;
      }
      Logger.important('Core', 'The CBL update run failed: ', err);
      return EXIT_CODES.FAILED;
    } finally {
      try {
        await flushLogs();
      } finally {
        await lock.release();
      }
    }
  } finally {
    clearTimeout(watchdog);
    clearTimeout(hardExitTimer);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}
