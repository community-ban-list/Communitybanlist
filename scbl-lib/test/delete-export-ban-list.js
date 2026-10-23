import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../utils/describe-error.js';

// Delete export ban lists the way the website and the Discord bot do, with ExportBanList's
// deleteExportBanList, against stand-ins for BattleMetrics and the database, and check what the
// deletions post to the log channel. The BattleMetrics steps are the real ones, from
// apis/delete-battlemetrics-ban-list.js.

const OWNER = '42';
// Every request to BattleMetrics, save and row deletion, in order.
const calls = [];
// What the list logged, as Logger.verbose's arguments, with level 1 for Logger.important's lines,
// which are marked as important: since the last reset, and in all.
const logs = [];
const everything = [];
// The lines the list posted to the log channel, as the logger posts them: each level 1 line, then
// its errors, each described in a line by describeError.
const posted = () =>
  logs
    .filter(([, level]) => level === 1)
    .map(([module, level, message, ...extras]) => {
      const errors = extras.filter((extra) => typeof extra?.message === 'string');
      let text = `${message}`;
      if (errors.length > 0)
        text += `${/\s$/.test(text) ? '' : ' '}${errors.map(describeError).join(', ')}`;
      return `[${module}][${level}] ${text}`;
    });
// The Steam ID of the lists' owner, and each line the deletions post, which name the owner by
// their Steam ID alone, as nothing is looked up for a line.
const STEAM_ID = '76561198000000042';
const listOf = (id) =>
  `Server ${id}'s List "List ${id}" (ID: ${id}, BattleMetrics) of Steam user ${STEAM_ID}`;
const starting = (id) =>
  `[ExportBanList][1] Deleting BattleMetrics ban list list-${id} for ${listOf(id)}, which can take minutes.`;
const deleted = (id) =>
  `[ExportBanList][1] Deleted BattleMetrics ban list list-${id} for ${listOf(id)}, with its invites and subscribers.`;
const gone = (id) =>
  `[ExportBanList][1] BattleMetrics does not know ban list list-${id} for ${listOf(id)} (HTTP 404, Unknown ban list), so it is taken to be deleted already.`;
const nothing = (id) => `[ExportBanList][1] ${listOf(id)} has no BattleMetrics ban list to delete.`;

// An error as the BattleMetrics client throws one for an answer with this status and these errors.
function apiError(status, errors) {
  return Object.assign(new Error(`BattleMetrics request failed: HTTP ${status}`), {
    name: 'ApiError',
    status,
    response: { status, data: { errors } }
  });
}
const unknownBanList = () =>
  apiError(404, [{ status: '404', title: 'Not Found', detail: 'Unknown ban list.' }]);

// BattleMetrics' ban lists, by ID: the organisations on each, its owner among them, and its
// invites. A ban list is gone once its owner has left it.
const banLists = new Map();
function addBanList(id, { owner = OWNER, subscribers = ['77', '88'] } = {}) {
  banLists.set(id, {
    owner,
    organizations: new Set([owner, ...subscribers]),
    invites: new Set(['invite-1', 'invite-2'])
  });
}

// Answers that replace BattleMetrics' own for a request, by method and endpoint. Each is given a
// function that makes the request as BattleMetrics would, and gives an answer or throws.
const answers = new Map();

