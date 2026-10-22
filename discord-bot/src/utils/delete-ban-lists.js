import { sequelize } from 'scbl-lib/db';
import { Ban, BanList, ExportBanListConfig } from 'scbl-lib/db/models';

import { plural } from './format.js';

// MySQL's error numbers for a deadlock and a lock wait timeout. A transaction that ends in one of
// them, e.g. as the ban importer was writing the same players, is rolled back as a whole, so it can
// be run again, up to DELETE_ATTEMPTS times in all, waiting longer each time.
const LOCK_ERRORS = [1213, 1205];
const DELETE_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // multiplied by the number of the attempt that failed

function isLockConflict(err) {
  return LOCK_ERRORS.includes(err?.original?.errno ?? err?.parent?.errno);
}

// Count the bans on the ban lists and the players they ban.
export async function summariseBanListBans(banListIDs) {
  const where = { banList: banListIDs };
  return {
    bans: await Ban.count({ where }),
    steamUsers: await Ban.count({ where, distinct: true, col: 'steamUser' })
  };
}

// Count what deleting the ban lists would remove, so it can be confirmed first.
export async function summariseBanListDeletion(banListIDs) {
  return {
    ...(await summariseBanListBans(banListIDs)),
    exportBanListConfigs: await ExportBanListConfig.count({ where: { banList: banListIDs } })
  };
}

export function describeBanListDeletion({ bans, steamUsers, exportBanListConfigs = 0 }) {
  const description = `${plural(bans, 'ban')} on ${plural(steamUsers, 'player')}`;
  if (exportBanListConfigs === 0) return description;
  return `${description} and ${plural(exportBanListConfigs, 'export ban list config')}`;
}

// Delete the ban lists' bans in the transaction. The banned Steam users are queued to be updated,
// as the ban importer does when their bans change, so their reputation and export bans are
// recalculated without these bans on the next run.
export async function deleteBansOfBanLists(banListIDs, transaction) {
  await sequelize.query(
    `
      UPDATE SteamUsers SU
      JOIN (
        SELECT DISTINCT steamUser FROM Bans WHERE banList IN (:banListIDs)
      ) B ON SU.id = B.steamUser
      SET
        SU.lastRefreshedExport = NULL,
        SU.lastRefreshedReputationPoints = NULL,
        SU.lastRefreshedReputationRank = NULL
    `,
    { replacements: { banListIDs }, transaction }
  );
  await Ban.destroy({ where: { banList: banListIDs }, transaction });
}

// Delete the ban lists, their bans and the export ban list configs that use them. The organisation
// is deleted too if one is given. The deletion is one transaction, run again if it ends in a
// deadlock or a lock wait timeout, which a ban importer run writing the same players can cause.
// Every statement in it can run again, as a rolled back transaction changed nothing, and the
// organisation is deleted by its ID.
export async function deleteBanLists(banListIDs, organisation = null) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sequelize.transaction(async (transaction) => {
        if (banListIDs.length > 0) {
          // Delete dependent records explicitly rather than relying on the database's cascades.
          await deleteBansOfBanLists(banListIDs, transaction);
          await ExportBanListConfig.destroy({ where: { banList: banListIDs }, transaction });
          await BanList.destroy({ where: { id: banListIDs }, transaction });
        }

        if (organisation) await organisation.destroy({ transaction });
      });
    } catch (err) {
      if (attempt >= DELETE_ATTEMPTS || !isLockConflict(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
}
