import assert from 'assert';
import { readdir, readFile } from 'fs/promises';
import { createRequire } from 'module';
import vm from 'vm';

import * as apolloServer from '@apollo/server';
import * as apolloServerDisabledPlugins from '@apollo/server/plugin/disabled';
import * as graphqlToolsSchema from '@graphql-tools/schema';
import * as graphqlToolsUtils from '@graphql-tools/utils';
import graphql from 'graphql';
import { gql } from 'graphql-tag';
import jwt from 'jsonwebtoken';

import createApiClient from '../../scbl-lib/apis/create-api-client.js';
import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import describeError from '../../scbl-lib/utils/describe-error.js';
import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import logText from '../../scbl-lib/utils/log-text.js';
import Validators from '../../scbl-lib/validators.js';

// Checks for what the GraphQL API tells the client when part of a request fails, through the API
// as the web server builds it, with its real schema and resolvers. Part 1 checks that the errors
// the API gives on purpose reach the client as they are, from each place the resolvers, and the
// scbl-lib code they call, throw them. Part 2 checks that any other error, such as the database's,
// reaches the client only as "Internal server error", and is logged. Part 3 checks the API's
// settings in production, in development and with a NODE_ENV the web server does not expect, and
// Part 4 how the web server decides which mode it runs in.

// The API tells the client that the database cannot be reached with scbl-lib's own check, so the
// checks load the real module. It makes no connection, so its address is never used.
process.env.DATABASE_URI = 'mysql://checks:checks@127.0.0.1:1/checks';
const database = await import('scbl-lib/db/sequelize');

// Sequelize as scbl-lib loads it, for the errors the database gives. Each holds the MySQL driver's
// error, with the SQL that failed.
const Sequelize = createRequire(new URL('../../scbl-lib/db/sequelize.js', import.meta.url))(
  'sequelize'
);
const SQL = 'UPDATE `SteamUsers` SET `lastViewed`=? WHERE `id` = ?';
const mysqlError = (message, code, errno) =>
  Object.assign(new Error(message), { code, errno, sql: SQL });
const lockWait = () =>
  new Sequelize.DatabaseError(
    mysqlError(
      'Lock wait timeout exceeded; try restarting transaction',
      'ER_LOCK_WAIT_TIMEOUT',
      1205
    )
  );
const deadlock = () =>
  new Sequelize.DatabaseError(
    mysqlError(
      'Deadlock found when trying to get lock; try restarting transaction',
      'ER_LOCK_DEADLOCK',
      1213
    )
  );

// Load a module in a context of its own, with these globals. The imports in stubs get those
// exports, and other relative imports load the real files, each once.
async function load(path, stubs, globals) {
  const context = vm.createContext(globals);
  const modules = new Map();
  async function moduleFor(specifier, referencingURL) {
    const exports = stubs[specifier];
    assert.ok(exports || specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    const url = exports ? specifier : new URL(specifier, referencingURL).href;
    if (!modules.has(url)) {
      modules.set(
        url,
        exports
          ? new vm.SyntheticModule(
              Object.keys(exports),
              function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
              },
              { context }
            )
          : new vm.SourceTextModule(await readFile(new URL(url), 'utf8'), {
              context,
              identifier: url
            })
      );
    }
    return modules.get(url);
  }
  const module = await moduleFor(path, import.meta.url);
  await module.link((specifier, referencingModule) =>
    moduleFor(specifier, referencingModule.identifier)
  );
  await module.evaluate();
  return module.namespace;
}

// The error the BattleMetrics client gives for a request BattleMetrics answers this way. These
// answers are not tried again, so each request is made once.
function battlemetricsError(method, path, response) {
  const request = createApiClient({
    name: 'BattleMetrics',
    limiter: { schedule: (options, job) => job() },
    jobPrefix: 'BM',
    timeout: 1000,
    async send() {
      throw Object.assign(new Error(`Request failed with status code ${response.status}`), {
        response
      });
    }
  });
  return request(method, path).then(
    () => assert.fail(`${method} ${path} worked`),
    (error) => error
  );
}

// scbl-lib's test of a Discord webhook, with a stand-in for posting its message, which fails with
// the error Discord's answer gives, or posts the message when there is none.
let discordAnswer = null;
const { default: testDiscordWebhook } = await load(
  '../../scbl-lib/utils/test-discord-webhook.js',
  {
    './discord-webhook.js': {
      default: async () => {
        if (discordAnswer) throw discordAnswer;
      }
    }
  },
  { Error, URL }
);

// Stand-ins for the database's models, with the rows each check gives them.
const lists = new Map();
const banLists = new Map();
const configs = new Map();
// How many export ban lists each user has, for the limit of 4.
const listCounts = new Map();
// The ban lists the API lists.
let banListRows;
// What looking up organisations or a player throws, for the errors any request can meet, or a
// function that gives it for an organisation's ID.
let failure = null;
function fail(id) {
  const error = typeof failure === 'function' ? failure(id) : failure;
  if (error) throw error;
}
// What creating a list or a config does with its values, and how many players a list would hold,
// for the limits on players (mutation/check-size.js).
let createList;
let createConfig;
let countMembers;

