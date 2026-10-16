import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { ApolloServer } from '@apollo/server';
import { makeExecutableSchema } from '@graphql-tools/schema';

import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import mutationTypeDefs from '../src/graphql-api/mutation/typedef.js';

// Load a module with its package imports replaced by stand-ins. Relative imports load the real
// files. The modules run in this context, so GraphQL treats the errors they throw as it would in
// the web server.
async function load(path, stubs) {
  const linker = async (specifier, referencingModule) => {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
    }
    const exports = stubs[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    });
  };
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

const webhook = (id) => `https://discord.com/api/webhooks/${id}/token-${id}`;
// A webhook with a mistyped token. Only these fail their test, whatever their ID.
const mistyped = (id) => `https://discord.com/api/webhooks/${id}/mistyped`;

// A stand-in for posting test messages, which records the webhooks it posted to. Mistyped webhooks
// are answered the way Discord answers them.
function discord() {
  const sent = [];
  const utils = {
    isDiscordWebhookUrl,
    async testDiscordWebhook(url) {
      if (!isDiscordWebhookUrl(url)) throw new Error('Invalid Discord Webhook');
      sent.push(url);
      if (url.endsWith('/mistyped'))
        throw new Error(
          'We could not post a test message to your Discord webhook. Discord answered HTTP 401: Invalid Webhook Token (code 50027).'
        );
    }
  };
  return { sent, utils };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const limits = discord();
const limiter = await load('../src/graphql-api/mutation/test-webhook.js', {
  'scbl-lib/utils': limits.utils
});
const { default: testWebhook, WEBHOOK_TESTS_PER_MINUTE, WEBHOOK_TESTS_PER_HOUR } = limiter;
// The checks below work out their times and counts from the limits, so the limits can be tuned
// within these bounds without changing the checks.
assert.ok(WEBHOOK_TESTS_PER_MINUTE >= 2, 'Fixing a mistyped webhook takes a second test.');
assert.ok(
  WEBHOOK_TESTS_PER_HOUR >= WEBHOOK_TESTS_PER_MINUTE + 2 &&
    WEBHOOK_TESTS_PER_HOUR <= 30 * WEBHOOK_TESTS_PER_MINUTE,
  'The checks below need an hourly limit from 2 more than the minute limit up to 30 times it.'
);

// Each call is a new request from the user, made at the given time, testing a webhook no other
// call tests. The times below never go backwards, as on a real clock.
let webhooks = 1000;
const test = (user, now) => testWebhook({ user: { id: user } }, webhook(++webhooks), now);
const start = Date.UTC(2026, 0, 1);

// A request can test one webhook, even when the first test failed.
const request = { user: { id: 'one-request' } };
await testWebhook(request, webhook(1), start);
await assert.rejects(
  testWebhook(request, webhook(2), start),
  /^Error: Only one Discord webhook can be tested per request\. Please save one export ban list at a time\.$/
);
const failedRequest = { user: { id: 'failed-request' } };
await assert.rejects(
  testWebhook(failedRequest, mistyped(3), start),
  /could not post a test message/
);
await assert.rejects(testWebhook(failedRequest, webhook(4), start), /Only one Discord webhook/);
assert.deepStrictEqual(limits.sent, [webhook(1), mistyped(3)]);

// An address that is not a Discord webhook is refused without contacting Discord, so it is not a
// test and the request can still test a webhook.
const mistake = { user: { id: 'mistake' } };
await assert.rejects(testWebhook(mistake, 'https://example.com/hook', start), /Invalid Discord/);
await testWebhook(mistake, webhook(5), start);
assert.strictEqual(limits.sent.length, 3);

// Webhooks are only tested for a signed-in user.
for (const context of [{ user: null }, { user: {} }])
  await assert.rejects(testWebhook(context, webhook(6), start), /Please sign in again/);
assert.strictEqual(limits.sent.length, 3);

// A user can test a few webhooks a minute, failed tests included, and is told when they can test
// another. Other users can still test theirs. The user makes one test, and a second later the
// rest of the minute's.
limits.sent.length = 0;
await test('busy', start);
// Addresses refused before contacting Discord do not use up a test, but failed tests do.
await assert.rejects(
  testWebhook({ user: { id: 'busy' } }, 'not a webhook', start + SECOND),
  /Invalid Discord/
);
await assert.rejects(
  testWebhook({ user: { id: 'busy' } }, mistyped(7), start + SECOND),
  /could not post a test message/
);
for (let i = 2; i < WEBHOOK_TESTS_PER_MINUTE; i++) await test('busy', start + SECOND);
assert.strictEqual(limits.sent.length, WEBHOOK_TESTS_PER_MINUTE);
const minuteLimit = new RegExp(
  `^Error: Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_MINUTE} times a minute\\. Please try again in 50 seconds\\.$`
);
await assert.rejects(test('busy', start + 10 * SECOND), minuteLimit);
await assert.rejects(test('busy', start + 10 * SECOND), minuteLimit);
await test('someone-else', start + 10 * SECOND);
assert.strictEqual(limits.sent.length, WEBHOOK_TESTS_PER_MINUTE + 1);
// Refused tests do not count, so trying again when told works. The tests from a second after the
// first are still under a minute old, so the next test waits for them.
await assert.rejects(test('busy', start + MINUTE - 1), /a minute\. Please try again in 1 second\./);
await test('busy', start + MINUTE);
await assert.rejects(test('busy', start + MINUTE + 1), /a minute\. Please try again in 1 second\./);
await test('busy', start + MINUTE + SECOND);

// Make so many tests for a user from the given time, as fast as the minute limit allows: a
// minute's worth at once, and the same again each minute after.
async function useUp(user, from, count) {
  for (let i = 0; i < count; i++)
    await test(user, from + Math.floor(i / WEBHOOK_TESTS_PER_MINUTE) * MINUTE);
}

// A user who keeps within the minute limit still reaches the hourly one, which says how many
// minutes are left.
const hourly = start + HOUR;
await useUp('hourly', hourly, WEBHOOK_TESTS_PER_HOUR);
const hourLimit = new RegExp(
  `^Error: Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_HOUR} times an hour\\. Please try again in 30 minutes\\.$`
);
await assert.rejects(test('hourly', hourly + 30 * MINUTE), hourLimit);
await assert.rejects(test('hourly', hourly + HOUR - 1), /an hour\. Please try again in 1 second\./);
await test('hourly', hourly + HOUR);

// When both limits are reached, the longer wait is given, so trying again then works. Each user
// makes all but a minute's worth of their hourly tests from the given time, then the rest at once.
async function reachBothLimits(user, from, burst) {
  await useUp(user, from, WEBHOOK_TESTS_PER_HOUR - WEBHOOK_TESTS_PER_MINUTE);
  for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) await test(user, burst + i);
}
const early = start + 3 * HOUR;
await reachBothLimits('early-burst', early, early + 30 * MINUTE);
await assert.rejects(
  test('early-burst', early + 30 * MINUTE + 10 * SECOND),
  /an hour\. Please try again in 30 minutes\./
);
await test('early-burst', early + HOUR);
const late = start + 5 * HOUR;
await reachBothLimits('late-burst', late, late + HOUR - 30 * SECOND);
await assert.rejects(
  test('late-burst', late + HOUR - 20 * SECOND),
  /a minute\. Please try again in 50 seconds\./
);
// The hourly limit alone would allow a test by now.
await assert.rejects(
  test('late-burst', late + HOUR),
  /a minute\. Please try again in 30 seconds\./
);
await test('late-burst', late + HOUR + 30 * SECOND);

