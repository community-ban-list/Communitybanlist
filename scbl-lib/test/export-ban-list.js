import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../utils/describe-error.js';
import logText from '../utils/log-text.js';

// Exercise how an export ban list creates its BattleMetrics ban list and invite, and what it posts
// to the log channel, without a database or network requests.
const calls = [];
let reply;
// The name each new BattleMetrics ban list was asked for.
const banListNames = [];
async function battlemetrics(method, endpoint, params, data, priority, options) {
  // The options come from the module's own context, so they are copied before comparing.
  calls.push({ method, endpoint, priority, options: options && { ...options } });
  if (endpoint === 'ban-lists') banListNames.push(data.data.attributes.name);
  return reply(endpoint);
}

// The errors the next saves fail with, in order, where null lets a save succeed.
const saveFailures = [];

// A stand-in for Sequelize's Model, whose save() records what was saved.
class Model {
  static init() {}

  async save() {
    const { battlemetricsID, battlemetricsInvite } = this;
    calls.push({ saved: { battlemetricsID, battlemetricsInvite } });
    const failure = saveFailures.shift();
    if (failure) throw failure;
  }
}
// Any data type, such as DataTypes.STRING or DataTypes.ENUM(...).
const dataType = () => dataType;

// The lines posted to the log channel, as the logger posts them: the line, then its errors, each
// described in a line by describeError. Lines of level 2 and up are only printed, so they are left
// out.
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

const dependencies = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: {} },
  // Deleting a list holds a lock on a connection of its own, which export-ban-list-locks.js checks.
  '../open-connection.js': { default: () => assert.fail('A connection was opened.') },
  '../../apis/index.js': { battlemetrics },
  // Deleting lists is checked in delete-export-ban-list.js, and checking stored lists against the
  // limits, which counts the players of those over a cap, in check-stored-export-ban-lists.js.
  '../export-membership.js': { countMembers: () => assert.fail('No players are counted here.') },
  '../../apis/delete-battlemetrics-ban-list.js': {
    checkOwnership: async () => true,
    findVisibleBanLists: async () => new Set(),
    removeInvitesAndSubscribers: async () => {},
    removeOwner: async () => {}
  },
  '../../export-list-limits.js': { checkRules: () => [], DEFAULT_SETTINGS: {} },
  '../../utils/index.js': { Logger },
  '../../utils/log-text.js': { default: logText },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: '42', EXPORT_LIST_LIMITS: {} }
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

const OWNER = '76561198000000007';
// Each list here has a Discord webhook, which no line may give.
const WEBHOOK =
  'https://discord.com/api/webhooks/123456789012345678/webhook-token-these-checks-use';
const exportBanList = (fields) =>
  Object.assign(new ExportBanList(), {
    id: 7,
    name: 'Test',
    server: 'Server',
    type: 'battlemetrics',
    owner: OWNER,
    discordWebhook: WEBHOOK,
    battlemetricsID: null,
    battlemetricsInvite: null,
    ...fields
  });
const inviteURL = (code) =>
  `https://www.battlemetrics.com/rcon/ban-lists/accept-invite?code=${code}`;
const reset = () => {
  calls.length = 0;
  posted.length = 0;
  saveFailures.length = 0;
  banListNames.length = 0;
};
// The list as the lines name it, with its owner by Steam ID, as nothing is looked up for a line.
const LIST = `Server's List "Test" (ID: 7, BattleMetrics) of Steam user ${OWNER}`;

// An error as the BattleMetrics client throws one. Its config stands for anything else an error
// could hold, such as axios's request with the API key, which must never be posted.
const API_KEY = 'secret-api-key';
const apiError = (message, status, extra = {}) =>
  Object.assign(new Error(message), {
    name: 'ApiError',
    status,
    response: status ? { status, data: { errors: [{ title: 'Bad Gateway' }] } } : undefined,
    config: { headers: { Authorization: `Bearer ${API_KEY}` } },
    ...extra
  });

// No line ever gives a list's invite, as any organisation could use its ban list with it, nor its
// Discord webhook, with which anyone can post to it, nor the BattleMetrics API key. Each line is on
// one line. The same goes for the errors thrown, which the website posts.
function checkNoSecrets(lines = posted) {
  for (const line of lines) {
    assert.ok(!/code-|accept-invite/.test(line), `A line gives an invite: ${line}`);
    assert.ok(
      !/webhook-token|discord\.com\/api\/webhooks/.test(line),
      `A line gives a webhook: ${line}`
    );
    assert.ok(!line.includes(API_KEY), `A line gives the API key: ${line}`);
    assert.ok(!/[\r\n\u2028\u2029]/.test(line), `A line has a line break: ${JSON.stringify(line)}`);
  }
}

// A new list gets a BattleMetrics ban list, and then an invite to it. The ban list's POST is not
// marked as repeatable, as BattleMetrics may have created a ban list for one that timed out, but
// the invite's is, as a second invite does no harm. One line says which ban list was made for which
// list, once both are made, and nothing about the invite but that it was made.
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
assert.deepStrictEqual(posted, [
  `[ExportBanList][1] Created BattleMetrics ban list list-1 for ${LIST}, with its invite.`
]);
checkNoSecrets();
// The ban list is named after the list, as an admin can look it up on BattleMetrics.
assert.deepStrictEqual(banListNames, ['Community Ban List - Test (ID: 7)']);
assert.strictEqual(list.battlemetricsBanListName(), 'Community Ban List - Test (ID: 7)');