// A user's export ban list, with the methods the resolvers call, which a check can replace.
function storedList(owner, values = {}) {
  const list = {
    id: lists.size + 1,
    name: 'List',
    server: 'Server',
    type: 'remote',
    owner,
    ...exportListLimits.DEFAULT_SETTINGS,
    discordWebhook: null,
    battlemetricsID: null,
    battlemetricsInvite: null,
    async save() {},
    async destroy() {},
    async createBattlemetricsBanList() {},
    async createBattlemetricsInvite() {},
    async deleteExportBanList() {
      return 'none';
    },
    battlemetricsBanListName() {
      return `Community Ban List - ${this.name} (ID: ${this.id})`;
    },
    ...values
  };
  lists.set(list.id, list);
  return list;
}

function resetModels() {
  failure = null;
  banListRows = [{ id: 1, name: 'Bans', organisation: 1 }];
  createList = (values) => storedList(values.owner, values);
  createConfig = (values) => ({ id: configs.size + 1, ...values });
  countMembers = async () => 0;
}
resetModels();

const models = {
  Organisation: {
    async findAll() {
      fail();
      return [];
    },
    async findByPk(id) {
      fail(id);
      return null;
    }
  },
  BanList: {
    findAll: async () => banListRows,
    findOne: async ({ where }) => banLists.get(where.id) ?? null,
    findByPk: async (id) => banLists.get(id) ?? null
  },
  Ban: { paginate: async () => ({ edges: [], pageInfo: {} }) },
  SteamUser: {
    paginate: async () => ({ edges: [], pageInfo: {} }),
    async findByPk() {
      fail();
      return null;
    }
  },
  ExportBanList: {
    count: async ({ where }) => listCounts.get(where.owner) ?? 0,
    findOne: async ({ where }) => {
      const list = lists.get(where.id);
      return list?.owner === where.owner ? list : null;
    },
    create: async (values) => createList(values)
  },
  ExportBanListConfig: {
    findAll: async () => [],
    // A config is looked up by its ID and its list's owner to delete it, and by its list and ban
    // list to check it is not there yet.
    findOne: async ({ where }) =>
      [...configs.values()].find((config) =>
        'id' in where
          ? config.id === where.id && config.ExportBanList.owner === where['$ExportBanList.owner$']
          : config.exportBanList === where.exportBanList && config.banList === where.banList
      ) ?? null,
    create: async (values) => createConfig(values)
  }
};

// The limits on export ban lists: the defaults, but with no points rules for remote lists, so the
// players a change to one could put on it are always counted (mutation/check-size.js).
const { limits } = exportListLimits.readLimits({ EXPORT_REMOTE_NEVER_ENOUGH: 'none' });

// The servers the API builds, which index.js passes to the Koa integration.
const built = [];
const packages = {
  '@apollo/server': apolloServer,
  '@apollo/server/plugin/disabled': apolloServerDisabledPlugins,
  '@as-integrations/koa': {
    koaMiddleware: (server) => {
      built.push(server);
      return async () => {};
    }
  },
  '@graphql-tools/schema': graphqlToolsSchema,
  '@graphql-tools/utils': graphqlToolsUtils,
  graphql: { default: graphql },
  'graphql-tag': { gql },
  jsonwebtoken: { default: jwt },
  // The sign-in settings are only read when signing a request in, which these checks do not do.
  'scbl-lib/config': {
    JWT_AUTH: { ALGORITHM: 'HS256', SECRET: 'a-secret-only-these-checks-use' },
    SIGN_IN_TOKEN_LIFETIME: 30 * 24 * 60 * 60,
    EXPORT_LIST_LIMITS: limits
  },
  'scbl-lib/db/export-membership': {
    countMembers: (...args) => countMembers(...args),
    // Few players have two or more bans, so a BattleMetrics list within the points rules is never
    // counted.
    countPlayersWithBans: async () => 0
  },
  // No ban list is paused.
  'scbl-lib/db/ban-list-suspensions': {
    readPausedBanLists: async () => [],
    pausedSets: () => ({ suspended: [], excluded: [] })
  },
  'scbl-lib/db/models': models,
  'scbl-lib/db/sequelize': database,
  'scbl-lib/export-list-limits': exportListLimits,
  'scbl-lib/utils': {
    // Changes are posted to the log channel, which these checks do not look at.
    Logger: { verbose() {}, important() {} },
    describeError,
    logText,
    calculateRiskRating: () => 0,
    isDiscordWebhookUrl,
    testDiscordWebhook
  },
  'scbl-lib/validators': { default: Validators }
};

// The lines the API logs.
const logged = [];
const record = (...args) => logged.push(args.map(String).join(' '));
// Those formatError logs for errors the client is not shown.
const hiddenLines = () => logged.filter((line) => line.startsWith('Internal server error in '));

