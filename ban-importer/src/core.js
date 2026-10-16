import { steam } from 'scbl-lib/apis';
import { sequelize } from 'scbl-lib/db';
import { ExportBan, ExportBanList, SteamUser } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';
import {
  createDiscordWebhookMessage,
  DELETED_WEBHOOK_CODES,
  isDiscordWebhookUrl,
  Logger,
  sendDiscordWebhook
} from 'scbl-lib/utils';
import { HOST } from 'scbl-lib/config';

import { checkRunLock, stopIfRequested } from './run-control.js';

const UPDATE_STEAM_USER_INFO_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const UPDATE_STEAM_USER_INFO_BATCH_SIZE = 50;
const UPDATE_STEAM_USER_INFO_BATCH_TIMEOUT = 50000;
// The Steam step stops once this many batches in a row have failed, as Steam is then most likely
// down and the rest would fail too. The users left stay due, so the next run updates them.
const UPDATE_STEAM_USER_INFO_MAX_FAILED_BATCHES = 3;
const DISCORD_ALERT_CAP = 50;
// Once this many of a BattleMetrics export ban list's requests in a row have failed, its other
// export bans wait for the next run, as BattleMetrics would most likely refuse them too.
const BATTLEMETRICS_LIST_MAX_FAILURES = 3;
// Once this many BattleMetrics export ban lists in a row have stopped because BattleMetrics did not
// answer or answered with a server error, with no change made since, BattleMetrics is most likely
// down, so the BattleMetrics export bans left wait for the next run rather than each list waiting
// out its own timeouts.
const BATTLEMETRICS_MAX_LISTS_DOWN = 3;

// Webhooks Discord has reported as deleted during this run, so they are not tried again.
const deletedWebhooks = new Set();

// Export ban lists whose webhook was skipped during this run for not being a Discord webhook, so it
// is only reported once.
const invalidWebhookLists = new Set();

