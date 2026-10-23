import assert from 'assert';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the run record, without a database: what a run's record holds, how it is saved in
// ImporterState, and when the importer posts that it is stale.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const CADENCE = 6 * HOUR;
// The staleness check's leeway for runs that start a little early or late.
const LEEWAY = 5 * MINUTE;
const START = Date.parse('2026-10-15T12:00:00.000Z');

// A stand-in for the ImporterState and ImporterSchemaMigrations tables. A transaction's writes are
// only seen once it commits, and a row read with a row lock stays locked until its transaction
// ends, as in MySQL. Values go through JSON, as they do in the database.
function fakeDatabase({ rows = {}, tablesMadeAt = null, error = null } = {}) {
  const state = new Map(Object.entries(rows));
  const locks = new Map();
  const writes = [];
  let transactions = 0;

  const fail = () => {
    if (error) throw error;
  };
  const read = (name) => (state.has(name) ? JSON.parse(state.get(name)) : undefined);

  // Wait until no other transaction holds the row's lock, then take it.
  async function lockRow(name, transaction) {
    while (locks.has(name) && locks.get(name) !== transaction) await locks.get(name).ended;
    locks.set(name, transaction);
  }

  const ImporterState = {
    async findAll({ where: { name } }) {
      fail();
      return [...name]
        .filter((key) => state.has(key))
        .map((key) => ({ name: key, value: read(key) }));
    },
    async findByPk(name, { transaction, lock } = {}) {
      fail();
      if (lock) {
        assert.strictEqual(lock, 'UPDATE');
        await lockRow(name, transaction);
      }
      return state.has(name) ? { name, value: read(name) } : null;
    },
    // The record's rows are written in a transaction. The run's status message, and the importer
    // service's row, are the rows written on their own.
    async upsert({ name, value }, { transaction } = {}) {
      fail();
      if ((name === 'lastRunMessage' || name === 'importerService') && !transaction) {
        state.set(name, JSON.stringify(value));
        writes.push(name);
        return;
      }
      assert.ok(transaction, `${name} is written in a transaction`);
      transaction.writes.push([name, JSON.stringify(value)]);
    }
  };

  const ImporterSchemaMigration = {
    async min(field) {
      fail();
      assert.strictEqual(field, 'appliedAt');
      return tablesMadeAt;
    }
  };

  const sequelize = {
    async transaction(work) {
      fail();
      transactions++;
      let end;
      const transaction = {
        LOCK: { UPDATE: 'UPDATE' },
        writes: [],
        ended: new Promise((resolve) => (end = resolve))
      };
      try {
        const result = await work(transaction);
        for (const [name, value] of transaction.writes) {
          state.set(name, value);
          writes.push(name);
        }
        return result;
      } finally {
        for (const [name, holder] of locks) if (holder === transaction) locks.delete(name);
        end();
      }
    }
  };

  return {
    state,
    read,
    writes,
    transactions: () => transactions,
    modules: {
      'scbl-lib/db': { sequelize },
      'scbl-lib/db/importer-models': { ImporterSchemaMigration, ImporterState }
    }
  };
}

// Load run-record.js with a stand-in database, a logger and a console that record what they are
// given, and a clock that only moves when the test moves it.
async function loadRunRecord(database = fakeDatabase(), { env = {} } = {}) {
  const output = [];
  const discord = [];
  const clock = { now: START };
  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }

  const dependencies = {
    ...database.modules,
    'scbl-lib/utils': {
      describeError,
      Logger: {
        important: (module, message) => discord.push(message)
      }
    }
  };
  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args))
    },
    process: { env },
    Date: FakeDate
  });
  const url = new URL('../src/run-record.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();

  return { ...module.namespace, database, output, discord, clock };
}

// Copy a value made in run-record.js's context into one of this test's own, to compare it.
const plain = (value) => JSON.parse(JSON.stringify(value));

