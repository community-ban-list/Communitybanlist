import assert from 'assert';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import vm from 'vm';

const Bottleneck = createRequire(import.meta.url)('bottleneck');

// The budget is read from BATTLEMETRICS_API_RESERVOIR, or from the old, misspelt
// BATTLEMETRICS_API_RESERVIOR when only that is set, along with the name of the variable used.
let configLoads = 0;
async function budgetSetting(env) {
  delete process.env.BATTLEMETRICS_API_RESERVOIR;
  delete process.env.BATTLEMETRICS_API_RESERVIOR;
  Object.assign(process.env, env);
  configLoads++;
  const config = await import(`../config.js?load=${configLoads}`);
  return [config.BATTLEMETRICS_API_RESERVOIR, config.BATTLEMETRICS_API_RESERVOIR_VARIABLE];
}
assert.deepStrictEqual(await budgetSetting({}), [undefined, undefined]);
assert.deepStrictEqual(await budgetSetting({ BATTLEMETRICS_API_RESERVOIR: '120' }), [
  '120',
  'BATTLEMETRICS_API_RESERVOIR'
]);
assert.deepStrictEqual(await budgetSetting({ BATTLEMETRICS_API_RESERVIOR: '20' }), [
  '20',
  'BATTLEMETRICS_API_RESERVIOR'
]);
assert.deepStrictEqual(
  await budgetSetting({ BATTLEMETRICS_API_RESERVOIR: '120', BATTLEMETRICS_API_RESERVIOR: '20' }),
  ['120', 'BATTLEMETRICS_API_RESERVOIR']
);
assert.deepStrictEqual(
  await budgetSetting({ BATTLEMETRICS_API_RESERVOIR: '', BATTLEMETRICS_API_RESERVIOR: '20' }),
  ['20', 'BATTLEMETRICS_API_RESERVIOR']
);

// Load the API client with a budget and a stand-in for axios, which answers with reply(), and
// record what it logs and the limiter it creates.
async function loadClient(path, config, reply = () => ({ status: 200 })) {
  const output = [];
  const limiters = [];
  const requests = [];
  let limiter;
  class RecordingLimiter extends Bottleneck {
    constructor(options) {
      super(options);
      limiters.push(options);
      limiter = this;
    }
  }
  const dependencies = {
    axios: {
      default: async (request) => {
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return reply(requests.length);
      }
    },
    bottleneck: { default: RecordingLimiter },
    '../config.js': config
  };
  const context = vm.createContext({
    console: {
      log: (message) => output.push(message),
      warn: (message) => output.push(message)
    },
    // The waits between attempts are cut short, so the test runs quickly.
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 20)),
    AbortSignal
  });
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    if (specifier.startsWith('./')) {
      const dependency = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(dependency, 'utf8'), {
        context,
        identifier: dependency.href
      });
    }
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
  return { request: module.namespace.default, output, limiters, limiter, requests };
}

const budget = async (
  value,
  variable = value === undefined ? undefined : 'BATTLEMETRICS_API_RESERVOIR'
) => {
  const client = await loadClient('../apis/battlemetrics.js', {
    BATTLEMETRICS_API_KEY: 'test-token',
    BATTLEMETRICS_API_RESERVOIR: value,
    BATTLEMETRICS_API_RESERVOIR_VARIABLE: variable
  });
  const [limiter] = client.limiters;
  assert.strictEqual(limiter.reservoir, limiter.reservoirRefreshAmount);

  // Nothing is reported until the client is used, so services that never use it stay quiet.
  assert.strictEqual(client.output.length, 0);
  await client.request('get', 'bans');
  await client.request('get', 'bans');
  // Keep the budget lines, not the client's per-request logging.
  const lines = client.output.filter((line) => /BattleMetrics budget|Warning/.test(line));
  return { perMinute: limiter.reservoir, output: lines.join('\n') };
};

