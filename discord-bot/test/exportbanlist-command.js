import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

import * as scblUtils from '../../scbl-lib/utils/index.js';

// Run /exportbanlist without Discord, the database or BattleMetrics. Package imports are replaced
// by the stand-ins below, and relative imports load the real files, once each, as Node would, so
// the command, confirm(), audit() and the reply updater are the real ones. The modules run in this
// test's own context, so their errors and objects compare directly.
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

const LIMITS = {
  battlemetrics: { maxPlayers: 20000, minThreshold: 4, neverEnough: 'active-plus-expired' },
  remote: { maxPlayers: 40000, minThreshold: 4, neverEnough: 'active-plus-expired' }
};
const LIMITS_TEXT =
  "Limits used: BattleMetrics lists have at most 20,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough; remote lists have at most 40,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough. They come from the bot's EXPORT_* settings, which must match the website's.";
// What the numbers of players mean while ban lists are paused, which remove_outside_limits says
// after the limits used, here with ban lists 7 and 46 paused, and with 46 alone.
const PAUSED_TEXT =
  "Ban lists #7 and #46 are paused: their bans count for nothing for now. The ban importer leaves them out of export bans, but a count by settings now includes them, as the website's size check does, so that a list's cap holds once they count again. So a list within the cap by its export bans only while they are paused is not counted again, and is left until then.";
const ONE_PAUSED_TEXT =
  "Ban list #46 is paused: its bans count for nothing for now. The ban importer leaves them out of export bans, but a count by settings now includes them, as the website's size check does, so that a list's cap holds once they count again. So a list within the cap by its export bans only while #46 is paused is not counted again, and is left until then.";
// The same for the embed of a list counted again by its settings now, with ban lists 7 and 46
// paused, and for that of a list not counted again, which shows only its export bans.
const PAUSED_FIELD = [
  'Paused ban lists',
  "#7 and #46, whose bans count for nothing for now. The ban importer leaves them out of the list's export bans, but its count by its settings now includes them, as the website's size check does."
];
const PAUSED_UNCOUNTED_FIELD = [
  'Paused ban lists',
  "#7 and #46, whose bans count for nothing for now. The ban importer leaves them out of the list's export bans, and so out of its players here, but the website's size check counts them."
];
// Ban lists 46, suspended, and 7, resuming, whose bans count for nothing until the importer has
// caught up with it, as rows of the importer's table, out of order, as the names are sorted.
const PAUSED_ROWS = [
  { banList: 46, suspendedBy: 'admin', reason: null, resumedAt: null },
  { banList: 7, suspendedBy: 'admin', reason: null, resumedAt: new Date('2026-10-28T12:00:00Z') }
];
const PROGRESS_NOTE =
  'This reply can only be updated for 15 minutes after the command, so each result and the summary also go to the CBL log channel.';
// A message from the website's rules, as checkLimits gives them.
const RULE =
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 6 points (5 for an active ban, plus 1 for an expired ban), so the threshold must be 7 or more. Raise the threshold or lower the points.';

// What the command did: lookups, run lock checks, of which a removal or a transfer makes none, and
// deletions in order, the replies it made, what it logged, and anything that could tell a list's
// owner.
let calls;
let replies;
let audits;
let notifications;

// The database's export ban lists, by ID, each with what checkLimits gives for it. A deletion
// removes the list, unless the list's answer in `deletions` is an error.
let rows;
let deletions;
// Runs as checkLimits finishes, with the IDs it was given, e.g. to change a list while its players
// are counted again. An error in changeErrors for a list fails changeSince for it.
let duringCheck;
let changeErrors;
// The query that loaded each list deleted, in turn, e.g. 'find 12' for findByPk(12), as each query
// gives instances of its own, as Sequelize's do, and for each, the Steam name of the owner the list
// had loaded with it, which ExportBanList's lines name, and whether its lines were to be important.
let deletedFrom;
let deletedWith;
// Answers to isRunLockHeld, in turn: whether a run holds the lock, or an error. Once they run out,
// no run holds it.
let lockAnswers;
// The BattleMetrics ban lists the API key can see, or an error for the listing.
let visible;
// How the admin answers the confirmation: 'confirm', 'cancel' or 'timeout'. Before they answer,
// whileConfirming runs, e.g. to change a list.
let answer;
let whileConfirming;
// How long each confirmation waited for an answer, in milliseconds.
let timeouts;
// CBL's Steam users, as { id, name, isSCBLUser } by Steam ID: those a sign-in or the importer has
// added. isSCBLUser is whether they have signed in to the website.
let steamUsers;
// Runs as an update starts, with the update's values and options, before it writes anything, e.g.
// to change a list in the moment after it was read again, or to make the update wait or fail.
let beforeUpdate;
// The lists whose deletion lock is held, by a deletion on the website or a removal here, and the
// transaction in progress. An error in lockErrors for a list fails taking its deletion lock, as
// when its connection cannot be opened.
let beingDeleted;
let transaction;
let lockErrors;
// The ban lists paused now, as rows of the importer's table, suspended or resuming, and how many
// times they were read.
let pausedRows;
let pausedReads;

function reset() {
  calls = [];
  replies = [];
  audits = [];
  notifications = [];
  rows = new Map();
  deletions = new Map();
  duringCheck = null;
  changeErrors = new Map();
  deletedFrom = [];
  deletedWith = [];
  lockAnswers = [];
  visible = new Set();
  answer = 'confirm';
  whileConfirming = null;
  timeouts = [];
  steamUsers = new Map();
  beforeUpdate = null;
  beingDeleted = new Set();
  transaction = null;
  lockErrors = new Map();
  pausedRows = [];
  pausedReads = 0;
}

// Add a list to the database. Reading its Discord webhook, the only way to tell its owner anything,
// is recorded. recount is what checkLimits gives for a list whose export bans are over its type's
// cap: the players its settings and configs give now, or null for a list not counted again.
// recountError is the error of a count that failed, which fails checkLimits, unless the caller
// keeps such errors.
function addList(
  id,
  type,
  {
    battlemetricsID = null,
    players = 0,
    recount = null,
    recountError = null,
    problems = [RULE],
    ...more
  } = {}
) {
  const exportBanList = {
    id,
    name: `List ${id}`,
    type,
    owner: `765611980000000${id}`,
    battlemetricsID,
    threshold: 5,
    defaultActivePoints: 5,
    defaultExpiredPoints: 1,
    maxBanAge: 0,
    SteamUser: { id: `765611980000000${id}`, name: `Owner ${id}` },
    get discordWebhook() {
      notifications.push(id);
      return 'https://discord.com/api/webhooks/1/token';
    },
    // Like the shared deletion, a list that is removed no longer records its BattleMetrics ban
    // list. The bot only deletes a list while it holds its deletion lock.
    async deleteExportBanList(options) {
      assert.ok(beingDeleted.has(id), 'A list is deleted under its deletion lock.');
      calls.push(['delete', id]);
      deletedFrom.push(this.loadedBy);
      deletedWith.push({
        owner: this.SteamUser?.name ?? null,
        important: options?.important ?? false
      });
      const result = deletions.get(id);
      if (result instanceof Error) throw result;
      rows.delete(id);
      const outcome = result ?? (this.battlemetricsID ? 'deleted' : 'none');
      this.battlemetricsID = null;
      return outcome;
    },
    ...more
  };
  rows.set(id, {
    exportBanList,
    players,
    recount,
    recountError,
    problems: problems.map((message) => ({ rule: 'never-enough', field: 'threshold', message })),
    checked: true
  });
  return exportBanList;
}

// A list as a query gives it: an instance of its own, which says which query loaded it. Its webhook
// stays a getter, so reading it is still recorded.
const instance = (exportBanList, query) =>
  Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(exportBanList),
      loadedBy: { value: query, enumerable: true }
    }
  );

// Whether a list's columns equal a query's.
const hasColumns = (exportBanList, where) =>
  Object.entries(where).every(([column, value]) => exportBanList[column] === value);

const ExportBanList = {
  async checkLimits({ ids, keepRecountErrors = false } = {}) {
    calls.push(['check', ids === undefined ? 'all' : [...ids]]);
    const query = `check ${ids === undefined ? 'all' : ids.join(',')}`;
    const lists = [...rows.values()]
      .filter((row) => ids === undefined || ids.includes(row.exportBanList.id))
      .sort((a, b) => a.exportBanList.id - b.exportBanList.id)
      .map((row) => ({
        ...row,
        exportBanList: instance(row.exportBanList, query),
        configs: [],
        problems: [...row.problems]
      }));
    // A count that failed fails the check, unless the caller keeps its error with the list.
    const failed = lists.find((check) => check.recountError);
    if (failed && !keepRecountErrors) throw failed.recountError;
    if (duringCheck) await duringCheck(ids);
    return { limits: LIMITS, lists };
  },
  // Like Sequelize's, it loads the list without its owner's Steam user. A list read with its row
  // locked is read in the transaction in progress.
  async findByPk(id, options) {
    if (options?.lock) assert.ok(transaction && options.transaction === transaction);
    calls.push(options?.lock ? ['find', id, 'locked'] : ['find', id]);
    const row = rows.get(id);
    if (!row) return null;
    const found = instance(row.exportBanList, `find ${id}`);
    delete found.SteamUser;
    return found;
  },
  // A transaction, in which the transfer reads and writes. It ends with a commit once its work is
  // done, or a rollback when its work fails.
  async inTransaction(work) {
    assert.strictEqual(transaction, null, 'One transaction at a time.');
    transaction = {};
    calls.push(['begin']);
    try {
      const result = await work(transaction);
      calls.push(['commit']);
      return result;
    } catch (error) {
      calls.push(['rollback']);
      throw error;
    } finally {
      transaction = null;
    }
  },
  // Lock a user's lists in the transaction in progress, and give how many they have.
  async lockListsOf(owner, options) {
    assert.ok(transaction && options.transaction === transaction);
    calls.push(['lock lists', owner]);
    return [...rows.values()].filter((row) => row.exportBanList.owner === owner).length;
  },
  // Whether the list's deletion lock is held, asked in the transaction in progress.
  async isBeingDeleted(id, options) {
    assert.ok(transaction && options.transaction === transaction);
    calls.push(['deleting?', id]);
    return beingDeleted.has(id);
  },
  // Run a deletion while holding the list's deletion lock, which is freed once it ends, or, as
  // MySQL does, run nothing and throw an error marked beingDeleted while another deletion holds it.
  async whileDeleting(id, deletion) {
    if (lockErrors.has(id)) throw lockErrors.get(id);
    if (beingDeleted.has(id)) {
      calls.push(['deletion lock held', id]);
      throw Object.assign(new Error('This export ban list is already being deleted.'), {
        beingDeleted: true
      });
    }
    calls.push(['deletion lock', id]);
    beingDeleted.add(id);
    try {
      return await deletion();
    } finally {
      beingDeleted.delete(id);
      calls.push(['deletion lock freed', id]);
    }
  },
  // Only the lists whose columns equal the query's, in ID order. The BattleMetrics ban lists CBL's
  // lists record are read this way, so the query must load each list's type and ban list.
  async findAll({ attributes, where }) {
    calls.push(['find all', where]);
    assert.ok(attributes.includes('type') && attributes.includes('battlemetricsID'));
    return [...rows.values()]
      .map((row) => row.exportBanList)
      .filter((exportBanList) => hasColumns(exportBanList, where))
      .sort((a, b) => a.id - b.id)
      .map((exportBanList) => instance(exportBanList, 'find all'));
  },
  // How many lists have the columns of the query, e.g. how many a user owns.
  async count({ where }) {
    calls.push(['count', where]);
    return [...rows.values()].filter((row) => hasColumns(row.exportBanList, where)).length;
  },
  // Write the values to the lists with the columns of the query, and give how many there were, as
  // Sequelize's update does, in the transaction in progress.
  async update(values, options) {
    assert.ok(transaction && options.transaction === transaction);
    calls.push(['update', values, { where: options.where }]);
    if (beforeUpdate) await beforeUpdate(values, options);
    const updated = [...rows.values()].filter((row) =>
      hasColumns(row.exportBanList, options.where)
    );
    for (const { exportBanList } of updated) Object.assign(exportBanList, values);
    return [updated.length];
  },
  async findVisibleBattlemetricsBanLists() {
    calls.push(['visible']);
    if (visible instanceof Error) throw visible;
    return new Set(visible);
  },
  // What has changed in a list since checkLimits gave this check of it, as the real one finds it:
  // 'deleted' once the list is gone, 'changed' when its settings or its BattleMetrics ban list
  // differ from those it was checked with, or null. The bot asks only while it holds the list's
  // deletion lock, so no change is saved to the list after this.
  async changeSince({ exportBanList }) {
    assert.ok(beingDeleted.has(exportBanList.id), 'A list is read under its deletion lock.');
    calls.push(['changed?', exportBanList.id]);
    if (changeErrors.has(exportBanList.id)) throw changeErrors.get(exportBanList.id);
    const row = rows.get(exportBanList.id);
    if (!row) return 'deleted';
    const columns = [
      'battlemetricsID',
      'threshold',
      'defaultActivePoints',
      'defaultExpiredPoints',
      'maxBanAge'
    ];
    return columns.some((column) => row.exportBanList[column] !== exportBanList[column])
      ? 'changed'
      : null;
  }
};

