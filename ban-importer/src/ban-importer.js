import { sequelize } from 'scbl-lib/db';
import { Ban, BanList, SteamUser } from 'scbl-lib/db/models';
import {
  ForeignKeyConstraintError,
  QueryTypes,
  ValidationError,
  isDatabaseUnavailable
} from 'scbl-lib/db/sequelize';
import { describeError, Logger } from 'scbl-lib/utils';

import BanFetcher from './ban-fetcher.js';
import { checkRunLock, isStopping, RunStopped, stopIfRequested } from './run-control.js';

// Thank god for this function.

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

// MySQL's error numbers for a deadlock and a lock wait timeout, after which the statement, or the
// transaction it was in, can be run again.
const LOCK_ERRORS = [1213, 1205];

// findOrCreate commits its own transaction even after MySQL rolled it back for a deadlock, so the
// deadlock is reported as this error instead.
const ROLLED_BACK = /finished with state: rollback/;

// Whether a failed database operation could work if it is run again. Foreign key and validation
// errors, like anything else not listed here, would only fail again.
function isRetryable(err) {
  if (err instanceof ForeignKeyConstraintError || err instanceof ValidationError) return false;
  return (
    isDatabaseUnavailable(err) ||
    LOCK_ERRORS.includes(err.original?.errno) ||
    ROLLED_BACK.test(err.message)
  );
}

