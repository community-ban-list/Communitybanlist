import assert from 'assert';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import vm from 'vm';

import graphql from 'graphql';

import { PAGE_SIZE, largestPage, pageArgs } from '../src/graphql-api/core/page-size.js';

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
const models = { Ban, BanList: {}, ExportBanList: {}, Organisation: {}, SteamUser };

const { Query } = await load('../src/graphql-api/query/resolver.js', {
  graphql: { default: graphql },
  'scbl-lib/db/models': models,
  'scbl-lib/db/sequelize': { Op },
  'scbl-lib/utils': { describeError: String }
});
const { SteamUser: SteamUserFields } = await load('../src/graphql-api/steam-user/resolver.js', {
  graphql: { default: graphql },
  'scbl-lib/db/models': models,
  'scbl-lib/db/sequelize': { Op },
  'scbl-lib/utils': { calculateRiskRating() {} }
});

const player = { id: '76561198000000001' };
const bans = { name: 'bans', model: 'Ban', resolve: (args) => Query.bans(null, args) };
const steamUsers = {
  name: 'steamUsers',
  model: 'SteamUser',
  resolve: (args) => Query.steamUsers(null, args)
};
const playerBans = {
  name: 'SteamUser.bans',
  model: 'Ban',
  resolve: (args) => SteamUserFields.bans(player, args)
};

// Cursors as the library writes them, for each list's default order.
const cursor = (...values) => Buffer.from(JSON.stringify(values)).toString('base64');
const created = cursor('2024-01-01T00:00:00.000Z', '1,1');
const cursors = new Map([
  [bans, created],
  [steamUsers, cursor(player.id)],
  [playerBans, created]
]);

// The options a list passes to paginate for these arguments.
function optionsFor(list, args) {
  calls.length = 0;
  list.resolve(args);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, list.model);
  return calls[0].options;
}

// The page arguments among these options, leaving out those that are not set.
const pageOf = (options) =>
  Object.fromEntries(
    ['first', 'after', 'last', 'before']
      .filter((name) => options[name] !== undefined)
      .map((name) => [name, options[name]])
  );
const pageFor = (list, args) => pageOf(optionsFor(list, args));

// The ban and player lists return 20 rows when a request does not say how many, and 1 to 100 rows
// when it does. The sizes the site's pages ask for, 20 and 12, are kept.
for (const list of [bans, steamUsers]) {
  for (const [args, first] of [
    [{}, 20],
    [{ first: null }, 20],
    [{ first: 0 }, 1],
    [{ first: -5 }, 1],
    [{ first: 1 }, 1],
    [{ first: 12 }, 12],
    [{ first: 20 }, 20],
    [{ first: 100 }, 100],
    [{ first: 101 }, 100],
    [{ first: 200000 }, 100],
    [{ first: 2147483647 }, 100]
  ])
    assert.deepStrictEqual(pageFor(list, args), { first }, `${list.name} ${JSON.stringify(args)}`);

  // The page after a cursor has the same sizes, as does the page before one.
  const next = { after: cursors.get(list) };
  const previous = { before: cursors.get(list) };
  assert.deepStrictEqual(pageFor(list, next), { first: 20, ...next });
  assert.deepStrictEqual(pageFor(list, { first: 12, ...next }), { first: 12, ...next });
  assert.deepStrictEqual(pageFor(list, previous), { last: 20, ...previous });
  assert.deepStrictEqual(pageFor(list, { last: null, ...previous }), { last: 20, ...previous });
  assert.deepStrictEqual(pageFor(list, { last: 12, ...previous }), { last: 12, ...previous });
  assert.deepStrictEqual(pageFor(list, { last: 500, ...previous }), { last: 100, ...previous });
  assert.deepStrictEqual(pageFor(list, { last: 0, ...previous }), { last: 1, ...previous });
}

// The lists refuse requests that mix both directions or ask for the last rows with no cursor to
// end before (see core/list-order.js). Their page arguments still pass them on for paginate to
// refuse, with the number of last rows set as above.
assert.deepStrictEqual(pageOf(pageArgs({ first: 5, before: created }, PAGE_SIZE.list)), {
  first: 5,
  last: 20,
  before: created
});
assert.deepStrictEqual(pageOf(pageArgs({ last: 5, after: created }, PAGE_SIZE.list)), {
  last: 5,
  after: created
});
assert.deepStrictEqual(pageOf(pageArgs({ last: 5 }, PAGE_SIZE.list)), { last: 5 });
assert.deepStrictEqual(pageOf(pageArgs({ last: 0 }, PAGE_SIZE.list)), { last: 1 });

// A player's bans come PAGE_SIZE.playerBans to a page when a request does not say how many, as
// the profile and banned pages show all of a player's bans without asking for more. No page holds
// more than the larger of that and 100. These checks follow the setting, so it can be raised to
// show more of a player's bans without changing them.
const playerPage = Math.max(PAGE_SIZE.max, PAGE_SIZE.playerBans);
for (const [args, page] of [
  [{}, { first: PAGE_SIZE.playerBans }],
  [{ first: null }, { first: PAGE_SIZE.playerBans }],
  [{ first: 0 }, { first: 1 }],
  [{ first: 20 }, { first: 20 }],
  [{ first: 200000 }, { first: playerPage }],
  [{ before: created }, { last: PAGE_SIZE.playerBans, before: created }],
  [
    { last: 200000, before: created },
    { last: playerPage, before: created }
  ]
])
  assert.deepStrictEqual(pageFor(playerBans, args), page, `SteamUser.bans ${JSON.stringify(args)}`);