// A user is looked up by their Steam ID, which the command reaches through sequelize.models. Only
// the columns asked for are loaded, as with Sequelize.
const SteamUser = {
  async findByPk(id, { attributes }) {
    calls.push(['user', id]);
    const user = steamUsers.get(id);
    return user ? Object.fromEntries(attributes.map((column) => [column, user[column]])) : null;
  }
};

const stubs = {
  'discord.js': discord,
  axios: { default: { create: () => ({}) } },
  'scbl-lib/config': { BATTLEMETRICS_API_KEY: 'test-key' },
  'scbl-lib/db': {
    sequelize: { models: { SteamUser } },
    async isRunLockHeld() {
      calls.push(['lock']);
      const held = lockAnswers.shift() ?? false;
      if (held instanceof Error) throw held;
      return held;
    }
  },
  'scbl-lib/db/models': {
    Ban: {},
    BanList: {},
    ExportBanList,
    ExportBanListConfig: {},
    Organisation: {}
  },
  // The ban lists paused now (pausedRows), which /exportbanlist names where the numbers of a list's
  // players depend on them. The bot's other commands, which pause and resume them, are not run.
  'scbl-lib/db/ban-list-suspensions': {
    isMissingTable: () => false,
    MAX_REASON_LENGTH: 500,
    async readPausedBanLists() {
      pausedReads += 1;
      return pausedRows;
    },
    readSettledPausedBanLists: async () => [],
    async resumeBanList() {
      throw new Error('Not expected');
    },
    async suspendBanList() {
      throw new Error('Not expected');
    }
  },
  'scbl-lib/db/importer-models': { BanListSync: {} },
  'scbl-lib/db/sequelize': { Op: {}, QueryTypes: { SELECT: 'SELECT' } },
  // The real utils, so the bot's other helpers find what they import, but a logger that records
  // what the command logs rather than sending it.
  'scbl-lib/utils': {
    ...scblUtils,
    Logger: {
      verbose: (module, level, line) => audits.push(line),
      important: (module, line) => audits.push(`[important] ${line}`)
    }
  }
};

const { default: commands } = await load('../src/commands/index.js');
const { UserError } = await load('../src/utils/index.js');
const command = commands.get('exportbanlist');

// The command's reply: every edit, and each button the confirmation shows. The reply can be edited
// until `expiresAt`, or until `failEditsAfter` more edits have been made.
let failEditsAfter;
function interaction(subcommand, options = {}, { createdTimestamp = Date.now() } = {}) {
  const user = { tag: 'admin', id: '1' };
  return {
    commandName: 'exportbanlist',
    user,
    createdTimestamp,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name, required) => {
        assert.strictEqual(required, true);
        return options[name] ?? null;
      },
      getString: (name, required) => {
        assert.strictEqual(required, true);
        return options[name] ?? null;
      },
      getSubcommandGroup: () => null
    },
    // Nothing is sent but edits to the admin's own reply.
    followUp: () => assert.fail('No follow-up message is sent.'),
    async editReply(payload) {
      if (failEditsAfter !== undefined && failEditsAfter-- <= 0)
        throw new Error('Invalid Webhook Token');
      replies.push(payload);
      return {
        async awaitMessageComponent({ filter, time }) {
          timeouts.push(time);
          if (whileConfirming) await whileConfirming();
          if (answer === 'timeout') throw new Error('Collector received no interactions');
          const button = {
            customId: answer,
            user,
            async update(update) {
              replies.push(update);
            }
          };
          assert.ok(filter(button));
          assert.ok(!filter({ ...button, user: { id: '2' } }));
          return button;
        }
      };
    }
  };
}
const run = (subcommand, options, settings) =>
  command.execute(interaction(subcommand, options, settings));

const contentOf = (reply) => (typeof reply === 'string' ? reply : reply.content);
const embedOf = (reply) => reply.embeds?.[0]?.toJSON();
const fieldsOf = (embed) => embed.fields.map(({ name, value }) => [name, value]);
const fileOf = (reply) => reply.files?.[0];
// The confirmation's question, its button, and what it shows.
function prompt() {
  const question = replies.find((reply) => reply.components?.length > 0);
  if (!question) return null;
  const [confirmButton] = question.components[0].toJSON().components;
  return { reply: question, label: confirmButton.label, embed: embedOf(question) };
}
const deleted = () => calls.filter(([call]) => call === 'delete').map(([, id]) => id);

// Only administrators see the command unless the server allows other roles, and the bot itself
// lets only its admin roles use it. It has a subcommand to remove one list, one for every list
// outside the limits, and one to give a list to another user.
const json = command.data.toJSON();
assert.strictEqual(json.name, 'exportbanlist');
assert.strictEqual(json.default_member_permissions, '0');
assert.deepStrictEqual(
  json.options.map((option) => option.name),
  ['remove', 'remove_outside_limits', 'transfer']
);
const [idOption] = json.options[0].options;
assert.deepStrictEqual(
  [idOption.type, idOption.name, idOption.required, idOption.min_value],
  [discord.ApplicationCommandOptionType.Integer, 'id', true, 1]
);
assert.strictEqual(json.options[0].options.length, 1);
assert.deepStrictEqual(json.options[1].options, []);
// A transfer takes the list's ID, as a removal does, and the new owner's Steam ID as text, as a
// SteamID64 is too large a number for Discord's whole-number options.
const [transferIDOption, ownerOption, ...otherTransferOptions] = json.options[2].options;
assert.deepStrictEqual(
  [
    transferIDOption.type,
    transferIDOption.name,
    transferIDOption.required,
    transferIDOption.min_value
  ],
  [discord.ApplicationCommandOptionType.Integer, 'id', true, 1]
);
assert.deepStrictEqual(
  [ownerOption.type, ownerOption.name, ownerOption.required],
  [discord.ApplicationCommandOptionType.String, 'owner', true]
);
// The new owner must be a Steam user CBL knows, as signing in to the website makes them.
assert.strictEqual(
  ownerOption.description,
  "The new owner's SteamID64, 17 digits. CBL must know it: signing in to the website adds it."
);
assert.deepStrictEqual(otherTransferOptions, []);

// The query that reads the BattleMetrics ban lists CBL's lists record.
const FIND_RECORDED = ['find all', { type: 'battlemetrics' }];

// Removing one list shows its name, type, owner, players, BattleMetrics ID, whether CBL's
// BattleMetrics key can see its ban list, and why it is outside today's limits, asks first, giving
// a minute to answer, and then deletes it as the website does. The removal is logged, and the owner
// is not told.
reset();
addList(12, 'battlemetrics', { battlemetricsID: 'bm-12', players: 1234 });
visible = new Set(['bm-12', 'partner-list']);
await run('remove', { id: 12 });
let shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  'Remove export ban list **List 12** (#12)? This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs. Its owner is not told.'
);
assert.strictEqual(shown.label, 'Remove export ban list');
assert.strictEqual(shown.embed.title, 'List 12');
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '12'],
  ['Type', 'BattleMetrics'],
  ['Players', '1,234'],
  ['Owner', '**Owner 12** (`76561198000000012`)'],
  ['BattleMetrics ID', "`bm-12`, which CBL's BattleMetrics key can see."],
  ["Today's limits", discord.escapeMarkdown(RULE)]
]);
assert.deepStrictEqual(timeouts, [60 * 1000]);
// Once it is confirmed, the list is read again and deleted while the bot holds its deletion lock,
// which is freed once the deletion has ended.
assert.deepStrictEqual(calls, [
  ['check', [12]],
  FIND_RECORDED,
  ['visible'],
  ['deletion lock', 12],
  ['find', 12],
  ['delete', 12],
  ['deletion lock freed', 12]
]);
// The list is deleted as it was read after the confirmation, not as the preview showed it, with
// its owner's Steam user as the preview loaded it, for ExportBanList's lines about the deletion.
assert.deepStrictEqual(deletedFrom, ['find 12']);
assert.deepStrictEqual(deletedWith, [{ owner: 'Owner 12', important: false }]);
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 12** (#12) and its BattleMetrics ban list.'
);
assert.deepStrictEqual(audits, [
  'admin (1) removed export ban list "List 12" (ID: 12, BattleMetrics, BattleMetrics ID: bm-12) of Steam user "Owner 12" (ID: 76561198000000012), which had 1,234 players: its BattleMetrics ban list was deleted.'
]);
assert.deepStrictEqual(notifications, []);
assert.ok(!rows.has(12));

// A remote list is only deleted from the database. A BattleMetrics list without a ban list, and
// one whose ban list BattleMetrics no longer had, say so. A list within the limits can be removed
// too. BattleMetrics is only asked which ban lists CBL's key can see for a list with a ban list.
const askedBattlemetrics = () =>
  calls.some(([call]) => call === 'visible' || call === FIND_RECORDED[0]);

reset();
addList(13, 'remote', { players: 0, problems: [] });
await run('remove', { id: 13 });
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  'Remove export ban list **List 13** (#13)? This deletes the list, with its export bans and configs, so its address serves no players. Its owner is not told.'
);
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '13'],
  ['Type', 'Remote'],
  ['Players', '0'],
  ['Owner', '**Owner 13** (`76561198000000013`)'],
  ["Today's limits", 'Within them.']
]);
assert.strictEqual(contentOf(replies.at(-1)), 'Removed export ban list **List 13** (#13).');
assert.match(audits[0], /, which had 0 players: there was nothing to delete on BattleMetrics\.$/);
assert.ok(!askedBattlemetrics());

reset();
addList(14, 'battlemetrics', { SteamUser: null });
await run('remove', { id: 14 });
shown = prompt();
assert.match(
  contentOf(shown.reply),
  / It has no BattleMetrics ban list, so this deletes only the list,/
);
assert.deepStrictEqual(fieldsOf(shown.embed).slice(3, 5), [
  ['Owner', '`76561198000000014`'],
  ['BattleMetrics ID', 'None']
]);
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 14** (#14). It had no BattleMetrics ban list.'
);
assert.match(audits[0], /of Steam user 76561198000000014, which had 0 players:/);
assert.ok(!askedBattlemetrics());

