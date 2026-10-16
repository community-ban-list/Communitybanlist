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
// calls, and for run.js, whose run settles as the test settles it.
async function loadIndex() {
  const calls = [];
  const output = [];
  const result = deferred();
  let steps = null;

  // As in Node, exit() without a code exits with process.exitCode, or 0 if that is not set.
  const fakeProcess = new EventEmitter();
  fakeProcess.exitCode = undefined;
  fakeProcess.exits = [];
  fakeProcess.exit = (code) => fakeProcess.exits.push(code ?? fakeProcess.exitCode ?? 0);

  const step = (name) => async () => calls.push(name);
  const dependencies = {
    'scbl-lib/utils': { describeError, stackTrace },
    './src/core.js': {
      default: {
        updateSteamUserInfo: step('updateSteamUserInfo'),
        clearOrphanedUsers: step('clearOrphanedUsers'),
        updateReputationPoints: step('updateReputationPoints'),
        updateReputationRank: step('updateReputationRank'),
        exportExportBans: step('exportExportBans')
      }
    },
    './src/ban-importer.js': {
      default: class {
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
        steps = given;
        return result.promise;
      },
      EXIT_CODES
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

  return { calls, output, result, process: fakeProcess, steps: () => steps };
}

// The run is given every step, in order, each named after what it runs, as the run record names
// them. The import also reports its counts for the record.
{
  const index = await loadIndex();
  const names = [
    'importBans',
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
  for (const step of steps) await step.run();
  assert.deepStrictEqual(index.calls, names);
  assert.deepStrictEqual(
    steps.filter((step) => step.counts).map((step) => [step.name, { ...step.counts() }]),
    [['importBans', { lists: 2 }]]
  );
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
// then, it was left waiting for something that can never happen, so it exits 1 instead.
{
  const index = await loadIndex();
  index.process.emit('beforeExit', 0);
  assert.deepStrictEqual(index.process.exits, [1]);
  assert.deepStrictEqual(index.output, [
    'The CBL update run failed, as it was left waiting for something that can never happen.'
  ]);
}
{
  // Once the run has ended, its own code stands.
  const index = await loadIndex();
  index.result.resolve(0);
  await settle();
  index.process.emit('beforeExit', 0);
  assert.deepStrictEqual(index.process.exits, [0]);
  assert.deepStrictEqual(index.output, []);
}

console.log(
  'Importer entry point checks passed: the steps, exit codes, unhandled rejections and a run left waiting.'
);
