import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise a run of the importer, from waiting for the database to its exit code and its record,
// without a database, Discord or real signals. The run's steps and migrations are stand-ins, and
// the run record is the real one, saved to a stand-in for ImporterState.

const emptyQueue = { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 };

const START = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

// Wait for the run to get somewhere. The deadline only stops a broken run from hanging the test.
async function until(condition, what) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

// The database is unavailable, e.g. while it restarts.
const unavailable = () => Object.assign(new Error('connect ECONNREFUSED'), { unavailable: true });

// A logged line as the log channel would show it.
const describeLine = (message, extras) => `${message}${extras.map(describeError).join('')}`;

// A stand-in for the ImporterState and ImporterSchemaMigrations tables, holding JSON text as the
// database would. A transaction's writes are kept once it commits. With hang, transactions never
// end, with hangReads, the staleness check's reads never end, and with error, every use of the
// tables fails with it.
function fakeState(
  events,
  { rows = {}, tablesMadeAt = null, hang = false, hangReads = false, error = null } = {}
) {
  const state = new Map(Object.entries(rows).map(([name, value]) => [name, JSON.stringify(value)]));
  const read = (name) => (state.has(name) ? JSON.parse(state.get(name)) : undefined);
  const fail = () => {
    if (error) throw error;
  };

  const ImporterState = {
    async findAll({ where: { name } }) {
      events.push('read state');
      if (hangReads) return new Promise(() => {});
      fail();
      return [...name]
        .filter((key) => state.has(key))
        .map((key) => ({ name: key, value: read(key) }));
    },
    async findByPk(name) {
      fail();
      return state.has(name) ? { name, value: read(name) } : null;
    },
    async upsert({ name, value }, { transaction }) {
      fail();
      transaction.writes.push([name, JSON.stringify(value)]);
    }
  };
  const ImporterSchemaMigration = {
    async min() {
      fail();
      return tablesMadeAt;
    }
  };
  const transaction = async (work) => {
    events.push('transaction');
    if (hang) return new Promise(() => {});
    fail();
    const current = { LOCK: { UPDATE: 'UPDATE' }, writes: [] };
    const result = await work(current);
    for (const [name, value] of current.writes) state.set(name, value);
    events.push('commit');
    return result;
  };

  return { state, read, ImporterState, ImporterSchemaMigration, transaction };
}

// Load run.js with stand-ins for the database, the run lock, the migrations, the logger and the
// process, and a clock that only moves when the test moves it. takeRunLockError, when given, is
// what taking the lock fails with, migrations is what migrate() resolves with or a function that
// is given migrate()'s options and returns it or throws, state sets up the stand-in for
// ImporterState (see fakeState), and logQueue is what the logger says is waiting to be sent.
async function loadRun({
  env = {},
  authenticate = async () => {},
  lockFree = true,
  takeRunLockError = null,
  migrations = { applied: [], unknown: [] },
  connect = async () => {},
  disconnect = async () => {},
  state: stateOptions = {},
  logQueue = emptyQueue
} = {}) {
  const events = [];
  const output = [];
  const discord = [];
  const timers = new Set();
  let now = START;
  const state = fakeState(events, stateOptions);

  class FakeDate extends Date {
    static now() {
      return now;
    }
  }

  const lock = {
    held: true,
    released: false,
    destroyed: false,
    onLost: null,
    async isHeld() {
      return this.held;
    },
    async release() {
      events.push('release');
      this.released = true;
    },
    destroy() {
      events.push('destroy');
      this.destroyed = true;
    }
  };

  const fakeProcess = new EventEmitter();
  fakeProcess.env = env;
  fakeProcess.exits = [];
  fakeProcess.exit = (code) => {
    events.push(`exit ${code}`);
    fakeProcess.exits.push(code);
  };

  const dependencies = {
    'scbl-lib/db': {
      connect: async () => {
        events.push('connect');
        return connect();
      },
      disconnect: async () => {
        events.push('disconnect');
        return disconnect();
      },
      sequelize: {
        authenticate: async () => {
          events.push('authenticate');
          return authenticate();
        },
        transaction: state.transaction
      },
      takeRunLock: async ({ onLost }) => {
        events.push('takeRunLock');
        if (takeRunLockError) throw takeRunLockError;
        if (!lockFree) return null;
        lock.onLost = onLost;
        return lock;
      }
    },
    'scbl-lib/db/importer-models': {
      ImporterSchemaMigration: state.ImporterSchemaMigration,
      ImporterState: state.ImporterState
    },
    'scbl-lib/db/sequelize': { isDatabaseUnavailable: (err) => err.unavailable === true },
    'scbl-lib/utils': {
      describeError,
      // Level 1 lines and important ones go to the log channel. Important lines are the run's own,
      // which go ahead of its other messages.
      Logger: {
        verbose: (module, verboseness, message, ...extras) => {
          const text = describeLine(message, extras);
          events.push(`verbose ${text}`);
          if (verboseness === 1) discord.push(text);
        },
        important: (module, message, ...extras) => {
          const text = describeLine(message, extras);
          events.push(`important ${text}`);
          discord.push(text);
        },
        flush: () => events.push('flush'),
        getLogQueue: () => logQueue
      }
    },
    './schema/migrate.js': {
      // Like migrate(), it tells the run of each migration it applied as it records it.
      default: async (options) => {
        events.push('migrate');
        if (typeof migrations === 'function') return migrations(options);
        for (const id of migrations.applied) options.onApplied(id);
        return migrations;
      }
    }
  };

  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess,
    Date: FakeDate,
    setTimeout: (callback, ms) => {
      const timer = { at: now + ms, ms, callback, unref: () => timer };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer)
  });

  const url = new URL('../src/run.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  let control;
  await module.link(async (specifier, referencingModule) => {
    const exports = dependencies[specifier];
    if (exports) {
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    }
    // The real run-control.js, which the steps use too, and the real run record.
    assert.ok(
      ['./run-control.js', './run-record.js'].includes(specifier),
      `Unexpected dependency: ${specifier}`
    );
    const dependency = new URL(specifier, referencingModule.identifier);
    const loaded = new vm.SourceTextModule(await readFile(dependency, 'utf8'), {
      context,
      identifier: dependency.href
    });
    if (specifier === './run-control.js') control = loaded;
    return loaded;
  });
  await module.evaluate();

  const isRecord = (line) => line.startsWith('{"event":"cbl-importer-run"');
  return {
    run: module.namespace.default,
    EXIT_CODES: module.namespace.EXIT_CODES,
    leftWaiting: module.namespace.leftWaiting,
    control: control.namespace,
    lock,
    events,
    output,
    discord,
    state,
    // The lines logged as important.
    important: () =>
      events.filter((event) => event.startsWith('important ')).map((event) => event.slice(10)),
    // The JSON lines with the run's record, which a run prints once, and the only one.
    records: () => output.filter(isRecord).map((line) => JSON.parse(line)),
    record() {
      const records = this.records();
      assert.strictEqual(records.length, 1, 'One JSON line per run');
      return records[0];
    },
    // The console's lines other than the record's.
    printed: () => output.filter((line) => !isRecord(line)),
    timers,
    process: fakeProcess,
    now: () => now,
    // Move the clock on, running the timers that fall due, in order.
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [next] = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = end;
    },
    // Wait for the run to start waiting for a timer of ms milliseconds.
    waitForTimer: (ms) =>
      until(() => [...timers].some((timer) => timer.ms === ms), `a timer of ${ms} ms`),
    // Let the run get on, moving the clock on to each timer it waits for in turn, until it has
    // ended. Resolves with its exit code.
    async runTimers(run) {
      const progress = { ended: false };
      const done = () => (progress.ended = true);
      run.then(done, done);
      for (let turn = 0; ; turn++) {
        await new Promise(setImmediate);
        if (progress.ended) return run;
        assert.ok(turn < 1000, 'The run ends');
        const [next] = [...timers].sort((a, b) => a.at - b.at);
        assert.ok(next, 'The run waits for a timer');
        this.advance(next.at - now);
      }
    }
  };
}

