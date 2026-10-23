import { BanListSync } from 'scbl-lib/db/importer-models';
import { Ban, BanList, ExportBanList } from 'scbl-lib/db/models';
import {
  describeError,
  isSameBattlemetricsID,
  Logger,
  normaliseBattlemetricsID
} from 'scbl-lib/utils';

import {
  BATCH_SIZE,
  CONFIRM_AFTER,
  clearPendingRemovals,
  diffBans,
  flagOf,
  isMissingBanList,
  planRemovals,
  readPendingRemovals,
  readPendingSummary,
  readStoredBans,
  readStoredBansByID,
  releaseHeldRemovals,
  removeBans,
  retryOperation,
  savePendingRemovals,
  timeOf,
  writeBans
} from './apply-list.js';
import BanFetcher from './ban-fetcher.js';
import {
  accessProblem,
  describeAlert,
  describeWidespreadLoss,
  isWidespread,
  nextSync,
  NOT_VISIBLE,
  readAccessCheck,
  readBanListIDs,
  readSwitch,
  readVisibleBanLists,
  sourceKey,
  stateOf,
  STATES,
  UNCONFIRMED
} from './ban-list-sync.js';
import {
  checkHead,
  compareReads,
  fullScanSlots,
  pagesOf,
  planRead,
  readFullScanMinutes,
  readHeadUids,
  REASONS,
  scheduleAfter,
  shouldFollow
} from './planner.js';
import {
  checkRunLock,
  LOCK_LOST,
  pause,
  reportProgress,
  RunStopped,
  stopIfRequested
} from './run-control.js';

// A list that could not be fetched is tried again once the others are done, after this wait, so a
// short outage of its source has time to pass. A run that is asked to stop does not wait.
const SECOND_ATTEMPT_DELAY = 60 * 1000;

// Marks a list that was removed while its bans were being saved.
const LIST_REMOVED = Symbol('ban list removed');

// At most this many of a list's new, changed, moved or removed bans each get a line of their own in
// the console in a run.
const MAX_LOGGED_CHANGES = 100;

// A remote list's file is asked about again, rather than read, only when the list was last
// imported from it in full, with nothing kept back. Otherwise its row forgets the file.
const NO_FILE = Object.freeze({ etag: null, lastModified: null, bodyHash: null });

// A count written with thousands separators, e.g. 86,919.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

