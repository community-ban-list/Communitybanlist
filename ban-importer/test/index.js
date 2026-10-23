import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError, { stackTrace } from '../../scbl-lib/utils/describe-error.js';

// Check the importer's entry point, index.js, without a run: it gives the run its steps in order
// and exits with the run's code, or with 1 when the run failed, when a promise failed with nothing
// to handle it, or when the run was left waiting for something that can never happen.

const EXIT_CODES = { FINISHED: 0, FAILED: 1, INTERRUPTED: 3, SKIPPED: 75 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

// Let promise callbacks run.
const settle = () => new Promise(setImmediate);

// Load index.js with stand-ins for the process, the console and the steps, which record their
// calls, and for run.js and loop.js, whose run or service, and ending of a run left waiting, settle
// as the test settles them. The import is a dry run when dryRun is set, as IMPORTER_DRY_RUN makes
// it, and env is the environment, which says whether the importer runs once or as the service.
async function loadIndex({ dryRun = false, env = {} } = {}) {
  const calls = [];
  // The options a step was given besides its counts, as [name, options].
  const options = [];
  const output = [];
  const result = deferred();
  const leftWaiting = deferred();
  let steps = null;
  // Which ran: run.js's run, once, or loop.js's service, and the IMPORTER_MODE read. order also
  // has which service the newest message posted to the log channel is recorded for, in turn.
  const started = [];
  const modes = [];
  const order = [];

  // As in Node, exit() without a code exits with process.exitCode, or 0 if that is not set.
  const fakeProcess = new EventEmitter();
  fakeProcess.env = env;
  fakeProcess.exitCode = undefined;
  fakeProcess.exits = [];
  fakeProcess.exit = (code) => fakeProcess.exits.push(code ?? fakeProcess.exitCode ?? 0);

  // A step that counts what it does is given an object to count in, which it fills in here with
  // its name.
  const step = (name) => async (counts, given) => {
    calls.push(name);
    if (counts) counts.step = name;
    if (given) options.push([name, { ...given }]);
  };
  const dependencies = {
    'scbl-lib/db': { recordLogMessages: (service) => order.push(`record ${service}`) },
    'scbl-lib/utils': { describeError, stackTrace },
    './src/core.js': {
      default: {
        clearOrphanedUsers: step('clearOrphanedUsers'),
        updateReputationPoints: step('updateReputationPoints'),
        updateReputationRank: step('updateReputationRank'),
        exportExportBans: step('exportExportBans')
      }
    },
    './src/expiry.js': { expireBans: step('expireBans') },
    './src/reputation-check.js': { checkReputationPoints: step('checkReputationPoints') },
    './src/steam-profiles.js': { updateSteamUserInfo: step('updateSteamUserInfo') },
    './src/ban-importer.js': {
      default: class {
        constructor() {
          this.dryRun = dryRun;
        }

        async importBans() {
          calls.push('importBans');
        }

        report() {
          calls.push('report');
          return { lists: 2 };
        }
      }
    },
    './src/export-ban-manager.js': {
      default: { updateExportBans: step('updateExportBans') }
    },
    './src/run.js': {
      default: (given) => {
        started.push('run');
        order.push('run');
        steps = given;
        return result.promise;
      },
      EXIT_CODES,
      leftWaiting: () => {
        calls.push('leftWaiting');
        return leftWaiting.promise;
      }
    },
    // The service runs the same steps. IMPORTER_MODE is loop or once, or else invalid.
    './src/loop.js': {
      default: (given) => {
        started.push('loop');
        order.push('loop');
        steps = given;
        return result.promise;
      },
      readMode: (value) => {
        modes.push(value);
        if (value === undefined || value === 'once') return { loop: false };
        if (value === 'loop') return { loop: true };
        return { error: `IMPORTER_MODE must be once or loop, not "${value}".` };
      }
    }
  };

  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess
  });
  const url = new URL('../index.js', import.meta.url);
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

  return {
    calls,
    options,
    output,
    result,
    leftWaiting,
    started,
    modes,
    order,
    process: fakeProcess,
    steps: () => steps
  };
}

