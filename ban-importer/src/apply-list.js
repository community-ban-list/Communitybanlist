import { sequelize } from 'scbl-lib/db';
import {
  ForeignKeyConstraintError,
  QueryTypes,
  ValidationError,
  isDatabaseUnavailable
} from 'scbl-lib/db/sequelize';
import { describeError, Logger } from 'scbl-lib/utils';

import { isStopping } from './run-control.js';

// Bringing a ban list's bans in the database up to date with the bans its source gave, without
// writing what has not changed. The list's stored bans are read with one query and compared with
// the bans fetched, here in JavaScript, and only the bans that are new or changed are written, in
// transactions of BATCH_SIZE bans that also add their players and queue those players for an
// update. The bans the list no longer has are removed by the rules of planRemovals, also in
// transactions of BATCH_SIZE bans. ban-importer.js decides what is applied to each list.

// Thank god for this function.

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

// MySQL's error numbers for a deadlock and a lock wait timeout, after which the statement, or the
// transaction it was in, can be run again.
const LOCK_ERRORS = [1213, 1205];

// Sequelize reports a transaction that MySQL had already rolled back, e.g. for a deadlock, as this
// error instead.
const ROLLED_BACK = /finished with state: rollback/;

// Whether a failed database operation could work if it is run again. Foreign key and validation
// errors, like anything else not listed here, would only fail again.
export function isRetryable(err) {
  if (err instanceof ForeignKeyConstraintError || err instanceof ValidationError) return false;
  return (
    isDatabaseUnavailable(err) ||
    LOCK_ERRORS.includes(err?.original?.errno) ||
    ROLLED_BACK.test(err?.message)
  );
}

// Run the operation, and run it again while it fails in a way that could pass, up to MAX_RETRIES
// times in all. An operation that is a transaction is run again as a whole, as MySQL rolls back
// all of a transaction that ends in a deadlock.
export async function retryOperation(operation, retries = MAX_RETRIES) {
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

// Whether a ban could not be saved because its ban list was not in the database.
export function isMissingBanList(err) {
  return err instanceof ForeignKeyConstraintError && (err.fields || []).includes('banList');
}

// A time to compare, in milliseconds since 1970, or null for none. MySQL's DATETIME columns come
// back as Dates, and text in their format is read as UTC, as the CBL's connections use UTC. An
// invalid time is NaN, which is the same only as another NaN.
export function timeOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.getTime === 'function') return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text))
    return new Date(`${text.replace(' ', 'T')}Z`).getTime();
  return new Date(text).getTime();
}

// Whether a ban has expired, as MySQL's TINYINT gives it (1 or 0) or as the fetcher does (true or
// false), or null for none.
export function flagOf(value) {
  if (value === null || value === undefined) return null;
  return Boolean(Number(value));
}

