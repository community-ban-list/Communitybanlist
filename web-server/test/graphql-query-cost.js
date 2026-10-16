import assert from 'assert';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

import * as apolloServer from '@apollo/server';
import * as apolloServerErrors from '@apollo/server/errors';
import * as apolloServerDisabledPlugins from '@apollo/server/plugin/disabled';
import * as graphqlToolsSchema from '@graphql-tools/schema';
import * as graphqlToolsUtils from '@graphql-tools/utils';
import graphql from 'graphql';
import { gql } from 'graphql-tag';
import jwt from 'jsonwebtoken';

import { largestPage } from '../src/graphql-api/core/page-size.js';
import {
  PAGE_DEFAULTS,
  QUERY_LIMITS,
  queryCost,
  schemaCosts
} from '../src/graphql-api/core/query-cost.js';

const { Kind, getIntrospectionQuery, isObjectType, parse } = graphql;

// Stand-ins for the models, each with one row, that record every lookup the resolvers make.
const calls = [];
const playerID = '76561198000000001';
const rows = {
  Organisation: { id: 1, name: 'Organisation', discord: 'https://discord.gg/example' },
  BanList: { id: 1, name: 'Ban list', organisation: 1 },
  Ban: { id: '1', steamUser: playerID, banList: 1, reason: 'Reason', created: new Date(0) },
  SteamUser: { id: playerID, name: 'Player', reputationPoints: 3, async save() {} },
  ExportBanList: {
    id: 1,
    name: 'List',
    server: 'Server',
    type: 'remote',
    owner: playerID,
    async save() {},
    async destroy() {},
    // A remote list has no BattleMetrics invite to make.
    async createBattlemetricsInvite() {}
  },
  ExportBanListConfig: { id: 1, exportBanList: 1, banList: 1, activePoints: 1, async destroy() {} }
};
const models = {};
for (const [model, row] of Object.entries(rows)) {
  const answers = {
    paginate: () => ({ edges: [{ cursor: 'cursor', node: row }], pageInfo: {} }),
    findAll: () => [row],
    findByPk: () => row,
    // An export ban list config is only made when its list has none for that ban list yet.
    findOne: ({ where }) => (model === 'ExportBanListConfig' && !where.id ? null : row),
    count: () => 0,
    create: (values) => ({ ...row, ...values })
  };
  models[model] = {};
  for (const [method, answer] of Object.entries(answers))
    models[model][method] = async (options) => {
      calls.push({ model, method, options });
      return answer(options);
    };
}

// The GraphQL API is loaded from the file the web server runs, with the real schema and resolvers,
// and stubs for Koa and the database. @apollo/server is the real package, but ApolloServer is a
// subclass that records the options it is built with, so the checks can read the schema back.
const builds = [];
class RecordingApolloServer extends apolloServer.ApolloServer {
  constructor(options) {
    super(options);
    builds.push({ options, server: this });
  }
}

const packages = {
  '@apollo/server': { ...apolloServer, ApolloServer: RecordingApolloServer },
  '@apollo/server/errors': apolloServerErrors,
  '@apollo/server/plugin/disabled': apolloServerDisabledPlugins,
  '@as-integrations/koa': { koaMiddleware: () => async () => {} },
  '@graphql-tools/schema': graphqlToolsSchema,
  '@graphql-tools/utils': graphqlToolsUtils,
  graphql: { default: graphql },
  'graphql-tag': { gql },
  jsonwebtoken: { default: jwt },
  // These are only read when signing a request in, which these checks do not do. Both the current
  // and the sign-in-token values are supplied, so the API loads whichever way it reads them.
  'scbl-lib/config': {
    JWT_AUTH: { ALGORITHM: 'HS256', SECRET: 'a-secret-only-these-checks-use' },
    SIGN_IN_TOKEN_LIFETIME: 30 * 24 * 60 * 60
  },
  'scbl-lib/db/models': models,
  'scbl-lib/db/sequelize': {
    DATABASE_UNAVAILABLE_MESSAGE: 'The database is unavailable.',
    isDatabaseUnavailable: () => false,
    Op: { ne: Symbol('ne') }
  },
  'scbl-lib/utils': {
    calculateRiskRating(points) {
      calls.push({ model: 'utils', method: 'calculateRiskRating' });
      return points / 10;
    },
    isDiscordWebhookUrl: () => true,
    async testDiscordWebhook() {}
  }
};

