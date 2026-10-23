import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise the importer service, the importer in loop mode, without a database, Discord, a real
// health server or real signals: its cycles, their stop points, records and JSON lines, its time
// limits, its health and what it posts to the log channel in each IMPORTER_LOOP_DISCORD mode. The
// steps and migrations are stand-ins, and the run machinery is the real one (run.js, the run
// record, run-control.js and the drawings), on a clock that only moves when the test moves it.

const START = Date.parse('2026-10-22T14:07:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MB = 1024 * 1024;
const emptyQueue = { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 };

function deferred() {
  let resolve;
  const promise = new Promise((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

// Let promise callbacks run.
const settle = () => new Promise(setImmediate);

// The database is unavailable, e.g. while it restarts.
const unavailable = () => Object.assign(new Error('connect ECONNREFUSED'), { unavailable: true });

// A logged line as the log channel would show it.
const describeLine = (message, extras) => `${message}${extras.map(describeError).join('')}`;

// Values made in the service's context are copied into this one to compare them.
const copy = (value) => JSON.parse(JSON.stringify(value));

// A stand-in for the ImporterState and ImporterSchemaMigrations tables, holding JSON text as the
// database would. A transaction's writes are kept once it commits. Once control.hang is set,
// transactions and writes never end, once control.down is set, transactions fail as they do while
// the database is unavailable, and while control.delay is set, each transaction takes that long,
// on the test's clock (control.sleep). With missing, the tables do not exist until control.missing
// is cleared, as the migrations do.
function fakeState(events, { rows = {}, tablesMadeAt = null, missing = false } = {}) {
  const state = new Map(Object.entries(rows).map(([name, value]) => [name, JSON.stringify(value)]));
  const read = (name) => (state.has(name) ? JSON.parse(state.get(name)) : undefined);
  const control = { hang: false, down: false, delay: 0, sleep: null, missing };
  const never = () => new Promise(() => {});
  // MySQL's error for a table that does not exist.
  const noTable = () => {
    if (control.missing)
      throw Object.assign(new Error("Table 'cbl.ImporterState' doesn't exist"), {
        original: { errno: 1146 }
      });
  };

  const ImporterState = {
    async findAll({ where: { name } }) {
      events.push('read state');
      noTable();
      return [...name]
        .filter((key) => state.has(key))
        .map((key) => ({ name: key, value: read(key) }));
    },
    async findByPk(name) {
      noTable();
      return state.has(name) ? { name, value: read(name) } : null;
    },
    // A write outside a transaction is kept at once.
    async upsert({ name, value }, { transaction } = {}) {
      noTable();
      if (transaction) transaction.writes.push([name, JSON.stringify(value)]);
      else {
        if (control.hang) return never();
        events.push(`save ${name}`);
        state.set(name, JSON.stringify(value));
      }
    }
  };
  const ImporterSchemaMigration = { min: async () => tablesMadeAt };
  const transaction = async (work) => {
    events.push('transaction');
    if (control.hang) return never();
    if (control.down) throw unavailable();
    if (control.delay > 0) await control.sleep(control.delay);
    const current = { LOCK: { UPDATE: 'UPDATE' }, writes: [] };
    const result = await work(current);
    for (const [name, value] of current.writes) state.set(name, value);
    events.push('commit');
    return result;
  };
  return { state, read, control, ImporterState, ImporterSchemaMigration, transaction };
}

// A stand-in for the logger's status message, which records the options it was made with, how
// often it was updated, and its final payload, and draws its latest payload when the test asks.
// Its final edit is sent at once, unless the test sets finalEdit, e.g. to a function that finds
// the message deleted and posts it again, which sent() then waits for.
function fakeStatus(events, payload, options) {
  const status = {
    stopped: false,
    options,
    latest: payload,
    updates: 0,
    final: null,
    finalEdit: null,
    sending: Promise.resolve(),
    update(next) {
      if (status.final) return;
      status.updates++;
      status.latest = next;
    },
    finish(next) {
      events.push('status finish');
      status.final = next;
      if (status.finalEdit) status.sending = status.finalEdit(options);
    },
    sent() {
      events.push('status sent');
      return status.sending;
    },
    // The embed the message shows now: its final one, or else its latest payload, drawn.
    embed() {
      const shown = status.final ?? status.latest;
      return copy((typeof shown === 'function' ? shown() : shown).embeds[0]);
    }
  };
  // The logger draws a status message's first payload when it is made: this is its embed.
  status.first = copy((typeof payload === 'function' ? payload() : payload).embeds[0]);
  events.push(`status post${options.messageID ? ` ${options.messageID}` : ''}`);
  return status;
}

// Load loop.js, with the real run.js, run record, run-control.js and drawings, and stand-ins for
// the database, the importer's locks, the migrations, the logger, the BattleMetrics client's count
// of its requests, the health server's http and the process. lockAnswers are what each attempt to
// take the service lock finds, in turn, the last one again and again: 'free', 'busy', 'hang', when
// MySQL never answers, or an error it fails with, and runLockAnswers what each cycle's attempts to
// take the run lock find: 'free' or 'busy'. With discordLog, Discord logging is on. Once
// logQueue.stuck is set, the log queue never empties, as when Discord does not answer.
async function loadLoop({
  env = {},
  authenticate = async () => {},
  lockAnswers = ['free'],
  runLockAnswers = ['free'],
  migrations = { applied: [], unknown: [] },
  state: stateOptions = {},
  discordLog = true
} = {}) {
  const events = [];
  const output = [];
  const discord = [];
  const posts = [];
  const statuses = [];
  const revisions = [];
  const timers = new Set();
  const bm = { requests: 0 };
  let now = START;
  const state = fakeState(events, stateOptions);
  const answers = [...lockAnswers];
  const runAnswers = [...runLockAnswers];
  const logQueue = { stuck: false };

  class FakeDate extends Date {
    static now() {
      return now;
    }
  }

  // The importer's locks, once taken: the service lock, held until they are released, and the run
  // lock, which each cycle takes with beginCycle() and frees with endCycle() (runHeld). runTakes
  // and runFrees count them, and held set to false makes MySQL say they are no longer held.
  const lock = {
    held: true,
    runHeld: false,
    runTakes: 0,
    runFrees: 0,
    released: false,
    destroyed: false,
    onLost: null,
    async isHeld() {
      return this.held;
    },
    async beginCycle() {
      if (this.released || this.destroyed) return false;
      if (this.runHeld) return true;
      events.push('begin cycle');
      const answer = runAnswers.length > 1 ? runAnswers.shift() : runAnswers[0];
      if (answer === 'busy') return false;
      this.runHeld = true;
      this.runTakes++;
      return true;
    },
    async endCycle() {
      if (!this.runHeld) return;
      events.push('end cycle');
      this.runHeld = false;
      this.runFrees++;
    },
    async release() {
      events.push('release');
      this.released = true;
      this.releasedAt = now;
      this.runHeld = false;
    },
    destroy() {
      events.push('destroy');
      this.destroyed = true;
      this.runHeld = false;
    }
  };

  const fakeProcess = new EventEmitter();
  fakeProcess.env = env;
  fakeProcess.exitCode = undefined;
  fakeProcess.exits = [];
  fakeProcess.exit = (code) => {
    events.push(`exit ${code}`);
    fakeProcess.exits.push(code);
  };
  fakeProcess.memoryUsage = () => ({
    rss: 150 * MB,
    heapTotal: 80 * MB,
    heapUsed: 52.5 * MB,
    external: 3 * MB
  });

  // The health server's http: the test asks it as Docker's health check would.
  const server = {
    handler: null,
    address: null,
    closed: false,
    on: () => server,
    listen(port, host) {
      server.address = { port, host };
      return server;
    },
    close() {
      server.closed = true;
    }
  };

  const Logger = {
    discordWebhook: discordLog ? 'https://discord.com/api/webhooks/1/secret-token' : null,
    channelLines: 0,
    verbose(module, verboseness, message, ...extras) {
      const text = describeLine(message, extras);
      events.push(`verbose ${text}`);
      if (verboseness === 1) {
        this.channelLines++;
        discord.push(text);
      }
    },
    important(module, message, ...extras) {
      const text = describeLine(message, extras);
      events.push(`important ${text}`);
      this.channelLines++;
      discord.push(text);
    },
    flush: () => events.push('flush'),
    getLogQueue: () => (logQueue.stuck ? { ...emptyQueue, QUEUED: 1 } : emptyQueue),
    statusMessage(payload, options) {
      if (!discordLog)
        return { stopped: true, posted: Promise.resolve(null), update() {}, finish() {} };
      const status = fakeStatus(events, payload, options);
      statuses.push(status);
      return status;
    },
    post(payload) {
      if (!discordLog) return;
      events.push(`post ${payload.embeds[0].title}`);
      posts.push({ at: now, embed: copy(payload.embeds[0]) });
    },
    reviseMessage(messageID, revise) {
      events.push(`revise ${messageID}`);
      revisions.push({ messageID, revise });
    }
  };

  const dependencies = {
    http: { default: { createServer: (handler) => Object.assign(server, { handler }) } },
    'scbl-lib/apis': { battlemetricsRequestCount: () => bm.requests },
    'scbl-lib/db': {
      connect: async () => events.push('connect'),
      disconnect: async () => events.push('disconnect'),
      sequelize: {
        authenticate: async () => {
          events.push('authenticate');
          return authenticate(now);
        },
        transaction: state.transaction
      },
      // run.js takes both locks for a run in once mode, which the service never does.
      takeRunLock: async () => assert.fail('The service took the locks of a run in once mode'),
      takeServiceLock: async ({ onLost }) => {
        events.push('takeServiceLock');
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        if (answer instanceof Error) throw answer;
        if (answer === 'busy') return { busy: 'service' };
        if (answer === 'hang') return new Promise(() => {});
        lock.onLost = onLost;
        return lock;
      }
    },
    'scbl-lib/db/importer-models': {
      ImporterSchemaMigration: state.ImporterSchemaMigration,
      ImporterState: state.ImporterState
    },
    'scbl-lib/db/sequelize': { isDatabaseUnavailable: (err) => err.unavailable === true },
    'scbl-lib/utils': { describeError, Logger },
    './schema/migrate.js': {
      default: async (options) => {
        events.push('migrate');
        // The migrations make the importer's tables, if they were not there.
        state.control.missing = false;
        if (typeof migrations === 'function') return migrations(options);
        for (const id of migrations.applied) options.onApplied(id);
        return migrations;
      }
    }
  };

  const setTimeout = (callback, ms) => {
    const timer = { at: now + ms, ms, callback, unrefed: false };
    timer.unref = () => Object.assign(timer, { unrefed: true });
    timers.add(timer);
    return timer;
  };
  state.control.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess,
    Date: FakeDate,
    setTimeout,
    clearTimeout: (timer) => timers.delete(timer)
  });

  // The service's own modules, each loaded once, as several import the same ones.
  const OWN = [
    './loop.js',
    './health-check-server.js',
    './run.js',
    './run-control.js',
    './run-record.js',
    './run-status.js',
    './service-status.js'
  ];
  const modules = new Map();
  const load = async (specifier) => {
    if (!modules.has(specifier)) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      modules.set(
        specifier,
        new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href })
      );
    }
    return modules.get(specifier);
  };
  const module = await load('./loop.js');
  await module.link(async (specifier) => {
    const exports = dependencies[specifier];
    if (exports)
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    assert.ok(OWN.includes(specifier), `Unexpected dependency: ${specifier}`);
    return load(specifier);
  });
  await module.evaluate();

  const isRecord = (line) => line.startsWith('{"event":"cbl-importer-run"');
  const service = {
    runLoop: module.namespace.default,
    readMode: module.namespace.readMode,
    readDiscordMode: module.namespace.readDiscordMode,
    memoryOf: module.namespace.memoryOf,
    run: (await load('./run.js')).namespace,
    control: (await load('./run-control.js')).namespace,
    lock,
    events,
    output,
    discord,
    posts,
    statuses,
    revisions,
    state,
    timers,
    server,
    bm,
    logQueue,
    process: fakeProcess,
    Logger,
    now: () => now,
    // The JSON lines with the cycles' records.
    records: () => output.filter(isRecord).map((line) => JSON.parse(line)),
    // The console's lines other than the records'.
    printed: () => output.filter((line) => !isRecord(line)),
    // The lines logged as important.
    important: () =>
      events.filter((event) => event.startsWith('important ')).map((event) => event.slice(10)),
    // Ask the health server, as the Docker health check does.
    health() {
      const res = {
        writeHead(status, headers) {
          Object.assign(res, { status, headers });
        },
        end(body) {
          res.body = body;
        }
      };
      server.handler({}, res);
      return { status: res.status, ...JSON.parse(res.body) };
    },
    // Wait ms milliseconds on the clock, for a step.
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    // Let the service get on, moving the clock on to each timer it waits for in turn, until the
    // condition holds, and no later than until.
    async runUntil(condition, what, until = Infinity) {
      for (let turn = 0; ; turn++) {
        for (let i = 0; i < 3; i++) await settle();
        if (condition()) return;
        assert.ok(turn < 20000, `Timed out waiting for ${what}`);
        const [next] = [...timers].sort((a, b) => a.at - b.at);
        assert.ok(next, `Nothing is left to wait for, waiting for ${what}`);
        if (next.at > until) {
          this.advance(until - now);
          for (let i = 0; i < 3; i++) await settle();
          return;
        }
        this.advance(next.at - now);
      }
    },
    // Move the clock on to the time given, letting the service get on as it goes.
    runTo(at) {
      return this.runUntil(() => now >= at, `the clock to reach ${at}`, at);
    },
    // Start the service with the steps, and note how it ended.
    start(steps) {
      service.result = null;
      const running = service.runLoop(steps);
      running.then((code) => {
        service.result = code;
      });
      return running;
    },
    // Let the service run until it has ended, and resolve with its exit code.
    async finish(running) {
      let ended = false;
      running.then(() => (ended = true));
      await service.runUntil(() => ended, 'the service to end');
      return running;
    }
  };
  return service;
}