// BattleMetrics not knowing a ban list CBL's key could see before the removal means it is gone.
reset();
addList(15, 'battlemetrics', { battlemetricsID: 'bm-15' });
visible = new Set(['bm-15']);
deletions.set(15, 'gone');
await run('remove', { id: 15 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 15** (#15). BattleMetrics no longer had its ban list, so there was nothing to delete there.'
);
assert.match(audits[0], /: BattleMetrics no longer had its ban list\.$/);

// A key that cannot see a ban list gets the answer BattleMetrics gives for one it does not have, so
// the removal would take the ban list to be gone and leave it on BattleMetrics. So the confirmation
// says when CBL's key cannot see the list's ban list, or sees none of the ban lists CBL's lists
// record, or BattleMetrics could not be asked, and the list can still be removed. Then BattleMetrics
// not knowing the ban list is reported as something to check on BattleMetrics, not as its being
// gone. Remote lists, and BattleMetrics lists without a ban list, are not counted as recording one.
const UNSEEN =
  'the removal takes it to be gone already: it deletes only the list, with its export bans and configs, and the ban list stays on BattleMetrics with its subscribers.';
for (const { case: name, key, content, field, gone } of [
  {
    case: 'the key cannot see the ban list',
    key: new Set(['bm-22', 'partner-list']),
    content: `**CBL's BattleMetrics key cannot see its BattleMetrics ban list**, though it can see 1 of the 2 BattleMetrics ban lists CBL's export ban lists record, so BattleMetrics may have deleted it already. If it has not, ${UNSEEN} Check it on BattleMetrics first.`,
    field: "`bm-21`, which CBL's BattleMetrics key cannot see.",
    gone: "CBL's BattleMetrics key could not see it before the removal"
  },
  {
    case: "the key sees none of CBL's ban lists",
    key: new Set(['partner-list']),
    content: `**CBL's BattleMetrics key can see 0 of the 2 BattleMetrics ban lists CBL's export ban lists record**, so it may belong to an account outside CBL's organisation: check BATTLEMETRICS_API_KEY. If BattleMetrics still has this list's ban list, ${UNSEEN}`,
    field: "`bm-21`, which CBL's BattleMetrics key cannot see.",
    gone: "CBL's BattleMetrics key could not see it before the removal"
  },
  {
    case: 'BattleMetrics cannot be asked',
    key: new Error('BattleMetrics GET ban-lists failed: HTTP 503'),
    content: `This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs. **BattleMetrics could not be asked whether CBL's BattleMetrics key can see the ban list** (BattleMetrics GET ban-lists failed: HTTP 503). If the key cannot see it, ${UNSEEN}`,
    field:
      "`bm-21`. Whether CBL's BattleMetrics key can see it was not checked, as BattleMetrics could not be asked.",
    gone: "BattleMetrics could not be asked whether CBL's BattleMetrics key could see it"
  }
]) {
  for (const outcome of ['gone', 'deleted']) {
    reset();
    addList(21, 'battlemetrics', { battlemetricsID: 'bm-21', players: 3 });
    addList(22, 'battlemetrics', { battlemetricsID: 'bm-22' });
    addList(23, 'remote');
    addList(24, 'battlemetrics');
    visible = key;
    deletions.set(21, outcome);
    await run('remove', { id: 21 });
    shown = prompt();
    assert.strictEqual(
      contentOf(shown.reply),
      `Remove export ban list **List 21** (#21)? ${content} Its owner is not told.`,
      name
    );
    assert.deepStrictEqual(fieldsOf(shown.embed)[4], ['BattleMetrics ID', field], name);
    assert.deepStrictEqual(
      calls,
      [
        ['check', [21]],
        FIND_RECORDED,
        ['visible'],
        ['deletion lock', 21],
        ['find', 21],
        ['delete', 21],
        ['deletion lock freed', 21]
      ],
      name
    );
    const removed =
      'admin (1) removed export ban list "List 21" (ID: 21, BattleMetrics, BattleMetrics ID: bm-21) of Steam user "Owner 21" (ID: 76561198000000021), which had 3 players';
    if (outcome === 'gone') {
      assert.strictEqual(
        contentOf(replies.at(-1)),
        `Removed export ban list **List 21** (#21), but BattleMetrics did not know its ban list, and ${gone}, so it may still be on BattleMetrics with its subscribers: check it there.`,
        name
      );
      assert.deepStrictEqual(
        audits,
        [
          `${removed}: BattleMetrics did not know its ban list, and ${gone}, so it may still be on BattleMetrics: check it there.`
        ],
        name
      );
    } else {
      // BattleMetrics deleted it after all, e.g. as the key was given its access meanwhile.
      assert.strictEqual(
        contentOf(replies.at(-1)),
        'Removed export ban list **List 21** (#21) and its BattleMetrics ban list.',
        name
      );
      assert.deepStrictEqual(audits, [`${removed}: its BattleMetrics ban list was deleted.`], name);
    }
    assert.deepStrictEqual([...rows.keys()], [22, 23, 24], name);
    assert.deepStrictEqual(notifications, [], name);
  }
}

// A list given a ban list after the confirmation, as one still being made is, had no check of the
// key, so BattleMetrics not knowing that ban list is reported as something to check too, and the
// log names the ban list the removal took.
reset();
addList(25, 'battlemetrics');
whileConfirming = async () => {
  rows.get(25).exportBanList.battlemetricsID = 'bm-25';
};
deletions.set(25, 'gone');
await run('remove', { id: 25 });
assert.ok(!askedBattlemetrics());
assert.strictEqual(
  contentOf(replies.at(-1)),
  "Removed export ban list **List 25** (#25), but BattleMetrics did not know its ban list, and whether CBL's BattleMetrics key could see it was not checked, so it may still be on BattleMetrics with its subscribers: check it there."
);
assert.match(
  audits[0],
  /^admin \(1\) removed export ban list "List 25" \(ID: 25, BattleMetrics, BattleMetrics ID: bm-25\) of .*: BattleMetrics did not know its ban list, and whether CBL's BattleMetrics key could see it was not checked, so it may still be on BattleMetrics: check it there\.$/
);

// A list given to someone else while the removal was confirmed is deleted without its old owner's
// Steam user, so ExportBanList's lines name its owner by Steam ID alone, rather than by the wrong
// name.
reset();
addList(26, 'battlemetrics', { battlemetricsID: 'bm-26' });
visible = new Set(['bm-26']);
whileConfirming = async () => {
  rows.get(26).exportBanList.owner = '76561198000000099';
};
await run('remove', { id: 26 });
assert.deepStrictEqual(deleted(), [26]);
assert.deepStrictEqual(deletedWith, [{ owner: null, important: false }]);

// When the deletion fails, the reply and the log say which step failed, and the list is kept.
reset();
addList(16, 'battlemetrics', { battlemetricsID: 'bm-16' });
deletions.set(
  16,
  Object.assign(
    new Error(
      'BattleMetrics deletion failed while removing invites: HTTP 500. The local list was retained; any invites or subscriptions already removed remain removed.'
    ),
    { stage: 'battlemetrics' }
  )
);
await run('remove', { id: 16 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Could not remove export ban list **List 16** (#16). BattleMetrics deletion failed while removing invites: HTTP 500. The local list was retained; any invites or subscriptions already removed remain removed.'
);
assert.match(
  audits[0],
  /^admin \(1\) could not remove export ban list "List 16" .*: BattleMetrics deletion failed while removing invites/
);
assert.ok(rows.has(16));

reset();
addList(17, 'remote');
deletions.set(
  17,
  Object.assign(new Error('Lock wait timeout exceeded'), { stage: 'database deletion' })
);
await run('remove', { id: 17 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Could not remove export ban list **List 17** (#17). Deleting it from the database failed: Lock wait timeout exceeded'
);

// A list that does not exist is refused, and one deleted while the removal was confirmed is left.
reset();
await assert.rejects(run('remove', { id: 404 }), (err) => {
  assert.ok(err instanceof UserError);
  assert.strictEqual(err.message, 'There is no export ban list with ID 404.');
  return true;
});
assert.strictEqual(prompt(), null);

reset();
addList(18, 'remote');
whileConfirming = async () => rows.delete(18);
await run('remove', { id: 18 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Export ban list **List 18** (#18) no longer exists, so nothing was changed.'
);
assert.deepStrictEqual(deleted(), []);
assert.deepStrictEqual(audits, []);

// A list whose deletion lock is held once the removal is confirmed, as its owner is deleting it on
// the website, or another removal is under way, is left as it is, so the two never delete it at
// once: it is not read again, deleted or logged, and the admin is told.
reset();
addList(18, 'battlemetrics', { battlemetricsID: 'bm-18' });
visible = new Set(['bm-18']);
whileConfirming = async () => beingDeleted.add(18);
await run('remove', { id: 18 });
assert.deepStrictEqual(replies.at(-1), {
  content: 'Export ban list **List 18** (#18) is already being deleted, so nothing was changed.',
  embeds: []
});
assert.deepStrictEqual(calls, [
  ['check', [18]],
  FIND_RECORDED,
  ['visible'],
  ['deletion lock held', 18]
]);
assert.deepStrictEqual(audits, []);
assert.ok(rows.has(18));

// A deletion lock that cannot be taken, as when its connection cannot be opened, fails the command
// as any database error does, with nothing deleted or logged.
reset();
addList(18, 'remote');
const connectionRefused = new Error('connect ECONNREFUSED');
lockErrors.set(18, connectionRefused);
await assert.rejects(run('remove', { id: 18 }), (error) => error === connectionRefused);
assert.deepStrictEqual(deleted(), []);
assert.deepStrictEqual(audits, []);
assert.ok(rows.has(18));

// Cancelling, or not answering in time, changes nothing.
for (const [choice, reply] of [
  ['cancel', 'Cancelled. Nothing was changed.'],
  ['timeout', 'Timed out. Nothing was changed.']
]) {
  reset();
  addList(19, 'battlemetrics', { battlemetricsID: 'bm-19' });
  visible = new Set(['bm-19']);
  answer = choice;
  await run('remove', { id: 19 });
  assert.strictEqual(contentOf(replies.at(-1)), reply);
  assert.deepStrictEqual(calls, [['check', [19]], FIND_RECORDED, ['visible']]);
  assert.deepStrictEqual(audits, []);
  assert.ok(rows.has(19));
}

// A removal does not wait for the ban importer, as the website's Delete button does not, so it
// goes ahead while a run, or a cycle of the importer service, holds the run lock, which it never
// asks about.
reset();
addList(20, 'battlemetrics', { battlemetricsID: 'bm-20' });
visible = new Set(['bm-20']);
lockAnswers = [true, true, true];
await run('remove', { id: 20 });
assert.deepStrictEqual(calls, [
  ['check', [20]],
  FIND_RECORDED,
  ['visible'],
  ['deletion lock', 20],
  ['find', 20],
  ['delete', 20],
  ['deletion lock freed', 20]
]);
assert.ok(!rows.has(20));
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 20** (#20) and its BattleMetrics ban list.'
);

// A list whose export bans are over its type's cap was counted again by its settings now
// (checkLimits' recount), and both numbers are shown, so a list whose export bans are out of date,
// as its owner has made it smaller since the importer last updated them, can be told apart.
reset();
addList(27, 'battlemetrics', {
  battlemetricsID: 'bm-27',
  players: 28337,
  recount: 1554,
  problems: []
});
visible = new Set(['bm-27']);
answer = 'cancel';
await run('remove', { id: 27 });
shown = prompt();
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '27'],
  ['Type', 'BattleMetrics'],
  ['Players', '28,337 by its export bans, 1,554 by its settings now'],
  ['Owner', '**Owner 27** (`76561198000000027`)'],
  ['BattleMetrics ID', "`bm-27`, which CBL's BattleMetrics key can see."],
  ["Today's limits", 'Within them.']
]);
assert.deepStrictEqual(deleted(), []);

// While ban lists are paused, its export bans leave out their bans, as the importer does, and its
// count by its settings now includes them, as the website's size check does, so the two numbers can
// differ with no change to the list. The confirmation then names the paused lists, suspended or
// resuming, and says so. A list not counted again shows one number, its export bans, which leave
// out their bans, so the website's size check can count more players for it: the confirmation names
// the paused lists for it too, and says that, so its number and "Within them" are read rightly.
reset();
pausedRows = PAUSED_ROWS;
const PAUSED_CAP =
  'It has 41,000 players by its export bans and 43,500 by its settings now, both more than the 40,000 a remote export ban list can have.';
addList(26, 'remote', { players: 41000, recount: 43500, problems: [PAUSED_CAP] });
await run('remove', { id: 26 });
shown = prompt();
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '26'],
  ['Type', 'Remote'],
  ['Players', '41,000 by its export bans, 43,500 by its settings now'],
  PAUSED_FIELD,
  ['Owner', '**Owner 26** (`76561198000000026`)'],
  ["Today's limits", discord.escapeMarkdown(PAUSED_CAP)]
]);
assert.strictEqual(pausedReads, 1);
assert.deepStrictEqual(deleted(), [26]);
reset();
pausedRows = PAUSED_ROWS;
addList(25, 'remote', { players: 39000, problems: [] });
answer = 'cancel';
await run('remove', { id: 25 });
assert.deepStrictEqual(fieldsOf(prompt().embed), [
  ['ID', '25'],
  ['Type', 'Remote'],
  ['Players', '39,000'],
  PAUSED_UNCOUNTED_FIELD,
  ['Owner', '**Owner 25** (`76561198000000025`)'],
  ["Today's limits", 'Within them.']
]);
assert.strictEqual(pausedReads, 1);
assert.deepStrictEqual(deleted(), []);
// With no ban list paused, nothing is said of them, whether the list was counted again or not.
for (const counted of [
  { players: 41000, recount: 43500, problems: [PAUSED_CAP] },
  { players: 900 }
]) {
  reset();
  addList(24, 'remote', counted);
  answer = 'cancel';
  await run('remove', { id: 24 });
  assert.ok(!fieldsOf(prompt().embed).some(([name]) => name === PAUSED_FIELD[0]));
  assert.strictEqual(pausedReads, 1);
}

// The count by its settings now only fills in what the confirmation shows, so a count that fails
// does not stop the removal: the confirmation says it failed, and whether the list is within its
// type's cap is not known, and the list can still be removed.
const TIMED_OUT = 'Query execution was interrupted, maximum statement execution time exceeded';
reset();
addList(28, 'remote', { players: 41000, recountError: new Error(TIMED_OUT), problems: [] });
await run('remove', { id: 28 });
shown = prompt();
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '28'],
  ['Type', 'Remote'],
  ['Players', '41,000 by its export bans; they could not be counted by its settings now'],
  ['Owner', '**Owner 28** (`76561198000000028`)'],
  [
    "Today's limits",
    `Within the points rules. Whether it is within its type's cap is not known: its export bans are over it, and its players could not be counted by its settings now (${TIMED_OUT}).`
  ]
]);
assert.deepStrictEqual(deleted(), [28]);
assert.strictEqual(contentOf(replies.at(-1)), 'Removed export ban list **List 28** (#28).');
// A list outside the points rules still shows why.
reset();
addList(29, 'remote', { players: 41000, recountError: new Error(TIMED_OUT) });
answer = 'cancel';
await run('remove', { id: 29 });
assert.strictEqual(
  fieldsOf(prompt().embed).at(-1)[1],
  discord.escapeMarkdown(
    `${RULE} Whether it is within its type's cap is not known: its export bans are over it, and its players could not be counted by its settings now (${TIMED_OUT}).`
  )
);
assert.deepStrictEqual(deleted(), []);

console.log('Removing one export ban list: checks passed.');

