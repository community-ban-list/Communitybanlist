import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import describeError from '../../scbl-lib/utils/describe-error.js';
import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import logText from '../../scbl-lib/utils/log-text.js';
import Validators from '../../scbl-lib/validators.js';

// Make export ban list changes on the website and read what they post to the CBL log channel:
// mutation/resolver.js with the real ExportBanList model and BattleMetrics deletion steps, against
// stand-ins for the database, BattleMetrics, Discord and the logger. Each change posts who made it
// and what it was, ExportBanList posts the BattleMetrics side, and no line ever gives a list's
// Discord webhook, its BattleMetrics invite or the BattleMetrics API key, even when a change fails.
// The lists keep their webhooks through the steps, so every kind of line is checked with one.

// The secrets the stand-ins hand out, which no posted line may give: the API key, which the
// errors of the BattleMetrics client's requests hold, as axios's do, the webhook's address and
// token, and the code of each invite BattleMetrics makes.
const API_KEY = 'bm-api-key-these-checks-use';
const WEBHOOK =
  'https://discord.com/api/webhooks/123456789012345678/webhook-token-these-checks-use';
const OTHER_WEBHOOK =
  'https://discord.com/api/webhooks/223456789012345678/other-token-these-checks-use';
const INVITE_CODE = 'invite-code-these-checks-use';
const SECRETS = [
  API_KEY,
  WEBHOOK,
  'webhook-token',
  OTHER_WEBHOOK,
  'other-token',
  INVITE_CODE,
  'accept-invite'
];

// CBL's BattleMetrics organisation.
const ORGANISATION = '56746';

const ALICE = { id: '76561198000000001', name: 'Alice' };
const as = (user) => ({ user });

// The log channel: each line posted, as the logger posts it, with its errors described in a line
// by describeError after it, each line only printed in the console (level 2), and the posted lines
// that went as important ones, ahead of the channel's other messages.
const posted = [];
const printed = [];
const important = [];
function log(module, level, message, extras) {
  const errors = extras.filter((extra) => typeof extra?.message === 'string');
  let text = `${message}`;
  if (errors.length > 0)
    text += `${/\s$/.test(text) ? '' : ' '}${errors.map(describeError).join(', ')}`;
  (level === 1 ? posted : printed).push(`[${module}][${level}] ${text}`);
}
const Logger = {
  verbose: (module, level, message, ...extras) => log(module, level, message, extras),
  important(module, message, ...extras) {
    log(module, 1, message, extras);
    important.push(posted.at(-1));
  }
};

// Take the lines posted since the last time, checking that none gives a secret, or has a line
// break, with which a line could look like two.
function take() {
  const lines = posted.splice(0);
  for (const line of [...lines, ...printed]) {
    for (const secret of SECRETS)
      assert.ok(!line.includes(secret), `A line gives ${secret}: ${line}`);
    assert.ok(!/[\r\n\u2028\u2029]/.test(line), `A line has a line break: ${JSON.stringify(line)}`);
  }
  return lines;
}

// The clock the resolvers read, which only moves when the checks move it.
let now = Date.UTC(2026, 9, 23, 12);
class ClockDate extends Date {
  static now() {
    return now;
  }
}

// What the web server printed with console.error, which holds more of a failure, but is never
// posted.
const consoleErrors = [];

// BattleMetrics' ban lists, by ID: the organisations on each, its owner among them, and its
// invites. A ban list is gone once its owner has left it. Each request made is recorded, and an
// answer in `answers`, by method and endpoint, replaces BattleMetrics' own, given a function that
// makes the request as BattleMetrics would.
const banLists = new Map();
let nextBanList = 98765;
const requests = [];
const answers = new Map();

// An error as the BattleMetrics client throws one. The config and request stand for what axios's
// errors hold, the API key among it, which must never be posted.
function apiError(message, { status, errors, ambiguous = false } = {}) {
  return Object.assign(new Error(message), {
    name: 'ApiError',
    status,
    ambiguous,
    ...(status ? { response: { status, data: { errors } } } : {}),
    config: {
      url: `https://api.battlemetrics.com/ban-lists?key=${API_KEY}`,
      headers: { Authorization: `Bearer ${API_KEY}` }
    },
    request: { _header: `Authorization: Bearer ${API_KEY}` }
  });
}
const notFound = (detail) =>
  apiError('BattleMetrics request failed: HTTP 404', {
    status: 404,
    errors: [{ status: '404', title: 'Not Found', detail }]
  });

const page = (records) => ({ data: { data: records, links: {} } });
function answer(method, endpoint) {
  if (method === 'post' && endpoint === 'ban-lists') {
    const id = String(nextBanList++);
    banLists.set(id, {
      owner: ORGANISATION,
      organizations: new Set([ORGANISATION, '77']),
      invites: new Set()
    });
    return { data: { data: { type: 'banList', id } } };
  }
  const [, id, relationship] = endpoint.match(/^ban-lists\/([^/]+)(?:\/relationships\/(.+))?$/);
  const banList = banLists.get(id);
  if (!banList) throw notFound('Unknown ban list.');
  if (!relationship) return { data: { data: { type: 'banList', id } } };
  if (relationship === 'invites') {
    if (method === 'post') {
      banList.invites.add(INVITE_CODE);
      return { data: { data: { type: 'banListInvite', id: INVITE_CODE } } };
    }
    return page([...banList.invites].map((invite) => ({ type: 'banListInvite', id: invite })));
  }
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
  if (!members.has(member)) throw notFound();
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
  requests.push(`${method} ${endpoint}`);
  const replacement = answers.get(`${method} ${endpoint}`);
  return replacement ? replacement(() => answer(method, endpoint)) : answer(method, endpoint);
}

