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
  // When the latest successful run, one that exited 0, ended.
  LAST_SUCCESS_AT: 'lastSuccessAt',
  // A summary of each of the latest runs, oldest first.
  RECENT_RUNS: 'recentRuns',
  // When a run that held the run lock last posted that the importer is stale.
  LAST_STALE_ALERT_AT: 'lastStaleAlertAt'
};

// How many runs recentRuns keeps.
const RECENT_RUNS_KEPT = 100;

// The importer is stale once no run has succeeded for this many times its cadence, i.e. after 3
// runs in a row have failed or not happened.
const STALE_CADENCES = 3;

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

function truncate(text) {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

// The importer's tables do not exist yet, as no run has applied its migrations.
function isMissingTable(err) {
  return (err?.original ?? err?.parent)?.errno === NO_SUCH_TABLE;
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
    // finish names.
    this.phases = {};
    this.phase = null;
    // The counts the steps reported, by step.
    this.counts = {};
    // The importer migrations the run applied.
    this.migrations = [];
    // The record as it ended, once the run has ended.
    this.ended = null;
  }

  // Run one phase of the run, such as one of its steps, and time it.
  async time(name, work) {
    this.phase = name;
    const start = Date.now();
    try {
      return await work();
    } finally {
      this.phases[name] = seconds(Date.now() - start);
    }
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
  // it. reason says why a run did not finish. A record is only ended once.
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
    if (reason) this.ended.reason = truncate(reason);
    if (outcome !== 'finished' && outcome !== 'skipped' && this.phase)
      this.ended.phase = this.phase;
    if (this.migrations.length > 0) this.ended.migrations = this.migrations;
    this.ended.phases = this.phases;
    this.ended.counts = this.counts;
    return this.ended;
  }
}

// Save the record of a run that held the run lock: as the latest run, at the end of recentRuns and,
// for a run that exited 0, as the time of the latest success, all in one transaction. A run that
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
    if (record.exitCode === 0)
      await ImporterState.upsert(
        { name: STATE.LAST_SUCCESS_AT, value: record.endedAt },
        { transaction }
      );
  });
}

// Save the time of a stale alert, unless another run posted one within the cadence. The alert's
// row is read with a row lock, so two runs that check at once cannot both post it. Resolves with
// whether this run is to post it.
async function claimStaleAlert(now, cadence) {
  return sequelize.transaction(async (transaction) => {
    const last = await ImporterState.findByPk(STATE.LAST_STALE_ALERT_AT, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (last && now - Date.parse(last.value) < cadence) return false;
    await ImporterState.upsert(
      { name: STATE.LAST_STALE_ALERT_AT, value: isoTime(now) },
      { transaction }
    );
    return true;
  });
}

// Post one alert to the log channel when no run has succeeded for 3 cadences, at most once a
// cadence. Before the first success, the time is counted from when the importer's tables were made.
// A run that held the run lock saves the time of its alert. A start that is skipped, as another run
// holds the lock, checks too, as a stuck run would otherwise make every later start skip quietly,
// but it only reads the record, which needs no lock, and saves nothing: it posts unless a run
// posted within the cadence, and as runs start once a cadence, so do skipped starts. Resolves with
// whether it posted.
export async function alertIfStale({ cadenceSeconds, skipped = false }) {
  const now = Date.now();
  const cadence = cadenceSeconds * 1000;
  try {
    const rows = await ImporterState.findAll({
      where: { name: [STATE.LAST_SUCCESS_AT, STATE.LAST_RUN, STATE.LAST_STALE_ALERT_AT] }
    });
    const state = Object.fromEntries(rows.map(({ name, value }) => [name, value]));

    let since = Date.parse(state[STATE.LAST_SUCCESS_AT]);
    const succeeded = !Number.isNaN(since);
    if (!succeeded) {
      const made = await ImporterSchemaMigration.min('appliedAt');
      since = made ? new Date(made).getTime() : NaN;
    }
    if (Number.isNaN(since) || now - since < STALE_CADENCES * cadence) return false;

    if (now - Date.parse(state[STATE.LAST_STALE_ALERT_AT]) < cadence) return false;
    if (!skipped && !(await claimStaleAlert(now, cadence))) return false;

    const lastRun = state[STATE.LAST_RUN];
    const parts = [
      `The CBL update is stale: no run has succeeded for ${duration(now - since)}, ${
        succeeded ? 'since' : 'since its run record began at'
      } ${isoTime(since)}, which is over ${STALE_CADENCES} times IMPORTER_CADENCE_SECONDS (${duration(cadence)}).`
    ];
    if (lastRun?.endedAt)
      parts.push(
        `The last run ended at ${lastRun.endedAt} with exit code ${lastRun.exitCode}${
          lastRun.reason ? ` (${lastRun.reason})` : ''
        }.`
      );
    if (skipped) parts.push('This start was skipped, as another run holds the run lock.');
    Logger.important('Core', parts.join(' '));
    return true;
  } catch (err) {
    // There is nothing to check before the importer's tables have been made.
    if (isMissingTable(err)) return false;
    throw err;
  }
}
