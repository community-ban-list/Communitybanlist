import { pausedSets, readPausedBanLists } from 'scbl-lib/db/ban-list-suspensions';

import { retryOperation } from './apply-list.js';

// The ban lists an admin has paused, as a run sees them (see scbl-lib/db/ban-list-suspensions.js):
// read once a run, or in loop mode once a cycle, by the first step that needs them, after the
// run's migrations have made their table, and shared by every later step of the run. So every step
// of a run leaves out the same lists: the import does not import the suspended ones, and the
// reputation check, the recalculation of points and that of export bans all leave out the bans of
// the suspended and the resuming ones (excluded). A list paused or resumed while a run is under way
// is seen by the next run, and the reputation check then settles its players (see
// reputation-check.js).

// The run whose lists were read, by when it started, and the read, as a promise.
let read = null;

// The paused lists, for the run that started at startedAt, as the steps' settings give it:
// { rows, suspended, excluded }, rows as readPausedBanLists gives them and the two sets of IDs as
// pausedSets gives them. They are read once for each run, and a read that fails is tried again by
// the next step that asks, so a run never goes on with a partial view. With no startedAt, e.g. when
// a step is run on its own, they are read afresh. The table must be there: a missing one fails the
// step, as it means the run's migrations did not run.
export default function pausedBanLists({ startedAt } = {}) {
  const readNow = () =>
    retryOperation(() => readPausedBanLists({ missingTable: 'throw' })).then((rows) => ({
      rows,
      ...pausedSets(rows)
    }));
  // A step run on its own reads them for itself, and leaves the run's read as it is.
  if (startedAt === undefined) return readNow();
  if (read?.startedAt !== startedAt) {
    const promise = readNow();
    read = { startedAt, promise };
    promise.catch(() => {
      if (read?.promise === promise) read = null;
    });
  }
  return read.promise;
}
