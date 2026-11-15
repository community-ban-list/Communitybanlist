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
// paused, how the importer last imported it, and the bans it holds back from removing. Until the
// importer has made its tables, after it is deployed, they cannot be read, which the bot says. The
// one thing the bot writes to them here is the mark on a list's BanListSyncs row that its source was
// changed (see markSourceChanged).

export const NO_TABLES =
  'The ban importer has not created its tables yet, so this cannot be done until its next cycle has run.';

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

const REMOVALS =
  'SELECT banList, banId, heldAt FROM BanListPendingRemovals WHERE banList IN (:banListIDs)';
const STORED = 'SELECT id, banList FROM Bans WHERE id IN (:banIds)';

// The bans the ban importer holds back from removing the lists with these IDs, { waiting, held },
// by ban list ID, as the importer counts them: only the records of bans the list still has. The
// records of the bans /banlist update deleted with a new type or source stay until the importer has
// read the new source in full. A record's banId refers to Bans.id without a foreign key, so the two
// are compared here, as the importer compares them, rather than joined on.
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
    const counts = removals.get(Number(banList)) ?? { waiting: 0, held: 0 };
    if (heldAt === null) counts.waiting++;
    else counts.held++;
    removals.set(Number(banList), counts);
  }
  return removals;
}

// Whether the ban importer has yet to read the ban list since its type or source was changed, or to
// finish replacing its old bans with those of its new source, as it tells by the list's
// BanListSyncs row:
// - 'unread' when it has not read the list since, so nothing in the row is of its source now: the
//   row is of another source, by its sourceKey, or of the list's source but from before the change,
//   as when the source was changed back before the importer read the one it was changed to. The
//   row then says the old bans are still to be replaced (replacePending), but its latest attempt is
//   from before the list was last saved (updatedAt), which only /banlist update does;
// - 'replacing' when the row is of an attempt at the list's source since then, so its state and
//   counts are of that source, but the importer has not finished replacing the old bans
//   (replacePending): its attempts failed, did not read all of the list, or could not remove the
//   bans it no longer has, e.g. as BattleMetrics does not list it for CBL, or wait for a read to
//   confirm them gone;
// - null when it has finished.
// So a list whose old bans are still being replaced, renamed since the importer's latest attempt at
// it, is taken for one not read since, until the importer's next attempt.
function sourceChange(banList, row) {
  if (row.sourceKey !== sourceKey(banList)) return 'unread';
  if (!Number(row.replacePending)) return null;
  const attempted = row.lastAttemptAt ? new Date(row.lastAttemptAt).getTime() : null;
  return attempted !== null && attempted > new Date(banList.updatedAt).getTime()
    ? 'replacing'
    : 'unread';
}

// The status of the ban lists given: { paused, syncs, removals }, each a Map by ban list ID, of
// their paused rows, their BanListSyncs rows, each with its sourceChange, and the bans held back
// from removing them, { waiting, held } (see readRemovals). A list the importer has not read since
// its type or source was changed has no removals: those it holds back are its old source's. Fails
// with the bot's answer when the importer's tables are missing.
export async function readStatus(banLists) {
  if (banLists.length === 0) return { paused: new Map(), syncs: new Map(), removals: new Map() };
  const banListIDs = banLists.map((banList) => banList.id);
  const byID = new Map(banLists.map((banList) => [banList.id, banList]));
  try {
    const [paused, rows, removals] = await Promise.all([
      readPausedBanLists({ missingTable: 'throw' }),
      BanListSync.findAll({ where: { banList: banListIDs }, raw: true }),
      readRemovals(banListIDs)
    ]);
    const syncs = new Map(
      rows.map((row) => {
        const id = Number(row.banList);
        return [id, { ...row, sourceChange: sourceChange(byID.get(id), row) }];
      })
    );
    return {
      paused: new Map(paused.map((row) => [row.banList, row])),
      syncs,
      removals: new Map([...removals].filter(([id]) => syncs.get(id)?.sourceChange !== 'unread'))
    };
  } catch (err) {
    return tablesMissing(err);
  }
}