// A step of the run, as index.js gives them.
const step = (name, run, counts) => ({ name, run, counts });

// A step that waits until the test lets it finish.
function gatedStep(events, name) {
  const started = deferred();
  const finish = deferred();
  return {
    step: step(name, async () => {
      events.push(name);
      started.resolve();
      await finish.promise;
    }),
    started: started.promise,
    finish: finish.resolve
  };
}

// A run that finishes: it waits for the database, takes the lock before anything is posted to
// Discord, applies the importer's migrations, runs the steps in order and exits 0, after saving its
// record, closing the database connections, sending its log messages and releasing the lock. A run
// that finishes posts nothing itself: its start and end are only printed in the console, the start
// with the commit and the settings, and so is its record, as one JSON line.
{
  const importer = await loadRun({ env: { GIT_SHA: 'abc1234' } });
  const exitCode = await importer.run([
    step('import', async () => importer.events.push('import')),
    step('export', async () => importer.events.push('export'))
  ]);

  assert.strictEqual(exitCode, importer.EXIT_CODES.FINISHED);
  assert.strictEqual(exitCode, 0);
  assert.deepStrictEqual(importer.events, [
    'authenticate',
    'takeRunLock',
    'verbose Starting new CBL Update run (commit abc1234, time limit 18000s, cadence 21600s)...',
    'connect',
    'migrate',
    'import',
    'export',
    'transaction',
    'commit',
    'disconnect',
    'flush',
    'release'
  ]);
  assert.deepStrictEqual(importer.discord, []);
  assert.deepStrictEqual(importer.printed(), [
    'Finished All Tasks. Complete CBL run Took 0.00s. Garbage Collection Completed.'
  ]);

  // The record says when the run started and ended, which commit it ran, how it ended and how long
  // each phase took. It is saved as the latest run and, by when it started, the latest success, and
  // added to the summaries of recent runs.
  const record = importer.record();
  assert.deepStrictEqual(record, {
    event: 'cbl-importer-run',
    outcome: 'finished',
    exitCode: 0,
    startedAt: '2026-10-15T12:00:00.000Z',
    endedAt: '2026-10-15T12:00:00.000Z',
    seconds: 0,
    gitSha: 'abc1234',
    phases: { waitForDatabase: 0, takeRunLock: 0, connect: 0, migrate: 0, import: 0, export: 0 },
    counts: {}
  });
  assert.deepStrictEqual(importer.state.read('lastRun'), record);
  assert.strictEqual(importer.state.read('lastSuccessAt'), record.startedAt);
  const { event, ...summary } = record;
  assert.strictEqual(event, 'cbl-importer-run');
  assert.deepStrictEqual(importer.state.read('recentRuns'), [summary]);
  // A run that succeeded is not stale, so it does not check.
  assert.ok(!importer.events.includes('read state'));

  // The signal handlers and timers are gone once the run has ended.
  assert.strictEqual(importer.process.listenerCount('SIGTERM'), 0);
  assert.strictEqual(importer.process.listenerCount('SIGINT'), 0);
  assert.strictEqual(importer.timers.size, 0);
}