// Load a module with these packages, in a context of its own with these globals. Other relative
// imports load the real files.
async function load(path, globals) {
  const context = vm.createContext(globals);
  const modules = new Map();
  async function moduleFor(specifier, referencingURL) {
    const exports = packages[specifier];
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
}

// Load the API as it runs in development, where Apollo Sandbox's introspection query is allowed.
// Apollo Server reads NODE_ENV when it is built.
const { NODE_ENV } = process.env;
process.env.NODE_ENV = 'development';
await load('../src/graphql-api/index.js', {
  process: { env: { NODE_ENV: 'development' } },
  console
});
if (NODE_ENV === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = NODE_ENV;
assert.strictEqual(builds.length, 1);
const [{ options, server }] = builds;
const { schema } = options;

// Read the schema's costs before the server runs a request, as the server's rule does.
const costs = schemaCosts(schema);
const measure = (query) => queryCost(parse(query), schema, costs)[0];

// Every list with page arguments has its default page size here, so its pages are counted.
const pagedLists = Object.values(schema.getTypeMap())
  .filter(isObjectType)
  .flatMap((type) =>
    Object.values(type.getFields())
      .filter((field) => field.args.some((arg) => arg.name === 'first'))
      .map((field) => `${type.name}.${field.name}`)
  );
assert.deepStrictEqual(pagedLists.sort(), Object.keys(PAGE_DEFAULTS).sort());

// Every query the client sends, read from its source, costs at most three quarters of the limit and
// asks for at most the limit's number of fields at its top level, so the site's pages have room to
// grow and a page that outgrows it fails this check before it can be refused in production.
const clientSource = fileURLToPath(new URL('../../client/src/', import.meta.url));
const clientOperations = [];
for (const entry of await readdir(clientSource, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.[jt]sx?$/.test(entry.name)) continue;
  const file = join(entry.parentPath, entry.name);
  const name = relative(clientSource, file);
  const source = await readFile(file, 'utf8');
  const documents = [...source.matchAll(/gql`([^`]*)`/g)].map(([, text]) => text);
  assert.strictEqual(documents.length, source.split('gql`').length - 1, `all of ${name} is read`);
  for (const text of documents) {
    assert.ok(!text.includes('${'), `${name}: the client's documents are written out in full`);
    // A document of fragments alone is only written to the client's own cache, never sent.
    for (const result of queryCost(parse(text), schema, costs)) {
      const operation = result.operation.name?.value ?? 'the anonymous operation';
      clientOperations.push({ ...result, name: `${name}, ${operation}`, text });
    }
  }
}
assert.ok(clientOperations.length > 0, "the client's queries are found");
for (const { name, cost, topLevelFields } of clientOperations) {
  assert.ok(cost <= (QUERY_LIMITS.cost * 3) / 4, `${name} costs ${cost}`);
  assert.ok(topLevelFields <= QUERY_LIMITS.topLevelFields, `${name} has ${topLevelFields} fields`);
}
const largestClientCost = Math.max(...clientOperations.map(({ cost }) => cost));

// __typename and the schema's other __ fields are answered from the schema itself, and cost
// nothing.
assert.strictEqual(
  measure('{ bans(first: 5) { __typename edges { __typename node { __typename id } } } }').cost,
  measure('{ bans(first: 5) { edges { node { id } } } }').cost
);
assert.strictEqual(measure('{ __schema { types { name fields { name } } } __typename }').cost, 0);
assert.strictEqual(measure(getIntrospectionQuery()).cost, 0);

// Fragments cost the same as the fields in them, however they are written, and fragments that each
// spread the next twice are only worked out once each, so even 40 levels of them are counted at
// once, as far more than the limit.
const nested =
  '{ steamUsers(first: 100) { edges { node { bans(first: 100) { edges { node { id } } } } } } }';
const spread = `
  query { steamUsers(first: 100) { ...Players } }
  fragment Players on SteamUserConnection { edges { node { ...Bans } } }
  fragment Bans on SteamUser { bans(first: 100) { edges { node { id } } } }
`;
const inline = `{ steamUsers(first: 100) {
  ... on SteamUserConnection { edges { node { ... { bans(first: 100) { edges { node { id } } } } } } }
} }`;
assert.strictEqual(measure(spread).cost, measure(nested).cost);
assert.strictEqual(measure(inline).cost, measure(nested).cost);
const doubling = (levels) =>
  [
    '{ banLists { ...F0 } }',
    ...Array.from(
      { length: levels },
      (_, i) => `fragment F${i} on BanList { ...F${i + 1} ...F${i + 1} }`
    ),
    `fragment F${levels} on BanList { id }`
  ].join('\n');
assert.ok(measure(doubling(40)).cost > QUERY_LIMITS.cost);

// The fields at an operation's top level are counted by the names they are answered under, with
// those in fragments, and without __typename.
assert.strictEqual(measure('{ banLists { id } banLists { name } __typename }').topLevelFields, 1);
assert.strictEqual(
  measure(`
    { a: banLists { id } b: banLists { id } ...More }
    fragment More on Query { organisations { id } a: banLists { name } }
  `).topLevelFields,
  3
);

// Send an operation to the server as a signed-in player, and return its result and the lookups it
// made.
async function run(query, variables) {
  calls.length = 0;
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { user: { id: playerID } } }
  );
  assert.strictEqual(response.body.kind, 'single');
  return { status: response.http.status, result: response.body.singleResult, calls: [...calls] };
}

