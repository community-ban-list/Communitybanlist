import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import describeError from '../../scbl-lib/utils/describe-error.js';
import logText from '../../scbl-lib/utils/log-text.js';
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
// What the lookup made with the list's row locked finds, when it differs from the first lookup,
// e.g. null for a list given to another user in between.
let relookedUp;
// Each deletion's steps, in order: the lookups, and whether each locked the list's row, in its
// transaction, the deletion lock being taken and freed, and the shared deletion.
const steps = [];
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
      async findOne({ where, lock, transaction }) {
        assert.strictEqual(where.id, 42);
        assert.strictEqual(where.owner, 'owner');
        if (lock) assert.ok(transaction, 'The row is locked in a transaction.');
        steps.push(lock ? 'locked lookup' : 'lookup');
        if (lookupError) throw lookupError;
        return lock && relookedUp !== undefined ? relookedUp : list;
      },
      async inTransaction(work) {
        steps.push('begin');
        const result = await work({});
        steps.push('commit');
        return result;
      },
      async whileDeleting(id, deletion) {
        assert.strictEqual(id, 42);
        steps.push('take the deletion lock');
        try {
          return await deletion();
        } finally {
          steps.push('free the deletion lock');
        }
      }
    }
  },
  'scbl-lib/utils': { isDiscordWebhookUrl() {}, testDiscordWebhook() {}, Logger, logText }
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
    steps.push('delete');
    this.battlemetricsID = null;
    return type === 'battlemetrics' ? 'deleted' : 'none';
  });
  steps.length = 0;
  assert.strictEqual(await remove(), list);
  assert.deepStrictEqual(calls, ['delete']);
  // The deletion holds the list's deletion lock throughout, so the Discord bot cannot give the
  // list to another user meanwhile, and once it holds it, the list is looked up again with its row
  // locked, so a list given away just before is not deleted.
  assert.deepStrictEqual(steps, [
    'lookup',
    'take the deletion lock',
    'begin',
    'locked lookup',
    'commit',
    'delete',
    'free the deletion lock'
  ]);
}
assert.strictEqual(logs.length, 0);
assert.deepStrictEqual(posted, [
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST} and its BattleMetrics ban list bm-42.`,
  `[WebServer][1] Steam user owner deleted export ban list ${REMOTE_LIST}.`
]);

// The other outcomes: a BattleMetrics list whose ban list BattleMetrics did not know, which is
// only taken to be deleted already, as BattleMetrics says the same of a ban list CBL's key cannot
// see, or that had none.
posted.length = 0;
for (const outcome of ['gone', 'none']) {
  list = exportBanList('battlemetrics', async () => outcome);
  if (outcome === 'none') list.battlemetricsID = null;
  await remove();
}
assert.deepStrictEqual(posted, [
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST}; BattleMetrics did not know its ban list bm-42, so it was taken to be deleted already.`,
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

// A list given to another user between the first lookup and the deletion lock, e.g. by the Discord
// bot's /exportbanlist transfer, is not found once the lock is held, so it is not deleted, and
// nothing is posted. The lock is freed.
list = exportBanList('battlemetrics', async () => assert.fail('The list was deleted.'));
relookedUp = null;
steps.length = 0;
await assert.rejects(remove(), { message: 'Export ban list does not exist!' });
assert.deepStrictEqual(steps, [
  'lookup',
  'take the deletion lock',
  'begin',
  'locked lookup',
  'commit',
  'free the deletion lock'
]);
assert.strictEqual(logs[6][1].stage, 'lookup');
assert.strictEqual(posted.length, 3);
relookedUp = undefined;

// The list deleted is the one the locked lookup found, as it is now, with the BattleMetrics ban
// list it records now.
list = exportBanList('battlemetrics', async () => assert.fail('The first lookup was deleted.'));
relookedUp = {
  ...exportBanList('battlemetrics', async function () {
    calls.push('delete');
    return 'deleted';
  }),
  battlemetricsID: 'bm-43'
};
calls.length = 0;
assert.strictEqual(await remove(), relookedUp);
assert.deepStrictEqual(calls, ['delete']);
assert.strictEqual(
  posted.at(-1),
  `[WebServer][1] Steam user owner deleted export ban list ${BM_LIST} and its BattleMetrics ban list bm-43.`
);

console.log(
  'Export ban list deletion checks passed: the shared deletion, ownership, and error reporting.'
);
