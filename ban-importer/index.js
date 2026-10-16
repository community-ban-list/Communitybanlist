import { describeError, stackTrace } from 'scbl-lib/utils';

import Core from './src/core.js';

import BanImporter from './src/ban-importer.js';
import ExportBanManager from './src/export-ban-manager.js';
import run, { EXIT_CODES } from './src/run.js';

Error.stackTraceLimit = 255;

const TASKS_TO_COMPLETE = {
  IMPORT_BANS: true,
  UPDATE_STEAM_USER_INFO: true, // TODO: This is causing random hangs; Try ading more debug code until we can find out what causes it.
  UPDATE_REPUTATION_POINTS: true,
  UPDATE_REPUTATION_RANK: true,
  UPDATE_EXPORT_BANS: true,
  EXPORT_EXPORT_BANS: true
};

// A promise that fails with nothing to handle it must not stop the run part-way, but the run is
// then reported as failed. Only the error's name, message and where it was thrown are printed, as
// errors from API clients also hold their keys.
process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled promise rejection: ${describeError(reason)}${stackTrace(reason)}`);
  process.exitCode = EXIT_CODES.FAILED;
});

// The run's steps, in order. A run that is asked to stop does so between them.
const steps = [];
if (TASKS_TO_COMPLETE.IMPORT_BANS) steps.push(() => new BanImporter().importBans());
if (TASKS_TO_COMPLETE.UPDATE_STEAM_USER_INFO) steps.push(() => Core.updateSteamUserInfo());
if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_POINTS)
  steps.push(
    () => Core.clearOrphanedUsers(),
    () => Core.updateReputationPoints()
  );
if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_RANK) steps.push(() => Core.updateReputationRank());
if (TASKS_TO_COMPLETE.UPDATE_EXPORT_BANS) steps.push(() => ExportBanManager.updateExportBans());
if (TASKS_TO_COMPLETE.EXPORT_EXPORT_BANS) steps.push(() => Core.exportExportBans());

// Set once the run has ended, as the importer exits with the run's code.
let ended = false;

// Node exits by itself, with code 0, once nothing is left to wait for. Before the run has ended,
// that means the run was left waiting for something that can never happen, such as an answer on a
// connection that is gone, so the run failed.
process.on('beforeExit', () => {
  if (ended) return;
  console.error(
    'The CBL update run failed, as it was left waiting for something that can never happen.'
  );
  process.exit(EXIT_CODES.FAILED);
});

// Exit with the run's code: 0 finished, 1 failed, 3 stopped part-way by a signal or the time limit,
// or 75 skipped as another run is active. A run that finished exits 1 after an unhandled rejection.
run(steps)
  .catch((err) => {
    console.error(`The CBL update run failed: ${describeError(err)}${stackTrace(err)}`);
    return EXIT_CODES.FAILED;
  })
  .then((exitCode) => {
    ended = true;
    process.exit(exitCode || process.exitCode);
  });
