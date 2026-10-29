import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

import { readLimits } from '../../scbl-lib/export-list-limits.js';
import * as scblUtils from '../../scbl-lib/utils/index.js';

// /exportbanlist remove_outside_limits with the real ExportBanList, whose checkLimits finds the
// lists outside today's limits for the preview, and checks each again just before it is removed.
// The database is a stand-in, whose export bans stay as the importer last left them, as nothing
// else changes them, and so is its count of the players a list's settings and configs give now
// (countMembers). The bot's own files are the real ones, and its package imports are stand-ins.

const { limits: LIMITS } = readLimits({});

// The database: the export ban lists by ID, and each list's export bans by status.
const lists = new Map();
const exportBans = new Map();
// The lists deleted, and the thresholds the players were counted for, in turn.
const destroyed = [];
const counted = [];

// The players the database counts for a list's settings and configs as they are now, by threshold:
// the higher the threshold, the fewer players. An error fails the count. duringCount runs while a
// count is made, with its settings, e.g. for the list's owner to change it meanwhile.
const MEMBERS = new Map([
  [3, 45000],
  [6, 12000],
  [9, 40500],
  [10, 39000]
]);
let duringCount = null;
async function countMembers(settings) {
  counted.push(settings.threshold);
  if (duringCount) await duringCount(settings);
  assert.ok(MEMBERS.has(settings.threshold), `Unexpected count for ${settings.threshold}`);
  const players = MEMBERS.get(settings.threshold);
  if (players instanceof Error) throw players;
  return players;
}

// The lists' deletion locks, as MySQL keeps them: those the bot's connections hold, and those
// another connection holds, e.g. the website's while a list's owner deletes it there. The lists
// read with their rows locked, in turn, each while the bot held its deletion lock.
const lockedByBot = new Set();
const lockedElsewhere = new Set();
const lockedReads = [];

// A deletion lock's connection, which takes the lock unless another connection holds it, and frees
// it when it is closed.
async function openConnection() {
  const held = [];
  return {
    async query(sql, [id]) {
      assert.match(sql, /^SELECT GET_LOCK\(/);
      if (lockedByBot.has(id) || lockedElsewhere.has(id)) return [[{ taken: 0 }]];
      lockedByBot.add(id);
      held.push(id);
      return [[{ taken: 1 }]];
    },
    async end() {
      for (const id of held) lockedByBot.delete(id);
    },
    destroy() {
      this.end();
    }
  };
}

// A stand-in for Sequelize's Model, whose findAll gives the matching lists as instances, with the
// owner's Steam user included, whose findByPk gives one list, and whose destroy deletes the list
// with its export bans.
class Model {
  static init() {}

  static async findAll(options) {
    const ids = options.where?.id;
    return [...lists.values()]
      .filter((row) => ids === undefined || ids.includes(row.id))
      .sort((a, b) => a.id - b.id)
      .map((row) =>
        Object.assign(new this(), row, { SteamUser: { id: row.owner, name: `Owner ${row.id}` } })
      );
  }

  static async findByPk(id, options) {
    if (options?.lock) {
      assert.ok(options.transaction, 'A row is locked in a transaction.');
      assert.ok(lockedByBot.has(id), 'A list is read with its row locked under its deletion lock.');
      lockedReads.push(id);
    }
    return lists.has(id) ? Object.assign(new this(), lists.get(id)) : null;
  }

  async destroy() {
    assert.ok(lockedByBot.has(this.id), 'A list is deleted under its deletion lock.');
    destroyed.push(this.id);
    lists.delete(this.id);
    exportBans.delete(this.id);
  }
}
const dataType = () => dataType;
const models = {
  BanList: {},
  Organisation: {},
  SteamUser: {},
  ExportBanListConfig: { findAll: async () => [] },
  ExportBan: {
    async count({ where }) {
      return where.exportBanList
        .filter((id) => exportBans.has(id))
        .map((id) => ({
          exportBanList: id,
          // MySQL's COUNT can come back as text.
          count: String(
            where.status.reduce((sum, status) => sum + (exportBans.get(id)[status] ?? 0), 0)
          )
        }));
    }
  }
};
// Only remote lists are removed here, so BattleMetrics is never asked anything.
async function battlemetrics() {
  assert.fail('BattleMetrics is not asked anything.');
}

// The real ExportBanList, in a context of its own. Its transactions only run their work.
const modelStubs = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: { models, transaction: (work) => work({}) } },
  // A removal holds the list's deletion lock on a connection of its own, as the website's
  // deletions do.
  '../open-connection.js': { default: openConnection },
  '../export-membership.js': { countMembers },
  '../../apis/index.js': { battlemetrics },
  '../../utils/index.js': { Logger: { verbose() {}, important() {} } },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: '1', EXPORT_LIST_LIMITS: LIMITS },
  // The BattleMetrics steps' own imports.
  './battlemetrics.js': { default: battlemetrics },
  '../config.js': { BATTLEMETRICS_ORGANIZATION: '1' }
};
// Closing a deletion lock's connection sets a time limit on it.
const modelContext = vm.createContext({ URL, setTimeout, clearTimeout });
const loadModelFile = async (url) =>
  new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context: modelContext,
    identifier: url.href
  });
