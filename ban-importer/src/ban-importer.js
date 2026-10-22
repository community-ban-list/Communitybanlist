import { sequelize } from 'scbl-lib/db';
import { BanListSync } from 'scbl-lib/db/importer-models';
import { Ban, BanList, ExportBanList, SteamUser } from 'scbl-lib/db/models';
import {
  ForeignKeyConstraintError,
  QueryTypes,
  ValidationError,
  isDatabaseUnavailable
} from 'scbl-lib/db/sequelize';
import {
  describeError,
  isSameBattlemetricsID,
  Logger,
  normaliseBattlemetricsID
} from 'scbl-lib/utils';

import BanFetcher from './ban-fetcher.js';
import {
  accessProblem,
  describeAlert,
  describeWidespreadLoss,
  isWidespread,
  nextSync,
  NOT_VISIBLE,
  readAccessCheck,
  readVisibleBanLists,
  sourceKey,
  stateOf,
  STATES,
  UNCONFIRMED
} from './ban-list-sync.js';
import {
  checkRunLock,
  isStopping,
  LOCK_LOST,
  reportProgress,
  RunStopped,
  stopIfRequested,
  stopRequest
} from './run-control.js';

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

// Removing at least this many of a list's bans in one run, and at least this share of the bans it
// had before the run, could mean the list broke rather than lifted them, as could a list returning
// no bans at all. Either waits until IMPORTER_ALLOW_MASS_REMOVAL names the list.
const MASS_REMOVAL_BANS = 25;
const MASS_REMOVAL_SHARE = 0.1;

// A list that could not be fetched is tried again once the others are done, after this wait, so a
// short outage of its source has time to pass. A run that is asked to stop does not wait.
const SECOND_ATTEMPT_DELAY = 60 * 1000;

// Marks a list that was removed while its bans were being saved.
const LIST_REMOVED = Symbol('ban list removed');