// A step of a cycle, as index.js gives them.
const step = (name, run, counts) => ({ name, run, counts });

// The import's counts, as BanImporter.report() gives them, with what is given.
const importCounts = (counts = {}) => ({
  lists: 2,
  imported: 2,
  fetched: 200,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  pending: 0,
  moves: 0,
  failedLists: 0,
  headPolls: 2,
  fullReads: 0,
  requests: { head: 2, follow: 0, full: 0 },
  banLists: [
    { id: 1, fetched: 100, new: 0, updated: 0, removed: 0, held: 0, read: 'head' },
    { id: 2, fetched: 100, new: 0, updated: 0, removed: 0, held: 0, read: 'head' }
  ],
  ...counts
});

// Cycles start a cycle apart, from the start of one to the start of the next: every
// IMPORTER_CYCLE_SECONDS, here 10 minutes, however long each takes. Each runs every step, given
// the cadence, which is the cycle unless IMPORTER_CADENCE_SECONDS is set, and prints its record as
// a JSON line, with its number and the process's memory, which is saved as a run's is. The service
// takes the service lock once, and keeps it. Each cycle takes the run lock as it starts and frees
// it once its record is saved, so between cycles the service holds only the service lock, and the
// bot's commands that must not overlap a run work. Only the first cycle connects and applies the
// migrations. SIGTERM between cycles ends the service at once, with exit code 0: it shows that it
// stopped in its status message, closes the database connections, sends its log messages and
// releases the locks. Its signal handlers, timers and health server are gone once it has ended.
{
  const service = await loadLoop({
    env: { GIT_SHA: 'abc1234', IMPORTER_CYCLE_SECONDS: '600' }
  });
  const starts = [];
  const given = [];
  const runLockHeld = [];
  const running = service.start([
    step('importBans', async (settings) => {
      starts.push((service.now() - START) / SECOND);
      given.push({ ...settings });
      runLockHeld.push(service.lock.runHeld);
      await service.wait(30 * SECOND);
    }),
    step('exportExportBans', () => service.wait(10 * SECOND))
  ]);
  await service.runUntil(() => service.records().length === 3, 'three cycles');
  assert.deepStrictEqual(starts, [0, 600, 1200]);
  assert.deepStrictEqual(runLockHeld, [true, true, true]);
  await service.runTo(service.now() + MINUTE);
  assert.deepStrictEqual(
    [service.lock.runTakes, service.lock.runFrees, service.lock.runHeld],
    [3, 3, false]
  );
  assert.deepStrictEqual(given, [
    { cadenceSeconds: 600 },
    { cadenceSeconds: 600 },
    { cadenceSeconds: 600 }
  ]);
  const records = service.records();
  assert.deepStrictEqual(
    records.map(({ cycle, outcome, exitCode, seconds }) => [cycle, outcome, exitCode, seconds]),
    [
      [1, 'finished', 0, 40],
      [2, 'finished', 0, 40],
      [3, 'finished', 0, 40]
    ]
  );
  assert.deepStrictEqual(Object.keys(records[0].phases), [
    'waitForDatabase',
    'takeRunLock',
    'connect',
    'migrate',
    'importBans',
    'exportExportBans'
  ]);
  assert.deepStrictEqual(Object.keys(records[1].phases), [
    'waitForDatabase',
    'takeRunLock',
    'importBans',
    'exportExportBans'
  ]);
  assert.deepStrictEqual(records[2], {
    event: 'cbl-importer-run',
    outcome: 'finished',
    exitCode: 0,
    startedAt: '2026-10-22T14:27:00.000Z',
    endedAt: '2026-10-22T14:27:40.000Z',
    seconds: 40,
    gitSha: 'abc1234',
    cycle: 3,
    phases: { waitForDatabase: 0, takeRunLock: 0, importBans: 30, exportExportBans: 10 },
    counts: {},
    memory: { rssMB: 150, heapUsedMB: 52.5, heapTotalMB: 80, externalMB: 3 }
  });
  // Each cycle's record is saved as a run's is.
  assert.deepStrictEqual(service.state.read('lastRun'), records[2]);
  assert.deepStrictEqual(
    service.state.read('recentRuns').map(({ cycle }) => cycle),
    [1, 2, 3]
  );
  assert.strictEqual(service.state.read('lastSuccessAt'), records[2].startedAt);
  for (const once of ['takeServiceLock', 'connect', 'migrate'])
    assert.strictEqual(service.events.filter((event) => event === once).length, 1, once);
  assert.strictEqual(service.events.filter((event) => event === 'authenticate').length, 3);
  assert.ok(service.printed().includes('Finished CBL update cycle 2 in 40.00s.'));
  assert.ok(
    service.events.includes(
      'verbose Starting CBL update cycle 1 (commit abc1234, time limit 900s, cadence 600s)...'
    )
  );
  // While it goes, it keeps its signal handlers once, however many cycles it runs.
  assert.strictEqual(service.process.listenerCount('SIGTERM'), 1);
  assert.strictEqual(service.process.listenerCount('SIGINT'), 1);
  assert.deepStrictEqual(service.server.address, { port: 3001, host: '127.0.0.1' });

  // SIGTERM while it waits for the next cycle.
  await service.runTo(START + 25 * MINUTE);
  const stoppedAt = service.now();
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  assert.strictEqual(service.now(), stoppedAt);
  assert.strictEqual(service.records().length, 3);
  assert.deepStrictEqual(service.events.slice(-6), [
    'status finish',
    'save importerService',
    'status sent',
    'disconnect',
    'flush',
    'release'
  ]);
  assert.deepStrictEqual(service.important(), [
    'Received SIGTERM, so the importer service will stop at its next safe point. Send it again to stop at once.'
  ]);
  const final = service.statuses[0].embed();
  assert.strictEqual(final.title, 'CBL importer service stopped');
  assert.match(final.description, /\*\*Stopped\*\* <t:\d+:f>, as it received SIGTERM\.$/);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: null,
    startedAt: '2026-10-22T14:07:00.000Z',
    endedAt: new Date(stoppedAt).toISOString(),
    outcome: 'stopped'
  });
  assert.ok(service.lock.released);
  assert.ok(service.server.closed);
  assert.strictEqual(service.process.listenerCount('SIGTERM'), 0);
  assert.strictEqual(service.process.listenerCount('SIGINT'), 0);
  assert.strictEqual(service.timers.size, 0);
  assert.strictEqual(service.control.waitingForStop(), 0);
  assert.deepStrictEqual(service.process.exits, []);
}

