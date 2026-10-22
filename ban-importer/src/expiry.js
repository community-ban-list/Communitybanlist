import { sequelize } from 'scbl-lib/db';
import { QueryTypes } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import { affectedRows, BATCH_SIZE, retryOperation, sqlTime } from './apply-list.js';
import { reportProgress, stopIfRequested } from './run-control.js';

// Marking bans as expired once their expiry has passed. Whether a ban has expired is stored with
// it, and the export ban lists and the website read that flag, but the import only sets it when it
// fetches the ban. So a temporary ban of a list that is not fetched, e.g. as its source is failing
// or it imports one of CBL's own export ban lists, would otherwise count as active for as long as
// that lasts, and one that expires after its list was fetched would until its list is fetched
// again. This step finds every ban whose expiry has passed but whose flag still says it has not,
// wherever its list is, and marks it expired, queueing its player so that their reputation and
// export bans are recalculated with it expired.

// The bans whose expiry has passed but which are not marked expired, read without locking anything.
// A flag of NULL counts as not expired, as the export ban lists take it. The time is given in UTC,
// as the importer writes every time, so the comparison is right whatever the time zone of the
// database or of the connection.
const FIND_EXPIRED =
  'SELECT id, steamUser FROM Bans WHERE (expired = 0 OR expired IS NULL) AND expires IS NOT NULL AND expires <= CAST(? AS DATETIME(3))';

// Mark a batch of bans expired, by ID, unless something else changed them since they were read.
const MARK_EXPIRED =
  'UPDATE Bans SET expired = 1, updatedAt = ? WHERE id IN (?) AND (expired = 0 OR expired IS NULL) AND expires IS NOT NULL AND expires <= CAST(? AS DATETIME(3))';

// Queue players for a recalculation of their reputation points and rank and their export bans,
// which the later steps make for players whose time of their last one is NULL. Their Steam profile
// is not refreshed for it, as their bans did not change.
const QUEUE_RECALCULATION =
  'UPDATE SteamUsers SET lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';

// Mark a batch of bans, each given as { id, steamUser }, as expired, and queue their players, in one
// transaction. Resolves with how many bans were marked and how many players were queued.
async function expireBatch(batch, now) {
  const players = [...new Set(batch.map(({ steamUser }) => steamUser))];
  return sequelize.transaction(async (transaction) => {
    const result = await sequelize.query(MARK_EXPIRED, {
      replacements: [now, batch.map(({ id }) => id), now],
      transaction
    });
    await sequelize.query(QUEUE_RECALCULATION, { replacements: [players], transaction });
    return { bans: affectedRows(result), players: players.length };
  });
}

// Mark as expired every ban whose expiry has passed but that is not marked so, in transactions of
// batchSize bans, each of which also queues the bans' players for a recalculation. A transaction
// that ends in a deadlock, or finds the database unavailable, is run again as a whole. It counts in
// counts how many bans it found (due) and marked (expired), and how many players it queued
// (players), also when the run is asked to stop, which it does between transactions. now is the
// time the bans' expiries are compared with.
export async function expireBans(counts = {}, { now = new Date(), batchSize = BATCH_SIZE } = {}) {
  const startTime = Date.now();
  Object.assign(counts, { due: 0, expired: 0, players: 0 });
  const time = sqlTime(now);

  Logger.verbose('Expiry', 2, 'Finding bans whose expiry has passed...');
  const due = await retryOperation(() =>
    sequelize.query(FIND_EXPIRED, { replacements: [time], type: QueryTypes.SELECT })
  );
  counts.due = due.length;

  for (let i = 0; i < due.length; i += batchSize) {
    reportProgress(i, due.length, 'bans');
    // A run that is asked to stop does so between transactions.
    stopIfRequested();
    const { bans, players } = await retryOperation(() =>
      expireBatch(due.slice(i, i + batchSize), time)
    );
    counts.expired += bans;
    counts.players += players;
  }
  reportProgress(due.length, due.length, 'bans');

  Logger.verbose(
    'Expiry',
    2,
    `Marked ${counts.expired} of ${counts.due} bans whose expiry has passed as expired, and queued their ${counts.players} players for a recalculation. Took ${((Date.now() - startTime) / 1000).toFixed(2)}s`
  );
}
