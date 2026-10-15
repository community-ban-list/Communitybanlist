import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise a run of the importer, from waiting for the database to its exit code, without a
// database, Discord or real signals. The run's steps are stand-ins.

const emptyQueue = { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 };

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

// Load run.js with stand-ins for the database, the run lock, the logger and the process, and a
// clock that only moves when the test moves it.
async function loadRun({ env = {}, authenticate = async () => {}, lockFree = true } = {}) {
  const events = [];
  const output = [];
  const discord = [];
  const timers = new Set();
  let now = 1000000;

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
      connect: async () => events.push('connect'),
      disconnect: async () => events.push('disconnect'),
      sequelize: {
        authenticate: async () => {
          events.push('authenticate');
          return authenticate();
        }
      },
      takeRunLock: async ({ onLost }) => {
        events.push('takeRunLock');
        if (!lockFree) return null;
        lock.onLost = onLost;
        return lock;
      }
    },
    'scbl-lib/db/sequelize': { isDatabaseUnavailable: (err) => err.unavailable === true },
    'scbl-lib/utils': {
      describeError,
      Logger: {
        verbose: (module, verboseness, message, ...extras) => {
          const text = `${message}${extras.map(describeError).join('')}`;
          events.push(`verbose ${text}`);
          if (verboseness === 1) discord.push(text);
        },
        flush: () => events.push('flush'),
        getLogQueue: () => emptyQueue
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
    Date: { now: () => now },
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
    // The real run-control.js, which the steps use too.
    assert.strictEqual(specifier, './run-control.js', `Unexpected dependency: ${specifier}`);
    control = new vm.SourceTextModule(
      await readFile(new URL(specifier, referencingModule.identifier), 'utf8'),
      { context }
    );
    return control;
  });
  await module.evaluate();

  return {
    run: module.namespace.default,
    EXIT_CODES: module.namespace.EXIT_CODES,
    control: control.namespace,
    lock,
    events,
    output,
    discord,
    timers,
    process: fakeProcess,
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
      until(() => [...timers].some((timer) => timer.ms === ms), `a timer of ${ms} ms`)
  };
}

// A step that waits until the test lets it finish.
function gatedStep(events, name) {
  const started = deferred();
  const finish = deferred();
  const step = async () => {
    events.push(name);
    started.resolve();
    await finish.promise;
  };
  return { step, started: started.promise, finish: finish.resolve };
}

// A run that finishes: it waits for the database, takes the lock before anything is posted to
// Discord, runs the steps in order and exits 0, after sending its log messages and releasing the
// lock. The start message names the commit and the time limit, and mentions nobody.
{
  const importer = await loadRun({ env: { GIT_SHA: 'abc1234' } });
  const step = (name) => async () => importer.events.push(name);
  const exitCode = await importer.run([step('import'), step('export')]);

  assert.strictEqual(exitCode, importer.EXIT_CODES.FINISHED);
  assert.strictEqual(exitCode, 0);
  assert.deepStrictEqual(importer.events.slice(0, 7), [
    'authenticate',
    'takeRunLock',
    'verbose Starting new CBL Update run (commit abc1234, time limit 18000s)...',
    'connect',
    'import',
    'export',
    'disconnect'
  ]);
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
  assert.match(importer.discord.at(-1), /^Finished All Tasks/);
  assert.ok(!importer.discord.some((message) => message.includes('<@')));

  // The signal handlers and timers are gone once the run has ended.
  assert.strictEqual(importer.process.listenerCount('SIGTERM'), 0);
  assert.strictEqual(importer.process.listenerCount('SIGINT'), 0);
  assert.strictEqual(importer.timers.size, 0);
}

// When another run holds the lock, the run is skipped with exit code 75 and one line in the
// console, and nothing is posted to Discord or done to the database.
{
  const importer = await loadRun({ lockFree: false });
  const exitCode = await importer.run([() => importer.events.push('import')]);
  assert.strictEqual(exitCode, 75);
  assert.deepStrictEqual(importer.events, ['authenticate', 'takeRunLock']);
  assert.deepStrictEqual(importer.output, [
    'Skipped this CBL update run, as another run holds the run lock.'
  ]);
  assert.deepStrictEqual(importer.discord, []);
}

// A step that fails ends the run with exit code 1. The failure is posted to Discord, the later
// steps are skipped and the lock is released.
{
  const importer = await loadRun();
  const exitCode = await importer.run([
    async () => {
      throw new Error('Deadlock found');
    },
    () => importer.events.push('export')
  ]);
  assert.strictEqual(exitCode, 1);
  assert.ok(!importer.events.includes('export'));
  assert.ok(!importer.events.includes('disconnect'));
  assert.strictEqual(importer.discord.at(-1), 'The CBL update run failed: Error: Deadlock found');
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
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
  const run = importer.run([() => importer.events.push('import')]);
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
}
{
  const importer = await loadRun({ authenticate: async () => Promise.reject(unavailable()) });
  const run = importer.run([() => importer.events.push('import')]);
  for (const delay of [5000, 10000, 20000, 40000, 80000]) {
    await importer.waitForTimer(delay);
    importer.advance(delay);
  }
  // It gives up with exit code 1, before the lock is taken or anything is posted to Discord.
  assert.strictEqual(await run, 1);
  assert.strictEqual(importer.events.filter((event) => event === 'authenticate').length, 6);
  assert.ok(!importer.events.includes('takeRunLock'));
  assert.deepStrictEqual(importer.discord, []);
  assert.match(importer.output.at(-1), /^The CBL update run failed, as it could not reach/);
}
{
  // Other errors are not waited out.
  const importer = await loadRun({
    authenticate: async () => {
      throw new Error("Access denied for user 'cbl'");
    }
  });
  assert.strictEqual(await importer.run([]), 1);
  assert.deepStrictEqual(importer.events, ['authenticate']);
}