// A cycle that takes longer than the cycle is followed by the next one at once, and the one after
// that starts a cycle after it: with a cycle of 60 seconds, cycles of 90, 10 and 10 seconds start
// at 0, 90 and 150 seconds. IMPORTER_CADENCE_SECONDS, when set, is the cadence the steps are given.
{
  const service = await loadLoop({
    env: {
      IMPORTER_CYCLE_SECONDS: '60',
      IMPORTER_MAX_CYCLE_SECONDS: '300',
      IMPORTER_CADENCE_SECONDS: '3600'
    }
  });
  const durations = [90, 10, 10];
  const starts = [];
  const given = [];
  const running = service.start([
    step('importBans', async (settings) => {
      starts.push((service.now() - START) / SECOND);
      given.push(settings.cadenceSeconds);
      await service.wait((durations[starts.length - 1] ?? 10) * SECOND);
    })
  ]);
  await service.runUntil(() => service.records().length === 3, 'three cycles');
  assert.deepStrictEqual(starts, [0, 90, 150]);
  assert.deepStrictEqual(given, [3600, 3600, 3600]);
  service.process.emit('SIGINT', 'SIGINT');
  assert.strictEqual(await service.finish(running), 0);
}

// A cycle that takes longer than IMPORTER_MAX_CYCLE_SECONDS stops at its next safe point, as a run
// stops at its time limit, and the next cycle starts at once, as the one that stopped took longer
// than a cycle, and runs as usual: the time limit stopped only its own cycle. The time limit counts
// from when the database answered.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '120' }
  });
  let cycles = 0;
  const running = service.start([
    step('importBans', async () => {
      cycles++;
      for (let item = 0; item < (cycles === 1 ? 30 : 2); item++) {
        service.control.stopIfRequested();
        await service.wait(10 * SECOND);
      }
    }),
    step('exportExportBans', async () => {})
  ]);
  await service.runUntil(() => service.records().length === 2, 'two cycles');
  const [first, second] = service.records();
  assert.deepStrictEqual(
    [first.outcome, first.exitCode, first.phase, first.reason, first.seconds],
    ['interrupted', 3, 'importBans', 'Stopped, as it took longer than 120s', 120]
  );
  assert.deepStrictEqual(
    [second.outcome, second.startedAt, second.seconds],
    ['finished', '2026-10-22T14:09:00.000Z', 20]
  );
  assert.deepStrictEqual(service.important(), [
    'Cycle 1 has taken longer than 120s (IMPORTER_MAX_CYCLE_SECONDS), so it will stop at its next safe point.',
    'The CBL update cycle 1 stopped before it finished, as it took longer than 120s.'
  ]);
  // It stopped in time, so the service does not exit, however long it then runs.
  await service.runTo(START + 10 * MINUTE);
  assert.deepStrictEqual(service.process.exits, []);
  assert.ok(service.records().length > 5);
  assert.ok(
    service
      .records()
      .slice(1)
      .every(({ outcome }) => outcome === 'finished')
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A cycle that has not stopped 60 seconds after its time limit, e.g. as a step is stuck, ends the
// service: its JSON line is printed as failed, the failure is posted and shown in the status
// message, and the process exits 1 once the log messages are sent, closing the lock's connection,
// for Docker to start the service again. Docker never restarts a container that is only unhealthy.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '120' }
  });
  const stuck = deferred();
  const running = service.start([step('importBans', () => stuck.promise)]);
  await service.runTo(START + 120 * SECOND);
  assert.strictEqual(service.control.isStopping(), true);
  await service.runTo(START + 179 * SECOND);
  assert.deepStrictEqual(service.process.exits, []);
  await service.runUntil(() => service.process.exits.length > 0, 'the service to exit');
  assert.strictEqual(service.now(), START + 180 * SECOND);
  assert.deepStrictEqual(service.process.exits, [1]);
  assert.ok(service.lock.destroyed);
  assert.deepStrictEqual(service.events.slice(-6), [
    'status finish',
    'flush',
    'save importerService',
    'status sent',
    'destroy',
    'exit 1'
  ]);
  assert.deepStrictEqual(
    [service.state.read('importerService').outcome, service.state.read('importerService').endedAt],
    ['failed', '2026-10-22T14:10:00.000Z']
  );
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['failed', 1, 'Cycle 1 did not stop within 60s of its time limit, so the importer exited']
  );
  assert.strictEqual(
    service.important().at(-1),
    'Cycle 1 did not stop within 60s of its time limit, so the importer service is exiting, for Docker to start it again.'
  );
  const final = service.statuses[0].embed();
  assert.strictEqual(final.title, 'CBL importer service failed');
  assert.match(
    final.description,
    /as cycle 1 did not stop at its time limit\. Docker restarts it\.$/
  );

  // The test's process.exit() returns, so let the stuck step end. Nothing more is printed or run.
  stuck.resolve();
  assert.strictEqual(await service.finish(running), 1);
  assert.strictEqual(service.records().length, 1);
  assert.deepStrictEqual(service.process.exits, [1]);
}

// SIGTERM during a cycle stops it at its next safe point: the step under way finishes, the next one
// never starts, and the cycle's record says it was interrupted. The service then ends with exit
// code 0, as it was asked to stop. A database that does not answer cannot hold up the end: once it
// is asked, the service releases the lock within 55 seconds, inside docker stop's 60.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  const gate = deferred();
  const running = service.start([
    step('importBans', async () => {
      await gate.promise;
      await service.wait(20 * SECOND);
    }),
    step('exportExportBans', async () => service.events.push('export'))
  ]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  const askedAt = service.now();
  service.process.emit('SIGTERM', 'SIGTERM');
  gate.resolve();
  assert.strictEqual(await service.finish(running), 0);
  assert.ok(!service.events.includes('export'));
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase, record.reason],
    ['interrupted', 3, 'importBans', 'Stopped, as it received SIGTERM']
  );
  assert.deepStrictEqual(service.important(), [
    'Received SIGTERM, so the importer service will stop at its next safe point. Send it again to stop at once.',
    'The CBL update cycle 1 stopped before it finished, as it received SIGTERM.'
  ]);
  // It was saved, and the end followed it in order. The run lock is freed with the service lock.
  const end = service.events.slice(service.events.indexOf('transaction'));
  assert.deepStrictEqual(end, [
    'transaction',
    'commit',
    'status finish',
    'save importerService',
    'status sent',
    'disconnect',
    'flush',
    'release'
  ]);
  assert.strictEqual(service.now() - askedAt, 20 * SECOND);
  assert.deepStrictEqual([service.lock.runFrees, service.lock.runHeld], [0, false]);
}
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  const running = service.start([
    step('importBans', () => service.wait(20 * SECOND)),
    step('exportExportBans', async () => {})
  ]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  // From here on, the database takes every save and never answers.
  const askedAt = service.now();
  service.process.emit('SIGTERM', 'SIGTERM');
  service.state.control.hang = true;
  assert.strictEqual(await service.finish(running), 0);
  assert.ok(service.lock.released);
  assert.ok(service.now() - askedAt <= 55 * SECOND, `${service.now() - askedAt}ms`);
}
// A cycle that reaches its safe point late, here 40 seconds after SIGTERM, leaves its end only the
// time to 55 seconds after the signal, rather than the 45 seconds an end may take, so the locks are
// still released inside docker stop's 60 seconds: against a database that never answers, and
// against Discord not answering, when the log messages are waited for only until then.
for (const what of ['database', 'discord']) {
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  const running = service.start([
    step('importBans', () => service.wait(60 * SECOND)),
    step('exportExportBans', async () => {})
  ]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  await service.runTo(service.now() + 20 * SECOND);
  const askedAt = service.now();
  service.process.emit('SIGTERM', 'SIGTERM');
  if (what === 'database') service.state.control.hang = true;
  else service.logQueue.stuck = true;
  assert.strictEqual(await service.finish(running), 0, what);
  assert.ok(service.lock.released, what);
  const releasedAfter = service.lock.releasedAt - askedAt;
  assert.ok(releasedAfter <= 55 * SECOND, `${what}: released ${releasedAfter}ms after SIGTERM`);
  // The end began 40 seconds after the signal, and left the last 5 seconds to release the locks.
  assert.strictEqual(releasedAfter, 50 * SECOND, what);
  assert.strictEqual(service.records()[0].seconds, 60, what);
}

// A cycle that has not reached a safe point 45 seconds after SIGTERM, e.g. as a BattleMetrics
// request waits out a pause the API asked for, or is tried again, is ended there, so docker stop
// never has to kill the service: its JSON line says it was interrupted, and why, and in at most 5
// more seconds its record is saved, its status message shows that the service stopped, the
// service's row says so, and the log messages are sent. Then the locks' connection is closed, and
// the service exits 0, as it was asked to stop. Nothing more is saved or posted if the step ends
// after all.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '120' }
  });
  const running = service.start([
    step('importBans', () => service.wait(150 * SECOND)),
    step('exportExportBans', async () => service.events.push('export'))
  ]);
  await service.runTo(START + 20 * SECOND);
  service.process.emit('SIGTERM', 'SIGTERM');
  await service.runTo(START + 64 * SECOND);
  assert.deepStrictEqual(service.process.exits, []);
  await service.runUntil(() => service.process.exits.length > 0, 'the service to exit');
  assert.deepStrictEqual([service.process.exits, service.now()], [[0], START + 65 * SECOND]);
  assert.ok(service.lock.destroyed);
  const why = 'Cycle 1 did not reach a safe point within 45s of SIGTERM';
  assert.deepStrictEqual(service.important(), [
    'Received SIGTERM, so the importer service will stop at its next safe point. Send it again to stop at once.',
    `${why}, so the importer service is ending it there, and stopping now.`
  ]);
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.phase, record.reason, record.seconds],
    ['interrupted', 3, 'importBans', `${why}, so it ended there`, 65]
  );
  assert.deepStrictEqual(service.state.read('lastRun'), record);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: null,
    startedAt: '2026-10-22T14:07:00.000Z',
    endedAt: new Date(START + 65 * SECOND).toISOString(),
    outcome: 'stopped'
  });
  const final = service.statuses[0].embed();
  assert.strictEqual(final.title, 'CBL importer service stopped');
  assert.match(final.description, /\*\*Stopped\*\* <t:\d+:f>, as it received SIGTERM\.$/);
  const saved = service.events.length;
  // The test's process.exit() returns: the step ends after all, but nothing more is saved.
  assert.strictEqual(await service.finish(running), 0);
  assert.deepStrictEqual(
    service.events.slice(saved).filter((event) => /^(save |transaction|post )/.test(event)),
    []
  );
  assert.strictEqual(service.records().length, 1);
  assert.ok(!service.events.includes('export'));
}
// A time limit that comes first does not change that: the cycle is ended 45 seconds after SIGTERM,
// before the time limit's hard exit, and the service stopped.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '120' }
  });
  const stuck = deferred();
  const running = service.start([step('importBans', () => stuck.promise)]);
  await service.runTo(START + 130 * SECOND);
  assert.strictEqual(service.control.isStopping(), true);
  service.process.emit('SIGTERM', 'SIGTERM');
  await service.runUntil(() => service.process.exits.length > 0, 'the service to exit');
  assert.deepStrictEqual([service.process.exits, service.now()], [[0], START + 175 * SECOND]);
  assert.strictEqual(service.state.read('importerService').outcome, 'stopped');
  // The hard exit that was due at 180 seconds does nothing more.
  service.advance(START + 200 * SECOND - service.now());
  for (let i = 0; i < 3; i++) await settle();
  assert.deepStrictEqual(service.process.exits, [0]);
  stuck.resolve();
  assert.strictEqual(await service.finish(running), 0);
}
// A cycle whose time limit's hard exit comes before that, as SIGTERM came 30 seconds after the time
// limit, failed: its status message, its row, its record and its exit code all say so. It is not
// said that Docker starts it again, as Docker does not start again a service that docker stop
// stopped.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '120' }
  });
  const stuck = deferred();
  const running = service.start([step('importBans', () => stuck.promise)]);
  await service.runTo(START + 150 * SECOND);
  service.process.emit('SIGTERM', 'SIGTERM');
  await service.runUntil(() => service.process.exits.length > 0, 'the service to exit');
  assert.deepStrictEqual([service.process.exits, service.now()], [[1], START + 180 * SECOND]);
  assert.strictEqual(
    service.important().at(-1),
    'Cycle 1 did not stop within 60s of its time limit, so the importer service is exiting.'
  );
  const final = service.statuses[0].embed();
  assert.strictEqual(final.title, 'CBL importer service failed');
  assert.match(
    final.description,
    /\*\*Failed\*\* <t:\d+:f>, as cycle 1 did not stop at its time limit\.$/
  );
  assert.strictEqual(service.state.read('importerService').outcome, 'failed');
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['failed', 1, 'Cycle 1 did not stop within 60s of its time limit, so the importer exited']
  );
  // The stop's deadline, due at 195 seconds, does nothing more.
  service.advance(START + 200 * SECOND - service.now());
  for (let i = 0; i < 3; i++) await settle();
  assert.deepStrictEqual(service.process.exits, [1]);
  stuck.resolve();
  await service.finish(running);
}
// A service that is not yet holding the service lock, as MySQL does not answer it, exits 45 seconds
// after SIGTERM too.
{
  const service = await loadLoop({ lockAnswers: ['hang'] });
  service.start([step('importBans', () => service.events.push('import'))]);
  for (let i = 0; i < 3; i++) await settle();
  service.advance(10 * SECOND);
  service.process.emit('SIGTERM', 'SIGTERM');
  await service.runTo(START + 54 * SECOND);
  assert.deepStrictEqual(service.process.exits, []);
  await service.runTo(START + 55 * SECOND);
  assert.deepStrictEqual(service.process.exits, [0]);
  assert.strictEqual(
    service.printed().at(-1),
    'The importer service stopped before it took the service lock, as it received SIGTERM.'
  );
  assert.ok(!service.events.includes('import'));
}
// The 55 seconds count from the signal: a service that stops for another reason, as it lost its
// locks, gives its end its usual time, which nothing cuts short, also when its cycle reaches its
// safe point a minute later. Here each save takes a second.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const running = service.start([
    step('importBans', () => service.wait(90 * SECOND)),
    step('exportExportBans', async () => service.events.push('export'))
  ]);
  await service.runTo(START + 20 * SECOND);
  service.state.control.delay = SECOND;
  service.lock.onLost('Connection lost');
  assert.strictEqual(await service.finish(running), 1);
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.reason, record.seconds],
    ['failed', 'Stopped, as it lost its locks', 90]
  );
  assert.deepStrictEqual(service.state.read('lastRun'), record);
  assert.ok(!service.printed().some((line) => line.startsWith('Warning: could not save')));
  assert.deepStrictEqual(service.process.exits, []);
}

