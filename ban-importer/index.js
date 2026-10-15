import { connect, disconnect } from 'scbl-lib/db';
import { describeError, Logger, stackTrace } from 'scbl-lib/utils';

import Core from './src/core.js';

import BanImporter from './src/ban-importer.js';
import ExportBanManager from './src/export-ban-manager.js';

Error.stackTraceLimit = 255;

const TASKS_TO_COMPLETE = {
  IMPORT_BANS: true,
  UPDATE_STEAM_USER_INFO: true, // TODO: This is causing random hangs; Try ading more debug code until we can find out what causes it.
  UPDATE_REPUTATION_POINTS: true,
  UPDATE_REPUTATION_RANK: true,
  UPDATE_EXPORT_BANS: true,
  EXPORT_EXPORT_BANS: true
};

// How long to wait at the end of a run for Discord log messages still waiting to be sent.
const LOG_FLUSH_TIMEOUT = 30 * 1000;

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Send the progress bars' latest values and wait for queued Discord log messages, but for no longer
// than LOG_FLUSH_TIMEOUT, so a slow or unreachable Discord cannot keep the run from ending.
async function flushLogs() {
  Logger.flush();
  const deadline = Date.now() + LOG_FLUSH_TIMEOUT;
  while (Date.now() < deadline && Object.values(Logger.getLogQueue()).some((count) => count > 0))
    await doSleep(500);
}

// A promise that fails with nothing to handle it must not stop the run part-way, but the run is
// then reported as failed. Only the error's name, message and where it was thrown are printed, as
// errors from API clients also hold their keys.
process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled promise rejection: ${describeError(reason)}${stackTrace(reason)}`);
  process.exitCode = 1;
});

// The run's start, summary and failure are logged as important, so they reach the log channel even
// when the run's other messages fill its queue.
async function main() {
  const profileStartTime = Date.now();
  Logger.important('Core', `<@276137824460210178> Starting new CBL Update run...`);
  await connect();

  if (TASKS_TO_COMPLETE.IMPORT_BANS) {
    const importer = new BanImporter();
    await importer.importBans();
  }

  if (TASKS_TO_COMPLETE.UPDATE_STEAM_USER_INFO) await Core.updateSteamUserInfo();
  if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_POINTS) await Core.clearOrphanedUsers();
  if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_POINTS) await Core.updateReputationPoints();
  if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_RANK) await Core.updateReputationRank();
  if (TASKS_TO_COMPLETE.UPDATE_EXPORT_BANS) await ExportBanManager.updateExportBans();
  if (TASKS_TO_COMPLETE.EXPORT_EXPORT_BANS) await Core.exportExportBans();

  await disconnect();
  Logger.important(
    'Core',
    `Finished All Tasks. Complete CBL run Took ${((Date.now() - profileStartTime) / 1000).toFixed(
      2
    )}s. Garbage Collection Completed.`
  );
  console.log(
    `Finished All Tasks. Complete CBL run Took ${((Date.now() - profileStartTime) / 1000).toFixed(
      2
    )}s. Garbage Collection Completed.`
  );
}

main()
  .then(() => console.log(`Done!`))
  .catch((error) => {
    process.exitCode = 1;
    Logger.important('Core', 'The CBL update run failed: ', error);
  })
  .then(flushLogs)
  // Exit with process.exitCode, which is 1 if anything above failed.
  .finally(() => process.exit());
