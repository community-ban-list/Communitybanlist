import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import describeError from '../../scbl-lib/utils/describe-error.js';
import Validators from '../../scbl-lib/validators.js';

const logs = [];
const calls = [];
// The lines posted to the log channel, as the logger posts them: the line, then its errors, each
// described in a line by describeError.
const posted = [];
const Logger = {
  verbose(module, level, message, ...extras) {
    if (level !== 1) return;
    const errors = extras.filter((extra) => typeof extra?.message === 'string');
    let text = `${message}`;
    if (errors.length > 0)
      text += `${/\s$/.test(text) ? '' : ' '}${errors.map(describeError).join(', ')}`;
    posted.push(`[${module}][${level}] ${text}`);
  }
};
let list;
let lookupError;
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
  // With no limit, no list's players are counted.
  'scbl-lib/db/export-membership': {
    countMembers() {
      throw new Error('A list was counted with no limit on its players.');
    },
    countPlayersWithBans() {
      throw new Error('Players were counted with no limit on lists.');
    }
  },
  'scbl-lib/db/models': {
    BanList: {},
    ExportBanListConfig: {},
    Organisation: {},
    ExportBanList: {
      async findOne({ where }) {
        assert.strictEqual(where.id, 42);
        assert.strictEqual(where.owner, 'owner');
        if (lookupError) throw lookupError;
        return list;
      }
    }
  },
  'scbl-lib/utils': { isDiscordWebhookUrl() {}, testDiscordWebhook() {}, Logger }
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
const remove = (user = { id: 'owner' }) =>
  module.namespace.default.Mutation.deleteExportBanList(null, { id: 42 }, { user });

// A list whose deletion does what deleteExportBanList is given. Its other steps record that they
// were taken, as the resolver must leave them all to deleteExportBanList, which the Discord bot
// uses too.
const exportBanList = (type, deleteExportBanList) => ({
  id: 42,
  name: 'List 42',
  server: 'Server',
  type,
  battlemetricsID: type === 'battlemetrics' ? 'bm-42' : null,
  deleteExportBanList,
  async deleteBattlemetricsBanList() {
    calls.push('battlemetrics');
  },
  async destroy() {
    calls.push('database');
  }
});

// The user's list is deleted with deleteExportBanList, whatever its type, and returned. One line
// says who deleted which list, with what happened to its BattleMetrics ban list, which the
// deletion clears from the list, as the real one does.
const BM_LIST = `Server's List "List 42" (ID: 42, BattleMetrics)`;
const REMOTE_LIST = `Server's List "List 42" (ID: 42, remote)`;
for (const type of ['battlemetrics', 'remote']) {
  calls.length = 0;
  list = exportBanList(type, async function () {
    calls.push('delete');
    this.battlemetricsID = null;
    return type === 'battlemetrics' ? 'deleted' : 'none';
  });
  assert.strictEqual(await remove(), list);
  assert.deepStrictEqual(calls, ['delete']);
}
assert.strictEqual(logs.length, 0);
assert.deepStrictEqual(posted, [
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST} and its BattleMetrics ban list bm-42.`,
  `[WebServer][1] Steam user owner deleted export ban list ${REMOTE_LIST}.`
]);

// The other outcomes: a BattleMetrics list whose ban list BattleMetrics no longer had, or that had
// none.
posted.length = 0;
for (const outcome of ['gone', 'none']) {
  list = exportBanList('battlemetrics', async () => outcome);
  if (outcome === 'none') list.battlemetricsID = null;
  await remove();
}
assert.deepStrictEqual(posted, [
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST}; BattleMetrics no longer had its ban list bm-42.`,
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST}, which had no BattleMetrics ban list.`
]);
posted.length = 0;

// A failed deletion is logged with the stage that failed, which the error gives, the status and
// BattleMetrics' errors, but never the error whole.
calls.length = 0;
const apiError = Object.assign(new Error('Request failed with status code 400'), {
  stage: 'battlemetrics',
  config: { headers: { Authorization: 'Bearer secret-test-token' } },
  response: {
    status: 400,
    data: { errors: [{ code: 'test', title: 'Bad Request', detail: 'Example rejection detail' }] }
  }
});
list = exportBanList('battlemetrics', async () => {
  throw apiError;
});
await assert.rejects(remove(), (error) => error === apiError);
assert.deepStrictEqual(calls, []);
assert.strictEqual(logs[0][0], 'Failed to delete export ban list:');
assert.strictEqual(logs[0][1].exportBanListID, 42);
assert.strictEqual(logs[0][1].stage, 'battlemetrics');
assert.strictEqual(logs[0][1].status, 400);
assert.strictEqual(logs[0][1].errors[0].detail, 'Example rejection detail');
assert.ok(!JSON.stringify(logs).includes('secret-test-token'));

list = exportBanList('remote', async () => {
  throw Object.assign(new Error('Deletion failed'), { stage: 'database deletion' });
});
await assert.rejects(remove(), /Deletion failed/);
assert.strictEqual(logs[1][1].stage, 'database deletion');

// An error that does not give its stage is logged as the deletion's.
list = exportBanList('remote', async () => {
  throw new Error('Unexpected failure');
});
await assert.rejects(remove(), /Unexpected failure/);
assert.strictEqual(logs[2][1].stage, 'deletion');

// Each failed deletion posts a line saying which list, what failed and why, from the error's stage
// and its description, never the error whole, which holds the API key.
assert.deepStrictEqual(posted, [
  `[WebServer][1] Steam user owner could not delete export ban list ${BM_LIST}, as deleting its BattleMetrics ban list bm-42 failed: Error: Request failed with status code 400`,
  `[WebServer][1] Steam user owner could not delete export ban list ${REMOTE_LIST}, as deleting it from the database failed: Error: Deletion failed`,
  `[WebServer][1] Steam user owner could not delete export ban list ${REMOTE_LIST}: Error: Unexpected failure`
]);
assert.ok(!posted.join('\n').includes('secret-test-token'));

lookupError = new Error('Database unavailable');
await assert.rejects(remove(), (error) => error === lookupError);
assert.strictEqual(logs[3][1].message, 'Database unavailable');
assert.strictEqual(logs[3][1].stage, 'lookup');
lookupError = undefined;

list = null;
await assert.rejects(remove(), /Export ban list does not exist/);
assert.strictEqual(logs[4][1].stage, 'lookup');
await assert.rejects(remove(null), /Please sign in again/);
assert.strictEqual(logs[5][1].stage, 'authentication');
assert.strictEqual(logs.length, 6);
assert.deepStrictEqual(calls, []);
// Signing in and looking the list up change nothing, so their failures post nothing.
assert.strictEqual(posted.length, 3);

console.log(
  'Export ban list deletion checks passed: the shared deletion, ownership, and error reporting.'
);