// A second signal ends the service at once, closing the lock's connection: the cycle under way
// prints its record, as the only one, with exit code 3, but there is no time to save it.
{
  const service = await loadLoop();
  const gate = deferred();
  const running = service.start([step('importBans', () => gate.promise)]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(service.process.exits, []);
  service.process.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(service.process.exits, [3]);
  assert.ok(service.lock.destroyed);
  assert.match(
    service.printed().at(-1),
    /^Received SIGINT again, so the importer service is ending now/
  );
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['interrupted', 3, 'Received SIGINT again, so it ended at once']
  );
  gate.resolve();
  await service.finish(running);
  assert.strictEqual(service.records().length, 1);
}

// A service that loses its locks, e.g. as MySQL restarted, stops at its next safe point and exits
// 1, as another run may have taken them, for Docker to start it again: during a cycle, which fails,
// between cycles, at once, without another cycle, and when a cycle finds at its start that it no
// longer holds them, or that their connection is gone as it takes the run lock. Between cycles it
// holds only the service lock, so it says it lost its locks, not the run lock.
{
  const service = await loadLoop();
  const gate = deferred();
  const running = service.start([
    step('importBans', () => gate.promise),
    step('exportExportBans', async () => service.events.push('export'))
  ]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  service.lock.onLost('Connection lost: The server closed the connection.');
  gate.resolve();
  assert.strictEqual(await service.finish(running), 1);
  assert.ok(!service.events.includes('export'));
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.exitCode, record.reason],
    ['failed', 1, 'Stopped, as it lost its locks']
  );
  assert.deepStrictEqual(service.important(), [
    'The importer service lost its locks (Connection lost: The server closed the connection.), so it will stop at its next safe point and exit, for Docker to start it again.',
    'The CBL update cycle 1 stopped before it finished, as it lost its locks.'
  ]);
  const final = service.statuses[0].embed();
  assert.strictEqual(final.title, 'CBL importer service failed');
  assert.match(final.description, /as it lost its locks\. Docker restarts it\.$/);
  assert.strictEqual(service.state.read('importerService').outcome, 'failed');
}
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const running = service.start([step('importBans', () => service.wait(30 * SECOND))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  await service.runTo(START + 5 * MINUTE);
  assert.strictEqual(service.lock.runHeld, false);
  service.lock.onLost('Connection lost');
  assert.strictEqual(await service.finish(running), 1);
  assert.strictEqual(service.now(), START + 5 * MINUTE);
  assert.strictEqual(service.records().length, 1);
  assert.strictEqual(
    service.important().at(-1),
    'The importer service lost its locks (Connection lost), so it will stop at its next safe point and exit, for Docker to start it again.'
  );
  assert.match(service.statuses[0].embed().description, /as it lost its locks\. Docker restarts/);
}
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  service.lock.held = false;
  assert.strictEqual(await service.finish(running), 1);
  const second = service.records()[1];
  assert.deepStrictEqual(
    [second.outcome, second.phase, second.reason],
    ['failed', 'takeRunLock', 'Stopped, as it lost its locks']
  );
  assert.strictEqual(service.events.filter((event) => event === 'import').length, 1);
}
{
  // The connection went while the service waited between cycles, which the next cycle finds as it
  // takes the run lock.
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  service.lock.beginCycle = async () => {
    service.lock.onLost('Error: The client was disconnected by the server because of inactivity.');
    return false;
  };
  assert.strictEqual(await service.finish(running), 1);
  const second = service.records()[1];
  assert.deepStrictEqual(
    [second.outcome, second.phase, second.reason],
    ['failed', 'takeRunLock', 'Stopped, as it lost its locks']
  );
  assert.match(
    service.important().at(-2),
    /^The importer service lost its locks \(Error: The client/
  );
}

// The database being unavailable between cycles does not end the service: the next cycle waits
// for it, trying again after 5, 10, 20 and 40 seconds and then every minute, for as long as it
// takes, and runs once it answers. Its record shows how long it waited. While it waits, it is
// healthy for 10 minutes, or for as long as the last cycle ended within two cycles and the time
// limit.
{
  let downFrom = Infinity;
  let downUntil = Infinity;
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '60' },
    authenticate: async (at) => {
      if (at >= downFrom && at < downUntil) throw unavailable();
    }
  });
  const running = service.start([step('importBans', () => service.wait(5 * SECOND))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  assert.deepStrictEqual(
    [service.health().status, service.health().healthy, service.health().reason],
    [200, true, 'cycle 1 ended 0 minutes ago']
  );
  downFrom = START + 60 * SECOND;
  downUntil = START + 12 * MINUTE;
  // At first the last cycle, which ended within 3 minutes, keeps it healthy, then its wait.
  await service.runTo(START + 3 * MINUTE);
  let health = service.health();
  assert.deepStrictEqual(
    [health.status, health.waitingFor, health.reason],
    [200, 'database', 'cycle 1 ended 2 minutes ago']
  );
  await service.runTo(START + 4 * MINUTE);
  health = service.health();
  assert.deepStrictEqual(
    [health.status, health.waitingFor, health.reason],
    [200, 'database', 'it has been waiting for the database for 3 minutes']
  );
  assert.strictEqual(health.waitingSince, '2026-10-22T14:08:00.000Z');
  await service.runTo(START + 11 * MINUTE);
  health = service.health();
  assert.deepStrictEqual(
    [health.status, health.healthy, health.reason],
    [
      503,
      false,
      'no cycle has ended for 10 minutes, more than the 3 minutes allowed, and it has been waiting for the database for 10 minutes'
    ]
  );
  assert.deepStrictEqual(service.process.exits, []);
  assert.strictEqual(service.records().length, 1);
  await service.runUntil(() => service.records().length === 2, 'the second cycle');
  // It tried at 1, 1:05, 1:15, 1:35, 2:15 and then every minute, until 12:15.
  const second = service.records()[1];
  assert.deepStrictEqual([second.outcome, second.phases.waitForDatabase], ['finished', 675]);
  assert.deepStrictEqual(
    service
      .printed()
      .filter((line) => line.startsWith('The database is not available'))
      .slice(0, 6),
    [5, 10, 20, 40, 60, 60].map(
      (delay, index) =>
        `The database is not available (Error: connect ECONNREFUSED). Trying again in ${delay}s (retry ${index + 1}).`
    )
  );
  assert.strictEqual(service.health().status, 200);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}
{
  // SIGTERM while a cycle waits for the database stops it there.
  const service = await loadLoop({
    authenticate: async () => {
      throw unavailable();
    }
  });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runTo(START + 30 * SECOND);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.phase, record.reason],
    ['interrupted', 'waitForDatabase', 'Stopped, as it received SIGTERM']
  );
  assert.ok(!service.events.includes('import'));
}

