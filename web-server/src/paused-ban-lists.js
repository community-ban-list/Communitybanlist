import { pausedSets, readPausedBanLists } from 'scbl-lib/db/ban-list-suspensions';

// The ban lists an admin has paused, whose bans count for nothing (see
// scbl-lib/db/ban-list-suspensions.js), which the website leaves out of its lists of bans and ban
// lists, and marks on players' pages. Each request is answered with them as read at most this long
// ago, so a list paused or resumed shows within seconds, while most requests read nothing.
export const MAX_AGE = 10 * 1000;

// The last read, as a promise, and when it started.
let cached = null;

// The IDs of the paused ban lists, as a Set, read at most MAX_AGE ago, at now. Until the importer
// has made the table of paused lists, none is paused. A read that fails is passed on, and the next
// request reads them again.
export default function pausedBanLists(now = Date.now()) {
  if (!cached || now - cached.at >= MAX_AGE || now < cached.at) {
    const promise = readPausedBanLists().then((rows) => new Set(pausedSets(rows).excluded));
    cached = { at: now, promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
  }
  return cached.promise;
}