// Each phase's time is recorded, as are the counts a step gives, which a step that fails still
// gives. The record of a failed run names the phase it failed in and why.
{
  const importer = await loadRun();
  let imported = 0;
  const exitCode = await importer.run([
    step(
      'importBans',
      async () => {
        importer.advance(90 * 1000);
        imported = 2;
      },
      () => ({ lists: 20, imported, banLists: [{ id: 1 }, { id: 2 }] })
    ),
    step(
      'updateExportBans',
      async () => {
        importer.advance(1500);
        throw new Error('Deadlock found');
      },
      () => ({ players: 250 })
    ),
    step('exportExportBans', async () => importer.events.push('export'))
  ]);
  assert.strictEqual(exitCode, 1);
  const record = importer.record();
  assert.strictEqual(record.outcome, 'failed');
  assert.strictEqual(record.reason, 'Error: Deadlock found');
  assert.strictEqual(record.phase, 'updateExportBans');
  assert.strictEqual(record.seconds, 91.5);
  assert.strictEqual(record.endedAt, '2026-10-15T12:01:31.500Z');
  assert.deepStrictEqual(record.phases, {
    waitForDatabase: 0,
    takeRunLock: 0,
    connect: 0,
    migrate: 0,
    importBans: 90,
    updateExportBans: 1.5
  });
  assert.deepStrictEqual(record.counts, {
    importBans: { lists: 20, imported: 2, banLists: [{ id: 1 }, { id: 2 }] },
    updateExportBans: { players: 250 }
  });
  // The saved record is the same, its summary leaves out the per-list counts, and a failed run is
  // not a success.
  assert.deepStrictEqual(importer.state.read('lastRun'), record);
  assert.deepStrictEqual(importer.state.read('recentRuns')[0].counts, {
    importBans: { lists: 20, imported: 2 },
    updateExportBans: { players: 250 }
  });
  assert.ok(!importer.state.state.has('lastSuccessAt'));
}

// When another run holds the lock, the run is skipped with exit code 75 and one line in the
// console, besides its record. It posts nothing to Discord, and saves nothing, but it checks
// whether the importer is stale, as a run that is stuck holding the lock would make every later
// start skip.
{
  const importer = await loadRun({ lockFree: false });
  const exitCode = await importer.run([step('import', () => importer.events.push('import'))]);
  assert.strictEqual(exitCode, 75);
  assert.deepStrictEqual(importer.events, ['authenticate', 'takeRunLock', 'read state']);
  assert.deepStrictEqual(importer.printed(), [
    'Skipped this CBL update run, as another run holds the run lock.'
  ]);
  assert.deepStrictEqual(importer.discord, []);
  assert.strictEqual(importer.state.state.size, 0);
  const record = importer.record();
  assert.strictEqual(record.outcome, 'skipped');
  assert.strictEqual(record.exitCode, 75);
  assert.strictEqual(record.reason, 'Another run holds the run lock');
  assert.ok(!('phase' in record));
}

// A skipped start that finds no run has succeeded for 3 cadences posts that the importer is stale,
// and sends it before it ends, unless a run or skipped start posted within the cadence. It saves
// when it started as the time of the alert, and nothing else.
{
  const rows = {
    lastSuccessAt: new Date(START - 19 * HOUR).toISOString(),
    lastRun: { endedAt: '2026-10-15T06:00:00.000Z', exitCode: 1, reason: 'Error: Lost' }
  };
  const importer = await loadRun({ lockFree: false, state: { rows } });
  assert.strictEqual(await importer.run([]), 75);
  assert.deepStrictEqual(importer.discord, [
    'The CBL update is stale: no run has succeeded for 19.0 hours, since the one that started at 2026-10-14T17:00:00.000Z. Runs start every IMPORTER_CADENCE_SECONDS (6.0 hours), so 3 or more in a row have not succeeded. The last run ended at 2026-10-15T06:00:00.000Z with exit code 1 (Error: Lost). This start was skipped, as another run holds the run lock.'
  ]);
  assert.deepStrictEqual(importer.events, [
    'authenticate',
    'takeRunLock',
    'read state',
    'transaction',
    'commit',
    `important ${importer.discord[0]}`,
    'flush'
  ]);
  assert.deepStrictEqual([...importer.state.state.keys()].sort(), [
    'lastRun',
    'lastStaleAlertAt',
    'lastSuccessAt'
  ]);
  assert.strictEqual(importer.state.read('lastStaleAlertAt'), importer.record().startedAt);
  assert.strictEqual(importer.record().outcome, 'skipped');

  const alerted = await loadRun({
    lockFree: false,
    state: { rows: { ...rows, lastStaleAlertAt: new Date(START - 5 * HOUR).toISOString() } }
  });
  assert.strictEqual(await alerted.run([]), 75);
  assert.deepStrictEqual(alerted.discord, []);
  assert.ok(!alerted.events.includes('flush'));
}