// While another run holds the service lock, e.g. one started by hand, the service stands by, trying
// again every 15 seconds, and says so in the console. It posts nothing meanwhile, but checks once a
// cadence whether the importer is stale, as a skipped start does, and it is healthy for its first
// 10 minutes of waiting. Once it takes the lock, it starts its first cycle.
{
  const rows = {
    lastSuccessAt: new Date(START - 2 * HOUR).toISOString(),
    lastRun: { endedAt: '2026-10-22T12:10:00.000Z', exitCode: 1, reason: 'Error: Lost' }
  };
  const busy = Array.from({ length: 50 }, () => 'busy');
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '600' },
    lockAnswers: [...busy, 'free'],
    state: { rows }
  });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runTo(START + 9 * MINUTE);
  let health = service.health();
  assert.deepStrictEqual(
    [health.status, health.holdsLock, health.waitingFor, health.reason],
    [200, false, 'lock', 'it has been waiting for another run to end for 9 minutes']
  );
  assert.deepStrictEqual(service.discord, [
    'The CBL update is stale: no run has succeeded for 2.0 hours, since the one that started at 2026-10-22T12:07:00.000Z. The importer service starts a cycle every 10 minutes (IMPORTER_CADENCE_SECONDS, or else IMPORTER_CYCLE_SECONDS), so 3 or more in a row have not succeeded. The last run ended at 2026-10-22T12:10:00.000Z with exit code 1 (Error: Lost). The importer service is standing by, as another run holds the service lock.'
  ]);
  assert.deepStrictEqual(service.printed(), [
    'Another run holds the service lock, so the importer service stands by, trying again every 15s.',
    'Another run holds the service lock, so the importer service stands by, trying again every 15s.'
  ]);
  assert.deepStrictEqual(service.statuses, []);
  await service.runTo(START + 11 * MINUTE);
  health = service.health();
  assert.deepStrictEqual(
    [health.status, health.reason],
    [
      503,
      'it has been waiting for another run to end for 11 minutes, more than the 10 minutes allowed'
    ]
  );
  // The stale alert is posted at most once a cadence.
  assert.strictEqual(service.discord.length, 2);
  await service.runUntil(() => service.events.includes('import'), 'the first cycle');
  assert.strictEqual(service.events.filter((event) => event === 'takeServiceLock').length, 51);
  assert.strictEqual(service.now(), START + 50 * 15 * SECOND);
  assert.strictEqual(service.health().status, 200);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}
{
  // SIGTERM while it stands by ends it at once, with exit code 0, without trying again or posting.
  const service = await loadLoop({ lockAnswers: ['busy'] });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runTo(START + 40 * SECOND);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  assert.strictEqual(service.events.filter((event) => event === 'takeServiceLock').length, 3);
  assert.deepStrictEqual(service.discord, []);
  assert.deepStrictEqual(service.records(), []);
  assert.ok(!service.events.includes('release'));
  assert.match(
    service.printed().at(-1),
    /stopped before it took the service lock, as it received SIGTERM/
  );
}
{
  // A database that cannot be reached to take the lock is waited for in the same way.
  const unreachable = () =>
    new Error(
      'Could not connect to the database to take the service lock: Error: connect ECONNREFUSED'
    );
  const service = await loadLoop({ lockAnswers: [unreachable(), unreachable(), 'free'] });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runTo(START + 20 * SECOND);
  assert.deepStrictEqual([service.health().waitingFor, service.health().status], ['database', 200]);
  await service.runUntil(() => service.events.includes('import'), 'the first cycle');
  assert.strictEqual(service.now(), START + 30 * SECOND);
  assert.match(
    service.printed()[0],
    /^The importer service could not take the service lock \(Error: Could not connect/
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// The health server says whether the service is healthy, as JSON: while it holds the service lock,
// as long as a cycle ended within two cycles and the time limit, here 2 × 10 + 15 = 35 minutes, or,
// before its first cycle ends, it took the lock within that time. It gives what the service posts
// to Discord, or off when it posts nothing, and the process's memory too.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const stuck = deferred();
  let cycles = 0;
  const running = service.start([
    step('importBans', async () => {
      cycles++;
      if (cycles === 2) await stuck.promise;
    })
  ]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  const health = service.health();
  assert.deepStrictEqual(health, {
    status: 200,
    healthy: true,
    reason: 'cycle 1 ended 0 minutes ago',
    holdsLock: true,
    cycles: 1,
    cycle: null,
    lastCycle: { cycle: 1, outcome: 'finished', endedAt: '2026-10-22T14:07:00.000Z', seconds: 0 },
    waitingFor: null,
    waitingSince: null,
    discord: 'both',
    memory: { rssMB: 150, heapUsedMB: 52.5, heapTotalMB: 80, externalMB: 3 }
  });
  // Cycle 2 is stuck, as nothing in it reaches a safe point, and the service is healthy while it
  // goes, until its time limit's hard exit ends the service, which is then stopping.
  await service.runTo(START + 10 * MINUTE + SECOND);
  assert.deepStrictEqual([service.health().status, service.health().cycle], [200, 2]);
  await service.runUntil(() => service.process.exits.length > 0, 'the hard exit');
  assert.deepStrictEqual([service.process.exits, service.now()], [[1], START + 26 * MINUTE]);
  assert.deepStrictEqual(
    [service.health().status, service.health().reason],
    [503, 'the importer service is stopping']
  );
  stuck.resolve();
  await service.finish(running);
}

// IMPORTER_LOOP_DISCORD=changes: the embed of a cycle, as a run's is drawn, is posted once the
// cycle has ended, but only for a cycle that changed something or had a problem. A quiet cycle posts
// nothing at all. There is no status message or hourly summary. Alerts, such as a failure, are
// posted in every mode.
async function discordCycles(mode, { hours = 0 } = {}) {
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '600', IMPORTER_LOOP_DISCORD: mode, GIT_SHA: 'abc1234' }
  });
  // What each cycle does: cycle 1 adds bans, 2 is quiet, 3 posts a warning, 4 fails, 5 marks bans
  // expired, 6 pushes export bans, and every cycle after is quiet.
  let cycle = 0;
  let imports = importCounts();
  let expired = { due: 0, expired: 0, players: 0 };
  let pushed = { queued: 0, created: 0, deleted: 0, failed: 0 };
  const steps = [
    step(
      'importBans',
      async () => {
        cycle++;
        service.bm.requests += 2;
        imports = importCounts(cycle === 1 ? { new: 3, updated: 1 } : {});
        if (cycle === 3) service.Logger.important('BanImporter', 'Warning: something to look at.');
        await service.wait(30 * SECOND);
      },
      () => imports
    ),
    step(
      'expireBans',
      async () => {
        expired =
          cycle === 5 ? { due: 2, expired: 2, players: 2 } : { due: 0, expired: 0, players: 0 };
        if (cycle === 4) throw new Error('Deadlock found');
      },
      () => expired
    ),
    step(
      'exportExportBans',
      async () => {
        pushed =
          cycle === 6
            ? { queued: 5, created: 4, deleted: 1, failed: 0 }
            : { queued: 0, created: 0, deleted: 0, failed: 0 };
      },
      () => pushed
    )
  ];
  const running = service.start(steps);
  await service.runUntil(() => service.records().length === 8 + hours * 6, 'the cycles');
  return { service, running };
}
{
  const { service, running } = await discordCycles('changes');
  assert.deepStrictEqual(
    service.posts.map(({ embed }) => embed.title),
    [
      'CBL update cycle 1 finished',
      'CBL update cycle 3 finished',
      'CBL update cycle 4 failed',
      'CBL update cycle 5 finished',
      'CBL update cycle 6 finished'
    ]
  );
  // Each is posted as its cycle ends.
  assert.deepStrictEqual(
    service.posts.map(({ at }) => (at - START) / MINUTE),
    [0.5, 20.5, 30.5, 40.5, 50.5]
  );
  const [first] = service.posts;
  assert.match(first.embed.description, /> 2 ban lists: 200 bans fetched, 3 new, 1 updated/);
  assert.deepStrictEqual(service.statuses, []);
  // The alerts are posted as lines of their own.
  assert.deepStrictEqual(service.discord, [
    'Warning: something to look at.',
    'The CBL update cycle 4 failed: Error: Deadlock found'
  ]);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  // It stopped between cycles, so its stop posted no embed.
  assert.strictEqual(service.posts.length, 5);
}