// The API as the web server builds it with NODE_ENV set to this. Apollo Server reads NODE_ENV
// itself when it is built, so it is set for that too. The modules make their errors with this
// realm's Error, as in the web server, where all of its code shares one, so GraphQL takes them for
// errors.
async function loadApi(NODE_ENV) {
  const { NODE_ENV: before } = process.env;
  process.env.NODE_ENV = NODE_ENV;
  try {
    await load('../src/graphql-api/index.js', packages, {
      process: { env: { NODE_ENV } },
      console: { log: record, info: record, warn: record, error: record },
      Buffer,
      Error,
      setTimeout,
      clearTimeout
    });
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
  assert.strictEqual(built.length, 1);
  return built.pop();
}

// Let the requests in progress run until each waits for something the checks control.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Run an operation on an API as a user, or signed out, and give its result as the client gets it,
// in JSON, once the errors it hid from the client have been logged.
async function run(server, query, { user, variables } = {}) {
  const contextValue = user ? { user: { id: user } } : {};
  const response = await server.executeOperation({ query, variables }, { contextValue });
  assert.strictEqual(response.body.kind, 'single');
  await settle();
  return JSON.parse(JSON.stringify(response.body.singleResult));
}

// A mutation with these arguments, asking only for the ID of what it gives.
const mutation = (name, args) => {
  const given = Object.entries(args).map(([arg, value]) => `${arg}: ${JSON.stringify(value)}`);
  return `mutation { ${name}(${given.join(', ')}) { id } }`;
};
const LIST = { name: 'List', server: 'Server', type: 'remote' };

const api = await loadApi('production');

// Check that a request fails with an error the API gives on purpose, which reaches the client as
// it is, with this message, or one that matches it, and this code. It is not logged as an error
// the client was not shown.
async function checkShown(query, message, { code = 'INTERNAL_SERVER_ERROR', ...options } = {}) {
  logged.length = 0;
  const { errors } = await run(api, query, options);
  assert.strictEqual(errors?.length, 1, `${query}: ${JSON.stringify(errors)}`);
  const [error] = errors;
  if (message instanceof RegExp) assert.match(error.message, message, query);
  else assert.strictEqual(error.message, message, query);
  assert.strictEqual(error.extensions.code, code, query);
  assert.strictEqual(error.extensions.stacktrace, undefined, query);
  assert.deepStrictEqual(hiddenLines(), [], query);
}

// Check that a request that fails with this error, which the client did not cause, reaches the
// client only as "Internal server error" for the field at this path, with nothing else of the
// error, and that the error is logged once, in one line: its name and message, and never its SQL.
async function checkHidden(query, error, path, options) {
  logged.length = 0;
  const { errors } = await run(api, query, options);
  assert.strictEqual(errors?.length, 1, `${query}: ${JSON.stringify(errors)}`);
  const { locations, ...answer } = errors[0];
  assert.deepStrictEqual(
    answer,
    { message: 'Internal server error', path, extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    query
  );
  assert.strictEqual(locations.length, 1);
  const described =
    error instanceof Error ? `${error.name}: ${error.message}` : 'a thrown [object Object]';
  assert.deepStrictEqual(
    hiddenLines(),
    [`Internal server error in ${path.join('.')}, not shown to the client: ${described}`],
    query
  );
  assert.ok(!logged.some((line) => line.includes(SQL)), `${query}: the SQL is not logged`);
}

// Part 1: the errors the API gives on purpose reach the client as they are.

// GraphQL's own errors, for a request it cannot read, check or run, and the API's refusal of one
// that asks for far too much.
await checkShown('{ bans(', 'Syntax Error: Expected Name, found <EOF>.', {
  code: 'GRAPHQL_PARSE_FAILED'
});
await checkShown(
  'query ($first: Int) { bans(first: $first) { edges { node { id } } } }',
  'Variable "$first" got invalid value "many"; Int cannot represent non-integer value: "many"',
  { code: 'BAD_USER_INPUT', variables: { first: 'many' } }
);
await checkShown(
  `{ ${Array.from({ length: 11 }, (_, i) => `f${i}: banLists { id }`).join(' ')} }`,
  'The operation asks for 11 fields at its top level, and one request can ask for at most 10. Split it into several requests.',
  { code: 'GRAPHQL_VALIDATION_FAILED' }
);

// A list asked for in an order, or from a cursor, it cannot give (core/list-order.js).
for (const [query, message] of [
  ['{ bans(orderBy: "reason") { edges { node { id } } } }', 'orderBy must be one of: created.'],
  [
    '{ steamUsers(first: 5, last: 5, before: "x") { edges { node { id } } } }',
    'Use first and after, or last and before, but not both.'
  ],
  ['{ steamUsers(last: 5) { edges { node { id } } } }', 'Use last with a before cursor.'],
  ['{ bans(after: "not a cursor") { edges { node { id } } } }', 'Invalid page cursor.']
])
  await checkShown(query, message, { code: 'BAD_USER_INPUT' });

// A change by a user who is signed out, which the guard on changes refuses before any of the
// resolvers' own checks (mutation/guard-changes.js).
await checkShown(
  mutation('deleteExportBanList', { id: 1 }),
  'Please sign in again to change your export ban lists.'
);

// A new list the resolver refuses: past the limit of 4 lists, of no type it knows, or with a
// value the forms' rules or the bounds on its settings refuse (mutation/resolver.js, refusal.js).
listCounts.set('full', 4);
await checkShown(mutation('createExportBanList', LIST), 'You are limited to 4 export ban lists.', {
  user: 'full'
});
await checkShown(
  mutation('createExportBanList', { ...LIST, type: 'steam' }),
  'Invalid export ban list type.',
  { user: 'unknown-type' }
);
await checkShown(
  mutation('createExportBanList', { ...LIST, name: 'x'.repeat(41) }),
  'A name between 1 and 40 characters long is required.',
  { user: 'long-name' }
);
await checkShown(
  mutation('createExportBanList', { ...LIST, discordWebhook: 'https://example.com/webhook' }),
  'Invalid Discord Webhook',
  { user: 'not-a-webhook' }
);
await checkShown(
  mutation('createExportBanList', { ...LIST, threshold: 0 }),
  'The threshold must be a whole number from 1 to 1,000.',
  { user: 'threshold-zero' }
);
// The points rules (scbl-lib/export-list-limits.js), which the limits keep for BattleMetrics lists.
await checkShown(
  mutation('createExportBanList', { ...LIST, type: 'battlemetrics', threshold: 4 }),
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.',
  { user: 'low-threshold' }
);

// A change that could put too many players on a list, or whose players cannot be counted now
// (mutation/check-size.js). Each user can start 3 counts in 30 seconds.
countMembers = async () => {
  throw new Sequelize.DatabaseError(
    mysqlError(
      'Query execution was interrupted, maximum statement execution time exceeded',
      'ER_QUERY_TIMEOUT',
      3024
    )
  );
};
await checkShown(
  mutation('createExportBanList', LIST),
  'We could not work out how many players this change would put on your export ban list. Please try again shortly.',
  { user: 'count-fails' }
);
countMembers = async () => 50000;
for (let count = 0; count < 3; count++)
  await checkShown(
    mutation('createExportBanList', LIST),
    'These settings would put 50,000 players on your export ban list. A remote export ban list can have at most 40,000. Raise the threshold, lower the points or set a max ban age.',
    { user: 'counted' }
  );
await checkShown(
  mutation('createExportBanList', LIST),
  /^Saving this change needs a count of the players it would list, and each user can run 3 counts every 30 seconds\. Please try again in \d+ seconds?\.$/,
  { user: 'counted' }
);
// Counts run one at a time. While one runs and 5 wait, a change that needs another is refused.
let finishCount;
countMembers = () => {
  countMembers = async () => 0;
  return new Promise((resolve) => (finishCount = resolve));
};
const queued = Array.from({ length: 6 }, (_, user) =>
  run(api, mutation('createExportBanList', LIST), { user: `queued-${user}` })
);
await settle();
await checkShown(
  mutation('createExportBanList', LIST),
  'Too many export ban list changes are being checked right now. Please try again in a minute.',
  { user: 'one-too-many' }
);
finishCount(0);
for (const { errors } of await Promise.all(queued)) assert.strictEqual(errors, undefined);

// A Discord webhook whose test message cannot be posted, a second webhook tested in one request,
// and a user who has tested as many as they may for now (mutation/test-webhook.js, and scbl-lib's
// test of a webhook).
discordAnswer = new Error('Discord answered HTTP 404: Unknown Webhook (code 10015)');
await checkShown(
  mutation('createExportBanList', {
    ...LIST,
    discordWebhook: 'https://discord.com/api/webhooks/1/deleted'
  }),
  'We could not post a test message to your Discord webhook. Discord answered HTTP 404: Unknown Webhook (code 10015).',
  { user: 'deleted-webhook' }
);
discordAnswer = null;
const [first, second] = [storedList('two-webhooks'), storedList('two-webhooks')];
await checkShown(
  `mutation {
    first: updateExportBanList(id: ${first.id}, discordWebhook: "https://discord.com/api/webhooks/1/a") { id }
    second: updateExportBanList(id: ${second.id}, discordWebhook: "https://discord.com/api/webhooks/2/b") { id }
  }`,
  'Only one Discord webhook can be tested per request. Please save one export ban list at a time.',
  { user: 'two-webhooks' }
);
const tested = storedList('tester');
const testWebhook = (number) =>
  mutation('updateExportBanList', {
    id: tested.id,
    discordWebhook: `https://discord.com/api/webhooks/${number}/token`
  });
for (let number = 1; number <= 5; number++)
  assert.strictEqual((await run(api, testWebhook(number), { user: 'tester' })).errors, undefined);
await checkShown(
  testWebhook(6),
  /^Discord webhooks can only be tested 5 times a minute\. Please try again in (1 minute|\d+ seconds)\.$/,
  { user: 'tester' }
);

// A user who has created and deleted as many lists as they may for now (mutation/guard-changes.js).
const deleted = storedList('deleter');
for (let count = 0; count < 3; count++)
  assert.strictEqual(
    (await run(api, mutation('deleteExportBanList', { id: deleted.id }), { user: 'deleter' }))
      .errors,
    undefined
  );
await checkShown(
  mutation('deleteExportBanList', { id: deleted.id }),
  /^Export ban lists can only be created or deleted 3 times a minute\. Please try again in (1 minute|\d+ seconds)\.$/,
  { user: 'deleter' }
);

// A list or a config that does not exist, or is not the user's, a config's ban list that does not
// exist, a second config for the same ban list, and points out of bounds (mutation/resolver.js).
const owned = storedList('owner');
banLists.set(1, { id: 1, name: 'Bans', Organisation: { name: 'Organisation' } });
banLists.set(2, { id: 2, name: 'Other bans' });
configs.set(1, { id: 1, exportBanList: owned.id, banList: 1, activePoints: 3, expiredPoints: 1 });
const config = (values) =>
  mutation('createExportBanListConfig', { activePoints: 1, expiredPoints: 1, ...values });
for (const [query, message] of [
  [
    mutation('updateExportBanList', { id: 404, name: 'Renamed' }),
    'Export ban list does not exist!'
  ],
  [mutation('deleteExportBanList', { id: 404 }), 'Export ban list does not exist!'],
  [config({ exportBanList: 404, banList: 1 }), 'Export ban list does not exist!'],
  [
    mutation('updateExportBanList', { id: deleted.id, name: 'Not mine' }),
    'Export ban list does not exist!'
  ],
  [config({ exportBanList: owned.id, banList: 404 }), 'Ban list does not exist!'],
  [
    config({ exportBanList: owned.id, banList: 1 }),
    'Export ban list config already exists for this ban list.'
  ],
  [
    config({ exportBanList: owned.id, banList: 2, activePoints: 101 }),
    'Points must be whole numbers from 0 to 100.'
  ],
  [mutation('deleteExportBanListConfig', { id: 404 }), 'Export ban list config does not exist!']
])
  await checkShown(query, message, { user: 'owner' });

// A new BattleMetrics list whose BattleMetrics ban list could not be made, as ExportBanList's
// creation of it fails: the list is deleted, or its owner is asked to delete it when it cannot be,
// and when the ban list was made but its invite was not, the owner is shown what BattleMetrics
// answered (scbl-lib/apis/create-api-client.js).
const banListRefused = await battlemetricsError('post', 'ban-lists', {
  status: 422,
  data: { errors: [{ title: 'Invalid name' }] }
});
const createBattlemetricsList = (values) => (listValues) =>
  storedList(listValues.owner, { ...listValues, ...values });
createList = createBattlemetricsList({
  async createBattlemetricsBanList() {
    throw Object.assign(banListRefused, { stage: 'battlemetrics' });
  }
});
await checkShown(
  mutation('createExportBanList', { ...LIST, type: 'battlemetrics' }),
  'BattleMetrics could not create a ban list for your export ban list, so it was not created. Please try again later.',
  { user: 'not-made' }
);
createList = createBattlemetricsList({
  async createBattlemetricsBanList() {
    throw Object.assign(banListRefused, { stage: 'battlemetrics' });
  },
  async destroy() {
    throw deadlock();
  }
});
await checkShown(
  mutation('createExportBanList', { ...LIST, type: 'battlemetrics' }),
  'BattleMetrics could not create a ban list for your export ban list. Please delete it and try again later.',
  { user: 'not-made-or-deleted' }
);
const inviteFailed = await battlemetricsError('post', 'ban-lists/123/relationships/invites', {
  status: 500
});
createList = createBattlemetricsList({
  async createBattlemetricsBanList() {
    this.battlemetricsID = '123';
    throw Object.assign(inviteFailed, { stage: 'invite' });
  }
});
await checkShown(
  mutation('createExportBanList', { ...LIST, type: 'battlemetrics' }),
  'BattleMetrics POST ban-lists/123/relationships/invites failed: HTTP 500, so it may have been carried out',
  { user: 'no-invite' }
);
resetModels();

// A list whose BattleMetrics ban list could not be deleted, with the errors scbl-lib's deletion
// gives, which are shown to the list's owner: those its own checks give, as BattleMetrics says
// another organisation owns the ban list, or gives an answer that does not say who owns it, and one
// the BattleMetrics client gives, as BattleMetrics refuses to list the ban list's invites.
const listingRefused = await battlemetricsError('get', 'ban-lists/7/relationships/invites', {
  status: 403,
  data: { errors: [{ title: 'Forbidden', detail: 'You may not manage this ban list.' }] }
});
assert.strictEqual(listingRefused.name, 'ApiError');
let ownershipAnswer = { data: { data: { relationships: { owner: { data: { id: '200' } } } } } };
const deletion = await load(
  '../../scbl-lib/apis/delete-battlemetrics-ban-list.js',
  {
    './battlemetrics.js': { default: async () => ownershipAnswer },
    './read-battlemetrics-pages.js': {
      default: async () => {
        throw listingRefused;
      }
    },
    '../config.js': { BATTLEMETRICS_ORGANIZATION: '100' }
  },
  { Error }
);
const notOwned = await deletion.checkOwnership('7').then(assert.fail, (error) => error);
assert.match(notOwned.message, /^BattleMetrics deletion failed while checking ownership: /);
ownershipAnswer = { data: {} };
const unreadable = await deletion.checkOwnership('7').then(assert.fail, (error) => error);
assert.strictEqual(
  unreadable.message,
  'BattleMetrics deletion failed while checking ownership: Invalid BattleMetrics ownership response. The local list was retained; any invites or subscriptions already removed remain removed.'
);
const notListed = await deletion.removeInvitesAndSubscribers('7').then(assert.fail, (e) => e);
assert.match(notListed.message, /^BattleMetrics deletion failed while listing invites: /);
for (const error of [notOwned, unreadable, notListed]) {
  const list = storedList('battlemetrics-owner', {
    type: 'battlemetrics',
    battlemetricsID: '7',
    async deleteExportBanList() {
      throw Object.assign(error, { stage: 'battlemetrics' });
    }
  });
  await checkShown(mutation('deleteExportBanList', { id: list.id }), error.message, {
    user: 'battlemetrics-owner'
  });
}

// Part 2: any other error reaches the client only as "Internal server error", and is logged.

// A player's profile, whose lookup the database stops.
failure = new Sequelize.DatabaseError(
  mysqlError('Query execution was interrupted', 'ER_QUERY_INTERRUPTED', 1317)
);
await checkHidden('{ steamUser(id: "76561198000000001") { id } }', failure, ['steamUser']);
resetModels();

// Changes the database refuses, as they are saved, after the API's own checks have passed.
const foreignKey = new Sequelize.ForeignKeyConstraintError({
  parent: mysqlError(
    'Cannot add or update a child row: a foreign key constraint fails (`cbl`.`ExportBanLists`, CONSTRAINT `ExportBanLists_ibfk_1` FOREIGN KEY (`owner`) REFERENCES `SteamUsers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE)',
    'ER_NO_REFERENCED_ROW_2',
    1452
  )
});
createList = () => {
  throw foreignKey;
};
await checkHidden(mutation('createExportBanList', LIST), foreignKey, ['createExportBanList'], {
  user: 'no-player-row'
});
resetModels();
const notNull = new Sequelize.ValidationError(
  'notNull Violation: ExportBanList.name cannot be null'
);
const unsaved = storedList('saver', {
  async save() {
    throw notNull;
  }
});
await checkHidden(
  mutation('updateExportBanList', { id: unsaved.id, name: 'Renamed' }),
  notNull,
  ['updateExportBanList'],
  { user: 'saver' }
);
const configLocked = deadlock();
createConfig = () => {
  throw configLocked;
};
await checkHidden(
  config({ exportBanList: owned.id, banList: 2 }),
  configLocked,
  ['createExportBanListConfig'],
  { user: 'owner' }
);
resetModels();
const undeletableConfig = deadlock();
configs.set(2, {
  id: 2,
  exportBanList: owned.id,
  banList: 2,
  activePoints: 1,
  expiredPoints: 1,
  ExportBanList: owned,
  async destroy() {
    throw undeletableConfig;
  }
});
await checkHidden(
  mutation('deleteExportBanListConfig', { id: 2 }),
  undeletableConfig,
  ['deleteExportBanListConfig'],
  { user: 'owner' }
);
const undeletableList = deadlock();
const kept = storedList('database-deleter', {
  async deleteExportBanList() {
    throw Object.assign(undeletableList, { stage: 'database deletion' });
  }
});
await checkHidden(
  mutation('deleteExportBanList', { id: kept.id }),
  undeletableList,
  ['deleteExportBanList'],
  { user: 'database-deleter' }
);
// A new BattleMetrics list whose BattleMetrics ban list was made but could not be saved with it.
const unrecorded = lockWait();
createList = createBattlemetricsList({
  async createBattlemetricsBanList() {
    this.battlemetricsID = '124';
    throw Object.assign(unrecorded, { stage: 'saving' });
  }
});
await checkHidden(
  mutation('createExportBanList', { ...LIST, type: 'battlemetrics' }),
  unrecorded,
  ['createExportBanList'],
  { user: 'unrecorded' }
);
resetModels();

// Errors from the database, from bugs and from the packages the API uses, any of which any request
// can meet, here as the organisations are looked up, or a ban list's organisation.
const syntaxError = (() => {
  try {
    JSON.parse('{');
  } catch (error) {
    return error;
  }
})();
for (const error of [
  new Sequelize.DatabaseError(
    mysqlError(
      "Unknown column 'Organisation.nosuchcolumn' in 'order clause'",
      'ER_BAD_FIELD_ERROR',
      1054
    )
  ),
  new Sequelize.UniqueConstraintError({
    parent: mysqlError("Duplicate entry '7' for key 'PRIMARY'", 'ER_DUP_ENTRY', 1062)
  }),
  new TypeError("Cannot read properties of undefined (reading 'id')"),
  new ReferenceError('organisation is not defined'),
  new RangeError('Invalid time value'),
  syntaxError,
  new AggregateError([new Error('A lookup failed.')], 'Several lookups failed.'),
  // Node's error for a connection that could not be made, which is a plain Error with an errno.
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:443'), {
    errno: -111,
    code: 'ECONNREFUSED',
    syscall: 'connect'
  }),
  // Plain Errors with a code but no errno: Node's for a stream that closed too early, and the MySQL
  // driver's for a connection that took too long, which gives its errno under another name.
  Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
  Object.assign(new Error('connect ETIMEDOUT'), {
    errorno: 'ETIMEDOUT',
    code: 'ETIMEDOUT',
    syscall: 'connect',
    fatal: true
  }),
  // A package's error of its own.
  Object.assign(new Error('Request failed with status code 500'), { name: 'AxiosError' }),
  // A value that is not an error.
  { sql: SQL }
]) {
  failure = error;
  await checkHidden('{ organisations { id } }', error, ['organisations']);
}
failure = new TypeError("Cannot read properties of null (reading 'name')");
await checkHidden('{ banLists { id organisation { id } } }', failure, [
  'banLists',
  0,
  'organisation'
]);