// A list's largest page is 100 rows, or its default when that is larger, as a player's bans would
// be with a larger PAGE_SIZE.playerBans. Such a list has pages of up to its default.
const larger = PAGE_SIZE.max + 50;
assert.strictEqual(largestPage(PAGE_SIZE.list), 100);
assert.strictEqual(largestPage(larger), larger);
assert.deepStrictEqual(pageOf(pageArgs({}, larger)), { first: larger });
assert.deepStrictEqual(pageOf(pageArgs({ first: 200000 }, larger)), { first: larger });
assert.deepStrictEqual(pageOf(pageArgs({ first: 20 }, larger)), { first: 20 });
assert.deepStrictEqual(pageOf(pageArgs({ before: 'previous-cursor' }, larger)), {
  last: larger,
  before: 'previous-cursor'
});

// The lists are sorted and filtered as core/list-order.js says: a player's bans are only theirs,
// and only the active or expired ones when asked; bans need a date; the most harmful players are
// only those with a rank; and this month's most harmful players are those with a rank whose points
// rose, sorted by rank when their points rose by the same amount.
const dated = { created: { [Op.ne]: null } };
for (const [args, where] of [
  [{}, { ...dated, steamUser: player.id }],
  [{ expired: false }, { ...dated, steamUser: player.id, expired: false }],
  [{ expired: true }, { ...dated, steamUser: player.id, expired: true }]
]) {
  const options = optionsFor(playerBans, { orderBy: 'created', orderDirection: 'DESC', ...args });
  assert.deepStrictEqual(options.order, [['created', 'DESC']]);
  assert.deepStrictEqual(options.where, where);
}
assert.deepStrictEqual(optionsFor(bans, {}).order, [['created', 'DESC']]);
assert.deepStrictEqual(optionsFor(bans, {}).where, dated);
assert.deepStrictEqual(optionsFor(steamUsers, {}).order, [['id', 'DESC']]);
assert.strictEqual(optionsFor(steamUsers, {}).where, undefined);
const ranked = optionsFor(steamUsers, { orderBy: 'reputationRank', orderDirection: 'ASC' });
assert.deepStrictEqual(ranked.order, [['reputationRank', 'ASC']]);
assert.deepStrictEqual(ranked.where, { reputationRank: { [Op.ne]: null } });
const rising = optionsFor(steamUsers, {
  orderBy: 'reputationPointsMonthChange',
  orderDirection: 'DESC'
});
assert.deepStrictEqual(rising.order, [
  ['reputationPointsMonthChange', 'DESC'],
  ['reputationRank', 'ASC']
]);
assert.deepStrictEqual(rising.where, {
  reputationPointsMonthChange: { [Op.gt]: 0 },
  reputationRank: { [Op.ne]: null }
});

// With the pagination library the models use, which fetches one row more than a page to tell
// whether there is another, every query a list makes is limited to between 2 rows and one more
// than its largest page, 101 for the ban and player lists, whatever page arguments the request
// gives. Only requests for a page before a cursor can be refused.
const require = createRequire(new URL('../../scbl-lib/db/models/ban.js', import.meta.url));
const { withRelayPagination } = require('@thomas-smyth/sequelize-cursor-pagination');
const queries = [];
for (const model of [Ban, SteamUser]) {
  model.findAll = async (options) => {
    queries.push(options);
    return [];
  };
  withRelayPagination({ primaryKeyField: 'id' })(model);
}
async function limitFor(list, args) {
  queries.length = 0;
  await list.resolve(args);
  assert.strictEqual(queries.length, 1);
  return queries[0].limit;
}

assert.strictEqual(await limitFor(steamUsers, {}), 21);
assert.strictEqual(await limitFor(steamUsers, { first: 200000 }), 101);
assert.strictEqual(await limitFor(bans, { first: 0 }), 2);
assert.strictEqual(await limitFor(bans, { before: created }), 21);
assert.strictEqual(await limitFor(playerBans, {}), PAGE_SIZE.playerBans + 1);

// Check that a request's query is limited, or that it was refused as a request for the page before
// a cursor that paginate does not support. Arguments set to undefined are left out, as GraphQL
// leaves out those a request does not give.
async function checkLimited(list, page) {
  const args = Object.fromEntries(Object.entries(page).filter(([, value]) => value !== undefined));
  const request = `${list.name} ${JSON.stringify(args)}`;
  let limit;
  try {
    limit = await limitFor(list, args);
  } catch (error) {
    assert.ok(args.last != null || args.before != null, `${request} was refused`);
    assert.strictEqual(error.extensions?.code, 'BAD_USER_INPUT', request);
    assert.match(error.message, /^Use (first and after, or last and before|last with a)/, request);
    return;
  }
  const largest = list === playerBans ? playerPage : 100;
  assert.ok(Number.isInteger(limit) && limit >= 2 && limit <= largest + 1, `${request}: ${limit}`);
}

// The same holds for every combination of these page arguments.
const sizes = [undefined, null, -1, 0, 1, 12, 20, 100, 101, 200000];
for (const [list, position] of cursors)
  for (const first of sizes)
    for (const last of sizes)
      for (const after of [undefined, null, '', position])
        for (const before of [undefined, null, '', position])
          await checkLimited(list, { first, last, after, before });

console.log(
  'GraphQL page size checks passed: defaults, limits, cursors, sort orders and the queries made.'
);