// IMPORTER_LOOP_DISCORD=status: no cycle's embed, but one status message for the service, edited
// at most once a minute, that shows when it started, the cycle under way and its step, the last
// cycle and when the next starts, and the totals since the last hourly summary; and an hourly
// summary on each whole hour, from the first at least half an hour after the start. The message's
// ID is kept in ImporterState, so the next process edits it rather than posting another.
{
  const { service, running } = await discordCycles('status', { hours: 1 });
  assert.deepStrictEqual(
    service.posts.map(({ embed, at }) => [embed.title, new Date(at).toISOString()]),
    [
      ['CBL importer service: hourly summary', '2026-10-22T15:00:00.000Z'],
      ['CBL importer service: hourly summary', '2026-10-22T16:00:00.000Z']
    ]
  );
  // The first summary covers the cycles that ended from the start to 15:00: cycles 1 to 6.
  assert.deepStrictEqual(service.posts[0].embed.description.split('\n'), [
    '<t:1792678020:f> to <t:1792681200:t>',
    '**Cycles** 6 run · 1 failed · 0 stopped',
    '**Bans** 3 added · 1 updated · 0 removed · 2 expired',
    '**Export bans** 4 created · 1 deleted',
    '**BattleMetrics** 12 requests',
    '**Steam** 0 profiles updated',
    '**Slowest cycle** 30s, cycle 1, started <t:1792678020:t>'
  ]);
  assert.strictEqual(service.posts[0].embed.color, 0xed4245);
  assert.deepStrictEqual(service.posts[1].embed.description.split('\n').slice(1, 3), [
    '**Cycles** 6 run · 0 failed · 0 stopped',
    '**Bans** 0 added · 0 updated · 0 removed · 0 expired'
  ]);
  assert.strictEqual(service.posts[1].embed.color, 0x57f287);

  const [status] = service.statuses;
  assert.strictEqual(service.statuses.length, 1);
  assert.deepStrictEqual(
    {
      messageID: status.options.messageID,
      editInterval: status.options.editInterval,
      repostIfDeleted: status.options.repostIfDeleted
    },
    { messageID: null, editInterval: 60000, repostIfDeleted: true }
  );
  // It is first drawn in cycle 1, once the migrations are applied.
  assert.strictEqual(status.first.title, 'CBL importer service running');
  assert.deepStrictEqual(status.first.description.split('\n'), [
    'Running since <t:1792678020:f> (<t:1792678020:R>) · commit `abc1234`',
    'A cycle every **10m 00s**, time limit **15m 00s**',
    '',
    '🔄 **Cycle 1** · started <t:1792678020:R> · **Migrations**',
    '',
    '**Since <t:1792678020:t>** · 0 cycles · bans 0 added, 0 updated, 0 removed, 0 expired · export bans 0 created, 0 deleted · 0 BattleMetrics requests · 0 Steam profiles updated'
  ]);
  // Between cycles, it says when the next starts, after the last cycle and the totals.
  const between = status.embed();
  assert.deepStrictEqual(between.description.split('\n').slice(3), [
    `💤 Next cycle <t:${(START + 140 * MINUTE) / 1000}:t> (<t:${(START + 140 * MINUTE) / 1000}:R>)`,
    `✅ **Cycle 14** finished in **30s**, <t:${(START + 130.5 * MINUTE) / 1000}:R>`,
    '> no changes',
    '',
    '**Since <t:1792684800:t>** · 2 cycles · bans 0 added, 0 updated, 0 removed, 0 expired · export bans 0 created, 0 deleted · 4 BattleMetrics requests · 0 Steam profiles updated · slowest 30s'
  ]);
  // Once posted, its ID is saved for the next process. A message that was deleted, and posted
  // again, is saved in its place.
  status.options.onPosted('777');
  await settle();
  assert.strictEqual(service.state.read('importerService').messageId, '777');
  status.options.onPosted('778');
  await settle();
  assert.strictEqual(service.state.read('importerService').messageId, '778');
  // Alerts are posted in this mode too.
  assert.deepStrictEqual(service.discord, [
    'Warning: something to look at.',
    'The CBL update cycle 4 failed: Error: Deadlock found'
  ]);

  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: '778',
    startedAt: '2026-10-22T14:07:00.000Z',
    endedAt: new Date(service.now()).toISOString(),
    outcome: 'stopped'
  });
  // The summary's timer is gone once the service has ended.
  assert.strictEqual(service.timers.size, 0);
}

// IMPORTER_LOOP_DISCORD=both, the default, posts the cycles' embeds as changes does, and keeps the
// status message and hourly summary as status does. An invalid value is taken as both, with a
// warning.
for (const mode of ['both', '', 'everything']) {
  const { service, running } = await discordCycles(mode);
  assert.deepStrictEqual(
    service.posts.map(({ embed }) => embed.title),
    [
      'CBL update cycle 1 finished',
      'CBL update cycle 3 finished',
      'CBL update cycle 4 failed',
      'CBL update cycle 5 finished',
      'CBL update cycle 6 finished',
      'CBL importer service: hourly summary'
    ]
  );
  assert.strictEqual(service.statuses.length, 1);
  assert.deepStrictEqual(
    service.discord,
    [
      ...(mode === 'everything'
        ? [
            'Warning: IMPORTER_LOOP_DISCORD must be changes, status or both, not "everything", so the importer service posts both.'
          ]
        : []),
      'Warning: something to look at.',
      'The CBL update cycle 4 failed: Error: Deadlock found'
    ],
    mode
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A cycle that does not succeed checks whether the importer is stale once its record is saved, as a
// run does, in every IMPORTER_LOOP_DISCORD mode: once no cycle has succeeded for 3 cadences, the
// stale alert is posted, and again once a cadence while it stays stale, however many cycles fail
// meanwhile. Here cycles start every minute and the cadence is 10 minutes, and the last success
// was 31 minutes before the service started. A cycle that exits 0 but imports none of its lists,
// as during a BattleMetrics outage, does not succeed, and nor does one that fails. One that
// succeeds does not check, and the next stale alert is then 3 cadences away.
const STALE =
  /^The CBL update is stale: no run has succeeded for (\d+) minutes, since the one that started at (\S+)\. The importer service starts a cycle every 10 minutes \(IMPORTER_CADENCE_SECONDS, or else IMPORTER_CYCLE_SECONDS\), so 3 or more in a row have not succeeded\. The last run ended at (\S+) with exit code (\d)(.*)\.$/;
const staleRows = { lastSuccessAt: new Date(START - 31 * MINUTE).toISOString() };
// Every list failed, as during a BattleMetrics outage.
const outage = () =>
  importCounts({
    failedLists: 2,
    banLists: [
      { id: 1, fetched: 0, error: 'Error: Request failed with status code 503' },
      { id: 2, fetched: 0, error: 'Error: Request failed with status code 503' }
    ]
  });
for (const mode of ['changes', 'status', 'both']) {
  const service = await loadLoop({
    env: {
      IMPORTER_CYCLE_SECONDS: '60',
      IMPORTER_CADENCE_SECONDS: '600',
      IMPORTER_LOOP_DISCORD: mode
    },
    state: { rows: staleRows }
  });
  let cycles = 0;
  const running = service.start([
    step(
      'importBans',
      async () => {
        cycles++;
        if (cycles === 5) throw new Error('Deadlock found');
      },
      () => (cycles === 13 ? importCounts() : outage())
    )
  ]);
  const stale = () => service.discord.filter((line) => STALE.test(line));
  await service.runUntil(() => service.records().length === 12, 'twelve cycles');
  await service.runTo(service.now() + 30 * SECOND);
  // Posted by cycle 1, and again by cycle 10, a cadence later, but by none in between, cycle 5's
  // failure included.
  assert.deepStrictEqual(
    stale().map((line) => {
      const [, minutes, since, endedAt, exitCode, how] = STALE.exec(line);
      return [Number(minutes), since, endedAt, Number(exitCode), how];
    }),
    [
      [
        31,
        '2026-10-22T13:36:00.000Z',
        '2026-10-22T14:07:00.000Z',
        0,
        ', but imported none of its 2 ban lists'
      ],
      [
        40,
        '2026-10-22T13:36:00.000Z',
        '2026-10-22T14:16:00.000Z',
        0,
        ', but imported none of its 2 ban lists'
      ]
    ],
    mode
  );
  assert.ok(service.discord.includes('The CBL update cycle 5 failed: Error: Deadlock found'), mode);
  assert.strictEqual(service.state.read('lastStaleAlertAt'), '2026-10-22T14:16:00.000Z', mode);
  // Cycle 13 succeeds, and checks nothing: the check reads the state first. The cycles after it
  // fail again, but the importer is stale again only 3 cadences after cycle 13.
  const beforeSuccess = service.events.length;
  await service.runUntil(() => service.records().length === 13, 'cycle 13');
  await service.runTo(service.now() + 30 * SECOND);
  assert.strictEqual(service.state.read('lastSuccessAt'), '2026-10-22T14:19:00.000Z', mode);
  assert.ok(!service.events.slice(beforeSuccess).includes('read state'), mode);
  await service.runTo(START + 40 * MINUTE);
  assert.strictEqual(stale().length, 2, mode);
  await service.runTo(START + 49 * MINUTE);
  assert.strictEqual(stale().length, 3, mode);
  assert.deepStrictEqual(
    STALE.exec(stale()[2]).slice(1, 4),
    ['29', '2026-10-22T14:19:00.000Z', '2026-10-22T14:48:00.000Z'],
    mode
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0, mode);
}
// A cycle that ends once the service is stopping does not check, which leaves the time for the
// service's last messages, and nor does one whose record could not be saved as the database is
// unavailable, as the check could not read it either. The check reads the state first, which
// neither does once its record is saved, or fails to be.
for (const why of ['SIGTERM', 'database']) {
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_CADENCE_SECONDS: '600' },
    state: { rows: staleRows }
  });
  const running = service.start([step('importBans', () => service.wait(30 * SECOND), outage)]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  if (why === 'SIGTERM') {
    service.process.emit('SIGTERM', 'SIGTERM');
    assert.strictEqual(await service.finish(running), 0, why);
  } else {
    service.state.control.down = true;
    await service.runTo(START + 55 * SECOND);
    assert.ok(
      service
        .printed()
        .includes('Warning: could not save the run record: Error: connect ECONNREFUSED'),
      why
    );
  }
  assert.strictEqual(service.records().length, 1, why);
  const saved = service.events.indexOf('transaction');
  assert.ok(saved > 0, why);
  assert.ok(!service.events.slice(saved).includes('read state'), why);
  assert.deepStrictEqual(
    service.discord.filter((line) => STALE.test(line)),
    [],
    why
  );
  if (why === 'database') {
    service.state.control.down = false;
    service.process.emit('SIGTERM', 'SIGTERM');
    assert.strictEqual(await service.finish(running), 0, why);
  }
}

