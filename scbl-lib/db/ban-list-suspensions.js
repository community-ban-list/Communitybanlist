import { checkExcludedBanLists, excludedBanListsSQL } from './excluded-ban-lists.js';
import sequelize, { QueryTypes } from './sequelize.js';

export { checkExcludedBanLists, excludedBanListsSQL };

// The ban lists an admin has paused, which the importer's BanListSuspensions table keeps, one row
// each. A paused list is either:
// - suspended (resumedAt is NULL): the importer does not import it, and its bans count for nothing:
//   not for players' reputation points, rank or risk, nor for export ban lists, and the website
//   leaves them out of its lists of bans;
// - resuming (resumedAt is set): the importer imports it again, reading it in full at once, while
//   its bans still count for nothing, until the importer has caught up with the list, i.e. it has
//   read all of it since it was resumed and confirmed the removals that read found. The importer
//   then deletes the row, and the list counts again. So bans the list's owner lifted while it was
//   suspended never count again.
// The bot adds the rows, sets resumedAt, and suspends a resuming list again, and the importer deletes
// them: the web server and the bot never change the table otherwise (see
// scbl-lib/db/models/importer/index.js). A list's row is deleted with the list. Every service reads the rows here, and each statement that
// counts bans is given the lists to leave out as literal IDs (see excludedBanListsSQL), rather than
// joining this table, so it takes no locks on it and works before the importer has made it (see
// excluded-ban-lists.js).

// MySQL's error numbers for a table that does not exist, a duplicate key, a foreign key to a row
// that does not exist, and a deadlock.
const NO_SUCH_TABLE = 1146;
const DUPLICATE_KEY = 1062;
const NO_REFERENCED_ROW = 1452;
const DEADLOCK = 1213;

// A suspension is tried this many times when another one of the same list gets in its way.
const ATTEMPTS = 3;

// The longest reason a suspension keeps, as the column holds.
export const MAX_REASON_LENGTH = 500;

// The longest suspendedBy the column holds.
const MAX_BY_LENGTH = 100;

const errnoOf = (err) => (err?.original ?? err?.parent ?? err)?.errno;

// Whether the importer has not made its tables yet, as no importer has applied its migrations.
export function isMissingTable(err) {
  return errnoOf(err) === NO_SUCH_TABLE;
}

const READ = `SELECT banList, suspendedAt, suspendedBy, reason, resumedAt FROM BanListSuspensions`;

// Each paused list's row as { banList, suspendedAt, suspendedBy, reason, resumedAt }, by ban list
// ID, or only that of the ban list given. With missingTable 'empty', the default, a table the
// importer has not made yet gives none, as no list can be paused before it has; with 'throw', its
// error is passed on, as the database gives it. Other errors are passed on too.
export async function readPausedBanLists({
  banList = null,
  transaction = null,
  missingTable = 'empty'
} = {}) {
  try {
    const rows = await sequelize.query(
      banList === null ? `${READ} ORDER BY banList` : `${READ} WHERE banList = ?`,
      {
        type: QueryTypes.SELECT,
        replacements: banList === null ? [] : [banList],
        transaction
      }
    );
    return rows.map((row) => ({ ...row, banList: Number(row.banList) }));
  } catch (err) {
    if (missingTable !== 'throw' && isMissingTable(err)) return [];
    throw err;
  }
}

// The IDs of the paused lists in rows, as rows of readPausedBanLists give them, in two sets, each
// in order: those the importer does not import (suspended), and those whose bans count for nothing
// (excluded), which are the suspended and the resuming lists.
export function pausedSets(rows) {
  const ids = (filter) =>
    rows
      .filter(filter)
      .map(({ banList }) => Number(banList))
      .sort((a, b) => a - b);
  return {
    suspended: ids(({ resumedAt }) => resumedAt === null || resumedAt === undefined),
    excluded: ids(() => true)
  };
}

// The IDs of the lists whose bans count for nothing now, in order.
export async function readExcludedBanLists(options) {
  return pausedSets(await readPausedBanLists(options)).excluded;
}

