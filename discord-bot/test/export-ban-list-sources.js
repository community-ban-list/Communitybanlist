import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

// Run the bot's commands without Discord, the database or BattleMetrics. Package imports are
// replaced by the stand-ins below, and relative imports load the real files, once each, as Node
// would. The modules run in this test's own context, so their errors and objects compare directly.
const loaded = new Map();
function moduleAt(url) {
  if (!loaded.has(url))
    loaded.set(
      url,
      readFile(new URL(url), 'utf8').then(
        (source) => new vm.SourceTextModule(source, { identifier: url })
      )
    );
  return loaded.get(url);
}
function linker(specifier, referencingModule) {
  if (specifier.startsWith('.'))
    return moduleAt(new URL(specifier, referencingModule.identifier).href);

  const exports = stubs[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
}
async function load(path) {
  const module = await moduleAt(new URL(path, import.meta.url).href);
  if (module.status === 'unlinked') await module.link(linker);
  if (module.status === 'linked') await module.evaluate();
  return module.namespace;
}

// Made-up BattleMetrics ban list IDs.
const EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000aa';
const OTHER_EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000bb';
const PARTNER_ID = 'facade00-ba5e-4b00-a000-0000000000cc';
const NEW_PARTNER_ID = 'facade00-ba5e-4b00-a000-0000000000dd';
const OTHER_PARTNER_ID = 'facade00-ba5e-4b00-a000-0000000000ee';
const exportLink = `https://www.battlemetrics.com/rcon/ban-lists/${EXPORT_ID}`;

const exportBanLists = [
  { id: 12, battlemetricsID: EXPORT_ID },
  // Remote export ban lists have no BattleMetrics ID.
  { id: 13, battlemetricsID: null },
  // IDs edited by hand: one in capitals with spaces around it, and an empty one.
  { id: 14, battlemetricsID: ` ${OTHER_EXPORT_ID.toUpperCase()}  ` },
  { id: 15, battlemetricsID: '' }
];
const organisation = { id: 3, name: 'Partner Org', discord: null };
const banLists = [
  { id: 5, name: 'Main', type: 'battlemetrics', source: PARTNER_ID },
  // Remote lists saved with a link to an export ban list's page, and with an export ban list's ID.
  { id: 6, name: 'Old', type: 'remote', source: exportLink },
  { id: 7, name: 'Typo', type: 'remote', source: OTHER_EXPORT_ID },
  // A list from before the bot that imports an export ban list.
  { id: 8, name: 'Mirror', type: 'battlemetrics', source: EXPORT_ID }
].map((banList) => ({ ...banList, organisation: organisation.id }));

// Whether a record matches a where clause, as far as these commands' queries go.
const Op = { ne: Symbol('ne') };
function matches(record, where = {}) {
  return Object.entries(where).every(([field, condition]) =>
    condition !== null && typeof condition === 'object' && Op.ne in condition
      ? record[field] !== condition[Op.ne]
      : record[field] === condition
  );
}

const writes = [];
const requests = [];
const audits = [];
let exportLookupError = null;
function banListRecord(values) {
  return {
    ...values,
    Organisation: organisation,
    async save() {
      writes.push(['save', this.id]);
    }
  };
}
const stubs = {
  'discord.js': discord,
  axios: {
    default: {
      create: () => ({
        async get(path) {
          requests.push(path);
          if (path === 'bans') return { data: { data: [{ type: 'ban' }], links: {} } };
          return { data: { data: { attributes: { name: 'Partner bans' } } } };
        }
      })
    }
  },
  'scbl-lib/config': { BATTLEMETRICS_API_KEY: 'test-key' },
  'scbl-lib/db': {
    sequelize: {
      async transaction(callback) {
        writes.push(['transaction']);
        return callback({});
      }
    }
  },
  'scbl-lib/db/models': {
    Ban: {},
    ExportBanListConfig: {},
    BanList: {
      async findOne({ where }) {
        const banList = banLists.find((banList) => matches(banList, where));
        return banList ? banListRecord(banList) : null;
      },
      async findByPk(id) {
        const banList = banLists.find((banList) => String(banList.id) === id);
        return banList ? banListRecord(banList) : null;
      },
      async create(values) {
        writes.push(['create', values.source]);
        const banList = { id: 90 + banLists.length, ...values };
        banLists.push(banList);
        return banListRecord(banList);
      }
    },
    ExportBanList: {
      async findAll({ where }) {
        if (exportLookupError) throw exportLookupError;
        return exportBanLists.filter((exportBanList) => matches(exportBanList, where));
      }
    },
    Organisation: {
      async findByPk(id) {
        return id === String(organisation.id) ? organisation : null;
      },
      async findOne({ where }) {
        return matches(organisation, where) ? organisation : null;
      },
      async create(values) {
        writes.push(['create organisation', values.name]);
        return { id: 4, ...values };
      }
    }
  },
  'scbl-lib/db/sequelize': { Op },
  'scbl-lib/utils': { Logger: { verbose: (...args) => audits.push(args.slice(2).join('')) } }
};

const { default: commands } = await load('../src/commands/index.js');
const { checkBanListSourceUnused, parseBanListSource, UserError } =
  await load('../src/utils/index.js');

async function run(command, subcommand, options) {
  const replies = [];
  await commands.get(command).execute({
    user: { tag: 'admin', id: '1' },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null
    },
    editReply: async (reply) => replies.push(reply)
  });
  return replies;
}
const refusedAsExport = (id) => (err) =>
  err instanceof UserError &&
  err.message.startsWith(
    `That source is one of CBL's own export ban lists (#${id}), not a partner's ban list.`
  );