// Removing every list outside today's limits previews each, with its type, owner, players and why,
// and the limits used, then removes them after one confirmation, in ID order, logging each. The
// admin has five minutes to read the preview and answer. Lists within the limits are left alone,
// and no owner is told.
reset();
addList(30, 'battlemetrics', { battlemetricsID: 'bm-30', players: 25000 });
addList(31, 'remote', { players: 4206 });
addList(32, 'battlemetrics', { battlemetricsID: 'bm-32', problems: [] });
addList(33, 'battlemetrics', {
  problems: ["A BattleMetrics export ban list's threshold must be at least 4."]
});
visible = new Set(['bm-30', 'bm-32', 'partner-list']);
await run('remove_outside_limits');
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `**3 export ban lists are outside today's limits.** Remove them? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\nCBL's BattleMetrics key can see 2 of the 2 BattleMetrics ban lists CBL's export ban lists record.\n${LIMITS_TEXT}`
);
assert.strictEqual(shown.label, 'Remove 3 export ban lists');
assert.strictEqual(shown.embed.title, "Export ban lists outside today's limits (3)");
const escapedRule = discord.escapeMarkdown(RULE);
assert.strictEqual(
  shown.embed.description,
  [
    `**List 30** (#30) · BattleMetrics · owner **Owner 30** (\`76561198000000030\`) · 25,000 players\n↳ ${escapedRule}`,
    `**List 31** (#31) · Remote · owner **Owner 31** (\`76561198000000031\`) · 4,206 players\n↳ ${escapedRule}`,
    "**List 33** (#33) · BattleMetrics · owner **Owner 33** (`76561198000000033`) · 0 players\n↳ A BattleMetrics export ban list's threshold must be at least 4."
  ].join('\n')
);
assert.strictEqual(fileOf(shown.reply), undefined);
assert.deepStrictEqual(timeouts, [5 * 60 * 1000]);
// Each list is checked again, and then read once more and deleted while the bot holds its deletion
// lock, which is freed once the deletion has ended.
assert.deepStrictEqual(calls, [
  ['check', 'all'],
  ['visible'],
  ['check', [30]],
  ['deletion lock', 30],
  ['changed?', 30],
  ['delete', 30],
  ['deletion lock freed', 30],
  ['check', [31]],
  ['deletion lock', 31],
  ['changed?', 31],
  ['delete', 31],
  ['deletion lock freed', 31],
  ['check', [33]],
  ['deletion lock', 33],
  ['changed?', 33],
  ['delete', 33],
  ['deletion lock freed', 33]
]);
// Each list is deleted as it was read again just before, not as the preview showed it, with its
// owner's Steam user, once it is found unchanged since it was read and checked again.
// ExportBanList's lines about each deletion are important, as the bot's are.
assert.deepStrictEqual(deletedFrom, ['check 30', 'check 31', 'check 33']);
assert.deepStrictEqual(deletedWith, [
  { owner: 'Owner 30', important: true },
  { owner: 'Owner 31', important: true },
  { owner: 'Owner 33', important: true }
]);
assert.deepStrictEqual([...rows.keys()], [32]);
// Every line is important, the results as well as the start and the summary. Lines of the same
// importance reach the log channel in the order they were logged, so there the summary comes after
// every result, even when results are still waiting to be sent as the removal ends.
assert.deepStrictEqual(audits, [
  "[important] admin (1) started removing 3 export ban lists outside today's limits.",
  '[important] admin (1) removed export ban list "List 30" (ID: 30, BattleMetrics, BattleMetrics ID: bm-30) of Steam user "Owner 30" (ID: 76561198000000030), outside today\'s limits with 25,000 players: its BattleMetrics ban list was deleted.',
  '[important] admin (1) removed export ban list "List 31" (ID: 31, Remote) of Steam user "Owner 31" (ID: 76561198000000031), outside today\'s limits with 4,206 players: there was nothing to delete on BattleMetrics.',
  '[important] admin (1) removed export ban list "List 33" (ID: 33, BattleMetrics) of Steam user "Owner 33" (ID: 76561198000000033), outside today\'s limits with 0 players: there was nothing to delete on BattleMetrics.',
  "[important] admin (1) removed 3 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 2 with nothing to delete on BattleMetrics."
]);
let summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 3 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 2 with nothing to delete on BattleMetrics."
);
assert.strictEqual(
  embedOf(summary).description,
  [
    '**List 30** (#30): removed, with its BattleMetrics ban list',
    '**List 31** (#31): removed; there was nothing to delete on BattleMetrics',
    '**List 33** (#33): removed; there was nothing to delete on BattleMetrics'
  ].join('\n')
);
// The summary replaces the preview's attachments.
assert.deepStrictEqual(summary.attachments, []);
assert.deepStrictEqual(summary.files, []);
// Progress was shown while the lists were removed.
assert.ok(
  replies.some(
    (reply) =>
      contentOf(reply) ===
      `Removing 3 export ban lists outside today's limits: 0 done.\n${PROGRESS_NOTE}`
  )
);
assert.deepStrictEqual(notifications, []);

// When nothing is outside the limits, nothing is asked or changed, and BattleMetrics is not asked.
reset();
addList(34, 'battlemetrics', { battlemetricsID: 'bm-34', problems: [] });
await run('remove_outside_limits');
assert.deepStrictEqual(replies, [
  {
    content: `No export ban list is outside today's limits, so nothing was changed.\n${LIMITS_TEXT}`,
    files: []
  }
]);
assert.deepStrictEqual(calls, [['check', 'all']]);

// Lists whose type the limits do not cover are named as not checked.
reset();
addList(35, 'remote');
addList(36, null, { problems: [] });
rows.get(36).checked = false;
answer = 'cancel';
await run('remove_outside_limits');
assert.match(
  contentOf(prompt().reply),
  /^\*\*1 export ban list is outside today's limits\.\*\* Remove it\? .* Their owners are not told\. 1 was not checked, as the limits do not cover its type: #36\.\n/
);

// Cancelling, or not answering in time, changes nothing.
for (const choice of ['cancel', 'timeout']) {
  reset();
  addList(37, 'remote');
  answer = choice;
  await run('remove_outside_limits');
  assert.deepStrictEqual(calls, [['check', 'all']]);
  assert.deepStrictEqual(deleted(), []);
  assert.deepStrictEqual(audits, []);
  assert.ok(rows.has(37));
}

// Nor does a removal of the lists outside the limits wait for the ban importer: while a run, or a
// cycle of the importer service, holds the run lock, which it never asks about, as before the
// preview, once the removal is confirmed, and before each list, it removes every list, also once
// a cycle has started part-way, and it says nothing about the importer.
reset();
for (const id of [40, 41, 42, 43]) addList(id, 'remote');
lockAnswers = [true, true, true, true, true, true];
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [40, 41, 42, 43]);
assert.deepStrictEqual([...rows.keys()], []);
assert.ok(!calls.some(([call]) => call === 'lock'));
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 4 of the 4 export ban lists outside today's limits: 4 with nothing to delete on BattleMetrics."
);
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 4 of the 4 export ban lists outside today's limits: 4 with nothing to delete on BattleMetrics."
);

// A failed removal does not stop the others. Each result is reported, and the log has each
// removal, the failure and the summary.
reset();
addList(50, 'battlemetrics', { battlemetricsID: 'bm-50' });
addList(51, 'battlemetrics', { battlemetricsID: 'bm-51' });
addList(52, 'remote');
visible = new Set(['bm-50', 'bm-51']);
deletions.set(
  51,
  Object.assign(
    new Error(
      'BattleMetrics deletion failed while removing owner: HTTP 503. The local list was retained; any invites or subscriptions already removed remain removed.'
    ),
    { stage: 'battlemetrics' }
  )
);
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [50, 51, 52]);
assert.deepStrictEqual([...rows.keys()], [51]);
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 2 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 with nothing to delete on BattleMetrics. 1 failed."
);
assert.strictEqual(
  embedOf(summary).description.split('\n')[1],
  '**List 51** (#51): failed: BattleMetrics deletion failed while removing owner: HTTP 503. The local list was retained; any invites or subscriptions already removed remain removed.'
);
assert.deepStrictEqual(
  audits.map((line) =>
    line
      .replace(/^\[important\] admin \(1\) /, '')
      .split(' ')
      .slice(0, 2)
      .join(' ')
  ),
  ['started removing', 'removed export', 'could not', 'removed export', 'removed 2']
);
// The failure is important too, so it keeps its place before the summary in the log channel.
assert.ok(audits.every((line) => line.startsWith('[important] admin (1) ')));
assert.match(audits[2], /: BattleMetrics deletion failed while removing owner: HTTP 503\./);

// BattleMetrics lists are only removed once BattleMetrics shows that CBL's API key can see CBL's
// ban lists: a list whose own ban list it cannot see is left, and when it can see none of them, or
// cannot be asked, every list with a ban list is left. Lists with nothing on BattleMetrics are
// removed either way.
reset();
addList(60, 'battlemetrics', { battlemetricsID: 'bm-60' });
addList(61, 'battlemetrics', { battlemetricsID: 'bm-61' });
addList(62, 'remote');
addList(63, 'battlemetrics', { battlemetricsID: 'bm-63', problems: [] });
visible = new Set(['bm-60', 'bm-63']);
await run('remove_outside_limits');
shown = prompt();
assert.match(
  contentOf(shown.reply),
  /^\*\*3 export ban lists are outside today's limits\.\*\* Remove 2 of them\? .*\nCBL's BattleMetrics key can see 2 of the 3 BattleMetrics ban lists CBL's export ban lists record\. The list whose ban list it cannot see is left: check it on BattleMetrics, then remove it with `\/exportbanlist remove`\.\n/
);
assert.strictEqual(shown.label, 'Remove 2 export ban lists');
assert.match(
  shown.embed.description,
  /\*\*List 61\*\* \(#61\) .*\n↳ .* \*\*Left:\*\* its BattleMetrics ban list is not among those CBL's BattleMetrics key can see\./
);
assert.deepStrictEqual(deleted(), [60, 62]);
assert.deepStrictEqual([...rows.keys()].sort(), [61, 63]);
assert.match(
  replies.at(-1).content,
  /^Removed 2 of the 3 export ban lists outside today's limits: .* 1 was left from the start\.$/
);
assert.match(
  embedOf(replies.at(-1)).description,
  /\*\*List 61\*\* \(#61\): left: its BattleMetrics ban list is not among those CBL's BattleMetrics key can see$/
);

for (const [access, note, why] of [
  [
    new Set(['partner-list']),
    "CBL's BattleMetrics key can see 0 of the 2 BattleMetrics ban lists CBL's export ban lists record. It may belong to an account outside CBL's organisation, so the lists with BattleMetrics ban lists are left. Check BATTLEMETRICS_API_KEY.",
    "CBL's BattleMetrics key can see none of CBL's ban lists"
  ],
  [
    new Error('BattleMetrics GET ban-lists failed: HTTP 401'),
    "BattleMetrics could not be asked which ban lists CBL's BattleMetrics key can see (BattleMetrics GET ban-lists failed: HTTP 401), so the lists with BattleMetrics ban lists are left. Try again later.",
    'BattleMetrics could not be asked about its ban list'
  ]
]) {
  reset();
  addList(64, 'battlemetrics', { battlemetricsID: 'bm-64' });
  addList(65, 'battlemetrics', { battlemetricsID: 'bm-65' });
  addList(66, 'battlemetrics');
  visible = access;
  await run('remove_outside_limits');
  shown = prompt();
  assert.ok(contentOf(shown.reply).includes(`\n${note}\n`));
  // The preview says why each list with a ban list is left.
  assert.deepStrictEqual(
    shown.embed.description.split('\n').filter((line) => line.startsWith('↳')),
    [`↳ ${escapedRule} **Left:** ${why}.`, `↳ ${escapedRule} **Left:** ${why}.`, `↳ ${escapedRule}`]
  );
  assert.deepStrictEqual(deleted(), [66]);
}

// A list given a ban list after the preview, as one still being made is, when no list in the
// preview had one and so BattleMetrics was not asked which ban lists CBL's key can see, is left, and
// the removal goes on to the next list and its summary.
reset();
addList(68, 'battlemetrics');
addList(69, 'remote');
whileConfirming = async () => {
  rows.get(68).exportBanList.battlemetricsID = 'bm-68';
};
await run('remove_outside_limits');
assert.ok(!calls.some(([call]) => call === 'visible'));
assert.deepStrictEqual(deleted(), [69]);
assert.deepStrictEqual([...rows.keys()], [68]);
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);
assert.deepStrictEqual(embedOf(summary).description.split('\n'), [
  '**List 68** (#68): not removed, as its BattleMetrics ban list was not checked',
  '**List 69** (#69): removed; there was nothing to delete on BattleMetrics'
]);
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);

// When nothing can be removed, the preview is shown without asking.
reset();
addList(67, 'battlemetrics', { battlemetricsID: 'bm-67' });
visible = new Set();
await run('remove_outside_limits');
assert.strictEqual(prompt(), null);
assert.match(
  contentOf(replies.at(-1)),
  /^\*\*1 export ban list is outside today's limits\.\*\* None can be removed now, so nothing was changed\.\n/
);
assert.deepStrictEqual(deleted(), []);

