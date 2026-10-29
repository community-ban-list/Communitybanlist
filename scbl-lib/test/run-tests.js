import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { constants, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// scripts/run-tests.mjs runs every workspace's tests in the pull request checks and in the image
// builds, so a test it skipped or let pass would never be noticed. This test is in scbl-lib/test
// because every image build runs scbl-lib's tests, as the pull request checks do, so all of them
// check the script too. It runs the script on made-up workspaces in a temporary folder.
const runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'run-tests-'));

function write(files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

// Runs the script from a folder, with the environment variables given added to its own, which the
// script passes on to each test and a test to the processes it starts. Its output comes through a
// pipe, as in CI, so the run ends only when every process holding the pipe open has ended.
function runFrom(folder, args = [], env = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: folder,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000
  });
  const output = result.stdout + result.stderr;
  return {
    status: result.status,
    output,
    ran: output.match(/^ran .*$/gm) ?? [],
    tests: output.match(/^# .*$/gm) ?? [],
    took: Date.now() - started
  };
}

const run = (...args) => runFrom(root, args);
// Made-up tests that log "ran" and the name of their file without its extension, so a.mjs logs
// "ran a", and then pass or fail. Every made-up test's code is fixed, with no value written into
// it: what a test needs to know comes from its file's name or from the environment.
const passes = String.raw`console.log('ran', process.argv[1].split(/[\\/]/).pop().split('.')[0]);`;
const fails = String.raw`console.log('ran', process.argv[1].split(/[\\/]/).pop().split('.')[0]); process.exit(3);`;