// An error that fails every item of a list, as the database's can, is logged in one line for the
// response, which says how many other fields it failed, and each other error in another. Every
// item is still only told that the server had an error.
banListRows = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1,
  name: `Bans ${index + 1}`,
  organisation: (index % 2) + 1
}));
const timedOut = new Sequelize.DatabaseError(
  mysqlError(
    'Query execution was interrupted, maximum statement execution time exceeded',
    'ER_QUERY_TIMEOUT',
    3024
  )
);
const missing = new TypeError("Cannot read properties of null (reading 'name')");
failure = (organisation) => (organisation === 1 ? timedOut : missing);
logged.length = 0;
const { errors: itemErrors } = await run(api, '{ banLists { id organisation { id } } }');
assert.deepStrictEqual(
  itemErrors.map(({ locations, ...answer }) => answer),
  banListRows.map((_, index) => ({
    message: 'Internal server error',
    path: ['banLists', index, 'organisation'],
    extensions: { code: 'INTERNAL_SERVER_ERROR' }
  }))
);
assert.deepStrictEqual(hiddenLines(), [
  `Internal server error in banLists.0.organisation and 24 other fields, not shown to the client: ${timedOut.name}: ${timedOut.message}`,
  `Internal server error in banLists.1.organisation and 24 other fields, not shown to the client: ${missing.name}: ${missing.message}`
]);
assert.ok(!logged.some((line) => line.includes(SQL)), 'the SQL is not logged');
resetModels();

// While the database cannot be reached, the client is told so, without the database's own error,
// which names its address.
for (const error of [
  new Sequelize.ConnectionRefusedError(
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.3:3306'), { code: 'ECONNREFUSED' })
  ),
  new Sequelize.DatabaseError(
    Object.assign(new Error('Connection lost: The server closed the connection.'), {
      code: 'PROTOCOL_CONNECTION_LOST'
    })
  )
]) {
  failure = error;
  await checkShown('{ organisations { id } }', database.DATABASE_UNAVAILABLE_MESSAGE);
}
resetModels();

// An error while a request's context is made, before any of it runs, is hidden the same way.
const contextFailed = lockWait();
logged.length = 0;
const contextResponse = await api.executeHTTPGraphQLRequest({
  httpGraphQLRequest: {
    method: 'POST',
    headers: new apolloServer.HeaderMap([['content-type', 'application/json']]),
    search: '',
    body: { query: '{ organisations { id } }' }
  },
  context: async () => {
    throw contextFailed;
  }
});
await settle();
assert.strictEqual(contextResponse.status, 500);
assert.deepStrictEqual(JSON.parse(contextResponse.body.string), {
  errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]
});
assert.deepStrictEqual(hiddenLines(), [
  `Internal server error in a request, not shown to the client: ${contextFailed.name}: ${contextFailed.message}`
]);