// A list whose ban list BattleMetrics listed, but which is gone when the list is removed, stops the
// removal there, as the key may have lost its access.
reset();
for (const id of [70, 71, 72]) addList(id, 'battlemetrics', { battlemetricsID: `bm-${id}` });
visible = new Set(['bm-70', 'bm-71', 'bm-72']);
deletions.set(71, 'gone');
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [70, 71]);
assert.deepStrictEqual([...rows.keys()], [72]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 2 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 whose BattleMetrics ban list was already gone. 1 was not tried, as the removal stopped.\nStopped after #71, as BattleMetrics no longer had its ban list, which it listed when the removal started. CBL's BattleMetrics key may have lost its access, so check BATTLEMETRICS_API_KEY and BATTLEMETRICS_ORGANIZATION before running the command again."
);

// Each list is read and checked again just before it is removed, so one whose owner has brought it
// within the limits, or deleted it, since the preview is left. The summary counts the list now
// within the limits apart from the one that changed, as a list can also come within them with no
// change to it (see exportbanlist-limits.js).
reset();
for (const id of [80, 81, 82]) addList(id, 'remote');
whileConfirming = async () => {
  rows.get(80).problems = [];
  rows.delete(81);
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [82]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 1 of the 3 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it is now within today's limits. 1 was not removed, as it had changed."
);
assert.deepStrictEqual(embedOf(replies.at(-1)).description.split('\n').slice(0, 2), [
  "**List 80** (#80): not removed, as it is now within today's limits",
  '**List 81** (#81): not removed, as it no longer exists'
]);

// A list whose export bans are over its type's cap was counted again by its settings now
// (checkLimits' recount), and the preview and the log give both numbers. Lists over the cap by
// their export bans but not by their settings now are within the limits, as their owners have made
// them smaller since the importer last updated their export bans, and the reply names them, so the
// admin knows why they are not removed, in a line after the limits used.
const CAP_REASON =
  'It has 41,000 players by its export bans and 40,500 by its settings now, both more than the 40,000 a remote export ban list can have.';
reset();
addList(88, 'remote', { players: 41000, recount: 40500, problems: [CAP_REASON] });
addList(89, 'battlemetrics', {
  battlemetricsID: 'bm-89',
  players: 28337,
  recount: 1554,
  problems: []
});
addList(97, 'remote', { players: 45000, recount: 40000, problems: [] });
await run('remove_outside_limits');
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `**1 export ban list is outside today's limits.** Remove it? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\n${LIMITS_TEXT}\n2 export ban lists are within the cap by their settings now, though their export bans are over it until the importer updates them: #89 (28,337 players by its export bans, 1,554 by its settings now) and #97 (45,000 players by its export bans, 40,000 by its settings now).`
);
assert.strictEqual(
  shown.embed.description,
  `**List 88** (#88) · Remote · owner **Owner 88** (\`76561198000000088\`) · 41,000 players by its export bans, 40,500 by its settings now\n↳ ${discord.escapeMarkdown(CAP_REASON)}`
);
assert.deepStrictEqual(shown.reply.files, []);
assert.deepStrictEqual(deleted(), [88]);
assert.strictEqual(
  audits[1],
  `[important] admin (1) removed export ban list "List 88" (ID: 88, Remote) of Steam user "Owner 88" (ID: 76561198000000088), outside today's limits with 41,000 players by its export bans, 40,500 by its settings now: there was nothing to delete on BattleMetrics.`
);

// When no list is outside the limits, such a list is named too.
reset();
addList(89, 'battlemetrics', {
  battlemetricsID: 'bm-89',
  players: 28337,
  recount: 1554,
  problems: []
});
await run('remove_outside_limits');
assert.deepStrictEqual(replies, [
  {
    content: `No export ban list is outside today's limits, so nothing was changed.\n${LIMITS_TEXT}\n1 export ban list is within the cap by its settings now, though its export bans are over it until the importer updates them: #89 (28,337 players by its export bans, 1,554 by its settings now).`,
    files: []
  }
]);
assert.deepStrictEqual(calls, [['check', 'all']]);

// While ban lists are paused, the importer leaves their bans out of export bans, but a count by a
// list's settings now includes them, as the website's size check does, so that the list's cap
// holds once they count again. Every reply says so after the limits used, naming the paused lists,
// suspended or resuming, so the numbers are read rightly. A list within the cap by its export bans
// is not counted again, so one within it only while they are paused is left, which it says too.
reset();
pausedRows = PAUSED_ROWS;
addList(88, 'remote', { players: 41000, recount: 43500, problems: [PAUSED_CAP] });
addList(90, 'remote', { players: 39000, problems: [] });
await run('remove_outside_limits');
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `**1 export ban list is outside today's limits.** Remove it? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\n${LIMITS_TEXT}\n${PAUSED_TEXT}`
);
assert.strictEqual(
  shown.embed.description,
  `**List 88** (#88) · Remote · owner **Owner 88** (\`76561198000000088\`) · 41,000 players by its export bans, 43,500 by its settings now\n↳ ${discord.escapeMarkdown(PAUSED_CAP)}`
);
assert.strictEqual(pausedReads, 1);
assert.deepStrictEqual(deleted(), [88]);
assert.deepStrictEqual([...rows.keys()], [90]);
// With one paused, and with lists within the cap by their settings now, which the reply names after
// it, or none outside the limits.
reset();
pausedRows = [PAUSED_ROWS[0]];
addList(89, 'remote', { players: 41000, recount: 39500, problems: [] });
await run('remove_outside_limits');
assert.deepStrictEqual(replies, [
  {
    content: `No export ban list is outside today's limits, so nothing was changed.\n${LIMITS_TEXT}\n${ONE_PAUSED_TEXT}\n1 export ban list is within the cap by its settings now, though its export bans are over it until the importer updates them: #89 (41,000 players by its export bans, 39,500 by its settings now).`,
    files: []
  }
]);
// And when none can be removed.
reset();
pausedRows = PAUSED_ROWS;
addList(91, 'battlemetrics', { battlemetricsID: 'bm-91', players: 900 });
visible = new Set(['partner-list']);
await run('remove_outside_limits');
assert.ok(
  contentOf(replies.at(-1)).endsWith(
    ` so the lists with BattleMetrics ban lists are left. Check BATTLEMETRICS_API_KEY.\n${LIMITS_TEXT}\n${PAUSED_TEXT}`
  )
);
assert.deepStrictEqual(deleted(), []);

// The reply names at most five of them, and an attached file names them all, so that however many
// there are, the reply keeps the limits used, which the admin compares with the website's.
for (const outsideToo of [false, true]) {
  reset();
  for (let id = 200; id < 240; id++)
    addList(id, 'remote', { players: 45000 + id, recount: 300, problems: [] });
  if (outsideToo) addList(240, 'remote');
  answer = 'cancel';
  await run('remove_outside_limits');
  const reply = outsideToo ? prompt().reply : replies[0];
  assert.ok(reply.content.length <= 2000);
  assert.ok(
    reply.content.endsWith(
      `\n${LIMITS_TEXT}\n40 export ban lists are within the cap by their settings now, though their export bans are over it until the importer updates them: #200 (45,200 players by its export bans, 300 by its settings now), #201 (45,201 players by its export bans, 300 by its settings now), #202 (45,202 players by its export bans, 300 by its settings now), #203 (45,203 players by its export bans, 300 by its settings now), #204 (45,204 players by its export bans, 300 by its settings now) and 35 more, all in the attached export-ban-lists-awaiting-the-importer.txt.`
    )
  );
  assert.deepStrictEqual(
    reply.files.map((attached) => attached.name),
    ['export-ban-lists-awaiting-the-importer.txt']
  );
  const lines = reply.files[0].attachment.toString('utf8').split('\n');
  assert.match(
    lines[0],
    /^Export ban lists within the cap by their settings now, though their export bans are over it until the importer updates them, checked \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: 40$/
  );
  assert.strictEqual(lines.length, 41);
  assert.strictEqual(
    lines[1],
    '#200 Remote list "List 200": 45,200 players by its export bans, 300 by its settings now'
  );
  assert.strictEqual(
    lines[40],
    '#239 Remote list "List 239": 45,239 players by its export bans, 300 by its settings now'
  );
  assert.deepStrictEqual(deleted(), []);
}

// A list over its type's cap by its export bans whose players cannot be counted by its settings now
// may be over the cap or not, so it is never removed for the cap, and it holds up no other list.
// Within the points rules, it is left, and named after the limits used, with why its count failed.
// When it breaks the points rules, which need no count, it is outside the limits all the same, and
// its line in the preview says that the count failed.
const UNKNOWN_CAP = `Whether it is within its type's cap is not known: its export bans are over it, and its players could not be counted by its settings now (${TIMED_OUT}).`;
const uncountedNote = (id) =>
  `1 export ban list over the cap by its export bans could not be counted by its settings now, so whether it is within the cap is not known, and it is left: #${id} (${TIMED_OUT}). Run the command again later to check it.`;
reset();
addList(98, 'remote', { players: 41000, recountError: new Error(TIMED_OUT), problems: [] });
addList(99, 'remote');
addList(109, 'remote', { players: 42000, recountError: new Error(TIMED_OUT) });
await run('remove_outside_limits');
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `**2 export ban lists are outside today's limits.** Remove them? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\n${LIMITS_TEXT}\n${uncountedNote(98)}`
);
const [line99, reason99, line109, reason109] = shown.embed.description.split('\n');
assert.deepStrictEqual(
  [line99, reason99, line109],
  [
    '**List 99** (#99) · Remote · owner **Owner 99** (`76561198000000099`) · 0 players',
    `↳ ${escapedRule}`,
    '**List 109** (#109) · Remote · owner **Owner 109** (`765611980000000109`) · 42,000 players by its export bans; they could not be counted by its settings now'
  ]
);
assert.ok(reason109.startsWith(`↳ ${discord.escapeMarkdown(`${RULE} Whether it is within`)}`));
assert.deepStrictEqual(calls, [
  ['check', 'all'],
  ['check', [99]],
  ['deletion lock', 99],
  ['changed?', 99],
  ['delete', 99],
  ['deletion lock freed', 99],
  ['check', [109]],
  ['deletion lock', 109],
  ['changed?', 109],
  ['delete', 109],
  ['deletion lock freed', 109]
]);
assert.deepStrictEqual([...rows.keys()], [98]);
assert.strictEqual(
  audits[2],
  `[important] admin (1) removed export ban list "List 109" (ID: 109, Remote) of Steam user "Owner 109" (ID: 765611980000000109), outside today's limits with 42,000 players by its export bans; they could not be counted by its settings now: there was nothing to delete on BattleMetrics.`
);
// The preview's attached file gives such a list's whole reason, with its count that failed.
reset();
addList(109, 'remote', { players: 42000, recountError: new Error(TIMED_OUT) });
const longRule = 'A rule that is long. '.repeat(40);
for (let id = 140; id < 170; id++) addList(id, 'remote', { problems: [longRule] });
answer = 'cancel';
await run('remove_outside_limits');
assert.ok(
  fileOf(prompt().reply)
    .attachment.toString('utf8')
    .includes(
      `\n#109 Remote list "List 109"\n  Owner: Owner 109 (Steam ID 765611980000000109)\n  Players: 42,000 by its export bans; they could not be counted by its settings now\n  Settings: threshold 5, 5 points for an active ban and 1 for an expired ban, max ban age 0 days (0 for any), 0 configs\n  Outside the limits: ${RULE} ${UNKNOWN_CAP}\n  To be removed.`
    )
);
assert.deepStrictEqual(deleted(), []);

// When no list is found outside the limits, nothing is changed, and the reply says it is not known
// for the lists that could not be counted.
reset();
addList(98, 'remote', { players: 41000, recountError: new Error(TIMED_OUT), problems: [] });
await run('remove_outside_limits');
assert.deepStrictEqual(replies, [
  {
    content: `No export ban list was found outside today's limits, so nothing was changed.\n${LIMITS_TEXT}\n${uncountedNote(98)}`,
    files: []
  }
]);
assert.deepStrictEqual(calls, [['check', 'all']]);

// The reply names at most five of them, each with its error cut short, and an attached file names
// them all, with the whole error, after the limits used and before the lists within the cap by
// their settings now.
reset();
const longError = `${TIMED_OUT} ${'and more '.repeat(20)}`;
for (let id = 300; id < 307; id++)
  addList(id, 'remote', {
    players: 41000 + id,
    recountError: new Error(id === 300 ? longError : TIMED_OUT),
    problems: []
  });
