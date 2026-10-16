import { sequelize } from 'scbl-lib/db';
import { Ban, BanList, ExportBanListConfig } from 'scbl-lib/db/models';

import { plural } from './format.js';

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
// is deleted too if one is given.
export async function deleteBanLists(banListIDs, organisation = null) {
  await sequelize.transaction(async (transaction) => {
    if (banListIDs.length > 0) {
      // Delete dependent records explicitly rather than relying on the database's cascades.
      await deleteBansOfBanLists(banListIDs, transaction);
      await ExportBanListConfig.destroy({ where: { banList: banListIDs }, transaction });
      await BanList.destroy({ where: { id: banListIDs }, transaction });
    }

    if (organisation) await organisation.destroy({ transaction });
  });
}