const modelModule = await loadModelFile(
  new URL('../../scbl-lib/db/models/export-ban-list.js', import.meta.url)
);
await modelModule.link(async (specifier, referencingModule) => {
  const exports = modelStubs[specifier];
  // The other relative imports, the limits, the deletion steps and the page reader, are the real
  // files.
  if (!exports) return loadModelFile(new URL(specifier, referencingModule.identifier));
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context: modelContext }
  );
});
await modelModule.evaluate();
const ExportBanList = modelModule.namespace.default;

// The command, which runs in this test's own context, with what it logs recorded.
const audits = [];
const stubs = {
  'discord.js': discord,
  axios: { default: { create: () => ({}) } },
  'scbl-lib/config': { BATTLEMETRICS_API_KEY: 'test-key' },
  'scbl-lib/db': { sequelize: { models }, isRunLockHeld: async () => false },
  'scbl-lib/db/models': {
    Ban: {},
    BanList: {},
    ExportBanList,
    ExportBanListConfig: {},
    Organisation: {}
  },
  'scbl-lib/db/sequelize': { Op: {} },
  'scbl-lib/utils': {
    ...scblUtils,
    Logger: {
      verbose: (module, level, line) => audits.push(line),
      important: (module, line) => audits.push(line)
    }
  }
};
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
const commandModule = await moduleAt(
  new URL('../src/commands/exportbanlist.js', import.meta.url).href
);
await commandModule.link(linker);
await commandModule.evaluate();
const command = commandModule.namespace.default;

// The command's replies, and the command as an admin runs it, who confirms the removal once
// whileConfirming has run, e.g. to change a list as they read the preview.
const replies = [];
function interaction(whileConfirming) {
  const user = { tag: 'admin', id: '1' };
  return {
    commandName: 'exportbanlist',
    user,
    createdTimestamp: Date.now(),
    options: { getSubcommand: () => 'remove_outside_limits', getSubcommandGroup: () => null },
    followUp: () => assert.fail('No follow-up message is sent.'),
    async editReply(payload) {
      replies.push(payload);
      return {
        async awaitMessageComponent() {
          await whileConfirming();
          return {
            customId: 'confirm',
            user,
            async update(update) {
              replies.push(update);
            }
          };
        }
      };
    }
  };
}

// A remote list, as stored, with its export bans by status.
function addList(id, threshold, bans, [defaultActivePoints, defaultExpiredPoints] = [3, 1]) {
  lists.set(id, {
    id,
    name: `List ${id}`,
    type: 'remote',
    threshold,
    defaultActivePoints,
    defaultExpiredPoints,
    maxBanAge: 0,
    owner: `7656119800000000${id}`,
    battlemetricsID: null
  });
  exportBans.set(id, bans);
}

// A list whose export bans are over the cap, but which its owner brings within the limits while the
// admin reads the preview, by raising its threshold, is not removed, though its export bans stay
// over the cap until the importer updates them. A list over the cap by its export bans and by its
// settings now is removed. Only the lists over the cap are counted.
// Its threshold is below the lowest of 4, and it has more players than a remote list can have.
addList(1, 3, { CREATED: 44000, TO_BE_CREATED: 1000, TO_BE_DELETED: 300 }, [1, 1]);
// Within the points rules, with more players than a remote list can have.
addList(2, 9, { CREATED: 41000 });
// Within the limits.
addList(3, 9, { CREATED: 900 });
// Its export bans are over the cap, but not its players by its settings now.
addList(4, 10, { CREATED: 42000 });
await command.execute(
  interaction(async () => {
    lists.get(1).threshold = 6;
  })
);