addList(310, 'remote', { players: 45000, recount: 300, problems: [] });
addList(311, 'remote');
answer = 'cancel';
await run('remove_outside_limits');
shown = prompt();
assert.ok(shown.reply.content.length <= 2000);
assert.ok(
  shown.reply.content.endsWith(
    `\n${LIMITS_TEXT}\n7 export ban lists over the cap by their export bans could not be counted by their settings now, so whether they are within the cap is not known, and they are left: #300 (${longError.slice(0, 99)}…), #301 (${TIMED_OUT}), #302 (${TIMED_OUT}), #303 (${TIMED_OUT}), #304 (${TIMED_OUT}) and 2 more, all in the attached export-ban-lists-not-counted.txt. Run the command again later to check them.\n1 export ban list is within the cap by its settings now, though its export bans are over it until the importer updates them: #310 (45,000 players by its export bans, 300 by its settings now).`
  )
);
assert.deepStrictEqual(
  shown.reply.files.map((attached) => attached.name),
  ['export-ban-lists-not-counted.txt']
);
const uncountedLines = shown.reply.files[0].attachment.toString('utf8').split('\n');
assert.match(
  uncountedLines[0],
  /^Export ban lists over the cap by their export bans that could not be counted by their settings now, and so are left, checked \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: 7$/
);
assert.strictEqual(uncountedLines.length, 8);
assert.strictEqual(
  uncountedLines[1],
  `#300 Remote list "List 300": 41,300 players by its export bans; the count failed: ${longError}`
);
assert.strictEqual(
  uncountedLines[7],
  `#306 Remote list "List 306": 41,306 players by its export bans; the count failed: ${TIMED_OUT}`
);
assert.deepStrictEqual(deleted(), []);

// A note naming five or fewer lists attaches its file too when it cuts an error short, so the whole
// error is never lost.
reset();
addList(300, 'remote', { players: 41300, recountError: new Error(longError), problems: [] });
addList(301, 'remote', { players: 41301, recountError: new Error(TIMED_OUT), problems: [] });
await run('remove_outside_limits');
assert.strictEqual(replies.length, 1);
assert.strictEqual(
  replies[0].content,
  `No export ban list was found outside today's limits, so nothing was changed.\n${LIMITS_TEXT}\n2 export ban lists over the cap by their export bans could not be counted by their settings now, so whether they are within the cap is not known, and they are left: #300 (${longError.slice(0, 99)}…) and #301 (${TIMED_OUT}), all in the attached export-ban-lists-not-counted.txt. Run the command again later to check them.`
);
assert.deepStrictEqual(
  replies[0].files.map((attached) => attached.name),
  ['export-ban-lists-not-counted.txt']
);
assert.strictEqual(
  replies[0].files[0].attachment.toString('utf8').split('\n')[1],
  `#300 Remote list "List 300": 41,300 players by its export bans; the count failed: ${longError}`
);
assert.deepStrictEqual(deleted(), []);

// With many lists in both notes, and a list left for CBL's BattleMetrics key, the notes in full
// would take the reply past Discord's 2,000 characters. Then they name the lists by ID only, and
// each attaches its file, with the whole errors, however few lists it names, so the limits used
// stay in full and no list is lost.
reset();
for (let id = 320; id < 327; id++)
  addList(id, 'remote', { players: 41000, recountError: new Error(TIMED_OUT), problems: [] });
for (let id = 330; id < 336; id++)
  addList(id, 'remote', { players: 45000, recount: 300, problems: [] });
addList(340, 'battlemetrics', { battlemetricsID: 'bm-340' });
addList(341, 'battlemetrics', { battlemetricsID: 'bm-341', problems: [] });
addList(342, 'remote');
visible = new Set(['bm-341']);
answer = 'cancel';
await run('remove_outside_limits');
const longReply = prompt().reply;
assert.ok(longReply.content.length <= 2000);
assert.ok(
  longReply.content.endsWith(
    `\n${LIMITS_TEXT}\n7 export ban lists over the cap by their export bans could not be counted by their settings now, so whether they are within the cap is not known, and they are left: #320, #321, #322, #323, #324 and 2 more, all in the attached export-ban-lists-not-counted.txt. Run the command again later to check them.\n6 export ban lists are within the cap by their settings now, though their export bans are over it until the importer updates them: #330, #331, #332, #333, #334 and 1 more, all in the attached export-ban-lists-awaiting-the-importer.txt.`
  )
);
assert.deepStrictEqual(
  longReply.files.map((attached) => attached.name),
  ['export-ban-lists-not-counted.txt', 'export-ban-lists-awaiting-the-importer.txt']
);
const [uncountedFile, updatingFile] = longReply.files.map((attached) =>
  attached.attachment.toString('utf8').split('\n')
);
assert.strictEqual(uncountedFile.length, 8);
assert.strictEqual(
  uncountedFile[7],
  `#326 Remote list "List 326": 41,000 players by its export bans; the count failed: ${TIMED_OUT}`
);
assert.strictEqual(updatingFile.length, 7);
assert.strictEqual(
  updatingFile[6],
  '#335 Remote list "List 335": 45,000 players by its export bans, 300 by its settings now'
);
assert.deepStrictEqual(deleted(), []);

// A note with five or fewer lists attaches its file too when the reply would be too long, and a
// long error from BattleMetrics is cut short, so the limits used still stay in full.
reset();
for (let id = 320; id < 325; id++)
  addList(id, 'remote', {
    players: 41000,
    recountError: new Error(`${TIMED_OUT} ${'and more '.repeat(100)}`),
    problems: []
  });
for (let id = 330; id < 335; id++)
  addList(id, 'remote', { players: 45000, recount: 300, problems: [] });
addList(340, 'battlemetrics', { battlemetricsID: 'bm-340' });
visible = new Error(`BattleMetrics GET ban-lists failed: ${'HTTP 500 '.repeat(200)}`);
await run('remove_outside_limits');
assert.ok(replies[0].content.length <= 2000);
assert.ok(
  replies[0].content.endsWith(
    `\n${LIMITS_TEXT}\n5 export ban lists over the cap by their export bans could not be counted by their settings now, so whether they are within the cap is not known, and they are left: #320, #321, #322, #323 and #324, all in the attached export-ban-lists-not-counted.txt. Run the command again later to check them.\n5 export ban lists are within the cap by their settings now, though their export bans are over it until the importer updates them: #330, #331, #332, #333 and #334, all in the attached export-ban-lists-awaiting-the-importer.txt.`
  )
);
assert.deepStrictEqual(
  replies[0].files.map((attached) => attached.name),
  ['export-ban-lists-not-counted.txt', 'export-ban-lists-awaiting-the-importer.txt']
);
assert.deepStrictEqual(deleted(), []);

// Checking a list again takes a moment, longer when its players are counted again, so it is read
// once more just before it is removed. One its owner changed while it was being checked, e.g. by
// raising its threshold, or deleted, is left, and one that cannot be read once more is left as
// failed. The others carry on.
reset();
for (const id of [120, 121, 122, 123, 124]) addList(id, 'remote');
duringCheck = (ids) => {
  if (ids?.[0] === 120) rows.get(120).exportBanList.threshold = 9;
  if (ids?.[0] === 121) rows.delete(121);
  if (ids?.[0] === 122) rows.get(122).exportBanList.name = 'Renamed';
};
changeErrors.set(123, new Error('Connection lost'));
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [122, 124]);
assert.deepStrictEqual(
  calls.filter(([call]) => call === 'changed?'),
  [120, 121, 122, 123, 124].map((id) => ['changed?', id])
);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 2 of the 5 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics. 1 failed. 2 were not removed, as they had changed."
);
assert.deepStrictEqual(embedOf(replies.at(-1)).description.split('\n'), [
  '**List 120** (#120): not removed, as it changed while it was being checked',
  '**List 121** (#121): not removed, as it no longer exists',
  '**List 122** (#122): removed; there was nothing to delete on BattleMetrics',
  '**List 123** (#123): failed: It could not be checked again: Connection lost',
  '**List 124** (#124): removed; there was nothing to delete on BattleMetrics'
]);
assert.match(
  audits.find((line) => line.includes('"List 123"')),
  /could not remove export ban list "List 123" .*: It could not be checked again: Connection lost$/
);

// A list whose deletion lock is held once it has been checked again, as its owner is deleting it on
// the website, is left as it is, so the two never delete it at once, and one whose deletion lock
// cannot be taken, as its connection cannot be opened, is left as failed, saying so. The others
// carry on.
reset();
for (const id of [125, 126, 127]) addList(id, 'remote');
duringCheck = (ids) => {
  if (ids?.[0] === 125) beingDeleted.add(125);
};
lockErrors.set(126, new Error('connect ECONNREFUSED'));
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [127]);
assert.deepStrictEqual(
  calls.filter(([call]) => call.startsWith('deletion lock') || call === 'changed?'),
  [
    ['deletion lock held', 125],
    ['deletion lock', 127],
    ['changed?', 127],
    ['deletion lock freed', 127]
  ]
);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 1 of the 3 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 failed. 1 was not removed, as it was already being deleted."
);
assert.deepStrictEqual(embedOf(replies.at(-1)).description.split('\n'), [
  '**List 125** (#125): not removed, as it is already being deleted',
  '**List 126** (#126): failed: Its deletion lock could not be taken: connect ECONNREFUSED',
  '**List 127** (#127): removed; there was nothing to delete on BattleMetrics'
]);
// A list left as it is posts no line of its own, as the summary counts it, and a failure does.
assert.ok(!audits.some((line) => line.includes('"List 125"')));
assert.match(
  audits.find((line) => line.includes('"List 126"')),
  /could not remove export ban list "List 126" .*: Its deletion lock could not be taken: connect ECONNREFUSED$/
);

// The summary counts the lists left as they were already being deleted apart from those that had
// changed.
reset();
for (const id of [140, 141, 142, 143]) addList(id, 'remote');
duringCheck = (ids) => {
  if (ids?.[0] === 140 || ids?.[0] === 141) beingDeleted.add(ids[0]);
  if (ids?.[0] === 142) rows.get(142).exportBanList.threshold = 9;
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [143]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 1 of the 4 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed. 2 were not removed, as they were already being deleted."
);
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 1 of the 4 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed. 2 were not removed, as they were already being deleted."
);

// A list whose players cannot be counted by its settings now as it is checked again just before
// its removal may be over its type's cap or not. It is removed when it breaks the points rules,
// which need no count, and otherwise left as failed.
reset();
addList(130, 'remote', { players: 41000, recount: 40500, problems: [RULE, CAP_REASON] });
addList(131, 'remote', { players: 41000, recount: 40500, problems: [CAP_REASON] });
whileConfirming = async () => {
  Object.assign(rows.get(130), { recount: null, recountError: new Error(TIMED_OUT) });
  rows.get(130).problems.splice(1);
  Object.assign(rows.get(131), { recount: null, recountError: new Error(TIMED_OUT), problems: [] });
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [130]);
assert.deepStrictEqual(embedOf(replies.at(-1)).description.split('\n'), [
  '**List 130** (#130): removed; there was nothing to delete on BattleMetrics',
  `**List 131** (#131): failed: It could not be checked again: ${TIMED_OUT}`
]);
assert.match(
  audits[1],
  /^\[important\] admin \(1\) removed export ban list "List 130" .*, outside today's limits with 41,000 players by its export bans; they could not be counted by its settings now: there was nothing to delete on BattleMetrics\.$/
);

// The summary says how many lists ended each way, and the log has each BattleMetrics list's ban
// list as it was before the list was removed.
reset();
addList(83, 'battlemetrics', { battlemetricsID: 'bm-83' });
addList(84, 'battlemetrics', { battlemetricsID: 'bm-84' });
addList(85, 'remote');
addList(86, 'battlemetrics', { battlemetricsID: 'bm-86' });
addList(87, 'remote');
visible = new Set(['bm-83', 'bm-84']);
deletions.set(
  84,
  Object.assign(new Error('Removing the owner failed.'), { stage: 'battlemetrics' })
);
whileConfirming = async () => {
  rows.get(85).problems = [];
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [83, 84, 87]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 2 of the 5 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 with nothing to delete on BattleMetrics. 1 failed. 1 was not removed, as it is now within today's limits. 1 was left from the start."
);
assert.match(
  audits[1],
  /^\[important\] admin \(1\) removed export ban list "List 83" \(ID: 83, BattleMetrics, BattleMetrics ID: bm-83\) of /
);
assert.match(
  audits[2],
  /^\[important\] admin \(1\) could not remove export ban list "List 84" \(ID: 84, BattleMetrics, BattleMetrics ID: bm-84\) .*: Removing the owner failed\.$/
);

// Lists that do not fit in the preview are in an attached file, with every detail, as are the
// results that do not fit in the summary.
reset();
const long = 'A reason that is long. '.repeat(40);
for (let id = 100; id < 130; id++) addList(id, 'remote', { problems: [long] });
// One counted again by its settings now, as its export bans are over the cap. A ban list is paused,
// which the file says after the limits used, as the reply does.
Object.assign(rows.get(128), { players: 41000, recount: 40500 });
pausedRows = [PAUSED_ROWS[0]];
answer = 'cancel';
await run('remove_outside_limits');
shown = prompt();
const description = shown.embed.description;
assert.ok(description.length <= 4096);
assert.match(description, /\n…and \d+ more, all in the attached file\.$/);
const file = fileOf(shown.reply);
assert.strictEqual(file.name, 'export-ban-lists-outside-limits.txt');
const text = file.attachment.toString('utf8');
assert.match(
  text,
  /^Export ban lists outside today's limits, checked \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: 30\n/
);
assert.ok(text.includes(`\n${LIMITS_TEXT}\n${ONE_PAUSED_TEXT}\n\n#100 Remote list "List 100"\n`));
assert.ok(
  text.includes(
    `\n#129 Remote list "List 129"\n  Owner: Owner 129 (Steam ID 765611980000000129)\n  Players: 0\n  Settings: threshold 5, 5 points for an active ban and 1 for an expired ban, max ban age 0 days (0 for any), 0 configs\n  Outside the limits: ${long}\n  To be removed.`
  )
);
assert.ok(
  text.includes(
    '\n#128 Remote list "List 128"\n  Owner: Owner 128 (Steam ID 765611980000000128)\n  Players: 41,000 by its export bans, 40,500 by its settings now\n'
  )
);
// Each reason is cut short in the embed, and in full in the file.
assert.ok(!description.includes(long.trim()));