// After a restart, the service edits the status message the process before it kept up to date,
// rather than posting another. A process that ended without saying so, e.g. as it was killed or
// ran out of memory, is posted about, once.
for (const [row, said] of [
  [
    {
      messageId: '555',
      startedAt: '2026-10-22T10:00:00.000Z',
      endedAt: '2026-10-22T14:06:00.000Z',
      outcome: 'stopped'
    },
    []
  ],
  [
    { messageId: '555', startedAt: '2026-10-22T10:00:00.000Z' },
    [
      "The importer service's last process, which started at 2026-10-22T10:00:00.000Z, ended without saying how, e.g. as it was killed, ran out of memory, was ended at once by a second signal, or could not reach the database as it ended."
    ]
  ],
  [
    {
      messageId: 'not-an-id',
      startedAt: '2026-10-22T10:00:00.000Z',
      endedAt: '2026-10-22T11:00:00.000Z'
    },
    []
  ]
]) {
  const service = await loadLoop({ state: { rows: { importerService: row } } });
  const running = service.start([step('importBans', async () => {})]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  const [status] = service.statuses;
  assert.strictEqual(status.options.messageID, row.messageId === '555' ? '555' : null);
  assert.deepStrictEqual(service.discord, said);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: row.messageId === '555' ? '555' : null,
    startedAt: '2026-10-22T14:07:00.000Z'
  });
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A status message that its final edit finds deleted, as someone deleted it while the service
// waited between cycles, is posted again, and the end saves the new message's ID with how the
// service ended, once that edit has been sent, so the next process edits the message that says how
// this one ended rather than posting a third. It is saved with the old ID first, should the edit
// take too long. A service whose cycle did not stop at its time limit does the same in the 5
// seconds it has.
for (const how of ['stopped', 'failed']) {
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '600', IMPORTER_MAX_CYCLE_SECONDS: '120' },
    state: {
      rows: {
        importerService: {
          messageId: '555',
          startedAt: '2026-10-22T10:00:00.000Z',
          endedAt: '2026-10-22T14:06:00.000Z',
          outcome: 'stopped'
        }
      }
    }
  });
  let cycles = 0;
  const stuck = deferred();
  const running = service.start([
    step('importBans', async () => {
      cycles++;
      if (cycles === 2 && how === 'failed') await stuck.promise;
    })
  ]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  const [status] = service.statuses;
  assert.strictEqual(status.options.messageID, '555', how);
  status.finalEdit = (options) => service.wait(2 * SECOND).then(() => options.onPosted('999'));
  if (how === 'stopped') {
    await service.runTo(START + 5 * MINUTE);
    service.process.emit('SIGTERM', 'SIGTERM');
    assert.strictEqual(await service.finish(running), 0, how);
  } else await service.runUntil(() => service.process.exits.length > 0, 'the hard exit');
  const endedAt = how === 'stopped' ? START + 5 * MINUTE : START + 13 * MINUTE;
  assert.deepStrictEqual(
    service.state.read('importerService'),
    {
      messageId: '999',
      startedAt: '2026-10-22T14:07:00.000Z',
      endedAt: new Date(endedAt).toISOString(),
      outcome: how
    },
    how
  );
  assert.strictEqual(
    service.events.filter((event) => event === 'save importerService').length,
    3,
    how
  );
  stuck.resolve();
  if (how === 'failed') await service.finish(running);
}
// The end waits for that edit for as long as it can, keeping 5 seconds to save the row again, so a
// slow Discord, which posts the message again 20 seconds after SIGTERM, still has its new ID saved.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '600' },
    state: {
      rows: {
        importerService: {
          messageId: '111',
          startedAt: '2026-10-22T13:00:00.000Z',
          endedAt: '2026-10-22T13:59:00.000Z',
          outcome: 'stopped'
        }
      }
    }
  });
  const running = service.start([step('importBans', () => service.wait(5 * SECOND))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  await service.runTo(service.now() + 10 * SECOND);
  const [status] = service.statuses;
  status.finalEdit = (options) => service.wait(20 * SECOND).then(() => options.onPosted('222'));
  const askedAt = service.now();
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: '222',
    startedAt: '2026-10-22T14:07:00.000Z',
    endedAt: new Date(askedAt).toISOString(),
    outcome: 'stopped'
  });
  assert.strictEqual(service.lock.releasedAt - askedAt, 20 * SECOND);
  assert.ok(!service.printed().some((line) => /final edit took longer/.test(line)));
}

// A second signal ends the service at once, closing the locks' connection, but nothing is cut
// short between cycles, nor once the service is ending, so it exits with the code it was stopping
// with: 0 after a signal, or 1 after it lost its locks. Here the database stops answering, so the
// end waits for it when the second signal comes.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const running = service.start([step('importBans', async () => {})]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  await service.runTo(START + MINUTE);
  service.process.emit('SIGTERM', 'SIGTERM');
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(service.process.exits, [0]);
  assert.ok(service.lock.destroyed);
  assert.strictEqual(service.records().length, 1);
  await service.finish(running);
}
for (const [cause, code] of [
  ['SIGTERM', 0],
  ['lost', 1]
]) {
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const running = service.start([step('importBans', async () => {})]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  await service.runTo(START + MINUTE);
  service.state.control.hang = true;
  if (cause === 'lost') service.lock.onLost('Connection lost');
  service.process.emit('SIGTERM', 'SIGTERM');
  await service.runTo(service.now() + 5 * SECOND);
  assert.deepStrictEqual(service.process.exits, [], cause);
  service.process.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(service.process.exits, [code], cause);
  assert.match(
    service.printed().at(-1),
    /^Received SIGINT again, so the importer service is ending now/,
    cause
  );
  assert.ok(service.lock.destroyed, cause);
  assert.strictEqual(service.records().length, 1, cause);
  await service.finish(running);
}

// A cycle that finds the run lock held waits for it, trying again every 15 seconds: e.g. while a
// run that an importer from before the importer service started by hand, which takes only the run
// lock, is under way. It posts that it waits, once, the health check and the status message say
// so, and the service checks once a cadence whether the importer is stale, as standing by does.
// The cycle's time limit starts once it holds the run lock, so a long wait is not cut short, and
// the cycle then runs as usual.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60', IMPORTER_MAX_CYCLE_SECONDS: '60' },
    runLockAnswers: ['free', ...Array(20).fill('busy'), 'free']
  });
  const running = service.start([step('importBans', () => service.wait(10 * SECOND))]);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  await service.runTo(START + 3 * MINUTE + 30 * SECOND);
  const waiting =
    'Another run holds the run lock, e.g. one started by hand with an importer from before the importer service, so cycle 2 waits for it, trying again every 15s.';
  assert.deepStrictEqual(service.discord.slice(0, 1), [waiting]);
  const health = service.health();
  assert.deepStrictEqual(
    [health.status, health.waitingFor, health.waitingSince, health.reason],
    [
      200,
      'lock',
      '2026-10-22T14:08:00.000Z',
      'it has been waiting for another run to end for 2 minutes'
    ]
  );
  assert.strictEqual(
    service.statuses[0].embed().description.split('\n')[3],
    `⏳ **Cycle 2** · started <t:${(START + MINUTE) / 1000}:R> · waiting for another run to end since <t:${(START + MINUTE) / 1000}:R>`
  );
  assert.deepStrictEqual(service.lock.runHeld, false);
  await service.runUntil(() => service.records().length === 2, 'the second cycle');
  const second = service.records()[1];
  assert.deepStrictEqual(
    [second.outcome, second.phases.takeRunLock, second.seconds, second.startedAt],
    ['finished', 300, 310, '2026-10-22T14:08:00.000Z']
  );
  // Posted once, however long it waited, and stale once a cadence from 3 cadences after the last
  // success, the first cycle, at 14:07.
  assert.deepStrictEqual(
    service.discord.map((line) => (line.startsWith('The CBL update is stale') ? 'stale' : line)),
    [waiting, 'stale', 'stale', 'stale']
  );
  assert.ok(
    service.discord
      .filter((line) => line.startsWith('The CBL update is stale'))
      .every((line) =>
        line.endsWith('The importer service is standing by, as another run holds the run lock.')
      )
  );
  assert.ok(!service.events.some((event) => /has taken longer than/.test(event)));
  assert.deepStrictEqual(service.process.exits, []);
  assert.strictEqual(service.health().status, 200);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}
// The service's first cycle shows that it waits for the run lock in the status message too, as the
// switch from the script's runs to the service may find a run of an earlier importer under way: it
// reads the service's row and posts the status message, or edits the last process's, as it starts
// to wait, before the migrations, which still wait for the run lock. A service stopped while it
// waits saves how it ended in its row, so the next process does not say it ended without saying
// how.
for (const stop of [false, true]) {
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60' },
    runLockAnswers: ['busy', 'busy', 'free'],
    state: {
      rows: {
        importerService: {
          messageId: '555',
          startedAt: '2026-10-22T10:00:00.000Z',
          endedAt: '2026-10-22T14:06:00.000Z',
          outcome: 'stopped'
        }
      }
    }
  });
  const running = service.start([step('importBans', async () => {})]);
  await service.runTo(START + 10 * SECOND);
  assert.strictEqual(service.statuses.length, 1, `${stop}`);
  const [status] = service.statuses;
  assert.strictEqual(status.options.messageID, '555');
  assert.strictEqual(
    status.first.description.split('\n')[3],
    `⏳ **Cycle 1** · started <t:${START / 1000}:R> · waiting for another run to end since <t:${START / 1000}:R>`
  );
  assert.ok(!service.events.includes('migrate'));
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: '555',
    startedAt: '2026-10-22T14:07:00.000Z'
  });
  if (stop) {
    service.process.emit('SIGTERM', 'SIGTERM');
    assert.strictEqual(await service.finish(running), 0);
    assert.deepStrictEqual(service.state.read('importerService'), {
      messageId: '555',
      startedAt: '2026-10-22T14:07:00.000Z',
      endedAt: new Date(START + 10 * SECOND).toISOString(),
      outcome: 'stopped'
    });
    assert.strictEqual(service.events.filter((event) => event === 'migrate').length, 0);
    continue;
  }
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  assert.deepStrictEqual(
    [service.records()[0].outcome, service.records()[0].phases.takeRunLock],
    ['finished', 30]
  );
  assert.deepStrictEqual(service.statuses, [status]);
  assert.strictEqual(service.events.filter((event) => event === 'migrate').length, 1);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}
