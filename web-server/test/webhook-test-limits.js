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

// A stand-in for posting test messages, which records the webhooks it posted to. Webhooks added to
// failing are answered the way Discord answers a mistyped one.
function discord() {
  const sent = [];
  const failing = new Set();
  const utils = {
    isDiscordWebhookUrl,
    async testDiscordWebhook(url) {
      if (!isDiscordWebhookUrl(url)) throw new Error('Invalid Discord Webhook');
      sent.push(url);
      if (failing.has(url))
        throw new Error(
          'We could not post a test message to your Discord webhook. Discord answered HTTP 401: Invalid Webhook Token (code 50027).'
        );
    }
  };
  return { sent, failing, utils };
}

const webhook = (id) => `https://discord.com/api/webhooks/${id}/token-${id}`;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const limits = discord();
const limiter = await load('../src/graphql-api/mutation/test-webhook.js', {
  'scbl-lib/utils': limits.utils
});
const { default: testWebhook, WEBHOOK_TESTS_PER_MINUTE, WEBHOOK_TESTS_PER_HOUR } = limiter;
// Fixing a mistyped webhook takes a second test, and the hourly limit is the larger one.
assert.ok(WEBHOOK_TESTS_PER_MINUTE >= 2);
assert.ok(WEBHOOK_TESTS_PER_HOUR > WEBHOOK_TESTS_PER_MINUTE);

// Each call is a new request from the user, made at the given time.
const test = (user, id, now) => testWebhook({ user: { id: user } }, webhook(id), now);
const start = Date.UTC(2026, 0, 1);

// A request can test one webhook, even when the first test failed.
const request = { user: { id: 'one-request' } };
await testWebhook(request, webhook(1), start);
await assert.rejects(
  testWebhook(request, webhook(2), start),
  /^Error: Only one Discord webhook can be tested per request\. Please save one export ban list at a time\.$/
);
limits.failing.add(webhook(3));
const failedRequest = { user: { id: 'one-request' } };
await assert.rejects(
  testWebhook(failedRequest, webhook(3), start),
  /could not post a test message/
);
await assert.rejects(testWebhook(failedRequest, webhook(4), start), /Only one Discord webhook/);
assert.deepStrictEqual(limits.sent, [webhook(1), webhook(3)]);

// An address that is not a Discord webhook is refused without contacting Discord, so it is not a
// test and the request can still test a webhook.
const mistake = { user: { id: 'one-request' } };
await assert.rejects(testWebhook(mistake, 'https://example.com/hook', start), /Invalid Discord/);
await testWebhook(mistake, webhook(5), start);
assert.strictEqual(limits.sent.length, 3);

// Webhooks are only tested for a signed-in user.
for (const context of [{ user: null }, { user: {} }])
  await assert.rejects(testWebhook(context, webhook(6), start), /Please sign in again/);
assert.strictEqual(limits.sent.length, 3);

// A user can test a few webhooks a minute, failed tests included, and is told when they can test
// another. Other users can still test theirs.
limits.sent.length = 0;
for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) {
  if (i === 1) {
    // Addresses refused before contacting Discord do not use up a test.
    await assert.rejects(
      testWebhook({ user: { id: 'busy' } }, 'not a webhook', start + i * SECOND),
      /Invalid Discord/
    );
  }
  if (i === 2) limits.failing.add(webhook(100 + i));
  await test('busy', 100 + i, start + i * SECOND).catch((err) => {
    assert.match(err.message, /could not post a test message/);
  });
}
assert.strictEqual(limits.sent.length, WEBHOOK_TESTS_PER_MINUTE);
const minuteLimit = new RegExp(
  `^Error: Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_MINUTE} times a minute\\. Please try again in 50 seconds\\.$`
);
await assert.rejects(test('busy', 200, start + 10 * SECOND), minuteLimit);
await assert.rejects(test('busy', 200, start + 10 * SECOND), minuteLimit);
await test('someone-else', 201, start + 10 * SECOND);
assert.strictEqual(limits.sent.length, WEBHOOK_TESTS_PER_MINUTE + 1);
// Refused tests do not count, so trying again when told works.
await assert.rejects(test('busy', 202, start + MINUTE - 1), /Please try again in 1 second\./);
await test('busy', 202, start + MINUTE);
await assert.rejects(test('busy', 203, start + MINUTE + 1), /Please try again in 1 second\./);
await test('busy', 203, start + MINUTE + SECOND);