answer = 'confirm';
replies = [];
const failure = Object.assign(new Error(long), { stage: 'database deletion' });
for (let id = 100; id < 130; id++) deletions.set(id, failure);
await run('remove_outside_limits');
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 0 of the 30 export ban lists outside today's limits. 30 failed."
);
assert.ok(embedOf(summary).description.length <= 4096);
assert.strictEqual(summary.files[0].name, 'export-ban-list-removals.txt');
const results = summary.files[0].attachment.toString('utf8').split('\n');
assert.strictEqual(results.length, 30);
assert.strictEqual(
  results[0],
  `#100 "List 100": failed: Deleting it from the database failed: ${long}`
);
assert.deepStrictEqual(summary.attachments, []);

// Discord lets the reply be edited for 15 minutes. A removal that runs past them carries on, and
// its results and summary are only logged; nor does a reply that can no longer be edited stop it.
reset();
for (const id of [90, 91]) addList(id, 'remote');
const late = interaction(
  'remove_outside_limits',
  {},
  { createdTimestamp: Date.now() - 14.5 * 60 * 1000 - 1 }
);
await command.execute(late);
assert.deepStrictEqual(deleted(), [90, 91]);
// The confirmation's own edits were the last.
assert.strictEqual(contentOf(replies.at(-1)), 'Working on it...');
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 2 of the 2 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics."
);

reset();
for (const id of [92, 93]) addList(id, 'remote');
failEditsAfter = 1;
const warnings = [];
const { warn } = console;
console.warn = (line) => warnings.push(line);
try {
  await run('remove_outside_limits');
} finally {
  console.warn = warn;
  failEditsAfter = undefined;
}
assert.deepStrictEqual(deleted(), [92, 93]);
assert.deepStrictEqual(warnings, [
  'Could not update the reply to /exportbanlist, so it is no longer updated: Invalid Webhook Token'
]);
assert.match(audits.at(-1), /^\[important\] admin \(1\) removed 2 of the 2 export ban lists/);

// Only one removal of the lists outside the limits runs at a time.
reset();
addList(95, 'remote');
// The first removal waits for the admin's answer, which comes once the second has been refused. A
// second removal that went ahead would be answered at once.
let answerNow;
let asked;
const asking = new Promise((resolve) => (asked = resolve));
whileConfirming = () => {
  whileConfirming = null;
  asked();
  return new Promise((resolve) => (answerNow = resolve));
};
const first = run('remove_outside_limits');
await asking;
await assert.rejects(run('remove_outside_limits'), {
  message:
    'The export ban lists outside the limits are already being removed. Try again once that has finished.'
});
answerNow();
await first;
assert.deepStrictEqual(deleted(), [95]);
// Once it has finished, the next can run.
addList(96, 'remote');
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [95, 96]);
assert.deepStrictEqual(notifications, []);

// Steam users to give lists to, and the owner addList gives list 12.
const NEW_OWNER = '76561198100000001';
const OTHER_USER = '76561198100000002';
const OWNER_12 = '76561198000000012';

// Add a Steam user who has signed in to the website, or with signedIn false, one CBL knows only
// from a ban list.
function addSteamUser(id, name, { signedIn = true } = {}) {
  steamUsers.set(id, { id, name, isSCBLUser: signedIn });
}

// Give a user remote export ban lists of their own, with these IDs.
function giveLists(owner, ids) {
  for (const id of ids)
    addList(id, 'remote', { owner, SteamUser: steamUsers.get(owner) ?? null, problems: [] });
}
const ownerOf = (id) => rows.get(id)?.exportBanList.owner;

// Giving a list to another Steam user shows the list's name, ID, type and players, its owner and
// the new owner, each with their Steam name and Steam ID, and how many export ban lists the new
// owner has, and asks first, giving a minute to answer. Then, in one transaction, the new owner's
// lists are locked and counted again, the list is read again with its row locked, and whether its
// deletion has started is checked, as the website changes lists from its own process, and only the
// list's owner is written, and only while it is still the owner shown. The transfer is logged, and
// no owner is told. Neither the run lock nor BattleMetrics is asked.
reset();
addList(12, 'battlemetrics', { battlemetricsID: 'bm-12', players: 1234 });
addSteamUser(NEW_OWNER, 'New Owner');
giveLists(NEW_OWNER, [30]);
await run('transfer', { id: 12, owner: NEW_OWNER });
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `Transfer export ban list **List 12** (#12) from **Owner 12** (\`${OWNER_12}\`) to **New Owner** (\`${NEW_OWNER}\`)? Only its owner changes: its settings, configs, players, Discord webhook and BattleMetrics ban list stay as they are. From then on the new owner sees it on the website, with its Discord webhook and BattleMetrics invite, and can change or delete it, and the current owner no longer can. Neither is told.`
);
assert.strictEqual(shown.label, 'Transfer export ban list');
assert.strictEqual(shown.embed.title, 'List 12');
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '12'],
  ['Type', 'BattleMetrics'],
  ['Players', '1,234'],
  ['Current owner', `**Owner 12** (\`${OWNER_12}\`)`],
  ['New owner', `**New Owner** (\`${NEW_OWNER}\`)`],
  ["New owner's export ban lists", '1 now, and 2 with this one. A user can have 4.']
]);
assert.deepStrictEqual(timeouts, [60 * 1000]);
assert.deepStrictEqual(calls, [
  ['check', [12]],
  ['user', NEW_OWNER],
  ['count', { owner: NEW_OWNER }],
  ['begin'],
  ['lock lists', NEW_OWNER],
  ['find', 12, 'locked'],
  ['deleting?', 12],
  ['update', { owner: NEW_OWNER }, { where: { id: 12, owner: OWNER_12 } }],
  ['commit']
]);
assert.strictEqual(ownerOf(12), NEW_OWNER);
assert.deepStrictEqual(replies.at(-1), {
  content: `Transferred export ban list **List 12** (#12) from **Owner 12** (\`${OWNER_12}\`) to **New Owner** (\`${NEW_OWNER}\`). From now on the new owner sees it on the website, with its Discord webhook and BattleMetrics invite, and the old owner no longer does. Neither was told.`,
  embeds: []
});
assert.deepStrictEqual(audits, [
  `admin (1) transferred export ban list "List 12" (ID: 12, BattleMetrics, BattleMetrics ID: bm-12) of Steam user "Owner 12" (ID: ${OWNER_12}) to Steam user "New Owner" (ID: ${NEW_OWNER}).`
]);
assert.deepStrictEqual(notifications, []);

// A remote list has no BattleMetrics ban list or invite to hand over, and a user without a Steam
// name is shown by their Steam ID. Spaces around the Steam ID given are left out.
reset();
addList(13, 'remote', { SteamUser: null, players: 5, problems: [] });
addSteamUser(NEW_OWNER, null);
await run('transfer', { id: 13, owner: ` ${NEW_OWNER} ` });
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `Transfer export ban list **List 13** (#13) from \`76561198000000013\` to \`${NEW_OWNER}\`? Only its owner changes: its settings, configs, players and Discord webhook stay as they are. From then on the new owner sees it on the website, with its Discord webhook, and can change or delete it, and the current owner no longer can. Neither is told.`
);
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '13'],
  ['Type', 'Remote'],
  ['Players', '5'],
  ['Current owner', '`76561198000000013`'],
  ['New owner', `\`${NEW_OWNER}\``],
  ["New owner's export ban lists", '0 now, and 1 with this one. A user can have 4.']
]);
assert.strictEqual(
  contentOf(replies.at(-1)),
  `Transferred export ban list **List 13** (#13) from \`76561198000000013\` to \`${NEW_OWNER}\`. From now on the new owner sees it on the website, with its Discord webhook, and the old owner no longer does. Neither was told.`
);
assert.deepStrictEqual(audits, [
  `admin (1) transferred export ban list "List 13" (ID: 13, Remote) of Steam user 76561198000000013 to Steam user ${NEW_OWNER}.`
]);
assert.strictEqual(ownerOf(13), NEW_OWNER);