try {
  // Shared code for the made-up tests, outside any made-up workspace. writer.cjs writes the file
  // WRITES_LATER_FILE names after 2 seconds, unless it is stopped first, and then ends.
  // starts-writer.cjs starts a process running writer.cjs, which holds the output open while it
  // runs, and exports it.
  write({
    'helpers/writer.cjs':
      "setTimeout(() => require('fs').writeFileSync(process.env.WRITES_LATER_FILE, ''), 2000);",
    'helpers/starts-writer.cjs':
      "module.exports = require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'writer.cjs')], { stdio: 'inherit' });"
  });

  // Tests in subfolders, and .mjs and .cjs files, run in name order. Helpers folders, and files and
  // folders whose names start with _ or a dot, hold shared code and are left out.
  write({
    'one/test/b.js': passes,
    'one/test/a.mjs': passes,
    'one/test/sub/deeper/c.cjs': passes,
    'one/test/helpers/shared.js': fails,
    'one/test/sub/helpers/shared.mjs': fails,
    'one/test/_shared.js': fails,
    'one/test/_data/fixture.js': fails,
    'one/test/.hidden.js': fails,
    'one/test/data.json': '{}'
  });
  let result = run('one');
  assert.strictEqual(result.status, 0, result.output);
  assert.deepStrictEqual(result.ran, ['ran a', 'ran b', 'ran c']);
  assert.deepStrictEqual(result.tests, [
    '# one/test/a.mjs',
    '# one/test/b.js',
    '# one/test/sub/deeper/c.cjs'
  ]);
  assert.match(result.output, /All 3 tests passed\./);

  // A workspace named twice, however it is written, runs once.
  result = run('one', './one/');
  assert.strictEqual(result.status, 0, result.output);
  assert.deepStrictEqual(result.ran, ['ran a', 'ran b', 'ran c']);
  assert.match(result.output, /Running 3 tests from one\./);

  // A link to a test runs it, and a name in another letter case counts too.
  write({ 'linked/elsewhere/linked.js': fails, 'linked/test/UPPER.JS': passes });
  symlinkSync('../elsewhere/linked.js', join(root, 'linked/test/linked.js'));
  result = run('linked');
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran UPPER', 'ran linked']);
  assert.match(result.output, /linked\/test\/linked\.js: exited with code 3/);

  // A failing test in a subfolder fails the run, after every other test has run.
  write({
    'two/test/ok.js': passes,
    'two/test/sub/broken.mjs': fails,
    'two/test/zz.js': passes
  });
  result = run('two', 'one');
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran ok', 'ran broken', 'ran zz', 'ran a', 'ran b', 'ran c']);
  assert.match(
    result.output,
    /1 of 6 tests failed:\n {2}two\/test\/sub\/broken\.mjs: exited with code 3/
  );

  // So does a test killed by a signal, and the tests after it still run.
  write({
    'killed/test/a.js': "process.kill(process.pid, 'SIGKILL');",
    'killed/test/b.js': passes
  });
  result = run('killed');
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran b']);
  assert.match(result.output, /killed\/test\/a\.js: stopped by SIGKILL/);

  // The checks below pass when writer.cjs never writes its file. So first, a test that waits for its
  // writer shows that the file WRITES_LATER_FILE names reaches writer.cjs through the script, and is
  // written when nothing stops it.
  const writtenForWaitingTest = join(root, 'waiting-test-process-wrote');
  write({ 'waits/test/a.cjs': "require('../../helpers/starts-writer.cjs');" });
  result = runFrom(root, ['waits'], { WRITES_LATER_FILE: writtenForWaitingTest });
  assert.strictEqual(result.status, 0, result.output);
  assert.ok(existsSync(writtenForWaitingTest), 'the writer did not write its file');

  // A process a test started and left running is stopped when the test ends. Had it kept running,
  // the run would have ended only once it had written its file.
  const leftByPassingTest = join(root, 'passing-test-process-ran-on');
  write({ 'leaves/test/a.cjs': "require('../../helpers/starts-writer.cjs').unref();" });
  result = runFrom(root, ['leaves'], { WRITES_LATER_FILE: leftByPassingTest });
  assert.strictEqual(result.status, 0, result.output);
  assert.ok(!existsSync(leftByPassingTest), 'a process the test left running kept running');

  // A test still running at the time limit is stopped, even one that ignores SIGTERM, and fails
  // the run; the tests after it still run. Left alone, it would pass after 30 seconds. A process it
  // started is stopped with it.
  const leftByStoppedTest = join(root, 'stopped-test-process-ran-on');
  write({
    'three/test/hangs.cjs':
      "require('../../helpers/starts-writer.cjs'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 30000);",
    'three/test/next.js': passes
  });
  result = runFrom(root, ['--timeout', '1', 'three'], { WRITES_LATER_FILE: leftByStoppedTest });
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran next']);
  assert.match(
    result.output,
    /three\/test\/hangs\.cjs: still running after 1 seconds, so it was stopped/
  );
  assert.ok(!existsSync(leftByStoppedTest), 'a process the stopped test started kept running');
  assert.ok(result.took < 20000, `took ${result.took} ms`);

  // Ctrl-C, SIGTERM or SIGHUP ends the run, without running the next test, and stops the test
  // running then, which is in a process group of its own and so is not signalled itself. The test
  // sends the script the signal SIGNAL_TO_SEND names, then runs writer.cjs itself.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const leftByTest = join(root, `${signal}-test-ran-on`);
    write({
      [`${signal}/test/a.cjs`]:
        "process.kill(process.ppid, process.env.SIGNAL_TO_SEND); require('../../helpers/writer.cjs');",
      [`${signal}/test/b.js`]: passes
    });
    result = runFrom(root, [signal], { SIGNAL_TO_SEND: signal, WRITES_LATER_FILE: leftByTest });
    assert.strictEqual(result.status, 128 + constants.signals[signal], result.output);
    assert.deepStrictEqual(result.ran, []);
    assert.ok(!existsSync(leftByTest), `the test kept running after ${signal}`);
  }

  // A workspace without tests, such as a misspelt one, fails the run before any test runs.
  write({ 'four/test/helpers/shared.js': passes });
  for (const [args, folder] of [
    [['missing'], 'missing/test'],
    [['four'], 'four/test'],
    [['one', 'missing'], 'missing/test']
  ]) {
    result = run(...args);
    assert.strictEqual(result.status, 1, result.output);
    assert.match(result.output, new RegExp(`Found no tests in ${folder}\\.`));
    assert.deepStrictEqual(result.ran, []);
  }

  // So does a time limit that is not a whole number of seconds.
  for (const timeout of ['0', '1.5', 'soon']) {
    result = run('--timeout', timeout, 'one');
    assert.strictEqual(result.status, 1, result.output);
    assert.match(result.output, /--timeout takes a whole number of seconds/);
    assert.deepStrictEqual(result.ran, []);
  }

  // With no workspace named, run from a folder without a package.json, it says where to run it.
  result = runFrom(join(root, 'one'));
  assert.strictEqual(result.status, 1, result.output);
  assert.match(
    result.output,
    /Found no workspace with a test folder\. Run this from the repository/
  );
  assert.deepStrictEqual(result.ran, []);

  // Run from the root, it runs the tests of each workspace in package.json with a test folder.
  write({ 'package.json': JSON.stringify({ workspaces: ['client', 'one'] }) });
  result = run();
  assert.strictEqual(result.status, 0, result.output);
  assert.deepStrictEqual(result.ran, ['ran a', 'ran b', 'ran c']);
  assert.match(result.output, /Running 3 tests from one\./);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  'Test runner checks passed: subfolders, file types, left-out files, failures, time limit, signals and workspaces.'
);