// A record holds when the run started and ended, the commit it ran, its outcome and exit code, why
// it did not finish, the phase it ended in, the migrations it applied, how long each phase took and
// the counts its steps reported.
{
  const {
    default: RunRecord,
    RECORD_EVENT,
    clock
  } = await loadRunRecord(undefined, {
    env: { GIT_SHA: 'abc1234' }
  });
  assert.strictEqual(RECORD_EVENT, 'cbl-importer-run');
  const record = new RunRecord();
  await record.time('connect', async () => {
    clock.now += 1234;
  });
  record.migrations = ['001-importer-state'];
  await assert.rejects(
    record.time('importBans', async () => {
      clock.now += 60000;
      throw new Error('Deadlock found');
    }),
    /Deadlock found/
  );
  record.count('importBans', () => ({ lists: 20, banLists: [{ id: 1 }] }));
  clock.now += 5;
  const ended = record.end('failed', 1, 'Error: Deadlock found');
  assert.deepStrictEqual(plain(ended), {
    event: 'cbl-importer-run',
    outcome: 'failed',
    exitCode: 1,
    startedAt: '2026-10-15T12:00:00.000Z',
    endedAt: '2026-10-15T12:01:01.239Z',
    seconds: 61.24,
    gitSha: 'abc1234',
    reason: 'Error: Deadlock found',
    phase: 'importBans',
    migrations: ['001-importer-state'],
    phases: { connect: 1.23, importBans: 60 },
    counts: { importBans: { lists: 20, banLists: [{ id: 1 }] } }
  });
  // It is only ended once.
  clock.now += 1000;
  assert.strictEqual(record.end('finished', 0), ended);
}
{
  // A run that finished, or was skipped, names no phase, and one without a commit says so. Long
  // reasons are cut short. A step whose counts cannot be had only loses its counts.
  const { default: RunRecord, output } = await loadRunRecord();
  const finished = new RunRecord();
  await finished.time('importBans', async () => {});
  finished.count('importBans', () => {
    throw new TypeError('Cannot read properties of undefined');
  });
  const record = plain(finished.end('finished', 0));
  assert.strictEqual(record.gitSha, 'unknown');
  assert.ok(!('phase' in record) && !('reason' in record) && !('migrations' in record));
  assert.deepStrictEqual(record.counts, {});
  assert.deepStrictEqual(output, [
    'Warning: could not count what importBans did for the run record: TypeError: Cannot read properties of undefined'
  ]);

  const skipped = new RunRecord();
  await skipped.time('takeRunLock', async () => {});
  assert.ok(!('phase' in skipped.end('skipped', 75, 'x'.repeat(2000))));
  assert.strictEqual(skipped.ended.reason.length, 500);
  assert.ok(skipped.ended.reason.endsWith('x…'));
}
{
  // A record that ends while a phase is still under way, as when the importer service ends a cycle
  // at once, can keep that phase's time so far, but not once the phase has ended, and keeps its
  // phases and counts as they were when it ended: the step that carries on changes neither, so the
  // JSON line and the record saved after it are the same.
  const { default: RunRecord, clock } = await loadRunRecord();
  const record = new RunRecord();
  await record.time('importBans', async () => {
    clock.now += 2000;
  });
  clock.now += 500;
  record.timePhaseSoFar();
  assert.deepStrictEqual(plain(record.phases), { importBans: 2 });
  clock.now -= 500;
  const counts = { queued: 10, created: 7 };
  let finish;
  const step = record.time('exportExportBans', () => new Promise((resolve) => (finish = resolve)));
  clock.now += 45000;
  record.timePhaseSoFar();
  record.count('exportExportBans', () => counts);
  const ended = record.end('interrupted', 3, 'Ended there');
  const line = JSON.stringify(ended);
  // The step carries on, counts one more, ends and records its counts and time.
  counts.created++;
  clock.now += 1000;
  finish();
  await step;
  record.count('exportExportBans', () => counts);
  record.count('later', () => ({ more: 1 }));
  assert.deepStrictEqual(plain(record.phases), { importBans: 2, exportExportBans: 46 });
  assert.strictEqual(JSON.stringify(ended), line);
  assert.deepStrictEqual(plain(ended.phases), { importBans: 2, exportExportBans: 45 });
  assert.deepStrictEqual(plain(ended.counts), { exportExportBans: { queued: 10, created: 7 } });
  assert.strictEqual(record.end('finished', 0), ended);
}
{
  // A reason is cut on a character boundary, never in the middle of an emoji, as MySQL rejects JSON
  // with half a surrogate pair, which would lose the whole record. A lone half already in a reason
  // is replaced.
  const { default: RunRecord } = await loadRunRecord();
  const { reason } = new RunRecord().end('failed', 1, `${'x'.repeat(498)}\u{1F600}tail`);
  assert.ok(reason.isWellFormed());
  assert.ok(!JSON.stringify(reason).includes('\\ud83d'));
  assert.strictEqual(reason, `${'x'.repeat(498)}…`);

  const whole = new RunRecord().end('failed', 1, `${'x'.repeat(497)}\u{1F600}tail`).reason;
  assert.strictEqual(whole, `${'x'.repeat(497)}\u{1F600}…`);
  assert.strictEqual(whole.length, 500);

  const lone = new RunRecord().end('failed', 1, 'Error: no \uD83D such player').reason;
  assert.strictEqual(lone, 'Error: no � such player');
}