const [preview] = replies.filter((reply) => reply.components?.length > 0);
assert.strictEqual(
  preview.content,
  `**2 export ban lists are outside today's limits.** Remove them? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\nLimits used: BattleMetrics lists have at most 20,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough; remote lists have at most 40,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough. They come from the bot's EXPORT_* settings, which must match the website's.\n1 export ban list is within the cap by its settings now, though its export bans are over it until the importer updates them: #4 (42,000 players by its export bans, 39,000 by its settings now).`
);
assert.strictEqual(
  preview.embeds[0].toJSON().description,
  [
    '**List 1** (#1) · Remote · owner **Owner 1** (`76561198000000001`) · 45,000 players by its export bans, 45,000 by its settings now',
    "↳ A remote export ban list's threshold must be at least 4. It has 45,000 players, more than the 40,000 a remote export ban list can have.",
    '**List 2** (#2) · Remote · owner **Owner 2** (`76561198000000002`) · 41,000 players by its export bans, 40,500 by its settings now',
    '↳ It has 41,000 players by its export bans and 40,500 by its settings now, both more than the 40,000 a remote export ban list can have.'
  ].join('\n')
);

// List 1 was checked and counted again just before its removal, with its new threshold, and left;
// list 2 was removed.
assert.deepStrictEqual(counted, [3, 9, 10, 6, 9]);
assert.deepStrictEqual(destroyed, [2]);
assert.deepStrictEqual([...lists.keys()], [1, 3, 4]);
assert.deepStrictEqual(exportBans.get(1), {
  CREATED: 44000,
  TO_BE_CREATED: 1000,
  TO_BE_DELETED: 300
});
const summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);
assert.deepStrictEqual(summary.embeds[0].toJSON().description.split('\n'), [
  "**List 1** (#1): not removed, as it is now within today's limits",
  '**List 2** (#2): removed; there was nothing to delete on BattleMetrics'
]);
assert.deepStrictEqual(audits, [
  "admin (1) started removing 2 export ban lists outside today's limits.",
  'admin (1) removed export ban list "List 2" (ID: 2, Remote) of Steam user "Owner 2" (ID: 76561198000000002), outside today\'s limits with 41,000 players by its export bans, 40,500 by its settings now: there was nothing to delete on BattleMetrics.',
  "admin (1) removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
]);

// Each list removed was read a last time with its row locked, under its deletion lock, which the bot
// freed once it was deleted.
assert.deepStrictEqual(lockedReads, [2]);
assert.deepStrictEqual([...lockedByBot], []);

// Start again with an empty database.
function clear() {
  lists.clear();
  exportBans.clear();
  for (const done of [destroyed, counted, replies, audits, lockedReads]) done.length = 0;
  lockedElsewhere.clear();
  duringCount = null;
}

// A list over the cap by both counts in the preview whose count fails as it is checked again just
// before its removal is left, as whether it is still over the cap is not known: it is reported as
// failed, and the others carry on. One that breaks the points rules, which need no count, is
// removed all the same.
clear();
MEMBERS.set(11, 41000);
MEMBERS.set(12, 42000);
addList(5, 11, { CREATED: 43000 });
addList(6, 12, { CREATED: 44000 });
// Its threshold is below the lowest of 4.
addList(7, 3, { CREATED: 45000 }, [1, 1]);
const TIMED_OUT = 'Query execution was interrupted, maximum statement execution time exceeded';
await command.execute(
  interaction(async () => {
    MEMBERS.set(11, new Error(TIMED_OUT));
    MEMBERS.set(3, new Error(TIMED_OUT));
  })
);
MEMBERS.set(3, 45000);
assert.deepStrictEqual(counted, [11, 12, 3, 11, 12, 3]);
assert.deepStrictEqual(destroyed, [6, 7]);
assert.deepStrictEqual([...lists.keys()], [5]);
assert.deepStrictEqual(exportBans.get(5), { CREATED: 43000 });
const failedSummary = replies.at(-1);
assert.strictEqual(
  failedSummary.content,
  "Removed 2 of the 3 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics. 1 failed."
);
assert.deepStrictEqual(failedSummary.embeds[0].toJSON().description.split('\n'), [
  `**List 5** (#5): failed: It could not be checked again: ${TIMED_OUT}`,
  '**List 6** (#6): removed; there was nothing to delete on BattleMetrics',
  '**List 7** (#7): removed; there was nothing to delete on BattleMetrics'
]);
assert.deepStrictEqual(audits, [
  "admin (1) started removing 3 export ban lists outside today's limits.",
  `admin (1) could not remove export ban list "List 5" (ID: 5, Remote) of Steam user "Owner 5" (ID: 76561198000000005): It could not be checked again: ${TIMED_OUT}`,
  'admin (1) removed export ban list "List 6" (ID: 6, Remote) of Steam user "Owner 6" (ID: 76561198000000006), outside today\'s limits with 44,000 players by its export bans, 42,000 by its settings now: there was nothing to delete on BattleMetrics.',
  'admin (1) removed export ban list "List 7" (ID: 7, Remote) of Steam user "Owner 7" (ID: 76561198000000007), outside today\'s limits with 45,000 players by its export bans; they could not be counted by its settings now: there was nothing to delete on BattleMetrics.',
  "admin (1) removed 2 of the 3 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics. 1 failed."
]);