// A run that cannot take the lock failed, rather than being skipped: it exits 1, not 75, and unlike
// a skipped run it posts the failure, and sends it before it ends. It held no lock, so it saves no
// record.
{
  const importer = await loadRun({ takeRunLockError: new Error('ER_LOCK_DEADLOCK') });
  const exitCode = await importer.run([step('import', () => importer.events.push('import'))]);
  assert.strictEqual(exitCode, 1);
  assert.deepStrictEqual(importer.events, [
    'authenticate',
    'takeRunLock',
    'important The CBL update run failed: Error: ER_LOCK_DEADLOCK',
    'flush'
  ]);
  assert.deepStrictEqual(importer.discord, ['The CBL update run failed: Error: ER_LOCK_DEADLOCK']);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase, record.reason],
    ['failed', 1, 'takeRunLock', 'Error: ER_LOCK_DEADLOCK']
  );
}

// A step that fails ends the run with exit code 1. The failure is posted to Discord, the later
// steps are skipped and the lock is released. Its record is saved, and it checks whether the
// importer is now stale.
{
  const importer = await loadRun();
  const exitCode = await importer.run([
    step('import', async () => {
      throw new Error('Deadlock found');
    }),
    step('export', () => importer.events.push('export'))
  ]);
  assert.strictEqual(exitCode, 1);
  assert.ok(!importer.events.includes('export'));
  assert.ok(!importer.events.includes('disconnect'));
  assert.strictEqual(
    importer.important().at(-1),
    'The CBL update run failed: Error: Deadlock found'
  );
  assert.deepStrictEqual(importer.events.slice(-5), [
    'transaction',
    'commit',
    'read state',
    'flush',
    'release'
  ]);
  assert.strictEqual(importer.state.read('lastRun').exitCode, 1);
}

// A run that fails after no run has succeeded for 3 cadences also posts that the importer is stale,
// after its failure, at most once a cadence. IMPORTER_CADENCE_SECONDS sets the cadence.
{
  const rows = { lastSuccessAt: new Date(START - 4 * HOUR).toISOString() };
  const failing = () => [
    step('import', async () => {
      throw new Error('Deadlock found');
    })
  ];
  const first = await loadRun({ env: { IMPORTER_CADENCE_SECONDS: '3600' }, state: { rows } });
  assert.strictEqual(await first.run(failing()), 1);
  assert.deepStrictEqual(first.discord, [
    'The CBL update run failed: Error: Deadlock found',
    'The CBL update is stale: no run has succeeded for 4.0 hours, since the one that started at 2026-10-15T08:00:00.000Z. Runs start every IMPORTER_CADENCE_SECONDS (60 minutes), so 3 or more in a row have not succeeded. The last run ended at 2026-10-15T12:00:00.000Z with exit code 1 (Error: Deadlock found).'
  ]);
  assert.strictEqual(first.state.read('lastStaleAlertAt'), first.record().startedAt);

  // The next run, started a moment later, saves its record but posts only its failure.
  const saved = Object.fromEntries(
    [...first.state.state].map(([name, value]) => [name, JSON.parse(value)])
  );
  const second = await loadRun({
    env: { IMPORTER_CADENCE_SECONDS: '3600' },
    state: { rows: saved }
  });
  assert.strictEqual(await second.run(failing()), 1);
  assert.deepStrictEqual(second.discord, ['The CBL update run failed: Error: Deadlock found']);
  assert.strictEqual(second.state.read('recentRuns').length, 2);

  // With the default cadence of 6 hours, 4 hours without a success is not stale.
  const defaultCadence = await loadRun({ state: { rows } });
  assert.strictEqual(await defaultCadence.run(failing()), 1);
  assert.deepStrictEqual(defaultCadence.discord, [
    'The CBL update run failed: Error: Deadlock found'
  ]);
}

// The importer's migrations are applied once the run holds the lock and has connected, before the
// first step. Those applied are printed and recorded, as are any the database has from a newer
// version, which are left alone.
{
  const importer = await loadRun({
    migrations: { applied: ['001-importer-state'], unknown: ['002-ban-list-syncs'] }
  });
  assert.strictEqual(await importer.run([step('import', () => importer.events.push('import'))]), 0);
  assert.deepStrictEqual(importer.events.slice(3, 8), [
    'connect',
    'migrate',
    "verbose Applied the importer's migrations 001-importer-state.",
    'verbose The database also has importer migrations from a newer version, which are left as they are: 002-ban-list-syncs.',
    'import'
  ]);
  assert.deepStrictEqual(importer.record().migrations, ['001-importer-state']);
}

// A migration that fails ends the run with exit code 1 before any step, and the failure names the
// migration.
{
  const failure = Object.assign(
    new Error(
      "Importer migration 001-importer-state failed: Error: CREATE command denied to user 'cbl'"
    ),
    { name: 'MigrationError' }
  );
  const importer = await loadRun({
    migrations: () => {
      throw failure;
    }
  });
  assert.strictEqual(await importer.run([step('import', () => importer.events.push('import'))]), 1);
  assert.ok(!importer.events.includes('import'));
  assert.deepStrictEqual(importer.discord, [
    "The CBL update run failed: MigrationError: Importer migration 001-importer-state failed: Error: CREATE command denied to user 'cbl'"
  ]);
  const record = importer.record();
  assert.deepStrictEqual([record.outcome, record.exitCode, record.phase], ['failed', 1, 'migrate']);
  assert.match(record.reason, /^MigrationError: Importer migration 001-importer-state failed: /);
  assert.ok(!('migrations' in record));
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
}
{
  // The migrations applied before a later one or the column check failed are in the record all the
  // same, as the database has them, and the next run does not apply them again.
  const importer = await loadRun({
    migrations: ({ onApplied }) => {
      onApplied('001-importer-state');
      throw Object.assign(
        new Error(
          "The importer's tables are missing columns after migration 001-importer-state: ImporterState.value."
        ),
        { name: 'MigrationError' }
      );
    }
  });
  assert.strictEqual(await importer.run([step('import', () => importer.events.push('import'))]), 1);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.migrations],
    ['failed', 1, ['001-importer-state']]
  );
  assert.deepStrictEqual(importer.state.read('lastRun').migrations, ['001-importer-state']);
  assert.deepStrictEqual(importer.state.read('recentRuns')[0].migrations, ['001-importer-state']);
}

