import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise how an export ban list creates its BattleMetrics ban list and invite, without a
// database or network requests.
const calls = [];
let reply;
async function battlemetrics(method, endpoint, params, data, priority, options) {
  // The options come from the module's own context, so they are copied before comparing.
  calls.push({ method, endpoint, priority, options: options && { ...options } });
  return reply(endpoint);
}

// A stand-in for Sequelize's Model, whose save() records what was saved.
class Model {
  static init() {}

  async save() {
    const { battlemetricsID, battlemetricsInvite } = this;
    calls.push({ saved: { battlemetricsID, battlemetricsInvite } });
  }
}
// Any data type, such as DataTypes.STRING or DataTypes.ENUM(...).
const dataType = () => dataType;

const dependencies = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: {} },
  '../../apis/index.js': { battlemetrics },
  // Deleting lists is checked in delete-export-ban-list.js.
  '../../apis/delete-battlemetrics-ban-list.js': {
    checkOwnership: async () => true,
    removeInvitesAndSubscribers: async () => {},
    removeOwner: async () => {}
  },
  '../../utils/index.js': { Logger: { verbose() {} } },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: '42' }
};
const context = vm.createContext({});
const module = new vm.SourceTextModule(
  await readFile(new URL('../db/models/export-ban-list.js', import.meta.url), 'utf8'),
  { context }
);
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
const ExportBanList = module.namespace.default;

const exportBanList = (fields) =>
  Object.assign(new ExportBanList(), {
    id: 7,
    name: 'Test',
    type: 'battlemetrics',
    battlemetricsID: null,
    battlemetricsInvite: null,
    ...fields
  });
const inviteURL = (code) =>
  `https://www.battlemetrics.com/rcon/ban-lists/accept-invite?code=${code}`;

// A new list gets a BattleMetrics ban list, and then an invite to it. The ban list's POST is not
// marked as repeatable, as BattleMetrics may have created a ban list for one that timed out, but
// the invite's is, as a second invite does no harm.
reply = (endpoint) => ({ data: { data: { id: endpoint === 'ban-lists' ? 'list-1' : 'code-1' } } });
let list = exportBanList();
await list.createBattlemetricsBanList();
assert.deepStrictEqual(calls, [
  { method: 'post', endpoint: 'ban-lists', priority: undefined, options: undefined },
  { saved: { battlemetricsID: 'list-1', battlemetricsInvite: null } },
  {
    method: 'post',
    endpoint: 'ban-lists/list-1/relationships/invites',
    priority: 5,
    options: { repeatable: true }
  },
  { saved: { battlemetricsID: 'list-1', battlemetricsInvite: inviteURL('code-1') } }
]);

// A list whose invite could not be created keeps its ban list, and gets only the invite when it is
// tried again.
calls.length = 0;
reply = () => {
  throw Object.assign(new Error('BattleMetrics POST failed after 3 attempts: HTTP 503'), {
    response: { status: 503, data: {} }
  });
};
list = exportBanList({ battlemetricsID: 'list-2' });
await assert.rejects(list.createBattlemetricsBanList(), /HTTP 503/);
assert.deepStrictEqual([list.battlemetricsID, list.battlemetricsInvite], ['list-2', null]);
reply = () => ({ data: { data: { id: 'code-2' } } });
await list.createBattlemetricsBanList();
assert.deepStrictEqual(
  calls.map((call) => call.endpoint || 'save'),
  ['ban-lists/list-2/relationships/invites', 'ban-lists/list-2/relationships/invites', 'save']
);
assert.strictEqual(list.battlemetricsInvite, inviteURL('code-2'));

// Nothing is created for a list that has its invite, has no BattleMetrics ban list, or is a
// remote list.
calls.length = 0;
for (const fields of [
  { battlemetricsID: 'list-3', battlemetricsInvite: inviteURL('code-3') },
  {},
  { type: 'remote', battlemetricsID: 'list-4' }
])
  await exportBanList(fields).createBattlemetricsInvite();
assert.strictEqual(calls.length, 0);

console.log(
  'Export ban list checks passed: BattleMetrics ban lists, and invites made again when missing.'
);
