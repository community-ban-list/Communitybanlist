import async from 'async';

import { Ban, BanList, SteamUser } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import BanFetcher from './ban-fetcher.js';
import { checkRunLock, isStopping, stopIfRequested } from './run-control.js';

// Thank god for this function.

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

async function retryOperation(operation, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === retries) throw err;
      Logger.verbose(
        'BanImporter',
        1,
        `Attempt ${attempt} failed. Retrying in ${RETRY_DELAY / 1000}s... `,
        err
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

export default class BanImporter {
  constructor(options) {
    options = {
      workers: 2,
      ...options
    };

    this.queueBan = this.queueBan.bind(this);

    this.saveBan = this.saveBan.bind(this);
    this.saveBanQueue = async.queue(this.saveBan, options.workers);

    this.importedBanListIDs = new Set();
    this.importedBanIDs = [];

    // Batches of bans whose players are being added, before the bans are queued to be saved. The
    // fetcher does not wait for them.
    this.batchesQueueing = 0;

    // Set when the run is stopping, after which no more bans are queued to be saved.
    this.stopping = false;
  }

  // Whether bans are still being queued or saved.
  busy() {
    return this.batchesQueueing > 0 || !this.saveBanQueue.idle();
  }

  // Called between ban lists and before the sweep, to end the import there if the run was asked to
  // stop. Bans that were fetched but not saved yet are dropped, as the next run fetches them again,
  // and the work under way, adding a batch's players or saving a ban, is finished first, so none is
  // left half-done.
  async checkForStop() {
    if (!isStopping()) return;
    this.stopping = true;
    this.saveBanQueue.kill();
    while (this.busy()) await new Promise((resolve) => setTimeout(resolve, 100));
    stopIfRequested();
  }

  async queueBan(importedBans) {
    Logger.verbose('BanImporter', 2, `Queueing batch of ${importedBans.length} raw bans...`);
    if (importedBans.length === 0) return;
    this.batchesQueueing++;
    try {
      await retryOperation(() =>
        SteamUser.bulkCreate(
          importedBans.map((importedBan) => ({ id: importedBan.steamUser })),
          { updateOnDuplicate: ['id'] }
        )
      );
      if (this.stopping) return;

      for (const importedBan of importedBans) {
        this.importedBanListIDs.add(importedBan.banList.id);
        this.importedBanIDs.push(importedBan.id);
        this.saveBanQueue.push(importedBan);
      }
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        1,
        `Failed to queue batch of ${importedBans.length} raw bans: `,
        err
      );
    } finally {
      this.batchesQueueing--;
    }
  }

  async saveBan(importedBan) {
    try {
      // Create or find the ban.
      const [ban, created] = await retryOperation(() =>
        Ban.findOrCreate({
          where: {
            id: importedBan.id
          },
          defaults: {
            id: importedBan.id,
            created: importedBan.created || Date.now(),
            expires: importedBan.expires,
            expired: importedBan.expired,
            reason: importedBan.reason,
            rawReason: importedBan.rawReason,
            rawNote: importedBan.rawNote,
            steamUser: importedBan.steamUser,
            banList: importedBan.banList.id
          }
        })
      );

      // Queue the Steam user for an update if the ban is new or the ban expired status has changed.
      if (created || ban.expired !== importedBan.expired) {
        Logger.verbose(
          'BanImporter',
          2,
          `Found new or updated ban (ID: ${importedBan.id}) in ban list (ID: ${importedBan.banList.id}).`
        );
        await retryOperation(() =>
          SteamUser.update(
            {
              lastRefreshedExport: null,
              lastRefreshedReputationPoints: null,
              lastRefreshedReputationRank: null
            },
            {
              where: { id: importedBan.steamUser }
            }
          )
        );
      }

      // If it's created there's no need to update the information.
      if (created) return;

      // Update the information.
      ban.expires = importedBan.expires;
      ban.expired = importedBan.expired;
      ban.reason = importedBan.reason;
      ban.rawReason = importedBan.rawReason;
      ban.rawNote = importedBan.rawNote;
      // Save the updated information.
      await retryOperation(() => ban.save());
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        1,
        `Failed to save raw ban (ID: ${importedBan.id}) in ban list (ID: ${importedBan.banList.id}): `,
        err
      );
    }
  }

  async importBans() {
    const profileStartTime = Date.now();
    Logger.verbose('BanImporter', 2, 'Fetching ban lists to import...');
    const banLists = await retryOperation(() => BanList.findAll());
    Logger.verbose('BanImporter', 2, `Fetched ${banLists.length} ban lists to import.`);

    const fetcher = new BanFetcher(this.queueBan);

    Logger.verbose('BanImporter', 2, 'Fetching ban lists...');
    const myProgressBar = Logger.discordProgressBar(
      'BanImporter',
      `Fetching ${banLists.length} Ban Lists...`,
      null,
      0,
      banLists.length,
      0
    );

    let currentList = 0;
    for (const banList of banLists) {
      await this.checkForStop();
      try {
        await retryOperation(() => fetcher.fetchBanList(banList));
      } catch (err) {
        Logger.verbose('BanImporter', 1, `Failed to import ban list ${banList.id}: `, err);
      }
      currentList++;
      Logger.discordProgressBar(
        'BanImporter',
        `Fetching ${banLists.length} Ban Lists...`,
        myProgressBar,
        0,
        banLists.length,
        currentList
      );
    }

    // Wait until every ban is saved, so the sweep below sees them all, and the import never ends
    // with saves still running, which a run that stops after it would cut off. A run that is asked
    // to stop meanwhile stops below instead, once the saves under way have finished.
    Logger.verbose('BanImporter', 2, 'Waiting for bans to be saved...');
    while (this.busy() && !isStopping()) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!this.busy())
      console.log(`Finished Drain after ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`);

    // The sweep deletes every ban of the fetched lists that was not seen in this run, so it must not
    // run when the run is stopping, nor in two runs at once.
    await this.checkForStop();
    await checkRunLock();

    Logger.verbose('BanImporter', 2, 'Getting deleted bans...');
    const deletedBans = await retryOperation(() =>
      Ban.findAll({
        attributes: ['steamUser'],
        where: {
          id: { [Op.notIn]: this.importedBanIDs },
          banList: { [Op.in]: [...this.importedBanListIDs] }
        }
      })
    );
    Logger.verbose('BanImporter', 1, `Got ${deletedBans.length} deleted bans`);

    Logger.verbose('BanImporter', 2, 'Queuing Steams for update from deleted bans...');
    await retryOperation(() =>
      SteamUser.update(
        {
          lastRefreshedInfo: null,
          lastRefreshedExport: null,
          lastRefreshedReputationPoints: null,
          lastRefreshedReputationRank: null
        },
        {
          where: {
            id: {
              [Op.in]: deletedBans.map((deletedBan) => deletedBan.steamUser)
            }
          }
        }
      )
    );

    Logger.verbose('BanImporter', 2, 'Deleting deleted bans...');
    await retryOperation(() =>
      Ban.destroy({
        where: {
          id: { [Op.notIn]: this.importedBanIDs },
          banList: { [Op.in]: [...this.importedBanListIDs] }
        }
      })
    );
  }
}