// The database's rows, by model. Lists are looked up as copies of their rows, as Sequelize does,
// and only save, create and destroy write to the rows. A write fails with the next error in
// `failures` for it, by model and method, e.g. 'ExportBanList.save'.
const rows = { ExportBanList: [], ExportBanListConfig: [], BanList: [], Organisation: [] };
const failures = new Map();
let nextID = 1;
function failure(name) {
  const error = failures.get(name)?.shift();
  if (error) throw error;
}
const matches = (row, where) =>
  Object.entries(where).every(([field, value]) => {
    if (field !== '$ExportBanList.owner$') return row[field] === value;
    const list = rows.ExportBanList.find(({ id }) => id === row.exportBanList);
    return list?.owner === value;
  });

// ExportBanList's columns, which its rows store.
const LIST_COLUMNS = [
  'id',
  'name',
  'server',
  'type',
  'threshold',
  'defaultActivePoints',
  'defaultExpiredPoints',
  'maxBanAge',
  'discordWebhook',
  'generated',
  'battlemetricsID',
  'battlemetricsInvite',
  'owner'
];

// A stand-in for Sequelize's Model, which the real ExportBanList extends.
class Model {
  static init() {}

  static async count({ where }) {
    return rows.ExportBanList.filter((row) => matches(row, where)).length;
  }

  static async create(values) {
    failure('ExportBanList.create');
    const row = {
      id: nextID++,
      generated: false,
      battlemetricsID: null,
      battlemetricsInvite: null
    };
    for (const column of LIST_COLUMNS) if (column in values) row[column] = values[column];
    rows.ExportBanList.push(row);
    return Object.assign(new this(), row);
  }

  static async findOne({ where }) {
    const row = rows.ExportBanList.find((list) => matches(list, where));
    return row ? Object.assign(new this(), row) : null;
  }

  static async findAll({ where }) {
    return rows.ExportBanList.filter((list) => matches(list, where)).map((row) =>
      Object.assign(new this(), row)
    );
  }

  async save() {
    failure('ExportBanList.save');
    const row = rows.ExportBanList.find(({ id }) => id === this.id);
    for (const column of LIST_COLUMNS) row[column] = this[column];
  }

  async destroy() {
    failure('ExportBanList.destroy');
    rows.ExportBanList.splice(
      rows.ExportBanList.findIndex(({ id }) => id === this.id),
      1
    );
    rows.ExportBanListConfig = rows.ExportBanListConfig.filter(
      (config) => config.exportBanList !== this.id
    );
  }

  // The website deletes a list only while its user owns it, and gives how many rows it deleted.
  static async destroy({ where }) {
    failure('ExportBanList.destroy');
    const deleted = rows.ExportBanList.filter((row) => matches(row, where));
    rows.ExportBanList = rows.ExportBanList.filter((row) => !deleted.includes(row));
    rows.ExportBanListConfig = rows.ExportBanListConfig.filter(
      (config) => !deleted.some(({ id }) => id === config.exportBanList)
    );
    return deleted.length;
  }
}
const dataType = () => dataType;

// Stand-ins for the other models the resolvers use, with the rows they include.
const models = {
  BanList: {
    async findOne({ where, include }) {
      assert.ok(include.length === 1 && include[0] === models.Organisation);
      const banList = rows.BanList.find((row) => matches(row, where));
      if (!banList) return null;
      const organisation = rows.Organisation.find(({ id }) => id === banList.organisation);
      return { ...banList, Organisation: { ...organisation } };
    }
  },
  Organisation: {},
  ExportBanListConfig: {
    async findAll({ where }) {
      return rows.ExportBanListConfig.filter((row) => matches(row, where)).map((config) => {
        const banList = rows.BanList.find(({ id }) => id === config.banList);
        const organisation = rows.Organisation.find(({ id }) => id === banList.organisation);
        return { ...config, BanList: { ...banList, Organisation: { ...organisation } } };
      });
    },
    async findOne({ where }) {
      const row = rows.ExportBanListConfig.find((config) => matches(config, where));
      if (!row) return null;
      return {
        ...row,
        ExportBanList: { ...rows.ExportBanList.find(({ id }) => id === row.exportBanList) },
        async destroy() {
          failure('ExportBanListConfig.destroy');
          rows.ExportBanListConfig.splice(rows.ExportBanListConfig.indexOf(row), 1);
        }
      };
    },
    async create(values) {
      failure('ExportBanListConfig.create');
      const row = { id: nextID++, ...values };
      rows.ExportBanListConfig.push(row);
      return { ...row };
    }
  }
};

// Load a module in a context. The imports in `stubs` get those exports, and other relative
// imports load the real files.
async function load(path, stubs, context) {
  const create = async (url) =>
    new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  const module = await create(new URL(path, import.meta.url));
  await module.link(async (specifier, referencingModule) => {
    if (Object.hasOwn(stubs, specifier)) {
      const exports = stubs[specifier];
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    }
    assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    return create(new URL(specifier, referencingModule.identifier));
  });
  await module.evaluate();
  return module.namespace;
}

// The limits on export ban lists, with no limit on their players, so no list's players are
// counted.
const LIMITS = exportListLimits.readLimits({
  EXPORT_BM_MAX_PLAYERS: '0',
  EXPORT_REMOTE_MAX_PLAYERS: '0'
}).limits;