async function retryOperation(operation, retries = MAX_RETRIES) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      Logger.verbose(
        'BanImporter',
        2,
        `Attempt ${attempt} failed (${describeError(err)}). Retrying in ${RETRY_DELAY / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

// Steam users are added, and bans removed, this many at a time.
const CHUNK_SIZE = 1000;

// Removing at least this many of a list's bans in one run, and at least this share of them, could
// mean the list broke rather than lifted them, so it waits until IMPORTER_ALLOW_MASS_REMOVAL names
// the list.
const MASS_REMOVAL_BANS = 25;
const MASS_REMOVAL_SHARE = 0.1;

// Marks a list that was removed while its bans were being saved.
const LIST_REMOVED = Symbol('ban list removed');

// Whether a ban could not be saved because its ban list was not in the database.
function isMissingBanList(err) {
  return err instanceof ForeignKeyConstraintError && (err.fields || []).includes('banList');
}

export default class BanImporter {
  constructor(options) {
    options = {
      workers: 2,
      // The IDs of the ban lists, separated by commas, that may lose any number of bans this run.
      allowMassRemoval: process.env.IMPORTER_ALLOW_MASS_REMOVAL,
      ...options
    };

    this.workers = options.workers;
    this.allowMassRemoval = new Set(
      String(options.allowMassRemoval ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
    this.fetcher = new BanFetcher();
  }

  async importBans() {
    Logger.verbose('BanImporter', 2, 'Fetching ban lists to import...');
    const banLists = await retryOperation(() => BanList.findAll({ attributes: ['id'] }));
    Logger.verbose('BanImporter', 2, `Fetched ${banLists.length} ban lists to import.`);
    if (this.allowMassRemoval.size > 0)
      Logger.verbose(
        'BanImporter',
        2,
        `IMPORTER_ALLOW_MASS_REMOVAL allows any number of bans to be removed from ban lists ${[
          ...this.allowMassRemoval
        ].join(', ')}.`
      );

    Logger.verbose('BanImporter', 2, 'Fetching ban lists...');
    const myProgressBar = Logger.discordProgressBar(
      'BanImporter',
      `Fetching ${banLists.length} Ban Lists...`,
      null,
      0,
      banLists.length,
      0
    );

    // Each list is fetched, saved and checked for removed bans before the next one is started.
    const results = [];
    let currentList = 0;
    for (const banList of banLists) {
      // A run that is asked to stop does so between ban lists.
      stopIfRequested();
      results.push(await this.importBanList(banList.id));
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
    return results;
  }

  // Fetch all of a ban list, save its bans, then remove the bans it no longer has. A list that
  // cannot be fetched or saved keeps all of its stored bans, as does a list whose import is stopped
  // part-way because the run was asked to stop, which then throws RunStopped.
  async importBanList(id) {
    const result = { id, fetched: 0, created: 0, updated: 0, failed: 0, removed: 0, held: 0 };
    let stage = 'reading it';
    try {
      // Read the list again, as it may have been changed or removed since the run started.
      const banList = await retryOperation(() => BanList.findByPk(id));
      if (!banList) {
        result.gone = true;
        return result;
      }

      // The fetcher stops between pages if the run is asked to stop, and so does the import once
      // the list is fetched, before any of it is saved.
      stage = 'fetching it';
      const { bans, rawCount, firstMetaTotal } = await this.fetcher.fetchBanList(banList);
      Object.assign(result, { fetched: bans.length, rawCount, firstMetaTotal });
      stopIfRequested();

      stage = 'saving its Steam users';
      await this.saveSteamUsers(bans);

      stage = 'saving its bans';
      if (!(await this.saveBans(banList, bans, result))) {
        result.gone = true;
        return result;
      }

      // Removing bans must not happen in two runs at once, so it needs the run lock. It is also
      // skipped once the run is asked to stop, so a list whose saves were cut short is never swept,
      // as its unsaved bans would look removed. A sweep that has started is finished, whatever
      // happens meanwhile.
      await checkRunLock();
      stopIfRequested();
      stage = 'removing the bans it no longer has';
      await this.removeMissingBans(banList, bans, result);
      return result;
    } catch (err) {
      result.stage = stage;
      if (err instanceof RunStopped) {
        result.stopped = true;
        throw err;
      }
      result.error = describeError(err);
      return result;
    } finally {
      this.logResult(result);
    }
  }

  // Add the list's players, so that their bans can be saved.
  async saveSteamUsers(bans) {
    const steamUsers = [...new Set(bans.map((ban) => ban.steamUser))];
    for (let i = 0; i < steamUsers.length; i += CHUNK_SIZE) {
      const chunk = steamUsers.slice(i, i + CHUNK_SIZE);
      await retryOperation(() =>
        SteamUser.bulkCreate(
          chunk.map((steamUser) => ({ id: steamUser })),
          { updateOnDuplicate: ['id'] }
        )
      );
    }
  }

  // Save the list's bans a few at a time, and wait for all of them. A ban that cannot be saved is
  // counted and the others are still saved, but the list stops if the database stays unavailable,
  // which throws, or if the list was removed during the run, which returns false. Once the run is
  // asked to stop, no more bans are started, and this returns when the saves under way, each with
  // its player's update, have finished, so none is left half-done. The bans not saved are fetched
  // again by the next run.
  async saveBans(banList, bans, result) {
    let next = 0;
    let stop = null;
    const work = async () => {
      while (next < bans.length && !stop && !isStopping()) {
        const importedBan = bans[next++];
        try {
          await this.saveBan(importedBan, result);
        } catch (err) {
          const reason = await this.stopReason(err, banList);
          if (reason) {
            stop = stop || reason;
            continue;
          }

          result.failed++;
          result.failure = result.failure || describeError(err);
          Logger.verbose(
            'BanImporter',
            2,
            `Failed to save raw ban (ID: ${importedBan.id}) in ban list (ID: ${banList.id}): ${describeError(err)}`
          );
        }
      }
    };
    await Promise.all(Array.from({ length: this.workers }, work));

    if (stop === LIST_REMOVED) return false;
    if (stop) throw stop;
    return true;
  }

  // Whether a ban that could not be saved means that the rest of its list cannot be saved either,
  // as the database stayed unavailable or the list was removed during the run.
  async stopReason(err, banList) {
    if (isRetryable(err)) return err;
    if (!isMissingBanList(err)) return null;
    try {
      const exists = await retryOperation(() =>
        BanList.findByPk(banList.id, { attributes: ['id'] })
      );
      return exists ? null : LIST_REMOVED;
    } catch (checkErr) {
      return checkErr;
    }
  }

  async saveBan(importedBan, result) {
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
          // Remote bans have no note, which is stored as NULL.
          rawNote: importedBan.rawNote ?? null,
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
    if (created) {
      result.created++;
      return;
    }

    // Update the information. A note that is missing matches the NULL stored for it, so an
    // unchanged ban is not saved again.
    ban.expires = importedBan.expires;
    ban.expired = importedBan.expired;
    ban.reason = importedBan.reason;
    ban.rawReason = importedBan.rawReason;
    ban.rawNote = importedBan.rawNote ?? null;
    if (!ban.changed()) return;

    // Save the updated information.
    await retryOperation(() => ban.save());
    result.updated++;
  }

  // Remove the stored bans that the list no longer has, a chunk at a time, each chunk in one
  // transaction that also queues its players for an update. Nothing is removed if the list returned
  // no bans, as it may be broken, or if it would lose many of its bans at once, unless
  // IMPORTER_ALLOW_MASS_REMOVAL names the list.
  async removeMissingBans(banList, bans, result) {
    const fetched = new Set(bans.map((ban) => ban.id));
    const stored = await retryOperation(() =>
      sequelize.query('SELECT id, steamUser FROM Bans WHERE banList = ?', {
        replacements: [banList.id],
        type: QueryTypes.SELECT
      })
    );
    result.stored = stored.length;

    const missing = stored.filter((ban) => !fetched.has(ban.id));
    if (missing.length === 0 || bans.length === 0) return;

    result.massRemoval =
      missing.length >= Math.max(MASS_REMOVAL_BANS, stored.length * MASS_REMOVAL_SHARE);
    if (result.massRemoval && !this.allowMassRemoval.has(String(banList.id))) {
      result.held = missing.length;
      return;
    }

    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE);
      await retryOperation(() =>
        sequelize.transaction(async (transaction) => {
          // Queue the Steam users for an update, as they have lost a ban.
          await SteamUser.update(
            {
              lastRefreshedInfo: null,
              lastRefreshedExport: null,
              lastRefreshedReputationPoints: null,
              lastRefreshedReputationRank: null
            },
            { where: { id: [...new Set(chunk.map((ban) => ban.steamUser))] }, transaction }
          );
          await Ban.destroy({
            where: { banList: banList.id, id: chunk.map((ban) => ban.id) },
            transaction
          });
        })
      );
      result.removed += chunk.length;
    }
  }

  // Log one line about the list. A line about a list that needs looking at is logged as important,
  // so it reaches the log channel ahead of other messages and is never dropped for them. The others
  // only go to the console.
  logResult(result) {
    const list = `ban list (ID: ${result.id})`;
    if (result.gone) {
      Logger.verbose('BanImporter', 2, `Skipped ${list}, as it was removed during the run.`);
      return;
    }

    const counts = [
      `${result.fetched} bans fetched`,
      `${result.created} new`,
      `${result.updated} updated`
    ];
    if (result.removed > 0) counts.push(`${result.removed} removed`);
    if (result.failed > 0) counts.push(`${result.failed} failed to save (${result.failure})`);
    const progress = result.fetched > 0 ? ` (${counts.join(', ')})` : '';

    if (result.stopped) {
      // This says what the list saved before the run stopped. The next run imports it again.
      Logger.important(
        'BanImporter',
        `Stopped importing ${list} while ${result.stage}, as the run is stopping, so none of its bans were removed${progress}.`
      );
    } else if (result.error) {
      const removed =
        result.removed > 0
          ? `after removing ${result.removed} of its bans`
          : 'so none of its bans were removed';
      Logger.important(
        'BanImporter',
        `Failed to import ${list} while ${result.stage}, ${removed}${progress}. ${result.error}`
      );
    } else if (result.fetched === 0 && result.stored > 0) {
      const none = result.rawCount > 0 ? 'no bans with a SteamID' : 'no bans';
      Logger.important(
        'BanImporter',
        `Imported ${list}: it returned ${none}, so its ${result.stored} stored bans were kept in case the list is broken.`
      );
    } else if (result.held > 0) {
      Logger.important(
        'BanImporter',
        `Imported ${list}: ${counts.join(', ')}. Kept the ${result.held} of its ${result.stored} stored bans that it no longer has, as removing at least ${MASS_REMOVAL_BANS} bans and ${MASS_REMOVAL_SHARE * 100}% of a list at once needs confirming. If the list really dropped them, set IMPORTER_ALLOW_MASS_REMOVAL=${result.id} for one run.`
      );
    } else if (result.massRemoval) {
      Logger.important(
        'BanImporter',
        `Imported ${list}: ${counts.join(', ')}, as IMPORTER_ALLOW_MASS_REMOVAL names the list. Remove it from the setting once the removal is done.`
      );
    } else if (result.failed > 0) {
      Logger.important('BanImporter', `Imported ${list}: ${counts.join(', ')}.`);
    } else {
      Logger.verbose('BanImporter', 2, `Imported ${list}: ${counts.join(', ')}.`);
    }
  }
}