// The run is given every step, in order, each named after what it runs, as the run record names
// them. Bans whose expiry has passed are marked expired after the import and before the steps that
// recalculate players, and the reputation check comes right after them, before those steps too.
// The import reports its counts for the record, and the expiry step, the reputation check, the
// Steam step, the export recalculation and the export push count what they do in an object they
// are given, which the record keeps, also when the step fails part-way. Each run of a step counts
// afresh. The Steam step is given how often runs start, which the run gives the steps, and the
// reputation check that and when the run started.
{
  const index = await loadIndex();
  const START = Date.parse('2026-10-23T12:00:00.000Z');
  const names = [
    'importBans',
    'expireBans',
    'checkReputationPoints',
    'updateSteamUserInfo',
    'clearOrphanedUsers',
    'updateReputationPoints',
    'updateReputationRank',
    'updateExportBans',
    'exportExportBans'
  ];
  // Copied into arrays of this test's own, as the steps were made in index.js's context.
  const steps = Array.from(index.steps());
  assert.deepStrictEqual(
    steps.map(({ name }) => name),
    names
  );
  const counted = () =>
    steps.filter((step) => step.counts).map((step) => [step.name, { ...step.counts() }]);
  // Before a counted step runs, it has counted nothing.
  assert.deepStrictEqual(
    steps
      .filter((step) => step.counts && step.name !== 'importBans')
      .map((step) => [step.name, step.counts()]),
    [
      ['expireBans', undefined],
      ['checkReputationPoints', undefined],
      ['updateSteamUserInfo', undefined],
      ['updateExportBans', undefined],
      ['exportExportBans', undefined]
    ]
  );
  for (const step of steps) await step.run({ cadenceSeconds: 3600, startedAt: START });
  assert.deepStrictEqual(index.calls, names);
  assert.deepStrictEqual(index.options, [
    ['checkReputationPoints', { cadenceSeconds: 3600, startedAt: START }],
    ['updateSteamUserInfo', { cadenceSeconds: 3600 }]
  ]);
  assert.deepStrictEqual(counted(), [
    ['importBans', { lists: 2 }],
    ['expireBans', { step: 'expireBans' }],
    ['checkReputationPoints', { step: 'checkReputationPoints' }],
    ['updateSteamUserInfo', { step: 'updateSteamUserInfo' }],
    ['updateExportBans', { step: 'updateExportBans' }],
    ['exportExportBans', { step: 'exportExportBans' }]
  ]);
  for (const step of [steps[1], steps[2], steps[3]]) {
    const first = step.counts();
    await step.run();
    assert.notStrictEqual(step.counts(), first);
  }
}

// A dry run only imports, as every other step writes.
{
  const index = await loadIndex({ dryRun: true });
  const steps = Array.from(index.steps());
  assert.deepStrictEqual(
    steps.map(({ name }) => name),
    ['importBans']
  );
  await steps[0].run();
  assert.deepStrictEqual(index.calls, ['importBans']);
}

// The importer exits with the run's code: 0 finished, 1 failed, 3 stopped part-way and 75 skipped.
for (const code of [0, 1, 3, 75]) {
  const index = await loadIndex();
  index.result.resolve(code);
  await settle();
  assert.deepStrictEqual(index.process.exits, [code]);
  assert.deepStrictEqual(index.output, []);
}

// A promise that fails with nothing to handle it is printed with where it was thrown, and a run
// that then finishes exits 1. One that was stopped or skipped keeps its own code.
for (const [code, exit] of [
  [0, 1],
  [3, 3],
  [75, 75]
]) {
  const index = await loadIndex();
  index.process.emit('unhandledRejection', new Error('Request failed'));
  assert.match(index.output[0], /^Unhandled promise rejection: Error: Request failed\n {4}at /);
  index.result.resolve(code);
  await settle();
  assert.deepStrictEqual(index.process.exits, [exit]);
}

