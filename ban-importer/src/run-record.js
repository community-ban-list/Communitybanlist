import { sequelize } from 'scbl-lib/db';
import { ImporterSchemaMigration, ImporterState } from 'scbl-lib/db/importer-models';
import { describeError, Logger } from 'scbl-lib/utils';

// The record of a run: when it ran, which commit it ran, how long each phase took, the counts its
// steps reported and how it ended. Every run prints its record as one JSON line when it ends, and a
// run that held the run lock also saves it in ImporterState, where the staleness check reads it.

// The record's JSON line starts with this, so it can be found among the run's other output.
export const RECORD_EVENT = 'cbl-importer-run';

// The ImporterState rows of the run record.
export const STATE = {
  // The record of the latest run, as its JSON line shows it.
  LAST_RUN: 'lastRun',
  // When the latest successful run started (see succeeded).
  LAST_SUCCESS_AT: 'lastSuccessAt',
  // A summary of each of the latest runs, oldest first.
  RECENT_RUNS: 'recentRuns',
  // When the run, or the skipped start, that last posted that the importer is stale started.
  LAST_STALE_ALERT_AT: 'lastStaleAlertAt',
  // The status message in the log channel of the latest run that posted one, and when that run
  // started, so the next run can correct it if the run's last edit did not reach Discord.
  LAST_RUN_MESSAGE: 'lastRunMessage'
};

// The ImporterState rows of the importer service, which runs the importer in a loop (see loop.js).
export const SERVICE_STATE = {
  // The service's status message in the log channel, which the next process edits rather than
  // posting another, or posts again below newer messages, whether the process that last kept it up
  // to date said how it ended, and the old copies of the message that may still be in the channel.
  SERVICE: 'importerService'
};

// Why a start was skipped, by the lock it found held (see takeRunLock): the service lock, which the
// importer service holds for as long as it runs, and a run in once mode for its run, or the run
// lock alone, which only a run of an importer from before the service lock holds.
export const LOCK_HOLDERS = {
  service: 'the importer service or another run holds the service lock',
  run: 'another run holds the run lock'
};

// How many runs recentRuns keeps.
const RECENT_RUNS_KEPT = 100;

// The importer is stale once no run has succeeded for this many times its cadence. Runs start once
// a cadence, and the check compares when runs started, so it is stale when the 3rd run since the
// last success, due 3 cadences after it, fails or is skipped too. Only runs check, at the end of a
// run that did not succeed and at a skipped start, so nothing is posted while no run starts at all.
const STALE_CADENCES = 3;

// Runs start a little before or after their time, e.g. when Docker takes longer to start one, so
// the check allows this much leeway, or a tenth of the cadence if that is less.
const STALE_LEEWAY = 5 * 60 * 1000;

// Why a run did not finish is kept to this many characters.
const MAX_REASON_LENGTH = 500;

// MySQL's error number for a table that does not exist.
const NO_SUCH_TABLE = 1146;

const seconds = (ms) => Math.round(ms / 10) / 100;
const isoTime = (ms) => new Date(ms).toISOString();

// A length of time in minutes, or in hours from 2 hours on.
function duration(ms) {
  const minutes = Math.round(ms / (60 * 1000));
  return minutes < 120 ? `${minutes} minutes` : `${(ms / (60 * 60 * 1000)).toFixed(1)} hours`;
}