const page = (records) => ({ data: { data: records, links: {} } });
function answer(method, endpoint) {
  const [, id, relationship] = endpoint.match(/^ban-lists\/([^/]+)(?:\/relationships\/(.+))?$/);
  const banList = banLists.get(id);
  if (!banList) throw unknownBanList();
  if (!relationship) return { data: { data: { type: 'banList', id } } };
  if (relationship === 'invites')
    return page([...banList.invites].map((invite) => ({ type: 'banListInvite', id: invite })));
  if (relationship === 'organizations')
    return page(
      [...banList.organizations].map((organization) => ({
        type: 'banList',
        id,
        relationships: { organization: { data: { type: 'organization', id: organization } } }
      }))
    );
  const [kind, member] = relationship.split('/');
  const members = kind === 'invites' ? banList.invites : banList.organizations;
  if (!members.has(member)) throw apiError(404, [{ status: '404', title: 'Not Found' }]);
  if (method === 'get')
    return {
      data: {
        data: {
          type: 'banList',
          id,
          relationships: { owner: { data: { type: 'organization', id: banList.owner } } }
        }
      }
    };
  members.delete(member);
  if (kind === 'organizations' && member === banList.owner) banLists.delete(id);
  return { status: 204 };
}
async function battlemetrics(method, endpoint) {
  calls.push([method, endpoint]);
  const replacement = answers.get(`${method} ${endpoint}`);
  return replacement ? replacement(() => answer(method, endpoint)) : answer(method, endpoint);
}

// The database's export ban lists, by ID. Lists are looked up as copies of their rows, as
// Sequelize does, and only save and destroy write to the rows.
const rows = new Map();
// The errors the next saves fail with, in order, where null lets a save succeed, and the error the
// next row deletion fails with.
const saveFailures = [];
let destroyFailure = null;

// A stand-in for Sequelize's Model.
class Model {
  static init() {}

  async save() {
    const { battlemetricsID, battlemetricsInvite } = this;
    calls.push(['save', { battlemetricsID, battlemetricsInvite }]);
    const failure = saveFailures.shift();
    if (failure) throw failure;
    Object.assign(rows.get(this.id), { battlemetricsID, battlemetricsInvite });
  }

  async destroy() {
    calls.push(['destroy']);
    const failure = destroyFailure;
    destroyFailure = null;
    if (failure) throw failure;
    rows.delete(this.id);
  }
}
// Any data type, such as DataTypes.STRING or DataTypes.ENUM(...).
const dataType = () => dataType;

const stubs = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: {} },
  '../../apis/index.js': { battlemetrics },
  '../../utils/index.js': {
    Logger: {
      verbose(...args) {
        logs.push(args);
        everything.push(args);
      },
      important(module, ...args) {
        const entry = Object.assign([module, 1, ...args], { important: true });
        logs.push(entry);
        everything.push(entry);
      }
    }
  },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: OWNER, EXPORT_LIST_LIMITS: {} },
  // The deletion steps' own imports.
  './battlemetrics.js': { default: battlemetrics },
  '../config.js': { BATTLEMETRICS_ORGANIZATION: OWNER }
};
const context = vm.createContext({ URL });
const load = async (url) =>
  new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
