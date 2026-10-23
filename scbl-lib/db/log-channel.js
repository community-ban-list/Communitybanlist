import describeError from '../utils/describe-error.js';
import Logger from '../utils/logger.js';
import isNewerMessage, { isMessageID, newerMessage } from '../utils/message-id.js';
import sequelize, { QueryTypes } from './sequelize.js';

// The newest message that CBL's services have posted to the log channel (DISCORD_LOG_WEBHOOK),
// which the web server, the bot and the importer share, so the importer service can keep its
// status message below every other (see ban-importer/src/loop.js). Each service's logger tells the
// service of every message it posts (see Logger.setPostListener), and the service writes the
// newest to one row of the importer's ImporterState table, lastLogMessage, which only ever moves on
// to a newer message, whichever service writes it.
//
// Writing it is best effort, and never holds up or fails logging, nor the service: it is done in
// the background, at most once every 5 seconds, so a burst of lines costs a write as it starts and
// one more for its newest message, and one write at a time, so it never uses more than one of the
// service's database connections. A write that fails, e.g. as the database is down, or as the
// importer has not made its tables yet in a new database, is tried again a minute later, with the
// newest message by then, and warned about in the console, once until a write works again. It
// never logs to the log channel, as that would post another message.

// The ImporterState row, which holds { messageId, service }.
export const LAST_LOG_MESSAGE = 'lastLogMessage';

// A service writes the newest message it posted at most this often, and after a write that failed,
// tries again this long after.
const WRITE_INTERVAL = 5 * 1000;
const RETRY_DELAY = 60 * 1000;

// MySQL's error number for a table that does not exist.
const NO_SUCH_TABLE = 1146;

// Whether the row holds an older message than :messageId, or none: the IDs are compared as the
// 64-bit numbers they are, as text compares 9 as newer than 10. A row that holds something else,
// e.g. after an edit by hand, counts as holding none, rather than failing every write, as MySQL's
// strict mode makes a CAST of something that is not a number fail.
const STORED = `JSON_UNQUOTE(JSON_EXTRACT(ImporterState.value, '$.messageId'))`;
const NEWER = `CAST(:messageId AS UNSIGNED) > IF(${STORED} REGEXP '^[0-9]{1,19}$', CAST(${STORED} AS UNSIGNED), 0)`;

// Write the row in one statement, as two services may write it at once, and only when it does not
// hold a newer message already, e.g. one that another service posted since, or a write that came
// later. updatedAt is set first, as it is compared with the row's value as it was, which value's
// own assignment then changes.
const SAVE = `INSERT INTO ImporterState (name, value, updatedAt)
  VALUES (:name, JSON_OBJECT('messageId', :messageId, 'service', :service), UTC_TIMESTAMP(3)) AS new
  ON DUPLICATE KEY UPDATE
    updatedAt = IF(${NEWER}, new.updatedAt, ImporterState.updatedAt),
    value = IF(${NEWER}, new.value, ImporterState.value)`;

const READ = `SELECT JSON_UNQUOTE(JSON_EXTRACT(value, '$.messageId')) AS messageId
  FROM ImporterState WHERE name = :name`;

// Whether the importer's tables do not exist yet, as no importer has applied its migrations.
function isMissingTable(err) {
  return (err?.original ?? err?.parent)?.errno === NO_SUCH_TABLE;
}

// Write that the message with the ID given, which service posted, is the newest in the log
// channel, unless the row has a newer one already.
export async function saveLogMessage(messageId, service) {
  if (!isMessageID(messageId)) throw new Error('Not a Discord message ID');
  await sequelize.query(SAVE, {
    replacements: { name: LAST_LOG_MESSAGE, messageId, service: String(service) }
  });
}

// The ID of the newest message in the log channel that CBL's services have written, or null when
// none has been, also when the importer has not made its tables yet. Fails as the database does
// otherwise.
export async function readLogMessage() {
  try {
    const [row] = await sequelize.query(READ, {
      replacements: { name: LAST_LOG_MESSAGE },
      type: QueryTypes.SELECT
    });
    return isMessageID(row?.messageId) ? row.messageId : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

// The recorder of this process, once recordLogMessages has started it.
let recorder = null;

// Write the newest message this process posts to the log channel to lastLogMessage, from now on,
// as service, e.g. 'web', which the row names. Each service's index.js starts it once, as it
// starts. Returns the recorder: record(id) notes a message posted, which the logger calls, flush()
// writes the newest message not written yet at once (see flushLogMessages), and stop() stops it
// (see stopRecordingLogMessages). interval and retryDelay change how often it writes, for tests.
export function recordLogMessages(
  service,
  { interval = WRITE_INTERVAL, retryDelay = RETRY_DELAY } = {}
) {
  recorder?.stop();
  // The newest message posted and not written yet, the newest written, the write under way, as a
  // promise that never fails, the timer for the next write, when the next may start, and whether
  // writes have been failing, since they were last warned about.
  let pending = null;
  let written = null;
  let writing = null;
  let timer = null;
  let notBefore = 0;
  let failing = false;
  let stopped = false;

  const start = () => {
    const messageId = pending;
    pending = null;
    writing = (async () => {
      try {
        await saveLogMessage(messageId, service);
        written = newerMessage(messageId, written);
        notBefore = Date.now() + interval;
        if (failing)
          console.log('Recorded the newest message in the Discord log in the database again.');
        failing = false;
      } catch (err) {
        // The newest message by then is written once the next write is due.
        if (!isNewerMessage(pending, messageId)) pending = messageId;
        notBefore = Date.now() + retryDelay;
        if (!failing)
          console.warn(
            isMissingTable(err)
              ? `Could not record the newest message in the Discord log in the database, as the importer has not made its tables yet, so it is tried again every ${retryDelay / 1000}s.`
              : `Warning: could not record the newest message in the Discord log in the database, so it is tried again every ${retryDelay / 1000}s: ${describeError(err)}`
          );
        failing = true;
      } finally {
        writing = null;
        schedule();
      }
    })();
  };

  // Write the newest message not written yet once the next write may start.
  const schedule = () => {
    if (stopped || writing || timer || pending === null) return;
    const wait = notBefore - Date.now();
    if (wait <= 0) {
      start();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      schedule();
    }, wait);
    // It must not keep the process running.
    timer.unref?.();
  };

  const current = {
    record(messageId) {
      if (stopped || !isNewerMessage(messageId, written) || !isNewerMessage(messageId, pending))
        return;
      pending = messageId;
      schedule();
    },

    async flush() {
      for (;;) {
        if (stopped) return;
        // The write under way may be of an older message, and the one it then starts, of the newest.
        if (writing) {
          await writing;
          continue;
        }
        if (pending === null) return;
        clearTimeout(timer);
        timer = null;
        start();
        await writing;
        return;
      }
    },

    stop() {
      stopped = true;
      pending = null;
      clearTimeout(timer);
      timer = null;
      if (recorder !== current) return;
      recorder = null;
      Logger.setPostListener(null);
    }
  };
  recorder = current;
  Logger.setPostListener((messageId) => current.record(messageId));
  return current;
}

// Write the newest message this process posted and has not written yet now, rather than when it is
// due, waiting first for a write under way, e.g. as the importer service ends, so the next process
// knows of its last lines. Resolves once that write has been tried, or at once with nothing to
// write, and never fails, but waits for the database, so whatever waits for it limits how long.
export function flushLogMessages() {
  return recorder ? recorder.flush() : Promise.resolve();
}

// Write no more, e.g. before a service closes its database connections as it stops.
export function stopRecordingLogMessages() {
  recorder?.stop();
}