// Tests started at the same moment share the limit, so firing requests together cannot get past
// it, and only the tests it allows reach Discord.
limits.sent.length = 0;
const together = await Promise.allSettled(
  Array.from({ length: WEBHOOK_TESTS_PER_MINUTE + 3 }, () => test('together', start + 7 * HOUR))
);
assert.strictEqual(
  together.filter(({ status }) => status === 'fulfilled').length,
  WEBHOOK_TESTS_PER_MINUTE
);
for (const { reason } of together.filter(({ status }) => status === 'rejected'))
  assert.match(reason.message, /times a minute\. Please try again in 1 minute\.$/);
assert.strictEqual(limits.sent.length, WEBHOOK_TESTS_PER_MINUTE);

// Send requests through GraphQL to the real mutations, with stand-ins for the database and
// Discord. Like Sequelize, the model hands out copies of the stored lists, and only save and create
// change what is stored. These requests use the real clock, so they all fall within a minute, and
// each user makes at most two tests, which the minute limit always allows, apart from the one who
// reaches the limit.
const stored = new Map();
let nextID = 1;
class Instance {
  constructor(values) {
    Object.assign(this, values);
  }

  async save() {
    stored.set(this.id, { ...this });
  }
}
const ExportBanList = {
  async count({ where }) {
    return [...stored.values()].filter((list) => list.owner === where.owner).length;
  },
  async findOne({ where }) {
    const list = stored.get(where.id);
    return list && list.owner === where.owner ? new Instance(list) : null;
  },
  async create(values) {
    const list = new Instance({ ...values, id: nextID++ });
    await list.save();
    return list;
  }
};
const listsOf = (user) => [...stored.values()].filter((list) => list.owner === user);
const mutations = discord();
const { default: resolver } = await load('../src/graphql-api/mutation/resolver.js', {
  'scbl-lib/db/models': { BanList: {}, ExportBanList, ExportBanListConfig: {} },
  'scbl-lib/utils': mutations.utils
});
const server = new ApolloServer({
  schema: makeExecutableSchema({
    typeDefs: [
      mutationTypeDefs,
      // Just enough of the rest of the schema for the mutations.
      `type Query { unused: Boolean }
      type ExportBanList { id: Int, name: String, discordWebhook: String }
      type ExportBanListConfig { id: Int }`
    ],
    resolvers: resolver
  })
});