// Check that the server refuses an operation as it asks for too much, with this message, before
// anything is looked up.
async function checkRefused(description, query, variables, message) {
  const { status, result, calls } = await run(query, variables);
  assert.strictEqual(status, 400, description);
  assert.strictEqual(result.data, undefined, description);
  assert.strictEqual(result.errors?.length, 1, description);
  assert.strictEqual(result.errors[0].extensions.code, 'GRAPHQL_VALIDATION_FAILED', description);
  assert.match(result.errors[0].message, message, description);
  assert.deepStrictEqual(calls, [], `nothing is looked up for ${description}`);
}

// A list with page arguments is counted as returning as many rows as its resolver asks paginate
// for: the size a request asks for, between 1 and the list's largest page, or the list's default
// when it does not say. Each list's rows are worked out from the costs of pages of one and two rows.
// A page size from a variable counts as the list's largest page, whatever is sent, and a cursor
// from a variable as the larger of the pages it can give.
const lists = [
  { name: 'Query.bans', model: 'Ban', path: (args) => `bans${args} { edges { node { id } } }` },
  {
    name: 'Query.steamUsers',
    model: 'SteamUser',
    path: (args) => `steamUsers${args} { edges { node { id } } }`
  },
  {
    name: 'SteamUser.bans',
    model: 'Ban',
    path: (args) => `steamUser(id: "${playerID}") { bans${args} { edges { node { id } } } }`
  }
];
for (const list of lists) {
  const query = (args, variables = '') => `query Page${variables} { ${list.path(args)} }`;
  const one = measure(query('(first: 1)')).cost;
  const perRow = measure(query('(first: 2)')).cost - one;
  const rowsCounted = (args, variables) =>
    1 + (measure(query(args, variables)).cost - one) / perRow;
  const pageAsked = async (args, variables, values) => {
    const { result, calls } = await run(query(args, variables), values);
    assert.strictEqual(result.errors, undefined, `${list.name}${args}`);
    const pages = calls.filter(
      ({ model, method }) => model === list.model && method === 'paginate'
    );
    assert.strictEqual(pages.length, 1);
    return pages[0].options.last ?? pages[0].options.first;
  };

  for (const args of [
    '',
    '(first: null)',
    '(first: 0)',
    '(first: -5)',
    '(first: 12)',
    '(first: 20)',
    '(first: 100)',
    '(first: 200000)',
    '(before: "cursor")',
    '(last: 7, before: "cursor")',
    '(last: 500, before: "cursor")'
  ])
    assert.strictEqual(rowsCounted(args), await pageAsked(args), `${list.name}${args}`);
  assert.strictEqual(rowsCounted(''), PAGE_DEFAULTS[list.name]);

  const largest = largestPage(PAGE_DEFAULTS[list.name]);
  for (const [args, variables] of [
    ['(first: $size)', '($size: Int)'],
    ['(last: $size, before: "cursor")', '($size: Int)']
  ]) {
    assert.strictEqual(rowsCounted(args, variables), largest, `${list.name}${args}`);
    for (const size of [null, 1, 5, 200000])
      assert.ok((await pageAsked(args, variables, { size })) <= largest, `${list.name}${args}`);
  }
  const fromCursor = ['(first: 5, before: $cursor)', '($cursor: String)'];
  assert.strictEqual(
    rowsCounted(...fromCursor),
    Math.max(
      await pageAsked(...fromCursor, { cursor: null }),
      await pageAsked(...fromCursor, { cursor: 'cursor' })
    )
  );
}

// Requests that ask for far more than any page are refused before anything is looked up.
const tooCostly = /asks for more than one request can answer/;
const refused = [
  ['pages of players with pages of their bans', nested],
  [
    "bans with their players' bans, and those bans' players' bans, at the default page sizes",
    `{ bans { edges { node { steamUser {
      bans { edges { node { steamUser { bans { edges { node { id } } } } } } }
    } } } } }`
  ],
  [
    "pages of bans with their players' pages of bans",
    `{ bans(first: 100) { edges { node {
      steamUser { bans(first: 100) { edges { node { id } } } }
    } } } }`
  ],
  [
    "organisations with their ban lists' organisations' ban lists",
    '{ organisations { banLists { organisation { banLists { id } } } } }'
  ],
  [
    "a page of players with three bans each, and those bans' players with three bans each, twice",
    `{ steamUsers(first: 20) { edges { node { id bans(first: 3) { edges { node { id
      steamUser { id bans(first: 3) { edges { node { id
        steamUser { id bans(first: 3) { edges { node { id steamUser { id } } } } }
      } } } }
    } } } } } } }`
  ],
  [
    'pages of players with pages of their bans, sized by a variable',
    `query Nested($size: Int) { steamUsers(first: $size) { edges { node {
      bans(first: $size) { edges { node { id } } }
    } } } }`,
    { size: 1 }
  ],
  ['the same nesting written with fragment spreads', spread],
  ['the same nesting written with inline fragments', inline]
];
for (const [description, query, variables] of refused) {
  assert.ok(measure(query).cost > QUERY_LIMITS.cost, description);
  await checkRefused(description, query, variables, tooCostly);
}

// An operation can ask for up to 10 fields at its top level, such as 10 player lookups or 10
// changes, but not 11.
const aliases = (count, field) =>
  Array.from({ length: count }, (_, i) => `a${i}: ${field}`).join(' ');
const players = (count) => `{ ${aliases(count, `steamUser(id: "${playerID}") { id }`)} }`;
const tenPlayers = await run(players(10));
assert.strictEqual(tenPlayers.result.errors, undefined);
assert.strictEqual(tenPlayers.calls.filter(({ method }) => method === 'findByPk').length, 10);
const elevenFields = /asks for 11 fields at its top level/;
await checkRefused('11 player lookups', players(11), undefined, elevenFields);
await checkRefused(
  '11 changes',
  `mutation { ${aliases(11, 'deleteExportBanListConfig(id: 1) { id }')} }`,
  undefined,
  elevenFields
);

// Apollo Server counts an operation's selections first, with each fragment's selections counted
// every time it is spread, and refuses more than 1,000, so the cost is only worked out for sensible
// requests. A fragment keeps these documents short enough to be read: bans, edges and node, and 9
// spreads of a fragment of 109 fields, make 993 selections before the fields beside the spreads.
const selections = (count) => `
  { bans(first: 1) { edges { node { ${'...Fields '.repeat(9)}${'id '.repeat(count - 993)}} } } }
  fragment Fields on Ban { ${aliases(109, 'id')} }
`;
assert.strictEqual((await run(selections(1000))).result.errors, undefined, '1,000 selections');
const tooManySelections = /recursively requests too many selections/;
await checkRefused('1,001 selections', selections(1001), undefined, tooManySelections);
await checkRefused('fragments that double 10 times', doubling(10), undefined, tooManySelections);

// Nesting within reason is answered.
const reasonable = await run(`{ bans(first: 20) { edges { node {
  steamUser { bans(first: 5) { edges { node { id } } } }
} } } }`);
assert.strictEqual(reasonable.result.errors, undefined);
assert.strictEqual(reasonable.result.data.bans.edges[0].node.steamUser.bans.edges[0].node.id, '1');

// So are several pages at once that together cost less than the site's costliest page, such as
// five pages of players with three of their bans each and each ban's player.
const playersBans = `steamUsers(first: 20) { edges { node { id
  bans(first: 3) { edges { node { id steamUser { id } } } }
} } }`;
const severalPages = `{ ${aliases(5, playersBans)} }`;
assert.ok(measure(severalPages).cost < largestClientCost, "less than the site's costliest page");
assert.strictEqual((await run(severalPages)).result.errors, undefined, 'several pages at once');

// The client's own queries and changes are answered. The server has already run requests above,
// after which Apollo Server gives every field a resolver, so this also checks that the rule still
// counts only the fields with resolvers of their own. Required variables are given values the
// stand-ins accept: 'remote' is a valid export ban list type, and any ID finds their row.
const values = { Int: 1, String: 'remote', Boolean: false };
for (const { name, text, operation } of clientOperations) {
  const variables = {};
  for (const { variable, type } of operation.variableDefinitions)
    if (type.kind === Kind.NON_NULL_TYPE)
      variables[variable.name.value] = values[type.type.name.value];
  const { result } = await run(text, variables);
  assert.strictEqual(result.errors, undefined, `${name}: ${JSON.stringify(result.errors)}`);
}

// In development, Apollo Sandbox's introspection query is answered.
const introspection = await run(getIntrospectionQuery());
assert.strictEqual(introspection.result.errors, undefined);
assert.ok(introspection.result.data.__schema.types.length > 0);

await server.stop();

console.log(
  `GraphQL query cost checks passed: ${clientOperations.length} client operations (costing at ` +
    `most ${largestClientCost} of ${QUERY_LIMITS.cost}), page sizes, fragments, top-level fields ` +
    'and refused requests.'
);