// The real ExportBanList, with the real BattleMetrics deletion steps and page reader. Its
// transactions only run their work, its query for a user's Steam user row, as their lists are
// locked, answers at once, no connection holds a list's deletion lock when it asks, and the
// deletion lock's connection takes every lock it asks for (export-ban-list-locks.js in scbl-lib
// checks these).
const { default: ExportBanList } = await load(
  '../../scbl-lib/db/models/export-ban-list.js',
  {
    sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
    '../sequelize.js': {
      default: {
        models: {},
        transaction: (work) => work({}),
        query: async (sql, options) => (options?.plain ? { holder: null } : [[], {}])
      }
    },
    '../open-connection.js': {
      default: async () => ({
        query: async () => [[{ taken: 1 }]],
        end: async () => {},
        destroy() {}
      })
    },
    // Only the bot's check of stored lists against the limits counts their players this way.
    '../export-membership.js': {
      countMembers: () => assert.fail('No players are counted here.')
    },
    '../../apis/index.js': { battlemetrics },
    './battlemetrics.js': { default: battlemetrics },
    '../config.js': { BATTLEMETRICS_ORGANIZATION: ORGANISATION },
    '../../export-list-limits.js': exportListLimits,
    '../../utils/index.js': { Logger },
    '../../config.js': { BATTLEMETRICS_ORGANIZATION: ORGANISATION, EXPORT_LIST_LIMITS: LIMITS }
  },
  vm.createContext({ URL, setTimeout, clearTimeout })
);
models.ExportBanList = ExportBanList;

// The resolvers, as resolver.js has them, with its log lines and webhook tests. Every webhook
// test passes.
const tested = [];
const {
  default: { Mutation }
} = await load(
  '../src/graphql-api/mutation/resolver.js',
  {
    'scbl-lib/config': { EXPORT_LIST_LIMITS: LIMITS },
    'scbl-lib/db/models': models,
    'scbl-lib/db/export-membership': {
      countMembers() {
        throw new Error('A list was counted with no limit on its players.');
      },
      countPlayersWithBans() {
        throw new Error('Players were counted with no limit on lists.');
      }
    },
    // The pool the counts run on, which is never used with no limit.
    'scbl-lib/db/sequelize': {
      createPool: () => ({
        async transaction() {
          throw new Error('Players were counted with no limit on lists.');
        }
      }),
      Transaction: { ISOLATION_LEVELS: { REPEATABLE_READ: 'REPEATABLE READ' } }
    },
    'scbl-lib/export-list-limits': exportListLimits,
    'scbl-lib/utils': {
      Logger,
      logText,
      isDiscordWebhookUrl,
      async testDiscordWebhook(url) {
        tested.push(url);
      }
    },
    'scbl-lib/validators': { default: Validators }
  },
  vm.createContext({
    Date: ClockDate,
    console: { error: (...args) => consoleErrors.push(args), log() {}, warn() {} }
  })
);
const { LINES_PER_MINUTE } = await load(
  '../src/graphql-api/mutation/audit.js',
  { 'scbl-lib/utils': { Logger, logText } },
  vm.createContext({})
);

// Each user's lines are limited to LINES_PER_MINUTE a minute, so the checks move the clock on a
// minute after each, except for those that check the limit.
async function change(name, args, user = ALICE) {
  now += 60 * 1000;
  return Mutation[name](null, args, as(user));
}
async function refused(name, args, message, user = ALICE) {
  await assert.rejects(change(name, args, user), { message });
}

const ALICE_TEXT = `Steam user "Alice" (ID: ${ALICE.id})`;
const DEFAULTS =
  'threshold 9, 3 points for an active ban and 1 for an expired ban, max ban age none';

// Creating a remote list posts one line: who created which list, with its settings, and whether
// it has a Discord webhook, never its address.
const remote = await change('createExportBanList', {
  name: 'Remote',
  server: 'Server',
  type: 'remote',
  discordWebhook: WEBHOOK
});
assert.deepStrictEqual(tested, [WEBHOOK]);
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} created export ban list Server's List "Remote" (ID: ${remote.id}, remote): ${DEFAULTS}, Discord webhook set.`
]);

// Creating a BattleMetrics list posts two: ExportBanList's, saying which ban list it made for which
// list, with its owner's Steam ID, as it looks nothing up, and that it made its invite, which it
// never gives, and the website's, with who created it and its settings.
let bm = await change('createExportBanList', {
  name: 'Bans',
  server: 'Server',
  type: 'battlemetrics',
  threshold: 10,
  defaultActivePoints: 4,
  defaultExpiredPoints: 2,
  maxBanAge: 30
});
assert.strictEqual(bm.battlemetricsID, '98765');
assert.ok(bm.battlemetricsInvite.endsWith(INVITE_CODE));
const bmList = (name = 'Bans', id = bm.id) => `Server's List "${name}" (ID: ${id}, BattleMetrics)`;
const ownedBy = (list) => `${list} of Steam user ${ALICE.id}`;
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Created BattleMetrics ban list 98765 for ${ownedBy(bmList())}, with its invite.`,
  `[WebServer][1] ${ALICE_TEXT} created export ban list ${bmList()}: threshold 10, 4 points for an active ban and 2 for an expired ban, max ban age 30 days, no Discord webhook.`
]);

// Saving a list posts one line with only what changed, each as old → new, and a webhook only as
// set or not.
await change('updateExportBanList', {
  id: bm.id,
  name: 'Renamed',
  server: 'Server',
  threshold: 12,
  defaultActivePoints: 4,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: WEBHOOK
});
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: name "Bans" → "Renamed", threshold 10 → 12, points for an expired ban 2 → 1, max ban age 30 days → none, Discord webhook none → set.`
]);

