import { sequelize } from 'scbl-lib/db';
import { ExportBan, SteamUser } from 'scbl-lib/db/models';
import { Op, QueryTypes, Transaction } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

const UPDATE_BATCH_SIZE = process.env.UPDATE_EXPORT_BANS_BATCH_SIZE || 100;

export default class ExportBanManager {
  static async updateExportBans() {
    Logger.verbose('ExportBanManager', 1, 'Fetching Steam users to update...');
    const profileStartTime = Date.now();
    const users = await SteamUser.findAll({ attributes: ['id'] });
    Logger.verbose(
      'ExportBanManager',
      1,
      `Fetched ${users.length} Steam users to update after ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
    let currentRunTime = profileStartTime;
    while (users.length > 0) {
      currentRunTime = Date.now();
      const batch = users.splice(0, Math.min(UPDATE_BATCH_SIZE, users.length));
      Logger.verbose(
        'ExportBanManager',
        1,
        `Updating batch of ${batch.length} Steam users' export bans (${
          users.length
        } remaining)... Batch time: ${((Date.now() - currentRunTime) / 1000).toFixed(2)}s`
      );

      // Generate the export bans.
      const generatedBans = await sequelize.transaction(
        {
          isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE
        },
        async (t) => {
          return sequelize.query(
            `
              SELECT
                CONCAT(steamUser, ",", exportBanList) AS "id",
                "TO_BE_CREATED" AS "status",
                steamUser,
                exportBanList
              FROM (
                SELECT
                  EBL.id AS "exportBanList",
                  B.steamUser AS "steamUser",
                  EBL.threshold AS "threshold",
                  IF (
                    SUM(
                      IF(
                        B.expired,
                        0,
                        IFNULL(
                          EBLC.activePoints,
                          EBL.defaultActivePoints
                        )
                      )
                    ) > 0,
                    3,
                    0
                  ) AS "activePoints",
                  SUM(
                    IF(
                      B.expired,
                      IFNULL(
                        EBLC.expiredPoints,
                        EBL.defaultExpiredPoints
                      ),
                      0
                    )
                  ) AS "expiredPoints"
                FROM Bans B
                CROSS JOIN ExportBanLists EBL
                LEFT JOIN ExportBanListConfigs EBLC ON EBL.id = EBLC.exportBanList AND B.banList = EBLC.banList
                WHERE (
                  EBL.maxBanAge = 0 OR
                  EBL.maxBanAge >= DATEDIFF(NOW(), B.created)
                ) AND B.steamUser IN (?)
                GROUP BY EBL.id, B.steamUser, B.banList
              ) A
              GROUP BY exportBanList, steamUser
              HAVING SUM(activePoints) + SUM(expiredPoints) >= MAX(threshold)
            `,
            {
              type: QueryTypes.SELECT,
              transaction: t,
              replacements: [batch.map((steamUser) => steamUser.id)]
            }
          );
        }
      );

      Logger.verbose(
        'ExportBanManager',
        2,
        `Saving ${generatedBans.length} export bans... Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Create new bans.
      await ExportBan.bulkCreate(generatedBans, { ignoreDuplicates: true });
      Logger.verbose(
        'ExportBanManager',
        2,
        `Step Create ${generatedBans.length} new bans done. Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Cancel deletion of bans that should still be present.
      await ExportBan.update(
        {
          status: 'CREATED'
        },
        {
          where: {
            id: {
              [Op.in]: generatedBans.map((generatedBan) => generatedBan.id)
            },
            status: 'TO_BE_DELETED'
          }
        }
      );
      Logger.verbose(
        'ExportBanManager',
        2,
        `Step Cancel deletion of bans that should still be present done. Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Queue existing bans to be deleted.
      await ExportBan.update(
        {
          status: 'TO_BE_DELETED'
        },
        {
          where: {
            id: {
              [Op.notIn]: generatedBans.map((generatedBan) => generatedBan.id)
            },
            steamUser: {
              [Op.in]: batch.map((steamUser) => steamUser.id)
            },
            status: 'CREATED'
          }
        }
      );
      Logger.verbose(
        'ExportBanManager',
        2,
        `Step Queue existing bans to be deleted done. Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Delete bans that have not yet been created.
      await ExportBan.destroy({
        where: {
          id: {
            [Op.notIn]: generatedBans.map((generatedBan) => generatedBan.id)
          },
          steamUser: {
            [Op.in]: batch.map((steamUser) => steamUser.id)
          },
          status: 'TO_BE_CREATED'
        }
      });
      Logger.verbose(
        'ExportBanManager',
        2,
        `Step Delete bans that have not yet been created done. Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Mark Steam users as updated.
      await SteamUser.update(
        {
          lastRefreshedExport: Date.now()
        },
        {
          where: {
            id: {
              [Op.in]: batch.map((steamUser) => steamUser.id)
            }
          }
        }
      );
      Logger.verbose(
        'ExportBanManager',
        2,
        `Finished Updating batch. Overall batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );
    }
    Logger.verbose(
      'ExportBanManager',
      1,
      `Finished updating ExportBans. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }
}
