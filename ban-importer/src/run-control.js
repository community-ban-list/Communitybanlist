// A run can be asked to stop part-way: by SIGTERM or SIGINT, by its time limit, or because it lost
// its run lock. It then stops at the next safe point, e.g. between ban lists or between export
// bans, and never between a BattleMetrics request and the database save that records it.
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