// Before the importer's tables exist, there is no row to read, nor to keep the message's ID in, so
// the status message waits for the migrations, as it does when nothing waits.
{
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60' },
    runLockAnswers: ['busy', 'busy', 'free'],
    state: { missing: true }
  });
  const running = service.start([step('importBans', async () => {})]);
  await service.runTo(START + 10 * SECOND);
  assert.deepStrictEqual(service.statuses, []);
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  assert.strictEqual(service.statuses.length, 1);
  assert.deepStrictEqual(service.state.read('importerService'), {
    messageId: null,
    startedAt: '2026-10-22T14:07:00.000Z'
  });
  assert.ok(!service.printed().some((line) => line.includes('could not read the importer')));
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A cycle asked to stop while it waits for the run lock stops at once, and one whose locks are lost
// meanwhile ends the service with exit code 1.
for (const [stop, code, reason] of [
  [(service) => service.process.emit('SIGTERM', 'SIGTERM'), 0, 'Stopped, as it received SIGTERM'],
  [(service) => service.lock.onLost('Connection lost'), 1, 'Stopped, as it lost its locks']
]) {
  const service = await loadLoop({ runLockAnswers: ['busy'] });
  const running = service.start([step('importBans', () => service.events.push('import'))]);
  await service.runTo(START + 40 * SECOND);
  const askedAt = service.now();
  stop(service);
  assert.strictEqual(await service.finish(running), code, reason);
  assert.strictEqual(service.now(), askedAt, reason);
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.phase, record.reason],
    [code === 0 ? 'interrupted' : 'failed', 'takeRunLock', reason]
  );
  assert.ok(!service.events.includes('import'), reason);
  assert.ok(service.lock.released, reason);
}

// The status message shows the cycle under way, with its step and how far it has got, as the
// steps report it, and, while the cycle waits for the database, since when.
{
  let down = false;
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60' },
    authenticate: async () => {
      if (down) throw unavailable();
    }
  });
  const gate = deferred();
  let cycles = 0;
  const running = service.start([
    step('importBans', async () => {
      cycles++;
      if (cycles > 1) return;
      service.control.reportProgress(7, 20, 'ban lists');
      await gate.promise;
    })
  ]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  const [status] = service.statuses;
  assert.strictEqual(
    status.embed().description.split('\n')[3],
    '🔄 **Cycle 1** · started <t:1792678020:R> · **Import** 7 / 20 ban lists'
  );
  gate.resolve();
  await service.runUntil(() => service.records().length === 1, 'the first cycle');
  down = true;
  await service.runTo(START + 2 * MINUTE);
  assert.strictEqual(
    status.embed().description.split('\n')[3],
    `⏳ **Cycle 2** · started <t:${(START + MINUTE) / 1000}:R> · waiting for the database since <t:${(START + MINUTE) / 1000}:R>`
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// Without Discord logging, nothing is posted, in any mode, and the service runs as usual. It says
// so when it starts, and the health check says it posts nothing to Discord.
{
  const service = await loadLoop({ discordLog: false });
  const running = service.start([
    step(
      'importBans',
      async () => {},
      () => importCounts({ new: 1 })
    )
  ]);
  await service.runUntil(() => service.records().length === 2, 'two cycles');
  assert.deepStrictEqual([service.posts, service.revisions], [[], []]);
  assert.ok(
    service
      .printed()
      .includes(
        'Started the CBL importer service (commit unknown): a cycle every 600s, time limit 900s, cadence 600s, posting nothing to Discord, not even alerts, as Discord logging is off.'
      )
  );
  assert.strictEqual(service.health().discord, 'off');
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// The first cycle corrects the status message of the run before the service if it still says that
// run is in progress, as a run does. It saves no run message of its own, as each cycle's embed is
// posted once the cycle has ended.
{
  const service = await loadLoop({
    state: {
      rows: { lastRunMessage: { messageId: '321', startedAt: '2026-10-22T13:00:00.000Z' } }
    }
  });
  const running = service.start([step('importBans', async () => {})]);
  await service.runUntil(() => service.records().length === 2, 'two cycles');
  assert.deepStrictEqual(
    service.revisions.map(({ messageID }) => messageID),
    ['321']
  );
  assert.deepStrictEqual(service.state.read('lastRunMessage'), {
    messageId: '321',
    startedAt: '2026-10-22T13:00:00.000Z'
  });
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// Migrations that fail make the first cycle fail, and the next cycle tries them again, so the
// service goes on. Its status message is posted once the migrations are applied.
{
  let attempts = 0;
  const service = await loadLoop({
    env: { IMPORTER_CYCLE_SECONDS: '60' },
    migrations: (options) => {
      attempts++;
      if (attempts === 1) throw new Error('MigrationError: Lock wait timeout exceeded');
      options.onApplied('001-importer-state');
      return { applied: ['001-importer-state'], unknown: [] };
    }
  });
  const running = service.start([step('importBans', async () => service.events.push('import'))]);
  await service.runUntil(() => service.records().length === 3, 'three cycles');
  const [first, second, third] = service.records();
  assert.deepStrictEqual(
    [first.outcome, first.phase, second.outcome, second.migrations, third.migrations],
    ['failed', 'migrate', 'finished', ['001-importer-state'], undefined]
  );
  assert.strictEqual(service.events.filter((event) => event === 'migrate').length, 2);
  assert.strictEqual(service.events.filter((event) => event === 'import').length, 2);
  assert.strictEqual(service.statuses.length, 1);
  assert.ok(
    service.discord.includes(
      'The CBL update cycle 1 failed: Error: MigrationError: Lock wait timeout exceeded'
    )
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A promise that fails with nothing to handle it fails the cycle in which it failed, as it fails a
// run, but not the cycles after it.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '60' } });
  let cycles = 0;
  const running = service.start([
    step('importBans', async () => {
      cycles++;
      if (cycles === 2) service.process.exitCode = 1;
    })
  ]);
  await service.runUntil(() => service.records().length === 3, 'three cycles');
  assert.deepStrictEqual(
    service.records().map(({ outcome, reason }) => [outcome, reason]),
    [
      ['finished', undefined],
      ['failed', 'A promise failed with nothing to handle it'],
      ['finished', undefined]
    ]
  );
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
}

// A service left waiting for something that can never happen, which index.js says through
// run.js's leftWaiting(), fails: the cycle under way prints its record as failed, and the service
// ends with exit code 1, releasing the lock.
{
  const service = await loadLoop();
  // The step never ends, so neither does the service's loop: index.js exits instead.
  service.start([step('importBans', () => new Promise(() => {}))]);
  await service.runUntil(() => service.statuses.length === 1, 'the first cycle to start');
  const exitCode = await service.run.leftWaiting();
  assert.strictEqual(exitCode, 1);
  const [record] = service.records();
  assert.deepStrictEqual(
    [record.outcome, record.reason],
    ['failed', 'The run was left waiting for something that can never happen']
  );
  assert.ok(service.lock.released);
  assert.ok(
    service.discord.includes(
      'The importer service failed, as it was left waiting for something that can never happen.'
    )
  );
}

// Nothing grows from one cycle to the next: after 30 cycles, the service still has one status
// message, one handler for each signal, no waits listening for a stop during a cycle and one
// between cycles, its own few timers, and the status message's totals since the last hourly
// summary only.
{
  const service = await loadLoop({ env: { IMPORTER_CYCLE_SECONDS: '600' } });
  const during = [];
  const running = service.start([
    step('importBans', async () => {
      during.push({
        listening: service.control.waitingForStop(),
        timers: service.timers.size,
        sigterm: service.process.listenerCount('SIGTERM')
      });
      await service.wait(10 * SECOND);
    })
  ]);
  await service.runUntil(() => service.records().length === 30, 'thirty cycles');
  await service.runTo(service.now() + MINUTE);
  assert.strictEqual(service.statuses.length, 1);
  // The run lock was taken once a cycle, and freed again each time.
  assert.deepStrictEqual(
    [service.lock.runTakes, service.lock.runFrees, service.lock.runHeld],
    [30, 30, false]
  );
  // During a cycle: no wait for a stop, and the cycle's time limit and the hourly summary's
  // timers. Between cycles: the wait for the next cycle.
  assert.ok(during.every(({ listening }) => listening === 0));
  assert.ok(
    during.every(({ timers }) => timers <= 2),
    JSON.stringify(during)
  );
  assert.ok(during.every(({ sigterm }) => sigterm === 1));
  assert.strictEqual(service.control.waitingForStop(), 1);
  assert.ok(service.timers.size <= 2);
  const totals = service.statuses[0].embed().description.split('\n').at(-1);
  assert.match(totals, /^\*\*Since <t:\d+:t>\*\* · [1-6] cycles? /);
  service.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(await service.finish(running), 0);
  assert.strictEqual(service.control.waitingForStop(), 0);
}

// IMPORTER_MODE is once, the default, or loop, in any case and with spaces or quotes around it.
// Anything else starts nothing, as either could be the wrong one. IMPORTER_LOOP_DISCORD is changes,
// status or both, the default, and an invalid value is taken as both, with a warning.
{
  const service = await loadLoop();
  for (const [value, loop] of [
    [undefined, false],
    ['', false],
    ['once', false],
    [' Once ', false],
    ['loop', true],
    ['"LOOP"', true]
  ])
    assert.deepStrictEqual(copy(service.readMode(value)), { loop }, `${value}`);
  for (const value of ['loops', 'service', '1'])
    assert.deepStrictEqual(copy(service.readMode(value)), {
      error: `IMPORTER_MODE must be once or loop, not "${value}", so the importer did not start.`
    });
  for (const [value, mode] of [
    [undefined, 'both'],
    ['changes', 'changes'],
    [" 'Status' ", 'status'],
    ['BOTH', 'both']
  ])
    assert.deepStrictEqual(copy(service.readDiscordMode(value)), { mode }, `${value}`);
  assert.deepStrictEqual(copy(service.readDiscordMode('all')), {
    mode: 'both',
    warning:
      'Warning: IMPORTER_LOOP_DISCORD must be changes, status or both, not "all", so the importer service posts both.'
  });
  assert.deepStrictEqual(
    copy(
      service.memoryOf({ rss: 157286400, heapUsed: 55050240, heapTotal: 83886080, external: 0 })
    ),
    { rssMB: 150, heapUsedMB: 52.5, heapTotalMB: 80, externalMB: 0 }
  );
}

console.log(
  'Importer service checks passed: cycle timing, overruns, the time limit and its hard exit, signals and the 55 s stop limit, a second signal, a lost lock, the run lock held only during cycles, the database, the service lock and the run lock waited for, health, the stale alert of failed cycles, each Discord mode, the status message kept across restarts and saved once posted again, the hourly summary, and nothing growing per cycle.'
);