// A run asked to stop while it connects stops before the migrations.
{
  const importer = await loadRun({
    connect: async () => importer.process.emit('SIGTERM', 'SIGTERM')
  });
  assert.strictEqual(await importer.run([step('import', () => importer.events.push('import'))]), 3);
  assert.ok(importer.events.includes('connect'));
  assert.ok(!importer.events.includes('migrate'));
  assert.strictEqual(importer.record().phase, 'connect');
}

// Saving the record never turns a run that finished into a failure, nor holds up its end: a save
// that fails is reported in the console, and one that does not answer is given up after 15
// seconds. The record's JSON line is printed before the save.
{
  const importer = await loadRun({ state: { error: new Error('Lock wait timeout exceeded') } });
  assert.strictEqual(await importer.run([]), 0);
  assert.deepStrictEqual(importer.printed().slice(1), [
    'Warning: could not save the run record: Error: Lock wait timeout exceeded'
  ]);
  assert.strictEqual(importer.record().outcome, 'finished');
  assert.deepStrictEqual(importer.events.slice(-3), ['disconnect', 'flush', 'release']);
}
{
  const importer = await loadRun({ state: { hang: true } });
  let exitCode = null;
  const run = importer.run([]).then((code) => (exitCode = code));
  await importer.waitForTimer(15000);
  assert.strictEqual(importer.record().outcome, 'finished');
  importer.advance(14999);
  await new Promise(setImmediate);
  assert.strictEqual(exitCode, null);
  importer.advance(1);
  await run;
  assert.strictEqual(exitCode, 0);
  assert.ok(
    importer
      .printed()
      .includes(
        'Warning: could not save the run record: Error: Saving the run record took longer than 15s'
      )
  );
  assert.deepStrictEqual(importer.events.slice(-3), ['disconnect', 'flush', 'release']);
  assert.strictEqual(importer.timers.size, 0);
}
{
  // The same goes for checking whether the importer is stale, after a run that failed.
  const importer = await loadRun({ state: { error: new Error('Connection lost') } });
  const exitCode = await importer.run([
    step('import', async () => {
      throw new Error('Deadlock found');
    })
  ]);
  assert.strictEqual(exitCode, 1);
  assert.deepStrictEqual(importer.printed(), [
    'Warning: could not save the run record: Error: Connection lost',
    'Warning: could not check whether the CBL update is stale: Error: Connection lost'
  ]);
}
{
  // And for closing the database connections, which is given up after 10 seconds.
  const importer = await loadRun({ disconnect: () => new Promise(() => {}) });
  const run = importer.run([]);
  await importer.waitForTimer(10000);
  importer.advance(10000);
  assert.strictEqual(await run, 0);
  assert.ok(
    importer
      .printed()
      .includes(
        'Warning: could not close the database connections: Error: Closing the database connections took longer than 10s'
      )
  );
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
}

// The end of a run takes at most 45 seconds, however slow the database and Discord are, so a run
// that docker stop stops, which it gives 60 seconds, exits in time once it reaches a safe point.
// The log messages are waited for until 5 seconds are left for releasing the run lock.
const failingStep = () =>
  step('import', async () => {
    throw new Error('Deadlock found');
  });
const sinceEnd = (importer) => importer.now() - Date.parse(importer.record().endedAt);
{
  // A database that does not save the record within 15 seconds is not asked whether the importer is
  // stale, which leaves the time for the log messages.
  const importer = await loadRun({
    state: { hang: true },
    logQueue: { ...emptyQueue, QUEUED: 3 }
  });
  assert.strictEqual(await importer.runTimers(importer.run([failingStep()])), 1);
  assert.strictEqual(sinceEnd(importer), 40000);
  assert.ok(!importer.events.includes('read state'));
  assert.deepStrictEqual(importer.events.slice(-3), ['transaction', 'flush', 'release']);
  assert.deepStrictEqual(importer.printed(), [
    'Warning: could not save the run record: Error: Saving the run record took longer than 15s'
  ]);
}
{
  // A staleness check that does not answer is given up after 15 seconds, and the log messages get
  // the rest of the time.
  const importer = await loadRun({
    state: { hangReads: true },
    logQueue: { ...emptyQueue, QUEUED: 1 }
  });
  assert.strictEqual(await importer.runTimers(importer.run([failingStep()])), 1);
  assert.strictEqual(sinceEnd(importer), 40000);
  assert.deepStrictEqual(importer.events.slice(-5), [
    'transaction',
    'commit',
    'read state',
    'flush',
    'release'
  ]);
  assert.deepStrictEqual(importer.printed(), [
    'Warning: could not check whether the CBL update is stale: Error: Checking whether the CBL update is stale took longer than 15s'
  ]);
}
{
  // A run that finished, with a database that saves and closes nothing, ends in the same time.
  const importer = await loadRun({
    state: { hang: true },
    disconnect: () => new Promise(() => {}),
    logQueue: { ...emptyQueue, RUNNING: 1 }
  });
  assert.strictEqual(await importer.runTimers(importer.run([])), 0);
  assert.strictEqual(sinceEnd(importer), 40000);
  assert.deepStrictEqual(importer.events.slice(-4), [
    'transaction',
    'disconnect',
    'flush',
    'release'
  ]);
}
{
  // Nor is a database that is unavailable asked whether the importer is stale.
  const importer = await loadRun({ state: { error: unavailable() } });
  assert.strictEqual(await importer.run([failingStep()]), 1);
  assert.ok(!importer.events.includes('read state'));
  assert.deepStrictEqual(importer.printed(), [
    'Warning: could not save the run record: Error: connect ECONNREFUSED'
  ]);
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
}

