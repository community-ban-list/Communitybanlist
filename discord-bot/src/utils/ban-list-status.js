import { sequelize } from 'scbl-lib/db';
import {
  isMissingTable,
  readPausedBanLists,
  readSettledPausedBanLists
} from 'scbl-lib/db/ban-list-suspensions';
import { BanListSync } from 'scbl-lib/db/importer-models';
import { QueryTypes } from 'scbl-lib/db/sequelize';

import UserError from './user-error.js';

// What the ban importer's tables say about ban lists, which the bot only reads here: whether each
// is paused, how the importer last imported it, and the bans it holds back from removing. Until the
// importer has made its tables, after it is deployed, they cannot be read, which the bot says.

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

const REMOVALS = `SELECT banList, COUNT(*) AS bans, COUNT(heldAt) AS held
  FROM BanListPendingRemovals WHERE banList IN (:banListIDs) GROUP BY banList`;

// The status of the ban lists with these IDs: { paused, syncs, removals }, each a Map by ban list
// ID, of their paused rows, their BanListSyncs rows and the bans held back from removing them,
// { waiting, held }. Fails with the bot's answer when the importer's tables are missing.
export async function readStatus(banListIDs) {
  if (banListIDs.length === 0) return { paused: new Map(), syncs: new Map(), removals: new Map() };
  try {
    const [paused, syncs, removals] = await Promise.all([
      readPausedBanLists({ missingTable: 'throw' }),
      BanListSync.findAll({ where: { banList: banListIDs }, raw: true }),
      sequelize.query(REMOVALS, {
        type: QueryTypes.SELECT,
        replacements: { banListIDs }
      })
    ]);
    return {
      paused: new Map(paused.map((row) => [row.banList, row])),
      syncs: new Map(syncs.map((row) => [Number(row.banList), row])),
      removals: new Map(
        removals.map(({ banList, bans, held }) => [
          Number(banList),
          { waiting: Number(bans) - Number(held), held: Number(held) }
        ])
      )
    };
  } catch (err) {
    return tablesMissing(err);
  }
}