// Saving it again with the same values, as the edit form sends every value, posts nothing. Another
// webhook is only said to be changed, and removing it to be none.
await change('updateExportBanList', { id: bm.id, name: 'Renamed', discordWebhook: WEBHOOK });
assert.deepStrictEqual(take(), []);
await change('updateExportBanList', { id: bm.id, discordWebhook: OTHER_WEBHOOK });
await change('updateExportBanList', { id: bm.id, discordWebhook: '' });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: Discord webhook changed.`,
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: Discord webhook set → none.`
]);
// The list gets its webhook back, and keeps it through its invite, configs and deletion below.
await change('updateExportBanList', { id: bm.id, discordWebhook: WEBHOOK });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: Discord webhook none → set.`
]);

// A list whose invite was not made gets it when it is saved, which ExportBanList posts.
rows.ExportBanList.find(({ id }) => id === bm.id).battlemetricsInvite = null;
await change('updateExportBanList', { id: bm.id, server: 'Community' });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list Community's List "Renamed" (ID: ${bm.id}, BattleMetrics): server "Server" → "Community".`,
  `[ExportBanList][1] Created the invite to BattleMetrics ban list 98765 for Community's List "Renamed" (ID: ${bm.id}, BattleMetrics) of Steam user ${ALICE.id}.`
]);

// When the invite cannot be made, the changes are saved, and a line says so, with BattleMetrics'
// answer, never the API key the error holds.
rows.ExportBanList.find(({ id }) => id === bm.id).battlemetricsInvite = null;
const inviteEndpoint = 'post ban-lists/98765/relationships/invites';
answers.set(inviteEndpoint, () => {
  throw apiError(
    'BattleMetrics POST ban-lists/98765/relationships/invites failed after 3 attempts: HTTP 502 (Bad Gateway)',
    { status: 502, errors: [{ title: 'Bad Gateway' }] }
  );
});
await change('updateExportBanList', { id: bm.id, server: 'Server' });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: server "Community" → "Server".`,
  `[WebServer][1] ${ALICE_TEXT} saved export ban list ${bmList('Renamed')}, but its missing invite to BattleMetrics ban list 98765 could not be made, which saving the list tries again: ApiError: BattleMetrics POST ban-lists/98765/relationships/invites failed after 3 attempts: HTTP 502 (Bad Gateway)`
]);
answers.delete(inviteEndpoint);

// When BattleMetrics makes the invite but the list cannot be saved with it, the changes are saved,
// and the line says so, with the save's error. The list holds the invite's address by then, but
// the line never gives it. Saving the list again makes the invite again.
failures.set('ExportBanList.save', [null, new Error('Lock wait timeout exceeded')]);
const unsavedInvite = await change('updateExportBanList', { id: bm.id, server: 'Community' });
assert.ok(unsavedInvite.battlemetricsInvite.endsWith(INVITE_CODE));
assert.strictEqual(rows.ExportBanList.find(({ id }) => id === bm.id).battlemetricsInvite, null);
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list Community's List "Renamed" (ID: ${bm.id}, BattleMetrics): server "Server" → "Community".`,
  `[WebServer][1] ${ALICE_TEXT} saved export ban list Community's List "Renamed" (ID: ${bm.id}, BattleMetrics), but its missing invite to BattleMetrics ban list 98765 could not be made, which saving the list tries again: Error: Lock wait timeout exceeded`
]);
await change('updateExportBanList', { id: bm.id, server: 'Server' });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${bmList('Renamed')}: server "Community" → "Server".`,
  `[ExportBanList][1] Created the invite to BattleMetrics ban list 98765 for ${ownedBy(bmList('Renamed'))}.`
]);

// Adding and deleting a config each post one line: the ban list, with its organisation, and the
// points it gives.
rows.Organisation.push({ id: 1, name: 'Partner Org' });
rows.BanList.push({ id: 3, name: 'Partner Bans', organisation: 1 });
const config = await change('createExportBanListConfig', {
  exportBanList: bm.id,
  banList: 3,
  activePoints: 5,
  expiredPoints: 2
});
const CONFIG =
  'ban list "Partner Bans" (ID: 3) of organisation "Partner Org", 5 points for an active ban and 2 for an expired ban';
await change('deleteExportBanListConfig', { id: config.id });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} added a config to export ban list ${bmList('Renamed')}: ${CONFIG}.`,
  `[WebServer][1] ${ALICE_TEXT} deleted a config from export ban list ${bmList('Renamed')}: ${CONFIG}.`
]);

// Deleting a BattleMetrics list posts three lines: ExportBanList's as it starts deleting its ban
// list, which can take minutes, and once it has, and the website's, with who deleted the list and
// what happened to its ban list.
await change('deleteExportBanList', { id: bm.id });
assert.ok(!banLists.has('98765'));
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list 98765 for ${ownedBy(bmList('Renamed'))}, which can take minutes.`,
  `[ExportBanList][1] Deleted BattleMetrics ban list 98765 for ${ownedBy(bmList('Renamed'))}, with its invites and subscribers.`,
  `[WebServer][1] ${ALICE_TEXT} deleted export ban list ${bmList('Renamed')} and its BattleMetrics ban list 98765.`
]);

// Deleting a remote list posts one line, as nothing is done on BattleMetrics.
await change('deleteExportBanList', { id: remote.id });
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} deleted export ban list Server's List "Remote" (ID: ${remote.id}, remote).`
]);

// A BattleMetrics list with no ban list posts two: ExportBanList's, that it has none to delete,
// and the website's. One whose ban list BattleMetrics no longer has posts three, which only say
// that BattleMetrics did not know it, as BattleMetrics says the same of a ban list CBL's key cannot
// see.
const bmArgs = { name: 'Bans', server: 'Server', type: 'battlemetrics', discordWebhook: WEBHOOK };
bm = await change('createExportBanList', bmArgs);
take();
rows.ExportBanList.find(({ id }) => id === bm.id).battlemetricsID = null;
await change('deleteExportBanList', { id: bm.id });
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] ${ownedBy(bmList())} has no BattleMetrics ban list to delete.`,
  `[WebServer][1] ${ALICE_TEXT} deleted export ban list ${bmList()}, which had no BattleMetrics ban list.`
]);
bm = await change('createExportBanList', bmArgs);
take();
banLists.delete(bm.battlemetricsID);
await change('deleteExportBanList', { id: bm.id });
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list ${bm.battlemetricsID} for ${ownedBy(bmList())}, which can take minutes.`,
  `[ExportBanList][1] BattleMetrics does not know ban list ${bm.battlemetricsID} for ${ownedBy(bmList())} (HTTP 404, Unknown ban list), so it is taken to be deleted already.`,
  `[WebServer][1] ${ALICE_TEXT} deleted export ban list ${bmList()}; BattleMetrics did not know its ban list ${bm.battlemetricsID}, so it was taken to be deleted already.`
]);

