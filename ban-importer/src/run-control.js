// A run can be asked to stop part-way: by SIGTERM or SIGINT, by its time limit, or because it lost
// its run lock. It then stops at the next safe point, e.g. between ban lists or between export
// bans, and never between a BattleMetrics request and the database save that records it. The
// steps also say here how far they have got, which the run's status in the log channel shows.
//
// This file has no imports, so it can be loaded on its own.

// The reason given when the run lost its run lock. That makes it a failed run, not an interrupted
// one.
export const LOCK_LOST = 'it lost its run lock';

// Why the run was asked to stop, e.g. 'it received SIGTERM', or null while it should carry on.
let stopReason = null;

let resolveStopRequest;
// Settles, with the reason, when the run is asked to stop.
export const stopRequest = new Promise((resolve) => {
  resolveStopRequest = resolve;
});

// The run lock the run holds.
let runLock = null;

// Told how far the step under way has got, while the run listens.
let progressListener = null;

// Thrown at a safe point to end a run that was asked to stop.
export class RunStopped extends Error {
  constructor(reason) {
    super(`The CBL update run stopped before it finished, as ${reason}.`);
    this.name = 'RunStopped';
    this.reason = reason;
  }
}

// Ask the run to stop at the next safe point. The first reason given is kept.
export function requestStop(reason) {
  if (stopReason !== null) return;
  stopReason = reason;
  resolveStopRequest(reason);
}

export function isStopping() {
  return stopReason !== null;
}

// Called at each safe point, to end the run there if it was asked to stop.
export function stopIfRequested() {
  if (stopReason !== null) throw new RunStopped(stopReason);
}

export function setRunLock(lock) {
  runLock = lock;
}

// Called before deleting or exporting bans, which two runs must never do at once: ends the run
// unless it still holds the run lock.
export async function checkRunLock() {
  if (runLock && (await runLock.isHeld())) return;
  requestStop(LOCK_LOST);
  throw new RunStopped(LOCK_LOST);
}

// Listen to how far each step gets, or stop listening with null. The run listens while it holds
// the run lock, to show the step's progress in its status.
export function setProgressListener(listener) {
  progressListener = listener;
}

// Say how far the step under way has got: done of total, counted in unit, e.g. 7 of 20 'ban
// lists'. Steps call it as they go, as often as they like, and it never holds them up or fails
// them.
export function reportProgress(done, total, unit) {
  if (!progressListener) return;
  try {
    progressListener({ done, total, unit });
  } catch (err) {
    console.warn(`Warning: could not show a step's progress: ${err?.message}`);
  }
}