// Each request gets its own context, as the web server's context function makes one per request.
async function graphql(user, query, variables) {
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { id: user } } }
  );
  return response.body.singleResult;
}
const CREATE = `mutation ($discordWebhook: String) {
  createExportBanList(name: "List", server: "Server", type: "remote", discordWebhook: $discordWebhook) {
    id
    discordWebhook
  }
}`;
// The form sends every field, the webhook included, whether or not it changed.
const UPDATE = `mutation ($id: Int!, $name: String!, $discordWebhook: String) {
  updateExportBanList(id: $id, name: $name, server: "Server", threshold: 9, discordWebhook: $discordWebhook) {
    id
    name
    discordWebhook
  }
}`;

// Creating a list tests its webhook, and saving it again with the same webhook does not.
let result = await graphql('owner', CREATE, { discordWebhook: webhook(1) });
assert.strictEqual(result.errors, undefined);
const list = result.data.createExportBanList.id;
assert.strictEqual(stored.get(list).discordWebhook, webhook(1));
result = await graphql('owner', UPDATE, { id: list, name: 'Renamed', discordWebhook: webhook(1) });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.get(list).name, 'Renamed');
assert.deepStrictEqual(mutations.sent, [webhook(1)]);

// A mistyped webhook fails its test and is not saved, and saving the corrected one works.
result = await graphql('editor', CREATE, { discordWebhook: '' });
const editorList = result.data.createExportBanList.id;
mutations.sent.length = 0;
result = await graphql('editor', UPDATE, {
  id: editorList,
  name: 'L',
  discordWebhook: mistyped(2)
});
assert.match(result.errors[0].message, /^We could not post a test message to your Discord webhook/);
assert.strictEqual(stored.get(editorList).discordWebhook, '');
result = await graphql('editor', UPDATE, { id: editorList, name: 'L', discordWebhook: webhook(2) });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(result.data.updateExportBanList.discordWebhook, webhook(2));
assert.strictEqual(stored.get(editorList).discordWebhook, webhook(2));
assert.deepStrictEqual(mutations.sent, [mistyped(2), webhook(2)]);

// The same when creating a list, and a list without a webhook needs no test.
mutations.sent.length = 0;
result = await graphql('creator', CREATE, { discordWebhook: mistyped(3) });
assert.match(result.errors[0].message, /could not post a test message/);
assert.strictEqual(listsOf('creator').length, 0);
result = await graphql('creator', CREATE, { discordWebhook: webhook(3) });
assert.strictEqual(result.errors, undefined);
result = await graphql('creator', CREATE, { discordWebhook: '' });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(listsOf('creator').length, 2);
assert.deepStrictEqual(mutations.sent, [mistyped(3), webhook(3)]);