// When removing the ban list's invite times out, the client's error names the request's path, with
// the invite's code in it. The deletion's error, which the owner is shown, and the line the
// website posts, after the one as the deletion started, give the path without it.
bm = await change('createExportBanList', bmArgs);
take();
const removal = `ban-lists/${bm.battlemetricsID}/relationships/invites/${INVITE_CODE}`;
answers.set(`delete ${removal}`, () => {
  throw apiError(`BattleMetrics DELETE ${removal} failed after 3 attempts: timed out after 30s`);
});
await assert.rejects(change('deleteExportBanList', { id: bm.id }), (error) => {
  assert.ok(!error.message.includes(INVITE_CODE), error.message);
  return true;
});
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list ${bm.battlemetricsID} for ${ownedBy(bmList())}, which can take minutes.`,
  `[WebServer][1] ${ALICE_TEXT} could not delete export ban list ${bmList()}, as deleting its BattleMetrics ban list ${bm.battlemetricsID} failed: ApiError: BattleMetrics deletion failed while removing invites: BattleMetrics DELETE ban-lists/${bm.battlemetricsID}/relationships/invites/[invite code] failed after 3 attempts: timed out after 30s. The local list was retained; any invites or subscriptions already removed remain removed.`
]);
answers.delete(`delete ${removal}`);

// When the row cannot be deleted after the ban list was, the line says so, after ExportBanList's.
failures.set('ExportBanList.destroy', [new Error('Deadlock found when trying to get lock')]);
await assert.rejects(change('deleteExportBanList', { id: bm.id }), /Deadlock/);
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list ${bm.battlemetricsID} for ${ownedBy(bmList())}, which can take minutes.`,
  `[ExportBanList][1] Deleted BattleMetrics ban list ${bm.battlemetricsID} for ${ownedBy(bmList())}, with its invites and subscribers.`,
  `[WebServer][1] ${ALICE_TEXT} could not delete export ban list ${bmList()}, as deleting it from the database failed: Error: Deadlock found when trying to get lock`
]);
await change('deleteExportBanList', { id: bm.id });
assert.strictEqual(take().length, 2);

// When BattleMetrics does not create the ban list, the list is deleted and one line says so, with
// why. When BattleMetrics did not answer, it may have made the ban list anyway, which nothing
// records, so the line says what to look for on BattleMetrics, and is posted as an important line,
// ahead of others.
answers.set('post ban-lists', () => {
  throw apiError(
    'BattleMetrics POST ban-lists failed: timed out after 30s, so it may have been carried out',
    {
      ambiguous: true
    }
  );
});
await refused(
  'createExportBanList',
  { name: 'Bans', server: 'Server', type: 'battlemetrics' },
  'BattleMetrics could not create a ban list for your export ban list, so it was not created. Please try again later.'
);
const unmade = (id) =>
  `[WebServer][1] ${ALICE_TEXT} could not create export ban list ${bmList('Bans', id)}, as making its BattleMetrics ban list failed`;
let id = nextID - 1;
const ambiguous = `${unmade(id)}, so the list was deleted. BattleMetrics may have made the ban list anyway, which nothing records: look for "Community Ban List - Bans (ID: ${id})" among CBL's ban lists on BattleMetrics, and remove it. ApiError: BattleMetrics POST ban-lists failed: timed out after 30s, so it may have been carried out`;
assert.deepStrictEqual(take(), [ambiguous]);
assert.deepStrictEqual(important.splice(0), [ambiguous]);

// So does the line when the list cannot be deleted either.
failures.set('ExportBanList.destroy', [new Error('Database unavailable')]);
await refused(
  'createExportBanList',
  { name: 'Bans', server: 'Server', type: 'battlemetrics' },
  'BattleMetrics could not create a ban list for your export ban list. Please delete it and try again later.'
);
id = nextID - 1;
const ambiguousKept = `${unmade(id)}, and the list could not be deleted either, so its owner was asked to delete it. BattleMetrics may have made the ban list anyway, which nothing records: look for "Community Ban List - Bans (ID: ${id})" among CBL's ban lists on BattleMetrics, and remove it. ApiError: BattleMetrics POST ban-lists failed: timed out after 30s, so it may have been carried out, Error: Database unavailable`;
assert.deepStrictEqual(take(), [ambiguousKept]);
assert.deepStrictEqual(important.splice(0), [ambiguousKept]);
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== id);

// When the list cannot be deleted either, the one line gives both failures. BattleMetrics saying
// no is not a request it may have carried out, so there is nothing to look for on BattleMetrics.
answers.set('post ban-lists', () => {
  throw apiError('BattleMetrics POST ban-lists failed: HTTP 400 (Bad Request)', {
    status: 400,
    errors: [{ title: 'Bad Request' }]
  });
});
failures.set('ExportBanList.destroy', [new Error('Database unavailable')]);
await refused(
  'createExportBanList',
  { name: 'Bans', server: 'Server', type: 'battlemetrics' },
  'BattleMetrics could not create a ban list for your export ban list. Please delete it and try again later.'
);
id = nextID - 1;
assert.deepStrictEqual(take(), [
  `${unmade(id)}, and the list could not be deleted either, so its owner was asked to delete it. ApiError: BattleMetrics POST ban-lists failed: HTTP 400 (Bad Request), Error: Database unavailable`
]);
assert.deepStrictEqual(important, []);
answers.delete('post ban-lists');
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== id);

