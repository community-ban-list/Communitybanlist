import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import graphql from 'graphql';

// Check how the website treats paused ban lists, whose bans count for nothing, without a database:
// it reads them at most every 10 seconds for all requests, leaves them and their bans out of its
// lists of ban lists and bans, keeps their bans on players' pages, marked, and says which bans and
// lists are paused.

// Load a module in its own context, with its package imports replaced by stubs. Relative imports
// load the real files.
async function load(path, stubs) {
  const context = vm.createContext({});
  const linker = async (specifier, referencingModule) => {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(url, 'utf8'), {
        identifier: url.href,
        context
      });
    }
    const exports = stubs[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  };
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    identifier: url.href,
    context
  });
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

// The paused lists' rows, how often they were read, and an error for the next read to fail with.
let rows = [];
let reads = 0;
let failWith = null;
const suspensions = {
  async readPausedBanLists() {
    reads++;
    if (failWith) throw failWith;
    return rows.map((row) => ({ ...row }));
  },
  pausedSets: (given) => ({
    suspended: given.filter(({ resumedAt }) => resumedAt === null).map(({ banList }) => banList),
    excluded: given.map(({ banList }) => banList)
  })
};

const { default: pausedBanLists, MAX_AGE } = await load('../src/paused-ban-lists.js', {
  'scbl-lib/db/ban-list-suspensions': suspensions
});
const ids = (set) => [...set].sort((a, b) => a - b);

// The paused lists, suspended or resuming, are read once for every request within 10 seconds, and
// again after that.
assert.strictEqual(MAX_AGE, 10 * 1000);
rows = [
  { banList: 7, resumedAt: null },
  { banList: 46, resumedAt: new Date('2026-10-29T12:00:00.000Z') }
];
assert.deepStrictEqual(ids(await pausedBanLists(1000)), [7, 46]);
rows = [];
assert.deepStrictEqual(ids(await pausedBanLists(1000 + MAX_AGE - 1)), [7, 46]);
assert.strictEqual(reads, 1);
assert.deepStrictEqual(ids(await pausedBanLists(1000 + MAX_AGE)), []);
assert.strictEqual(reads, 2);
// A clock that went back reads them again, as does the next request after a read that failed.
await pausedBanLists(500);
assert.strictEqual(reads, 3);
failWith = new Error('connect ECONNREFUSED');
await assert.rejects(pausedBanLists(500 + MAX_AGE), { message: 'connect ECONNREFUSED' });
failWith = null;
rows = [{ banList: 9, resumedAt: null }];
assert.deepStrictEqual(ids(await pausedBanLists(500 + MAX_AGE)), [9]);
assert.strictEqual(reads, 5);

// The resolvers, with stand-ins for the models that record what they are asked, and an Op whose
// notIn can be told apart.
const calls = [];
const Op = { ne: Symbol('ne'), gt: Symbol('gt'), notIn: Symbol('notIn') };
const banLists = [
  { id: 3, name: 'A', organisation: 1 },
  { id: 7, name: 'B', organisation: 1 },
  { id: 46, name: 'C', organisation: 2 }
];
const models = {
  Ban: {
    paginate(options) {
      calls.push({ model: 'Ban', options });
      return { edges: [], pageInfo: {} };
    }
  },
  BanList: {
    async findAll(options) {
      calls.push({ model: 'BanList', options });
      return banLists.filter(
        (banList) => !options.where || banList.organisation === options.where.organisation
      );
    },
    findByPk: async () => null
  },
  ExportBanList: {},
  Organisation: { findByPk: async () => null },
  SteamUser: {}
};
const stubs = {
  graphql: { default: graphql },
  'scbl-lib/db/models': models,
  'scbl-lib/db/sequelize': { Op },
  'scbl-lib/utils': { calculateRiskRating() {} }
};
const { default: query } = await load('../src/graphql-api/query/resolver.js', stubs);
const { default: organisation } = await load('../src/graphql-api/organisation/resolver.js', stubs);
const { default: banList } = await load('../src/graphql-api/ban-list/resolver.js', stubs);
const { default: steamUser } = await load('../src/graphql-api/steam-user/resolver.js', stubs);

const context = { user: null, paused: new Set([7, 46]) };
const none = { user: null, paused: new Set() };

// The list of bans leaves out the bans of paused lists, keeping its order and the rows it leaves
// out for its order, and without paused lists it is as before.
calls.length = 0;
await query.Query.bans(null, { first: 10 }, context);
const [{ options }] = calls;
// Made in the resolver's context, so copied into this one to compare.
assert.deepStrictEqual(Reflect.ownKeys(options.where.banList), [Op.notIn]);
assert.deepStrictEqual([...options.where.banList[Op.notIn]], [7, 46]);
assert.deepStrictEqual(Reflect.ownKeys(options.where.created), [Op.ne]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(options.order)), [['created', 'DESC']]);
calls.length = 0;
await query.Query.bans(null, { first: 10 }, none);
assert.ok(!Object.hasOwn(calls[0].options.where, 'banList'));
calls.length = 0;
await query.Query.bans(null, { first: 10 });
assert.ok(!Object.hasOwn(calls[0].options.where, 'banList'));

// The lists of ban lists leave out paused lists, all of them and an organisation's.
assert.deepStrictEqual(
  (await query.Query.banLists(null, {}, context)).map(({ id }) => id),
  [3]
);
assert.deepStrictEqual(
  (await query.Query.banLists(null, {}, none)).map(({ id }) => id),
  [3, 7, 46]
);
assert.deepStrictEqual(
  (await organisation.Organisation.banLists({ id: 1 }, {}, context)).map(({ id }) => id),
  [3]
);
assert.deepStrictEqual(
  (await organisation.Organisation.banLists({ id: 2 }, {}, none)).map(({ id }) => id),
  [46]
);

// A player's own page keeps the bans of paused lists, each of which says whether it is paused, as
// does a paused list.
const pageOf = (...lists) => ({
  edges: lists.map((list, index) => ({
    cursor: String(index),
    node: { id: `b${index}`, banList: list }
  })),
  pageInfo: {}
});
models.Ban.paginate = (options) => {
  calls.push({ model: 'Ban', options });
  return pageOf(7, 3, 46);
};
calls.length = 0;
let page = await steamUser.SteamUser.bans({ id: '76561198000000001' }, { first: 10 }, context);
assert.ok(!Object.hasOwn(calls[0].options.where, 'banList'));
assert.deepStrictEqual(
  page.edges.map(({ node }) => node.paused),
  [true, false, true]
);
page = await steamUser.SteamUser.bans({ id: '76561198000000001' }, { first: 10 }, {});
assert.deepStrictEqual(
  page.edges.map(({ node }) => node.paused),
  [false, false, false]
);
assert.strictEqual(banList.BanList.paused({ id: 46 }, {}, context), true);
assert.strictEqual(banList.BanList.paused({ id: 46 }, {}, none), false);

console.log(
  "Paused ban list checks passed: read once every 10 seconds, left out of the lists of bans and ban lists, and kept, marked, on players' pages."
);