// Saving a record keeps it as the latest run and adds its summary to recentRuns, all in one
// transaction. The summary leaves out the lists in the counts, such as each ban list's counts.
{
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord, STATE, clock } = await loadRunRecord(database);
  const run = new RunRecord();
  run.count('importBans', () => ({ lists: 2, fetched: 30, banLists: [{ id: 1 }, { id: 2 }] }));
  const record = run.end('failed', 1, 'Error: Deadlock found');
  await saveRecord(record);
  assert.strictEqual(database.transactions(), 1);
  assert.deepStrictEqual(database.read(STATE.LAST_RUN), plain(record));
  const { event, ...summary } = plain(record);
  assert.strictEqual(event, 'cbl-importer-run');
  assert.deepStrictEqual(database.read(STATE.RECENT_RUNS), [
    { ...summary, counts: { importBans: { lists: 2, fetched: 30 } } }
  ]);
  // A run that did not succeed leaves lastSuccessAt alone.
  assert.ok(!database.state.has(STATE.LAST_SUCCESS_AT));

  // A successful run also saves when it started, which the staleness check compares with when later
  // runs started, and recentRuns keeps the latest 100 runs.
  const old = Array.from({ length: 100 }, (_, i) => ({ startedAt: `old ${i}` }));
  database.state.set(STATE.RECENT_RUNS, JSON.stringify(old));
  const success = new RunRecord();
  clock.now += 30 * MINUTE;
  success.end('finished', 0);
  await saveRecord(success.ended);
  const recent = database.read(STATE.RECENT_RUNS);
  assert.strictEqual(recent.length, 100);
  assert.deepStrictEqual(recent[0], { startedAt: 'old 1' });
  assert.strictEqual(recent.at(-1).startedAt, success.ended.startedAt);
  assert.strictEqual(database.read(STATE.LAST_SUCCESS_AT), '2026-10-15T12:00:00.000Z');
  assert.strictEqual(success.ended.endedAt, '2026-10-15T12:30:00.000Z');
  assert.strictEqual(database.read(STATE.LAST_RUN).outcome, 'finished');
}
{
  // A save that fails saves nothing.
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord } = await loadRunRecord(database);
  const record = new RunRecord().end('finished', 0);
  database.modules['scbl-lib/db/importer-models'].ImporterState.upsert = async (row, options) => {
    if (row.name === 'recentRuns') throw new Error('Lock wait timeout exceeded');
    options.transaction.writes.push([row.name, JSON.stringify(row.value)]);
  };
  await assert.rejects(saveRecord(record), /Lock wait timeout exceeded/);
  assert.strictEqual(database.state.size, 0);
}

// Two runs that save at once, such as a run that lost its locks and the run that took them over,
// both keep their summaries in recentRuns, as recentRuns is read with a row lock.
{
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord, STATE } = await loadRunRecord(database);
  const lost = new RunRecord().end('failed', 1, 'Stopped, as it lost its locks');
  const took = new RunRecord().end('finished', 0);
  await Promise.all([saveRecord(lost), saveRecord(took)]);
  assert.deepStrictEqual(
    database.read(STATE.RECENT_RUNS).map((run) => run.outcome),
    ['failed', 'finished']
  );
}

// A run only counts as a success when it exited 0 and its import imported at least one ban list,
// if it had any, so runs during a BattleMetrics outage, when every list fails, never hold off the
// stale alert. A list that was removed during the run was not imported either, and a dry run
// imports nothing. A run whose import gave no counts, or had no lists, is judged by its exit code.
{
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord, succeeded, STATE, clock } = await loadRunRecord(database);
  const imported = (banLists) => ({
    lists: banLists.length,
    failedLists: banLists.filter((banList) => banList.error).length,
    banLists
  });
  const failure = { id: 1, fetched: 0, error: 'Error: Request failed with status code 503' };
  const record = (counts, exitCode = 0) => {
    const run = new RunRecord();
    if (counts) run.count('importBans', () => counts);
    return run.end(exitCode === 0 ? 'finished' : 'failed', exitCode);
  };

  const outage = record(imported([failure, { ...failure, id: 2 }, { id: 3, gone: true }]));
  assert.strictEqual(succeeded(outage), false);
  await saveRecord(outage);
  assert.ok(!database.state.has(STATE.LAST_SUCCESS_AT));
  assert.strictEqual(database.read(STATE.LAST_RUN).exitCode, 0);

  for (const counts of [imported([failure, { id: 2, fetched: 120 }]), imported([]), null]) {
    database.state.delete(STATE.LAST_SUCCESS_AT);
    clock.now += MINUTE;
    const success = record(counts);
    assert.strictEqual(succeeded(success), true, JSON.stringify(counts));
    await saveRecord(success);
    assert.strictEqual(database.read(STATE.LAST_SUCCESS_AT), success.startedAt);
  }
  assert.strictEqual(succeeded(record(imported([{ id: 2, fetched: 120 }]), 1)), false);
  assert.strictEqual(succeeded(record(null, 3)), false);

  database.state.delete(STATE.LAST_SUCCESS_AT);
  const dryRun = record({ ...imported([{ id: 2, fetched: 120 }]), dryRun: true });
  assert.strictEqual(succeeded(dryRun), false);
  await saveRecord(dryRun);
  assert.ok(!database.state.has(STATE.LAST_SUCCESS_AT));
}