function plural(count, noun) {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// A length of time in seconds, to the hundredth, as the run record gives its phases'.
function seconds(ms) {
  return Math.round(ms / 10) / 100;
}

// A length of time for a line, in seconds, to the tenth, e.g. 76.3s, as the BattleMetrics client
// gives its time limits.
function secondsText(ms) {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

// What the import of a list was doing when it failed, as its line says it: the stage, and for a
// BattleMetrics list that failed on one of its pages, the page, and how many pages a read of all of
// the list takes, about, when that is known and not already passed, e.g. fetching page 37 of about
// 93.
function describeStage({ stage, page, pages }) {
  if (!page) return stage;
  const of = pages >= page ? ` of about ${formatCount(pages)}` : '';
  return `fetching page ${formatCount(page)}${of}`;
}

// Log a line for each of the items, at most MAX_LOGGED_CHANGES of them, and then how many more there
// were, in the console.
function logEach(items, describe) {
  for (const item of items.slice(0, MAX_LOGGED_CHANGES))
    Logger.verbose('BanImporter', 2, describe(item));
  if (items.length > MAX_LOGGED_CHANGES)
    Logger.verbose(
      'BanImporter',
      2,
      `...and ${formatCount(items.length - MAX_LOGGED_CHANGES)} more.`
    );
}

// The bans given, with a ban that is given twice, e.g. on two pages, kept once.
function uniqueBans(bans) {
  const unique = new Map();
  for (const ban of bans) if (!unique.has(ban.id)) unique.set(ban.id, ban);
  return [...unique.values()];
}

// Whether a list's source refused it, e.g. as the list was deleted or CBL lost access to it, so it
// would only be refused again later in the run. A timeout (408) or rate limit (429) can pass.
function isRefused(err) {
  const status = err.status ?? err.response?.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// The import's totals, as its summary line and the run record give them. Bans kept that a list no
// longer has are counted as held, and of those, the ones that wait for a later complete read of
// their list as pending too, for a list only polled as the run found them at its start, so the
// totals do not drop to 0 on runs that only poll a list whose bans are kept. The run record also
// counts the bans whose player is no longer one of their SteamIDs, the lists that import one of
// CBL's own export ban lists, those CBL can no longer read on BattleMetrics, and the lists that
// were only polled and those that were read in full.
function totals(results) {
  const sum = (field) => results.reduce((total, result) => total + result[field], 0);
  return {
    fetched: sum('fetched'),
    new: sum('created'),
    updated: sum('updated'),
    removed: sum('removed'),
    held: sum('held'),
    pending: sum('pending'),
    moves: sum('moves'),
    failedLists: results.filter((result) => result.error).length,
    selfImports: results.filter((result) => result.selfImport).length,
    accessLost: results.filter((result) => result.accessLost).length,
    headPolls: results.filter((result) => result.read === 'head').length,
    fullReads: results.filter((result) => result.read === 'full').length
  };
}

// A list's counts for the run record, with how long its import took in the run, in seconds, both
// attempts together when it was tried again, how it was read, and why it was read in full, and what
// went wrong or was unusual, when anything was: for a list that failed on one of its pages, the
// page too.
function listReport(result) {
  const report = {
    id: result.id,
    fetched: result.fetched,
    new: result.created,
    updated: result.updated,
    removed: result.removed,
    held: result.held,
    seconds: seconds(result.ms ?? 0)
  };
  if (result.read) report.read = result.read;
  if (result.reason) report.reason = result.reason;
  if (result.drift) report.drift = result.drift;
  if (result.stored !== undefined) report.stored = result.stored;
  if (result.pending > 0) report.pending = result.pending;
  if (result.hold) report.hold = result.hold;
  if (result.moves > 0) report.moves = result.moves;
  if (result.state && result.state !== STATES.OK) report.state = result.state;
  if (result.failed > 0) report.failedToSave = result.failed;
  if (result.attempt > 1) report.attempt = result.attempt;
  if (result.gone) report.gone = true;
  if (result.unchanged) report.unchanged = true;
  if (result.complete === false) report.incomplete = true;
  if (result.replace) report.replace = true;
  if (result.sourceChanged) report.sourceChanged = true;
  if (result.massRemoval) report.massRemoval = true;
  if (result.error) Object.assign(report, { error: result.error, stage: result.stage });
  if (result.page) report.page = result.page;
  return report;
}

export default class BanImporter {
  constructor(options) {
    options = {
      // The IDs of the ban lists, separated by commas, that may lose any number of bans this run.
      allowMassRemoval: process.env.IMPORTER_ALLOW_MASS_REMOVAL,
      // Whether the run checks which BattleMetrics ban lists the CBL organisation can see.
      accessCheck: process.env.IMPORTER_ACCESS_CHECK,
      // Whether a read of all of a BattleMetrics list must have read as many bans as BattleMetrics
      // counts on it before any of its bans may be removed.
      countCheck: process.env.IMPORTER_SCAN_COUNT_CHECK,
      // The IDs of the ban lists, separated by commas, that the count check leaves out.
      countCheckSkip: process.env.IMPORTER_SCAN_COUNT_CHECK_SKIP,
      // Whether the run only says what the import would change, and writes nothing.
      dryRun: process.env.IMPORTER_DRY_RUN,
      // Whether a ban whose player is no longer one of its SteamIDs is moved to another of them.
      applySteamIDMoves: process.env.IMPORTER_APPLY_STEAMID_MOVES,
      // Whether a BattleMetrics list that is not due a full read only has its newest page read.
      headPoll: process.env.IMPORTER_HEAD_POLL,
      // Whether a head poll compares BattleMetrics' count of a list's bans with its count at the
      // list's last read and the new bans, and reads the list in full when they do not match.
      drift: process.env.IMPORTER_DRIFT,
      // How often each list is read in full, in minutes.
      fullScanMinutes: process.env.IMPORTER_FULL_SCAN_MINUTES,
      // How many bans are written, or removed, in one transaction.
      batchSize: BATCH_SIZE,
      // How the import tells the time, in milliseconds since 1970: when it plans its reads, when
      // each attempt at a list ends, which the list's row keeps, and how long each list takes.
      clock: () => Date.now(),
      ...options
    };

    this.batchSize = options.batchSize;
    this.clock = options.clock;
    this.allowMassRemoval = readBanListIDs(options.allowMassRemoval);
    this.countCheckSkip = readBanListIDs(options.countCheckSkip);
    const accessCheck = readAccessCheck(options.accessCheck);
    const countCheck = readSwitch('IMPORTER_SCAN_COUNT_CHECK', options.countCheck, {
      defaultOn: true,
      meaning: 'the count check stays on'
    });
    const dryRun = readSwitch('IMPORTER_DRY_RUN', options.dryRun, {
      defaultOn: false,
      invalidOn: true,
      meaning: 'the run is a dry run, which writes nothing'
    });
    const applySteamIDMoves = readSwitch(
      'IMPORTER_APPLY_STEAMID_MOVES',
      options.applySteamIDMoves,
      { defaultOn: false, meaning: 'no ban is moved to another of its SteamIDs' }
    );
    const headPoll = readSwitch('IMPORTER_HEAD_POLL', options.headPoll, {
      defaultOn: true,
      invalidOn: false,
      meaning: 'every list is read in full on every run'
    });
    const drift = readSwitch('IMPORTER_DRIFT', options.drift, {
      defaultOn: true,
      meaning: "head polls still compare BattleMetrics' counts"
    });
    const fullScan = readFullScanMinutes(options.fullScanMinutes);
    // The warnings about invalid settings are posted once the run imports. An invalid
    // IMPORTER_DRY_RUN stops the import instead, as the run cannot tell whether it may write, and
    // until then the run is taken to be a dry run, so it runs no other step.
    this.warnings = [accessCheck, countCheck, applySteamIDMoves, headPoll, drift, fullScan]
      .map(({ warning }) => warning)
      .filter(Boolean);
    this.dryRunError = dryRun.invalid
      ? `IMPORTER_DRY_RUN must be 1 or 0, not "${options.dryRun}", so the run imported nothing, as it cannot tell whether it may write. Set it to 1 for a dry run, or to 0 or nothing for a run that writes.`
      : null;
    this.accessCheck = accessCheck.on;
    this.countCheck = countCheck.on;
    this.dryRun = dryRun.on;
    this.applySteamIDMoves = applySteamIDMoves.on;
    this.headPoll = headPoll.on;
    this.drift = drift.on;
    this.fullScanMinutes = fullScan.minutes;
    // The BattleMetrics requests the import made, by what they were for: a list's newest page
    // (head), the pages a head poll followed after it (follow), and the other pages of reads of all
    // of a list (full). Each is a request the import asked for, as the BattleMetrics client's own
    // retries are not counted.
    this.requests = { head: 0, follow: 0, full: 0 };
    // Lists are read newest first for head polls, and otherwise in BattleMetrics' own order, as
    // before head polls.
    this.fetcher = new BanFetcher({
      countCheck: this.countCheck,
      countCheckSkip: this.countCheckSkip,
      newestFirst: this.headPoll,
      requests: this.requests
    });

    // The number of ban lists the import started with, and a result for each list it imported, and
    // the result of the list it was importing when the run stopped, if it stopped part-way through
    // one, which is not one of them (see importBanList).
    this.listCount = 0;
    this.results = [];
    this.stopped = null;

    // What the run read at its start: each list's BanListSyncs row, by list, the bans of each list
    // that wait for a confirming read or are held for an admin (see readPendingSummary), when the
    // run planned its reads, and CBL's own export ban lists on BattleMetrics. The access check is
    // read once, for the first BattleMetrics list, and its result is ok, failed, off or unused,
    // when no BattleMetrics list needed it. The IDs of the BattleMetrics lists the run tried are
    // kept, to tell how widespread a loss of access is, and the rows that wait to be saved until
    // the first pass is over, by list (see importBanList). The run's settings say how often runs
    // start (cadenceSeconds), or null when they do not, and each BattleMetrics list has its slot in
    // IMPORTER_FULL_SCAN_MINUTES, from the lists' rows (see fullScanSlots), at which its next
    // periodic full read is due once it is read in full.
    this.syncs = new Map();
    this.pending = new Map();
    this.plannedAt = this.clock();
    this.cadenceSeconds = null;
    this.slots = new Map();
    // The reasons polls found in the run to read lists in full, by list (see pollHead).
    this.found = new Map();
    this.exportBanLists = [];
    this.visibleBanLists = null;
    this.accessCheckResult = this.accessCheck ? 'unused' : 'off';
    // How long the access check took, in milliseconds, once it has been read.
    this.accessCheckMs = null;
    this.triedBattlemetrics = new Set();
    this.pendingSyncs = new Map();
    // Whether the warnings about the settings have been posted, which the first import does.
    this.warned = false;
  }

  // Import every ban list. settings are the run's, as the run gives its steps (see run.js and
  // loop.js), which say how often runs start, and so when each list's next periodic full read is
  // due (see nextFullScan in planner.js): in loop mode, how often the service's cycles start
  // (cycleSeconds, IMPORTER_CYCLE_SECONDS), whatever IMPORTER_CADENCE_SECONDS says, as that only
  // sets when the service is stale and the Steam step's budget there, and in once mode the run's
  // cadence (cadenceSeconds, IMPORTER_CADENCE_SECONDS), how often the script starts a run.
  async importBans({ cadenceSeconds = null, cycleSeconds = null } = {}) {
    // What the last import found and reported is cleared before anything else, so an import that
    // fails before it imports any list, e.g. as the database cannot be read, reports nothing rather
    // than the last one's counts: in loop mode, the importer service imports with the same
    // importer every cycle. The requests are counted in place, as the fetcher counts them too.
    const every = cycleSeconds ?? cadenceSeconds;
    this.cadenceSeconds = Number.isFinite(every) && every > 0 ? every : null;
    this.listCount = 0;
    this.results = [];
    this.stopped = null;
    this.accessCheckMs = null;
    for (const kind of Object.keys(this.requests)) this.requests[kind] = 0;
    this.accessCheckResult = this.accessCheck ? 'unused' : 'off';
    this.visibleBanLists = null;
    this.triedBattlemetrics.clear();
    this.pendingSyncs.clear();
    this.found.clear();

    // An invalid IMPORTER_DRY_RUN stops the import before it reads anything. Invalid values of the
    // other settings are posted, as the run goes on with the safer choice, which may not be what
    // was meant, and so is a dry run, which may have been left on by mistake. They are posted on
    // the first import only, and later ones print them in the console: in loop mode, the importer
    // service imports every cycle with the same settings, and would otherwise post them every few
    // minutes.
    if (this.dryRunError) throw new Error(this.dryRunError);
    const warn = this.warned
      ? (line) => Logger.verbose('BanImporter', 2, line)
      : (line) => Logger.important('BanImporter', line);
    this.warned = true;
    for (const warning of this.warnings) warn(warning);
    if (this.dryRun)
      warn(
        'IMPORTER_DRY_RUN is on, so this run writes nothing: it only says what the import would change.'
      );

    Logger.verbose('BanImporter', 2, 'Fetching ban lists to import...');
    const banLists = await retryOperation(() =>
      BanList.findAll({ attributes: ['id', 'type', 'source'] })
    );
    Logger.verbose('BanImporter', 2, `Fetched ${banLists.length} ban lists to import.`);
    if (!this.headPoll)
      Logger.verbose(
        'BanImporter',
        2,
        'IMPORTER_HEAD_POLL is off, so every list is read in full on every run, in the order BattleMetrics gives its bans.'
      );
    else if (!this.drift)
      Logger.verbose(
        'BanImporter',
        2,
        `IMPORTER_DRIFT is off, so the bans a list no longer has are only found when it is read in full, every ${plural(this.fullScanMinutes, 'minute')} (IMPORTER_FULL_SCAN_MINUTES).`
      );
    if (!this.countCheck)
      Logger.verbose(
        'BanImporter',
        2,
        "IMPORTER_SCAN_COUNT_CHECK is off, so a BattleMetrics list read to its last page counts as read in full, whatever BattleMetrics' count of its bans."
      );
    else if (this.countCheckSkip.size > 0)
      Logger.verbose(
        'BanImporter',
        2,
        `IMPORTER_SCAN_COUNT_CHECK_SKIP turns the count check off for ban lists ${[
          ...this.countCheckSkip
        ].join(', ')}, so each of them read to its last page counts as read in full.`
      );
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
    // Which lists have bans that a complete read would now remove, as they wait for one, decides
    // which are read in full, so if it cannot be read, nothing is imported either.
    this.pending = await retryOperation(() => readPendingSummary());

    // Each list's read is planned once the run knows the lists' rows: its newest page only, or all
    // of it, and why (see planner.js). The lists only polled are read first, so their new bans are
    // saved within seconds, then those read in full, the most urgent first. Each list's read is
    // planned again as it is read, from the list as it is then. The BattleMetrics lists that are
    // read share IMPORTER_FULL_SCAN_MINUTES by their pages, which gives each its slot.
    this.slots = fullScanSlots(
      banLists
        .filter((banList) => banList.type === 'battlemetrics' && !this.findExportBanList(banList))
        .map(({ id }) => ({ id, pages: pagesOf(this.syncs.get(id)) ?? 1 })),
      this.fullScanMinutes
    );
    // The lists read in full as their time has come are read the one read in full longest ago
    // first (see compareReads).
    this.plannedAt = this.clock();
    const order = banLists
      .map((banList) => ({
        id: banList.id,
        ...this.planFor(banList),
        lastFullScanAt: this.syncs.get(banList.id)?.lastFullScanAt ?? null
      }))
      .sort(compareReads);
    if (!this.accessCheck)
      Logger.verbose(
        'BanImporter',
        2,
        'IMPORTER_ACCESS_CHECK is off, so this run does not check which BattleMetrics ban lists the CBL organisation can see.'
      );

    Logger.verbose('BanImporter', 2, 'Fetching ban lists...');

    // Each list is fetched, saved and, when it is read in full, checked for removed bans before the
    // next one is started, in the order planned. A run that is asked to stop does so between ban
    // lists, after summing up the lists it imported.
    // The results are kept for the run record, which report() gives them to. The run's status
    // shows how many lists are done.
    this.listCount = banLists.length;
    const { results } = this;
    try {
      reportProgress(0, banLists.length, 'ban lists');
      for (const { id } of order) {
        stopIfRequested();
        results.push(await this.importBanList(id));
        reportProgress(results.length, banLists.length, 'ban lists');
      }

      // A list that could not be fetched, e.g. during a short BattleMetrics outage, or not read in
      // full, is tried once more after the others. Not when every list failed that way, as their
      // sources are then down; a list that was not fetched, as it imports a CBL export ban list,
      // says nothing about that. A run that is asked to stop, before or during the wait, tries no
      // list again.
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
            // The list's time in the run is that of both of its attempts.
            results[index] = await this.importBanList(failed.id, 2);
            results[index].ms += failed.ms;
          } catch (err) {
            // A list whose second attempt is stopped part-way is left out of the summary, as one
            // stopped in the first pass is, since its own line says what the attempt saved. The
            // report gives it on its own, with the time of both of its attempts.
            if (err instanceof RunStopped) {
              results.splice(index, 1);
              if (this.stopped?.id === failed.id) this.stopped.ms += failed.ms;
            }
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

  // Import a ban list, read as planFor plans it. A list read in full has its new and changed bans
  // saved, then the bans it no longer has removed, by the rules of planRemovals, or the bans of its
  // old source if its type or source was changed meanwhile, also when the run was asked to stop
  // while they were saved. A list that is only polled has the new and changed bans on its newest
  // pages saved, and none removed (see pollHead), unless the poll finds that it needs to be read in
  // full after all, which it then is, or that its type or source was changed meanwhile, when the
  // bans it fetched are removed as for a read in full. A list that cannot be fetched or saved keeps
  // all of its stored bans, as does a list whose import is stopped part-way because the run was
  // asked to stop, which then throws RunStopped. So does a list that imports one of CBL's own
  // export ban lists, which is not fetched at all, and one CBL can no longer read on BattleMetrics.
  // A list that was not read in full has its new and changed bans saved, but fails, and keeps all
  // its stored bans. A list whose type or source was changed since its last import has its old bans
  // replaced by the new source's. In a dry run, nothing is written: the counts say what the import
  // would have done.
  //
  // How the import went is then saved in the list's BanListSyncs row: at once, or, in the first
  // pass, for a list to be tried again or one CBL cannot read, once every list has been tried. By
  // then the run knows whether it tries the list again, which saves the row instead, so a first
  // attempt the second one makes good is never counted or posted about. And many lists losing
  // access at once can then be posted about together.
  async importBanList(id, attempt = 1) {
    // How long the attempt took, in milliseconds (ms), once it has ended, without the time it
    // waited for the run's access check, which the first BattleMetrics list of the run waits for and
    // the report gives on its own (see readAccess), so that list does not look slow.
    const startedAt = this.clock();
    let accessWait = 0;
    const result = {
      id,
      attempt,
      fetched: 0,
      created: 0,
      updated: 0,
      failed: 0,
      removed: 0,
      held: 0,
      pending: 0,
      moves: 0,
      ms: 0
    };
    // What the import of the list is doing, which a failure is reported as having failed at.
    const at = { stage: 'reading it' };
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
      result.incompleteBefore = this.wasIncomplete(banList);
      const checkStartedAt = this.clock();
      const visible = await this.checkAccess(banList);
      accessWait = this.clock() - checkStartedAt;
      if (visible === false) result.accessLost = NOT_VISIBLE;
      else if (visible === null && result.lostBefore) result.accessLost = UNCONFIRMED;

      // A list whose type or source was changed since its row was saved, by hand or with /banlist
      // update, has its old source's bans replaced by those of its new source. As that may take
      // more than one run, its row says so until it is done.
      const before = this.syncs.get(banList.id);
      result.replace =
        Boolean(before) &&
        (before.sourceKey !== sourceKey(banList) || flagOf(before.replacePending) === true);

      // A list that is not due to be read in full only has its newest pages polled. The poll is all
      // it needs, unless its pages are all of the list, or show that it needs to be read in full,
      // when the read it began is read on to the list's last page.
      const plan = this.planFor(banList);
      result.read = plan.read;
      if (plan.reason) result.reason = plan.reason;
      // A second attempt at a list whose poll found a reason to read it in full keeps that reason,
      // should its own read not complete either.
      const trigger = this.found.get(banList.id);
      if (trigger) result.trigger = trigger;
      let read = null;
      if (plan.read === 'head') {
        read = await this.pollHead(banList, before, result, at);
        if (!read) return result;
      }

      // The fetcher stops between pages if the run is asked to stop, and so does the import once
      // the list is fetched, before any of it is saved.
      at.stage = 'fetching it';
      const scan = await this.fetcher.fetchBanList(banList, {
        previous: this.lastFile(banList, before, result),
        read
      });
      Object.assign(result, {
        fetched: scan.bans.length,
        rawCount: scan.rawCount,
        firstMetaTotal: scan.firstMetaTotal,
        complete: scan.complete
      });
      if (scan.remote) result.remote = scan.remote;
      stopIfRequested();

      // The bans the list had before this run, which is what its losses are measured against, and
      // those that earlier complete reads of it did not have.
      at.stage = 'reading its stored bans';
      const stored = await retryOperation(() => readStoredBans(banList.id));
      const pending = await retryOperation(() => readPendingRemovals(banList.id));
      result.stored = stored.length;

      // A remote list whose file is the one it was last imported from has the bans it has stored,
      // of which only whether each has expired can have changed since.
      let bans = scan.bans;
      if (scan.unchanged) {
        const now = Date.now();
        bans = stored.map((ban) => ({
          ...ban,
          expired: ban.expires !== null && timeOf(ban.expires) <= now
        }));
        result.unchanged = true;
        result.fetched = bans.length;
      }

      // Only the bans that are new or changed are written.
      at.stage = 'saving its bans';
      const diff = diffBans(bans, stored, { applyMoves: this.applySteamIDMoves });
      result.moves = diff.moves.length;
      this.logChanges(banList, diff);
      if (this.dryRun) {
        result.created = diff.added.length;
        result.updated = diff.changed.length;
      } else if (!(await this.saveBans(banList, diff, result))) {
        result.gone = true;
        return result;
      }
      // Once its bans are saved, the list's newest page is the one its head polls compare theirs
      // with, if it was read newest first.
      if (scan.head !== undefined) result.head = scan.head;

      // The list's type or source may have been changed since it was read, by hand or by a
      // /banlist update made just as the run started. The bot deletes the list's bans with the
      // change, but this run may have saved some of the old source's bans again since, so the bans
      // fetched from it are removed instead of the bans the list no longer has. That is so even
      // when the run was asked to stop while they were saved, as they are of a source the list no
      // longer has, so the list is read again before the run stops. The new source is imported on
      // the next run.
      at.stage = 'reading it again';
      const current = await retryOperation(() =>
        BanList.findByPk(id, { attributes: ['id', 'type', 'source'] })
      );
      if (!current) {
        result.gone = true;
        return result;
      }
      const sourceChanged = current.type !== banList.type || current.source !== banList.source;

      // Removing bans must not happen in two runs at once, so it needs the run lock. A removal that
      // has started is finished, whatever happens meanwhile.
      await checkRunLock();
      if (sourceChanged) {
        at.stage = 'removing the bans of its old source';
        await this.removeOldSourceBans(banList, bans, stored, result);
        return result;
      }

      // A run that was asked to stop while the bans were saved ends here, once the batch under way
      // has been saved, as does one asked to stop since. So a list whose saves were cut short is
      // never swept, as its unsaved bans would look removed. A list CBL cannot read, or may still
      // not be able to, is never swept, and nor is a list that was not read in full.
      at.stage = 'saving its bans';
      stopIfRequested();
      if (!result.accessLost) {
        if (!scan.complete) {
          // The bans the read found are not missing, whatever else it missed. Those held for an
          // admin keep their records, for the next complete read to find that they came back.
          at.stage = 'checking that it was read in full';
          const found = new Set(bans.map((ban) => ban.id));
          if (!this.dryRun)
            await clearPendingRemovals(
              banList.id,
              [...pending]
                .filter(([banId, { heldAt }]) => found.has(banId) && heldAt === null)
                .map(([banId]) => banId),
              { batchSize: this.batchSize }
            );
          throw Object.assign(new Error(`${scan.incomplete}.`), { incomplete: true });
        }
        at.stage = 'removing the bans it no longer has';
        await this.removeMissingBans(banList, bans, stored, pending, result);
      }
      return result;
    } catch (err) {
      const { stage } = at;
      result.stage = stage;
      // A list that failed, or was stopped, on one of its pages says which, and how many a read of
      // all of it takes, about, from BattleMetrics' count on its first page, or before that, from
      // its row.
      if (stage === 'fetching it' && Number.isInteger(err?.page))
        Object.assign(result, {
          page: err.page,
          pages: Number.isInteger(err.pages) ? err.pages : pagesOf(this.syncs.get(id))
        });
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
      // A list whose source failed in a way that can pass, or that was not read in full, is tried
      // again after the other lists. Not a list whose last run did not read it in full either, as
      // its count more likely stays off: its failure was posted when it started, so this one only
      // goes to the console, and the alert for failing runs in a row says if it lasts.
      result.incompleteAgain = err.incomplete === true && result.incompleteBefore;
      result.retry =
        (stage === 'fetching it' || (err.incomplete === true && !result.incompleteAgain)) &&
        attempt === 1 &&
        !isRefused(err) &&
        !lost;
      return result;
    } finally {
      const now = this.clock();
      result.ms = now - startedAt - accessWait;
      // A list stopped part-way is left out of the import's results, and the report gives it on its
      // own (see report).
      if (result.stopped) this.stopped = result;
      if (!result.gone && !result.stopped) result.state = stateOf(result);
      this.logResult(result);
      // A second attempt that ends, saved or not, takes the place of the first one's row. One that
      // is stopped leaves it, to be saved as the run stops. A dry run saves no row.
      if (attempt > 1 && !result.stopped) this.pendingSyncs.delete(id);
      if (banList && !result.gone && !result.stopped && !this.dryRun) {
        if (attempt === 1 && (result.retry || result.accessLost))
          this.pendingSyncs.set(id, { banList, result, now: new Date(now) });
        else this.postAlerts(await this.saveSync(banList, result, new Date(now)));
      }
    }
  }

  // How the list is read this run, by planRead (see planner.js): from its row from before the run,
  // the bans it has that wait for a confirming read or are held for an admin, whether
  // IMPORTER_ALLOW_MASS_REMOVAL names it, the settings, how often runs start, and when the run
  // planned its reads. A list whose poll found a reason to read it in full earlier in the run is
  // read in full for it, from its first page, without polling it again.
  planFor(banList) {
    const trigger = this.found.get(banList.id);
    if (trigger) return { read: 'full', reason: trigger };
    return planRead({
      type: banList.type,
      row: this.syncs.get(banList.id) ?? null,
      sourceKey: sourceKey(banList),
      pending: this.pending.get(banList.id) ?? null,
      allowMassRemoval: this.allowMassRemoval.has(String(banList.id)),
      now: this.plannedAt,
      headPoll: this.headPoll,
      fullScanMinutes: this.fullScanMinutes,
      cadenceSeconds: this.cadenceSeconds
    });
  }

  // Poll a BattleMetrics list: read its newest page, and the pages after it while they hold only
  // bans the poll has not seen, as after a burst of new bans, for at most MAX_HEAD_PAGES pages in
  // all, and save the new and changed bans on them. None of the list's bans are removed, unless its
  // type or source was changed while it was polled, when the bans the poll fetched are, as a read
  // in full removes them. A ban has been seen when it was on the list's newest page at its last
  // read (its row's headUids), or is stored. Only the stored bans on the pages read are read from
  // the database. Returns null when that is all the list needs, or else the read, to be read on to
  // the list's last page as a read of all of the list (see checkHead), with nothing saved here:
  // - when the pages read are all of the list already;
  // - when they hold only new bans, and as many pages as a poll follows (overflow);
  // - when BattleMetrics' count of the list's bans is not its count at the list's last read plus
  //   the new bans (drift), which only a read of all of it can explain.
  // The read of all of the list saves the bans on the pages with the rest, so what the list lost is
  // measured against the bans it had before the run, as for any read in full: had the poll saved its
  // new bans first, a list whose source now gives none of its old bans, only more new ones than a
  // poll follows, would not seem to have lost all of its bans, and would not be held for an admin.
  // A read in full that fails saves none of them, as for any read in full, until the list is read in
  // full again. A list that was held stays so, as a poll does not check for removed bans.
  async pollHead(banList, before, result, at) {
    at.stage = 'fetching it';
    const read = await this.fetcher.fetchBattlemetricsHead(banList);
    const known = new Set(readHeadUids(before?.headUids) ?? []);
    const stored = new Map();
    const prefix = `${banList.id},`;
    while (read.next) {
      // A page's stored bans say whether it has bans the poll has seen, and so whether the next page
      // is needed.
      at.stage = 'reading its stored bans';
      const ids = read.pages.at(-1).bans.map((ban) => ban.id);
      for (const row of await retryOperation(() => readStoredBansByID(banList.id, ids))) {
        stored.set(row.id, row);
        known.add(row.id.slice(prefix.length));
      }
      if (!shouldFollow(read.pages, known)) break;
      at.stage = 'fetching it';
      await this.fetcher.followBattlemetrics(read);
    }
    const head = checkHead({
      pages: read.pages,
      known,
      previousTotal: before?.headTotal,
      drift: this.drift
    });
    if (head.complete) return read;

    const trigger = head.overflow ? REASONS.OVERFLOW : head.drift ? REASONS.DRIFT : null;
    if (trigger) {
      // The list is read in full after all, for the reason the poll found, which a second attempt
      // at it keeps.
      Object.assign(result, { read: 'full', reason: trigger, trigger });
      this.found.set(banList.id, trigger);
      const pages =
        read.pages.length === 1 ? 'newest page' : `newest ${formatCount(read.pages.length)} pages`;
      if (head.drift) {
        result.drift = head.drift;
        Logger.verbose(
          'BanImporter',
          2,
          `Reading ban list (ID: ${banList.id}) in full, as BattleMetrics counts ${plural(head.drift.total, 'ban')} on it, but its count at its last read and the ${plural(head.newBans, 'new ban')} on its ${pages} make ${formatCount(head.drift.expected)}, so a ban was removed, or added below its ${pages}.`
        );
      } else
        Logger.verbose(
          'BanImporter',
          2,
          `Reading ban list (ID: ${banList.id}) in full, as its ${pages} hold only new bans.`
        );
      return read;
    }

    const bans = uniqueBans(read.pages.flatMap((page) => page.bans));
    result.fetched = bans.length;
    at.stage = 'saving its bans';
    const diff = diffBans(bans, [...stored.values()], { applyMoves: this.applySteamIDMoves });
    result.moves = diff.moves.length;
    this.logChanges(banList, diff);
    if (this.dryRun) {
      result.created = diff.added.length;
      result.updated = diff.changed.length;
    } else if (!(await this.saveBans(banList, diff, result))) {
      result.gone = true;
      return null;
    }

    // The list's type or source may have been changed while it was polled, by /banlist update,
    // which deletes the list's bans and saves the change in one transaction. A batch of the poll's
    // bans written while that transaction is under way waits for it, and is then saved, which would
    // leave the old source's bans on the list. So the list is read again once its bans are saved,
    // as a read in full reads it (see importBanList), and if its type or source has changed, the
    // bans the poll fetched are removed, as they are of a source the list no longer has. That is so
    // even when the run was asked to stop while they were saved, e.g. while a batch waited for the
    // bot's transaction, so the list is read again before the run stops. A change saved after this
    // read deletes the poll's bans with the list's others, as they were saved before it, unless
    // /banlist update counted none on the list, which leaves them for the next full read to
    // replace. The list's row keeps the old source's key, so the next run reads the new source in
    // full.
    at.stage = 'reading it again';
    const current = await retryOperation(() =>
      BanList.findByPk(banList.id, { attributes: ['id', 'type', 'source'] })
    );
    if (!current) {
      result.gone = true;
      return null;
    }
    if (current.type !== banList.type || current.source !== banList.source) {
      // Removing bans needs the run lock, as for any list. A removal that has started is finished,
      // whatever happens meanwhile, and a run asked to stop stops at its next safe point.
      await checkRunLock();
      at.stage = 'removing the bans of its old source';
      await this.removeOldSourceBans(banList, bans, [...stored.values()], result);
      return null;
    }

    // A run that was asked to stop while the bans were saved ends here, once the batch under way
    // has been saved, as does one asked to stop since, and the list keeps its row: its newest page
    // and count are only saved with all the bans on the pages, so the next poll still finds the
    // bans not saved, on its newest page as new ones, or below it by drift.
    at.stage = 'saving its bans';
    stopIfRequested();

    // Once its bans are saved, the list's newest page, with its count, is the one its next poll
    // compares its own with. The bans the list kept for now, as the run found them at its start,
    // are still kept, as a poll removes none: those held for an admin, and those that wait for a
    // confirming read, which are pending too. So a list that was held stays so.
    const [newest] = read.pages;
    result.head = { uids: newest.uids, total: newest.total };
    result.firstMetaTotal = newest.total;
    result.stillHeld = before?.state === STATES.HELD;
    const kept = this.pending.get(banList.id);
    if (kept) Object.assign(result, { held: kept.held + kept.waiting, pending: kept.waiting });
    return null;
  }

  // Whether CBL had lost access to the list, by its row from before the run, for its current type
  // and source: a list whose source was changed starts afresh.
  hadLostAccess(banList) {
    const before = this.syncs.get(banList.id);
    return before?.state === STATES.ACCESS_LOST && before.sourceKey === sourceKey(banList);
  }

  // Whether the list's last read of all of it was not complete, by its row from before the run, for
  // its current type and source.
  wasIncomplete(banList) {
    const before = this.syncs.get(banList.id);
    return before?.sourceKey === sourceKey(banList) && Number(before.incompleteScans) > 0;
  }

  // The file a remote list was last imported from in full, by its row (before): its ETag,
  // Last-Modified and SHA-256, so its host can be asked whether the file has changed. None for a
  // list whose bans are being replaced, or whose row has none of them.
  lastFile(banList, before, result) {
    if (banList.type !== 'remote' || !before || result.replace) return null;
    const file = {
      etag: before.remoteEtag ?? null,
      lastModified: before.remoteLastModified ?? null,
      bodyHash: before.remoteBodyHash ?? null
    };
    return file.etag || file.lastModified || file.bodyHash ? file : null;
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
  // cannot be read, which the console is told of. How long that took is kept for the report.
  async readAccess() {
    const startedAt = this.clock();
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
    } finally {
      this.accessCheckMs = this.clock() - startedAt;
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
  async saveSync(banList, result, now = new Date(this.clock())) {
    try {
      const battlemetrics = banList.type === 'battlemetrics';
      const outcome = {
        banList: banList.id,
        sourceKey: sourceKey(banList),
        now,
        selfImport: result.selfImport ?? null,
        accessLost: result.accessLost ?? null,
        error: result.error ?? null,
        held: result.held,
        stillHeld: result.stillHeld === true,
        // The list's newest page, once the bans on it are saved, which its head polls compare
        // theirs with, and when the list is next due to be read in full, and why. With head polls
        // off, the list forgets its newest page, whatever the attempt did, so once they are on
        // again it is read in full before it is polled.
        head: battlemetrics ? (this.headPoll ? result.head : null) : undefined,
        schedule: battlemetrics ? this.scheduleOf(result, now) : undefined,
        storedCount: await retryOperation(() => Ban.count({ where: { banList: banList.id } })),
        // BattleMetrics' count of the list's bans, if the attempt got as far as asking for it.
        headTotal: 'firstMetaTotal' in result ? result.firstMetaTotal : undefined,
        // Whether the attempt read all of the list, if it got as far as reading it.
        complete: result.complete,
        // A list whose old source's bans are being replaced stays so until none of them is left.
        replacePending:
          result.replace === undefined ? undefined : result.replace && !result.replaced,
        // A remote list's file is kept only when the list was imported from it in full, with
        // nothing kept back, so the next run may skip the file if it has not changed.
        remote: banList.type === 'remote' ? this.importedFile(result) : undefined
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

  // When a BattleMetrics list is next due to be read in full after the attempt at it, which ended
  // at now, a Date, and why, by scheduleAfter (see planner.js), as { nextFullScanAt, scanReason },
  // or undefined to keep its row's. A read of all of the list that completed without an error
  // schedules the next one, at the list's slot, or the read that confirms the removal of bans it
  // left waiting, if that is sooner. A poll that found a reason to read the list in full, which was
  // not then read in full without an error, leaves it due at once, for that reason. With runs less
  // than IMPORTER_FULL_SCAN_MINUTES apart, the next periodic read is counted from when the list was
  // read, which its row keeps as lastFullScanAt: as it falls at the list's slot, a list read late in
  // a run is still due when its slot comes round again, as one read early is. With runs further
  // apart, it is counted from when the run planned its reads, as the next runs plan theirs, so a
  // list read late in a run is due by the next run, as one read early is, rather than by the run
  // after that.
  scheduleOf(result, now) {
    const schedule = scheduleAfter({
      now: now.getTime(),
      plannedAt: this.plannedAt,
      fullScanMinutes: this.fullScanMinutes,
      cadenceSeconds: this.cadenceSeconds,
      slot: this.slots.get(result.id) ?? null,
      completed: result.complete === true && !result.error,
      confirmAt: result.confirmAt ?? null,
      trigger: result.trigger ?? null
    });
    return (
      schedule && {
        nextFullScanAt: new Date(schedule.nextFullScanAt),
        scanReason: schedule.scanReason
      }
    );
  }

  // The file a remote list was imported from in full, with nothing kept back, by its ETag,
  // Last-Modified and SHA-256, or NO_FILE.
  importedFile(result) {
    const clean =
      result.remote &&
      !result.error &&
      result.complete === true &&
      result.failed === 0 &&
      result.held === 0;
    return clean ? result.remote : NO_FILE;
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

  // Log the list's new and changed bans, and those whose player is no longer one of their
  // SteamIDs, in the console, a line each.
  logChanges(banList, { added, changed, moves }) {
    const list = `ban list (ID: ${banList.id})`;
    const would = this.dryRun ? 'Would save' : 'Found';
    logEach(added, (ban) => `${would} new ban (ID: ${ban.id}) in ${list}.`);
    logEach(
      changed,
      (ban) => `${would} updated ban (ID: ${ban.id}) in ${list}: ${ban.fields.join(', ')} changed.`
    );
    logEach(moves, ({ id, from, to }) =>
      this.applySteamIDMoves
        ? `${this.dryRun ? 'Would move' : 'Moving'} ban (ID: ${id}) in ${list} from player ${from} to ${to}, as ${from} is no longer one of its SteamIDs.`
        : `Ban (ID: ${id}) in ${list} is for player ${from}, who is no longer one of its SteamIDs, so it would move to ${to} with IMPORTER_APPLY_STEAMID_MOVES=1.`
    );
  }

  // Save the list's new and changed bans, a batch at a time, and count them. A ban that cannot be
  // saved is counted and the others are still saved, but the list stops if the database stays
  // unavailable, which throws, or if the list was removed during the run, which returns false.
  // Once the run is asked to stop, no more batches are started, and this returns when the batch
  // under way, with its players' updates, has been saved. The bans not saved are fetched again by
  // the next run.
  async saveBans(banList, { added, changed }, result) {
    try {
      await writeBans(banList.id, [...added, ...changed], {
        batchSize: this.batchSize,
        onWritten: (batch) => {
          for (const write of batch) {
            if (write.fields) result.updated++;
            else result.created++;
          }
        },
        onFailed: (write, err) => {
          result.failed++;
          result.failure = result.failure || describeError(err);
          Logger.verbose(
            'BanImporter',
            2,
            `Failed to save raw ban (ID: ${write.id}) in ban list (ID: ${banList.id}): ${describeError(err)}`
          );
        }
      });
      return true;
    } catch (err) {
      if ((await this.stopReason(err, banList)) === LIST_REMOVED) return false;
      throw err;
    }
  }

  // Whether a write that failed means the list was removed during the run, as its foreign key
  // failed and the list is gone.
  async stopReason(err, banList) {
    if (!isMissingBanList(err)) return null;
    const exists = await retryOperation(() => BanList.findByPk(banList.id, { attributes: ['id'] }));
    return exists ? null : LIST_REMOVED;
  }

  // Remove the bans the list had before this run that its complete read did not have, by the rules
  // of planRemovals. A list named in IMPORTER_ALLOW_MASS_REMOVAL, or one whose row an admin has
  // allowed to lose all its bans (allowFullRemovalUntil, set for its current source), loses them
  // all at once. The bans kept are counted as held, and those that wait for a later complete read
  // as pending too, which are recorded in BanListPendingRemovals, as are those held for an admin
  // as the list seemed to have lost all its bans, so that the hold lasts until it is confirmed or
  // one of them comes back. A recorded ban that came back, or that the list no longer has, loses
  // its record. A list removed during the run, so that its records cannot be saved, is skipped as
  // gone.
  async removeMissingBans(banList, bans, stored, pending, result) {
    const now = this.clock();
    const found = new Set(bans.map((ban) => ban.id));
    const had = new Set(stored.map((ban) => ban.id));
    const missing = stored.filter((ban) => !found.has(ban.id));
    const cleared = [...pending.keys()].filter((banId) => found.has(banId) || !had.has(banId));
    // The bans the list still has that an earlier run held for an admin, and since when.
    const held = [...pending].filter(([banId, { heldAt }]) => heldAt !== null && had.has(banId));

    const bySetting = this.allowMassRemoval.has(String(banList.id));
    const confirmed = bySetting || this.fullRemovalAllowed(banList, now);
    const rules = {
      missing: missing.map((ban) => ban.id),
      stored: stored.length,
      fetched: bans.length,
      pending: new Map([...pending].map(([banId, { firstMissingAt }]) => [banId, firstMissingAt])),
      held: new Set(held.map(([banId]) => banId)),
      now,
      replace: result.replace
    };
    const plan = planRemovals({ ...rules, confirmed });
    // Whether the confirmation let the list lose bans that it would otherwise have kept.
    if (confirmed) {
      const unconfirmed = planRemovals(rules);
      result.massRemoval = unconfirmed.hold !== null || unconfirmed.wait.length > 0;
      result.confirmedBy = bySetting ? 'IMPORTER_ALLOW_MASS_REMOVAL' : 'allowFullRemovalUntil';
    }
    result.hold = plan.hold;
    result.held = plan.held.length + plan.wait.length;
    result.pending = plan.wait.length;
    // The first of the bans that wait for a later complete read is due to be confirmed as gone
    // CONFIRM_AFTER after it was first missing, which is now for a ban first missing now, or no
    // longer held for an admin, so the list is read in full again then.
    if (plan.wait.length > 0) {
      const released = new Set(plan.released);
      result.confirmAt =
        plan.wait.reduce(
          (first, banId) =>
            Math.min(
              first,
              released.has(banId) || !rules.pending.has(banId) ? now : rules.pending.get(banId)
            ),
          Infinity
        ) + CONFIRM_AFTER;
    }
    // A 'full' hold that an earlier run began says since when.
    if (plan.hold === 'full' && held.length > 0)
      result.heldSince = held.reduce((since, [, { heldAt }]) => Math.min(since, heldAt), Infinity);
    const remove = new Set(plan.remove);
    const removed = missing.filter((ban) => remove.has(ban.id));

    if (this.dryRun) {
      result.removed = removed.length;
      logEach(
        removed,
        (ban) => `Would remove ban (ID: ${ban.id}) from ban list (ID: ${banList.id}).`
      );
    } else {
      try {
        if (cleared.length > 0)
          await clearPendingRemovals(banList.id, cleared, { batchSize: this.batchSize });
        if (plan.released.length > 0) await releaseHeldRemovals(banList.id, { now: new Date(now) });
        if (plan.wait.length > 0)
          await savePendingRemovals(banList.id, plan.wait, {
            now: new Date(now),
            batchSize: this.batchSize
          });
        if (plan.hold === 'full')
          await savePendingRemovals(banList.id, plan.held, {
            now: new Date(now),
            held: true,
            batchSize: this.batchSize
          });
        if (removed.length > 0)
          result.removed += await removeBans(banList.id, removed, { batchSize: this.batchSize });
      } catch (err) {
        if ((await this.stopReason(err, banList)) !== LIST_REMOVED) throw err;
        // Its bans went with it, so none of them is kept.
        Object.assign(result, { gone: true, hold: null, held: 0, pending: 0 });
        return;
      }
    }
    if (result.replace && !plan.hold && plan.wait.length === 0) result.replaced = true;
  }

  // Whether an admin has allowed the list to lose all of its bans, by its row, for its current type
  // and source, until a time that has not passed yet.
  fullRemovalAllowed(banList, now) {
    const before = this.syncs.get(banList.id);
    if (!before || before.sourceKey !== sourceKey(banList)) return false;
    const until = timeOf(before.allowFullRemovalUntil);
    return until !== null && until > now;
  }

  // Remove the bans fetched from the list's old type or source, a batch at a time as above, and
  // count those the list still had. Removing them is never held, as the new source's bans replace
  // them. Each ban's players are queued for an update: the one it was saved with, and any it had
  // before. A dry run saved none of them, so it has none to remove.
  async removeOldSourceBans(banList, bans, stored, result) {
    result.sourceChanged = true;
    if (this.dryRun) return;
    const players = new Map(stored.map((ban) => [ban.id, ban.steamUser]));
    result.removed += await removeBans(
      banList.id,
      bans.map((ban) => ({
        id: ban.id,
        steamUser: ban.steamUser,
        previousSteamUser: players.get(ban.id)
      })),
      { batchSize: this.batchSize }
    );
  }

  // Log one line about the list. A line about a list that needs looking at is logged as important,
  // so it reaches the log channel ahead of other messages and is never dropped for them. The others
  // only go to the console. A second attempt at a list is logged as important, as its first one
  // was. A list that imports a CBL export ban list, or that CBL cannot read, is posted about once,
  // when that starts (see saveSync), so its line otherwise only goes to the console, unless its
  // import failed. And once a list has been posted about as one CBL cannot read, before this run, a
  // failure that shows it again only goes to the console; any other failure of it, e.g. while
  // BattleMetrics is down, is posted as for any list. A read that is not complete, after one in the
  // list's last run that was not either, only goes to the console too, as the first was posted. A
  // list whose bans are held for an admin is posted about on every read of all of it while they
  // are, and a list that is only polled says in the console how many bans it still keeps. In a dry
  // run, every line goes to the console only, as nothing in it needs doing.
  logResult(result) {
    const log = (important, line) => {
      if (important && !this.dryRun) Logger.important('BanImporter', line);
      else Logger.verbose('BanImporter', 2, line);
    };
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
    // A list that was only polled is said to be, as only the newest of its bans were read.
    const polled = result.read === 'head' && result.complete === undefined;
    const imported = `${this.dryRun ? 'Checked' : polled ? 'Polled' : 'Imported'} ${list}${again ? ' at the second attempt' : ''}`;
    const counts = [
      `${result.fetched} bans fetched`,
      `${result.created} new`,
      `${result.updated} updated`
    ];
    if (result.removed > 0) counts.push(`${result.removed} removed`);
    if (result.failed > 0) counts.push(`${result.failed} failed to save (${result.failure})`);
    if (result.moves > 0)
      counts.push(
        `${plural(result.moves, 'ban')} ${this.applySteamIDMoves ? 'moved' : 'to move'} to another SteamID`
      );
    const progress = result.fetched > 0 ? ` (${counts.join(', ')})` : '';
    const dryRun = this.dryRun ? ' Nothing was written, as IMPORTER_DRY_RUN is on.' : '';

    if (result.stopped) {
      // The import's summary leaves the list out, so this says what it saved before the run
      // stopped, where it was, e.g. the page it was fetching, and how long the attempt had taken,
      // as a list that holds up a run that is stopping is likely the one that made it slow. The
      // next run imports it again.
      log(
        true,
        `Stopped importing ${list}${again ? ' at the second attempt' : ''} while ${describeStage(result)}, after ${secondsText(result.ms)}, as the run is stopping, so none of its bans were removed${progress}.`
      );
    } else if (result.error) {
      const removed =
        result.removed > 0
          ? `after removing ${result.removed} of its bans`
          : 'so none of its bans were removed';
      const line = `Failed to import ${list}${again ? ' again' : ''} while ${describeStage(result)}, ${removed}${progress}. ${result.error}`;
      log(!result.lostAgain && !result.incompleteAgain, line);
    } else if (result.sourceChanged) {
      // A dry run saved none of the bans fetched, so it has none to remove.
      const what = this.dryRun
        ? `Checked ${list}${again ? ' at the second attempt' : ''}, but its type or source was changed while it was read`
        : `Removed the bans fetched for ${list}${again ? ' at the second attempt' : ''}, as its type or source was changed while it was imported`;
      log(true, `${what}${progress}. Its new source is imported on the next run.${dryRun}`);
    } else if (result.accessLost) {
      log(
        again,
        `${imported}: ${counts.join(', ')}. None of its bans were checked for removal, as ${result.accessLost}.${dryRun}`
      );
    } else if (polled) {
      // A poll removes none of the list's bans, so those it kept for now are still kept, and are
      // posted about when a read of all of it keeps them.
      const held = result.held > 0 ? `, ${formatCount(result.held)} held` : '';
      log(result.failed > 0 || again, `${imported}: ${counts.join(', ')}${held}.${dryRun}`);
    } else if (result.hold === 'empty') {
      const none = result.rawCount > 0 ? 'no bans with a SteamID' : 'no bans';
      log(
        true,
        `${imported}: it returned ${none}, so its ${result.stored} stored bans were kept in case the list is broken. If the list really is empty, set IMPORTER_ALLOW_MASS_REMOVAL=${result.id} for one run.${dryRun}`
      );
    } else if (result.hold === 'full') {
      const confirm = `If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=${result.id} for one run.`;
      if (result.heldSince === undefined)
        log(
          true,
          `${imported}: ${counts.join(', ')}. Kept all ${result.stored} of its stored bans, as it no longer has any of them, which more likely means that its source broke. They are kept until one of them comes back. ${confirm}${dryRun}`
        );
      else {
        // The bans it saved since, which it no longer has, are removed as usual.
        const waiting =
          result.pending > 0
            ? ` Of the bans it saved since, ${result.pending} that it no longer has are kept until a later complete read of it confirms they are gone.`
            : '';
        log(
          true,
          `${imported}: ${counts.join(', ')}. Still kept the ${plural(result.held - result.pending, 'ban')} it had when it lost all of its bans at once, held since ${new Date(result.heldSince).toISOString()}, as none of them has come back, which more likely means that its source broke. ${confirm}${waiting}${dryRun}`
        );
      }
    } else if (result.replace && (result.removed > 0 || result.pending > 0)) {
      const waiting =
        result.pending > 0
          ? `, and ${result.pending} more are kept until a later complete read of it confirms they are gone`
          : '';
      log(
        true,
        `${imported}: ${counts.join(', ')}. Its type or source was changed since it was last imported, so the bans of its old source are being replaced: ${result.removed} were removed${waiting}.${dryRun}`
      );
    } else if (result.pending > 0) {
      log(
        result.failed > 0 || again,
        `${imported}: ${counts.join(', ')}. Kept the ${result.pending} of its ${result.stored} stored bans that it no longer has until a complete read of it at least ${CONFIRM_AFTER / 60000} minutes after the first one without them still does not have them.${dryRun}`
      );
    } else if (result.massRemoval) {
      const by =
        result.confirmedBy === 'IMPORTER_ALLOW_MASS_REMOVAL'
          ? 'as IMPORTER_ALLOW_MASS_REMOVAL names the list. Remove it from the setting once the removal is done.'
          : 'as an admin confirmed that it may lose them all.';
      log(true, `${imported}: ${counts.join(', ')}, ${by}${dryRun}`);
    } else if (result.unchanged) {
      log(
        result.failed > 0 || again,
        `${imported}: its file is unchanged since it was last imported, so it was not read again (${counts.join(', ')}).${dryRun}`
      );
    } else {
      log(result.failed > 0 || again, `${imported}: ${counts.join(', ')}.${dryRun}`);
    }
  }

  // Print one line for the whole import. It only goes to the console: the run's status message in
  // Discord shows the same totals, from the import's report. Bans that were kept as their removal
  // needs confirming are counted as held, not removed. When the run stopped part-way, the line sums
  // up the lists imported before it stopped, out of the listCount lists of the run, and leaves out
  // a list it stopped in the middle of, at either attempt, which has a line of its own. In a dry
  // run, the counts say what the import would have done.
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
      `Got ${plural(total.removed, 'deleted ban')}. Imported ${lists}${stopped ? ' before the run stopped' : ''}: ${counts.join(', ')}.${this.dryRun ? ' Nothing was written, as IMPORTER_DRY_RUN is on.' : ''}`
    );
    // How the lists were read, and the BattleMetrics requests it took.
    const { head, follow, full } = this.requests;
    Logger.verbose(
      'BanImporter',
      2,
      `Polled ${plural(total.headPolls, 'ban list')} and read ${formatCount(total.fullReads)} in full, with ${plural(head + follow + full, 'BattleMetrics request')}: ${formatCount(head)} for newest pages, ${formatCount(follow)} following them and ${formatCount(full)} for full reads.`
    );
    if (total.moves > 0 && !this.applySteamIDMoves)
      Logger.verbose(
        'BanImporter',
        2,
        total.moves === 1
          ? "1 ban is for a player who is no longer one of the ban's SteamIDs. It keeps its player until IMPORTER_APPLY_STEAMID_MOVES=1 moves it."
          : `${formatCount(total.moves)} bans are for a player who is no longer one of the ban's SteamIDs. They keep their player until IMPORTER_APPLY_STEAMID_MOVES=1 moves them.`
      );
  }

  // The import's counts for the run record: its totals, as in its summary line, how the access
  // check went, and, once it was read, how long it took, in seconds, the BattleMetrics requests it
  // made, by what they were for, and each list's own counts. An import that stopped part-way
  // reports the lists its summary line sums up, and, when it stopped part-way through a list, that
  // list's counts on their own (stopped), with where it stopped (stage, and page for a list
  // stopped on a page of its bans) and how long it had taken (seconds), both attempts together at
  // a second attempt, which neither the totals nor banLists count. A dry run says so.
  report() {
    return {
      lists: this.listCount,
      imported: this.results.length,
      ...totals(this.results),
      accessCheck: this.accessCheckResult,
      ...(this.accessCheckMs === null ? {} : { accessCheckSeconds: seconds(this.accessCheckMs) }),
      requests: { ...this.requests },
      ...(this.dryRun ? { dryRun: true } : {}),
      banLists: this.results.map(listReport),
      ...(this.stopped
        ? { stopped: { ...listReport(this.stopped), stage: this.stopped.stage } }
        : {})
    };
  }
}