const module = await load(new URL('../db/models/export-ban-list.js', import.meta.url));
await module.link(async (specifier, referencingModule) => {
  const exports = stubs[specifier];
  // The other relative imports, the deletion steps and the page reader, are the real files.
  if (!exports) return load(new URL(specifier, referencingModule.identifier));
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

const inviteURL = (code) =>
  `https://www.battlemetrics.com/rcon/ban-lists/accept-invite?code=${code}`;
// Each list has a Discord webhook, which no line may give.
const WEBHOOK =
  'https://discord.com/api/webhooks/123456789012345678/webhook-token-these-checks-use';
function addList(id, fields = {}) {
  rows.set(id, {
    id,
    name: `List ${id}`,
    server: `Server ${id}`,
    type: 'battlemetrics',
    owner: STEAM_ID,
    discordWebhook: WEBHOOK,
    battlemetricsID: `list-${id}`,
    battlemetricsInvite: inviteURL(`code-${id}`),
    ...fields
  });
}
// Look a list up, as the website and the bot do before deleting it.
const find = (id) => Object.assign(new ExportBanList(), rows.get(id));
const stored = (id) => {
  const { battlemetricsID, battlemetricsInvite } = rows.get(id);
  return { battlemetricsID, battlemetricsInvite };
};
const reset = () => {
  calls.length = 0;
  logs.length = 0;
  answers.clear();
  saveFailures.length = 0;
  destroyFailure = null;
};

// The requests that check a ban list's owner and read its invites and subscribers, and those
// that remove them, but not the owner.
const ownership = (id) => ['get', `ban-lists/${id}/relationships/organizations/${OWNER}`];
const lookUp = (id) => ['get', `ban-lists/${id}`];
const reads = (id) => [
  ownership(id),
  ['get', `ban-lists/${id}/relationships/invites`],
  ['get', `ban-lists/${id}/relationships/organizations`]
];
const removals = (id) => [
  ['delete', `ban-lists/${id}/relationships/invites/invite-1`],
  ['delete', `ban-lists/${id}/relationships/invites/invite-2`],
  ['delete', `ban-lists/${id}/relationships/organizations/77`],
  ['delete', `ban-lists/${id}/relationships/organizations/88`]
];
const removeOwner = (id) => ['delete', `ban-lists/${id}/relationships/organizations/${OWNER}`];
const cleared = ['save', { battlemetricsID: null, battlemetricsInvite: null }];
const restored = (id) => [
  'save',
  { battlemetricsID: `list-${id}`, battlemetricsInvite: inviteURL(`code-${id}`) }
];

// A BattleMetrics list is deleted in this order: the ownership check, its invites and subscribers
// read and then removed, the list saved without its ban list, CBL's own organisation removed,
// which is the last step on BattleMetrics, and then the row deleted. It posts a line as the
// deletion starts, as it can take minutes, and one once the ban list is deleted, each naming the
// list and the ban list.
addList(1);
addBanList('list-1');
assert.strictEqual(await find(1).deleteExportBanList(), 'deleted');
assert.deepStrictEqual(calls, [
  ...reads('list-1'),
  ...removals('list-1'),
  cleared,
  removeOwner('list-1'),
  ['destroy']
]);
assert.ok(!banLists.has('list-1') && !rows.has(1));
assert.deepStrictEqual(posted(), [starting(1), deleted(1)]);

// A list loaded with its owner, as the bot's checkLimits loads it, names the owner by their Steam
// name too.
reset();
addList(13);
addBanList('list-13');
const withOwner = Object.assign(find(13), { SteamUser: { id: STEAM_ID, name: 'Owner Name' } });
assert.strictEqual(await withOwner.deleteExportBanList(), 'deleted');
const named = `Server 13's List "List 13" (ID: 13, BattleMetrics) of Steam user "Owner Name" (ID: ${STEAM_ID})`;
assert.deepStrictEqual(posted(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list list-13 for ${named}, which can take minutes.`,
  `[ExportBanList][1] Deleted BattleMetrics ban list list-13 for ${named}, with its invites and subscribers.`
]);
assert.ok(logs.every((entry) => !entry.important));

// A caller that posts its own lines as important ones, as the bot does when it removes many lists,
// gets these lines posted that way too, so they stay in order with its own: here, as the deletion
// starts and ends, and for a list with no ban list.
reset();
addList(15);
addBanList('list-15');
assert.strictEqual(await find(15).deleteExportBanList({ important: true }), 'deleted');
assert.deepStrictEqual(posted(), [starting(15), deleted(15)]);
assert.ok(logs.every((entry) => entry.important));
reset();
addList(15, { battlemetricsID: null, battlemetricsInvite: null });
assert.strictEqual(await find(15).deleteExportBanList({ important: true }), 'none');
assert.deepStrictEqual(posted(), [nothing(15)]);
assert.ok(logs.every((entry) => entry.important));

// The list's name and server, and its owner's Steam name, are their owners' to choose, so each is
// kept on one line and shown as written: a name cannot start a line that looks like another
// module's, or hide part of its line.
reset();
addList(16, { name: 'List".\n[DiscordBot][1] admin (1) removed', server: '||Server' });
addBanList('list-16');
const oddOwner = Object.assign(find(16), { SteamUser: { id: STEAM_ID, name: 'xX_Owner_Xx' } });
assert.strictEqual(await oddOwner.deleteExportBanList(), 'deleted');
const escaped = `\\|\\|Server's List "List". \\[DiscordBot\\]\\[1\\] admin (1) removed" (ID: 16, BattleMetrics) of Steam user "xX\\_Owner\\_Xx" (ID: ${STEAM_ID})`;
assert.deepStrictEqual(posted(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list list-16 for ${escaped}, which can take minutes.`,
  `[ExportBanList][1] Deleted BattleMetrics ban list list-16 for ${escaped}, with its invites and subscribers.`
]);

// A remote list, and a BattleMetrics list whose ban list was never created, only have their rows
// deleted. A remote list is not deleted on BattleMetrics even if it records a ban list, and posts
// nothing, as there is nothing to do on BattleMetrics. A BattleMetrics list with no ban list
// posts one line, saying so.
for (const fields of [
  { type: 'remote', battlemetricsID: null, battlemetricsInvite: null },
  { type: 'remote' },
  { battlemetricsID: null, battlemetricsInvite: null }
]) {
  reset();
  addList(2, fields);
  addBanList('list-2');
  assert.strictEqual(await find(2).deleteExportBanList(), 'none');
  assert.deepStrictEqual(calls, [['destroy']]);
  assert.ok(banLists.has('list-2') && !rows.has(2));
  assert.deepStrictEqual(posted(), fields.type === 'remote' ? [] : [nothing(2)]);
}

// When removing CBL's own organisation fails, the list records its ban list again and is kept,
// and deleting it again removes the organisation. The failure is only thrown, for the website or
// the bot to post with who tried, so only the start is posted.
reset();
addList(3);
addBanList('list-3');
answers.set(`delete ${removeOwner('list-3')[1]}`, () => {
  throw apiError(400, [{ title: 'Bad Request', detail: 'Ownership transfer required' }]);
});
let list = find(3);
await assert.rejects(list.deleteExportBanList(), {
  message: /^BattleMetrics deletion failed while removing owner: Ownership transfer required\./,
  stage: 'battlemetrics'
});
assert.deepStrictEqual(calls, [
  ...reads('list-3'),
  ...removals('list-3'),
  cleared,
  removeOwner('list-3'),
  restored(3)
]);
assert.deepStrictEqual(stored(3), {
  battlemetricsID: 'list-3',
  battlemetricsInvite: inviteURL('code-3')
});
assert.strictEqual(list.battlemetricsID, 'list-3');
assert.deepStrictEqual(posted(), [starting(3)]);
reset();
assert.strictEqual(await find(3).deleteExportBanList(), 'deleted');
assert.deepStrictEqual(calls, [...reads('list-3'), cleared, removeOwner('list-3'), ['destroy']]);
assert.ok(!banLists.has('list-3') && !rows.has(3));
assert.deepStrictEqual(posted(), [starting(3), deleted(3)]);

// When the list cannot be saved with its ban list again either, that is posted with the list and
// the ban list's ID, so the ban list can be removed by hand, and the error is the organisation's
// removal.
reset();
addList(4);
addBanList('list-4');
answers.set(`delete ${removeOwner('list-4')[1]}`, () => {
  throw apiError(503, [{ title: 'Service Unavailable' }]);
});
const restoreError = new Error('Lock wait timeout exceeded; try restarting transaction');
saveFailures.push(null, restoreError);
list = find(4);
await assert.rejects(list.deleteExportBanList(), {
  message: /^BattleMetrics deletion failed while removing owner: Service Unavailable\./,
  stage: 'battlemetrics'
});
assert.deepStrictEqual(calls.slice(-3), [cleared, removeOwner('list-4'), restored(4)]);
assert.deepStrictEqual(stored(4), { battlemetricsID: null, battlemetricsInvite: null });
assert.strictEqual(list.battlemetricsID, null);
const restoreLogs = logs.filter(([, , message]) => message.includes('by hand'));
assert.strictEqual(restoreLogs.length, 1);
const [, , , ...loggedErrors] = restoreLogs[0];
assert.deepStrictEqual(loggedErrors, [restoreError]);
assert.deepStrictEqual(posted(), [
  starting(4),
  `[ExportBanList][1] ${listOf(4)} no longer records BattleMetrics ban list list-4, which CBL's organisation may still own, as removing the organisation failed and the list could not be saved with it again. Remove the ban list on BattleMetrics by hand. Error: Lock wait timeout exceeded; try restarting transaction`
]);
// Deleting the list again only deletes its row, and the ban list is left for removing by hand.
reset();
assert.strictEqual(await find(4).deleteExportBanList(), 'none');
assert.deepStrictEqual(calls, [['destroy']]);
assert.ok(banLists.get('list-4').organizations.has(OWNER));
assert.deepStrictEqual(posted(), [nothing(4)]);

// When the list cannot be saved without its ban list, CBL's own organisation is not removed, and
// deleting the list again finishes. It is tried again as the website does, with the list looked
// up again, and with the same list.
for (const sameList of [false, true]) {
  reset();
  addList(5);
  addBanList('list-5');
  const saveError = new Error('Lock wait timeout exceeded; try restarting transaction');
  saveFailures.push(saveError);
  list = find(5);
  await assert.rejects(list.deleteExportBanList(), (error) => error === saveError);
  assert.strictEqual(saveError.stage, 'battlemetrics');
  assert.deepStrictEqual(calls, [...reads('list-5'), ...removals('list-5'), cleared]);
  assert.deepStrictEqual(stored(5), {
    battlemetricsID: 'list-5',
    battlemetricsInvite: inviteURL('code-5')
  });
  assert.strictEqual(list.battlemetricsID, 'list-5');
  assert.ok(banLists.get('list-5').organizations.has(OWNER));
  assert.deepStrictEqual(posted(), [starting(5)]);

  reset();
  assert.strictEqual(await (sameList ? list : find(5)).deleteExportBanList(), 'deleted');
  assert.deepStrictEqual(calls, [...reads('list-5'), cleared, removeOwner('list-5'), ['destroy']]);
  assert.ok(!banLists.has('list-5') && !rows.has(5));
  assert.deepStrictEqual(posted(), [starting(5), deleted(5)]);
}

// When the row cannot be deleted, the list no longer records its ban list, which is gone, so
// deleting it again only deletes the row. The ban list's deletion is posted, as it is done, and the
// row's failure is only thrown.
reset();
addList(6);
addBanList('list-6');
destroyFailure = new Error('Deadlock found when trying to get lock');
await assert.rejects(find(6).deleteExportBanList(), {
  message: 'Deadlock found when trying to get lock',
  stage: 'database deletion'
});
assert.deepStrictEqual(stored(6), { battlemetricsID: null, battlemetricsInvite: null });
assert.deepStrictEqual(posted(), [starting(6), deleted(6)]);
reset();
assert.strictEqual(await find(6).deleteExportBanList(), 'none');
assert.deepStrictEqual(calls, [['destroy']]);
assert.ok(!rows.has(6));
assert.deepStrictEqual(posted(), [nothing(6)]);

// When BattleMetrics removed CBL's own organisation but its answer was lost, the list records its
// ban list again. Deleting it again finds that BattleMetrics no longer knows the ban list, posts
// that with the list and the ban list's ID, and deletes the row.
reset();
addList(7);
addBanList('list-7');
answers.set(`delete ${removeOwner('list-7')[1]}`, (carryOut) => {
  carryOut();
  throw Object.assign(
    new Error(
      `BattleMetrics DELETE ${removeOwner('list-7')[1]} failed after 3 attempts: timed out after 30s`
    ),
    { name: 'ApiError', code: 'ECONNABORTED' }
  );
});
await assert.rejects(find(7).deleteExportBanList(), {
  message: /while removing owner: BattleMetrics DELETE .* timed out after 30s\./,
  stage: 'battlemetrics'
});
assert.ok(!banLists.has('list-7'));
assert.strictEqual(stored(7).battlemetricsID, 'list-7');
assert.deepStrictEqual(posted(), [starting(7)]);
reset();
assert.strictEqual(await find(7).deleteExportBanList(), 'gone');
assert.deepStrictEqual(calls, [ownership('list-7'), lookUp('list-7'), cleared, ['destroy']]);
assert.ok(!rows.has(7));
assert.deepStrictEqual(posted(), [starting(7), gone(7)]);

// A list whose ban list BattleMetrics no longer has, e.g. one removed on BattleMetrics, or left
// behind by a deletion before this order, is deleted the same way.
reset();
addList(8);
assert.strictEqual(await find(8).deleteExportBanList(), 'gone');
assert.deepStrictEqual(calls, [ownership('list-8'), lookUp('list-8'), cleared, ['destroy']]);
assert.ok(!rows.has(8));
assert.deepStrictEqual(posted(), [starting(8), gone(8)]);

// When such a list cannot be saved without its ban list, it is kept as it was, and deleting it
// again finds the ban list gone again and finishes, with the list looked up again and with the
// same list. The ban list is only said to be taken as deleted once the list no longer records it.
for (const sameList of [false, true]) {
  reset();
  addList(12);
  const saveError = new Error('Lock wait timeout exceeded; try restarting transaction');
  saveFailures.push(saveError);
  list = find(12);
  await assert.rejects(list.deleteExportBanList(), (error) => error === saveError);
  assert.strictEqual(saveError.stage, 'battlemetrics');
  assert.deepStrictEqual(calls, [ownership('list-12'), lookUp('list-12'), cleared]);
  const kept = { battlemetricsID: 'list-12', battlemetricsInvite: inviteURL('code-12') };
  assert.deepStrictEqual(stored(12), kept);
  const { battlemetricsID, battlemetricsInvite } = list;
  assert.deepStrictEqual({ battlemetricsID, battlemetricsInvite }, kept);
  assert.deepStrictEqual(posted(), [starting(12)]);

  reset();
  assert.strictEqual(await (sameList ? list : find(12)).deleteExportBanList(), 'gone');
  assert.deepStrictEqual(calls, [ownership('list-12'), lookUp('list-12'), cleared, ['destroy']]);
  assert.ok(!rows.has(12));
  assert.deepStrictEqual(posted(), [starting(12), gone(12)]);
}

// A ban list that BattleMetrics still has, but without the configured organisation on it, is not
// deleted, nor is the list, as the configured organisation may be wrong.
reset();
addList(9);
addBanList('list-9', { owner: '56746' });
await assert.rejects(find(9).deleteExportBanList(), {
  message:
    /^BattleMetrics deletion failed while checking ownership: The BattleMetrics list still exists, but the configured CBL organization does not own it, so the configured organization may be wrong\. The local list was retained;/,
  stage: 'battlemetrics'
});
assert.deepStrictEqual(calls, [ownership('list-9'), lookUp('list-9')]);
assert.deepStrictEqual(stored(9), {
  battlemetricsID: 'list-9',
  battlemetricsInvite: inviteURL('code-9')
});
assert.deepStrictEqual([...banLists.get('list-9').organizations], ['56746', '77', '88']);
assert.deepStrictEqual(posted(), [starting(9)]);

// The list is kept too when looking up its ban list gets any other answer than BattleMetrics' 404
// for a ban list it does not know: a refused key, a refusal, a rate limit, a failure, no answer in
// time, an answer that is not a ban list, or a 404 that does not say the ban list is unknown.
const timeout = Object.assign(
  new Error('BattleMetrics GET ban-lists/list-10 failed after 3 attempts: timed out after 30s'),
  { name: 'ApiError', code: 'ECONNABORTED' }
);
const otherAnswers = [
  apiError(401, [{ title: 'Unauthorized' }]),
  apiError(403, [{ title: 'Forbidden', detail: 'Unknown ban list.' }]),
  apiError(429, [{ title: 'Too Many Requests' }]),
  apiError(500, undefined),
  apiError(503, [{ title: 'Service Unavailable' }]),
  timeout,
  { data: '<html>Not JSON</html>' },
  apiError(404, undefined),
  apiError(404, [{ status: '404', title: 'Not Found', detail: 'Route not found.' }])
];
for (const other of otherAnswers) {
  reset();
  addList(10);
  answers.set(`get ${lookUp('list-10')[1]}`, () => {
    if (other instanceof Error) throw other;
    return other;
  });
  await assert.rejects(find(10).deleteExportBanList(), {
    message: /^BattleMetrics deletion failed while checking ownership: /,
    stage: 'battlemetrics'
  });
  assert.deepStrictEqual(calls, [ownership('list-10'), lookUp('list-10')]);
  assert.deepStrictEqual(stored(10), {
    battlemetricsID: 'list-10',
    battlemetricsInvite: inviteURL('code-10')
  });
  assert.deepStrictEqual(posted(), [starting(10)]);
}

// Only a 404 from the ownership check leads to the ban list being looked up. Any other failure
// keeps the list without a second request.
for (const status of [401, 403, 429, 500]) {
  reset();
  addList(11);
  addBanList('list-11');
  answers.set(`get ${ownership('list-11')[1]}`, () => {
    throw apiError(status, [{ title: `HTTP ${status}` }]);
  });
  await assert.rejects(find(11).deleteExportBanList(), {
    message: /while checking ownership/,
    stage: 'battlemetrics'
  });
  assert.deepStrictEqual(calls, [ownership('list-11')]);
  assert.strictEqual(stored(11).battlemetricsID, 'list-11');
  assert.deepStrictEqual(posted(), [starting(11)]);
}

// An invite's ID is its code, with which any organisation can use the ban list. When removing an
// invite fails without BattleMetrics saying why, e.g. as it timed out, the client's error names the
// request's path, with the code in it. The deletion's error, which the website shows the owner and
// which the website and the bot post, gives the path without it, and so does what the deletion
// posts.
reset();
addList(14);
addBanList('list-14');
const inviteRemoval = 'ban-lists/list-14/relationships/invites/invite-1';
answers.set(`delete ${inviteRemoval}`, () => {
  throw Object.assign(
    new Error(`BattleMetrics DELETE ${inviteRemoval} failed after 3 attempts: timed out after 30s`),
    { name: 'ApiError', code: 'ECONNABORTED', ambiguous: false }
  );
});
let removalError;
await assert.rejects(find(14).deleteExportBanList(), (error) => {
  removalError = error;
  return true;
});
assert.strictEqual(
  removalError.message,
  'BattleMetrics deletion failed while removing invites: BattleMetrics DELETE ban-lists/list-14/relationships/invites/[invite code] failed after 3 attempts: timed out after 30s. The local list was retained; any invites or subscriptions already removed remain removed.'
);
assert.strictEqual(removalError.stage, 'battlemetrics');
assert.ok(!describeError(removalError).includes('invite-1'));
assert.deepStrictEqual(posted(), [starting(14)]);

// No line posted here ever gave a list's invite, the invites' codes or the addresses the lists
// record, nor the lists' Discord webhook, and each was on one line.
assert.ok(everything.length > 30);
for (const [, , message, ...extras] of everything) {
  const errors = extras.filter((extra) => typeof extra?.message === 'string');
  const line = [message, ...errors.map(describeError)].join(' ');
  assert.ok(!/invite-\d|code-\d|accept-invite/.test(line), `A line gives an invite: ${line}`);
  assert.ok(
    !/webhook-token|discord\.com\/api\/webhooks/.test(line),
    `A line gives a webhook: ${line}`
  );
  assert.ok(!/[\r\n\u2028\u2029]/.test(line), `A line has a line break: ${JSON.stringify(line)}`);
}

console.log(
  'Export ban list deletion checks passed: the order of every step, putting the ban list back, trying again, ban lists already gone, and the lines they post.'
);
