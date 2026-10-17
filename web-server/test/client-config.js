import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { DEFAULT_LIMITS } from '../../scbl-lib/export-list-limits.js';

// Checks /config.js, which gives the client the settings set with the web server's environment
// variables: the links it shows, and the limits on export ban lists that its forms check changes
// against. The client is built before the web server runs, so it can only get them this way.

const VARIABLES = [
  'DISCORD_INVITE',
  'INTAKE_FORM',
  'EXPORT_BM_MAX_PLAYERS',
  'EXPORT_REMOTE_MAX_PLAYERS',
  'EXPORT_BM_MIN_THRESHOLD',
  'EXPORT_REMOTE_MIN_THRESHOLD',
  'EXPORT_BM_NEVER_ENOUGH',
  'EXPORT_REMOTE_NEVER_ENOUGH'
];

// Load scbl-lib/config.js afresh with these environment variables, as each service does when it
// starts. Each load is a fresh copy of the file.
let loads = 0;
async function configFrom(env) {
  for (const variable of VARIABLES) delete process.env[variable];
  Object.assign(process.env, env);
  loads++;
  return import(`../../scbl-lib/config.js?load=${loads}`);
}

// The body of /config.js that the web server serves when it starts with these variables.
async function bodyFrom(env) {
  const config = await configFrom(env);
  const url = new URL('../src/client-config.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  await module.link((specifier) => {
    assert.strictEqual(specifier, 'scbl-lib/config', `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(config), function () {
      for (const [name, value] of Object.entries(config)) this.setExport(name, value);
    });
  });
  await module.evaluate();
  const body = module.namespace.default;
  assert.strictEqual(typeof body, 'string');
  return body;
}

// What a browser gets from the body, which it runs as a script before the client starts: the
// settings it sets window.CBL_CONFIG to. They are read back as plain values of this context.
function run(body) {
  const window = {};
  vm.runInNewContext(body, { window });
  assert.deepStrictEqual(Object.keys(window), ['CBL_CONFIG']);
  return JSON.parse(JSON.stringify(window.CBL_CONFIG));
}

// The limits the client reads in a browser that ran the body, or none, as scbl-lib/config.js reads
// them there. The browser has no environment variables, so these are cleared.
async function clientLimits(served) {
  globalThis.CBL_CONFIG = served;
  try {
    return (await configFrom({})).EXPORT_LIST_LIMITS;
  } finally {
    delete globalThis.CBL_CONFIG;
  }
}

// With no variables set, the body gives the default limits, and no links.
const defaults = await bodyFrom({});
assert.strictEqual(
  defaults,
  `window.CBL_CONFIG = ${JSON.stringify({ EXPORT_LIST_LIMITS: DEFAULT_LIMITS })};\n`
);
assert.deepStrictEqual(run(defaults), { EXPORT_LIST_LIMITS: DEFAULT_LIMITS });

// The links and limits set with the variables, with the limits as the web server reads them:
// numbers, a limit of 0 players for no limit, and the rules in lower case.
const set = {
  DISCORD_INVITE: 'https://discord.gg/example',
  INTAKE_FORM: 'https://forms.example.com/apply',
  EXPORT_BM_MAX_PLAYERS: '0',
  EXPORT_REMOTE_MAX_PLAYERS: '50000',
  EXPORT_BM_MIN_THRESHOLD: '6',
  EXPORT_REMOTE_MIN_THRESHOLD: ' 1 ',
  EXPORT_BM_NEVER_ENOUGH: 'one-ban',
  EXPORT_REMOTE_NEVER_ENOUGH: 'NONE'
};
const setLimits = {
  battlemetrics: { maxPlayers: 0, minThreshold: 6, neverEnough: 'one-ban' },
  remote: { maxPlayers: 50000, minThreshold: 1, neverEnough: 'none' }
};
const served = run(await bodyFrom(set));
assert.deepStrictEqual(served, {
  DISCORD_INVITE: set.DISCORD_INVITE,
  INTAKE_FORM: set.INTAKE_FORM,
  EXPORT_LIST_LIMITS: setLimits
});
// They are the limits the web server checks changes against.
assert.deepStrictEqual((await configFrom(set)).EXPORT_LIST_LIMITS, setLimits);

// Values that cannot be used never stop the body being made: limits that cannot be used are the
// defaults, as the web server uses them, and links are passed on exactly as they are set.
const odd = 'https://example.com/"quoted"\\path</script><script>\u2028\u2029?a=1&b=\u{1F600}';
const junk = {
  DISCORD_INVITE: odd,
  INTAKE_FORM: '  ',
  EXPORT_BM_MAX_PLAYERS: 'lots',
  EXPORT_REMOTE_MAX_PLAYERS: '-1',
  EXPORT_BM_MIN_THRESHOLD: '0',
  EXPORT_REMOTE_MIN_THRESHOLD: '1e3',
  EXPORT_BM_NEVER_ENOUGH: 'two-bans',
  EXPORT_REMOTE_NEVER_ENOUGH: '{"maxPlayers": 1}'
};
assert.deepStrictEqual(run(await bodyFrom(junk)), {
  DISCORD_INVITE: odd,
  INTAKE_FORM: '  ',
  EXPORT_LIST_LIMITS: DEFAULT_LIMITS
});
assert.strictEqual((await configFrom(junk)).EXPORT_LIST_LIMIT_PROBLEMS.length, 6);
for (const value of ['', '   ', '9'.repeat(400), '\t\n', 'NaN', 'undefined'])
  assert.deepStrictEqual(
    run(await bodyFrom(Object.fromEntries(VARIABLES.map((name) => [name, value]))))
      .EXPORT_LIST_LIMITS,
    DEFAULT_LIMITS,
    JSON.stringify(value)
  );

// The client reads the limits the web server served, as they are: a limit of 0 players stays 0.
assert.deepStrictEqual(await clientLimits(served), setLimits);
const served0 = run(await bodyFrom({ EXPORT_BM_MAX_PLAYERS: '0', EXPORT_REMOTE_MAX_PLAYERS: '0' }));
assert.deepStrictEqual(await clientLimits(served0), {
  battlemetrics: { ...DEFAULT_LIMITS.battlemetrics, maxPlayers: 0 },
  remote: { ...DEFAULT_LIMITS.remote, maxPlayers: 0 }
});
// If /config.js did not load, or came from a web server that does not serve the limits, the
// client uses the defaults, and the web server's checks still apply.
assert.deepStrictEqual(await clientLimits(undefined), DEFAULT_LIMITS);
assert.deepStrictEqual(await clientLimits({ DISCORD_INVITE: set.DISCORD_INVITE }), DEFAULT_LIMITS);
// Elsewhere, where /config.js is never run, the limits come from the environment as before.
assert.deepStrictEqual((await configFrom({ EXPORT_BM_MAX_PLAYERS: '0' })).EXPORT_LIST_LIMITS, {
  ...DEFAULT_LIMITS,
  battlemetrics: { ...DEFAULT_LIMITS.battlemetrics, maxPlayers: 0 }
});

for (const variable of VARIABLES) delete process.env[variable];

console.log(
  'Client config checks passed: /config.js gives the links and the limits the web server reads, never fails on values it cannot use, and the client reads the limits as given.'
);