// Text to compare, with a missing value the same as NULL, as remote bans have no note.
export function textOf(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

// The values of a ban that are compared with the stored ban, each with how it is read, and that
// are written when they differ. A ban's created time is only written when it is new.
const COMPARED = {
  steamUser: textOf,
  expires: timeOf,
  expired: flagOf,
  reason: textOf,
  rawReason: textOf,
  rawNote: textOf
};
export const COMPARED_FIELDS = Object.keys(COMPARED);

function same(field, value, stored) {
  return Object.is(COMPARED[field](value), COMPARED[field](stored));
}

// The player a fetched ban is for, given the player its stored ban has, if it has one: the stored
// player while that is still one of the ban's SteamIDs, so a ban never moves only because its
// SteamIDs are given in another order, and otherwise the player the fetcher chose for a new ban,
// the first SteamID an admin added by hand, or else the first.
export function chooseSteamUser(ban, storedSteamUser) {
  const steamIDs = ban.steamIDs ?? [{ steamID: ban.steamUser }];
  if (storedSteamUser !== undefined && steamIDs.some(({ steamID }) => steamID === storedSteamUser))
    return storedSteamUser;
  return ban.steamUser;
}

// The values of a fetched ban to write, for the player given.
function toWrite(ban, steamUser) {
  return {
    id: ban.id,
    steamUser,
    created: ban.created ?? null,
    expires: ban.expires ?? null,
    expired: Boolean(ban.expired),
    reason: ban.reason ?? null,
    rawReason: ban.rawReason ?? null,
    rawNote: ban.rawNote ?? null
  };
}

// Compare the bans fetched for a list with the list's stored bans, as readStoredBans gives them.
// Returns:
// - added: the bans that are new, to write;
// - changed: the bans whose values differ from the stored ones, to write, each with the fields that
//   differ (fields) and the player its stored ban has (previousSteamUser);
// - moves: the bans whose stored player is no longer one of their SteamIDs, each with that player
//   (from) and the one it would move to (to). Only with applyMoves is a ban moved, which makes it
//   changed, and otherwise it keeps its stored player;
// - unchanged: how many bans are as they are stored, which are not written.
// Dates are compared by their time, 1 and 0 as true and false, and a missing value as NULL.
export function diffBans(fetched, stored, { applyMoves = false } = {}) {
  const storedBans = new Map(stored.map((row) => [row.id, row]));
  const added = [];
  const changed = [];
  const moves = [];
  let unchanged = 0;
  for (const ban of fetched) {
    const old = storedBans.get(ban.id);
    if (!old) {
      added.push(toWrite(ban, chooseSteamUser(ban)));
      continue;
    }

    let steamUser = old.steamUser;
    const chosen = chooseSteamUser(ban, old.steamUser);
    if (chosen !== old.steamUser) {
      moves.push({ id: ban.id, from: old.steamUser, to: chosen });
      if (applyMoves) steamUser = chosen;
    }

    const write = toWrite(ban, steamUser);
    const fields = COMPARED_FIELDS.filter((field) => !same(field, write[field], old[field]));
    if (fields.length === 0) unchanged++;
    else changed.push({ ...write, fields, previousSteamUser: old.steamUser });
  }
  return { added, changed, moves, unchanged };
}

// How long a ban must have been missing from complete reads of its list, from the first that did
// not have it to the latest, before it is removed, unless it is removed at once.
export const CONFIRM_AFTER = 10 * 60 * 1000;

// Missing bans are removed at once when fewer than this many, and this share of the bans the list
// had before the read, would otherwise wait.
export const REMOVE_AT_ONCE_BANS = 10;
export const REMOVE_AT_ONCE_SHARE = 0.05;

// A list of at least this many bans whose read found none of them keeps them until an admin
// confirms that it lost them all.
export const FULL_REMOVAL_BANS = 10;

// A read that finds at least this many of a list's bans missing, of those no earlier read had
// missed, and at least this share of the bans the list had before the read, keeps them until an
// admin confirms that the list lost them. A source that starts leaving bans out, e.g. its expired
// ones, gives a count that drops with them, so the count check still passes, and only the size of
// the loss shows it. A list loses a handful of bans a day, a few at a time, far fewer than either:
// the 25 decide for a list of up to 125 bans, and the share for a larger one, e.g. 2,356 bans of
// 11,780. A smaller loss still waits for a confirming read, as any loss did before.
export const LARGE_REMOVAL_BANS = 25;
export const LARGE_REMOVAL_SHARE = 0.2;

// The fewest missing bans that are a large loss of a list that had stored bans, by the numbers
// above: 25 for a list of up to 125 bans, and a fifth of a larger one, rounded up, e.g. 40 of 200.
export function largeLossBans(stored) {
  return Math.max(LARGE_REMOVAL_BANS, Math.ceil(stored * LARGE_REMOVAL_SHARE));
}

// Whether losing count bans of a list that had stored bans before the read is a large loss.
export function isLargeLoss(count, stored) {
  return count >= largeLossBans(stored);
}

// The fewest of a 'large' hold's bans still missing that keep it, of the bans it is measured
// against (of, see planRemovals): a large loss of them, or all of them when they are fewer than
// LARGE_REMOVAL_BANS, as for a hold that took in that of a list that lost all of its fewer than 25
// bans, which would otherwise end with none of those back.
export function fewestHeld(of) {
  return Math.min(largeLossBans(of), Math.max(of, 1));
}

// The holds that are recorded in BanListPendingRemovals, as their bans' heldAt, and so last over
// runs, until an admin confirms them or their bans come back: for 'full', any one of those it began
// with, and for 'large', enough that fewer than fewestHeld are still missing. An 'empty' hold is
// not recorded, as every read that finds no bans holds the list again.
export const RECORDED_HOLDS = ['full', 'large'];

// Decide what to do with the bans missing from a complete read of a list: missing is their IDs,
// stored and fetched the numbers of bans the list had before the read and the read found, pending
// when each ban recorded as missing before was first missing, in milliseconds, by its ID, held the
// IDs of the bans the list still has that an earlier run held for an admin, firstHeld, for 'full',
// those of them the hold began with, which are all of them unless it held bans the list saved
// since (below), heldFor the hold that run began, 'full' or 'large', and heldOf, for 'large', the
// bans it is measured against, as its BanListHolds row keeps them, or null when that is not known,
// now the time of the read in milliseconds, replace whether the bans are being replaced by those of
// the list's new source, and confirmed whether the list may lose any number of bans at once.
// Returns:
// - remove: the IDs of the bans to remove now;
// - wait: the IDs of the bans to keep until a later complete read confirms they are gone;
// - hold: why bans wait for an admin to confirm their removal, or null: 'empty' for a read that
//   found no bans, 'full' for one that found none of the bans of a list of at least
//   FULL_REMOVAL_BANS bans, and 'large' for one that found at least LARGE_REMOVAL_BANS, and
//   LARGE_REMOVAL_SHARE of the list, missing that no earlier read had missed; or, for a list an
//   earlier run held, the hold it began (heldFor), while that hold lasts, or 'large' as that hold
//   takes in all of the list's missing bans (below);
// - held: the IDs of the bans that wait for an admin;
// - released: the IDs of the bans an earlier run held that no longer wait for an admin, but for a
//   later complete read, as if first missing now;
// - heldOf, for 'large' only: the bans the hold is measured against from now, which BanListHolds
//   keeps.
// So with confirmed, every missing ban is removed at once. Otherwise a list that seems to have
// lost all its bans keeps them, as its source more likely broke, and so does one that lost a large
// part of them at once, unless its bans are being replaced. A recorded hold lasts until its bans
// are replaced, as the bans the list saved since are not the bans it lost, or until they come back:
// for 'full', any one of those it began with, and for 'large', enough of them that fewer than
// fewestHeld of the bans it is measured against are still missing, those that come back being no
// longer held. A 'full' hold whose list loses all of its bans again, with too few of them saved
// since to be a large loss (below), holds those it saved since with its own: only one of its own
// coming back ends it, and those it saved since that come back meanwhile are no longer held, as
// for 'large'. A 'large' hold is measured against the fewer of heldOf and the bans the list had
// before this read, and against the latter when heldOf is not known: so the list's growth never
// ends it, and a hold of a list that shrank lasts as a hold that began on the smaller list would.
// Once that is saved as its heldOf, it never grows again. While a hold lasts, a read that loses a
// large part of the list's other bans, of those no earlier read had missed, holds every missing
// ban as 'large' from now, and so does one that finds none of the list's bans while it is held as
// 'large': a 'large' hold takes them in, measured as before, and a 'full' one becomes 'large',
// measured against the bans it began with (firstHeld), which keeps those at least until one of them
// comes back, as the 'full' hold would have, also when it held bans the list saved since. Kept as 'full', it would let the large loss go as soon as any one of
// the bans it began with came back.
// Any other missing ban is removed once complete reads have not had it for CONFIRM_AFTER, and
// waits until then, but when fewer than REMOVE_AT_ONCE_BANS and REMOVE_AT_ONCE_SHARE of the list
// would wait, all of them are removed at once.
export function planRemovals({
  missing,
  stored,
  fetched,
  pending = new Map(),
  held = new Set(),
  firstHeld = held,
  heldFor = 'full',
  heldOf = null,
  now = Date.now(),
  replace = false,
  confirmed = false
}) {
  const none = { remove: [], wait: [], hold: null, held: [], released: [] };
  if (missing.length === 0) return none;
  if (confirmed) return { ...none, remove: [...missing] };
  if (!replace && fetched === 0) return { ...none, hold: 'empty', held: [...missing] };

  // A list an earlier run held stays held while its hold lasts: one held as it lost all its bans
  // while none of those it began with has come back, and one held as it lost a large part of them
  // while at least fewestHeld of the bans it is measured against (of) are still missing. Those
  // that came back are no longer held.
  const isMissing = new Set(missing);
  const stillHeld = [...held].filter((id) => isMissing.has(id));
  const of = heldFor === 'large' ? Math.min(heldOf ?? stored, stored) : firstHeld.size;
  const lasts =
    heldFor === 'large'
      ? stillHeld.length >= fewestHeld(of)
      : [...firstHeld].every((id) => isMissing.has(id));
  const holding = !replace && held.size > 0 && lasts;

  // While the hold lasts, the list's other missing bans are removed as usual, unless those of them
  // no earlier read had missed are a large loss, or the read found none of the list's bans while
  // it is held as 'large': the hold then takes in every missing ban, as 'large', from now. A 'full'
  // hold that took them in would end as soon as any one of those it began with came back, and the
  // large loss would then be removed after a confirming read, with no admin. A read that found none
  // of the list's bans otherwise holds them all as 'full': as a hold that begins, or, while a
  // 'full' hold lasts, with it, which still ends only as one of those it began with comes back.
  const lostAll = !replace && missing.length >= stored && stored >= FULL_REMOVAL_BANS;
  const fresh = missing.filter((id) => !pending.has(id) && !held.has(id));
  if (holding && (isLargeLoss(fresh.length, stored) || (lostAll && heldFor === 'large')))
    return { ...none, hold: 'large', held: [...missing], heldOf: of };
  if (lostAll) return { ...none, hold: 'full', held: [...missing] };
  const released = new Set(holding ? [] : stillHeld);
  let others = holding ? missing.filter((id) => !held.has(id)) : missing;

  // A list that is not held, and lost a large part of its bans in this read, holds the bans it
  // lost. Only bans no earlier read had missed count, and are held: those already recorded wait
  // for their confirming read as they did, and those a hold that ended released are not held
  // again.
  let lost = [];
  if (!replace && !holding) {
    lost = others.filter((id) => !pending.has(id));
    if (isLargeLoss(lost.length, stored)) others = others.filter((id) => pending.has(id));
    else lost = [];
  }

  const due = (id) =>
    !released.has(id) && pending.has(id) && now - pending.get(id) >= CONFIRM_AFTER;
  const wait = others.filter((id) => !due(id));
  const plan =
    wait.length < Math.max(REMOVE_AT_ONCE_BANS, stored * REMOVE_AT_ONCE_SHARE)
      ? { remove: [...others], wait: [] }
      : { remove: others.filter(due), wait };
  if (lost.length > 0)
    return { ...plan, hold: 'large', held: lost, released: [...released], heldOf: stored };
  if (holding && heldFor === 'large')
    return { ...plan, hold: 'large', held: stillHeld, released: [], heldOf: of };
  return {
    ...plan,
    hold: holding ? heldFor : null,
    held: holding ? stillHeld : [],
    released: [...released]
  };
}

// The bans written, and the bans removed, at most this many in one transaction.
export const BATCH_SIZE = 500;

// Queue players for an update of their Steam profile, export bans, and reputation points and rank,
// which the later steps of the run make for players whose time of their last update is NULL.
const QUEUE_PLAYERS =
  'UPDATE SteamUsers SET lastRefreshedInfo = NULL, lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';

// A ban, new or changed, is written with one statement, which never changes when the ban was
// created. MySQL 8.0.19 and later take a row alias, here new, for the values given.
const WRITE_BANS =
  'INSERT INTO Bans (id, created, expires, expired, reason, rawReason, rawNote, steamUser, banList, createdAt, updatedAt) VALUES';
const ON_DUPLICATE_BAN =
  'AS new ON DUPLICATE KEY UPDATE steamUser = new.steamUser, expires = new.expires, expired = new.expired, reason = new.reason, rawReason = new.rawReason, rawNote = new.rawNote, updatedAt = new.updatedAt';

// Placeholders for rows of values, e.g. (?, ?), (?, ?) for 2 rows of 2 values.
export function placeholders(rows, columns) {
  const row = `(${Array(columns).fill('?').join(', ')})`;
  return Array(rows).fill(row).join(', ');
}

// A time as MySQL's DATETIME columns take it, in UTC and to the millisecond, as the CBL's models
// write times, or null. A Date given to a query as it is loses its milliseconds, so a ban written
// that way would differ from its source on every run. Throws for an invalid time.
export function sqlTime(value) {
  if (value === null || value === undefined) return null;
  return new Date(timeOf(value)).toISOString().replace('T', ' ').replace('Z', '');
}

// The number of rows a statement changed, from what Sequelize resolves with: [result, metadata],
// or [insertId, affectedRows] for an INSERT.
export function affectedRows(result) {
  if (!Array.isArray(result)) return 0;
  if (typeof result[1] === 'number') return result[1];
  return result[0]?.affectedRows ?? 0;
}

// The list's stored bans, with the values the import compares.
export function readStoredBans(banList) {
  return sequelize.query(
    'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ?',
    { replacements: [banList], type: QueryTypes.SELECT }
  );
}

// The list's stored bans with the IDs given, with the values the import compares, which a head poll
// reads for the bans on the pages it read, rather than all of the list's.
export async function readStoredBansByID(banList, ids) {
  if (ids.length === 0) return [];
  return sequelize.query(
    'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ? AND id IN (?)',
    { replacements: [banList, ids], type: QueryTypes.SELECT }
  );
}

// For each list with bans that complete reads of it did not have, by list: when the first of those
// that wait for a confirming read is due to be confirmed as gone (confirmAt), CONFIRM_AFTER after it
// was first missing, in milliseconds, or null when none wait, how many are held for an admin (held)
// and how many wait for a confirming read (waiting). A run reads it once, to decide which lists to
// read in full, and to count the bans kept by the lists it only polls.
export async function readPendingSummary() {
  const rows = await sequelize.query(
    'SELECT banList, MIN(CASE WHEN heldAt IS NULL THEN firstMissingAt END) AS firstMissingAt, SUM(heldAt IS NOT NULL) AS held, SUM(heldAt IS NULL) AS waiting FROM BanListPendingRemovals GROUP BY banList',
    { type: QueryTypes.SELECT }
  );
  return new Map(
    rows.map(({ banList, firstMissingAt, held, waiting }) => {
      const first = timeOf(firstMissingAt);
      return [
        Number(banList),
        {
          confirmAt: first === null ? null : first + CONFIRM_AFTER,
          held: Number(held) || 0,
          waiting: Number(waiting) || 0
        }
      ];
    })
  );
}

// The list's bans that earlier complete reads did not have, by ID, each with when the first of them
// did not (firstMissingAt), and when a run began holding it for an admin (heldAt), or null, in
// milliseconds.
export async function readPendingRemovals(banList) {
  const rows = await sequelize.query(
    'SELECT banId, firstMissingAt, heldAt FROM BanListPendingRemovals WHERE banList = ?',
    { replacements: [banList], type: QueryTypes.SELECT }
  );
  return new Map(
    rows.map(({ banId, firstMissingAt, heldAt }) => [
      banId,
      { firstMissingAt: timeOf(firstMissingAt), heldAt: timeOf(heldAt) }
    ])
  );
}

// Write a batch of bans in one transaction: add their players that are new, write the bans, and
// queue for an update their players and, for a changed ban, the player it had before.
async function writeBatch(banList, writes, now) {
  const players = [...new Set(writes.map(({ steamUser }) => steamUser))];
  const queued = [
    ...new Set(
      writes.flatMap(({ steamUser, previousSteamUser }) =>
        previousSteamUser ? [steamUser, previousSteamUser] : [steamUser]
      )
    )
  ];
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `INSERT IGNORE INTO SteamUsers (id, createdAt, updatedAt) VALUES ${placeholders(players.length, 3)}`,
      { replacements: players.flatMap((id) => [id, now, now]), transaction }
    );
    await sequelize.query(`${WRITE_BANS} ${placeholders(writes.length, 11)} ${ON_DUPLICATE_BAN}`, {
      replacements: writes.flatMap((write) => [
        write.id,
        sqlTime(write.created ?? now),
        sqlTime(write.expires),
        write.expired,
        write.reason,
        write.rawReason,
        write.rawNote,
        write.steamUser,
        banList,
        now,
        now
      ]),
      transaction
    });
    await sequelize.query(QUEUE_PLAYERS, { replacements: [queued], transaction });
  });
}

