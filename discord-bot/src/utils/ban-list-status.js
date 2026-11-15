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

const REMOVALS = `SELECT banList, COUNT(*) AS bans, COUNT(heldAt) AS held
  FROM BanListPendingRemovals WHERE banList IN (:banListIDs) GROUP BY banList`;

// Whether the ban importer has yet to finish reading the ban list's type or source, as it tells by
// the list's BanListSyncs row: 'other' when the row is of another source, by its sourceKey, so
// nothing in it is of the list's source now, 'replacing' when the row is of the list's source but
// the importer has not finished replacing the old source's bans with those of the new one
// (replacePending), as when its first attempt at a new source failed or did not read all of it, or
// the list was given back its source before the importer read the one it was changed to, or null
// when it has finished.
function sourceChange(banList, row) {
  if (row.sourceKey !== sourceKey(banList)) return 'other';
  return Number(row.replacePending) ? 'replacing' : null;
}

// The status of the ban lists given: { paused, syncs, removals }, each a Map by ban list ID, of
// their paused rows, their BanListSyncs rows, each with its sourceChange, and the bans held back
// from removing them, { waiting, held }. A list whose new type or source the importer has yet to
// finish reading has no removals: those it holds back are its old source's, or of bans deleted with
// it, until the importer has read the new one in full. Fails with the bot's answer when the
// importer's tables are missing.
export async function readStatus(banLists) {
  if (banLists.length === 0) return { paused: new Map(), syncs: new Map(), removals: new Map() };
  const banListIDs = banLists.map((banList) => banList.id);
  const byID = new Map(banLists.map((banList) => [banList.id, banList]));
  try {
    const [paused, rows, removals] = await Promise.all([
      readPausedBanLists({ missingTable: 'throw' }),
      BanListSync.findAll({ where: { banList: banListIDs }, raw: true }),
      sequelize.query(REMOVALS, {
        type: QueryTypes.SELECT,
        replacements: { banListIDs }
      })
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
      removals: new Map(
        removals
          .filter(({ banList }) => !syncs.get(Number(banList))?.sourceChange)
          .map(({ banList, bans, held }) => [
            Number(banList),
            { waiting: Number(bans) - Number(held), held: Number(held) }
          ])
      )
    };
  } catch (err) {
    return tablesMissing(err);
  }
}