// SIGTERM or SIGINT asks the run to stop at its next safe point: the step in progress finishes, the
// next one never starts, and the run exits 3 after sending its log messages and releasing the lock.
for (const signal of ['SIGTERM', 'SIGINT']) {
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, () => importer.events.push('export')]);
  await first.started;
  importer.process.emit(signal, signal);
  assert.match(importer.discord.at(-1), new RegExp(`^Received ${signal}, so the run will stop`));
  first.finish();

  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('export'));
  assert.strictEqual(
    importer.discord.at(-1),
    `The CBL update run stopped before it finished, as it received ${signal}.`
  );
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
  assert.deepStrictEqual(importer.process.exits, []);
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
  assert.match(importer.discord.at(-1), /^Finished All Tasks/);
}

// The steps' own safe points, such as between export bans, stop the run too.
{
  const importer = await loadRun();
  const run = importer.run([
    async () => {
      importer.process.emit('SIGTERM', 'SIGTERM');
      importer.control.stopIfRequested();
      importer.events.push('next export ban');
    }
  ]);
  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('next export ban'));
}

// A second signal ends the run at once, closing the lock's connection, which frees the lock.
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
  assert.match(importer.output.at(-1), /^Received SIGINT again, so the run is ending now/);

  // The test's process.exit() returns, so let the run end.
  first.finish();
  await run;
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
}

// The time limit, IMPORTER_MAX_RUN_SECONDS, asks the run to stop at its next safe point, so it ends
// before the next scheduled run would stop it.
{
  const importer = await loadRun({ env: { IMPORTER_MAX_RUN_SECONDS: '600' } });
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, () => importer.events.push('export')]);
  await first.started;
  importer.advance(599 * 1000);
  assert.strictEqual(importer.control.isStopping(), false);
  importer.advance(1000);
  assert.strictEqual(importer.control.isStopping(), true);
  assert.match(importer.discord.at(-1), /^The run has taken longer than 600s/);
  first.finish();

  assert.strictEqual(await run, 3);
  assert.ok(!importer.events.includes('export'));
  assert.match(importer.discord.at(-1), /stopped before it finished, as it took longer than 600s/);
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
  assert.match(importer.output.at(-1), /did not stop within 60s of its time limit/);

  first.finish();
  await run;
}

// The time limit is 5 hours unless set, and an invalid setting is replaced with that, with a
// warning.
for (const [value, seconds, warning] of [
  [undefined, 18000, false],
  ['', 18000, false],
  ['7200', 7200, false],
  ['0', 18000, true],
  ['-5', 18000, true],
  ['1.5', 18000, true],
  ['abc', 18000, true],
  ['9999999999', 18000, true]
]) {
  const env = value === undefined ? {} : { IMPORTER_MAX_RUN_SECONDS: value };
  const importer = await loadRun({ env });
  let timeLimit;
  await importer.run([
    async () => {
      timeLimit = Math.max(...[...importer.timers].map((timer) => timer.ms));
    }
  ]);
  assert.strictEqual(timeLimit, seconds * 1000, `Time limit for ${JSON.stringify(value)}`);
  assert.strictEqual(
    importer.output.some((line) => /^Warning: IMPORTER_MAX_RUN_SECONDS must be/.test(line)),
    warning
  );
}

// A run that loses its lock, e.g. because MySQL restarted, stops at its next safe point and exits
// 1, as another run may have started.
{
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, () => importer.events.push('export')]);
  await first.started;
  importer.lock.onLost('Connection lost: The server closed the connection.');
  assert.match(importer.discord.at(-1), /^The run lost its run lock \(Connection lost/);
  first.finish();

  assert.strictEqual(await run, 1);
  assert.ok(!importer.events.includes('export'));
  assert.strictEqual(
    importer.discord.at(-1),
    'The CBL update run stopped before it finished, as it lost its run lock.'
  );
  assert.deepStrictEqual(importer.events.slice(-2), ['flush', 'release']);
}

// The first reason to stop is the one reported: a run that lost its lock and then received SIGTERM
// still failed.
{
  const importer = await loadRun();
  const first = gatedStep(importer.events, 'import');
  const run = importer.run([first.step, () => importer.events.push('export')]);
  await first.started;
  importer.lock.onLost('Connection lost');
  importer.process.emit('SIGTERM', 'SIGTERM');
  first.finish();
  assert.strictEqual(await run, 1);
  assert.match(importer.discord.at(-1), /as it lost its run lock\.$/);
}

// Steps that delete or export bans check the lock first, and end the run with exit code 1 if it is
// no longer held.
{
  const importer = await loadRun();
  const run = importer.run([
    async () => {
      importer.lock.held = false;
      await importer.control.checkRunLock();
      importer.events.push('export');
    }
  ]);
  assert.strictEqual(await run, 1);
  assert.ok(!importer.events.includes('export'));
  assert.ok(importer.lock.released);
}

console.log(
  'Importer run checks passed: exit codes, the run lock, signals, the time limit and the database wait.'
);