// Valid budgets are used as given, and the budget in use is reported once, with where it came from.
for (const [value, perMinute, source] of [
  [undefined, 10, /the default, as BATTLEMETRICS_API_RESERVOIR is not set/],
  ['120', 120, /from BATTLEMETRICS_API_RESERVOIR\)/],
  [' 30 ', 30, /from BATTLEMETRICS_API_RESERVOIR\)/]
]) {
  const result = await budget(value);
  assert.strictEqual(result.perMinute, perMinute, `Budget for ${JSON.stringify(value)}`);
  assert.match(result.output, new RegExp(`^BattleMetrics budget: ${perMinute} requests a minute`));
  assert.match(result.output, source);
  assert.doesNotMatch(result.output, /Warning/);
  assert.strictEqual(result.output.split('\n').length, 1);
}
const oldName = await budget('20', 'BATTLEMETRICS_API_RESERVIOR');
assert.strictEqual(oldName.perMinute, 20);
assert.match(oldName.output, /from BATTLEMETRICS_API_RESERVIOR, the old spelling/);

// An invalid budget would stop every request, so the default is used, with a warning that names
// the variable it came from.
for (const value of ['0', '-5', '12.5', 'abc']) {
  const result = await budget(value);
  assert.strictEqual(result.perMinute, 10, `Budget for ${JSON.stringify(value)}`);
  assert.match(
    result.output,
    /Warning: BATTLEMETRICS_API_RESERVOIR must be a whole number above 0/
  );
}
const invalidOldName = await budget('abc', 'BATTLEMETRICS_API_RESERVIOR');
assert.match(invalidOldName.output, /Warning: BATTLEMETRICS_API_RESERVIOR must be a whole number/);

// High budgets are allowed, with warnings about BattleMetrics' 300 a minute and the client's
// spacing between requests.
const high = await budget('250');
assert.strictEqual(high.perMinute, 250);
assert.match(high.output, /leaves little of BattleMetrics' 300 requests a minute/);
assert.doesNotMatch(high.output, /no more than about/);
const faster = await budget('290');
assert.match(faster.output, /no more than about 280 are sent a minute/);
const over = await budget('400');
assert.match(over.output, /is over BattleMetrics' limit of 300 requests a minute/);
assert.doesNotMatch(over.output, /leaves little/);

// Requests made at the same time all go through the real limiter, one after another, instead of
// being rejected for sharing a job ID.
const battlemetrics = await loadClient('../apis/battlemetrics.js', {
  BATTLEMETRICS_API_KEY: 'test-token',
  BATTLEMETRICS_API_RESERVOIR: '60',
  BATTLEMETRICS_API_RESERVOIR_VARIABLE: 'BATTLEMETRICS_API_RESERVOIR'
});
const results = await Promise.allSettled(
  [1, 2, 3].map((id) => battlemetrics.request('get', `bans/${id}`))
);
assert.deepStrictEqual(
  results.map((result) => result.status),
  ['fulfilled', 'fulfilled', 'fulfilled']
);
assert.strictEqual(battlemetrics.requests.length, 3);

const steam = await loadClient('../apis/steam.js', { STEAM_API_KEY: 'test-key' });
const steamResults = await Promise.allSettled(
  [1, 2].map(() => steam.request('get', 'ISteamUser/GetPlayerSummaries/v2', {}))
);
assert.deepStrictEqual(
  steamResults.map((result) => result.status),
  ['fulfilled', 'fulfilled']
);

// Each attempt at a request takes from the budget like any other request, so a request that is
// made three times leaves three fewer.
const retried = await loadClient(
  '../apis/battlemetrics.js',
  {
    BATTLEMETRICS_API_KEY: 'test-token',
    BATTLEMETRICS_API_RESERVOIR: '10',
    BATTLEMETRICS_API_RESERVOIR_VARIABLE: 'BATTLEMETRICS_API_RESERVOIR'
  },
  (count) => {
    if (count < 3) throw Object.assign(new Error('Unavailable'), { response: { status: 503 } });
    return { status: 200 };
  }
);
assert.strictEqual((await retried.request('get', 'bans')).status, 200);
assert.strictEqual(retried.requests.length, 3);
assert.strictEqual(await retried.limiter.currentReservoir(), 7);

console.log(
  'BattleMetrics budget checks passed: settings, invalid values, concurrent requests and retries.'
);
