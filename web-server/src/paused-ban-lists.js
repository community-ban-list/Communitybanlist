import { pausedSets, readPausedBanLists } from 'scbl-lib/db/ban-list-suspensions';

// The ban lists an admin has paused, whose bans count for nothing (see
// scbl-lib/db/ban-list-suspensions.js), which the website leaves out of its lists of bans and ban
// lists, and marks on players' pages. Each request is answered with them as read at most this long
// ago, so a list paused or resumed shows within seconds, while most requests read nothing.
export const MAX_AGE = 10 * 1000;

// The last read, as a promise, and when it started, and the paused lists of the last read that
// worked.
let cached = null;
let lastGood = new Set();

// The IDs of the paused ban lists, as a Set, read at most MAX_AGE ago, at now. Until the importer
// has made the table of paused lists, none is paused. Every GraphQL request waits for them, so a
// read that fails, e.g. as the database is down, never fails the request: it is answered with the
// paused lists of the last read that worked, or none, and the next request reads them again. The
// request's own queries then fail as they would have.
export default function pausedBanLists(now = Date.now()) {
  if (!cached || now - cached.at >= MAX_AGE || now < cached.at) {
    const promise = readPausedBanLists().then(
      (rows) => (lastGood = new Set(pausedSets(rows).excluded)),
      (err) => {
        if (cached?.promise === promise) cached = null;
        console.warn(
          `Warning: could not read the paused ban lists: ${err?.name ?? 'Error'}: ${err?.message ?? err}`
        );
        return lastGood;
      }
    );
    cached = { at: now, promise };
  }
  return cached.promise;
}