// The hourly limit holds however the tests are spread out, and says how many minutes are left.
for (let i = 0; i < WEBHOOK_TESTS_PER_HOUR; i++) await test('hourly', 300 + i, start + i * MINUTE);
const lastTest = start + (WEBHOOK_TESTS_PER_HOUR - 1) * MINUTE;
const hourLimit = new RegExp(
  `^Error: Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_HOUR} times an hour\\. Please try again in ${60 - WEBHOOK_TESTS_PER_HOUR} minutes\\.$`
);
await assert.rejects(test('hourly', 400, lastTest + MINUTE), hourLimit);
await assert.rejects(
  test('hourly', 400, start + HOUR - 1),
  /an hour\. Please try again in 1 second\./
);
await test('hourly', 400, start + HOUR);

// When both limits are reached, the longer wait is given, so trying again then works. Each user
// spreads out most of their hourly tests from the given time, then makes a burst of tests.
async function reachBothLimits(user, from, burst) {
  for (let i = 0; i < WEBHOOK_TESTS_PER_HOUR - WEBHOOK_TESTS_PER_MINUTE; i++)
    await test(user, 500 + i, from + i * MINUTE);
  for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) await test(user, 600 + i, burst + i);
}
const early = start + 2 * HOUR;
await reachBothLimits('early-burst', early, early + 30 * MINUTE);
await assert.rejects(
  test('early-burst', 700, early + 30 * MINUTE + 10 * SECOND),
  /an hour\. Please try again in 30 minutes\./
);
await test('early-burst', 700, early + HOUR);
const late = start + 4 * HOUR;
await reachBothLimits('late-burst', late, late + HOUR - 30 * SECOND);
await assert.rejects(
  test('late-burst', 700, late + HOUR - 20 * SECOND),
  /a minute\. Please try again in 50 seconds\./
);
// The hourly limit alone would allow a test by now.
await assert.rejects(test('late-burst', 700, late + HOUR), /a minute\. .* 30 seconds\./);
await test('late-burst', 700, late + HOUR + 30 * SECOND + WEBHOOK_TESTS_PER_MINUTE);

// Send requests through GraphQL to the real mutations, with stand-ins for the database and
// Discord. Like Sequelize, the model hands out copies of the stored lists, and only save and create
// change what is stored.
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
mutations.failing.add(webhook(2));
result = await graphql('owner', UPDATE, { id: list, name: 'Renamed', discordWebhook: webhook(2) });
assert.match(result.errors[0].message, /^We could not post a test message to your Discord webhook/);
assert.strictEqual(stored.get(list).discordWebhook, webhook(1));
result = await graphql('owner', UPDATE, { id: list, name: 'Renamed', discordWebhook: webhook(3) });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(result.data.updateExportBanList.discordWebhook, webhook(3));
assert.strictEqual(stored.get(list).discordWebhook, webhook(3));

// The same when creating a list, and a list without a webhook needs no test.
result = await graphql('creator', CREATE, { discordWebhook: webhook(2) });
assert.match(result.errors[0].message, /could not post a test message/);
assert.strictEqual(stored.size, 1);
result = await graphql('creator', CREATE, { discordWebhook: webhook(4) });
assert.strictEqual(result.errors, undefined);
result = await graphql('creator', CREATE, { discordWebhook: '' });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.size, 3);
assert.deepStrictEqual(mutations.sent, [
  webhook(1),
  webhook(2),
  webhook(3),
  webhook(2),
  webhook(4)
]);