// A run that finished but imported none of its ban lists, e.g. during a BattleMetrics outage, is
// not a success: it is not saved as the latest success, and it checks whether the importer is now
// stale, and says why, before it closes the database connections.
{
  const rows = { lastSuccessAt: new Date(START - 19 * HOUR).toISOString() };
  const importer = await loadRun({ state: { rows } });
  const error = 'Error: Request failed with status code 503';
  const exitCode = await importer.run([
    step(
      'importBans',
      async () => {},
      () => ({
        lists: 2,
        imported: 2,
        failedLists: 2,
        banLists: [
          { id: 1, error },
          { id: 2, error }
        ]
      })
    )
  ]);
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(importer.record().outcome, 'finished');
  assert.strictEqual(importer.state.read('lastSuccessAt'), rows.lastSuccessAt);
  assert.match(
    importer.discord[0],
    /^The CBL update is stale: .* The last run ended at 2026-10-15T12:00:00\.000Z with exit code 0, but imported none of its 2 ban lists\.$/
  );
  assert.deepStrictEqual(importer.events.slice(-9), [
    'transaction',
    'commit',
    'read state',
    'transaction',
    'commit',
    `important ${importer.discord[0]}`,
    'disconnect',
    'flush',
    'release'
  ]);
}

// A run left waiting for something that can never happen, such as an answer on a connection that
// is gone, is ended by index.js through leftWaiting() once Node finds nothing left to wait for. It
// failed: the failure is posted, and it ends as a failed run does, printing its record as its one
// JSON line and saving it, checking whether the importer is stale and releasing the lock.
{
  const importer = await loadRun();
  const stuck = gatedStep(importer.events, 'import');
  const run = importer.run([stuck.step, step('export', () => importer.events.push('export'))]);
  await stuck.started;
  assert.strictEqual(await importer.leftWaiting(), 1);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase, record.reason],
    ['failed', 1, 'import', 'The run was left waiting for something that can never happen']
  );
  assert.deepStrictEqual(importer.state.read('lastRun'), record);
  assert.deepStrictEqual(importer.discord, [
    'The CBL update run failed, as it was left waiting for something that can never happen.'
  ]);
  assert.deepStrictEqual(importer.events.slice(-5), [
    'transaction',
    'commit',
    'read state',
    'flush',
    'release'
  ]);

  // Should the run carry on after all, it stops at its next safe point, and its record stands.
  stuck.finish();
  assert.strictEqual(await run, 1);
  assert.ok(!importer.events.includes('export'));
  assert.strictEqual(importer.records().length, 1);
  assert.strictEqual(importer.events.filter((event) => event === 'release').length, 1);
}
{
  // One left waiting before it holds the lock only prints its record, after posting the failure.
  const importer = await loadRun({ authenticate: () => new Promise(() => {}) });
  importer.run([]);
  await until(() => importer.events.includes('authenticate'), 'the database wait');
  assert.strictEqual(await importer.leftWaiting(), 1);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase],
    ['failed', 1, 'waitForDatabase']
  );
  assert.deepStrictEqual(importer.discord, [
    'The CBL update run failed, as it was left waiting for something that can never happen.'
  ]);
  assert.ok(!importer.events.includes('transaction'));
  assert.strictEqual(importer.events.at(-1), 'flush');
}
{
  // Without a run under way, there is nothing to end, and the importer exits 1 all the same.
  const importer = await loadRun();
  assert.strictEqual(await importer.leftWaiting(), 1);
  assert.strictEqual(await importer.run([]), 0);
  assert.strictEqual(await importer.leftWaiting(), 1);
  assert.strictEqual(importer.records().length, 1);
}

// A run that finished after a promise failed with nothing to handle it exits 1, as index.js does,
// and its record says so. It is not a success.
{
  const importer = await loadRun();
  const exitCode = await importer.run([
    step('import', async () => {
      importer.process.exitCode = 1;
    })
  ]);
  assert.strictEqual(exitCode, 1);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['failed', 1, 'A promise failed with nothing to handle it']
  );
  assert.ok(!importer.state.state.has('lastSuccessAt'));
  assert.ok(!importer.events.includes('disconnect'));
}