// Suspend a ban list, as the admin by gives, e.g. "name (ID)", for the reason given, if any.
// Resolves with { outcome, row }:
// - 'suspended': the list is suspended now, and row is its new row. A list that was resuming is
//   suspended again, as from now (resumed is true).
// - 'already': the list was suspended already, and row is that suspension's row, unchanged.
// - 'gone': the list does not exist, e.g. as it was removed meanwhile.
// A missing table is passed on as the database gives it (see isMissingTable).
export async function suspendBanList(banList, { by, reason = null }) {
  const values = {
    banList,
    by: String(by).slice(0, MAX_BY_LENGTH),
    reason: reason ? String(reason).slice(0, MAX_REASON_LENGTH) : null
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await sequelize.transaction(async (transaction) => {
        const [current] = await sequelize.query(`${READ} WHERE banList = :banList FOR UPDATE`, {
          type: QueryTypes.SELECT,
          replacements: values,
          transaction
        });
        if (current && current.resumedAt === null)
          return { outcome: 'already', row: { ...current, banList: Number(current.banList) } };

        if (current)
          await sequelize.query(
            `UPDATE BanListSuspensions
             SET suspendedAt = UTC_TIMESTAMP(3), suspendedBy = :by, reason = :reason, resumedAt = NULL
             WHERE banList = :banList`,
            { replacements: values, transaction }
          );
        else
          await sequelize.query(
            `INSERT INTO BanListSuspensions (banList, suspendedAt, suspendedBy, reason, resumedAt)
             VALUES (:banList, UTC_TIMESTAMP(3), :by, :reason, NULL)`,
            { replacements: values, transaction }
          );
        const [row] = await readPausedBanLists({ banList, transaction, missingTable: 'throw' });
        return { outcome: 'suspended', resumed: Boolean(current), row };
      });
    } catch (err) {
      const errno = errnoOf(err);
      if (errno === NO_REFERENCED_ROW) return { outcome: 'gone', row: null };
      // Another suspension of the same list got in first: the next attempt finds its row.
      if (attempt < ATTEMPTS && (errno === DUPLICATE_KEY || errno === DEADLOCK)) continue;
      throw err;
    }
  }
}

// Resume a suspended ban list. Resolves with { outcome, row }:
// - 'resuming': the list is resuming now, and row is its row, with resumedAt set.
// - 'already': the list was resuming already, and row is its row, unchanged.
// - 'not_paused': the list is not paused, and row is null.
// Its row is locked while it is read and changed, so of two resumptions at once, or a resumption
// and a suspension, the second sees what the first did. A missing table is passed on as the
// database gives it (see isMissingTable).
export async function resumeBanList(banList) {
  return sequelize.transaction(async (transaction) => {
    const [current] = await sequelize.query(`${READ} WHERE banList = ? FOR UPDATE`, {
      type: QueryTypes.SELECT,
      replacements: [banList],
      transaction
    });
    if (!current) return { outcome: 'not_paused', row: null };
    if (current.resumedAt !== null)
      return { outcome: 'already', row: { ...current, banList: Number(current.banList) } };

    await sequelize.query(
      `UPDATE BanListSuspensions SET resumedAt = UTC_TIMESTAMP(3)
       WHERE banList = ? AND resumedAt IS NULL`,
      { replacements: [banList], transaction }
    );
    const [row] = await readPausedBanLists({ banList, transaction, missingTable: 'throw' });
    return { outcome: 'resuming', row };
  });
}

// A time as MySQL's DATETIME(3) columns hold it: in UTC, to the millisecond. A Date given to a query
// as it is loses its milliseconds, and is written in the process's own time zone.
function sqlTime(date) {
  return new Date(date).toISOString().replace('T', ' ').replace('Z', '');
}

// Delete a resuming list's row, once the importer has caught up with the list, so the list counts
// again. Only the importer calls this. The row is only deleted while its resumedAt is still the one
// the importer read (resumedAt, a Date, compared to the millisecond), so a list suspended again
// since stays suspended, and one resumed again stays resuming until the importer catches up since
// then. Resolves with whether it deleted the row.
export async function endResumption(banList, resumedAt) {
  const deleted = await sequelize.query(
    'DELETE FROM BanListSuspensions WHERE banList = ? AND resumedAt = CAST(? AS DATETIME(3))',
    { replacements: [banList, sqlTime(resumedAt)], type: QueryTypes.BULKDELETE }
  );
  return Number(deleted) > 0;
}

// The ImporterState row of the importer's reputation check, which keeps the paused lists whose
// bans the players it last settled were recalculated without (see
// ban-importer/src/reputation-check.js, whose STATE_ROW it is).
export const REPUTATION_CHECK_ROW = 'reputationCheck';

// The IDs of the paused lists that the importer's reputation check has settled players without, as
// its row names them, in order: deleting the bans of one of them changes no player's points, as its
// players were recalculated without them, or the check finds them again once the list is no longer
// paused. Deleting those of a list paused since the check last ran does, as nothing would find its
// players again, so they must be queued. None, when the row or the table is not there yet.
export async function readSettledPausedBanLists() {
  try {
    const [row] = await sequelize.query('SELECT value FROM ImporterState WHERE name = ?', {
      type: QueryTypes.SELECT,
      replacements: [REPUTATION_CHECK_ROW]
    });
    let value = row?.value;
    if (typeof value === 'string') value = JSON.parse(value);
    const ids = Array.isArray(value?.excludedBanLists) ? value.excludedBanLists : [];
    return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort(
      (a, b) => a - b
    );
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}