// Write the list's bans, new and changed, as diffBans gives them, in transactions of batchSize
// bans, each run again as a whole while it fails in a way that could pass. onWritten is given the
// bans of each transaction once it is committed. A batch that fails in another way is written again
// a ban at a time, so that only the bans that cannot be saved are left out, each of which is passed
// to onFailed with its error. Once the run is asked to stop, no more batches are started. Throws if
// the database stays unavailable, or the list is not in the database. Resolves with whether the
// writes stopped part-way.
export async function writeBans(
  banList,
  writes,
  { batchSize = BATCH_SIZE, now = new Date(), onWritten = () => {}, onFailed = () => {} } = {}
) {
  for (let i = 0; i < writes.length; i += batchSize) {
    if (isStopping()) return { stopped: true };
    const batch = writes.slice(i, i + batchSize);
    try {
      await retryOperation(() => writeBatch(banList, batch, now));
      onWritten(batch);
      continue;
    } catch (err) {
      if (isRetryable(err) || isMissingBanList(err)) throw err;
      if (batch.length === 1) {
        onFailed(batch[0], err);
        continue;
      }
    }
    for (const write of batch) {
      try {
        await retryOperation(() => writeBatch(banList, [write], now));
        onWritten([write]);
      } catch (err) {
        if (isRetryable(err) || isMissingBanList(err)) throw err;
        onFailed(write, err);
      }
    }
  }
  return { stopped: false };
}

