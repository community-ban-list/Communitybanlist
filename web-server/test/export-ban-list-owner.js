import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import graphql from 'graphql';

const context = vm.createContext({});

// Load a resolver with its package imports replaced by stubs. Relative imports load the real files.
async function load(path, stubs) {
  const linker = async (specifier, referencingModule) => {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(url, 'utf8'), {
        context,
        identifier: url.href
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
    context,
    identifier: url.href
  });
  await module.link(linker);
  await module.evaluate();
  return module.namespace.default;
}

const lists = [
  { id: 7, owner: 'owner' },
  { id: 8, owner: 'other' }
];
const queries = [];
const ExportBanList = {
  async findOne({ where }) {
    queries.push(where);
    return lists.find((list) => list.id === where.id && list.owner === where.owner) || null;
  },
  async findAll({ where }) {
    queries.push(where);
    return lists.filter((list) => list.owner === where.owner);
  }
};

const { SteamUser } = await load('../src/graphql-api/steam-user/resolver.js', {
  graphql: { default: graphql },
  'scbl-lib/db/models': { Ban: {}, ExportBanList },
  'scbl-lib/db/sequelize': { Op: { ne: Symbol('ne'), gt: Symbol('gt') } },
  'scbl-lib/utils': { calculateRiskRating() {} }
});
const { ExportBanList: ExportBanListFields } = await load(
  '../src/graphql-api/export-ban-list/resolver.js',
  { 'scbl-lib/db/models': { ExportBanListConfig: {} } }
);

const owner = { user: { id: 'owner' } };
const other = { user: { id: 'other' } };
const anonymous = { user: null };
const ownerProfile = { id: 'owner' };

// The owner sees their own lists, and only their own.
assert.strictEqual(await SteamUser.exportBanList(ownerProfile, { id: 7 }, owner), lists[0]);
// The query object comes from the module's own context, so copy it before comparing.
assert.deepStrictEqual({ ...queries.pop() }, { id: 7, owner: 'owner' });
assert.strictEqual(await SteamUser.exportBanList(ownerProfile, { id: 8 }, owner), null);
assert.deepStrictEqual(await SteamUser.exportBanLists(ownerProfile, {}, owner), [lists[0]]);

// Anyone else, signed in or not, sees none of them and causes no lookups.
queries.length = 0;
for (const viewer of [other, anonymous, { user: {} }]) {
  assert.strictEqual(await SteamUser.exportBanList(ownerProfile, { id: 7 }, viewer), null);
  assert.strictEqual((await SteamUser.exportBanLists(ownerProfile, {}, viewer)).length, 0);
}
assert.strictEqual(queries.length, 0);

// The webhook and invite are only shown to the list's owner, whichever way the list was reached.
const list = { owner: 'owner', discordWebhook: 'webhook', battlemetricsInvite: 'invite' };
assert.strictEqual(ExportBanListFields.discordWebhook(list, {}, owner), 'webhook');
assert.strictEqual(ExportBanListFields.battlemetricsInvite(list, {}, owner), 'invite');
for (const viewer of [other, anonymous, { user: {} }]) {
  assert.strictEqual(ExportBanListFields.discordWebhook(list, {}, viewer), null);
  assert.strictEqual(ExportBanListFields.battlemetricsInvite(list, {}, viewer), null);
}
const ownerless = { discordWebhook: 'webhook', battlemetricsInvite: 'invite' };
assert.strictEqual(ExportBanListFields.discordWebhook(ownerless, {}, anonymous), null);
assert.strictEqual(ExportBanListFields.battlemetricsInvite(ownerless, {}, { user: {} }), null);

console.log('Export ban list privacy checks passed: owner, other users, and signed-out visitors.');
