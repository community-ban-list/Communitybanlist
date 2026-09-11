import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

const logs = [];
const calls = [];
let list;
let lookupError;
const context = vm.createContext({ console: { error: (...args) => logs.push(args) } });
const dependencies = {
  'scbl-lib/db/models': {
    BanList: {},
    ExportBanListConfig: {},
    ExportBanList: {
      async findOne({ where }) {
        assert.strictEqual(where.id, 42);
        assert.strictEqual(where.owner, 'owner');
        if (lookupError) throw lookupError;
        return list;
      }
    }
  },
  'scbl-lib/utils': { testDiscordWebhook() {} }
};
const source = await readFile(
  new URL('../src/graphql-api/mutation/resolver.js', import.meta.url),
  'utf8'
);
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
const remove = (user = { id: 'owner' }) =>
  module.namespace.default.Mutation.deleteExportBanList(null, { id: 42 }, { user });

list = {
  type: 'battlemetrics',
  async deleteBattlemetricsBanList() {
    calls.push('battlemetrics');
  },
  async destroy() {
    calls.push('database');
  }
};
assert.strictEqual(await remove(), list);
assert.deepStrictEqual(calls, ['battlemetrics', 'database']);
assert.strictEqual(logs.length, 0);

calls.length = 0;
list.type = 'remote';
await remove();
assert.deepStrictEqual(calls, ['database']);

calls.length = 0;
list.type = 'battlemetrics';
const apiError = Object.assign(new Error('Request failed with status code 400'), {
  config: { headers: { Authorization: 'Bearer secret-test-token' } },
  response: {
    status: 400,
    data: { errors: [{ code: 'test', title: 'Bad Request', detail: 'Example rejection detail' }] }
  }
});
list.deleteBattlemetricsBanList = async () => {
  throw apiError;
};
await assert.rejects(remove(), (error) => error === apiError);
assert.strictEqual(calls.length, 0, 'Failed remote deletion must retain the local list');
assert.strictEqual(logs[0][1].status, 400);
assert.strictEqual(logs[0][1].stage, 'battlemetrics');
assert.strictEqual(logs[0][1].errors[0].detail, 'Example rejection detail');
assert.ok(!JSON.stringify(logs).includes('secret-test-token'));

lookupError = new Error('Database unavailable');
await assert.rejects(remove(), (error) => error === lookupError);
assert.strictEqual(logs[1][1].message, 'Database unavailable');
assert.strictEqual(logs[1][1].stage, 'lookup');
lookupError = undefined;

list.type = 'remote';
list.destroy = async () => {
  throw new Error('Deletion failed');
};
await assert.rejects(remove(), /Deletion failed/);
assert.strictEqual(logs[2][1].stage, 'database deletion');

list = null;
await assert.rejects(remove(), /Export ban list does not exist/);
await assert.rejects(remove(null), /Please sign in again/);
assert.strictEqual(logs.length, 5);

console.log('Export ban list deletion checks passed: success, ownership, and error reporting.');