// The staleness check: no run has succeeded for 3 cadences. It compares when runs started.
const cadenceSeconds = CADENCE / 1000;
const stalenessRows = (lastSuccessAt, extra = {}) => ({
  lastSuccessAt: JSON.stringify(new Date(lastSuccessAt).toISOString()),
  lastRun: JSON.stringify({
    endedAt: '2026-10-15T11:00:00.000Z',
    exitCode: 1,
    reason: 'Error: Deadlock found'
  }),
  ...extra
});

// Until 3 cadences after the last success started, less 5 minutes for runs that start a little
// early or late, nothing is posted, and nothing is written.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * CADENCE + LEEWAY + 1) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds, startedAt: START }), false);
  assert.deepStrictEqual(discord, []);
  assert.strictEqual(database.transactions(), 0);
}

// From then on, one alert is posted, which says how long it has been, since when, the cadence and
// how the last run ended, and when the run that posted it started is saved.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * CADENCE - 30 * MINUTE) });
  const { alertIfStale, discord, clock, STATE } = await loadRunRecord(database);
  clock.now += 20 * MINUTE;
  assert.strictEqual(await alertIfStale({ cadenceSeconds, startedAt: START }), true);
  assert.deepStrictEqual(discord, [
    'The CBL update is stale: no run has succeeded for 18.8 hours, since the one that started at 2026-10-14T17:30:00.000Z. Runs start every IMPORTER_CADENCE_SECONDS (6.0 hours), so 3 or more in a row have not succeeded. The last run ended at 2026-10-15T11:00:00.000Z with exit code 1 (Error: Deadlock found).'
  ]);
  assert.strictEqual(database.read(STATE.LAST_STALE_ALERT_AT), '2026-10-15T12:00:00.000Z');

  // At most once a cadence: a run or a skipped start that started less than a cadence, less the 5
  // minutes, after the run that posted, posts nothing, however late it checks.
  clock.now = START + 6 * HOUR;
  const nearlyCadence = START + CADENCE - LEEWAY - 1;
  assert.strictEqual(await alertIfStale({ cadenceSeconds, startedAt: nearlyCadence }), false);
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds, skipped: 'run', startedAt: nearlyCadence }),
    false
  );
  assert.strictEqual(discord.length, 1);

  // A start that is skipped, as another run holds the run lock, a cadence later posts, and says so.
  // It saves when it started too, with a row lock, which needs no run lock.
  const transactions = database.transactions();
  const skippedAt = START + CADENCE;
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds, skipped: 'run', startedAt: skippedAt }),
    true
  );
  assert.strictEqual(discord.length, 2);
  assert.match(
    discord[1],
    /^The CBL update is stale: no run has succeeded for 24\.5 hours, .* This start was skipped, as another run holds the run lock\.$/
  );
  assert.strictEqual(database.transactions(), transactions + 1);
  assert.strictEqual(database.read(STATE.LAST_STALE_ALERT_AT), '2026-10-15T18:00:00.000Z');

  // So neither a run that checks next within the cadence, such as one that started at the same
  // time, nor a second skipped start, such as one started by hand, posts it again.
  clock.now = skippedAt + 2 * HOUR;
  assert.strictEqual(await alertIfStale({ cadenceSeconds, startedAt: skippedAt }), false);
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds, skipped: 'run', startedAt: skippedAt + 2 * HOUR }),
    false
  );
  // Nor does a run that started before it, e.g. a stuck run that ends later.
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds, startedAt: skippedAt - CADENCE / 2 }),
    false
  );
  assert.strictEqual(discord.length, 2);
  assert.strictEqual(database.transactions(), transactions + 1);

  // A start that is skipped as the importer service, or another run, holds the service lock, as
  // the service does between its cycles, when the run lock is free, says so.
  clock.now = START + 2 * CADENCE;
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds, skipped: 'service', startedAt: START + 2 * CADENCE }),
    true
  );
  assert.match(
    discord[2],
    / This start was skipped, as the importer service or another run holds the service lock\.$/
  );
}

