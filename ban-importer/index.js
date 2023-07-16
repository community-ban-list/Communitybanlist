import { connect, disconnect } from 'scbl-lib/db';

import Core from './src/core.js';

import BanImporter from './src/ban-importer.js';
import ExportBanManager from './src/export-ban-manager.js';

const TASKS_TO_COMPLETE = {
  IMPORT_BANS: false,
  UPDATE_STEAM_USER_INFO: true, // TODO: This is causing failures; temporarily disabled.
  UPDATE_REPUTATION_POINTS: false,
  UPDATE_REPUTATION_RANK: false,
  UPDATE_EXPORT_BANS: false,
  EXPORT_EXPORT_BANS: false
};

async function main() {
  await connect();

  if (TASKS_TO_COMPLETE.IMPORT_BANS) {
    const importer = new BanImporter();
    await importer.importBans();
  }

  if (TASKS_TO_COMPLETE.UPDATE_STEAM_USER_INFO) await Core.updateSteamUserInfo();
  if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_POINTS) await Core.updateReputationPoints();
  if (TASKS_TO_COMPLETE.UPDATE_REPUTATION_RANK) await Core.updateReputationRank();
  if (TASKS_TO_COMPLETE.UPDATE_EXPORT_BANS) await ExportBanManager.updateExportBans();
  if (TASKS_TO_COMPLETE.EXPORT_EXPORT_BANS) await Core.exportExportBans();

  await disconnect();
}

main()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });
