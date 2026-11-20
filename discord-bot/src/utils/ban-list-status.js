import { sequelize } from 'scbl-lib/db';
import {
  isMissingTable,
  readPausedBanLists,
  readSettledPausedBanLists
} from 'scbl-lib/db/ban-list-suspensions';
import { BanListSync } from 'scbl-lib/db/importer-models';
import { QueryTypes } from 'scbl-lib/db/sequelize';
import { sourceKey } from 'scbl-lib/utils';

import UserError from './user-error.js';

// What the ban importer's tables say about ban lists, which the bot reads here: whether each is
// paused, how the importer last imported it, and the bans it holds back from removing, and why.
// Until the importer has made its tables, after it is deployed, they cannot be read, which the bot
// says. What the bot writes to them here is in a list's BanListSyncs row, and only in a row the
// importer has made: the mark that its source was changed (see markSourceChanged), that it is to be
// read in full (see markFullRead), and that an admin confirmed the removal of the bans it holds
// back (see markRemovalConfirmed).

export const NO_TABLES =
  'The ban importer has not created its tables yet, so this cannot be done until its next cycle has run.';

// How long an admin's confirmation of a removal lasts, in hours (see markRemovalConfirmed, and
// fullRemovalAllowed in ban-importer/src/ban-importer.js).
export const CONFIRM_HOURS = 2;

// Pass on a missing table as the bot's answer, and other errors as they are.
function tablesMissing(err) {
  if (isMissingTable(err)) throw new UserError(NO_TABLES);
  throw err;
}

// The paused row of each paused ban list, by ban list ID. A missing table means no list is paused.
export async function readPaused() {
  return new Map((await readPausedBanLists()).map((row) => [row.banList, row]));
}

// Of the ban lists with these IDs, those whose players need not be queued when their bans are
// deleted: the lists paused now whose players the importer's reputation check has settled without
// their bans (see readSettledPausedBanLists). A list paused since the check last ran is not one of
// them, as nothing would find its players again once its bans are gone. None until the importer
// has made its tables.
export async function readQueueSkips(banListIDs) {
  const [paused, settled] = await Promise.all([readPaused(), readSettledPausedBanLists()]);
  return banListIDs.filter((id) => paused.has(id) && settled.includes(id));
}

// The paused row of one ban list, or null, failing with the bot's answer when the table is missing,
// as the list cannot be paused or resumed then.
export async function readPause(banList) {
  const [row] = await readPausedBanLists({ banList, missingTable: 'throw' }).catch(tablesMissing);
  return row ?? null;
}

const MARK_SOURCE_CHANGED = 'UPDATE BanListSyncs SET replacePending = 1 WHERE banList = ?';

// Mark the ban list's BanListSyncs row, in the transaction that saves its new type or source, so the
// ban importer replaces its bans with those of the new source: it reads the list in full afresh on
// its next cycle, or once it is resumed, without what it kept about the source the row was written
// for, such as a remote list's ETag or a BattleMetrics list's newest page. The row's sourceKey
// tells the importer of a new source too, but not of a source changed back before the importer read
// the new one: the row is then still that source's, so without the mark the importer would take its
// file as unchanged, or poll only its newest page, and the bans the change deleted would not come
// back. A list with no row, which the importer has never imported, needs no mark, nor does any list
// before the importer has made its tables.
export async function markSourceChanged(banList, transaction) {
  try {
    await sequelize.query(MARK_SOURCE_CHANGED, { replacements: [banList], transaction });
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

const READ_IN_FULL = {
  battlemetrics:
    'UPDATE BanListSyncs SET nextFullScanAt = UTC_TIMESTAMP(3) WHERE banList = ? AND sourceKey = ?',
  remote:
    'UPDATE BanListSyncs SET remoteEtag = NULL, remoteLastModified = NULL, remoteBodyHash = NULL WHERE banList = ? AND sourceKey = ?'
};
const ROW_OF_SOURCE = 'SELECT banList FROM BanListSyncs WHERE banList = ? AND sourceKey = ?';

// Mark the ban list's BanListSyncs row, if it has one for its current type and source, to be read
// in full: a BattleMetrics list's nextFullScanAt is set to now, by the database's clock (see
// planRead in ban-importer/src/planner.js), and a remote list's ETag, Last-Modified and SHA-256 are
// forgotten (see lastFile in ban-importer/src/ban-importer.js). The caller refuses a remote list
// while the importer's run lock is held (see /banlist resync). Never with replacePending (see
// planRemovals in ban-importer/src/apply-list.js). Resolves with whether the list has such a row.
// MySQL counts the rows an UPDATE changed, as Sequelize connects without CLIENT_FOUND_ROWS, so a
// row found as the mark would set it, as a remote list's whose file is already forgotten, counts
// none, and the row is looked for again then.
export async function markFullRead(banList) {
  const sql = banList.type === 'battlemetrics' ? READ_IN_FULL.battlemetrics : READ_IN_FULL.remote;
  const replacements = [banList.id, sourceKey(banList)];
  try {
    const changed = await sequelize.query(sql, { type: QueryTypes.BULKUPDATE, replacements });
    if (Number(changed) > 0) return true;
    const rows = await sequelize.query(ROW_OF_SOURCE, { type: QueryTypes.SELECT, replacements });
    return rows.length > 0;
  } catch (err) {
    return tablesMissing(err);
  }
}

const CONFIRM_REMOVAL = {
  battlemetrics: `UPDATE BanListSyncs SET allowFullRemovalUntil = UTC_TIMESTAMP(3) + INTERVAL ${CONFIRM_HOURS} HOUR, nextFullScanAt = UTC_TIMESTAMP(3) WHERE banList = ? AND sourceKey = ?`,
  remote: `UPDATE BanListSyncs SET allowFullRemovalUntil = UTC_TIMESTAMP(3) + INTERVAL ${CONFIRM_HOURS} HOUR WHERE banList = ? AND sourceKey = ?`
};
const CONFIRMED_UNTIL =
  'SELECT allowFullRemovalUntil FROM BanListSyncs WHERE banList = ? AND sourceKey = ?';

// Mark the ban list's BanListSyncs row, if it has one for its current type and source, with an
// admin's confirmation of the removal of the bans the ban importer holds back:
// allowFullRemovalUntil is set to CONFIRM_HOURS from now, by the database's clock (see
// fullRemovalAllowed in ban-importer/src/ban-importer.js, and Confirming a removal in
// ban-importer/README.md), and a BattleMetrics list's nextFullScanAt to now, as markFullRead sets
// it. Resolves with the time it lasts until, as the row then says, or null when the list has no row
// for its current type and source, e.g. as it was removed meanwhile. It is read back rather than
// counted (see markFullRead).
export async function markRemovalConfirmed(banList) {
  const sql =
    banList.type === 'battlemetrics' ? CONFIRM_REMOVAL.battlemetrics : CONFIRM_REMOVAL.remote;
  const replacements = [banList.id, sourceKey(banList)];
  try {
    await sequelize.query(sql, { type: QueryTypes.BULKUPDATE, replacements });
    const [row] = await sequelize.query(CONFIRMED_UNTIL, {
      type: QueryTypes.SELECT,
      replacements
    });
    return row?.allowFullRemovalUntil ? new Date(row.allowFullRemovalUntil) : null;
  } catch (err) {
    return tablesMissing(err);
  }
}

const REMOVALS =
  'SELECT banList, banId, heldAt FROM BanListPendingRemovals WHERE banList IN (:banListIDs)';
const STORED = 'SELECT id, banList FROM Bans WHERE id IN (:banIds)';

// The bans the ban importer holds back from removing the lists with these IDs, by ban list ID, as
// { waiting, held, heldSince, heldLast }: how many wait for a confirming read, how many are held for
// an admin, and since when the first and the last of those were held, or null, counting only the
// records of bans the list still has (see planMissingBans in ban-importer/src/ban-importer.js). A
// record's banId refers to Bans.id without a foreign key, so the two are compared here rather than
// joined on.
async function readRemovals(banListIDs) {
  const records = await sequelize.query(REMOVALS, {
    type: QueryTypes.SELECT,
    replacements: { banListIDs }
  });
  if (records.length === 0) return new Map();
  const stored = await sequelize.query(STORED, {
    type: QueryTypes.SELECT,
    replacements: { banIds: records.map(({ banId }) => banId) }
  });
  const kept = new Set(stored.map(({ id, banList }) => `${Number(banList)},${id}`));
  const removals = new Map();
  for (const { banList, banId, heldAt } of records) {
    if (!kept.has(`${Number(banList)},${banId}`)) continue;
    const counts = removals.get(Number(banList)) ?? {
      waiting: 0,
      held: 0,
      heldSince: null,
      heldLast: null
    };
    if (heldAt === null) counts.waiting++;
    else {
      counts.held++;
      const since = new Date(heldAt);
      if (counts.heldSince === null || since < counts.heldSince) counts.heldSince = since;
      if (counts.heldLast === null || since > counts.heldLast) counts.heldLast = since;
    }
    removals.set(Number(banList), counts);
  }
  return removals;
}

const HOLDS =
  'SELECT banList, reason, storedCount FROM BanListHolds WHERE banList IN (:banListIDs)';

// Why the ban importer holds the bans of the lists with these IDs for an admin, as its BanListHolds
// rows say, { reason, storedCount }, by ban list ID. That table came with a later migration than
// the others, so a table that is not there yet gives none (see whyHeld in
// ban-importer/src/apply-list.js).
async function readHoldReasons(banListIDs) {
  try {
    const rows = await sequelize.query(HOLDS, {
      type: QueryTypes.SELECT,
      replacements: { banListIDs }
    });
    return new Map(
      rows.map(({ banList, reason, storedCount }) => [
        Number(banList),
        { reason, storedCount: storedCount === null ? null : Number(storedCount) }
      ])
    );
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
}

// The fewest held bans, of the bans a hold is measured against (of), that holdOf takes as a hold of
// a large loss, as fewestHeld in ban-importer/src/apply-list.js counts them: at least 25 and a
// fifth of them, or all of them when they are fewer than 25.
const LARGE_REMOVAL_BANS = 25;
const LARGE_REMOVAL_SHARE = 0.2;
const fewestHeld = (of) =>
  Math.min(Math.max(LARGE_REMOVAL_BANS, Math.ceil(of * LARGE_REMOVAL_SHARE)), Math.max(of, 1));

// A time from a row, in milliseconds since 1970, or null for none.
const timeOf = (value) =>
  value === null || value === undefined ? null : new Date(value).getTime();

// The ban importer's hold of the ban list's bans for an admin, from its BanListSyncs row (sync),
// the bans it holds back from removing it (removals, see readRemovals) and its BanListHolds row
// (recorded), as { kind, held, waiting, since }, or null for none (see whyHeld, countFetched and
// planRemovals in ban-importer/src/apply-list.js, and Confirming a removal in
// ban-importer/README.md):
// - 'full' or 'large' when bans are recorded as held: 'large' when the BanListHolds row says so and
//   at least fewestHeld of the fewer of its storedCount and the list's stored bans are held, and
//   'full' otherwise; held is how many, since when the first of them was held, and waiting how many
//   other bans wait for a confirming read;
// - 'empty' when its row's state is held and it has stored bans, but none recorded as held or
//   waiting, or, for a BattleMetrics list, its row shows a read that gave none (countedNone,
//   below): since is null, held is the list's stored bans, upTo is set for a BattleMetrics list
//   whose row does not show such a read, and recorded is the hold of 'full' or 'large' its records
//   give, or null.
// A list whose row has a sourceChange (see sourceChange) has none.
export function holdOf(banList, sync, removals = null, recorded = null) {
  if (!sync || sync.sourceChange) return null;
  const { waiting = 0, held = 0, heldSince = null, heldLast = heldSince } = removals ?? {};
  const stored = Number(sync.storedCount ?? 0);
  let hold = null;
  if (held > 0) {
    const of = Math.min(recorded?.storedCount ?? stored, stored);
    const large = recorded?.reason === 'large' && held >= fewestHeld(of);
    hold = { kind: large ? 'large' : 'full', held, waiting, since: heldSince };
  }
  const battlemetrics = banList.type === 'battlemetrics';
  // A count of 0 is not taken as a read that gave none while bans are recorded as held and the last
  // of them was held after the row's last read in full, or the row has none (see saveSync in
  // ban-importer/src/ban-importer.js).
  const lastFull = timeOf(sync.lastFullScanAt);
  const recordedLater = hold !== null && (lastFull === null || timeOf(heldLast) > lastFull);
  // A count of 0 is taken as a read that gave none only with an empty newest page in the row (see
  // checkCount in ban-importer/src/ban-fetcher.js, and writeHeadUids in
  // ban-importer/src/planner.js).
  const countedNone =
    battlemetrics &&
    !recordedLater &&
    sync.headTotal !== null &&
    sync.headTotal !== undefined &&
    Number(sync.headTotal) === 0 &&
    sync.headUids === '[]';
  if (sync.state === 'held' && stored > 0 && (countedNone || (held === 0 && waiting === 0)))
    return {
      kind: 'empty',
      held: stored,
      upTo: battlemetrics && !countedNone,
      waiting,
      since: null,
      recorded: hold
    };
  return hold;
}

// Whether the ban importer has yet to read the ban list since its type or source was changed, or to
// finish switching it to its new source, as it tells by the list's BanListSyncs row:
// - 'unread' when it has not read the list since, so nothing in the row is of its source now: the
//   row is of another source, by its sourceKey, or of the list's source but from before the change,
//   as when the source was changed back before the importer read the one it was changed to. The
//   row then says the switch is still under way (replacePending), but its latest attempt is
//   from before the list's type or source was last changed, by the list's updatedAt, which only
//   /banlist update moves, and only with a new type or source, as a rename leaves it as it was;
// - 'replacing' when the row is of an attempt at the list's source since then, so its state and
//   counts are of that source, but the importer has not finished switching it to that source
//   (replacePending): its attempts failed, did not read all of the list, or could not remove the
//   bans the list no longer has, e.g. as BattleMetrics does not list it for CBL, or those bans wait
//   for a read to confirm them gone;
// - null when it has finished.
function sourceChange(banList, row) {
  if (row.sourceKey !== sourceKey(banList)) return 'unread';
  if (!Number(row.replacePending)) return null;
  const attempted = row.lastAttemptAt ? new Date(row.lastAttemptAt).getTime() : null;
  return attempted !== null && attempted > new Date(banList.updatedAt).getTime()
    ? 'replacing'
    : 'unread';
}

// The status of the ban lists given: { paused, syncs, removals, holds }, each a Map by ban list ID,
// of their paused rows, their BanListSyncs rows, each with its sourceChange, the bans held back
// from removing them, { waiting, held, heldSince, heldLast } (see readRemovals), and the ban
// importer's holds of their bans for an admin, for the lists with one (see holdOf). A list whose
// sourceChange is 'unread' has no removals. Fails with the bot's answer when the importer's tables
// are missing.
export async function readStatus(banLists) {
  if (banLists.length === 0)
    return { paused: new Map(), syncs: new Map(), removals: new Map(), holds: new Map() };
  const banListIDs = banLists.map((banList) => banList.id);
  const byID = new Map(banLists.map((banList) => [banList.id, banList]));
  try {
    const [paused, rows, allRemovals, reasons] = await Promise.all([
      readPausedBanLists({ missingTable: 'throw' }),
      BanListSync.findAll({ where: { banList: banListIDs }, raw: true }),
      readRemovals(banListIDs),
      readHoldReasons(banListIDs)
    ]);
    const syncs = new Map(
      rows.map((row) => {
        const id = Number(row.banList);
        return [id, { ...row, sourceChange: sourceChange(byID.get(id), row) }];
      })
    );
    const removals = new Map(
      [...allRemovals].filter(([id]) => syncs.get(id)?.sourceChange !== 'unread')
    );
    const holds = new Map();
    for (const banList of banLists) {
      const hold = holdOf(
        banList,
        syncs.get(banList.id) ?? null,
        removals.get(banList.id) ?? null,
        reasons.get(banList.id) ?? null
      );
      if (hold) holds.set(banList.id, hold);
    }
    return {
      paused: new Map(paused.map((row) => [row.banList, row])),
      syncs,
      removals,
      holds
    };
  } catch (err) {
    return tablesMissing(err);
  }
}
