import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import Validators from '../../scbl-lib/validators.js';

// Exercise how creating and saving export ban lists handles BattleMetrics failures, without a
// database or network requests.
const logs = [];
const calls = [];
// The list createExportBanList creates, and the one updateExportBanList finds.
let created;
const found = {
  id: 11,
  type: 'battlemetrics',
  battlemetricsID: 'list-11',
  battlemetricsInvite: null,
  async save() {
    calls.push(`save ${this.name}`);
  },
  async createBattlemetricsInvite() {
    calls.push('invite');
  }
};
const context = vm.createContext({ console: { error: (...args) => logs.push(args) } });
const dependencies = {
  // The limits on export ban lists, with no limit on their players.
  'scbl-lib/config': {
    EXPORT_LIST_LIMITS: exportListLimits.readLimits({
      EXPORT_BM_MAX_PLAYERS: '0',
      EXPORT_REMOTE_MAX_PLAYERS: '0'
    }).limits
  },
  'scbl-lib/export-list-limits': exportListLimits,
  'scbl-lib/validators': { default: Validators },
  'scbl-lib/db/models': {
    BanList: {},
    ExportBanListConfig: {},
    Organisation: {},
    ExportBanList: {
      count: async () => 0,
      // A list is never created in a transaction, which its BattleMetrics ban list's save would
      // wait on.
      create: async (fields, options) => {
        assert.strictEqual(options, undefined);
        return Object.assign(created, fields);
      },
      findOne: async () => found
    }
  },
  'scbl-lib/utils': { isDiscordWebhookUrl() {}, testDiscordWebhook() {} }
};
const url = new URL('../src/graphql-api/mutation/resolver.js', import.meta.url);
const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
  context,
  identifier: url.href
});
await module.link(async (specifier, referencingModule) => {
  // Relative imports load the real files.
  if (specifier.startsWith('.')) {
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
const { Mutation } = module.namespace.default;
const user = { user: { id: 'owner' } };
const create = (type = 'battlemetrics') =>
  Mutation.createExportBanList(null, { name: 'Test', server: 'Server', type }, user);
const update = () => Mutation.updateExportBanList(null, { id: 11, name: 'New name' }, user);

// The logged details, copied out of the module's context to compare them.
const logged = () =>
  logs.map(([description, details]) => [description, JSON.parse(JSON.stringify(details))]);

// An error as the BattleMetrics client throws one. Its config stands for anything else an error
// could hold, which must not be logged.
function apiError(message, status, extra = {}) {
  return Object.assign(new Error(message), {
    name: 'ApiError',
    status,
    response: {
      status,
      data: { errors: [{ code: 'test', title: 'Bad Gateway', detail: 'Example' }] }
    },
    config: { headers: { Authorization: 'Bearer secret-test-token' } },
    ...extra
  });
}

// When BattleMetrics fails to create the ban list, the web server logs which list it was and that
// BattleMetrics may have created a ban list anyway. The list could never be used without one, so
// it is deleted, without a transaction, and the owner is told that it was not created.
const listError = apiError(
  'BattleMetrics POST ban-lists failed: HTTP 502 (Bad Gateway), so it may have been carried out',
  502,
  { ambiguous: true }
);
const deletions = [];
created = {
  id: 9,
  battlemetricsID: null,
  async createBattlemetricsBanList() {
    throw listError;
  },
  async destroy(...args) {
    deletions.push({ id: this.id, args: args.length });
  }
};
await assert.rejects(create(), {
  message:
    'BattleMetrics could not create a ban list for your export ban list, so it was not created. Please try again later.'
});
assert.deepStrictEqual(deletions, [{ id: 9, args: 0 }]);
assert.deepStrictEqual(logged(), [
  [
    'Failed to create the BattleMetrics ban list for export ban list:',
    {
      exportBanListID: 9,
      battlemetricsID: null,
      name: 'ApiError',
      message: listError.message,
      status: 502,
      ambiguous: true,
      errors: [{ code: 'test', title: 'Bad Gateway', detail: 'Example' }]
    }
  ]
]);
assert.ok(!JSON.stringify(logged()).includes('secret-test-token'));

// If the list cannot be deleted either, that is logged too, and the owner is asked to delete it.
logs.length = 0;
created = {
  id: 13,
  battlemetricsID: null,
  async createBattlemetricsBanList() {
    throw listError;
  },
  async destroy() {
    throw new Error('Database unavailable');
  }
};
await assert.rejects(create(), {
  message:
    'BattleMetrics could not create a ban list for your export ban list. Please delete it and try again later.'
});
assert.deepStrictEqual(
  logged().map(([description]) => description),
  [
    'Failed to create the BattleMetrics ban list for export ban list:',
    'Failed to delete the export ban list with no BattleMetrics ban list:'
  ]
);
assert.deepStrictEqual(logged()[1][1], {
  exportBanListID: 13,
  name: 'Error',
  message: 'Database unavailable'
});

// When only the invite fails, the list keeps its BattleMetrics ban list and the owner gets the
// error, and the log gives the BattleMetrics ban list that was created.
logs.length = 0;
deletions.length = 0;
const inviteError = apiError(
  'BattleMetrics POST ban-lists/list-10/relationships/invites failed after 3 attempts: HTTP 502',
  502,
  { ambiguous: false }
);
created = {
  id: 10,
  battlemetricsID: null,
  async createBattlemetricsBanList() {
    this.battlemetricsID = 'list-10';
    throw inviteError;
  },
  async destroy() {
    deletions.push(this.id);
  }
};
await assert.rejects(create(), (error) => error === inviteError);
assert.deepStrictEqual(deletions, []);
assert.strictEqual(logs.length, 1);
assert.strictEqual(logged()[0][1].battlemetricsID, 'list-10');
assert.strictEqual(logged()[0][1].ambiguous, false);

// A list made without trouble is returned, and nothing is logged. A remote list makes no
// BattleMetrics requests.
logs.length = 0;
for (const type of ['battlemetrics', 'remote']) {
  let requests = 0;
  created = {
    id: 12,
    async createBattlemetricsBanList() {
      requests++;
    }
  };
  assert.strictEqual(await create(type), created);
  assert.strictEqual(requests, type === 'battlemetrics' ? 1 : 0);
}
assert.strictEqual(logs.length, 0);

// Saving a list also creates its invite if it is missing, after the changes are saved.
assert.strictEqual(await update(), found);
assert.deepStrictEqual(calls, ['save New name', 'invite']);
assert.strictEqual(logs.length, 0);

// When the invite still cannot be created, the saved changes stand, and the failure is logged.
found.createBattlemetricsInvite = async () => {
  throw inviteError;
};
assert.strictEqual(await update(), found);
assert.deepStrictEqual(
  logged().map(([description, { exportBanListID, battlemetricsID, status }]) => [
    description,
    exportBanListID,
    battlemetricsID,
    status
  ]),
  [['Failed to create the BattleMetrics invite for export ban list:', 11, 'list-11', 502]]
);
assert.ok(!JSON.stringify(logged()).includes('secret-test-token'));

console.log(
  'BattleMetrics export ban list checks passed: failed creations are logged and their lists deleted, and missing invites are made on save.'
);