// An alert after a dry run, which finished but imported nothing, says it was one.
{
  const database = fakeDatabase({
    rows: stalenessRows(START - 3 * CADENCE - 30 * MINUTE, {
      lastRun: JSON.stringify({
        endedAt: '2026-10-15T11:00:00.000Z',
        exitCode: 0,
        counts: { importBans: { lists: 20, dryRun: true, banLists: [{ id: 1, fetched: 9 }] } }
      })
    })
  });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds, startedAt: START }), true);
  assert.match(
    discord[0],
    / The last run ended at 2026-10-15T11:00:00\.000Z with exit code 0, but was a dry run, which imports nothing\.$/
  );
}

// Walk the schedule, with a run starting every 6 hours, as the script that starts them does. Each
// run saves its record when it ends, and one that did not succeed then checks whether the importer
// is stale, as run.js does. A start that is skipped checks when it starts.
async function schedule() {
  const database = fakeDatabase();
  const loaded = await loadRunRecord(database);
  const { default: RunRecord, saveRecord, alertIfStale, succeeded, clock } = loaded;
  return {
    ...loaded,
    // A run that starts at the time given, takes as long as given and exits with exitCode.
    // Resolves with whether it posted that the importer is stale.
    async run(time, lasting, exitCode) {
      clock.now = Date.parse(time);
      const run = new RunRecord();
      clock.now += lasting;
      const record = run.end(
        exitCode === 0 ? 'finished' : 'failed',
        exitCode,
        exitCode === 0 ? undefined : 'Error: Deadlock found'
      );
      await saveRecord(record);
      return !succeeded(record) && alertIfStale({ cadenceSeconds, startedAt: run.startedAt });
    },
    // A start at the time given that is skipped, as another run holds the run lock.
    async skip(time) {
      clock.now = Date.parse(time);
      const run = new RunRecord();
      clock.now += 1000;
      return alertIfStale({ cadenceSeconds, skipped: 'run', startedAt: run.startedAt });
    }
  };
}

// After a success that took 30 minutes, the 3rd run in a row that fails posts the alert, although
// each failed run ends sooner after its start than the success did. Then the run each cadence after
// it posts it again, however quickly it fails, until a run succeeds.
{
  const walk = await schedule();
  assert.strictEqual(await walk.run('2026-10-15T00:00:00.000Z', 30 * MINUTE, 0), false);
  assert.strictEqual(await walk.run('2026-10-15T06:00:00.000Z', 20 * MINUTE, 1), false);
  assert.strictEqual(await walk.run('2026-10-15T12:00:00.000Z', 20 * MINUTE, 1), false);
  assert.strictEqual(await walk.run('2026-10-15T18:00:00.000Z', 20 * MINUTE, 1), true);
  assert.deepStrictEqual(walk.discord, [
    'The CBL update is stale: no run has succeeded for 18.3 hours, since the one that started at 2026-10-15T00:00:00.000Z. Runs start every IMPORTER_CADENCE_SECONDS (6.0 hours), so 3 or more in a row have not succeeded. The last run ended at 2026-10-15T18:20:00.000Z with exit code 1 (Error: Deadlock found).'
  ]);
  assert.strictEqual(await walk.run('2026-10-16T00:00:00.000Z', MINUTE, 1), true);
  assert.strictEqual(await walk.run('2026-10-16T06:00:00.000Z', 2 * HOUR, 1), true);
  assert.strictEqual(
    walk.database.read(walk.STATE.LAST_STALE_ALERT_AT),
    '2026-10-16T06:00:00.000Z'
  );
  // A run started by hand in between posts nothing.
  assert.strictEqual(await walk.run('2026-10-16T09:00:00.000Z', MINUTE, 1), false);
  assert.strictEqual(await walk.run('2026-10-16T12:00:00.000Z', 30 * MINUTE, 0), false);
  assert.strictEqual(await walk.run('2026-10-16T18:00:00.000Z', MINUTE, 1), false);
  assert.strictEqual(walk.discord.length, 3);
}

