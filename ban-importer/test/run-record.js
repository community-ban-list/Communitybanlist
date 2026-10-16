import assert from 'assert';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the run record, without a database: what a run's record holds, how it is saved in
// ImporterState, and when the importer posts that it is stale.

const HOUR = 60 * 60 * 1000;
const CADENCE = 6 * HOUR;
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
    async upsert({ name, value }, { transaction }) {
      fail();
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

// Saving a record keeps it as the latest run and adds its summary to recentRuns, all in one
// transaction. The summary leaves out the lists in the counts, such as each ban list's counts.
{
  const database = fakeDatabase();
  const { default: RunRecord, saveRecord, STATE } = await loadRunRecord(database);
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

  // A successful run also saves when it ended, and recentRuns keeps the latest 100 runs.
  const old = Array.from({ length: 100 }, (_, i) => ({ startedAt: `old ${i}` }));
  database.state.set(STATE.RECENT_RUNS, JSON.stringify(old));
  const success = new RunRecord().end('finished', 0);
  await saveRecord(success);
  const recent = database.read(STATE.RECENT_RUNS);
  assert.strictEqual(recent.length, 100);
  assert.deepStrictEqual(recent[0], { startedAt: 'old 1' });
  assert.strictEqual(recent.at(-1).startedAt, success.startedAt);
  assert.strictEqual(database.read(STATE.LAST_SUCCESS_AT), success.endedAt);
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

// The staleness check: no run has succeeded for 3 cadences.
const stalenessRows = (lastSuccessAt, extra = {}) => ({
  lastSuccessAt: JSON.stringify(new Date(lastSuccessAt).toISOString()),
  lastRun: JSON.stringify({
    endedAt: '2026-10-15T11:00:00.000Z',
    exitCode: 1,
    reason: 'Error: Deadlock found'
  }),
  ...extra
});

// Just under 3 cadences after the last success, nothing is posted, and nothing is written.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * CADENCE + 1) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), false);
  assert.deepStrictEqual(discord, []);
  assert.strictEqual(database.transactions(), 0);
}

// From 3 cadences on, one alert is posted, which says how long it has been, since when, the cadence
// and how the last run ended, and its time is saved.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * CADENCE - 30 * 60 * 1000) });
  const { alertIfStale, discord, clock, STATE } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), true);
  assert.deepStrictEqual(discord, [
    'The CBL update is stale: no run has succeeded for 18.5 hours, since 2026-10-14T17:30:00.000Z, which is over 3 times IMPORTER_CADENCE_SECONDS (6.0 hours). The last run ended at 2026-10-15T11:00:00.000Z with exit code 1 (Error: Deadlock found).'
  ]);
  assert.strictEqual(database.read(STATE.LAST_STALE_ALERT_AT), '2026-10-15T12:00:00.000Z');

  // At most once a cadence: not again until a cadence after the last alert, whether by a run or by
  // a start that was skipped, as another run holds the run lock.
  clock.now += CADENCE - 1;
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), false);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000, skipped: true }), false);
  assert.strictEqual(discord.length, 1);
  clock.now += 1;
  const transactions = database.transactions();
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000, skipped: true }), true);
  assert.strictEqual(discord.length, 2);
  // A skipped start says so. It only reads the record, which needs no lock, and saves nothing, as
  // starts come once a cadence.
  assert.match(
    discord[1],
    /^The CBL update is stale: no run has succeeded for 24\.5 hours, .* This start was skipped, as another run holds the run lock\.$/
  );
  assert.strictEqual(database.transactions(), transactions);
  assert.strictEqual(database.read(STATE.LAST_STALE_ALERT_AT), '2026-10-15T12:00:00.000Z');

  // As the skipped start saved nothing, a run that checks next posts too, and saves when.
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), true);
  assert.strictEqual(discord.length, 3);
  assert.strictEqual(database.read(STATE.LAST_STALE_ALERT_AT), '2026-10-15T18:00:00.000Z');
}

// The cadence is a setting, e.g. an hour for hourly runs, which makes the importer stale after 3
// hours. Durations under 2 hours are given in minutes.
{
  const database = fakeDatabase({ rows: stalenessRows(START - 3 * HOUR - 60 * 1000) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: 3600 }), true);
  assert.match(discord[0], /for 3\.0 hours, .* times IMPORTER_CADENCE_SECONDS \(60 minutes\)\./);
}

// Before any run has succeeded, the time is counted from when the importer's tables were made.
{
  const tablesMadeAt = new Date(START - 3 * CADENCE - HOUR);
  const database = fakeDatabase({ tablesMadeAt });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), true);
  assert.deepStrictEqual(discord, [
    'The CBL update is stale: no run has succeeded for 19.0 hours, since its run record began at 2026-10-14T17:00:00.000Z, which is over 3 times IMPORTER_CADENCE_SECONDS (6.0 hours).'
  ]);
}
{
  // Tables made more recently are not stale yet.
  const database = fakeDatabase({ tablesMadeAt: new Date(START - HOUR) });
  const { alertIfStale, discord } = await loadRunRecord(database);
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000 }), false);
  assert.deepStrictEqual(discord, []);
}

// Before the importer's tables exist, there is nothing to check. Other errors are left to the run,
// which reports them.
{
  const missing = Object.assign(new Error("Table 'cbl.ImporterState' doesn't exist"), {
    original: { errno: 1146 }
  });
  const { alertIfStale } = await loadRunRecord(fakeDatabase({ error: missing }));
  assert.strictEqual(await alertIfStale({ cadenceSeconds: CADENCE / 1000, skipped: true }), false);

  const { alertIfStale: failing } = await loadRunRecord(
    fakeDatabase({ error: new Error('Connection lost') })
  );
  await assert.rejects(failing({ cadenceSeconds: CADENCE / 1000 }), /Connection lost/);
}

// Two runs that save their alerts and check at the same moment, such as a run that lost the run
// lock and the run that took it over, post one alert between them, as the alert's row is read with
// a row lock.
{
  const database = fakeDatabase({
    rows: stalenessRows(START - 4 * CADENCE, {
      lastStaleAlertAt: JSON.stringify(new Date(START - CADENCE).toISOString())
    })
  });
  const { alertIfStale, discord } = await loadRunRecord(database);
  const results = await Promise.all([
    alertIfStale({ cadenceSeconds: CADENCE / 1000 }),
    alertIfStale({ cadenceSeconds: CADENCE / 1000 })
  ]);
  assert.deepStrictEqual(results.toSorted(), [false, true]);
  assert.strictEqual(discord.length, 1);
}

console.log(
  'Run record checks passed: what a record holds, saving it with the latest 100 summaries, and the staleness alert and its limit of one a cadence.'
);