// A BattleMetrics source naming one of CBL's own export ban lists is refused whatever its case or
// hyphens, as is a link to it, and IDs stored in another case or with spaces still match.
for (const [input, id] of [
  [EXPORT_ID, 12],
  [EXPORT_ID.toUpperCase(), 12],
  [EXPORT_ID.replace(/-/g, ''), 12],
  [` ${exportLink} `, 12],
  [`https://www.battlemetrics.com/rcon/ban-lists/${EXPORT_ID.toUpperCase()}/edit`, 12],
  [OTHER_EXPORT_ID, 14]
]) {
  const source = parseBanListSource('battlemetrics', input);
  await assert.rejects(checkBanListSourceUnused('battlemetrics', source), refusedAsExport(id));
}
await assert.rejects(
  checkBanListSourceUnused('battlemetrics', EXPORT_ID),
  /Importing it would feed the players CBL exports back in as new bans\.$/
);

// Other sources are only checked for duplicates. The empty stored ID matches nothing, not even a
// source made of hyphens, and remote sources are never export ban lists.
await assert.rejects(
  checkBanListSourceUnused('battlemetrics', PARTNER_ID),
  /already used by \*\*Partner Org\*\* \/ \*\*Main\*\* \(#5\)/
);
await checkBanListSourceUnused('battlemetrics', PARTNER_ID, { id: 5 });
await checkBanListSourceUnused('battlemetrics', NEW_PARTNER_ID);
await checkBanListSourceUnused('battlemetrics', '-');
await checkBanListSourceUnused('remote', `https://example.com/${EXPORT_ID}.txt`);

// Every command that sets a BattleMetrics source refuses an export ban list, with or without
// skip_check, before saving anything or making a request. The export ban list is named even when a
// list from before the bot already uses the same source.
for (const skipCheck of [true, null]) {
  const options = { type: 'battlemetrics', skip_check: skipCheck };
  await assert.rejects(
    run('banlist', 'add', { ...options, organisation: '3', name: 'New', source: EXPORT_ID }),
    refusedAsExport(12)
  );
  await assert.rejects(
    run('banlist', 'update', { banlist: '5', source: exportLink, skip_check: skipCheck }),
    refusedAsExport(12)
  );
  // Changing only the type reads the stored source as a BattleMetrics ID, whether that turns a
  // link into an ID or leaves the source as it was.
  await assert.rejects(
    run('banlist', 'update', { banlist: '6', type: 'battlemetrics', skip_check: skipCheck }),
    refusedAsExport(12)
  );
  await assert.rejects(
    run('banlist', 'update', { banlist: '7', type: 'battlemetrics', skip_check: skipCheck }),
    refusedAsExport(14)
  );
  await assert.rejects(
    run('org', 'add', {
      ...options,
      name: 'New Org',
      banlist_name: 'Main',
      source: OTHER_EXPORT_ID.toUpperCase()
    }),
    refusedAsExport(14)
  );
}
assert.deepStrictEqual(writes, []);
assert.deepStrictEqual(requests, []);
assert.deepStrictEqual(audits, []);

// If the export ban lists cannot be read, nothing is added.
exportLookupError = new Error('Database unavailable');
await assert.rejects(
  run('banlist', 'add', {
    organisation: '3',
    name: 'New',
    type: 'battlemetrics',
    source: NEW_PARTNER_ID,
    skip_check: true
  }),
  (err) => err === exportLookupError
);
exportLookupError = null;
assert.deepStrictEqual(writes, []);

// Partner ban lists are still added, test fetched unless skip_check is set, and a list that already
// imports an export ban list can still be renamed, as its source is not changed.
const partner = { organisation: '3', type: 'battlemetrics' };
const [skipped] = await run('banlist', 'add', {
  ...partner,
  name: 'Second',
  source: NEW_PARTNER_ID,
  skip_check: true
});
assert.match(skipped.content, /^Added .* Skipped checking the source\./);
assert.deepStrictEqual(requests, []);
const [fetched] = await run('banlist', 'add', {
  ...partner,
  name: 'Third',
  source: OTHER_PARTNER_ID
});
assert.match(fetched.content, /Found 1 ban on the BattleMetrics ban list "Partner bans"\./);
assert.deepStrictEqual(requests, ['bans', `ban-lists/${OTHER_PARTNER_ID}`]);
await run('banlist', 'update', { banlist: '8', name: 'Mirror (to remove)' });
assert.deepStrictEqual(writes, [
  ['create', NEW_PARTNER_ID],
  ['create', OTHER_PARTNER_ID],
  ['save', 8]
]);
assert.strictEqual(audits.length, 3);

console.log(
  "Export ban list source checks passed: IDs, links, each command, skip_check and partners' lists."
);