// Runs that start a few minutes early or late are still counted on the schedule: a success that
// started 4 minutes late, then runs that start on time, and a repeat that starts 4 minutes early.
{
  const walk = await schedule();
  await walk.run('2026-10-15T00:04:00.000Z', 30 * MINUTE, 0);
  assert.strictEqual(await walk.run('2026-10-15T06:00:00.000Z', MINUTE, 1), false);
  assert.strictEqual(await walk.run('2026-10-15T12:00:00.000Z', MINUTE, 1), false);
  assert.strictEqual(await walk.run('2026-10-15T18:00:00.000Z', MINUTE, 1), true);
  assert.strictEqual(await walk.run('2026-10-15T23:56:00.000Z', MINUTE, 1), true);
  assert.strictEqual(walk.discord.length, 2);
}

// A run that is stuck holding the run lock makes the starts after it skip. The 3rd start after the
// last success posts, and saves when it started, so a second skipped start in the same cadence
// posts nothing, and the next cadence's does.
{
  const walk = await schedule();
  await walk.run('2026-10-15T00:00:00.000Z', 30 * MINUTE, 0);
  assert.strictEqual(await walk.skip('2026-10-15T06:00:00.000Z'), false);
  assert.strictEqual(await walk.skip('2026-10-15T12:00:00.000Z'), false);
  const transactions = walk.database.transactions();
  assert.strictEqual(await walk.skip('2026-10-15T18:00:00.000Z'), true);
  assert.strictEqual(walk.database.transactions(), transactions + 1);
  assert.strictEqual(
    walk.database.read(walk.STATE.LAST_STALE_ALERT_AT),
    '2026-10-15T18:00:00.000Z'
  );
  assert.match(walk.discord[0], /^The CBL update is stale: no run has succeeded for 18\.0 hours, /);
  assert.strictEqual(await walk.skip('2026-10-15T20:00:00.000Z'), false);
  assert.strictEqual(await walk.skip('2026-10-16T00:00:00.000Z'), true);
  assert.strictEqual(walk.discord.length, 2);
}

// The cadence is a setting, e.g. an hour for hourly runs, which makes the importer stale after 3
// hours, with the same 5 minutes' leeway, or a tenth of the cadence if that is less. Durations
// under 2 hours are given in minutes.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * HOUR + LEEWAY) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: 3600 }), true);
  assert.match(
    discord[0],
    /for 2\.9 hours, .* Runs start every IMPORTER_CADENCE_SECONDS \(60 minutes\), so 3 or more/
  );
}
for (const [minutes, stale] of [
  [28, false],
  [29, true]
]) {
  const database = fakeDatabase({ rows: stalenessRows(START - minutes * MINUTE) });
  const { alertIfStale } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: 600 }), stale);
}

// Before any run has succeeded, the time is counted from when the importer's tables were made,
// early in the first run.
{
  const tablesMadeAt = new Date(START - 3 * CADENCE + 2 * MINUTE);
  const database = fakeDatabase({ tablesMadeAt });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds }), true);
  assert.deepStrictEqual(discord, [
    'The CBL update is stale: no run has succeeded for 18.0 hours, since its run record began at 2026-10-14T18:02:00.000Z. Runs start every IMPORTER_CADENCE_SECONDS (6.0 hours), so 3 or more in a row have not succeeded.'
  ]);
}
{
  // Tables made more recently are not stale yet.
  const database = fakeDatabase({ tablesMadeAt: new Date(START - HOUR) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds }), false);
  assert.deepStrictEqual(discord, []);
}

// A run that exited 0 but imported no ban list did not succeed, and the alert says so.
{
  const lastRun = {
    endedAt: '2026-10-15T11:30:00.000Z',
    exitCode: 0,
    counts: {
      importBans: {
        lists: 20,
        failedLists: 20,
        banLists: [{ id: 1, error: 'Error: Request failed with status code 401' }]
      }
    }
  };
  const database = fakeDatabase({
    rows: stalenessRows(START - 3 * CADENCE, { lastRun: JSON.stringify(lastRun) })
  });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds }), true);
  assert.match(
    discord[0],
    / The last run ended at 2026-10-15T11:30:00\.000Z with exit code 0, but imported none of its 20 ban lists\.$/
  );
}

// Before the importer's tables exist, there is nothing to check. Other errors are left to the run,
// which reports them.
{
  const missing = Object.assign(new Error("Table 'cbl.ImporterState' doesn't exist"), {
    original: { errno: 1146 }
  });
  const { alertIfStale } = await loadRunRecord(fakeDatabase({ error: missing }));
  assert.strictEqual(await alertIfStale({ cadenceSeconds, skipped: 'run' }), false);

  const { alertIfStale: failing } = await loadRunRecord(
    fakeDatabase({ error: new Error('Connection lost') })
  );
  await assert.rejects(failing({ cadenceSeconds }), /Connection lost/);
}