// A list loaded with its owner, as checkLimits loads it, names the owner by their Steam name too.
reset();
list = exportBanList({ SteamUser: { id: OWNER, name: 'Owner Name' } });
await list.createBattlemetricsBanList();
assert.deepStrictEqual(posted, [
  `[ExportBanList][1] Created BattleMetrics ban list list-1 for Server's List "Test" (ID: 7, BattleMetrics) of Steam user "Owner Name" (ID: ${OWNER}), with its invite.`
]);
checkNoSecrets();

// The list's name and server, and its owner's Steam name, are their owners' to choose. Each is kept
// on one line, so it cannot start a line that looks like another module's, and shown as written, so
// its Markdown cannot hide part of the line or turn into a link.
reset();
list = exportBanList({
  name: 'Bans".\n[DiscordBot][1] admin (1) removed',
  server: '||AFO',
  SteamUser: { id: OWNER, name: 'xX_[Owner](https://example.com)' }
});
await list.createBattlemetricsBanList();
assert.deepStrictEqual(posted, [
  `[ExportBanList][1] Created BattleMetrics ban list list-1 for \\|\\|AFO's List "Bans". \\[DiscordBot\\]\\[1\\] admin (1) removed" (ID: 7, BattleMetrics) of Steam user "xX\\_\\[Owner\\](https://example.com)" (ID: ${OWNER}), with its invite.`
]);
checkNoSecrets();

// A list whose invite could not be created keeps its ban list, and gets only the invite when it is
// tried again. Nothing is posted for the failure, which is thrown with its stage for the caller to
// post, as the website does. The invite made later gets a line of its own.
reset();
reply = () => {
  throw apiError('BattleMetrics POST failed after 3 attempts: HTTP 503', 503);
};
list = exportBanList({ battlemetricsID: 'list-2' });
await assert.rejects(list.createBattlemetricsBanList(), { message: /HTTP 503/, stage: 'invite' });
assert.deepStrictEqual([list.battlemetricsID, list.battlemetricsInvite], ['list-2', null]);
assert.deepStrictEqual(posted, []);
reply = () => ({ data: { data: { id: 'code-2' } } });
await list.createBattlemetricsBanList();
assert.deepStrictEqual(
  calls.map((call) => call.endpoint || 'save'),
  ['ban-lists/list-2/relationships/invites', 'ban-lists/list-2/relationships/invites', 'save']
);
assert.strictEqual(list.battlemetricsInvite, inviteURL('code-2'));
assert.deepStrictEqual(posted, [
  `[ExportBanList][1] Created the invite to BattleMetrics ban list list-2 for Server's List "Test" (ID: 7, BattleMetrics) of Steam user ${OWNER}.`
]);
checkNoSecrets();

// A failure is only thrown, marked with the step it was in, and nothing is posted: BattleMetrics
// not creating the ban list ('battlemetrics', with nothing recorded), the list not being saved
// with the ban list it made ('saving', with the ban list only on the list in memory), and the
// invite of a new list not being made or saved ('invite', with the ban list recorded).
const lockTimeout = () => new Error('Lock wait timeout exceeded; try restarting transaction');
for (const [stage, failAt, recorded] of [
  ['battlemetrics', 'ban-lists', null],
  ['saving', 'first save', 'list-3'],
  ['invite', 'ban-lists/list-3/relationships/invites', 'list-3'],
  ['invite', 'second save', 'list-3']
]) {
  reset();
  reply = (endpoint) => {
    if (endpoint === failAt)
      throw apiError(`BattleMetrics POST ${endpoint} failed: HTTP 502 (Bad Gateway)`, 502);
    return { data: { data: { id: endpoint === 'ban-lists' ? 'list-3' : 'code-3' } } };
  };
  if (failAt === 'first save') saveFailures.push(lockTimeout());
  if (failAt === 'second save') saveFailures.push(null, lockTimeout());
  list = exportBanList();
  let thrown;
  await assert.rejects(list.createBattlemetricsBanList(), (error) => {
    assert.strictEqual(error.stage, stage, failAt);
    thrown = error;
    return true;
  });
  assert.strictEqual(list.battlemetricsID, recorded, failAt);
  assert.deepStrictEqual(posted, [], failAt);
  // The website posts the error, so it gives no secret either, though after the second save the
  // list holds its new invite.
  checkNoSecrets([thrown.message, describeError(thrown)]);
  if (failAt === 'second save') {
    assert.strictEqual(list.battlemetricsInvite, inviteURL('code-3'));
    assert.strictEqual(
      describeError(thrown),
      'Error: Lock wait timeout exceeded; try restarting transaction'
    );
  }
}

// Nothing is created or posted for a list that has its invite, has no BattleMetrics ban list, or
// is a remote list.
reset();
for (const fields of [
  { battlemetricsID: 'list-3', battlemetricsInvite: inviteURL('code-3') },
  {},
  { type: 'remote', battlemetricsID: 'list-4' }
])
  await exportBanList(fields).createBattlemetricsInvite();
assert.strictEqual(calls.length, 0);
assert.deepStrictEqual(posted, []);

console.log(
  'Export ban list checks passed: BattleMetrics ban lists, invites made again when missing, and the lines they post.'
);
