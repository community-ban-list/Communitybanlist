// Runs the tests, the same way in the pull request checks and in each image's build stage. Run it
// from the repository root, naming the workspaces whose tests to run, or none to run the tests of
// every workspace in package.json that has a test folder:
//
//   node scripts/run-tests.mjs [--timeout <seconds>] [<workspace> ...]
//
// A test is any .js, .mjs or .cjs file, or link to one, in a workspace's test folder or its
// subfolders, except in a helpers folder or under a name that starts with _ or a dot, where tests
// can keep shared code and data. Each test runs on its own, in name order. A test fails when it
// exits with an error or is still running after the time limit, 120 seconds unless --timeout says
// otherwise. It is then stopped, along with any process it started, so a test that never finishes
// cannot hold up a build. Every test runs, and then the script lists those that failed and exits
// with 1. It also exits with 1, before running any test, when a workspace has no tests, so a
// misspelt workspace cannot pass by running nothing.
import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { constants } from 'os';
import { join, relative, sep } from 'path';
import { parseArgs } from 'util';

function stop(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    options: { timeout: { type: 'string', default: '120' } },
    allowPositionals: true
  });
} catch (error) {
  stop(error.message);
}
if (!/^[1-9][0-9]*$/.test(args.values.timeout))
  stop(`--timeout takes a whole number of seconds, not ${args.values.timeout}.`);
const seconds = Number(args.values.timeout);

// The workspaces in package.json that have a test folder.
function workspacesWithTests() {
  const listed = existsSync('package.json')
    ? (JSON.parse(readFileSync('package.json', 'utf8')).workspaces ?? [])
    : [];
  return listed.filter((workspace) => existsSync(join(workspace, 'test')));
}

// Each workspace once, however it is written: web-server, ./web-server and web-server/ are one.
const workspaces = [
  ...new Set(
    (args.positionals.length > 0 ? args.positionals : workspacesWithTests()).map(
      (workspace) => relative('.', workspace) || '.'
    )
  )
];
if (workspaces.length === 0)
  stop(
    'Found no workspace with a test folder. Run this from the repository root, or name the workspaces.'
  );

// Every test in a folder and its subfolders, in name order. A name in another letter case counts
// too, so a test named x.JS cannot go unnoticed.
function findTests(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.[cm]?js$/i.test(entry.name))
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

// Each test runs in a process group of its own, which a process it starts joins unless it asks for
// a group of its own. When the test ends or is stopped, the whole group is stopped, so nothing it
// started keeps running and holds this script's output open. Windows has no process groups, so
// there only the test itself is stopped.
const ownGroup = process.platform !== 'win32';
let running = null;

// Stops the running test and anything it started. SIGKILL, because a test may handle SIGTERM
// itself and keep running.
function stopRunning() {
  try {
    if (ownGroup) process.kill(-running.pid, 'SIGKILL');
    else running.kill('SIGKILL');
  } catch {
    // Everything in it has ended already.
  }
}

// Ctrl-C signals this script but not the test, which is in a process group of its own. So stop
// the test too, then exit with the status a shell gives for the signal, such as 130 for Ctrl-C.
// The same goes for SIGTERM and SIGHUP.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (running) stopRunning();
    process.exit(128 + constants.signals[signal]);
  });
}

// Runs a test, and resolves with why it failed, or with null when it passed.
function runTest(test) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', test], {
      stdio: 'inherit',
      detached: ownGroup
    });
    running = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopRunning();
    }, seconds * 1000);
    function end(reason) {
      if (running !== child) return;
      clearTimeout(timer);
      stopRunning();
      running = null;
      resolve(reason);
    }
    child.on('error', (error) => end(`could not start: ${error.message}`));
    child.on('close', (status, signal) => {
      if (timedOut) end(`still running after ${seconds} seconds, so it was stopped`);
      else if (signal) end(`stopped by ${signal}`);
      else if (status !== 0) end(`exited with code ${status}`);
      else end(null);
    });
  });
}

console.log(`Running ${tests.length} tests from ${workspaces.join(', ')}.`);
const failures = [];
for (const test of tests) {
  console.log(`\n# ${test}`);
  const reason = await runTest(test);
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