// Remove bans from the list, each given as { id, steamUser }, and optionally the player it had
// before (previousSteamUser), in transactions of batchSize bans, each of which also queues the bans'
// players for an update, as they lost a ban, and drops the bans' records in BanListPendingRemovals.
// onRemoved is given how many bans each transaction removed once it is committed, and the bans of
// that batch, whose records it dropped, so a removal cut short part-way still counts those it made.
// Resolves with the number of bans removed.
export async function removeBans(
  banList,
  bans,
  { batchSize = BATCH_SIZE, onRemoved = () => {} } = {}
) {
  let removed = 0;
  for (let i = 0; i < bans.length; i += batchSize) {
    const batch = bans.slice(i, i + batchSize);
    const ids = batch.map(({ id }) => id);
    const players = [
      ...new Set(
        batch.flatMap(({ steamUser, previousSteamUser }) =>
          previousSteamUser ? [steamUser, previousSteamUser] : [steamUser]
        )
      )
    ];
    const count = await retryOperation(() =>
      sequelize.transaction(async (transaction) => {
        await sequelize.query(QUEUE_PLAYERS, { replacements: [players], transaction });
        const result = await sequelize.query('DELETE FROM Bans WHERE banList = ? AND id IN (?)', {
          replacements: [banList, ids],
          transaction
        });
        await sequelize.query(
          'DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)',
          { replacements: [banList, ids], transaction }
        );
        return affectedRows(result);
      })
    );
    removed += count;
    onRemoved(count, batch);
  }
  return removed;
}