// Wait, but no longer than until the run is asked to stop.
function pause(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopRequest.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// A count written with thousands separators, e.g. 86,919.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

function plural(count, noun) {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// Whether a ban could not be saved because its ban list was not in the database.
function isMissingBanList(err) {
  return err instanceof ForeignKeyConstraintError && (err.fields || []).includes('banList');
}

// Whether a list's source refused it, e.g. as the list was deleted or CBL lost access to it, so it
// would only be refused again later in the run. A timeout (408) or rate limit (429) can pass.
function isRefused(err) {
  const status = err.status ?? err.response?.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// The import's totals, as its summary line and the run record give them. The run record also counts
// the lists that import one of CBL's own export ban lists, and those CBL can no longer read on
// BattleMetrics.
function totals(results) {
  const sum = (field) => results.reduce((total, result) => total + result[field], 0);
  return {
    fetched: sum('fetched'),
    new: sum('created'),
    updated: sum('updated'),
    removed: sum('removed'),
    held: sum('held'),
    failedLists: results.filter((result) => result.error).length,
    selfImports: results.filter((result) => result.selfImport).length,
    accessLost: results.filter((result) => result.accessLost).length
  };
}

// A list's counts for the run record, with what went wrong or was unusual, when anything was.
function listReport(result) {
  const report = {
    id: result.id,
    fetched: result.fetched,
    new: result.created,
    updated: result.updated,
    removed: result.removed,
    held: result.held
  };
  if (result.stored !== undefined) report.stored = result.stored;
  if (result.state && result.state !== STATES.OK) report.state = result.state;
  if (result.failed > 0) report.failedToSave = result.failed;
  if (result.attempt > 1) report.attempt = result.attempt;
  if (result.gone) report.gone = true;
  if (result.sourceChanged) report.sourceChanged = true;
  if (result.massRemoval) report.massRemoval = true;
  if (result.error) Object.assign(report, { error: result.error, stage: result.stage });
  return report;
}

export default class BanImporter {
  constructor(options) {
    options = {
      workers: 2,
      // The IDs of the ban lists, separated by commas, that may lose any number of bans this run.
      allowMassRemoval: process.env.IMPORTER_ALLOW_MASS_REMOVAL,
      // Whether the run checks which BattleMetrics ban lists the CBL organisation can see.
      accessCheck: process.env.IMPORTER_ACCESS_CHECK,
      ...options
    };

    this.workers = options.workers;
    this.allowMassRemoval = new Set(
      String(options.allowMassRemoval ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
    const accessCheck = readAccessCheck(options.accessCheck);
    if (accessCheck.warning) Logger.verbose('BanImporter', 2, accessCheck.warning);
    this.accessCheck = accessCheck.on;
    this.fetcher = new BanFetcher();

    // The number of ban lists the import started with, and a result for each list it imported.
    this.listCount = 0;
    this.results = [];

    // What the run read at its start: each list's BanListSyncs row, by list, and CBL's own export
    // ban lists on BattleMetrics. The access check is read once, for the first BattleMetrics list,
    // and its result is ok, failed, off or unused, when no BattleMetrics list needed it. The IDs of
    // the BattleMetrics lists the run tried are kept, to tell how widespread a loss of access is,
    // and the rows that wait to be saved until the first pass is over, by list (see
    // importBanList).
    this.syncs = new Map();
    this.exportBanLists = [];
    this.visibleBanLists = null;
    this.accessCheckResult = this.accessCheck ? 'unused' : 'off';
    this.triedBattlemetrics = new Set();
    this.pendingSyncs = new Map();
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

    // What earlier runs recorded about each list, and the BattleMetrics IDs of CBL's own export ban
    // lists, which no ban list may import. If either cannot be read, nothing is imported, as a list
    // that imports an export ban list could not be told from the others, and every list's alerts
    // would be posted again.
    const syncs = await retryOperation(() => BanListSync.findAll({ raw: true }));
    this.syncs = new Map(syncs.map((sync) => [sync.banList, sync]));
    const exportBanLists = await retryOperation(() =>
      ExportBanList.findAll({ attributes: ['id', 'battlemetricsID'], raw: true })
    );
    this.exportBanLists = exportBanLists.filter(
      ({ battlemetricsID }) => normaliseBattlemetricsID(battlemetricsID) !== ''
    );
    this.visibleBanLists = null;
    this.accessCheckResult = this.accessCheck ? 'unused' : 'off';
    this.triedBattlemetrics.clear();
    this.pendingSyncs.clear();
    if (!this.accessCheck)
      Logger.verbose(
        'BanImporter',
        2,
        'IMPORTER_ACCESS_CHECK is off, so this run does not check which BattleMetrics ban lists the CBL organisation can see.'
      );

    Logger.verbose('BanImporter', 2, 'Fetching ban lists...');

    // Each list is fetched, saved and checked for removed bans before the next one is started. A
    // run that is asked to stop does so between ban lists, after summing up the lists it imported.
    // The results are kept for the run record, which report() gives them to. The run's status
    // shows how many lists are done.
    this.listCount = banLists.length;
    const results = (this.results = []);
    try {
      reportProgress(0, banLists.length, 'ban lists');
      for (const banList of banLists) {
        stopIfRequested();
        results.push(await this.importBanList(banList.id));
        reportProgress(results.length, banLists.length, 'ban lists');
      }

      // A list that could not be fetched, e.g. during a short BattleMetrics outage, is tried once
      // more after the others. Not when every list failed that way, as their sources are then down;
      // a list that was not fetched, as it imports a CBL export ban list, says nothing about that.
      // A run that is asked to stop, before or during the wait, tries no list again.
      const retries = results.filter((result) => result.retry);
      const tryAgain =
        retries.length > 0 &&
        results.some((result) => !result.gone && !result.retry && !result.selfImport);

      // The rows that waited for the first pass to end are saved now, except those of the lists
      // tried again, whose second attempts save them.
      await this.savePendingSyncs((result) => !tryAgain || !result.retry);
      if (tryAgain) {
        stopIfRequested();
        reportProgress(0, retries.length, 'ban lists tried again');
        await pause(SECOND_ATTEMPT_DELAY);
        for (const [tried, failed] of retries.entries()) {
          stopIfRequested();
          const index = results.indexOf(failed);
          try {
            results[index] = await this.importBanList(failed.id, 2);
          } catch (err) {
            // A list whose second attempt is stopped part-way is left out of the summary, as one
            // stopped in the first pass is, since its own line says what the attempt saved.
            if (err instanceof RunStopped) results.splice(index, 1);
            throw err;
          }
          reportProgress(tried + 1, retries.length, 'ban lists tried again');
        }
      }
    } catch (err) {
      if (err instanceof RunStopped) {
        // The rows still waiting are saved, as their lists' attempts are over, e.g. of the lists the
        // run stopped before trying again. Not once the run has lost its run lock, as another run
        // may then be saving rows.
        if (err.reason !== LOCK_LOST) await this.savePendingSyncs();
        this.logSummary(results, { stopped: true, listCount: banLists.length });
      }
      throw err;
    }

    this.logSummary(results);
    return results;
  }

  // Fetch all of a ban list, save its bans, then remove the bans it no longer has, or those of its
  // old source if its type or source was changed meanwhile. A list that cannot be fetched or saved
  // keeps all of its stored bans, as does a list whose import is stopped part-way because the run
  // was asked to stop, which then throws RunStopped. So does a list that imports one of CBL's own
  // export ban lists, which is not fetched at all, and one CBL can no longer read on BattleMetrics.
  // How the import went is then saved in the list's BanListSyncs row: at once, or, in the first
  // pass, for a list to be tried again or one CBL cannot read, once every list has been tried. By
  // then the run knows whether it tries the list again, which saves the row instead, so a first
  // attempt the second one makes good is never counted or posted about. And many lists losing
  // access at once can then be posted about together.
  async importBanList(id, attempt = 1) {
    const result = {
      id,
      attempt,
      fetched: 0,
      created: 0,
      updated: 0,
      failed: 0,
      removed: 0,
      held: 0
    };
    let stage = 'reading it';
    let banList = null;
    try {
      // Read the list again, as it may have been changed or removed since the run started.
      banList = await retryOperation(() => BanList.findByPk(id));
      if (!banList) {
        result.gone = true;
        return result;
      }

      // Importing one of CBL's own export ban lists would feed the players CBL exports back in as
      // new bans, so such a list is neither fetched nor swept. Its bans stay until it is removed.
      const exportBanList = this.findExportBanList(banList);
      if (exportBanList) {
        result.selfImport = exportBanList.id;
        return result;
      }

      // A BattleMetrics list that the CBL organisation cannot see, by the run's access check, is
      // still fetched, so that any bans it gives are saved, but none of its bans are removed. A
      // list CBL had lost access to, by its row, stays so until a run shows that CBL can read it
      // again: its fetch must work, while the check, if it is on, finds it. So when the check
      // could not be made, it is not swept either, nor said to be back to normal.
      if (banList.type === 'battlemetrics') this.triedBattlemetrics.add(id);
      result.lostBefore = this.hadLostAccess(banList);
      const visible = await this.checkAccess(banList);
      if (visible === false) result.accessLost = NOT_VISIBLE;
      else if (visible === null && result.lostBefore) result.accessLost = UNCONFIRMED;

      // The fetcher stops between pages if the run is asked to stop, and so does the import once
      // the list is fetched, before any of it is saved.
      stage = 'fetching it';
      const { bans, rawCount, firstMetaTotal } = await this.fetcher.fetchBanList(banList);
      Object.assign(result, { fetched: bans.length, rawCount, firstMetaTotal });
      stopIfRequested();

      // The bans the list had before this run, which is what its losses are measured against.
      stage = 'reading its stored bans';
      const stored = await retryOperation(() =>
        sequelize.query('SELECT id, steamUser FROM Bans WHERE banList = ?', {
          replacements: [banList.id],
          type: QueryTypes.SELECT
        })
      );
      result.stored = stored.length;

      stage = 'saving its Steam users';
      await this.saveSteamUsers(bans);

      stage = 'saving its bans';
      if (!(await this.saveBans(banList, bans, result))) {
        result.gone = true;
        return result;
      }
      // A run that was asked to stop while the bans were saved ends here, once the saves under way
      // have finished.
      stopIfRequested();

      // The list's type or source may have been changed since it was read, by hand or by a
      // /banlist update made just as the run started. The bot deletes the list's bans with the
      // change, but this run may have saved some of the old source's bans again since, so the bans
      // fetched from it are removed instead of the bans the list no longer has. The new source is
      // imported on the next run.
      stage = 'reading it again';
      const current = await retryOperation(() =>
        BanList.findByPk(id, { attributes: ['id', 'type', 'source'] })
      );
      if (!current) {
        result.gone = true;
        return result;
      }
      const sourceChanged = current.type !== banList.type || current.source !== banList.source;

      // Removing bans must not happen in two runs at once, so it needs the run lock. It is also
      // skipped once the run is asked to stop, so a list whose saves were cut short is never swept,
      // as its unsaved bans would look removed. A sweep that has started is finished, whatever
      // happens meanwhile. A list CBL cannot read, or may still not be able to, is never swept.
      await checkRunLock();
      stopIfRequested();
      if (sourceChanged) {
        stage = 'removing the bans of its old source';
        await this.removeOldSourceBans(banList, bans, result);
      } else if (!result.accessLost) {
        stage = 'removing the bans it no longer has';
        await this.removeMissingBans(banList, bans, stored, result);
      }
      return result;
    } catch (err) {
      result.stage = stage;
      if (err instanceof RunStopped) {
        result.stopped = true;
        throw err;
      }
      result.error = describeError(err);
      // BattleMetrics may have answered that CBL can no longer read the list, which would only
      // happen again later in the run. Its count of the list's bans is kept even so. A list CBL
      // had lost access to that fails for another reason, e.g. as BattleMetrics is down, is still
      // taken to have lost it, as nothing shows otherwise.
      const lost =
        banList?.type === 'battlemetrics' && stage === 'fetching it' && accessProblem(err);
      if (lost) result.accessLost = lost;
      else if (result.lostBefore) result.accessLost ??= UNCONFIRMED;
      result.lostAgain = Boolean(lost && result.lostBefore);
      if (lost && Number.isInteger(err.metaTotal)) result.firstMetaTotal = err.metaTotal;
      // A list whose source failed in a way that can pass is tried again after the other lists.
      result.retry = stage === 'fetching it' && attempt === 1 && !isRefused(err) && !lost;
      return result;
    } finally {
      if (!result.gone && !result.stopped) result.state = stateOf(result);
      this.logResult(result);
      // A second attempt that ends, saved or not, takes the place of the first one's row. One that
      // is stopped leaves it, to be saved as the run stops.
      if (attempt > 1 && !result.stopped) this.pendingSyncs.delete(id);
      if (banList && !result.gone && !result.stopped) {
        if (attempt === 1 && (result.retry || result.accessLost))
          this.pendingSyncs.set(id, { banList, result, now: new Date() });
        else this.postAlerts(await this.saveSync(banList, result));
      }
    }
  }

  // Whether CBL had lost access to the list, by its row from before the run, for its current type
  // and source: a list whose source was changed starts afresh.
  hadLostAccess(banList) {
    const before = this.syncs.get(banList.id);
    return before?.state === STATES.ACCESS_LOST && before.sourceKey === sourceKey(banList);
  }

  // The CBL export ban list whose BattleMetrics list the ban list imports, if it does. Its source
  // is compared with the export ban lists' IDs ignoring case, hyphens and spaces, as the bot does.
  findExportBanList(banList) {
    if (banList.type !== 'battlemetrics') return null;
    return (
      this.exportBanLists.find(({ battlemetricsID }) =>
        isSameBattlemetricsID(battlemetricsID, banList.source)
      ) ?? null
    );
  }

  // Whether the run's access check finds the BattleMetrics list among the ban lists the CBL
  // organisation can see: true or false, or null when the check could not be made. With the check
  // off, and for a remote list, it is true, as nothing then says otherwise. The check reads
  // BattleMetrics' list of the ban lists the CBL organisation can see, every page of it, once a
  // run, for the first BattleMetrics list. A check that fails never stops the import: the run goes
  // without it.
  async checkAccess(banList) {
    if (banList.type !== 'battlemetrics' || !this.accessCheck) return true;
    this.visibleBanLists ??= this.readAccess();
    const visible = await this.visibleBanLists;
    if (!visible) return null;
    return visible.has(normaliseBattlemetricsID(banList.source));
  }

  // Read the IDs of the BattleMetrics ban lists the CBL organisation can see, or null when they
  // cannot be read, which the console is told of.
  async readAccess() {
    try {
      const visible = await readVisibleBanLists();
      this.accessCheckResult = 'ok';
      Logger.verbose(
        'BanImporter',
        2,
        `The CBL organisation can see ${plural(visible.size, 'BattleMetrics ban list')}.`
      );
      return visible;
    } catch (err) {
      this.accessCheckResult = 'failed';
      Logger.verbose(
        'BanImporter',
        2,
        `Could not read which BattleMetrics ban lists the CBL organisation can see, so this run does not check them: ${describeError(err)}`
      );
      return null;
    }
  }

  // Save the rows that wait for the first pass to end, those whose result filter picks, or all of
  // them, then post the alerts they call for, together (see postAlerts).
  async savePendingSyncs(filter = () => true) {
    const alerts = [];
    for (const [id, { banList, result, now }] of this.pendingSyncs) {
      if (!filter(result)) continue;
      this.pendingSyncs.delete(id);
      alerts.push(...(await this.saveSync(banList, result, now)));
    }
    this.postAlerts(alerts);
  }

  // Save how the list's import went in its BanListSyncs row, as it was at the time now, and resolve
  // with the alerts its new state calls for, each with its text and its list's ID. They are only
  // given once the row is saved, and a row is saved once a run, so each is posted once. A list
  // removed during the run has its row removed with it, so nothing is saved for it. A row that
  // cannot be saved is left as it was, which never fails the list's import.
  async saveSync(banList, result, now = new Date()) {
    try {
      const outcome = {
        banList: banList.id,
        sourceKey: sourceKey(banList),
        now,
        selfImport: result.selfImport ?? null,
        accessLost: result.accessLost ?? null,
        error: result.error ?? null,
        held: result.held,
        storedCount: await retryOperation(() => Ban.count({ where: { banList: banList.id } })),
        // BattleMetrics' count of the list's bans, if the attempt got as far as asking for it.
        headTotal: 'firstMetaTotal' in result ? result.firstMetaTotal : undefined
      };
      const sync = nextSync(this.syncs.get(banList.id) ?? null, outcome);
      try {
        await retryOperation(() => BanListSync.upsert(sync.values, { fields: sync.fields }));
      } catch (err) {
        if (isMissingBanList(err)) return [];
        throw err;
      }

      if (sync.recovered)
        Logger.verbose(
          'BanImporter',
          2,
          `Ban list (ID: ${banList.id}) is back to normal: ${sync.recovered}.`
        );
      return sync.alerts.map((kind) => ({
        kind,
        banList: banList.id,
        text: describeAlert(kind, sync, outcome)
      }));
    } catch (err) {
      Logger.verbose(
        'BanImporter',
        2,
        `Could not save the sync state of ban list (ID: ${banList.id}): ${describeError(err)}`
      );
      return [];
    }
  }

  // Post alerts about lists. When many lists lose access at once, as isWidespread says, of the
  // BattleMetrics lists the run has tried, CBL's own token is the likelier cause, so their alerts
  // are posted as one, which says to check it before removing any of them.
  postAlerts(alerts) {
    const lost = alerts.filter(({ kind }) => kind === STATES.ACCESS_LOST);
    const together = isWidespread(lost.length, this.triedBattlemetrics.size);
    if (together)
      Logger.important(
        'BanImporter',
        describeWidespreadLoss(
          lost.map(({ banList }) => banList),
          this.triedBattlemetrics.size
        )
      );
    for (const { kind, text } of alerts)
      if (!together || kind !== STATES.ACCESS_LOST) Logger.important('BanImporter', text);
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

  // Remove the bans the list had before this run that it no longer has, a chunk at a time, each
  // chunk in one transaction that also queues its players for an update. Nothing is removed if the
  // list returned no bans, as it may be broken, or if it would lose many of its bans at once, unless
  // IMPORTER_ALLOW_MASS_REMOVAL names the list.
  async removeMissingBans(banList, bans, stored, result) {
    const fetched = new Set(bans.map((ban) => ban.id));
    const missing = stored.filter((ban) => !fetched.has(ban.id));
    if (missing.length === 0) return;

    result.massRemoval =
      bans.length === 0 ||
      missing.length >= Math.max(MASS_REMOVAL_BANS, stored.length * MASS_REMOVAL_SHARE);
    if (result.massRemoval && !this.allowMassRemoval.has(String(banList.id))) {
      result.held = missing.length;
      return;
    }

    for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
      const chunk = missing.slice(i, i + CHUNK_SIZE);
      await this.removeBans(banList, chunk);
      result.removed += chunk.length;
    }
  }

  // Remove the bans fetched from the list's old type or source, a chunk at a time as above, and
  // count those the list still had. Removing them is never held, as the new source's bans replace
  // them.
  async removeOldSourceBans(banList, bans, result) {
    result.sourceChanged = true;
    for (let i = 0; i < bans.length; i += CHUNK_SIZE)
      result.removed += await this.removeBans(banList, bans.slice(i, i + CHUNK_SIZE));
  }

  // Remove the bans from the list in one transaction that also queues their players for an update,
  // as they have lost a ban. Resolves with the number of bans removed.
  removeBans(banList, bans) {
    return retryOperation(() =>
      sequelize.transaction(async (transaction) => {
        await SteamUser.update(
          {
            lastRefreshedInfo: null,
            lastRefreshedExport: null,
            lastRefreshedReputationPoints: null,
            lastRefreshedReputationRank: null
          },
          { where: { id: [...new Set(bans.map((ban) => ban.steamUser))] }, transaction }
        );
        return Ban.destroy({
          where: { banList: banList.id, id: bans.map((ban) => ban.id) },
          transaction
        });
      })
    );
  }

  // Log one line about the list. A line about a list that needs looking at is logged as important,
  // so it reaches the log channel ahead of other messages and is never dropped for them. The others
  // only go to the console. A second attempt at a list is logged as important, as its first one
  // was. A list that imports a CBL export ban list, or that CBL cannot read, is posted about once,
  // when that starts (see saveSync), so its line otherwise only goes to the console, unless its
  // import failed. And once a list has been posted about as one CBL cannot read, before this run, a
  // failure that shows it again only goes to the console; any other failure of it, e.g. while
  // BattleMetrics is down, is posted as for any list.
  logResult(result) {
    const list = `ban list (ID: ${result.id})`;
    if (result.gone) {
      Logger.verbose('BanImporter', 2, `Skipped ${list}, as it was removed during the run.`);
      return;
    }
    if (result.selfImport) {
      Logger.verbose(
        'BanImporter',
        2,
        `Skipped ${list}, as its source is CBL's own export ban list (#${result.selfImport}), so none of its bans were fetched or removed.`
      );
      return;
    }

    const again = result.attempt > 1;
    const imported = `Imported ${list}${again ? ' at the second attempt' : ''}`;
    const counts = [
      `${result.fetched} bans fetched`,
      `${result.created} new`,
      `${result.updated} updated`
    ];
    if (result.removed > 0) counts.push(`${result.removed} removed`);
    if (result.failed > 0) counts.push(`${result.failed} failed to save (${result.failure})`);
    const progress = result.fetched > 0 ? ` (${counts.join(', ')})` : '';

    if (result.stopped) {
      // The import's summary leaves the list out, so this says what it saved before the run
      // stopped. The next run imports it again.
      Logger.important(
        'BanImporter',
        `Stopped importing ${list}${again ? ' at the second attempt' : ''} while ${result.stage}, as the run is stopping, so none of its bans were removed${progress}.`
      );
    } else if (result.error) {
      const removed =
        result.removed > 0
          ? `after removing ${result.removed} of its bans`
          : 'so none of its bans were removed';
      const line = `Failed to import ${list}${again ? ' again' : ''} while ${result.stage}, ${removed}${progress}. ${result.error}`;
      if (result.lostAgain) Logger.verbose('BanImporter', 2, line);
      else Logger.important('BanImporter', line);
    } else if (result.sourceChanged) {
      Logger.important(
        'BanImporter',
        `Removed the bans fetched for ${list}${again ? ' at the second attempt' : ''}, as its type or source was changed while it was imported${progress}. Its new source is imported on the next run.`
      );
    } else if (result.accessLost) {
      const line = `${imported}: ${counts.join(', ')}. None of its bans were checked for removal, as ${result.accessLost}.`;
      if (again) Logger.important('BanImporter', line);
      else Logger.verbose('BanImporter', 2, line);
    } else if (result.fetched === 0 && result.removed === 0 && result.stored > 0) {
      const none = result.rawCount > 0 ? 'no bans with a SteamID' : 'no bans';
      Logger.important(
        'BanImporter',
        `${imported}: it returned ${none}, so its ${result.stored} stored bans were kept in case the list is broken. If the list really is empty, set IMPORTER_ALLOW_MASS_REMOVAL=${result.id} for one run.`
      );
    } else if (result.held > 0) {
      Logger.important(
        'BanImporter',
        `${imported}: ${counts.join(', ')}. Kept the ${result.held} of its ${result.stored} stored bans that it no longer has, as removing at least ${MASS_REMOVAL_BANS} bans and ${MASS_REMOVAL_SHARE * 100}% of a list at once needs confirming. If the list really dropped them, set IMPORTER_ALLOW_MASS_REMOVAL=${result.id} for one run.`
      );
    } else if (result.massRemoval) {
      Logger.important(
        'BanImporter',
        `${imported}: ${counts.join(', ')}, as IMPORTER_ALLOW_MASS_REMOVAL names the list. Remove it from the setting once the removal is done.`
      );
    } else if (result.failed > 0 || again) {
      Logger.important('BanImporter', `${imported}: ${counts.join(', ')}.`);
    } else {
      Logger.verbose('BanImporter', 2, `${imported}: ${counts.join(', ')}.`);
    }
  }

  // Print one line for the whole import. It only goes to the console: the run's status message in
  // Discord shows the same totals, from the import's report. Bans that were kept as their removal
  // needs confirming are counted as held, not removed. When the run stopped part-way, the line sums
  // up the lists imported before it stopped, out of the listCount lists of the run, and leaves out
  // a list it stopped in the middle of, at either attempt, which has a line of its own.
  logSummary(results, { stopped = false, listCount = results.length } = {}) {
    const total = totals(results);
    const counts = [
      `${plural(total.fetched, 'ban')} fetched`,
      `${formatCount(total.new)} new`,
      `${formatCount(total.updated)} updated`,
      `${formatCount(total.removed)} removed`,
      `${formatCount(total.held)} held`,
      `${plural(total.failedLists, 'list')} failed`
    ];
    const lists =
      results.length < listCount
        ? `${formatCount(results.length)} of ${plural(listCount, 'ban list')}`
        : plural(results.length, 'ban list');
    Logger.verbose(
      'BanImporter',
      2,
      `Got ${plural(total.removed, 'deleted ban')}. Imported ${lists}${stopped ? ' before the run stopped' : ''}: ${counts.join(', ')}.`
    );
  }

  // The import's counts for the run record: its totals, as in its summary line, how the access
  // check went, and each list's own counts. An import that stopped part-way reports the lists its
  // summary line sums up.
  report() {
    return {
      lists: this.listCount,
      imported: this.results.length,
      ...totals(this.results),
      accessCheck: this.accessCheckResult,
      banLists: this.results.map(listReport)
    };
  }
}
