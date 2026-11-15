import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

import * as playerIDs from '../../scbl-lib/player-ids.js';
import sourceKey from '../../scbl-lib/utils/ban-list-source-key.js';
import isSameBattlemetricsID, {
  normaliseBattlemetricsID
} from '../../scbl-lib/utils/battlemetrics-id.js';
import logText from '../../scbl-lib/utils/log-text.js';

// Run the bot's commands without Discord, the database or BattleMetrics. Package imports are
// replaced by the stand-ins below, and relative imports load the real files, once each, as Node
// would. The modules run in this test's own context, so their errors and objects compare directly.
// The IDs are compared with scbl-lib's real comparison, which the ban importer shares.
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
// BattleMetrics requests: each one's path, and its parameters, or null without any.
const requests = [];
const requestParams = [];
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
// What a remote ban list's host answers with, and BattleMetrics, for a ban list's first page of
// bans, and for the ban lists the CBL organisation can see, which an error fails, how many times
// those were read, and the time limit each read had.
let remoteFile = '';
let battlemetricsBans = { data: [{ type: 'ban' }], links: {} };
let visibleBanLists = [PARTNER_ID, NEW_PARTNER_ID, OTHER_PARTNER_ID];
let visibleError = null;
let visibleReads = 0;
const visibleSignals = [];
// The ban lists the CBL organisation can see are given this many to a page, each page linking to
// the next unless nextLink gives another link for a page, by its index. hold, if set, is called
// with each request's path and config, and the request waits for what it returns.
let visiblePageSize = 3;
let nextLink = () => undefined;
let hold = null;
// The time limits AbortSignal.timeout gives, each with its time and the controller that ends it, so
// a check can end one without waiting for it. The modules run in this test's context, so they get
// these.
const timeLimits = [];
AbortSignal.timeout = (ms) => {
  const controller = new AbortController();
  timeLimits.push({ ms, controller });
  return controller.signal;
};
function readVisible(params) {
  if (visibleError) throw visibleError;
  // A read that went round in circles would end only at its time limit, which never ends here.
  assert.ok(visibleReads <= 20, 'The ban lists were read in circles');
  const index = Number(params['page[key]'] ?? 0);
  const page = visibleBanLists.slice(index * visiblePageSize, (index + 1) * visiblePageSize);
  const last = (index + 1) * visiblePageSize >= visibleBanLists.length;
  const next =
    nextLink(index) ??
    (last
      ? null
      : `https://api.battlemetrics.com/ban-lists?page%5Bkey%5D=${index + 1}&page%5Bsize%5D=100`);
  return {
    data: { data: page.map((id) => ({ type: 'banList', id })), links: next ? { next } : {} }
  };
}
const stubs = {
  'discord.js': discord,
  axios: {
    default: {
      get: async () => ({ data: remoteFile }),
      create: () => ({
        async get(path, config) {
          requests.push(path);
          requestParams.push(config?.params ?? null);
          await hold?.(path, config);
          if (path === 'bans') return { data: battlemetricsBans };
          if (path === 'ban-lists') {
            visibleReads++;
            visibleSignals.push(config?.signal);
            return readVisible(config.params);
          }
          return { data: { data: { attributes: { name: 'Partner bans' } } } };
        }
      })
    }
  },
  'scbl-lib/config': { BATTLEMETRICS_API_KEY: 'test-key' },
  'scbl-lib/player-ids': playerIDs,
  'scbl-lib/db': {
    sequelize: {
      async transaction(callback) {
        writes.push(['transaction']);
        return callback({});
      }
    },
    // The importer is not running, so ban list changes go ahead.
    async isRunLockHeld() {
      return false;
    }
  },
  'scbl-lib/db/models': {
    // No ban list here has bans to count.
    Ban: {
      async count() {
        return [];
      }
    },
    ExportBanListConfig: {},
    BanList: {
      // An organisation's ban lists, for the reply that shows it.
      async findAll({ where }) {
        return banLists.filter((banList) => matches(banList, where)).map(banListRecord);
      },
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
  // No ban list is paused, and the bot's other commands never change that.
  'scbl-lib/db/ban-list-suspensions': {
    isMissingTable: () => false,
    MAX_REASON_LENGTH: 500,
    readPausedBanLists: async () => [],
    readSettledPausedBanLists: async () => [],
    async resumeBanList() {
      throw new Error('Not expected');
    },
    async suspendBanList() {
      throw new Error('Not expected');
    }
  },
  'scbl-lib/db/importer-models': { BanListSync: {} },
  'scbl-lib/db/sequelize': { Op, QueryTypes: { SELECT: 'SELECT' } },
  'scbl-lib/utils': {
    isSameBattlemetricsID,
    normaliseBattlemetricsID,
    Logger: { verbose: (...args) => audits.push(args.slice(2).join('')) },
    logText,
    sourceKey
  }
};

const { default: commands } = await load('../src/commands/index.js');
const { checkBanListSource, checkBanListSourceUnused, parseBanListSource, UserError } =
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
  // skip_check only skips the test fetch, so a source another ban list uses is still refused.
  await assert.rejects(
    run('banlist', 'add', { ...options, organisation: '3', name: 'New', source: PARTNER_ID }),
    /already used by \*\*Partner Org\*\* \/ \*\*Main\*\* \(#5\)/
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
assert.deepStrictEqual(requests, ['bans', `ban-lists/${OTHER_PARTNER_ID}`, 'ban-lists']);
// The test fetch asks for the list's bans as the importer does, 100 to a page and its expired ones
// too, as BattleMetrics' API documentation says it hides them without filter[expired]. The list's
// name needs no parameters, and the ban lists the CBL organisation can see are read 100 to a page,
// as the importer reads them.
assert.deepStrictEqual(requestParams, [
  { 'filter[banList]': OTHER_PARTNER_ID, 'filter[expired]': 'true', 'page[size]': 100 },
  null,
  { 'page[size]': '100' }
]);
await run('banlist', 'update', { banlist: '8', name: 'Mirror (to remove)' });
// Updates save in a transaction, which would also delete the old bans if the source changed.
assert.deepStrictEqual(writes, [
  ['create', NEW_PARTNER_ID],
  ['create', OTHER_PARTNER_ID],
  ['transaction'],
  ['save', 8]
]);
assert.strictEqual(audits.length, 3);
// The test fetch also asked BattleMetrics which ban lists the CBL organisation can see, which it
// lists among them, so nothing more was said. skip_check asks nothing.
assert.strictEqual(visibleReads, 1);

const refusedWith = (message) => (err) => {
  assert.ok(err instanceof UserError, String(err));
  assert.strictEqual(err.message, message);
  return true;
};

// A BattleMetrics list that gives no bans but still counts some is one CBL may see but not its
// bans, which the ban importer fails as one CBL cannot read, so the check refuses it in the
// importer's words, without suggesting skip_check. So is one that gives no count, which the
// importer, with its count check on, as by default, fails as it cannot check that its read got
// every ban. Only one that counts none is empty, which skip_check saves.
const UNLISTED_ID = 'facade00-ba5e-4b00-a000-0000000000ff';
battlemetricsBans = { data: [], links: {}, meta: { active: 100, expired: 150, total: 250 } };
await assert.rejects(
  checkBanListSource('battlemetrics', UNLISTED_ID),
  refusedWith(
    'BattleMetrics counts 250 bans on the list but gave none of them, so CBL may not be allowed to see its bans, and the ban importer would fail to import it.'
  )
);
for (const meta of [undefined, {}, { total: 'many' }, { total: -1 }, { total: 2.5 }]) {
  battlemetricsBans = { data: [], links: {}, meta };
  await assert.rejects(
    checkBanListSource('battlemetrics', UNLISTED_ID),
    refusedWith(
      'BattleMetrics gave no bans on the list and no count of its bans, so it could not be checked that every ban was read, and the ban importer would fail to import it.'
    ),
    JSON.stringify(meta)
  );
}
battlemetricsBans = { data: [], links: {}, meta: { total: 0 } };
await assert.rejects(
  checkBanListSource('battlemetrics', UNLISTED_ID),
  refusedWith(
    "Found no bans on the BattleMetrics ban list. Check the ID and that the CBL BattleMetrics organisation has accepted the list's invite, or use `skip_check` if the list is meant to be empty."
  )
);
battlemetricsBans = { data: [{ type: 'ban' }, { type: 'ban' }], links: { next: 'page 2' } };

// A list that BattleMetrics does not list among the ban lists the CBL organisation can see is
// still saved, with a warning in the importer's words, as the importer saves its new bans but
// removes none of them while BattleMetrics does not list it. The IDs are compared as the importer
// compares them, here one BattleMetrics gives in capitals without hyphens, and a list whose
// visibility could not be checked is saved without a word.
visibleReads = 0;
const UNLISTED =
  'Found 2+ bans on the BattleMetrics ban list "Partner bans". **BattleMetrics does not list it among the ban lists the CBL organisation can see**, so its new bans are saved, but none are removed while BattleMetrics does not list it.';
assert.strictEqual(await checkBanListSource('battlemetrics', UNLISTED_ID), UNLISTED);
visibleBanLists = [UNLISTED_ID.toUpperCase().replace(/-/g, '')];
assert.strictEqual(
  await checkBanListSource('battlemetrics', UNLISTED_ID),
  'Found 2+ bans on the BattleMetrics ban list "Partner bans".'
);
visibleBanLists = [PARTNER_ID];
visibleError = new Error('BattleMetrics GET ban-lists failed: HTTP 503');
assert.strictEqual(
  await checkBanListSource('battlemetrics', UNLISTED_ID),
  'Found 2+ bans on the BattleMetrics ban list "Partner bans".'
);
visibleError = null;
assert.strictEqual(visibleReads, 3);
writes.length = 0;
const [unlisted] = await run('banlist', 'add', {
  ...partner,
  name: 'Unlisted',
  source: UNLISTED_ID
});
assert.strictEqual(
  unlisted.content,
  `Added **Partner Org** / **Unlisted**. ${UNLISTED} Its bans are imported on the next ban importer run.`
);
assert.deepStrictEqual(writes, [['create', UNLISTED_ID]]);

// The ban lists the CBL organisation can see are read a page at a time, each page by the link on
// the one before, as the importer reads them: here the list is on the third page of three, and a
// list on none of them is not listed. Each page is asked for once, and all of them within one time
// limit of 30 seconds.
const LISTED = 'Found 2+ bans on the BattleMetrics ban list "Partner bans".';
const PAGED = [PARTNER_ID, NEW_PARTNER_ID, OTHER_PARTNER_ID, EXPORT_ID, OTHER_EXPORT_ID];
visiblePageSize = 2;
visibleBanLists = [...PAGED, UNLISTED_ID];
const visibleRequests = () => requestParams.filter((params, i) => requests[i] === 'ban-lists');
for (const list of [requests, requestParams, visibleSignals, timeLimits]) list.length = 0;
assert.strictEqual(await checkBanListSource('battlemetrics', UNLISTED_ID), LISTED);
assert.deepStrictEqual(visibleRequests(), [
  { 'page[size]': '100' },
  { 'page[key]': '1', 'page[size]': '100' },
  { 'page[key]': '2', 'page[size]': '100' }
]);
assert.deepStrictEqual(
  timeLimits.map(({ ms }) => ms),
  [30000]
);
assert.ok(visibleSignals.every((signal) => signal === timeLimits[0].controller.signal));
visibleBanLists = PAGED;
assert.strictEqual(await checkBanListSource('battlemetrics', UNLISTED_ID), UNLISTED);
// Only a link to the next page of the same list is followed, and each page once: a link elsewhere,
// or back to a page read already, ends the read as one that could not be made, as does a ban list
// without an ID, as for the importer, and the list is saved without a word.
for (const link of [
  'https://elsewhere.example/ban-lists?page%5Bkey%5D=1&page%5Bsize%5D=100',
  'https://api.battlemetrics.com/bans?page%5Bkey%5D=1&page%5Bsize%5D=100',
  'https://api.battlemetrics.com/ban-lists?page%5Bsize%5D=100'
]) {
  nextLink = (index) => (index === 0 ? link : undefined);
  visibleReads = 0;
  assert.strictEqual(await checkBanListSource('battlemetrics', UNLISTED_ID), LISTED, link);
  assert.strictEqual(visibleReads, 1, link);
}
nextLink = () => undefined;
visibleBanLists = [PARTNER_ID, null, NEW_PARTNER_ID];
assert.strictEqual(await checkBanListSource('battlemetrics', UNLISTED_ID), LISTED);
// A BattleMetrics that does not answer holds the reply up only until the time limit ends, after
// which the list is saved without a word, as one whose visibility could not be checked. The list's
// name is asked for meanwhile, not after.
let answerName;
hold = (path, config) => {
  if (path === 'ban-lists')
    return new Promise((resolve, reject) => {
      config.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
      );
    });
  if (path.startsWith('ban-lists/'))
    return new Promise((resolve) => {
      answerName = resolve;
    });
};
for (const list of [requests, timeLimits]) list.length = 0;
const checking = checkBanListSource('battlemetrics', UNLISTED_ID);
await new Promise(setImmediate);
assert.deepStrictEqual(requests, ['bans', `ban-lists/${UNLISTED_ID}`, 'ban-lists']);
answerName();
timeLimits[0].controller.abort();
assert.strictEqual(await checking, LISTED);
hold = null;
visiblePageSize = 3;
visibleBanLists = [PARTNER_ID, NEW_PARTNER_ID, OTHER_PARTNER_ID];
battlemetricsBans = { data: [{ type: 'ban' }], links: {} };

// A remote list's check counts the bans the ban importer would take from it: not the lines that ban
// an EOS ID, however they end, nor a number that is too long or is not a player's account.
remoteFile = [
  '76561198000000001:0 //Cheating',
  'Admin [SteamID 76561198000000002] Banned:76561198000000003:0 //Banned by an admin',
  '0123456789abcdef0123456789abcdef:0 //An EOS ID',
  `${'a'.repeat(15)}76561198000000004:0 //An EOS ID ending in a SteamID's digits`,
  '176561198000000005:0 //A longer number',
  '12345678901234567:0 //Not an account',
  'Not a ban'
].join('\n');
assert.strictEqual(
  await checkBanListSource('remote', 'https://example.com/bans.txt'),
  'Found 2 bans.'
);
// A remote file with no bans goes by the ban importer's rule. Only a blank one is a list with no
// bans, which skip_check saves. Any other the importer would fail on every cycle, which the check
// says in the importer's words, without suggesting skip_check: one whose only bans are of EOS IDs,
// and anything else, such as an error page or a placeholder.
for (const body of ['', ' \r\n\n', '\uFEFF', undefined]) {
  remoteFile = body;
  await assert.rejects(
    checkBanListSource('remote', 'https://example.com/bans.txt'),
    refusedWith(
      'Fetched the link, but the file is empty. Use `skip_check` if the list is meant to be empty.'
    )
  );
}
const IMPORTER_FAILS =
  'Fetched the link, but the ban importer would fail to import it: The remote ban list has no bans in the `steamID:expiry //reason` format';
for (const [body, lines] of [
  ['0123456789abcdef0123456789abcdef:0 //An EOS ID', '1 line'],
  [
    [
      '0123456789abcdef0123456789abcdef:0 //An EOS ID',
      'Not a ban',
      '0123456789ABCDEF0123456789ABCDE0:4102444800 //Another'
    ].join('\n'),
    '2 lines'
  ]
]) {
  remoteFile = body;
  await assert.rejects(
    checkBanListSource('remote', 'https://example.com/bans.txt'),
    refusedWith(
      `${IMPORTER_FAILS}. It has ${lines} with an EOS ID, which CBL does not import from remote ban lists.`
    )
  );
}
for (const body of ['<html>Not a ban list</html>', '# No bans yet', '{"bans":[]}']) {
  remoteFile = body;
  await assert.rejects(
    checkBanListSource('remote', 'https://example.com/bans.txt'),
    refusedWith(`${IMPORTER_FAILS}, so it may be an error page.`)
  );
}

// The names an admin gives an organisation and its first ban list are kept on one line in the log
// and shown as written (logText), as the website's lines show names, while the reply escapes them
// with bold, once.
audits.length = 0;
const firstID = 90 + banLists.length;
const [oddOrg] = await run('org', 'add', {
  name: 'Odd\n**Org**',
  banlist_name: 'First ||list||\u202e',
  type: 'battlemetrics',
  source: 'facade00-ba5e-4b00-a000-000000000100',
  skip_check: true
});
assert.deepStrictEqual(audits, [
  `admin (1) added organisation "Odd \\*\\*Org\\*\\*" (ID: 4) with ban list "First \\|\\|list\\|\\| " (ID: ${firstID}) and BattleMetrics source "facade00-ba5e-4b00-a000-000000000100".`
]);
assert.ok(
  oddOrg.content.startsWith(
    `Added **${discord.escapeMarkdown('Odd\n**Org**')}** with its ban list **${discord.escapeMarkdown('First ||list||\u202e')}**.`
  )
);

console.log(
  "Export ban list source checks passed: IDs, links, each command, skip_check, partners' lists, hidden bans and lists BattleMetrics does not list for CBL, read a page at a time within one time limit, remote lines and remote files the importer would fail, and names in the log."
);