// Part 3: the API's settings. In production it keeps its schema to itself: it answers no
// introspection queries, its errors suggest nothing for a field, an argument or an enum value that
// does not exist, and a browser that opens it gets no Apollo Sandbox page, only the refusal of a
// request with no query.
const INTROSPECTION = '{ __schema { queryType { name } } }';
const MISSPELT_FIELD = '{ banLst { id } }';
// An enum value that does not exist, given in a variable, which GraphQL checks as the request runs
// rather than with the request's other checks.
const MISSPELT_VALUE =
  'query ($direction: OrderDirection) { bans(orderDirection: $direction) { edges { node { id } } } }';
const MISSPELT_VALUE_VARIABLES = { variables: { direction: 'ASCC' } };
const UNKNOWN_VALUE =
  'Variable "$direction" got invalid value "ASCC"; Value "ASCC" does not exist in "OrderDirection" enum.';
async function checkSchemaHidden(server, where) {
  assert.strictEqual(
    (await run(server, INTROSPECTION)).errors?.[0]?.extensions.validationErrorCode,
    'INTROSPECTION_DISABLED',
    where
  );
  for (const [query, message, code, options] of [
    [MISSPELT_FIELD, 'Cannot query field "banLst" on type "Query".', 'GRAPHQL_VALIDATION_FAILED'],
    [
      '{ bans(frist: 5) { edges { node { id } } } }',
      'Unknown argument "frist" on field "Query.bans".',
      'GRAPHQL_VALIDATION_FAILED'
    ],
    [MISSPELT_VALUE, UNKNOWN_VALUE, 'BAD_USER_INPUT', MISSPELT_VALUE_VARIABLES]
  ]) {
    const { errors } = await run(server, query, options);
    assert.deepStrictEqual(
      errors?.map((error) => ({ message: error.message, code: error.extensions.code })),
      [{ message, code }],
      `${where}: ${query}`
    );
  }
  assert.deepStrictEqual(await openInBrowser(server), { status: 400, page: false }, where);
}
await checkSchemaHidden(api, 'In production');