// When the list cannot be saved with the ban list BattleMetrics made, the one line gives the ban
// list, which nothing records, to be removed by hand, and is posted as an important line.
failures.set('ExportBanList.save', [new Error('Lock wait timeout exceeded')]);
await refused(
  'createExportBanList',
  { name: 'Bans', server: 'Server', type: 'battlemetrics' },
  'Lock wait timeout exceeded'
);
id = nextID - 1;
const unsaved = String(nextBanList - 1);
const unsavedLine = `[WebServer][1] ${ALICE_TEXT} created export ban list ${bmList('Bans', id)}: ${DEFAULTS}, no Discord webhook. BattleMetrics ban list ${unsaved} was made for it, but saving it to the list failed, so nothing records the ban list, which must be removed on BattleMetrics by hand: Error: Lock wait timeout exceeded`;
assert.deepStrictEqual(take(), [unsavedLine]);
assert.deepStrictEqual(important.splice(0), [unsavedLine]);
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== id);

// When its invite cannot be made, the list keeps its ban list, and the one line says so.
const withoutInvite = String(nextBanList);
const inviteFailure = `BattleMetrics POST ban-lists/${withoutInvite}/relationships/invites failed after 3 attempts: HTTP 503`;
answers.set(`post ban-lists/${withoutInvite}/relationships/invites`, () => {
  throw apiError(inviteFailure, { status: 503 });
});
await refused(
  'createExportBanList',
  { name: 'Bans', server: 'Server', type: 'battlemetrics', discordWebhook: WEBHOOK },
  inviteFailure
);
id = nextID - 1;
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} created export ban list ${bmList('Bans', id)} with BattleMetrics ban list ${withoutInvite}: ${DEFAULTS}, Discord webhook set. Its invite could not be made, which saving the list tries again: ApiError: ${inviteFailure}`
]);
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== id);

// So does it when BattleMetrics makes the invite but the list cannot be saved with it. The list
// holds the invite's address by then, but neither the line nor the error the owner is shown gives
// it.
failures.set('ExportBanList.save', [null, new Error('Lock wait timeout exceeded')]);
const inviteUnsaved = String(nextBanList);
await refused('createExportBanList', bmArgs, 'Lock wait timeout exceeded');
id = nextID - 1;
assert.ok(banLists.get(inviteUnsaved).invites.has(INVITE_CODE));
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} created export ban list ${bmList('Bans', id)} with BattleMetrics ban list ${inviteUnsaved}: ${DEFAULTS}, Discord webhook set. Its invite could not be made, which saving the list tries again: Error: Lock wait timeout exceeded`
]);
assert.ok(!JSON.stringify(consoleErrors).includes(INVITE_CODE));
assert.deepStrictEqual(important, []);
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== id);

// The database's other failures each post a line saying which list and what failed: a list that
// cannot be created, saved, or have a config added or deleted.
failures.set('ExportBanList.create', [new Error('Database unavailable')]);
await refused(
  'createExportBanList',
  { name: 'Remote', server: 'Server', type: 'remote' },
  'Database unavailable'
);
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} could not create export ban list Server's List "Remote" (remote): Error: Database unavailable`
]);
const kept = await change('createExportBanList', {
  name: 'Kept',
  server: 'Server',
  type: 'remote',
  discordWebhook: WEBHOOK
});
const keptList = `Server's List "Kept" (ID: ${kept.id}, remote)`;
take();
failures.set('ExportBanList.save', [new Error('Database unavailable')]);
await refused('updateExportBanList', { id: kept.id, name: 'New' }, 'Database unavailable');
failures.set('ExportBanList.save', [new Error('Database unavailable')]);
await refused(
  'updateExportBanList',
  { id: kept.id, discordWebhook: OTHER_WEBHOOK },
  'Database unavailable'
);
failures.set('ExportBanListConfig.create', [new Error('Database unavailable')]);
const configArgs = { exportBanList: kept.id, banList: 3, activePoints: 2, expiredPoints: 1 };
await refused('createExportBanListConfig', configArgs, 'Database unavailable');
const keptConfig = await change('createExportBanListConfig', configArgs);
failures.set('ExportBanListConfig.destroy', [new Error('Database unavailable')]);
await refused('deleteExportBanListConfig', { id: keptConfig.id }, 'Database unavailable');
const KEPT_CONFIG =
  'ban list "Partner Bans" (ID: 3) of organisation "Partner Org", 2 points for an active ban and 1 for an expired ban';
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${ALICE_TEXT} could not save export ban list ${keptList} (name "Kept" → "New"): Error: Database unavailable`,
  `[WebServer][1] ${ALICE_TEXT} could not save export ban list ${keptList} (Discord webhook changed): Error: Database unavailable`,
  `[WebServer][1] ${ALICE_TEXT} could not add a config to export ban list ${keptList} (${KEPT_CONFIG}): Error: Database unavailable`,
  `[WebServer][1] ${ALICE_TEXT} added a config to export ban list ${keptList}: ${KEPT_CONFIG}.`,
  `[WebServer][1] ${ALICE_TEXT} could not delete a config from export ban list ${keptList} (${KEPT_CONFIG}): Error: Database unavailable`
]);

// Changes refused before anything is saved post nothing, as they change nothing: a mistake in a
// new list, a value out of bounds, too many lists, and lists and configs that do not exist, or are
// another user's.
await refused(
  'createExportBanList',
  { name: 'Bad', server: 'Server', type: 'other' },
  'Invalid export ban list type.'
);
await refused(
  'createExportBanList',
  { name: 'Bad', server: 'Server', type: 'remote', discordWebhook: 'https://example.com/hook' },
  'Invalid Discord Webhook'
);
await refused(
  'updateExportBanList',
  { id: kept.id, threshold: 0 },
  'The threshold must be a whole number from 1 to 1,000.'
);
await refused('updateExportBanList', { id: 999, name: 'New' }, 'Export ban list does not exist!');
await refused('deleteExportBanList', { id: 999 }, 'Export ban list does not exist!');
const BOB = { id: '76561198000000002' };
await refused('deleteExportBanList', { id: kept.id }, 'Export ban list does not exist!', BOB);
await refused(
  'createExportBanListConfig',
  configArgs,
  'Export ban list config already exists for this ban list.'
);
await refused(
  'deleteExportBanListConfig',
  { id: keptConfig.id },
  'Export ban list config does not exist!',
  BOB
);
// So is a config for a ban list paused as the request read them, among the checks, before the list
// is locked to save it.
rows.BanList.push({ id: 5, name: 'Paused Bans', organisation: 1 });
now += 60 * 1000;
await assert.rejects(
  Mutation.createExportBanListConfig(
    null,
    { ...configArgs, banList: 5 },
    { ...as(ALICE), paused: new Set([5]) }
  ),
  { message: 'That ban list is paused, so no config can be added for it until it counts again.' }
);
assert.deepStrictEqual(take(), []);
for (let i = 0; i < 3; i++)
  await change('createExportBanList', { name: `List ${i}`, server: 'Server', type: 'remote' });
take();
await refused(
  'createExportBanList',
  { name: 'Fifth', server: 'Server', type: 'remote' },
  'You are limited to 4 export ban lists.'
);
assert.deepStrictEqual(take(), []);

// A user CBL has no Steam name for is named by their Steam ID.
const bobs = await change(
  'createExportBanList',
  { name: 'Bob', server: 'Server', type: 'remote' },
  BOB
);
assert.deepStrictEqual(take(), [
  `[WebServer][1] Steam user ${BOB.id} created export ban list Server's List "Bob" (ID: ${bobs.id}, remote): ${DEFAULTS}, no Discord webhook.`
]);