// Record that a batch of the list's bans, by ID, were missing from the complete read of it at now,
// with one statement, in the transaction given, if any: as first missing then, if they are not
// recorded yet, and as last missing then. With held, they are held for an admin, from now if they
// were not already, which keeps when that began.
function recordMissing(banList, batch, { now, held, transaction }) {
  return sequelize.query(
    `INSERT INTO BanListPendingRemovals (banList, banId, firstMissingAt, lastMissingAt, heldAt) VALUES ${placeholders(batch.length, 5)} AS new ON DUPLICATE KEY UPDATE lastMissingAt = new.lastMissingAt, heldAt = COALESCE(BanListPendingRemovals.heldAt, new.heldAt)`,
    {
      replacements: batch.flatMap((id) => [
        banList,
        id,
        sqlTime(now),
        sqlTime(now),
        held ? sqlTime(now) : null
      ]),
      transaction
    }
  );
}

// Record that the bans, by ID, were missing from the complete read of the list at now, and wait for
// a later complete read, a statement for each batch of batchSize bans (see recordMissing). onSaved
// is given how many bans each statement recorded once it has, and their IDs, so records cut short
// part-way still count those that were saved.
export async function savePendingRemovals(
  banList,
  ids,
  { now, batchSize = BATCH_SIZE, onSaved = () => {} }
) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await retryOperation(() => recordMissing(banList, batch, { now, held: false }));
    onSaved(batch.length, batch);
  }
}