async function withTimeout(promise) {
  const myError = new Error(`timeout`);
  const timeout = new Promise((resolve, reject) =>
    setTimeout(() => reject(myError), UPDATE_STEAM_USER_INFO_BATCH_TIMEOUT)
  );

  return await Promise.race([promise, timeout]);
}

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class Core {
  static async updateSteamUserInfo() {
    Logger.verbose('Core', 2, 'Fetching Steam users to update...');
    const profileStartTime = Date.now();
    const users = await SteamUser.findAll({
      attributes: ['id'],
      where: {
        [Op.or]: [
          { lastRefreshedInfo: null },
          {
            lastRefreshedInfo: {
              [Op.lt]: new Date(new Date() - UPDATE_STEAM_USER_INFO_REFRESH_INTERVAL)
            }
          }
        ]
      }
    });

    Logger.verbose('Core', 2, `Updating ${users.length} Steam users...`);
    const startingLength = users.length;
    const myProgressBar = Logger.discordProgressBar(
      'Core',
      `Updating ${users.length} Steam users...`,
      null,
      0,
      startingLength,
      0
    );

    let failedBatches = 0;
    while (users.length > 0) {
      // A run that is asked to stop does so between batches.
      stopIfRequested();
      const batch = users.splice(0, Math.min(UPDATE_STEAM_USER_INFO_BATCH_SIZE, users.length));

      let data = null;

      Logger.verbose(
        'Core',
        2,
        `Updating batch of ${batch.length} Steam users (${users.length} remaining)...`
      );
      try {
        const myData = await steam('get', 'ISteamUser/GetPlayerSummaries/v2', {
          steamids: batch.map((user) => user.id).join(',')
        });
        data = myData.data;
      } catch (err) {
        // Steam refused the key, so it would refuse every other batch too, and
        // partner.steam-api.com limits the whole IP address after repeated refusals.
        if (err.auth) {
          Logger.verbose(
            'Core',
            1,
            `Stopped updating Steam users, as Steam refused the API key: ${err.message}`
          );
          break;
        }

        // Steam is still limiting requests after the client's retries and minute-long pauses, so
        // every other batch would wait out the same pauses. The users left stay due, so the next
        // run updates them, and the later steps do not need fresh Steam data.
        if (err.status === 429) {
          Logger.verbose(
            'Core',
            1,
            `Stopped updating Steam users, as Steam is still limiting requests: ${err.message}`
          );
          break;
        }

        failedBatches++;
        if (failedBatches >= UPDATE_STEAM_USER_INFO_MAX_FAILED_BATCHES) {
          Logger.verbose(
            'Core',
            1,
            `Stopped updating Steam users, as ${failedBatches} batches in a row failed: ${err.message}`
          );
          break;
        }

        // The Steam client throws ApiErrors, which never hold the key, so the error is logged
        // whole.
        Logger.verbose(
          'Core',
          1,
          `Failed to update batch of ${batch.length} Steam users due to Error: `,
          err
        );
        await doSleep(5000);
        continue;
      }
      failedBatches = 0;

      Logger.verbose(
        'Core',
        2,
        `Done fetching SteamUsers. Updating DB ${data.response.players
          .map((user) => user.steamid)
          .join(',')}`
      );
      for (const user of data.response.players) {
        try {
          await withTimeout(
            SteamUser.update(
              {
                name: user.personaname,
                profileURL: user.profileurl,
                avatar: user.avatar,
                avatarMedium: user.avatarmedium,
                avatarFull: user.avatarfull,
                lastRefreshedInfo: Date.now()
              },
              { where: { id: user.steamid } }
            )
          );
        } catch (err) {
          Logger.verbose('Core', 1, `Failed to update Steam user: `, err);
          continue;
        }
      }
    }
    Logger.discordProgressBar(
      'Core',
      `Updating ${startingLength} Steam users...`,
      myProgressBar,
      0,
      startingLength,
      startingLength - users.length
    );

    Logger.verbose(
      'Core',
      2,
      `Finished updating Steam users. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }

  static async clearOrphanedUsers() {
    Logger.verbose('Core', 2, 'Clearing reputation points of orphaned Steam users...');
    const profileStartTime = Date.now();
    const affectedRows = await sequelize.query(
      `UPDATE SteamUsers 
      SET 
      reputationPoints = 0, reputationPointsMonthBefore = 0, lastRefreshedReputationPoints = now(), lastRefreshedReputationRank = now(), lastRefreshedExport = now() 
      WHERE 
      id IN (
        SELECT id FROM (
          SELECT id FROM SteamUsers where id NOT IN (
            SELECT steamUser from Bans
            )
             and reputationPoints > 0 and isSCBLUser is not null
          ) as X
        )`,
      { type: sequelize.QueryTypes.BULKUPDATE }
    );
    Logger.verbose(
      'Core',
      2,
      `Finished Updating reputation points of ${affectedRows} orphaned Steam users. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
  }

  static async updateReputationPoints() {
    Logger.verbose('Core', 2, 'Updating reputation points of outdated Steam users...');
    const profileStartTime = Date.now();
    const affectedRows = await sequelize.query(
      `
        UPDATE SteamUsers SU
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT 
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW(),
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW(),
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLC ON SU.id = PPBLC.steamUser
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT 
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            WHERE B.created < NOW() - INTERVAL 1 MONTH
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLMB ON SU.id = PPBLMB.steamUser
        SET
          SU.reputationPoints = IFNULL(PPBLC.points, 0),
          SU.reputationPointsMonthBefore = IFNULL(PPBLMB.points, 0),
          SU.reputationPointsMonthChange = IFNULL(PPBLC.points, 0) - IFNULL(PPBLMB.points, 0),
          SU.lastRefreshedReputationPoints = NOW()
        WHERE SU.lastRefreshedReputationPoints IS NULL
      `,
      { type: sequelize.QueryTypes.BULKUPDATE }
    );
    Logger.verbose(
      'Core',
      2,
      `Finished Updating reputation points of ${affectedRows} outdated Steam users. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
  }

  static async updateReputationRank() {
    Logger.verbose('Core', 2, 'Updating reputation rank of Steam users...');
    const profileStartTime = Date.now();

    // One statement, so it needs nothing left on a pooled connection by an earlier one and can run
    // again in the same process; NOW() is the same for every row. Only players whose rank changed
    // or who were queued for a refresh are written, so lastRefreshedReputationRank is when a
    // player's rank last changed or was last recalculated after their bans changed.
    // While it runs, it locks every SteamUsers row and stops new rows being added, so other writes
    // to SteamUsers, a new player's first sign-in included, wait until it finishes: 2 to 2.5
    // seconds with 145,000 players when most of them are re-ranked, as new bans usually make them,
    // and about 0.2 seconds when no rank changed.
    // Leave this at RANK() because that way we can actually count how many ppl were on ranks before this one.
    // DENSE_RANK() fucks counting up when browsing ranks
    const affectedRows = await sequelize.query(
      `
      UPDATE SteamUsers su
      JOIN (
        SELECT id, RANK() OVER (ORDER BY reputationPoints DESC) AS reputationRank
        FROM SteamUsers
      ) rr ON su.id = rr.id
      SET su.reputationRank = rr.reputationRank,
          su.lastRefreshedReputationRank = NOW()
      WHERE NOT (su.reputationRank <=> rr.reputationRank) OR su.lastRefreshedReputationRank IS NULL
      `,
      { type: sequelize.QueryTypes.BULKUPDATE }
    );
    Logger.verbose(
      'Core',
      2,
      `Finished Updating reputation rank of ${affectedRows} Steam users. Took ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );
  }

  static async exportExportBans() {
    Logger.verbose('Core', 2, 'Exporting Bans...');
    const profileStartTime = Date.now();
    // Get bans that need exporting, the longest waiting first. An export ban BattleMetrics refused
    // was changed when its claim was released, so it goes to the back of the queue, and cannot
    // hold up the rest of its list run after run.
    const queuedExportBans = await ExportBan.findAll({
      where: { status: { [Op.in]: ['TO_BE_CREATED', 'TO_BE_DELETED'] } },
      include: [ExportBanList, SteamUser],
      order: [['updatedAt', 'ASC']]
    });
    Logger.verbose(
      'Core',
      2,
      `Step Done: Getting Bans that need exporting after ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );

    // A BattleMetrics export ban list whose BattleMetrics ban list was never made, e.g. as
    // BattleMetrics failed when the list was created, has nowhere to add bans to. Its bans to be
    // created wait until it has one, rather than being sent to BattleMetrics, and failing, on every
    // run. Its bans to be deleted are still deleted, as that needs no ban list.
    const listsWithoutBanList = {};
    const exportBans = queuedExportBans.filter((exportBan) => {
      const { ExportBanList: exportBanList } = exportBan;
      if (
        exportBan.status !== 'TO_BE_CREATED' ||
        exportBanList.type !== 'battlemetrics' ||
        exportBanList.battlemetricsID
      )
        return true;
      listsWithoutBanList[exportBanList.id] ||= { exportBanList, count: 0 };
      listsWithoutBanList[exportBanList.id].count++;
      return false;
    });
    for (const { exportBanList, count } of Object.values(listsWithoutBanList))
      Logger.verbose(
        'Core',
        1,
        `Skipped ${count} bans to add to ${exportBanList.server}'s List "${exportBanList.name}" (ID: ${exportBanList.id}), as it has no BattleMetrics ban list to add them to.`
      );

    // Export bans claimed by an earlier run go first, so a ban BattleMetrics may have made for one is
    // looked for, and recorded, early in the run. Claiming one changed its time, which would put it
    // behind every export ban queued since, and those could hold it up for more runs. The others
    // keep their order.
    exportBans.sort(
      (a, b) => (b.battlemetricsID === 'pending') - (a.battlemetricsID === 'pending')
    );

    // Tally the number of changes per ban list.
    const listChangeCount = {};
    for (const exportBan of exportBans) {
      if (exportBan.ExportBanList.id in listChangeCount)
        listChangeCount[exportBan.ExportBanList.id].count++;
      else
        listChangeCount[exportBan.ExportBanList.id] = {
          exportBanList: exportBan.ExportBanList,
          count: 1,
          // How many of the changes were made this run.
          made: 0
        };
    }
    Logger.verbose(
      'Core',
      2,
      `Step Done: Tallying number of Bans after ${((Date.now() - profileStartTime) / 1000).toFixed(
        2
      )}s`
    );

    // Mark whether to do Discord alerts for each ban.
    for (const exportBan of exportBans)
      exportBan.doDiscordAlert =
        listChangeCount[exportBan.ExportBanList.id].count < DISCORD_ALERT_CAP;
    Logger.verbose(
      'Core',
      2,
      `Step Done: Marking Bans for discord alerts after ${(
        (Date.now() - profileStartTime) /
        1000
      ).toFixed(2)}s`
    );

    // Changes reach BattleMetrics from here on, so they must never be made by two runs at once.
    await checkRunLock();

    const myProgressBar = Logger.discordProgressBar(
      'Core',
      `Exporting ${exportBans.length} Bans...`,
      null,
      0,
      exportBans.length,
      0
    );
    let currentList = 0;

    // Whether BattleMetrics refused the API key, which every BattleMetrics export ban list uses.
    let battlemetricsRefused = false;

    // How many BattleMetrics export ban lists in a row have stopped as BattleMetrics did not answer
    // or failed, since a change was last made, and whether BattleMetrics is taken to be down.
    let listsDown = 0;
    let battlemetricsDown = false;

    // For each BattleMetrics export ban list, how many of its requests in a row have failed, and,
    // once its other export bans wait for the next run, why.
    const listFailures = {};

    // The bans on each BattleMetrics ban list, read at most once a run, the first time a ban that
    // BattleMetrics may or may not have made has to be looked for on it.
    const battlemetricsBans = new Map();

    // Update the export bans.
    for (const exportBan of exportBans) {
      // A run that is asked to stop does so between export bans, never between a BattleMetrics
      // request and the database save that records it.
      stopIfRequested();

      // Once BattleMetrics has refused the key, it would refuse every other request too, and once
      // it seems to be down, it would most likely not answer them either, so the BattleMetrics
      // export bans left wait for the next run. Remote lists' export bans carry on.
      const { ExportBanList: exportBanList } = exportBan;
      if ((battlemetricsRefused || battlemetricsDown) && exportBanList.type === 'battlemetrics')
        continue;

      // The same goes for the export bans of a list whose requests are failing.
      const failures =
        exportBanList.type === 'battlemetrics'
          ? (listFailures[exportBanList.id] ||= { count: 0, stopped: null })
          : null;
      if (failures && failures.stopped) continue;

      // A creation marks the export ban as created before saving it, so a failed save is still
      // described as a creation.
      const creating = exportBan.status === 'TO_BE_CREATED';
      Logger.verbose(
        'Core',
        2,
        `${creating ? 'Creat' : 'Delet'}ing export ban (ID: ${exportBan.id})...`
      );

      try {
        const made = creating
          ? await Core.createExportBan(exportBan, battlemetricsBans)
          : await Core.deleteExportBan(exportBan, battlemetricsBans);
        if (made) {
          listChangeCount[exportBanList.id].made++;
          if (failures) {
            failures.count = 0;
            listsDown = 0;
          }
        }
      } catch (err) {
        if (err.auth) {
          battlemetricsRefused = true;
          await Logger.verbose(
            'Core',
            1,
            `Stopped exporting bans to BattleMetrics until the next run, as BattleMetrics refused the API key: ${err.message}`
          );
        } else {
          // The BattleMetrics client throws ApiErrors, which never hold the API key, so the error
          // is logged whole, which keeps the stack trace of any other error, e.g. the database's.
          await Logger.verbose(
            'Core',
            1,
            `Failed to ${creating ? 'create' : 'delete'} export ban (ID: ${exportBan.id}): `,
            err
          );

          // Once a few of a list's requests in a row have failed, its other export bans wait for
          // the next run, rather than each failing in turn. A request BattleMetrics may have
          // carried out, e.g. one answered with 5xx, keeps its export ban claimed, so the ban is
          // not made twice, and only counts towards those. One that went unanswered, as it timed
          // out or was cut off, stops the list at once, as BattleMetrics is then most likely not
          // answering, and every other export ban would wait as long. Not so for an export ban an
          // earlier run claimed: its request failed before, so the request itself may be what
          // fails, and as claimed export bans go first, it would stop its list on every run.
          if (failures) {
            failures.count++;
            if (err.ambiguous && !err.response && exportBan.battlemetricsID !== 'pending')
              failures.stopped =
                'BattleMetrics did not answer a request, which it may have carried out';
            else if (failures.count >= BATTLEMETRICS_LIST_MAX_FAILURES)
              failures.stopped = `${failures.count} of its requests in a row failed`;
            if (failures.stopped) {
              Logger.verbose(
                'Core',
                1,
                `Stopped exporting bans to BattleMetrics for ${exportBanList.server}'s List "${exportBanList.name}" (ID: ${exportBanList.id}) until the next run, as ${failures.stopped}.`
              );

              // A list stopped by BattleMetrics refusing its requests says nothing about the others.
              if (!err.response || err.response.status >= 500) listsDown++;
              if (listsDown >= BATTLEMETRICS_MAX_LISTS_DOWN && !battlemetricsDown) {
                battlemetricsDown = true;
                Logger.verbose(
                  'Core',
                  1,
                  `Stopped exporting bans to BattleMetrics until the next run, as it did not answer or failed for ${listsDown} export ban lists in a row, so it is most likely down.`
                );
              }
            }
          }
        }
      }
      currentList++;
      Logger.discordProgressBar(
        'BanImporter',
        `Exporting ${exportBans.length} Bans...`,
        myProgressBar,
        0,
        exportBans.length,
        currentList
      );
    }
    Logger.verbose(
      'Core',
      2,
      `Step Done: Updating export Bans after ${((Date.now() - profileStartTime) / 1000).toFixed(
        2
      )}s`
    );

    // Do Discord alerts for ban lists exceeding the threshold, if any of their changes were made.
    for (const { exportBanList, count, made } of Object.values(listChangeCount)) {
      if (!exportBanList.discordWebhook || count < DISCORD_ALERT_CAP || made === 0) continue;

      const [, message] = createDiscordWebhookMessage(exportBanList.discordWebhook);

      message.setTitle("We've updated your export ban list.");
      message.setDescription(
        `We've made some changes to who's on your export ban list named "${exportBanList.name}".\nSadly, there's too many changes for us to document them individually.`
      );

      await Core.sendExportBanListAlert(exportBanList, message);
    }
    Logger.verbose(
      'Core',
      2,
      `Finished Exporting Bans. Took ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
  }

  // Send an alert to an export ban list's Discord webhook. If Discord says the webhook no longer
  // exists, remove it from every export ban list using it so later runs stop trying it.
  static async sendExportBanListAlert(exportBanList, message) {
    const { discordWebhook } = exportBanList;
    if (deletedWebhooks.has(discordWebhook)) return;

    // Name the list rather than the webhook, as anyone with its URL can post to the channel.
    const list = `${exportBanList.server}'s List "${exportBanList.name}" (ID: ${exportBanList.id})`;

    // Webhooks saved before the web server checked them could point anywhere, so only send to
    // Discord webhooks.
    if (!isDiscordWebhookUrl(discordWebhook)) {
      if (!invalidWebhookLists.has(exportBanList.id)) {
        invalidWebhookLists.add(exportBanList.id);
        Logger.verbose(
          'Core',
          1,
          `Skipped the Discord Webhook for ${list}, as it is not a Discord webhook address.`
        );
      }
      return;
    }

    let reason;
    try {
      await sendDiscordWebhook(discordWebhook, { embeds: message.getJSON().embeds });
      return;
    } catch (err) {
      if (!DELETED_WEBHOOK_CODES.includes(err.code)) {
        Logger.verbose('Core', 1, `Failed to send Discord Webhook for ${list}: ${err.message}`);
        return;
      }
      reason = err.message;
    }

    deletedWebhooks.add(discordWebhook);

    try {
      // Matching on the webhook leaves lists alone whose owners have set a new one since the run
      // started.
      const [count] = await ExportBanList.update(
        { discordWebhook: null },
        { where: { discordWebhook } }
      );
      const others =
        count > 1 ? ` and ${count - 1} other export ban list${count > 2 ? 's' : ''}` : '';
      Logger.verbose(
        'Core',
        1,
        `Removed the Discord Webhook from ${list}${others}, as Discord says it no longer exists (${reason}).`
      );
    } catch (err) {
      Logger.verbose(
        'Core',
        1,
        `Failed to remove the deleted Discord Webhook from ${list}: ${err.message}`
      );
    }
  }

  // Create an export ban: add it to its list's BattleMetrics ban list, for a BattleMetrics export
  // ban list, and mark it as created. Resolves with whether it was created, as one for BattleMetrics
  // may be left for a later run.
  static async createExportBan(exportBan, battlemetricsBans) {
    let { ExportBanList: exportBanList } = exportBan;

    if (exportBanList.type === 'battlemetrics') {
      // Add to BattleMetrics, which also marks the export ban as created. The export ban and its
      // list are read again first, as the run may have started hours ago, and either may have
      // been deleted or changed since.
      const current = await ExportBan.findOne({
        where: { id: exportBan.id },
        include: [ExportBanList]
      });
      if (!current || current.status !== 'TO_BE_CREATED' || !current.ExportBanList) return false;
      const result = await current.createBattlemetricsBan(battlemetricsBans);
      if (result !== 'created' && result !== 'found') return false;
      exportBanList = current.ExportBanList;
    } else {
      // Update the record to indicate it has been created.
      exportBan.status = 'CREATED';
      await exportBan.save();
    }

    // Send Discord alert.
    if (!exportBanList.discordWebhook || !exportBan.doDiscordAlert) return true;

    const [, message] = createDiscordWebhookMessage(exportBanList.discordWebhook, {
      color: '#00ff00'
    });

    message.setTitle(`${exportBan.SteamUser.name} has been added to your export ban list.`);
    message.setDescription(
      `[${exportBan.SteamUser.name}](${HOST}/search/${exportBan.SteamUser.id}) has reached the threshold required to be added to your export ban list named "${exportBanList.name}".\n\n* [BM RCON Link](https://www.battlemetrics.com/rcon/players?filter[search]=${exportBan.SteamUser.id}&method=quick&redirect=1)\n* [SteamID.uk Profile](https://steamid.uk/profile/${exportBan.SteamUser.id})`
    );
    message.setThumbnail(exportBan.SteamUser.avatarMedium);

    await Core.sendExportBanListAlert(exportBanList, message);
    return true;
  }

  // Delete an export ban: remove it from its list's BattleMetrics ban list, for a BattleMetrics
  // export ban list, and delete the record. Resolves with whether it was removed from the list, as
  // one for BattleMetrics may be left for a later run, or have had no BattleMetrics ban.
  static async deleteExportBan(exportBan, battlemetricsBans) {
    let { ExportBanList: exportBanList } = exportBan;

    if (exportBanList.type === 'battlemetrics') {
      // Delete from BattleMetrics, which also deletes the record. As for a creation, the export
      // ban and its list are read again first.
      const current = await ExportBan.findOne({
        where: { id: exportBan.id },
        include: [ExportBanList]
      });
      if (!current || current.status !== 'TO_BE_DELETED' || !current.ExportBanList) return false;
      const result = await current.deleteBattlemetricsBan(battlemetricsBans);
      if (result === 'gone')
        Logger.verbose(
          'Core',
          1,
          `Removed export ban (ID: ${exportBan.id}) from Lists due to error 404 during deletion.`
        );
      // Nothing was removed from the list for an export ban that had no BattleMetrics ban, so its
      // owner is not told otherwise.
      if (result === 'cleared')
        Logger.verbose(
          'Core',
          2,
          `Deleted export ban (ID: ${exportBan.id}), which had no Battlemetrics ban.`
        );
      if (result !== 'deleted' && result !== 'gone') return false;
      exportBanList = current.ExportBanList;
    } else {
      // Delete the record.
      await exportBan.destroy();
    }

    // Send Discord alert.
    if (!exportBanList.discordWebhook || !exportBan.doDiscordAlert) return true;

    const [, message] = createDiscordWebhookMessage(exportBanList.discordWebhook, {
      color: '#ff0000'
    });

    message.setTitle(`${exportBan.SteamUser.name} has been removed from your export ban list.`);
    message.setDescription(
      `[${exportBan.SteamUser.name}](${HOST}/search/${exportBan.SteamUser.id}) no longer meets the threshold required to be on your export ban list named "${exportBanList.name}" so has been removed.\n\n* [BM RCON Link](https://www.battlemetrics.com/rcon/players?filter[search]=${exportBan.SteamUser.id}&method=quick&redirect=1)\n* [SteamID.uk Profile](https://steamid.uk/profile/${exportBan.SteamUser.id})`
    );
    message.setThumbnail(exportBan.SteamUser.avatarMedium);

    await Core.sendExportBanListAlert(exportBanList, message);
    return true;
  }
}
