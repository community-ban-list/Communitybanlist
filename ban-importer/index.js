import { connect, disconnect } from 'scbl-lib/db';
import { Logger } from 'scbl-lib/utils';

import Core from './src/core.js';

import BanImporter from './src/ban-importer.js';
import ExportBanManager from './src/export-ban-manager.js';

const TASKS_TO_COMPLETE = {
  IMPORT_BANS: false,
  UPDATE_STEAM_USER_INFO: true, // TODO: This is causing random hangs; Try ading more debug code until we can find out what causes it.
  UPDATE_REPUTATION_POINTS: true,
  UPDATE_REPUTATION_RANK: true,
  UPDATE_EXPORT_BANS: false,
  EXPORT_EXPORT_BANS: false
};

async function main() {
  const profileStartTime = Date.now();
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
  Logger.verbose(
    'Core',
    1,
    `Finished All Tasks. Complete CBL run Took ${((Date.now() - profileStartTime) / 1000).toFixed(
      2
    )}s`
  );
  console.log(
    `Finished All Tasks. Complete CBL run Took ${((Date.now() - profileStartTime) / 1000).toFixed(
      2
    )}s`
  );
}

main()
  .then(() => {
    console.log(`Done!`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });
