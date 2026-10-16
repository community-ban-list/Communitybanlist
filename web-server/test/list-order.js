import assert from 'assert';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import vm from 'vm';

import graphql from 'graphql';

import queryTypeDefs from '../src/graphql-api/query/typedef.js';
import steamUserTypeDefs from '../src/graphql-api/steam-user/typedef.js';

const { GraphQLError } = graphql;

// Load a resolver in this context, so the options it passes on can be compared as they are, with
// its package imports replaced by stubs. Relative imports load the real files.
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
  return module.namespace.default;
}

// Stand-ins for the models, whose paginate records the options each list passes to it.
const calls = [];
const recorder = (model) => ({
  paginate(options) {
    calls.push({ model, options });
    return { edges: [], pageInfo: {} };
  }
});
const Ban = recorder('Ban');
const SteamUser = recorder('SteamUser');
const Op = { ne: Symbol('ne'), gt: Symbol('gt') };
const stubs = {
  graphql: { default: graphql },
  'scbl-lib/db/models': { Ban, BanList: {}, ExportBanList: {}, Organisation: {}, SteamUser },
  'scbl-lib/db/sequelize': { Op },
  'scbl-lib/utils': { calculateRiskRating() {} }
};

const { Query } = await load('../src/graphql-api/query/resolver.js', stubs);
const { SteamUser: SteamUserFields } = await load(
  '../src/graphql-api/steam-user/resolver.js',
  stubs
);

// The lists, each with the sort orders it accepts.
const player = { id: '76561198000000001' };
const bans = {
  name: 'bans',
  model: 'Ban',
  orders: ['created'],
  resolve: (args) => Query.bans(null, args)
};
const steamUsers = {
  name: 'steamUsers',
  model: 'SteamUser',
  orders: ['id', 'reputationRank', 'reputationPointsMonthChange', 'lastViewed'],
  resolve: (args) => Query.steamUsers(null, args)
};
const playerBans = {
  name: 'SteamUser.bans',
  model: 'Ban',
  orders: ['created'],
  resolve: (args) => SteamUserFields.bans(player, args)
};
const lists = [bans, steamUsers, playerBans];

// The options a list passes to paginate for these arguments.
function optionsFor(list, args) {
  calls.length = 0;
  list.resolve(args);
  assert.strictEqual(calls.length, 1, `${list.name} ${JSON.stringify(args)}`);
  assert.strictEqual(calls[0].model, list.model);
  return calls[0].options;
}

// Check that a list refuses a request with this message, before it makes any query.
function assertRefused(list, args, message) {
  const request = `${list.name} ${JSON.stringify(args)}`;
  calls.length = 0;
  assert.throws(
    () => list.resolve(args),
    (error) => {
      assert.ok(error instanceof GraphQLError, `${request}: ${error}`);
      assert.strictEqual(error.extensions.code, 'BAD_USER_INPUT', request);
      assert.strictEqual(error.message, message, request);
      return true;
    },
    request
  );
  assert.strictEqual(calls.length, 0, `${request} made a query`);
}

const MIXED = 'Use first and after, or last and before, but not both.';
const NO_BEFORE = 'Use last with a before cursor.';
const INVALID_CURSOR = 'Invalid page cursor.';

// Each list's sort orders, as the site's pages use them. Each order leaves out the rows with no
// value to sort by. This month's most harmful players are those with a rank whose points rose,
// sorted by rank when their points rose by the same amount. A player's bans are only theirs, and
// only the active or expired ones when asked.
const notNull = { [Op.ne]: null };
for (const [list, args, order, where] of [
  [bans, {}, [['created', 'DESC']], { created: notNull }],
  [bans, { orderBy: null, orderDirection: null }, [['created', 'DESC']], { created: notNull }],
  [bans, { orderBy: 'created', orderDirection: 'ASC' }, [['created', 'ASC']], { created: notNull }],
  [playerBans, {}, [['created', 'DESC']], { created: notNull, steamUser: player.id }],
  [
    playerBans,
    { orderBy: 'created', orderDirection: 'DESC', expired: false },
    [['created', 'DESC']],
    { created: notNull, steamUser: player.id, expired: false }
  ],
  [steamUsers, {}, [['id', 'DESC']], undefined],
  [steamUsers, { orderBy: 'id', orderDirection: 'ASC' }, [['id', 'ASC']], undefined],
  [
    steamUsers,
    { orderBy: 'reputationRank', orderDirection: 'ASC' },
    [['reputationRank', 'ASC']],
    { reputationRank: notNull }
  ],
  [
    steamUsers,
    { orderBy: 'reputationPointsMonthChange', orderDirection: 'DESC' },
    [
      ['reputationPointsMonthChange', 'DESC'],
      ['reputationRank', 'ASC']
    ],
    { reputationPointsMonthChange: { [Op.gt]: 0 }, reputationRank: notNull }
  ],
  [
    steamUsers,
    { orderBy: 'lastViewed', orderDirection: 'DESC' },
    [['lastViewed', 'DESC']],
    { lastViewed: notNull }
  ]
]) {
  const options = optionsFor(list, args);
  assert.deepStrictEqual(options.order, order, `${list.name} ${JSON.stringify(args)}`);
  assert.deepStrictEqual(options.where, where, `${list.name} ${JSON.stringify(args)}`);
}

// Every list refuses any other orderBy, with an error naming the ones it accepts, before it makes
// any query: other fields of its rows, fields of other tables, the other lists' orders, and names
// that are not fields.
const otherNames = [
  'rawNote',
  'rawReason',
  'isSCBLUser',
  'lastRefreshedExport',
  'lastRefreshedInfo',
  'createdAt',
  'updatedAt',
  'expires',
  'reason',
  'name',
  'reputationPoints',
  'SteamUser.name',
  '$SteamUser.name$',
  'banList',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
  'created`',
  '`created`',
  'created DESC',
  'CREATED',
  ' id'
];
for (const list of lists) {
  const others = lists
    .flatMap(({ orders }) => orders)
    .filter((name) => !list.orders.includes(name));
  for (const orderBy of [...otherNames, ...others])
    assertRefused(list, { orderBy }, `orderBy must be one of: ${list.orders.join(', ')}.`);
}

// Cursors as the pagination library writes them: base64 JSON for an array of a row's values for
// the fields a list is sorted by, then its id.
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const date = '2026-10-01T12:34:56.789Z';
const banID = '1,9998';
const steamID = '76561198000000002';
const sorted = [
  { list: bans, args: {}, kinds: ['date', 'string'], values: [date, banID] },
  { list: playerBans, args: { expired: false }, kinds: ['date', 'string'], values: [date, banID] },
  { list: steamUsers, args: {}, kinds: ['string'], values: [steamID] },
  {
    list: steamUsers,
    args: { orderBy: 'reputationRank', orderDirection: 'ASC' },
    kinds: ['integer', 'string'],
    values: [3, steamID]
  },
  {
    list: steamUsers,
    args: { orderBy: 'reputationPointsMonthChange', orderDirection: 'DESC' },
    kinds: ['integer', 'integer', 'string'],
    values: [6, 12, steamID]
  },
  {
    list: steamUsers,
    args: { orderBy: 'lastViewed', orderDirection: 'DESC' },
    kinds: ['date', 'string'],
    values: [date, steamID]
  }
];

// Values that are not of each kind: dates are the strings JSON gives for a Date, with four-digit
// years, integers are whole numbers, and ids are strings.
const notOfKind = {
  date: [
    null,
    'ab',
    '2026-10-01',
    '2026-10-01 12:34:56',
    '2026-10-01T12:34:56.789+00:00',
    '2026-02-30T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z',
    Date.parse(date),
    true,
    [date],
    { date }
  ],
  integer: [null, '3', 3.5, 1e21, true, [3], {}],
  string: [null, 1, true, [steamID], {}]
};

for (const { list, args, kinds, values } of sorted) {
  const position = encode(values);

  // A request asks for the page after a cursor with first and after, or for the page before one
  // with last and before. Every list refuses requests that mix the two, or that ask for the last
  // rows without a cursor to end before, as the pagination library cannot answer them.
  for (const page of [
    { first: 5, before: position },
    { first: 5, last: 5, before: position },
    { after: position, before: position },
    { after: position, last: 5 },
    { first: 5, last: 5 }
  ])
    assertRefused(list, { ...args, ...page }, MIXED);
  for (const page of [
    { last: 5 },
    { last: 5, before: null },
    { before: '' },
    { last: 5, before: '' }
  ])
    assertRefused(list, { ...args, ...page }, NO_BEFORE);

  // A cursor the list could have written is passed on as it is, for the page after it or before
  // it. An empty cursor is no cursor, as it is to the pagination library.
  assert.strictEqual(optionsFor(list, { ...args, first: 5, after: position }).after, position);
  assert.strictEqual(optionsFor(list, { ...args, last: 5, before: position }).before, position);
  for (const page of [{ after: '' }, { after: null }, { last: 5, before: position, after: '' }])
    optionsFor(list, { ...args, ...page });

  // Any other cursor is refused, for either page, before any query is made: text that is not
  // base64 JSON, JSON that is not an array, arrays of the wrong length or holding arrays, and
  // arrays with a value that is not of its field's kind.
  const json = (text) => Buffer.from(text).toString('base64');
  const others = [
    'not-base64!!',
    ' ',
    json('[1,'),
    json('undefined'),
    Buffer.from(JSON.stringify(values)).toString('hex'),
    encode(null),
    encode(values[0]),
    encode({ length: values.length, ...values }),
    encode([values]),
    encode(values.map((value) => [value])),
    encode([]),
    encode(values.slice(0, -1)),
    encode([...values, values.at(-1)])
  ];
  kinds.forEach((kind, index) => {
    for (const value of notOfKind[kind]) others.push(encode(values.with(index, value)));
  });
  for (const cursor of others) {
    assertRefused(list, { ...args, first: 5, after: cursor }, INVALID_CURSOR);
    assertRefused(list, { ...args, last: 5, before: cursor }, INVALID_CURSOR);
  }
}

// With the pagination library the models use, the cursors it writes for a list's rows are
// accepted for that list's pages after and before them.
const require = createRequire(new URL('../../scbl-lib/db/models/ban.js', import.meta.url));
const { withRelayPagination } = require('@thomas-smyth/sequelize-cursor-pagination');
const rows = new Map([
  [Ban, { id: banID, created: new Date(date) }],
  [
    SteamUser,
    {
      id: steamID,
      reputationRank: 12,
      reputationPointsMonthChange: 6,
      lastViewed: new Date('2026-10-02T08:00:00.000Z')
    }
  ]
]);
const queries = [];
for (const [model, row] of rows) {
  model.findAll = async (options) => {
    queries.push(options);
    return [{ ...row }];
  };
  withRelayPagination({ primaryKeyField: 'id' })(model);
}
for (const { list, args } of sorted) {
  const { edges } = await list.resolve({ ...args, first: 1 });
  assert.strictEqual(edges.length, 1);
  const { cursor } = edges[0];
  queries.length = 0;
  await list.resolve({ ...args, first: 1, after: cursor });
  await list.resolve({ ...args, last: 1, before: cursor });
  assert.strictEqual(queries.length, 2, `${list.name} ${JSON.stringify(args)}`);
}

// The schema's description of each list's orderBy names the orders it accepts.
function orderByDescription(typeDefs, type, field) {
  const fields = typeDefs.definitions.find((node) => node.name.value === type).fields;
  const { arguments: args } = fields.find((node) => node.name.value === field);
  return args.find((node) => node.name.value === 'orderBy').description.value;
}
for (const [typeDefs, type, list] of [
  [queryTypeDefs, 'Query', bans],
  [queryTypeDefs, 'Query', steamUsers],
  [steamUserTypeDefs, 'SteamUser', playerBans]
]) {
  const description = orderByDescription(typeDefs, type, list.name.split('.').at(-1));
  for (const name of list.orders) assert.match(description, new RegExp(`\\b${name}\\b`), list.name);
}

console.log(
  'List order checks passed: sort orders, filters, page directions, cursors and descriptions.'
);