const CLEAR_PENDING = 'DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)';
const RELEASE_HELD =
  'UPDATE BanListPendingRemovals SET firstMissingAt = ?, lastMissingAt = ?, heldAt = NULL WHERE banList = ? AND heldAt IS NOT NULL';
const SAVE_HOLD =
  'INSERT INTO BanListHolds (banList, reason, storedCount) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE reason = new.reason, storedCount = new.storedCount';
const CLEAR_HOLD = 'DELETE FROM BanListHolds WHERE banList = ?';

// Write what a read changes of the list's hold for an admin in one transaction, run again as a
// whole while it fails in a way that could pass, so all of it is written, or none of it, in this
// order:
// - back: the bans, by ID, that the read found again lose their records: the held bans that came
//   back, and those that waited for a confirming read, which a read of the list drops before its
//   bans are saved, also with no hold to write, as for a read that is not complete;
// - release: the list's held bans no longer wait for an admin, but for a later complete read, as
//   if first missing at now, as its hold ended, or begins anew (see planRemovals);
// - reason: why its bans are held, with the bans a 'large' hold is measured against (stored), is
//   saved in BanListHolds, for a hold that begins, or one whose reason or count changes; or with
//   end, and no reason, the list's row there is deleted, as its hold ended;
// - ids: the hold's bans are recorded as missing from the complete read at now and held, from now
//   unless they already were, a statement for each batch of batchSize bans (see recordMissing).
// A run cut short in it, e.g. by a database outage longer than the retries or the process being
// killed, writes none of it, so the next complete read finds the list held as it was, or not held
// at all. A hold that keeps bans is written before the read's new and changed bans are saved, so
// that read finds the same loss, against the same bans, and one that only ends once they are, as it
// lets bans go, so a run cut short before then leaves it as it was (see keepMissingBans in
// ban-importer.js). Written a statement at a time, a hold cut short as it ended could leave a
// 'large' row with fewer of its bans held than such a hold keeps, and one cut short as it began
// could leave part of its bans held, so that the next read took the list as held, and the rest of
// the bans it lost as missing besides, which would wait for a confirming read that removes them.
export async function saveHold(
  banList,
  ids,
  {
    back = [],
    release = false,
    reason = null,
    stored = null,
    end = false,
    now,
    batchSize = BATCH_SIZE
  }
) {
  await retryOperation(() =>
    sequelize.transaction(async (transaction) => {
      for (let i = 0; i < back.length; i += batchSize)
        await sequelize.query(CLEAR_PENDING, {
          replacements: [banList, back.slice(i, i + batchSize)],
          transaction
        });
      if (release)
        await sequelize.query(RELEASE_HELD, {
          replacements: [sqlTime(now), sqlTime(now), banList],
          transaction
        });
      if (reason !== null)
        await sequelize.query(SAVE_HOLD, { replacements: [banList, reason, stored], transaction });
      else if (end) await sequelize.query(CLEAR_HOLD, { replacements: [banList], transaction });
      for (let i = 0; i < ids.length; i += batchSize)
        await recordMissing(banList, ids.slice(i, i + batchSize), { now, held: true, transaction });
    })
  );
}