// Names are their users' to choose, so each is kept on one line and shown as written, in the
// website's lines and in ExportBanList's: a line break in a name becomes a space, and the
// characters Discord reads as Markdown get a backslash.
const MALLORY = { id: '76561198000000003', name: 'xX_Sniper_Xx||' };
const MALLORY_TEXT = `Steam user "xX\\_Sniper\\_Xx\\|\\|" (ID: ${MALLORY.id})`;
const odd = await change(
  'createExportBanList',
  { name: 'M\n[DiscordBot][1] admin (1) removed', server: '||AFO', type: 'battlemetrics' },
  MALLORY
);
const ODD_NAME = 'M \\[DiscordBot\\]\\[1\\] admin (1) removed';
const MASKED = '\\[Main\\](https://example.com/x)';
const oddList = (name) => `\\|\\|AFO's List "${name}" (ID: ${odd.id}, BattleMetrics)`;
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Created BattleMetrics ban list ${odd.battlemetricsID} for ${oddList(ODD_NAME)} of Steam user ${MALLORY.id}, with its invite.`,
  `[WebServer][1] ${MALLORY_TEXT} created export ban list ${oddList(ODD_NAME)}: ${DEFAULTS}, no Discord webhook.`
]);
await change('updateExportBanList', { id: odd.id, name: '[Main](https://example.com/x)' }, MALLORY);
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${MALLORY_TEXT} updated export ban list ${oddList(MASKED)}: name "${ODD_NAME}" → "${MASKED}".`
]);
// The names of ban lists and organisations, which CBL's admins choose, are shown the same way.
rows.Organisation.push({ id: 2, name: 'Org_Name' });
rows.BanList.push({ id: 4, name: 'Bans\n||x||', organisation: 2 });
const oddConfig = await change(
  'createExportBanListConfig',
  { exportBanList: odd.id, banList: 4, activePoints: 1, expiredPoints: 1 },
  MALLORY
);
await change('deleteExportBanListConfig', { id: oddConfig.id }, MALLORY);
const ODD_CONFIG =
  'ban list "Bans \\|\\|x\\|\\|" (ID: 4) of organisation "Org\\_Name", 1 point for an active ban and 1 for an expired ban';
assert.deepStrictEqual(take(), [
  `[WebServer][1] ${MALLORY_TEXT} added a config to export ban list ${oddList(MASKED)}: ${ODD_CONFIG}.`,
  `[WebServer][1] ${MALLORY_TEXT} deleted a config from export ban list ${oddList(MASKED)}: ${ODD_CONFIG}.`
]);
await change('deleteExportBanList', { id: odd.id }, MALLORY);
assert.deepStrictEqual(take(), [
  `[ExportBanList][1] Deleting BattleMetrics ban list ${odd.battlemetricsID} for ${oddList(MASKED)} of Steam user ${MALLORY.id}, which can take minutes.`,
  `[ExportBanList][1] Deleted BattleMetrics ban list ${odd.battlemetricsID} for ${oddList(MASKED)} of Steam user ${MALLORY.id}, with its invites and subscribers.`,
  `[WebServer][1] ${MALLORY_TEXT} deleted export ban list ${oddList(MASKED)} and its BattleMetrics ban list ${odd.battlemetricsID}.`
]);

// Each user's changes post at most LINES_PER_MINUTE lines a minute. The rest are only printed in
// the web server's console, and the first of them posts one line saying so. Another user's lines
// are not held back. A failure is always posted, and does not count: here a save that fails, and a
// BattleMetrics ban list made for a list that could not be saved with it, which must be removed by
// hand, so its line goes ahead of others. A minute later the user's lines are posted again, after
// one saying how many went to the console only.
now += 60 * 1000;
printed.length = 0;
for (let i = 0; i < LINES_PER_MINUTE + 2; i++)
  await Mutation.updateExportBanList(null, { id: bobs.id, name: `Bob ${i}` }, as(BOB));