// Cut a reason short on a character boundary, as MySQL rejects JSON with half a surrogate pair, such
// as half an emoji. A lone half already in the text is replaced.
function truncate(text) {
  const whole = String(text).toWellFormed();
  return whole.length > MAX_REASON_LENGTH
    ? `${whole.slice(0, MAX_REASON_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
    : whole;
}

// The importer's tables do not exist yet, as no run has applied its migrations.
export function isMissingTable(err) {
  return (err?.original ?? err?.parent)?.errno === NO_SUCH_TABLE;
}

// A copy of a record's counts as they are now, as its JSON line and ImporterState keep them. Counts
// that JSON cannot hold, which neither could keep, are only copied step by step.
function copyCounts(counts) {
  try {
    return JSON.parse(JSON.stringify(counts));
  } catch {
    return { ...counts };
  }
}

// A run's summary for recentRuns: its record without the lists in its counts, such as the import's
// per-list counts, so the summaries of many runs stay small.
function summarize({ event, counts, ...record }) {
  const totals = {};
  for (const [step, stepCounts] of Object.entries(counts))
    totals[step] = Object.fromEntries(
      Object.entries(stepCounts).filter(([, value]) => !Array.isArray(value))
    );
  return { ...record, counts: totals };
}

export default class RunRecord {
  constructor() {
    this.startedAt = Date.now();
    this.gitSha = process.env.GIT_SHA || 'unknown';
    // How long each phase took, in seconds, and the phase under way, which a run that does not
    // finish names, and when it started.
    this.phases = {};
    this.phase = null;
    this.phaseStartedAt = null;
    // The counts the steps reported, by step.
    this.counts = {};
    // The importer migrations the run applied.
    this.migrations = [];
    // In loop mode, the number of the importer service's cycle, from 1 when the service starts, and
    // the process's memory as the cycle ended.
    this.cycle = null;
    this.memory = null;
    // The record as it ended, once the run has ended.
    this.ended = null;
  }

  // Run one phase of the run, such as one of its steps, and time it.
  async time(name, work) {
    this.phase = name;
    const start = Date.now();
    this.phaseStartedAt = start;
    try {
      return await work();
    } finally {
      this.phases[name] = seconds(Date.now() - start);
    }
  }

  // Keep how long the phase under way has taken so far as its time, for a record that ends while
  // the phase is still under way, e.g. as the importer service ends a cycle at once. A phase that
  // has ended keeps its own time.
  timePhaseSoFar() {
    if (this.phase !== null && !Object.hasOwn(this.phases, this.phase))
      this.phases[this.phase] = seconds(Date.now() - this.phaseStartedAt);
  }

  // Keep the counts a step gives, also when it failed or stopped part-way. Counts that cannot be
  // had only cost the record the step's counts, never the run.
  count(name, getCounts) {
    try {
      const counts = getCounts();
      if (counts) this.counts[name] = counts;
    } catch (err) {
      console.warn(
        `Warning: could not count what ${name} did for the run record: ${describeError(err)}`
      );
    }
  }

  // End the record with how the run ended, and return it as its JSON line and ImporterState show
  // it. reason says why a run did not finish. A record is only ended once. It keeps its phases and
  // counts as they are now, so a step that is still running, e.g. once the importer service ended
  // its cycle at once, changes neither the run's JSON line nor the record saved after it.
  end(outcome, exitCode, reason) {
    if (this.ended) return this.ended;
    const endedAt = Date.now();
    this.ended = {
      event: RECORD_EVENT,
      outcome,
      exitCode,
      startedAt: isoTime(this.startedAt),
      endedAt: isoTime(endedAt),
      seconds: seconds(endedAt - this.startedAt),
      gitSha: this.gitSha
    };
    if (this.cycle !== null) this.ended.cycle = this.cycle;
    if (reason) this.ended.reason = truncate(reason);
    if (outcome !== 'finished' && outcome !== 'skipped' && this.phase)
      this.ended.phase = this.phase;
    if (this.migrations.length > 0) this.ended.migrations = this.migrations;
    this.ended.phases = { ...this.phases };
    this.ended.counts = copyCounts(this.counts);
    if (this.memory) this.ended.memory = this.memory;
    return this.ended;
  }
}

// Whether a run counts as a success: it exited 0, and its import imported at least one ban list, if
// it had any to import. A run while every list fails, e.g. during a BattleMetrics outage, does not,
// so it cannot hold off the stale alert, and nor does a dry run, which imports nothing. A run whose
// import gave no counts is judged by its exit code.
export function succeeded(record) {
  if (record?.exitCode !== 0 || record.counts?.importBans?.dryRun === true) return false;
  const banLists = record.counts?.importBans?.banLists;
  return (
    !Array.isArray(banLists) ||
    banLists.length === 0 ||
    banLists.some((banList) => !banList.error && !banList.gone)
  );
}

// Save the record of a run that held the run lock: as the latest run, at the end of recentRuns and,
// for a run that succeeded, as the start of the latest success, all in one transaction. A run that
// lost the lock saves its record too, and may save at the same time as the run that took the lock
// over, so recentRuns is read with a row lock, which keeps both runs' summaries.
export async function saveRecord(record) {
  await sequelize.transaction(async (transaction) => {
    const recent = await ImporterState.findByPk(STATE.RECENT_RUNS, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const runs = Array.isArray(recent?.value) ? recent.value : [];
    runs.push(summarize(record));

    await ImporterState.upsert({ name: STATE.LAST_RUN, value: record }, { transaction });
    await ImporterState.upsert(
      { name: STATE.RECENT_RUNS, value: runs.slice(-RECENT_RUNS_KEPT) },
      { transaction }
    );
    if (succeeded(record))
      await ImporterState.upsert(
        { name: STATE.LAST_SUCCESS_AT, value: record.startedAt },
        { transaction }
      );
  });
}

// The status message of the latest run that posted one, as { messageId, startedAt }, or null if
// there is none. A run reads it before it saves its own.
export async function readRunMessage() {
  const row = await ImporterState.findByPk(STATE.LAST_RUN_MESSAGE);
  const value = row?.value;
  return typeof value?.messageId === 'string' && /^\d+$/.test(value.messageId) ? value : null;
}

// Save which status message a run posted, and when the run started, so the next run can find the
// message if this one ends without its last edit.
export async function saveRunMessage({ messageId, startedAt }) {
  await ImporterState.upsert({
    name: STATE.LAST_RUN_MESSAGE,
    value: { messageId, startedAt: isoTime(startedAt) }
  });
}

// Whether a value is a Discord message's ID.
const isMessageID = (value) => typeof value === 'string' && /^\d+$/.test(value);

// The importer service's row, as { messageId, startedAt, endedAt, outcome, oldMessageIds }: its
// status message in the log channel, when the process that last kept it up to date started, once
// that process ended as it should, when and how, and, if there are any, the old copies of the
// status message, posted before it was posted again below newer messages, that are still to be
// deleted (see loop.js). Resolves with null when there is none, and leaves out IDs that are not
// messages' IDs.
export async function readService() {
  const row = await ImporterState.findByPk(SERVICE_STATE.SERVICE);
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { messageId, oldMessageIds, ...rest } = value;
  const service = isMessageID(messageId) ? { messageId, ...rest } : rest;
  const old = Array.isArray(oldMessageIds) ? oldMessageIds.filter(isMessageID) : [];
  if (old.length > 0) service.oldMessageIds = old;
  return service;
}

// Save the importer service's row (see readService), with times given in milliseconds.
export async function saveService({
  messageId = null,
  startedAt,
  endedAt,
  outcome,
  oldMessageIds = []
}) {
  const value = { messageId, startedAt: isoTime(startedAt) };
  if (endedAt !== undefined) Object.assign(value, { endedAt: isoTime(endedAt), outcome });
  if (oldMessageIds.length > 0) value.oldMessageIds = [...oldMessageIds];
  await ImporterState.upsert({ name: SERVICE_STATE.SERVICE, value });
}

// The record of the run that started at startedAt, as lastRunMessage gives it: the latest run's
// record, or else its summary in recentRuns, e.g. when a run that lost the run lock saved its
// record after the run that took the lock over. Resolves with null when that run saved no record,
// e.g. as it was killed.
export async function readSavedRun(startedAt) {
  if (typeof startedAt !== 'string') return null;
  const rows = await ImporterState.findAll({
    where: { name: [STATE.LAST_RUN, STATE.RECENT_RUNS] }
  });
  const state = Object.fromEntries(rows.map(({ name, value }) => [name, value]));
  const recent = Array.isArray(state[STATE.RECENT_RUNS]) ? state[STATE.RECENT_RUNS] : [];
  return (
    [state[STATE.LAST_RUN], ...recent.toReversed()].find(
      (saved) => saved?.startedAt === startedAt
    ) ?? null
  );
}

// Save when the run that posts a stale alert started, unless a run that started less than a
// cadence before it, or after it, posted one. The alert's row is read with a row lock, so two runs
// that check at once cannot both post it. Resolves with whether this run is to post it.
async function claimStaleAlert(startedAt, cadence, leeway) {
  return sequelize.transaction(async (transaction) => {
    const last = await ImporterState.findByPk(STATE.LAST_STALE_ALERT_AT, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (last && startedAt - Date.parse(last.value) < cadence - leeway) return false;
    await ImporterState.upsert(
      { name: STATE.LAST_STALE_ALERT_AT, value: isoTime(startedAt) },
      { transaction }
    );
    return true;
  });
}

// Post one alert to the log channel when no run has succeeded for 3 cadences, at most once a
// cadence. It compares when runs started, as the script that starts them spaces them a cadence
// apart: the last success, the run that checks (startedAt) and the run that last posted the alert.
// Comparing when they ended would make the alert a run late whenever a failed run ends sooner after
// its start than the last success did. Before the first success, the time is counted from when the
// importer's tables were made, early in the first run. A start that is skipped, as another run
// holds a lock, checks too, as a stuck run would otherwise make every later start skip quietly,
// and skipped names the lock it found held, 'service' or 'run', which the alert names too.
// Whichever posts saves when it started, with a row lock that needs no run lock, so no other run
// or skipped start posts it again within the cadence. Resolves with whether it posted. The
// importer service (service) checks at the end of each cycle that did not succeed, and while it
// stands by for a lock that another run holds (skipped): the service lock as the service starts,
// or the run lock as a cycle starts. Its cycles start a cadence apart.
export async function alertIfStale({
  cadenceSeconds,
  skipped = false,
  startedAt = Date.now(),
  service = false
}) {
  const now = Date.now();
  const cadence = cadenceSeconds * 1000;
  const leeway = Math.min(STALE_LEEWAY, cadence / 10);
  try {
    const rows = await ImporterState.findAll({
      where: { name: [STATE.LAST_SUCCESS_AT, STATE.LAST_RUN, STATE.LAST_STALE_ALERT_AT] }
    });
    const state = Object.fromEntries(rows.map(({ name, value }) => [name, value]));

    let since = Date.parse(state[STATE.LAST_SUCCESS_AT]);
    const hadSuccess = !Number.isNaN(since);
    if (!hadSuccess) {
      const made = await ImporterSchemaMigration.min('appliedAt');
      since = made ? new Date(made).getTime() : NaN;
    }
    if (Number.isNaN(since) || startedAt - since < STALE_CADENCES * cadence - leeway) return false;

    // A quick check without a lock first, then the claim, which saves the alert's time with one.
    if (startedAt - Date.parse(state[STATE.LAST_STALE_ALERT_AT]) < cadence - leeway) return false;
    if (!(await claimStaleAlert(startedAt, cadence, leeway))) return false;

    const lastRun = state[STATE.LAST_RUN];
    const schedule = service
      ? `The importer service starts a cycle every ${duration(cadence)} (IMPORTER_CADENCE_SECONDS, or else IMPORTER_CYCLE_SECONDS)`
      : `Runs start every IMPORTER_CADENCE_SECONDS (${duration(cadence)})`;
    const parts = [
      `The CBL update is stale: no run has succeeded for ${duration(now - since)}, since ${
        hadSuccess ? 'the one that started at' : 'its run record began at'
      } ${isoTime(since)}. ${schedule}, so ${STALE_CADENCES} or more in a row have not succeeded.`
    ];
    if (lastRun?.endedAt) {
      let how = '';
      if (lastRun.reason) how = ` (${lastRun.reason})`;
      else if (lastRun.exitCode === 0 && lastRun.counts?.importBans?.dryRun === true)
        how = ', but was a dry run, which imports nothing';
      else if (lastRun.exitCode === 0 && !succeeded(lastRun))
        how = `, but imported none of its ${lastRun.counts.importBans.lists} ban lists`;
      parts.push(
        `The last run ended at ${lastRun.endedAt} with exit code ${lastRun.exitCode}${how}.`
      );
    }
    if (skipped)
      parts.push(
        service
          ? `The importer service is standing by, as another run holds the ${skipped === 'service' ? 'service' : 'run'} lock.`
          : `This start was skipped, as ${LOCK_HOLDERS[skipped] ?? LOCK_HOLDERS.run}.`
      );
    Logger.important('Core', parts.join(' '));
    return true;
  } catch (err) {
    // There is nothing to check before the importer's tables have been made.
    if (isMissingTable(err)) return false;
    throw err;
  }
}
