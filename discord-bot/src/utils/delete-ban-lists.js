import { sequelize } from 'scbl-lib/db';
import { Ban, BanList, ExportBanListConfig } from 'scbl-lib/db/models';

import { plural } from './format.js';

// Count what deleting the ban lists would remove, so it can be confirmed first.
export async function summariseBanListDeletion(banListIDs) {
  const where = { banList: banListIDs };
  return {
    bans: await Ban.count({ where }),
    steamUsers: await Ban.count({ where, distinct: true, col: 'steamUser' }),
    exportBanListConfigs: await ExportBanListConfig.count({ where })
  };
}

export function describeBanListDeletion({ bans, steamUsers, exportBanListConfigs }) {
  const description = `${plural(bans, 'ban')} on ${plural(steamUsers, 'player')}`;
  if (exportBanListConfigs === 0) return description;
  return `${description} and ${plural(exportBanListConfigs, 'export ban list config')}`;
}

// Delete the ban lists, their bans and the export ban list configs that use them. The organisation
// is deleted too if one is given.
export async function deleteBanLists(banListIDs, organisation = null) {
  await sequelize.transaction(async (transaction) => {
    if (banListIDs.length > 0) {
      // Queue the banned Steam users to be updated, as the ban importer does when their bans change,
      // so their reputation and export bans are recalculated without these bans on the next run.
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

      // Delete dependent records explicitly rather than relying on the database's cascades.
      await Ban.destroy({ where: { banList: banListIDs }, transaction });
      await ExportBanListConfig.destroy({ where: { banList: banListIDs }, transaction });
      await BanList.destroy({ where: { id: banListIDs }, transaction });
    }

    if (organisation) await organisation.destroy({ transaction });
  });
}