// One request repeating a mutation under many aliases posts one test message. The other aliases
// are refused, and a failed test leaves the stored webhook as it was.
const aliases = (count, field) =>
  `mutation { ${Array.from({ length: count }, (_, i) => `a${i}: ${field}`).join(' ')} }`;
mutations.sent.length = 0;
mutations.failing.add(webhook(5));
result = await graphql(
  'owner',
  aliases(50, `updateExportBanList(id: ${list}, discordWebhook: "${webhook(5)}") { id }`)
);
assert.deepStrictEqual(mutations.sent, [webhook(5)]);
assert.strictEqual(result.errors.length, 50);
for (const error of result.errors) {
  assert.match(
    error.message,
    error.path[0] === 'a0' ? /could not post a test message/ : /Only one Discord webhook/
  );
}
assert.strictEqual(stored.get(list).discordWebhook, webhook(3));
result = await graphql(
  'spammer',
  aliases(
    20,
    `createExportBanList(name: "L", server: "S", type: "remote", discordWebhook: "${webhook(6)}") { id }`
  )
);
assert.deepStrictEqual(mutations.sent, [webhook(5), webhook(6)]);
assert.strictEqual(Object.values(result.data).filter(Boolean).length, 1);
assert.strictEqual(result.errors.length, 19);
assert.strictEqual(stored.size, 4);

// Mutations in the same request that need no test still run.
result = await graphql(
  'owner',
  `mutation {
    first: updateExportBanList(id: ${list}, discordWebhook: "${webhook(7)}") { id }
    second: updateExportBanList(id: ${list}, discordWebhook: "${webhook(8)}") { id }
    third: updateExportBanList(id: ${list}, name: "Third", discordWebhook: "${webhook(7)}") { id }
  }`
);
assert.deepStrictEqual(
  result.errors.map((error) => error.path[0]),
  ['second']
);
assert.strictEqual(stored.get(list).discordWebhook, webhook(7));
assert.strictEqual(stored.get(list).name, 'Third');

// The limit on each user reaches the form as an error it can show, without contacting Discord.
result = await graphql('retrying', CREATE, { discordWebhook: '' });
const retryingList = result.data.createExportBanList.id;
mutations.sent.length = 0;
for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) {
  mutations.failing.add(webhook(10 + i));
  result = await graphql('retrying', UPDATE, {
    id: retryingList,
    name: 'L',
    discordWebhook: webhook(10 + i)
  });
  assert.match(result.errors[0].message, /could not post a test message/);
}
result = await graphql('retrying', UPDATE, {
  id: retryingList,
  name: 'L',
  discordWebhook: webhook(20)
});
assert.strictEqual(result.errors.length, 1);
assert.match(
  result.errors[0].message,
  new RegExp(
    `^Discord webhooks can only be tested ${WEBHOOK_TESTS_PER_MINUTE} times a minute\\. Please try again in (1 minute|\\d+ seconds)\\.$`
  )
);
assert.strictEqual(mutations.sent.length, WEBHOOK_TESTS_PER_MINUTE);
assert.strictEqual(stored.get(retryingList).discordWebhook, '');

// The user who reached the limit can still save changes that need no test, and other users can
// still test webhooks.
result = await graphql('retrying', UPDATE, { id: retryingList, name: 'Kept', discordWebhook: '' });
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.get(retryingList).name, 'Kept');
const creatorList = [...stored.values()].find((record) => record.owner === 'creator').id;
result = await graphql('creator', UPDATE, {
  id: creatorList,
  name: 'L',
  discordWebhook: webhook(21)
});
assert.strictEqual(result.errors, undefined);
assert.strictEqual(stored.get(creatorList).discordWebhook, webhook(21));

await server.stop();

console.log('Webhook test limit checks passed: one test per request, limits per user, and saving.');