// The database may have just been restarted, so the run waits for it, trying again after 5, 10,
// 20, 40 and 80 seconds.
{
  let failures = 2;
  const importer = await loadRun({
    authenticate: async () => {
      if (failures-- > 0) throw unavailable();
    }
  });
  const run = importer.run([step('import', () => importer.events.push('import'))]);
  for (const delay of [5000, 10000]) {
    await importer.waitForTimer(delay);
    importer.advance(delay);
  }
  assert.strictEqual(await run, 0);
  assert.ok(importer.events.includes('import'));
  assert.strictEqual(importer.events.filter((event) => event === 'authenticate').length, 3);
  assert.match(
    importer.output[0],
    /^The database is not available \(Error: connect ECONNREFUSED\)/
  );
  assert.strictEqual(importer.record().phases.waitForDatabase, 15);
}
{
  const importer = await loadRun({ authenticate: async () => Promise.reject(unavailable()) });
  const run = importer.run([step('import', () => importer.events.push('import'))]);
  for (const delay of [5000, 10000, 20000, 40000, 80000]) {
    await importer.waitForTimer(delay);
    importer.advance(delay);
  }
  // It gives up with exit code 1, before the lock is taken. The failure is posted all the same, as
  // the run would otherwise fail unseen, and sent before the run ends. It saves no record.
  assert.strictEqual(await run, 1);
  assert.strictEqual(importer.events.filter((event) => event === 'authenticate').length, 6);
  assert.ok(!importer.events.includes('takeRunLock'));
  assert.deepStrictEqual(importer.discord, [
    'The CBL update run failed, as it could not reach the database: Error: connect ECONNREFUSED'
  ]);
  assert.deepStrictEqual(importer.important(), importer.discord);
  assert.strictEqual(importer.events.at(-1), 'flush');
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.phase, record.reason],
    ['failed', 'waitForDatabase', 'Could not reach the database: Error: connect ECONNREFUSED']
  );
}
{
  // Other errors are not waited out.
  const importer = await loadRun({
    authenticate: async () => {
      throw new Error("Access denied for user 'cbl'");
    }
  });
  assert.strictEqual(await importer.run([]), 1);
  assert.deepStrictEqual(importer.events, [
    'authenticate',
    "important The CBL update run failed, as it could not reach the database: Error: Access denied for user 'cbl'",
    'flush'
  ]);
}

// SIGTERM or SIGINT asks the run to stop at its next safe point: the step in progress finishes, the
// next one never starts, and the run exits 3 after saving its record, sending its log messages and
// releasing the lock.
for (const signal of ['SIGTERM', 'SIGINT']) {
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, step('export', () => importer.events.push('export'))]);
  await first.started;
  importer.process.emit(signal, signal);
  assert.match(
    importer.important().at(-1),
    new RegExp(`^Received ${signal}, so the run will stop`)
  );
  first.finish();

  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('export'));
  assert.strictEqual(
    importer.important().at(-1),
    `The CBL update run stopped before it finished, as it received ${signal}.`
  );
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
  assert.deepStrictEqual(importer.process.exits, []);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase, record.reason],
    ['interrupted', 3, 'import', `Stopped, as it received ${signal}`]
  );
  assert.deepStrictEqual(importer.state.read('lastRun'), record);
}

// A run asked to stop during its last step has nothing left to skip, so it finishes as usual.
{
  const importer = await loadRun();
  const last = gatedStep(importer.events, 'export');
  const run = importer.run([last.step]);
  await last.started;
  importer.process.emit('SIGTERM', 'SIGTERM');
  last.finish();
  assert.strictEqual(await run, 0);
  assert.strictEqual(importer.record().outcome, 'finished');
}

// The steps' own safe points, such as between export bans, stop the run too.
{
  const importer = await loadRun();
  const run = importer.run([
    step('export', async () => {
      importer.process.emit('SIGTERM', 'SIGTERM');
      importer.control.stopIfRequested();
      importer.events.push('next export ban');
    })
  ]);
  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('next export ban'));
  assert.strictEqual(importer.record().phase, 'export');
}

// A second signal ends the run at once, closing the lock's connection, which frees the lock. Its
// record is printed, as the only one, but there is no time to save it.
{
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step]);
  await first.started;
  importer.process.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(importer.process.exits, []);
  importer.process.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(importer.process.exits, [3]);
  assert.ok(importer.lock.destroyed);
  assert.match(importer.printed().at(-1), /^Received SIGINT again, so the run is ending now/);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['interrupted', 3, 'Received SIGINT again, so it ended at once']
  );

  // The test's process.exit() returns, so let the run end. It prints no second record.
  first.finish();
  await run;
  assert.strictEqual(importer.records().length, 1);
}
{
  // A run that has already ended, and is only saving its record, exits with its own code.
  const importer = await loadRun({ state: { hang: true } });
  const run = importer.run([]);
  await importer.waitForTimer(15000);
  importer.process.emit('SIGTERM', 'SIGTERM');
  importer.process.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(importer.process.exits, [0]);
  assert.ok(importer.lock.destroyed);
  assert.strictEqual(importer.record().outcome, 'finished');

  importer.advance(15000);
  await run;
  assert.strictEqual(importer.records().length, 1);
}

// A signal while the run waits for the database stops it there, before the lock is taken.
{
  const importer = await loadRun({ authenticate: async () => Promise.reject(unavailable()) });
  const run = importer.run([]);
  await importer.waitForTimer(5000);
  importer.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('takeRunLock'));
  assert.deepStrictEqual(importer.discord, []);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.phase, record.reason],
    ['interrupted', 'waitForDatabase', 'Stopped, as it received SIGTERM']
  );
}