// Two that check at the same moment, such as a run that lost its locks and the run that took them
// over, or a run and a skipped start, post one alert between them, as the alert's row is read with
// a row lock. The one that loses posts nothing.
for (const skipped of [false, 'run']) {
  const database = fakeDatabase({
    rows: stalenessRows(START - 4 * CADENCE, {
      lastStaleAlertAt: JSON.stringify(new Date(START - CADENCE).toISOString())
    })
  });
  const { alertIfStale, discord } = await loadRunRecord(database);
  const results = await Promise.all([
    alertIfStale({ cadenceSeconds }),
    alertIfStale({ cadenceSeconds, skipped })
  ]);
  assert.deepStrictEqual(results.toSorted(), [false, true]);
  assert.strictEqual(discord.length, 1);
}

// A run saves which status message it posted, and when it started, as lastRunMessage, on its own,
// and the next run reads it back. A row that does not name a Discord message is ignored.
{
  const database = fakeDatabase();
  const { readRunMessage, saveRunMessage, STATE } = await loadRunRecord(database);
  assert.strictEqual(STATE.LAST_RUN_MESSAGE, 'lastRunMessage');
  assert.strictEqual(await readRunMessage(), null);
  await saveRunMessage({ messageId: '1430000000000000010', startedAt: START });
  assert.deepStrictEqual(database.read('lastRunMessage'), {
    messageId: '1430000000000000010',
    startedAt: '2026-10-15T12:00:00.000Z'
  });
  assert.deepStrictEqual(plain(await readRunMessage()), database.read('lastRunMessage'));
  assert.strictEqual(database.transactions(), 0);
  for (const value of [{ messageId: 1430 }, { messageId: '../webhooks' }, {}, 'text', null]) {
    database.state.set('lastRunMessage', JSON.stringify(value));
    assert.strictEqual(await readRunMessage(), null, JSON.stringify(value));
  }
}

// The next run finds the record of the run whose message it checks by when that run started, as
// lastRunMessage gives it: the latest run's record, or else its summary in recentRuns, e.g. as a
// run that lost its locks saved its record after the run that took them over. A run that
// saved no record, e.g. as it was killed, has none.
{
  const database = fakeDatabase();
  const { default: RunRecord, readSavedRun, saveRecord, clock } = await loadRunRecord(database);
  assert.strictEqual(await readSavedRun('2026-10-15T12:00:00.000Z'), null);

  const earlier = new RunRecord();
  earlier.count('importBans', () => ({ lists: 2, fetched: 30, banLists: [{ id: 1 }, { id: 2 }] }));
  await saveRecord(earlier.end('failed', 1, 'Stopped, as it lost its locks'));
  clock.now += HOUR;
  const latest = new RunRecord();
  await saveRecord(latest.end('finished', 0));

  assert.deepStrictEqual(
    plain(await readSavedRun('2026-10-15T13:00:00.000Z')),
    plain(latest.ended)
  );
  const { event, ...summary } = plain(earlier.ended);
  assert.strictEqual(event, 'cbl-importer-run');
  assert.deepStrictEqual(plain(await readSavedRun('2026-10-15T12:00:00.000Z')), {
    ...summary,
    counts: { importBans: { lists: 2, fetched: 30 } }
  });
  for (const startedAt of ['2026-10-15T06:00:00.000Z', undefined, null])
    assert.strictEqual(await readSavedRun(startedAt), null, String(startedAt));
  assert.strictEqual(database.transactions(), 2);
}

// The record of a cycle of the importer service also gives the cycle's number, after the commit,
// and the process's memory as the cycle ended, last. Its summary in recentRuns keeps both.
{
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord } = await loadRunRecord(database);
  const record = new RunRecord();
  record.cycle = 12;
  record.memory = { rssMB: 150, heapUsedMB: 52.5, heapTotalMB: 80, externalMB: 3 };
  record.count('importBans', () => ({ lists: 2, banLists: [{ id: 1 }] }));
  const ended = plain(record.end('finished', 0));
  assert.deepStrictEqual(Object.keys(ended), [
    'event',
    'outcome',
    'exitCode',
    'startedAt',
    'endedAt',
    'seconds',
    'gitSha',
    'cycle',
    'phases',
    'counts',
    'memory'
  ]);
  assert.deepStrictEqual([ended.cycle, ended.memory.rssMB], [12, 150]);
  await saveRecord(record.ended);
  const [summary] = database.read('recentRuns');
  assert.deepStrictEqual(
    [summary.cycle, summary.memory, summary.counts],
    [12, ended.memory, { importBans: { lists: 2 } }]
  );
}

