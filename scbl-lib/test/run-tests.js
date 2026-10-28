import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// scripts/run-tests.mjs runs every workspace's tests in the pull request checks and in the image
// builds, so a test it skipped or let pass would never be noticed. It runs here on made-up
// workspaces in a temporary folder.
const runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'run-tests-'));

function write(files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

function run(...args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: 'utf8',
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

const passes = (name) => `console.log('ran ${name}');`;
const fails = (name) => `console.log('ran ${name}'); process.exit(3);`;

try {
  // Tests in subfolders, and .mjs and .cjs files, run in name order. Helpers folders, and files and
  // folders whose names start with _ or a dot, hold shared code and are left out.
  write({
    'one/test/b.js': passes('b'),
    'one/test/a.mjs': passes('a'),
    'one/test/sub/deeper/c.cjs': passes('c'),
    'one/test/helpers/shared.js': fails('helpers'),
    'one/test/sub/helpers/shared.mjs': fails('nested helpers'),
    'one/test/_shared.js': fails('_shared'),
    'one/test/_data/fixture.js': fails('_data'),
    'one/test/.hidden.js': fails('.hidden'),
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

  // A failing test in a subfolder fails the run, after every other test has run.
  write({
    'two/test/ok.js': passes('ok'),
    'two/test/sub/broken.mjs': fails('broken'),
    'two/test/zz.js': passes('zz')
  });
  result = run('two', 'one');
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran ok', 'ran broken', 'ran zz', 'ran a', 'ran b', 'ran c']);
  assert.match(
    result.output,
    /1 of 6 tests failed:\n {2}two\/test\/sub\/broken\.mjs: exited with code 3/
  );

  // A test still running at the time limit is stopped, even one that ignores SIGTERM, and fails
  // the run; the tests after it still run. Left alone, it would pass after 30 seconds.
  write({
    'three/test/hangs.js':
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 30000);",
    'three/test/next.js': passes('next')
  });
  result = run('--timeout', '1', 'three');
  assert.strictEqual(result.status, 1, result.output);
  assert.deepStrictEqual(result.ran, ['ran next']);
  assert.match(
    result.output,
    /three\/test\/hangs\.js: still running after 1 seconds, so it was stopped/
  );
  assert.ok(result.took < 20000, `took ${result.took} ms`);

  // A workspace without tests, such as a misspelt one, fails the run before any test runs.
  write({ 'four/test/helpers/shared.js': passes('helper') });
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

  // With no workspace named, it runs the tests of each workspace in package.json with a test folder.
  write({ 'package.json': JSON.stringify({ workspaces: ['client', 'one'] }) });
  result = run();
  assert.strictEqual(result.status, 0, result.output);
  assert.deepStrictEqual(result.ran, ['ran a', 'ran b', 'ran c']);
  assert.match(result.output, /Running 3 tests from one\./);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  'Test runner checks passed: subfolders, file types, left-out files, failures, time limit and workspaces.'
);
