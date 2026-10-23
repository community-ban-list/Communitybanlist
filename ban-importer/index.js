import { describeError, stackTrace } from 'scbl-lib/utils';

import Core from './src/core.js';

import BanImporter from './src/ban-importer.js';
import ExportBanManager from './src/export-ban-manager.js';
import { expireBans } from './src/expiry.js';
import runLoop, { readMode } from './src/loop.js';
import run, { EXIT_CODES, leftWaiting } from './src/run.js';
import { updateSteamUserInfo } from './src/steam-profiles.js';

Error.stackTraceLimit = 255;

const TASKS_TO_COMPLETE = {
  IMPORT_BANS: true,
  EXPIRE_BANS: true,
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

const banImporter = new BanImporter();

// A step that counts what it does as it goes, in an object it is given, which the run record keeps,
// also when the step fails or stops part-way. It is also given the run's settings.
function counted(name, work) {
  let counts;
  return { name, run: (settings) => work((counts = {}), settings), counts: () => counts };
}

// The run's steps, in order, each named for the run record, which also keeps the counts a step
// gives. A run that is asked to stop does so between them. A dry run (IMPORTER_DRY_RUN) only
// imports, writing nothing, as every other step writes. Bans whose expiry has passed are marked
// expired after the import, which marks those it fetches, and before the steps that recalculate
// players from whether their bans have expired. The Steam step works out how many profiles to
// refresh from how often runs start.
const steps = [];
const writes = !banImporter.dryRun;
if (TASKS_TO_COMPLETE.IMPORT_BANS)
  steps.push({
    name: 'importBans',
    run: () => banImporter.importBans(),
    counts: () => banImporter.report()
  });
if (TASKS_TO_COMPLETE.EXPIRE_BANS && writes)
  steps.push(counted('expireBans', (counts) => expireBans(counts)));
if (TASKS_TO_COMPLETE.UPDATE_STEAM_USER_INFO && writes)
  steps.push(
    counted('updateSteamUserInfo', (counts, { cadenceSeconds } = {}) =>
      updateSteamUserInfo(counts, { cadenceSeconds })
    )
  );
if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_POINTS && writes)
  steps.push(
    { name: 'clearOrphanedUsers', run: () => Core.clearOrphanedUsers() },
    { name: 'updateReputationPoints', run: () => Core.updateReputationPoints() }
  );
if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_RANK && writes)
  steps.push({ name: 'updateReputationRank', run: () => Core.updateReputationRank() });
if (TASKS_TO_COMPLETE.UPDATE_EXPORT_BANS && writes)
  steps.push(counted('updateExportBans', (counts) => ExportBanManager.updateExportBans(counts)));
if (TASKS_TO_COMPLETE.EXPORT_EXPORT_BANS && writes)
  steps.push(counted('exportExportBans', (counts) => Core.exportExportBans(counts)));

// Set once the run has ended, as the importer exits with the run's code.
let ended = false;
// Set once the run is being ended as left waiting.
let leaving = false;

// Node exits by itself, with code 0, once nothing is left to wait for. Before the run has ended,
// that means the run was left waiting for something that can never happen, such as an answer on a
// connection that is gone, so the run failed. It is ended as failed, with its JSON line and its
// record, and the importer exits 1. Should that be left waiting too, Node exits 1 by itself.
process.on('beforeExit', () => {
  if (ended || leaving) return;
  leaving = true;
  process.exitCode = EXIT_CODES.FAILED;
  leftWaiting()
    .catch((err) => {
      console.error(`The CBL update run failed: ${describeError(err)}${stackTrace(err)}`);
      return EXIT_CODES.FAILED;
    })
    .then((exitCode) => process.exit(exitCode));
});

// IMPORTER_MODE=once, the default, runs the steps once and exits with the run's code: 0 finished, 1
// failed, 3 stopped part-way by a signal or the time limit, or 75 skipped as another run is active.
// A run that finished exits 1 after an unhandled rejection, as the run's own exit code and record
// already say. IMPORTER_MODE=loop runs them as the importer service, a cycle at a time, until it is
// stopped, and exits with the service's code (see loop.js). Any other value starts nothing.
const mode = readMode(process.env.IMPORTER_MODE);
if (mode.error) {
  console.error(mode.error);
  ended = true;
  process.exit(EXIT_CODES.FAILED);
} else {
  (mode.loop ? runLoop : run)(steps)
    .catch((err) => {
      console.error(`The CBL update run failed: ${describeError(err)}${stackTrace(err)}`);
      return EXIT_CODES.FAILED;
    })
    .then((exitCode) => {
      ended = true;
      process.exit(exitCode || process.exitCode);
    });
}