// A user with 3 lists can be given a fourth, the most the website lets them have.
reset();
addList(12, 'remote');
addSteamUser(NEW_OWNER, 'New Owner');
giveLists(NEW_OWNER, [30, 31, 32]);
await run('transfer', { id: 12, owner: NEW_OWNER });
assert.deepStrictEqual(fieldsOf(prompt().embed).at(-1), [
  "New owner's export ban lists",
  '3 now, and 4 with this one. A user can have 4.'
]);
assert.strictEqual(ownerOf(12), NEW_OWNER);
assert.match(contentOf(replies.at(-1)), /^Transferred export ban list \*\*List 12\*\* \(#12\) /);

// A list over its type's cap by its export bans is shown with its players by its settings now too,
// and when that count fails, the confirmation says so, and the list can still be transferred.
reset();
addList(12, 'remote', { players: 41000, recount: 39000, problems: [] });
addSteamUser(NEW_OWNER, 'New Owner');
await run('transfer', { id: 12, owner: NEW_OWNER });
assert.deepStrictEqual(fieldsOf(prompt().embed)[2], [
  'Players',
  '41,000 by its export bans, 39,000 by its settings now'
]);
assert.strictEqual(ownerOf(12), NEW_OWNER);
// While ban lists are paused, the confirmation names them, as a removal's does, for such a list and
// for one not counted again, saying what they mean for each list's numbers of players.
for (const [counted, players, field] of [
  [
    { players: 41000, recount: 43500 },
    '41,000 by its export bans, 43,500 by its settings now',
    PAUSED_FIELD
  ],
  [{ players: 39000 }, '39,000', PAUSED_UNCOUNTED_FIELD]
]) {
  reset();
  pausedRows = PAUSED_ROWS;
  addList(12, 'remote', { ...counted, problems: [] });
  addSteamUser(NEW_OWNER, 'New Owner');
  await run('transfer', { id: 12, owner: NEW_OWNER });
  assert.deepStrictEqual(fieldsOf(prompt().embed).slice(2, 5), [
    ['Players', players],
    field,
    ['Current owner', '**Owner 12** (`76561198000000012`)']
  ]);
  assert.strictEqual(pausedReads, 1);
  assert.strictEqual(ownerOf(12), NEW_OWNER);
}
reset();
addList(12, 'remote', { players: 41000, recountError: new Error(TIMED_OUT), problems: [] });
addSteamUser(NEW_OWNER, 'New Owner');
await run('transfer', { id: 12, owner: NEW_OWNER });
assert.deepStrictEqual(fieldsOf(prompt().embed)[2], [
  'Players',
  '41,000 by its export bans; they could not be counted by its settings now'
]);
assert.strictEqual(ownerOf(12), NEW_OWNER);
assert.match(contentOf(replies.at(-1)), /^Transferred export ban list \*\*List 12\*\* \(#12\) /);

// CBL also knows the Steam IDs of players who have been on its ban lists, so a list can be given to
// someone who has never signed in to the website, who sees it once they do. The confirmation warns
// that they have not signed in yet, so that the Steam ID can be checked first.
reset();
addList(12, 'remote');
addSteamUser(NEW_OWNER, 'Player 7', { signedIn: false });
await run('transfer', { id: 12, owner: NEW_OWNER });
assert.deepStrictEqual(fieldsOf(prompt().embed)[4], [
  'New owner',
  `**Player 7** (\`${NEW_OWNER}\`)\n**Has not signed in to the website yet**, so check the Steam ID is theirs. They see the list once they sign in.`
]);
assert.strictEqual(ownerOf(12), NEW_OWNER);
assert.match(contentOf(replies.at(-1)), /^Transferred export ban list \*\*List 12\*\* \(#12\) /);

// A transfer is refused, with nothing shown, asked or changed: when the owner given is not a
// SteamID64, which is checked before anything is read; when the list does not exist or already
// belongs to that user; when CBL has no Steam user with that ID, as they have never signed in or
// been on a ban list; and when the user already has as many export ban lists as the website lets a
// user have.
async function refusedTransfer(options, message, reads) {
  const owners = new Map([...rows].map(([id, row]) => [id, row.exportBanList.owner]));
  await assert.rejects(run('transfer', options), (err) => {
    assert.ok(err instanceof UserError, message);
    assert.strictEqual(err.message, message);
    return true;
  });
  assert.deepStrictEqual(calls, reads, message);
  assert.strictEqual(prompt(), null, message);
  assert.deepStrictEqual(audits, [], message);
  assert.deepStrictEqual(
    new Map([...rows].map(([id, row]) => [id, row.exportBanList.owner])),
    owners,
    message
  );
}
const notSteamID = (given) =>
  `**${discord.escapeMarkdown(given)}** is not a Steam ID. Give the new owner's SteamID64, which is 17 digits.`;

for (const given of [
  NEW_OWNER.slice(0, -1),
  `${NEW_OWNER}1`,
  `${NEW_OWNER.slice(0, -1)}x`,
  `https://steamcommunity.com/profiles/${NEW_OWNER}`,
  'STEAM_0:1:20011',
  '-7656119810000000'
]) {
  reset();
  addList(12, 'remote');
  addSteamUser(NEW_OWNER, 'New Owner');
  await refusedTransfer({ id: 12, owner: given }, notSteamID(given), []);
}
// A long one is cut short in the message.
reset();
await refusedTransfer({ id: 12, owner: '7'.repeat(300) }, notSteamID(`${'7'.repeat(99)}…`), []);

reset();
addSteamUser(NEW_OWNER, 'New Owner');
await refusedTransfer({ id: 404, owner: NEW_OWNER }, 'There is no export ban list with ID 404.', [
  ['check', [404]]
]);

reset();
addList(12, 'remote');
addSteamUser(OWNER_12, 'Owner 12');
await refusedTransfer(
  { id: 12, owner: OWNER_12 },
  `Export ban list **List 12** (#12) already belongs to **Owner 12** (\`${OWNER_12}\`).`,
  [['check', [12]]]
);

reset();
addList(12, 'remote');
await refusedTransfer(
  { id: 12, owner: NEW_OWNER },
  `CBL has no Steam user with ID \`${NEW_OWNER}\`. The new owner must sign in to the website once first, which adds them.`,
  [
    ['check', [12]],
    ['user', NEW_OWNER]
  ]
);

// Lists from before the limit can leave a user with more than 4.
for (const ids of [
  [30, 31, 32, 33],
  [30, 31, 32, 33, 34]
]) {
  reset();
  addList(12, 'battlemetrics', { battlemetricsID: 'bm-12' });
  addSteamUser(NEW_OWNER, 'New Owner');
  giveLists(NEW_OWNER, ids);
  await refusedTransfer(
    { id: 12, owner: NEW_OWNER },
    `**New Owner** (\`${NEW_OWNER}\`) already has ${ids.length} export ban lists, and the website lets a user have at most 4. One of them must be removed before they can be given another.`,
    [
      ['check', [12]],
      ['user', NEW_OWNER],
      ['count', { owner: NEW_OWNER }]
    ]
  );
}

// Cancelling, or not answering in time, changes nothing.
for (const [choice, reply] of [
  ['cancel', 'Cancelled. Nothing was changed.'],
  ['timeout', 'Timed out. Nothing was changed.']
]) {
  reset();
  addList(12, 'battlemetrics', { battlemetricsID: 'bm-12' });
  addSteamUser(NEW_OWNER, 'New Owner');
  answer = choice;
  await run('transfer', { id: 12, owner: NEW_OWNER });
  assert.strictEqual(contentOf(replies.at(-1)), reply);
  assert.deepStrictEqual(calls, [
    ['check', [12]],
    ['user', NEW_OWNER],
    ['count', { owner: NEW_OWNER }]
  ]);
  assert.deepStrictEqual(audits, []);
  assert.strictEqual(ownerOf(12), OWNER_12);
}

// Once the transfer is confirmed, the list and the new owner's lists are read again, and nothing is
// changed if the list has been deleted, or given to the new owner or to someone else, or it is
// being deleted, on the website or by a removal, which can take minutes, or the new owner has as
// many lists as a user can have.
const readAgain = [['begin'], ['lock lists', NEW_OWNER], ['find', 12, 'locked']];
for (const { case: name, change, reply, reads, owner } of [
  {
    case: 'the list was deleted',
    change: () => rows.delete(12),
    reply: 'Export ban list **List 12** (#12) no longer exists, so nothing was changed.',
    reads: [...readAgain, ['commit']],
    owner: undefined
  },
  {
    case: 'the list was given to the new owner',
    change: () => {
      rows.get(12).exportBanList.owner = NEW_OWNER;
    },
    reply: `Export ban list **List 12** (#12) already belongs to **New Owner** (\`${NEW_OWNER}\`), so nothing was changed.`,
    reads: [...readAgain, ['commit']],
    owner: NEW_OWNER
  },
  {
    case: 'the list was given to someone else',
    change: () => {
      rows.get(12).exportBanList.owner = OTHER_USER;
    },
    reply: `Export ban list **List 12** (#12) now belongs to \`${OTHER_USER}\`, not **Owner 12** (\`${OWNER_12}\`) as shown, so nothing was changed.`,
    reads: [...readAgain, ['commit']],
    owner: OTHER_USER
  },
  {
    case: 'it is being deleted',
    change: () => beingDeleted.add(12),
    reply: 'Export ban list **List 12** (#12) is being deleted, so nothing was changed.',
    reads: [...readAgain, ['deleting?', 12], ['commit']],
    owner: OWNER_12
  },
  {
    case: 'the new owner has made lists',
    change: () => giveLists(NEW_OWNER, [31, 32, 33]),
    reply: `**New Owner** (\`${NEW_OWNER}\`) now has 4 export ban lists, and the website lets a user have at most 4, so nothing was changed.`,
    reads: [...readAgain, ['deleting?', 12], ['commit']],
    owner: OWNER_12
  }
]) {
  reset();
  addList(12, 'battlemetrics', { battlemetricsID: 'bm-12' });
  addSteamUser(NEW_OWNER, 'New Owner');
  giveLists(NEW_OWNER, [30]);
  whileConfirming = change;
  await run('transfer', { id: 12, owner: NEW_OWNER });
  assert.ok(prompt(), name);
  assert.deepStrictEqual(replies.at(-1), { content: reply, embeds: [] }, name);
  assert.deepStrictEqual(
    calls,
    [['check', [12]], ['user', NEW_OWNER], ['count', { owner: NEW_OWNER }], ...reads],
    name
  );
  assert.deepStrictEqual(audits, [], name);
  assert.strictEqual(ownerOf(12), owner, name);
}

// A list changed or deleted in the moment between being read again and the update is left as it
// is, as the update only writes the owner while the list still has the owner shown.
for (const [name, change, owner] of [
  [
    'given to someone else',
    () => {
      rows.get(12).exportBanList.owner = OTHER_USER;
    },
    OTHER_USER
  ],
  ['deleted', () => rows.delete(12), undefined]
]) {
  reset();
  addList(12, 'battlemetrics', { battlemetricsID: 'bm-12' });
  addSteamUser(NEW_OWNER, 'New Owner');
  beforeUpdate = change;
  await run('transfer', { id: 12, owner: NEW_OWNER });
  assert.deepStrictEqual(
    replies.at(-1),
    {
      content:
        'Export ban list **List 12** (#12) changed as it was being transferred, so nothing was changed.',
      embeds: []
    },
    name
  );
  assert.strictEqual(ownerOf(12), owner, name);
  assert.deepStrictEqual(audits, [], name);
}

// Let everything run that does not wait for an update the test holds back: the stand-ins answer at
// once.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const listsOf = (owner) =>
  [...rows.values()]
    .filter((row) => row.exportBanList.owner === owner)
    .map((row) => row.exportBanList.id);
const OWNER_13 = '76561198000000013';

// The bot makes one transfer at a time, from reading the list and the new owner's lists again to
// writing the owner, so two transfers to a user with 3 lists, confirmed at the same time, cannot
// both give them their fourth. Here the first one's update waits until both have been confirmed,
// as when MySQL makes it wait for a row a ban importer run has locked. The second is only checked
// once the first has been made, and is refused.
reset();
addList(12, 'remote');
addList(13, 'remote');
addSteamUser(NEW_OWNER, 'New Owner');
giveLists(NEW_OWNER, [30, 31, 32]);
let releaseUpdate;
const updateReleased = new Promise((resolve) => (releaseUpdate = resolve));
beforeUpdate = () => updateReleased;
const together = [
  run('transfer', { id: 12, owner: NEW_OWNER }),
  run('transfer', { id: 13, owner: NEW_OWNER })
];
await settle();
releaseUpdate();
await Promise.all(together);
assert.deepStrictEqual(listsOf(NEW_OWNER), [12, 30, 31, 32]);
assert.strictEqual(ownerOf(13), OWNER_13);
assert.deepStrictEqual(calls.slice(calls.findIndex(([call]) => call === 'update')), [
  ['update', { owner: NEW_OWNER }, { where: { id: 12, owner: OWNER_12 } }],
  ['commit'],
  ['begin'],
  ['lock lists', NEW_OWNER],
  ['find', 13, 'locked'],
  ['deleting?', 13],
  ['commit']
]);
assert.ok(
  replies.some(
    (reply) =>
      contentOf(reply) ===
      `**New Owner** (\`${NEW_OWNER}\`) now has 4 export ban lists, and the website lets a user have at most 4, so nothing was changed.`
  )
);
assert.deepStrictEqual(audits, [
  `admin (1) transferred export ban list "List 12" (ID: 12, Remote) of Steam user "Owner 12" (ID: ${OWNER_12}) to Steam user "New Owner" (ID: ${NEW_OWNER}).`
]);

// A transfer whose update fails, as when MySQL gives up waiting for a lock, changes nothing, and a
// transfer confirmed meanwhile waits for it to end and then is made as usual.
reset();
addList(12, 'remote');
addList(13, 'remote');
addSteamUser(NEW_OWNER, 'New Owner');
const lockWaitTimeout = new Error('Lock wait timeout exceeded; try restarting transaction');
const failureReleased = new Promise((resolve) => (releaseUpdate = resolve));
beforeUpdate = async (values, { where }) => {
  if (where.id !== 12) return;
  await failureReleased;
  calls.push(['failed', 12]);
  throw lockWaitTimeout;
};
const [failing, waiting] = [
  run('transfer', { id: 12, owner: NEW_OWNER }),
  run('transfer', { id: 13, owner: NEW_OWNER })
];
await settle();
releaseUpdate();
await assert.rejects(failing, (error) => error === lockWaitTimeout);
await waiting;
assert.deepStrictEqual(calls.slice(calls.findIndex(([call]) => call === 'failed')), [
  ['failed', 12],
  ['rollback'],
  ['begin'],
  ['lock lists', NEW_OWNER],
  ['find', 13, 'locked'],
  ['deleting?', 13],
  ['update', { owner: NEW_OWNER }, { where: { id: 13, owner: OWNER_13 } }],
  ['commit']
]);
assert.strictEqual(ownerOf(12), OWNER_12);
assert.strictEqual(ownerOf(13), NEW_OWNER);
assert.deepStrictEqual(replies.at(-1), {
  content: `Transferred export ban list **List 13** (#13) from **Owner 13** (\`${OWNER_13}\`) to **New Owner** (\`${NEW_OWNER}\`). From now on the new owner sees it on the website, with its Discord webhook, and the old owner no longer does. Neither was told.`,
  embeds: []
});
assert.deepStrictEqual(audits, [
  `admin (1) transferred export ban list "List 13" (ID: 13, Remote) of Steam user "Owner 13" (ID: ${OWNER_13}) to Steam user "New Owner" (ID: ${NEW_OWNER}).`
]);

// A transfer MySQL could not make, as other changes held the rows it needed, which
// ExportBanList.inTransaction marks busy once it has given up, e.g. after a lock wait timeout or a
// deadlock met every time it tried, changed nothing, so the admin is told so plainly, to try again,
// and nothing is logged as a failure.
reset();
addList(12, 'remote');
addSteamUser(NEW_OWNER, 'New Owner');
beforeUpdate = () => {
  throw Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), {
    busy: true
  });
};
await assert.rejects(run('transfer', { id: 12, owner: NEW_OWNER }), (err) => {
  assert.ok(err instanceof UserError);
  assert.strictEqual(
    err.message,
    'Export ban list **List 12** (#12) was not transferred, as the database was busy with other changes, so nothing was changed. Try again in a minute.'
  );
  return true;
});
assert.strictEqual(ownerOf(12), OWNER_12);
assert.deepStrictEqual(audits, []);
assert.ok(calls.some(([call]) => call === 'rollback'));

// A transfer goes ahead while a ban importer run holds its lock, which it does not check: nothing
// a run does reads or writes a list's owner.
reset();
addList(12, 'battlemetrics', { battlemetricsID: 'bm-12' });
addSteamUser(NEW_OWNER, 'New Owner');
lockAnswers = [true, true];
await run('transfer', { id: 12, owner: NEW_OWNER });
assert.ok(!calls.some(([call]) => call === 'lock'));
assert.strictEqual(ownerOf(12), NEW_OWNER);
assert.match(audits[0], /^admin \(1\) transferred export ban list "List 12" /);
assert.deepStrictEqual(notifications, []);

console.log('Transferring an export ban list: checks passed.');

console.log(
  'Export ban list command checks passed: admin only, previews, confirmations, removals that do not wait for the importer, BattleMetrics access, failures, long removals and transfers.'
);