// GET /graphql as a browser opens it, with its status and whether it gets a page.
async function openInBrowser(server) {
  const response = await server.executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: 'GET',
      headers: new apolloServer.HeaderMap([['accept', 'text/html']]),
      search: '',
      body: undefined
    },
    context: async () => ({})
  });
  const page = response.headers.get('content-type')?.startsWith('text/html') ?? false;
  return { status: response.status ?? 200, page };
}

// In development, it answers introspection queries, as Apollo Sandbox's are, suggests names for
// ones that do not exist, and gives a browser Sandbox's page. In development too, the client is
// only told an error it did not cause happened, and no error says where in the code it came from:
// only the log does.
const developmentApi = await loadApi('development');
assert.strictEqual(
  (await run(developmentApi, INTROSPECTION)).data?.__schema.queryType.name,
  'Query'
);
assert.strictEqual(
  (await run(developmentApi, MISSPELT_FIELD)).errors[0].message,
  'Cannot query field "banLst" on type "Query". Did you mean "banLists" or "bans"?'
);
assert.strictEqual(
  (await run(developmentApi, MISSPELT_VALUE, MISSPELT_VALUE_VARIABLES)).errors[0].message,
  `${UNKNOWN_VALUE} Did you mean the enum value "ASC"?`
);
failure = new TypeError("Cannot read properties of undefined (reading 'id')");
logged.length = 0;
for (const [query, message] of [
  ['{ organisations { id } }', 'Internal server error'],
  ['{ bans(orderBy: "reason") { edges { node { id } } } }', 'orderBy must be one of: created.'],
  [MISSPELT_FIELD, /^Cannot query field "banLst" on type "Query"\./],
  ['{ bans(', /^Syntax Error: /]
]) {
  const { errors } = await run(developmentApi, query);
  assert.strictEqual(errors?.length, 1, query);
  if (message instanceof RegExp) assert.match(errors[0].message, message, query);
  else assert.strictEqual(errors[0].message, message, query);
  assert.strictEqual(errors[0].extensions.stacktrace, undefined, query);
}
assert.deepStrictEqual(hiddenLines(), [
  `Internal server error in organisations, not shown to the client: ${failure.name}: ${failure.message}\n${failure.stack.split('\n').slice(1).join('\n')}`
]);
resetModels();
assert.deepStrictEqual(await openInBrowser(developmentApi), { status: 200, page: true });