// The hold the list's held bans were held for, as BanListHolds keeps it: why, 'full' or 'large'
// (reason), and the bans a 'large' hold is measured against (stored): those the list had before
// the read that began it, or fewer, as the list shrank since, or for one that took in a 'full'
// hold, the bans that hold held. Or null when it keeps none: the bans of a list held by an
// importer from before that table were held as it lost all of them, the only hold that importer
// recorded.
export async function readHold(banList) {
  const [row] = await sequelize.query(
    'SELECT reason, storedCount FROM BanListHolds WHERE banList = ?',
    { replacements: [banList], type: QueryTypes.SELECT }
  );
  if (!row) return null;
  const stored = Number(row.storedCount ?? NaN);
  return { reason: row.reason, stored: Number.isFinite(stored) ? stored : null };
}

// Why the list's held bans are held, as planRemovals takes it, from the hold readHold gives
// (recorded), how many of the bans the list still has are held (held), and the bans the list had
// before the read (stored): heldFor, 'full' or 'large', and for 'large', heldOf, the bans it is
// measured against, or null when that is not known. Bans held with no reason recorded were held by
// an importer from before BanListHolds, as the list lost all of them, the only hold it recorded,
// so they are taken as 'full', as are those of any reason but 'large'. So are those of a list
// whose reason says 'large' while fewer of its bans are held than fewestHeld, measured as
// planRemovals measures it. This importer never leaves a 'large' hold so: the held bans that come
// back while it lasts lose their records in the transaction that goes on with the rest, or that
// ends it, and the count it is measured against only ever drops, with the list, in the same
// transaction (see saveHold). So such a reason outlived its hold, e.g. as the previous image, which
// deletes none, ended it, and then held the list as it lost all of its bans, or someone deleted
// held bans by hand. Taken as 'large', the hold would end with none of its bans back.
export function whyHeld(recorded, held, stored) {
  if (
    recorded?.reason === 'large' &&
    held >= fewestHeld(Math.min(recorded.stored ?? stored, stored))
  )
    return { heldFor: 'large', heldOf: recorded.stored };
  return { heldFor: 'full', heldOf: null };
}

// Forget the hold the list's bans were held for, once none of them is held any longer.
export async function clearHoldReason(banList) {
  await retryOperation(() => sequelize.query(CLEAR_HOLD, { replacements: [banList] }));
}

// Drop the records of bans, by ID, that a read found again, or that the list no longer has.
export async function clearPendingRemovals(banList, ids, { batchSize = BATCH_SIZE } = {}) {
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await retryOperation(() => sequelize.query(CLEAR_PENDING, { replacements: [banList, batch] }));
  }
}