// A list its owner changes while it is checked again just before its removal, here by raising its
// threshold while its players are counted, is left: it is read once more after the check, so it is
// not removed as it was counted. The others carry on.
clear();
addList(8, 9, { CREATED: 41000 });
addList(9, 9, { CREATED: 42000 });
await command.execute(
  interaction(async () => {
    duringCount = () => {
      duringCount = null;
      lists.get(8).threshold = 10;
    };
  })
);
assert.deepStrictEqual(counted, [9, 9, 9, 9]);
assert.deepStrictEqual(destroyed, [9]);
assert.deepStrictEqual(lists.get(8).threshold, 10);
assert.deepStrictEqual(replies.at(-1).embeds[0].toJSON().description.split('\n'), [
  '**List 8** (#8): not removed, as it changed while it was being checked',
  '**List 9** (#9): removed; there was nothing to delete on BattleMetrics'
]);

// A list whose players cannot be counted by its settings now before the preview may be over the cap
// or not, so it is left, and the preview names it after the limits used. It holds up no other list,
// and one whose count fails but which breaks the points rules is removed with the rest.
clear();
MEMBERS.set(14, new Error(TIMED_OUT));
MEMBERS.set(3, new Error(TIMED_OUT));
addList(10, 14, { CREATED: 43000 });
// Their thresholds are below the lowest of 4, and only list 11 is over the cap.
addList(11, 3, { CREATED: 44000 }, [1, 1]);
addList(12, 3, { CREATED: 900 }, [1, 1]);
await command.execute(interaction(async () => {}));
MEMBERS.set(3, 45000);
const [uncountedPreview] = replies.filter((reply) => reply.components?.length > 0);
assert.ok(
  uncountedPreview.content.startsWith(
    "**2 export ban lists are outside today's limits.** Remove them? "
  )
);
assert.ok(
  uncountedPreview.content.endsWith(
    `\n1 export ban list over the cap by its export bans could not be counted by its settings now, so whether it is within the cap is not known, and it is left: #10 (${TIMED_OUT}). Run the command again later to check it.`
  )
);
assert.match(
  uncountedPreview.embeds[0].toJSON().description,
  /^\*\*List 11\*\* \(#11\) · Remote · .* · 44,000 players by its export bans; they could not be counted by its settings now\n↳ .* Whether it is within its type's cap is not known: /
);
assert.deepStrictEqual(counted, [14, 3, 3]);
assert.deepStrictEqual(destroyed, [11, 12]);
assert.deepStrictEqual([...lists.keys()], [10]);

// A list whose deletion lock another connection holds, as its owner is deleting it on the website,
// is left as it is, once it has been checked again, so the two never delete it at once. The others
// carry on, each removed under its own deletion lock, which is freed once it is deleted.
clear();
addList(13, 9, { CREATED: 41000 });
addList(14, 9, { CREATED: 42000 });
await command.execute(
  interaction(async () => {
    lockedElsewhere.add(13);
  })
);
assert.deepStrictEqual(counted, [9, 9, 9, 9]);
assert.deepStrictEqual(destroyed, [14]);
assert.deepStrictEqual([...lists.keys()], [13]);
assert.deepStrictEqual(lockedReads, [14]);
assert.deepStrictEqual([...lockedByBot], []);
const beingDeletedSummary = replies.at(-1);
assert.strictEqual(
  beingDeletedSummary.content,
  "Removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);
assert.deepStrictEqual(beingDeletedSummary.embeds[0].toJSON().description.split('\n'), [
  '**List 13** (#13): not removed, as it is already being deleted',
  '**List 14** (#14): removed; there was nothing to delete on BattleMetrics'
]);

console.log(
  'Export ban list limit checks passed: a list its owner has brought within the cap is left though its export bans are not updated yet, one over the cap by both counts is removed, one changed while it is checked just before its removal is left, one whose count fails is left unless it breaks the points rules, and one being deleted on the website is left.'
);