// With a NODE_ENV the web server does not expect, such as prod, it does not serve the site's pages
// (Part 4), and the API keeps its schema to itself, as in production.
const unexpectedApi = await loadApi('prod');
await checkSchemaHidden(unexpectedApi, 'With NODE_ENV prod');

await api.stop();
await developmentApi.stop();
await unexpectedApi.stop();

// Part 4: the web server runs in production mode only when NODE_ENV is exactly production, and for
// development only when it is development or test, or is not set. It warns when it starts with any
// other value, with which it is in neither mode. Only production.js reads NODE_ENV, so the site, its
// API and signing in never disagree about it.
async function productionWith(NODE_ENV) {
  return load('../src/production.js', {}, { process: { env: { NODE_ENV } } });
}
for (const [NODE_ENV, inProduction, inDevelopment] of [
  ['production', true, false],
  [undefined, false, true],
  ['development', false, true],
  ['test', false, true]
])
  assert.deepStrictEqual(
    { ...(await productionWith(NODE_ENV)) },
    { inProduction, inDevelopment, nodeEnvProblem: null }
  );
for (const NODE_ENV of ['prod', 'Production', 'production ', '"production"', ''])
  assert.deepStrictEqual(
    { ...(await productionWith(NODE_ENV)) },
    {
      inProduction: false,
      inDevelopment: false,
      nodeEnvProblem: `NODE_ENV is ${JSON.stringify(NODE_ENV)}, not production, development or test, so the web server does not serve the site's pages. Set NODE_ENV to production for the live site.`
    }
  );

const webServer = new URL('../', import.meta.url);
const sources = ['index.js', 'healthcheck.js'];
for (const file of await readdir(new URL('src/', webServer), { recursive: true }))
  if (file.endsWith('.js')) sources.push(`src/${file}`);
const readers = [];
for (const file of sources)
  if ((await readFile(new URL(file, webServer), 'utf8')).includes('process.env.NODE_ENV'))
    readers.push(file);
assert.deepStrictEqual(readers, ['src/production.js']);

console.log(
  "GraphQL error checks passed: the API's own errors shown as they are, others hidden and logged, and its production and development settings."
);
