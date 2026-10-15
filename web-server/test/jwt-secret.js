import assert from 'assert';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import checkJwtSecret from '../src/jwt-secret.js';

// The placeholder the repository used to fall back to. It is public, so it must never be used.
const PLACEHOLDER =
  'Pnc56tlFrlsahFsGt1efxepEZ1xSOBPIcDUZiEhv-UidVDA4Upg7Ao1t8DJFtMo3U-R7hx_rX_okBQBPfthwS428PlQUZmHQgdEMuXb8yktxDhFhzJNzA-hL1mdyJoqhIEUwrL_QtVGrUlrgWpA84fGiGZwubPQYpF1zAD_nHjLkjffxTCidWXJnZNV8IHmju2ZJzKvO6tvbZNrAN6IFWAOtnVYTBiI21vIuC-tpz57x5mS_5XNuiprre0kM4TahVNbc1fhFyvOacaUkbPW82Kj9vgGYzuVBeNnEZYC4zd4UWGJNnLYGKH1yoiHP6QdDgFhqMH4EljZhTvK-NSHOtw';

// A missing, empty or published secret stops the web server, including the placeholder pasted
// with surrounding whitespace or quotes.
for (const secret of [
  undefined,
  null,
  '',
  '   ',
  PLACEHOLDER,
  `${PLACEHOLDER}\n`,
  `${PLACEHOLDER}\r`,
  ` ${PLACEHOLDER} `,
  `"${PLACEHOLDER}"`,
  `'${PLACEHOLDER}'`
]) {
  const problem = checkJwtSecret(secret);
  assert.ok(problem && problem.fatal, `Should refuse ${JSON.stringify(secret)}`);
}
assert.match(checkJwtSecret(undefined).message, /not set/);
assert.match(checkJwtSecret(PLACEHOLDER).message, /placeholder/);

// A short secret only warns, so a working production secret never stops the server. Padding does
// not count towards the length.
for (const secret of ['short-but-private', `  ${'x'.repeat(31)}  `]) {
  const short = checkJwtSecret(secret);
  assert.ok(short && !short.fatal, `Should warn about ${JSON.stringify(secret)}`);
  assert.match(short.message, /shorter than 32 characters/);
}

// A long private secret is fine, and no message ever includes the secret.
assert.strictEqual(checkJwtSecret('y6Jz2mJ0rN8vW4qL1tP9sB3xC7kD5hF0gR2aE6uI8oQ='), null);
assert.ok(!checkJwtSecret('short-but-private').message.includes('short-but-private'));

// The web server itself exits before connecting to the database when the secret is missing.
const env = {
  ...process.env,
  DATABASE_URI: 'mysql://test:test@127.0.0.1:1/test',
  BATTLEMETRICS_API_KEY: 'test',
  STEAM_API_KEY: 'test',
  PORT: '0'
};
delete env.JWT_AUTH_SECRET;
const index = fileURLToPath(new URL('../index.js', import.meta.url));
for (const secret of [undefined, '', '   ']) {
  const run = spawnSync(process.execPath, [index], {
    env: secret === undefined ? env : { ...env, JWT_AUTH_SECRET: secret },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.strictEqual(run.status, 1, `Should exit 1 with ${JSON.stringify(secret)}`);
  assert.match(run.stderr, /cannot start: JWT_AUTH_SECRET is not set/);
  assert.doesNotMatch(run.stdout, /Connecting to the CBL database|Server started/);
}

console.log('JWT secret checks passed: missing, placeholder, short and long secrets, and startup.');