// The importer service keeps a row of its own, on its own: its status message, when the process
// that keeps it up to date started, and, once that process ended as it should, when and how, and
// the old copies of its status message still to be deleted. A row whose message is not a Discord
// message's ID keeps the rest.
{
  const database = fakeDatabase();
  const { readService, saveService, SERVICE_STATE } = await loadRunRecord(database);
  assert.strictEqual(SERVICE_STATE.SERVICE, 'importerService');
  assert.strictEqual(await readService(), null);
  await saveService({ messageId: '1430000000000000020', startedAt: START });
  assert.deepStrictEqual(database.read('importerService'), {
    messageId: '1430000000000000020',
    startedAt: '2026-10-15T12:00:00.000Z'
  });
  assert.deepStrictEqual(plain(await readService()), database.read('importerService'));
  await saveService({
    messageId: '1430000000000000020',
    startedAt: START,
    endedAt: START + HOUR,
    outcome: 'stopped'
  });
  assert.deepStrictEqual(plain(await readService()), {
    messageId: '1430000000000000020',
    startedAt: '2026-10-15T12:00:00.000Z',
    endedAt: '2026-10-15T13:00:00.000Z',
    outcome: 'stopped'
  });
  // A process that has not posted a status message, e.g. in changes mode, saves none.
  await saveService({ startedAt: START });
  assert.deepStrictEqual(database.read('importerService'), {
    messageId: null,
    startedAt: '2026-10-15T12:00:00.000Z'
  });
  assert.deepStrictEqual(plain(await readService()), { startedAt: '2026-10-15T12:00:00.000Z' });
  database.state.set('importerService', JSON.stringify({ messageId: '../x', startedAt: 'then' }));
  assert.deepStrictEqual(plain(await readService()), { startedAt: 'then' });
  // The old copies of the status message still to be deleted, after it was posted again below
  // newer messages, are kept with it, when there are any, and only their IDs are read back.
  await saveService({
    messageId: '1430000000000000030',
    startedAt: START,
    oldMessageIds: ['1430000000000000020', '1430000000000000025']
  });
  assert.deepStrictEqual(database.read('importerService'), {
    messageId: '1430000000000000030',
    startedAt: '2026-10-15T12:00:00.000Z',
    oldMessageIds: ['1430000000000000020', '1430000000000000025']
  });
  assert.deepStrictEqual(plain(await readService()), database.read('importerService'));
  await saveService({ messageId: '1430000000000000030', startedAt: START, oldMessageIds: [] });
  assert.deepStrictEqual(Object.keys(database.read('importerService')), ['messageId', 'startedAt']);
  for (const [oldMessageIds, read] of [
    [['1430000000000000020', '../x', 7, null], ['1430000000000000020']],
    [['x'], undefined],
    ['1430000000000000020', undefined]
  ]) {
    database.state.set(
      'importerService',
      JSON.stringify({ messageId: '1430000000000000030', startedAt: 'then', oldMessageIds })
    );
    assert.deepStrictEqual(plain(await readService()).oldMessageIds, read);
  }
  for (const value of ['text', null, [1]]) {
    database.state.set('importerService', JSON.stringify(value));
    assert.strictEqual(await readService(), null, JSON.stringify(value));
  }
  assert.strictEqual(database.transactions(), 0);
}

// The importer service checks whether the importer is stale as runs do, and its alert says that it
// starts a cycle every cadence, and, while it stands by for a lock that another run holds, which:
// the service lock as it starts, or the run lock as a cycle starts.
for (const held of ['service', 'run']) {
  const database = fakeDatabase({
    rows: { lastSuccessAt: JSON.stringify(new Date(START - 2 * HOUR).toISOString()) }
  });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(
    await alertIfStale({ cadenceSeconds: 600, skipped: held, startedAt: START, service: true }),
    true
  );
  assert.deepStrictEqual(discord, [
    `The CBL update is stale: no run has succeeded for 2.0 hours, since the one that started at 2026-10-15T10:00:00.000Z. The importer service starts a cycle every 10 minutes (IMPORTER_CADENCE_SECONDS, or else IMPORTER_CYCLE_SECONDS), so 3 or more in a row have not succeeded. The importer service is standing by, as another run holds the ${held} lock.`
  ]);
}

console.log(
  'Run record checks passed: what a record holds, also when it ends while a phase is under way, reasons cut on a character boundary, saving it with the latest 100 summaries, what counts as a success, the staleness alert on the schedule, with its limit of one a cadence, the run status message to check, with the record of its run, and the importer service: its cycles, its row and its alert.'
);
