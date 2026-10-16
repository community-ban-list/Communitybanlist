import { sequelize } from 'scbl-lib/db';
import { ExportBan, ExportBanList, SteamUser } from 'scbl-lib/db/models';
import { Op, QueryTypes, Transaction } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import { stopIfRequested } from './run-control.js';

// Changed Below on the 14900k. Will need to monitor to make sure issues do not arise.
// const UPDATE_BATCH_SIZE = process.env.UPDATE_EXPORT_BANS_BATCH_SIZE || 100;
const UPDATE_BATCH_SIZE = process.env.UPDATE_EXPORT_BANS_BATCH_SIZE || 250;

// At most this many export bans are written by one statement. MySQL reads a list of IDs as ranges
// of the primary key while it has the memory for them (range_optimizer_max_mem_size, 8 MB by
// default, which holds about 2,200 IDs), and reads the whole table instead for a longer list.
const MAX_ROWS_PER_WRITE = 1000;

// The battlemetricsID of an export ban whose BattleMetrics ban is being made, or may have been made
// (see scbl-lib/db/models/export-ban.js).
const PENDING = 'pending';

// Work out which of a batch's export bans change, and how, from the export bans its players
// qualify for and the export bans they have. Export bans that stay as they are are left out, so a
// batch with nothing to change has nothing to write. listTypes holds each export ban list's type.
function findChanges(generatedBans, exportBans, listTypes) {
  const changes = {
    // Export bans the players qualify for and do not have yet, which are created.
    add: [],
    // Export bans the players qualify for again, whose deletion is cancelled. Those on
    // BattleMetrics lists with no BattleMetrics ban, or with one that may or may not have been made
    // ('pending'), are created again. Those with a BattleMetrics ban, and those on remote lists,
    // are marked as created.
    createAgain: [],
    markCreated: [],
    markRemoteCreated: [],
    // Export bans the players no longer qualify for. Created ones are queued to be deleted, and so
    // are ones not yet created whose BattleMetrics ban was made, or may have been. The others not
    // yet created are deleted.
    queueDeletion: [],
    queueClaimed: [],
    remove: []
  };

  const existing = new Set(exportBans.map((exportBan) => exportBan.id));
  const qualifying = new Set();
  for (const generatedBan of generatedBans) {
    qualifying.add(generatedBan.id);
    if (!existing.has(generatedBan.id)) changes.add.push(generatedBan);
  }

  for (const { id, exportBanList, status, battlemetricsID } of exportBans) {
    if (qualifying.has(id)) {
      // Export bans created or still to be created stay as they are.
      if (status !== 'TO_BE_DELETED') continue;
      if (listTypes.get(exportBanList) !== 'battlemetrics') changes.markRemoteCreated.push(id);
      else if (battlemetricsID === null || battlemetricsID === PENDING)
        changes.createAgain.push(id);
      else changes.markCreated.push(id);
    } else if (status === 'CREATED') {
      changes.queueDeletion.push(id);
    } else if (status === 'TO_BE_CREATED') {
      if (battlemetricsID === null) changes.remove.push(id);
      else changes.queueClaimed.push(id);
    }
    // Export bans already queued to be deleted stay as they are.
  }
  return changes;
}

// Write the items in statements of at most MAX_ROWS_PER_WRITE, and make none when there are none.
async function inStatements(items, write) {
  for (let i = 0; i < items.length; i += MAX_ROWS_PER_WRITE)
    await write(items.slice(i, i + MAX_ROWS_PER_WRITE));
}

// Set the status of the export bans with these IDs. Only export bans that still match the
// conditions, which say what the batch read, are changed, so one that something else changed since
// the read is left as it is, for the next run.
async function setStatus(ids, status, conditions, options = {}) {
  await inStatements(ids, (someIDs) =>
    ExportBan.update({ status }, { where: { id: { [Op.in]: someIDs }, ...conditions }, ...options })
  );
}

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

    // The type of each export ban list, which says how an export ban's deletion is cancelled. It is
    // read once a run, as a list's type never changes, and a list made during the run has no export
    // bans queued to be deleted.
    const listTypes = new Map(
      (await ExportBanList.findAll({ attributes: ['id', 'type'], raw: true })).map(
        ({ id, type }) => [id, type]
      )
    );

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

      // Read the batch's export bans once, by the index on steamUser, and work out which change.
      // Each step below then writes only those, by ID. They used to be found by three statements
      // with id NOT IN (the export bans generated). For a list of up to 1,000 IDs, MySQL weighed
      // up a range on the steamUser index for each player and gap in the list, estimating each by
      // reading the index, and then, unless the list was short, read the whole table anyway: 0.4
      // to 1 second a statement, most of it spent planning.
      const changes = findChanges(
        generatedBans,
        await ExportBan.findAll({
          attributes: ['id', 'exportBanList', 'status', 'battlemetricsID'],
          where: {
            steamUser: {
              [Op.in]: batch.map((steamUser) => steamUser.id)
            }
          },
          raw: true
        }),
        listTypes
      );

      // Create new bans. One created since the read is left as it is.
      await inStatements(changes.add, (someBans) =>
        ExportBan.bulkCreate(someBans, { ignoreDuplicates: true })
      );
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
      // again rather than marked as created, so they are not left off BattleMetrics. They keep
      // their time, which says how long ago a claimed ban may have been made. The others are marked
      // as created, those on BattleMetrics lists only while they still have their ban.
      await setStatus(
        changes.createAgain,
        'TO_BE_CREATED',
        { status: 'TO_BE_DELETED', battlemetricsID: { [Op.or]: [null, PENDING] } },
        { silent: true }
      );
      await setStatus(changes.markCreated, 'CREATED', {
        status: 'TO_BE_DELETED',
        battlemetricsID: { [Op.not]: null, [Op.ne]: PENDING }
      });
      await setStatus(changes.markRemoteCreated, 'CREATED', { status: 'TO_BE_DELETED' });
      Logger.verbose(
        'ExportBanManager',
        2,
        `Step Cancel deletion of bans that should still be present done. Batch time: ${(
          (Date.now() - currentRunTime) /
          1000
        ).toFixed(2)}s`
      );

      // Queue existing bans to be deleted.
      await setStatus(changes.queueDeletion, 'TO_BE_DELETED', { status: 'CREATED' });
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
      await setStatus(
        changes.queueClaimed,
        'TO_BE_DELETED',
        { status: 'TO_BE_CREATED', battlemetricsID: { [Op.not]: null } },
        { silent: true }
      );
      await inStatements(changes.remove, (someIDs) =>
        ExportBan.destroy({
          where: {
            id: {
              [Op.in]: someIDs
            },
            status: 'TO_BE_CREATED',
            battlemetricsID: null
          }
        })
      );
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