await Mutation.updateExportBanList(null, { id: kept.id, name: 'Kept again' }, as(ALICE));
failures.set('ExportBanList.save', [new Error('Database unavailable')]);
await assert.rejects(Mutation.updateExportBanList(null, { id: bobs.id, name: 'Bob' }, as(BOB)), {
  message: 'Database unavailable'
});
failures.set('ExportBanList.save', [new Error('Lock wait timeout exceeded')]);
await assert.rejects(
  Mutation.createExportBanList(
    null,
    { name: 'Bob BM', server: 'Server', type: 'battlemetrics' },
    as(BOB)
  ),
  { message: 'Lock wait timeout exceeded' }
);
const bobsBM = nextID - 1;
rows.ExportBanList = rows.ExportBanList.filter((row) => row.id !== bobsBM);
const bobsList = (name) => `Server's List "${name}" (ID: ${bobs.id}, remote)`;
const renamed = (i, level = 1) =>
  `[WebServer][${level}] Steam user ${BOB.id} updated export ban list ${bobsList(`Bob ${i}`)}: name "${i === 0 ? 'Bob' : `Bob ${i - 1}`}" → "Bob ${i}".`;
const bobsUnsaved = `[WebServer][1] Steam user ${BOB.id} created export ban list Server's List "Bob BM" (ID: ${bobsBM}, BattleMetrics): ${DEFAULTS}, no Discord webhook. BattleMetrics ban list ${nextBanList - 1} was made for it, but saving it to the list failed, so nothing records the ban list, which must be removed on BattleMetrics by hand: Error: Lock wait timeout exceeded`;
assert.deepStrictEqual(take(), [
  ...Array.from({ length: LINES_PER_MINUTE }, (_, i) => renamed(i)),
  `[WebServer][1] Steam user ${BOB.id}'s changes have posted ${LINES_PER_MINUTE} lines in the last minute, the most for one user, so their next ones are only in the web server's console until there is room again. Failures are still posted.`,
  `[WebServer][1] ${ALICE_TEXT} updated export ban list Server's List "Kept again" (ID: ${kept.id}, remote): name "Kept" → "Kept again".`,
  `[WebServer][1] Steam user ${BOB.id} could not save export ban list ${bobsList(`Bob ${LINES_PER_MINUTE + 1}`)} (name "Bob ${LINES_PER_MINUTE + 1}" → "Bob"): Error: Database unavailable`,
  bobsUnsaved
]);
assert.deepStrictEqual(important.splice(0), [bobsUnsaved]);
assert.deepStrictEqual(printed, [renamed(LINES_PER_MINUTE, 2), renamed(LINES_PER_MINUTE + 1, 2)]);
now += 60 * 1000;
await Mutation.updateExportBanList(null, { id: bobs.id, name: 'Bob' }, as(BOB));
assert.deepStrictEqual(take(), [
  `[WebServer][1] Steam user ${BOB.id}'s changes have room in the log channel again, after 2 lines of theirs went to the web server's console only.`,
  `[WebServer][1] Steam user ${BOB.id} updated export ban list ${bobsList('Bob')}: name "Bob ${LINES_PER_MINUTE + 1}" → "Bob".`
]);
// The limit leaves room for setting up a list by hand, with a config for each of CBL's ban lists,
// about 20, in a minute.
assert.ok(LINES_PER_MINUTE >= 25);

// Failures take none of a user's room: with a failure among them, a user's LINES_PER_MINUTE
// changes in a minute are all posted.
now += 60 * 1000;
printed.length = 0;
for (let i = 0; i < LINES_PER_MINUTE - 1; i++)
  await Mutation.updateExportBanList(null, { id: kept.id, name: `Kept ${i}` }, as(ALICE));
failures.set('ExportBanList.save', [new Error('Database unavailable')]);
await assert.rejects(Mutation.updateExportBanList(null, { id: kept.id, name: 'Kept' }, as(ALICE)), {
  message: 'Database unavailable'
});
await Mutation.updateExportBanList(null, { id: kept.id, name: 'Kept' }, as(ALICE));
const keptAs = (name) => `Server's List "${name}" (ID: ${kept.id}, remote)`;
assert.deepStrictEqual(take(), [
  ...Array.from(
    { length: LINES_PER_MINUTE - 1 },
    (_, i) =>
      `[WebServer][1] ${ALICE_TEXT} updated export ban list ${keptAs(`Kept ${i}`)}: name "${i === 0 ? 'Kept again' : `Kept ${i - 1}`}" → "Kept ${i}".`
  ),
  `[WebServer][1] ${ALICE_TEXT} could not save export ban list ${keptAs(`Kept ${LINES_PER_MINUTE - 2}`)} (name "Kept ${LINES_PER_MINUTE - 2}" → "Kept"): Error: Database unavailable`,
  `[WebServer][1] ${ALICE_TEXT} updated export ban list ${keptAs('Kept')}: name "Kept ${LINES_PER_MINUTE - 2}" → "Kept".`
]);
assert.deepStrictEqual(printed, []);

// Only the lines that leave something to clean up by hand were posted as important ones.
assert.deepStrictEqual(important, []);

// What the web server printed with console.error never gives the API key either.
assert.ok(consoleErrors.length > 0);
assert.ok(!JSON.stringify(consoleErrors).includes(API_KEY));

console.log(
  'Export ban list audit checks passed: who made each change and what it was, the BattleMetrics side, failures, the limit on lines, and no webhooks, invites or keys.'
);