// A run that fails outside its own handling is printed with where it failed, and exits 1.
{
  const index = await loadIndex();
  index.result.reject(new TypeError('Cannot read properties of undefined'));
  await settle();
  assert.match(
    index.output[0],
    /^The CBL update run failed: TypeError: Cannot read properties of undefined\n {4}at /
  );
  assert.deepStrictEqual(index.process.exits, [1]);
}

// Node exits by itself, with code 0, once nothing is left to wait for. If the run has not ended by
// then, it was left waiting for something that can never happen: run.js ends it as failed, with its
// JSON line and record, and the importer exits with the code that gives, rather than 0. Meanwhile
// the exit code is 1, so if ending the run is left waiting too, Node exits 1 when it checks again.
{
  const index = await loadIndex();
  index.process.emit('beforeExit', 0);
  assert.deepStrictEqual(index.calls, ['leftWaiting']);
  assert.strictEqual(index.process.exitCode, 1);
  assert.deepStrictEqual(index.process.exits, []);
  index.process.emit('beforeExit', 1);
  assert.deepStrictEqual(index.calls, ['leftWaiting']);
  index.leftWaiting.resolve(1);
  await settle();
  assert.deepStrictEqual(index.process.exits, [1]);
  assert.deepStrictEqual(index.output, []);
}
{
  // Ending the run that way cannot fail without the importer exiting 1.
  const index = await loadIndex();
  index.process.emit('beforeExit', 0);
  index.leftWaiting.reject(new TypeError('Cannot read properties of undefined'));
  await settle();
  assert.match(
    index.output[0],
    /^The CBL update run failed: TypeError: Cannot read properties of undefined\n {4}at /
  );
  assert.deepStrictEqual(index.process.exits, [1]);
}
{
  // Once the run has ended, its own code stands.
  const index = await loadIndex();
  index.result.resolve(0);
  await settle();
  index.process.emit('beforeExit', 0);
  assert.deepStrictEqual(index.process.exits, [0]);
  assert.deepStrictEqual(index.calls, []);
  assert.deepStrictEqual(index.output, []);
}

// Without IMPORTER_MODE, or with once, the importer runs once, as before. With loop, it runs the
// same steps as the importer service, and exits with the service's code, as it does with a run's.
// Any other value starts nothing: the importer says why and exits 1.
for (const [value, runner] of [
  [undefined, 'run'],
  ['once', 'run'],
  ['loop', 'loop']
]) {
  const index = await loadIndex({ env: value === undefined ? {} : { IMPORTER_MODE: value } });
  assert.deepStrictEqual([index.started, index.modes], [[runner], [value]], `${value}`);
  assert.strictEqual(Array.from(index.steps()).length, 9);
  index.result.resolve(runner === 'loop' ? 0 : 75);
  await settle();
  assert.deepStrictEqual(index.process.exits, [runner === 'loop' ? 0 : 75]);
}
{
  const index = await loadIndex({ env: { IMPORTER_MODE: 'loops' } });
  assert.deepStrictEqual(index.started, []);
  assert.deepStrictEqual(index.output, ['IMPORTER_MODE must be once or loop, not "loops".']);
  assert.deepStrictEqual(index.process.exits, [1]);
  // Node finding nothing left to wait for then is not a run left waiting.
  index.process.emit('beforeExit', 1);
  assert.deepStrictEqual(index.calls, []);
}

// The newest message the importer posts to the log channel is written to the database, as the web
// server's and the bot's are, in both modes, from before the run or the service starts, so the
// importer service, also its next process, can tell whether its status message is still below
// every other.
for (const [env, runner] of [
  [{}, 'run'],
  [{ IMPORTER_MODE: 'loop' }, 'loop']
]) {
  const index = await loadIndex({ env });
  assert.deepStrictEqual(index.order, ['record importer', runner]);
}

console.log(
  'Importer entry point checks passed: the steps, the dry run step, exit codes, unhandled rejections, a run left waiting, IMPORTER_MODE, and the newest message posted recorded.'
);