// One request repeating a mutation under many aliases posts one test message. The other aliases
// are refused, and a failed test leaves the stored webhook as it was.
const aliases = (count, field) =>
  `mutation { ${Array.from({ length: count }, (_, i) => `a${i}: ${field}`).join(' ')} }`;
mutations.sent.length = 0;
result = await graphql(
  'owner',
  aliases(50, `updateExportBanList(id: ${list}, discordWebhook: "${mistyped(4)}") { id }`)
);
assert.deepStrictEqual(mutations.sent, [mistyped(4)]);
assert.strictEqual(result.errors.length, 50);
for (const error of result.errors) {
  assert.match(
    error.message,
    error.path[0] === 'a0' ? /could not post a test message/ : /Only one Discord webhook/
  );
}
assert.strictEqual(stored.get(list).discordWebhook, webhook(1));
result = await graphql(
  'spammer',
  aliases(
    20,
    `createExportBanList(name: "L", server: "S", type: "remote", discordWebhook: "${webhook(5)}") { id }`
  )
);
assert.deepStrictEqual(mutations.sent, [mistyped(4), webhook(5)]);
assert.strictEqual(Object.values(result.data).filter(Boolean).length, 1);
assert.strictEqual(result.errors.length, 19);
assert.strictEqual(listsOf('spammer').length, 1);

// Mutations in the same request that need no test still run.
result = await graphql('several', CREATE, { discordWebhook: '' });
const severalList = result.data.createExportBanList.id;
result = await graphql(
  'several',
  `mutation {
    first: updateExportBanList(id: ${severalList}, discordWebhook: "${webhook(6)}") { id }
    second: updateExportBanList(id: ${severalList}, discordWebhook: "${webhook(7)}") { id }
    third: updateExportBanList(id: ${severalList}, name: "Third", discordWebhook: "${webhook(6)}") { id }
  }`
);
assert.deepStrictEqual(
  result.errors.map((error) => error.path[0]),
  ['second']
);
assert.strictEqual(stored.get(severalList).discordWebhook, webhook(6));
assert.strictEqual(stored.get(severalList).name, 'Third');

// The limit on each user reaches the form as an error it can show, without contacting Discord,
// whether the user is saving a list or creating one.
result = await graphql('retrying', CREATE, { discordWebhook: '' });
const retryingList = result.data.createExportBanList.id;
mutations.sent.length = 0;
for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) {
  result = await graphql('retrying', UPDATE, {
    id: retryingList,
    name: 'L',
    discordWebhook: mistyped(8)
  });
  assert.match(result.errors[0].message, /could not post a test message/);
}
const retryingLimit = new RegExp(
  `^Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_MINUTE} times a minute\\. Please try again in (1 minute|\\d+ seconds)\\.$`
);
result = await graphql('retrying', UPDATE, {
  id: retryingList,
  name: 'L',
  discordWebhook: webhook(8)
});
assert.strictEqual(result.errors.length, 1);
assert.match(result.errors[0].message, retryingLimit);
assert.strictEqual(stored.get(retryingList).discordWebhook, '');
// A refused create answers with no list, which the create form's cache update has to leave alone.
result = await graphql('retrying', CREATE, { discordWebhook: webhook(9) });
assert.strictEqual(result.data.createExportBanList, null);
assert.strictEqual(result.errors.length, 1);
assert.match(result.errors[0].message, retryingLimit);
assert.strictEqual(listsOf('retrying').length, 1);
assert.strictEqual(mutations.sent.length, WEBHOOK_TESTS_PER_MINUTE);

// The user who reached the limit can still save changes that need no test, and other users can
// still test webhooks.
result = await graphql('retrying', UPDATE, { id: retryingList, name: 'Kept', discordWebhook: '' });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.get(retryingList).name, 'Kept');
result = await graphql('neighbour', CREATE, { discordWebhook: webhook(10) });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.get(result.data.createExportBanList.id).discordWebhook, webhook(10));

await server.stop();

console.log('Webhook test limit checks passed: one test per request, limits per user, and saving.');
