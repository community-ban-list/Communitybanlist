// Runs the tests, the same way in the pull request checks and in each image's build stage. Run it
// from the repository root, naming the workspaces whose tests to run, or none to run the tests of
// every workspace in package.json that has a test folder:
//
//   node scripts/run-tests.mjs [--timeout <seconds>] [<workspace> ...]
//
// A test is any .js, .mjs or .cjs file in a workspace's test folder or its subfolders, except in a
// helpers folder or under a name that starts with _ or a dot, where tests can keep shared code and
// data. Each test runs on its own, in name order. A test fails when it exits with an error or is
// still running after the time limit, 300 seconds unless --timeout says otherwise; it is then
// stopped, so a test that never finishes cannot hold up a build. Every test runs, and then the
// script lists those that failed and exits with 1. It also exits with 1, before running any test,
// when a workspace has no tests, so a misspelt workspace cannot pass by running nothing.
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { parseArgs } from 'util';

function stop(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    options: { timeout: { type: 'string', default: '300' } },
    allowPositionals: true
  });
} catch (error) {
  stop(error.message);
}
if (!/^[1-9][0-9]*$/.test(args.values.timeout))
  stop(`--timeout takes a whole number of seconds, not ${args.values.timeout}.`);
const seconds = Number(args.values.timeout);

const workspaces =
  args.positionals.length > 0
    ? args.positionals
    : JSON.parse(readFileSync('package.json', 'utf8')).workspaces.filter((workspace) =>
        existsSync(join(workspace, 'test'))
      );
if (workspaces.length === 0) stop('Found no workspace with a test folder.');

// Every test in a folder and its subfolders, in name order.
function findTests(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) =>
      relative(folder, file)
        .split(sep)
        .every((name) => name !== 'helpers' && !/^[_.]/.test(name))
    )
    .sort();
}

const tests = workspaces.flatMap((workspace) => {
  const folder = join(workspace, 'test');
  const found = existsSync(folder) ? findTests(folder) : [];
  if (found.length === 0) stop(`Found no tests in ${folder}.`);
  return found;
});

// Why a finished test run failed, or null when it passed.
function failure(run) {
  if (run.error?.code === 'ETIMEDOUT')
    return `still running after ${seconds} seconds, so it was stopped`;
  if (run.error) return `could not start: ${run.error.message}`;
  if (run.signal) return `stopped by ${run.signal}`;
  if (run.status !== 0) return `exited with code ${run.status}`;
  return null;
}

console.log(`Running ${tests.length} tests from ${workspaces.join(', ')}.`);
const failures = [];
for (const test of tests) {
  console.log(`\n# ${test}`);
  const run = spawnSync(process.execPath, ['--experimental-vm-modules', test], {
    stdio: 'inherit',
    timeout: seconds * 1000,
    // SIGKILL, because a test may handle SIGTERM itself and keep running.
    killSignal: 'SIGKILL'
  });
  const reason = failure(run);
  if (reason) {
    console.error(`FAILED ${test}: ${reason}`);
    failures.push(`${test}: ${reason}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${tests.length} tests failed:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
