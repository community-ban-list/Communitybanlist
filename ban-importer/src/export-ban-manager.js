import { sequelize } from 'scbl-lib/db';
import { ExportBan, SteamUser } from 'scbl-lib/db/models';
import { Op, QueryTypes, Transaction } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import { stopIfRequested } from './run-control.js';

// Changed Below on the 14900k. Will need to monitor to make sure issues do not arise.
// const UPDATE_BATCH_SIZE = process.env.UPDATE_EXPORT_BANS_BATCH_SIZE || 100;
const UPDATE_BATCH_SIZE = process.env.UPDATE_EXPORT_BANS_BATCH_SIZE || 250;

export default class ExportBanManager {
  static async updateExportBans() {
    Logger.verbose('ExportBanManager', 2, 'Fetching Steam users to update...');
    const profileStartTime = Date.now();
    const users = await SteamUser.findAll({ attributes: ['id'] });
    Logger.verbose(
      'ExportBanManager',
      2,
      `Fetched ${users.length} Steam users to update. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
    let currentRunTime = profileStartTime;

    const startingLength = users.length;
    const myProgressBar = Logger.discordProgressBar(
      'Core',
      `Updating ${startingLength} ExportBans...`,
      null,
      0,
      startingLength,
      0
    );
    while (users.length > 0) {
      // A run that is asked to stop does so between batches.
      stopIfRequested();
      currentRunTime = Date.now();
      const batch = users.splice(0, Math.min(UPDATE_BATCH_SIZE, users.length));
      Logger.verbose(
        'ExportBanManager',
        2,
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
                  MAX(
                    IF(
                      B.expired,
                      0,
                      IFNULL(
                        EBLC.activePoints,
                        EBL.defaultActivePoints
                      )
                    )
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

      // Cancel deletion of bans that should still be present. Those on BattleMetrics lists with no
      // BattleMetrics ban, or with one that may or may not have been made ('pending'), are created
      // again rather than marked as created, so they are not left off BattleMetrics.
      if (generatedBans.length > 0)
        await sequelize.query(
          `
            UPDATE ExportBans EB
            JOIN ExportBanLists EBL ON EBL.id = EB.exportBanList
            SET EB.status = 'TO_BE_CREATED'
            WHERE EB.id IN (?) AND EB.status = 'TO_BE_DELETED' AND EBL.type = 'battlemetrics'
              AND (EB.battlemetricsID IS NULL OR EB.battlemetricsID = 'pending')
          `,
          {
            type: QueryTypes.BULKUPDATE,
            replacements: [generatedBans.map((generatedBan) => generatedBan.id)]
          }
        );
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

      // Delete bans that have not yet been created. Those whose BattleMetrics ban was made, or may
      // have been ('pending'), are queued to be deleted instead, so the ban is found and deleted
      // too. A claim keeps its time, which says how long ago its ban may have been made.
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
            status: 'TO_BE_CREATED',
            battlemetricsID: { [Op.not]: null }
          },
          silent: true
        }
      );
      await ExportBan.destroy({
        where: {
          id: {
            [Op.notIn]: generatedBans.map((generatedBan) => generatedBan.id)
          },
          steamUser: {
            [Op.in]: batch.map((steamUser) => steamUser.id)
          },
          status: 'TO_BE_CREATED',
          battlemetricsID: null
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
        `Finished Updating batch. (${users.length} remaining) Overall batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );
      Logger.discordProgressBar(
        'Core',
        `Updating ${startingLength} ExportBans...`,
        myProgressBar,
        0,
        startingLength,
        startingLength - users.length
      );
    }
    Logger.verbose(
      'ExportBanManager',
      2,
      `Finished updating ExportBans. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }
}