// The time limit, IMPORTER_MAX_RUN_SECONDS, asks the run to stop at its next safe point, so it ends
// before the next scheduled run would stop it.
{
  const importer = await loadRun({ env: { IMPORTER_MAX_RUN_SECONDS: '600' } });
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, step('export', () => importer.events.push('export'))]);
  await first.started;
  importer.advance(599 * 1000);
  assert.strictEqual(importer.control.isStopping(), false);
  importer.advance(1000);
  assert.strictEqual(importer.control.isStopping(), true);
  assert.match(importer.important().at(-1), /^The run has taken longer than 600s/);
  first.finish();

  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('export'));
  assert.match(
    importer.important().at(-1),
    /stopped before it finished, as it took longer than 600s/
  );
  assert.strictEqual(importer.record().reason, 'Stopped, as it took longer than 600s');
  // It ended in time, so it is not made to exit.
  assert.strictEqual(importer.timers.size, 0);
  assert.deepStrictEqual(importer.process.exits, []);
}

// A run that does not stop within 60 seconds of its time limit, e.g. because a step is stuck,
// exits at once, closing the lock's connection.
{
  const importer = await loadRun({ env: { IMPORTER_MAX_RUN_SECONDS: '600' } });
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step]);
  await first.started;
  importer.advance(600 * 1000);
  importer.advance(59 * 1000);
  assert.deepStrictEqual(importer.process.exits, []);
  importer.advance(1000);
  assert.deepStrictEqual(importer.process.exits, [3]);
  assert.ok(importer.lock.destroyed);
  assert.match(importer.printed().at(-1), /did not stop within 60s of its time limit/);
  assert.strictEqual(
    importer.record().reason,
    'The run did not stop within 60s of its time limit, so it ended at once'
  );

  first.finish();
  await run;
}

// The time limit is 5 hours unless set, and the cadence 6 hours, and an invalid setting is replaced
// with its default, with a warning.
for (const [value, seconds, warning] of [
  [undefined, null, false],
  ['', null, false],
  ['7200', 7200, false],
  ['0', null, true],
  ['-5', null, true],
  ['1.5', null, true],
  ['abc', null, true],
  ['9999999999', null, true]
]) {
  for (const [name, defaultSeconds] of [
    ['IMPORTER_MAX_RUN_SECONDS', 18000],
    ['IMPORTER_CADENCE_SECONDS', 21600]
  ]) {
    const env = value === undefined ? {} : { [name]: value };
    const importer = await loadRun({ env });
    let timeLimit;
    await importer.run([
      step('import', async () => {
        timeLimit = Math.max(...[...importer.timers].map((timer) => timer.ms));
      })
    ]);
    const expected = seconds ?? defaultSeconds;
    const start = importer.events.find((event) => event.startsWith('verbose Starting'));
    if (name === 'IMPORTER_MAX_RUN_SECONDS') {
      assert.strictEqual(timeLimit, expected * 1000, `Time limit for ${JSON.stringify(value)}`);
      assert.ok(start.includes(`time limit ${expected}s,`));
    } else {
      assert.ok(start.includes(`cadence ${expected}s)`), `Cadence for ${JSON.stringify(value)}`);
    }
    assert.strictEqual(
      importer.output.some((line) => line.startsWith(`Warning: ${name} must be a whole number`)),
      warning
    );
  }
}

// A run that loses its lock, e.g. because MySQL restarted, stops at its next safe point and exits
// 1, as another run may have started. Its record still says why.
{
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, step('export', () => importer.events.push('export'))]);
  await first.started;
  importer.lock.onLost('Connection lost: The server closed the connection.');
  assert.match(importer.important().at(-1), /^The run lost its run lock \(Connection lost/);
  first.finish();

  assert.strictEqual(await run, 1);
  assert.ok(!importer.events.includes('export'));
  assert.strictEqual(
    importer.important().at(-1),
    'The CBL update run stopped before it finished, as it lost its run lock.'
  );
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
  const record = importer.record();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['failed', 1, 'Stopped, as it lost its run lock']
  );
}

// The first reason to stop is the one reported: a run that lost its lock and then received SIGTERM
// still failed.
{
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, step('export', () => importer.events.push('export'))]);
  await first.started;
  importer.lock.onLost('Connection lost');
  importer.process.emit('SIGTERM', 'SIGTERM');
  first.finish();
  assert.strictEqual(await run, 1);
  assert.match(importer.important().at(-1), /as it lost its run lock\.$/);
}

// Steps that delete or export bans check the lock first, and end the run with exit code 1 if it is
// no longer held.
{
  const importer = await loadRun();
  const run = importer.run([
    step('export', async () => {
      importer.lock.held = false;
      await importer.control.checkRunLock();
      importer.events.push('export');
    })
  ]);
  assert.strictEqual(await run, 1);
  assert.ok(!importer.events.includes('export'));
  assert.ok(importer.lock.released);
}

// While the run still holds the lock, the steps that check it carry on, as the run gives them the
// lock it took.
{
  const importer = await loadRun();
  const run = importer.run([
    step('export', async () => {
      await importer.control.checkRunLock();
      importer.events.push('export');
    })
  ]);
  assert.strictEqual(await run, 0);
  assert.ok(importer.events.includes('export'));
}

console.log(
  'Importer run checks passed: exit codes, the run lock, signals, the time limit, the database wait, migrations, the run record, the end within 45 seconds, a run left waiting, staleness and posted lines.'
);
