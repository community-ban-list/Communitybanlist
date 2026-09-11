import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise the API helper without credentials, network requests, or rate-limit delays.
const requests = [];
const jobs = [];
const response = { status: 204 };
const context = vm.createContext({
  console: { log() {}, warn() {} },
  setTimeout() {}
});

class Bottleneck {
  on() {}

  wrap(request) {
    return {
      withOptions(options, ...args) {
        jobs.push(options);
        return request(...args);
      }
    };
  }
}

const dependencies = {
  axios: {
    default: async (request) => {
      requests.push(request);
      return response;
    }
  },
  bottleneck: { default: Bottleneck },
  '../config.js': { BATTLEMETRICS_API_KEY: 'test-token', BATTLEMETRICS_API_RESERVIOR: 10 }
};

const source = await readFile(new URL('../apis/battlemetrics.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source, { context });
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
const battlemetrics = module.namespace.default;

const endpoint = 'ban-lists/01234567-89ab-cdef-0123-456789abcdef/relationships/organizations/42';
assert.strictEqual(await battlemetrics('delete', endpoint), response);
assert.strictEqual(requests[0].method, 'delete');
assert.strictEqual(requests[0].url, `https://api.battlemetrics.com/${endpoint}`);
assert.strictEqual(requests[0].data, undefined, 'Unsubscribe must not send an empty JSON body');
assert.strictEqual(requests[0].headers.Authorization, 'Bearer test-token');
assert.strictEqual(jobs[0].priority, 5);

await battlemetrics('delete', 'bans/42');
assert.strictEqual(requests[1].data, undefined);

const params = { 'page[size]': 10 };
await battlemetrics('get', 'ban-lists', params);
assert.strictEqual(requests[2].params, params);
assert.strictEqual(requests[2].data, undefined);

for (const method of ['post', 'patch']) {
  const payload = { data: { type: 'banList', attributes: { name: 'Test list' } } };
  await battlemetrics(method, 'ban-lists', params, payload, 2);
  assert.strictEqual(requests[requests.length - 1].data, payload);
  assert.strictEqual(jobs[jobs.length - 1].priority, 2);
}

console.log('BattleMetrics request regression checks passed (5 requests).');
