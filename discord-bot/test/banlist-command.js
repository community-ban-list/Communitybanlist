import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise /banlist update and /banlist remove without Discord or a database. The command and the
// helpers that change the database are the real ones; the database, Discord and the source checks
// are stand-ins that record what is done.
const calls = [];
const prompts = [];
const replies = [];
const audits = [];
let transactions = 0;
let confirmAnswer = true;
let counts = { bans: 0, steamUsers: 0, exportBanListConfigs: 0 };
// Whether a ban importer run holds its run lock.
let importerRunning = false;

const sequelize = {
  async transaction(callback) {
    const transaction = { id: ++transactions };
    calls.push(['begin', transaction.id]);
    try {
      const value = await callback(transaction);
      calls.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      calls.push(['rollback', transaction.id]);
      throw err;
    }
  },
  async query(sql, { replacements, transaction }) {
    // The banned players are queued for the reputation and export updates.
    assert.match(
      sql,
      /SET\s+SU\.lastRefreshedExport = NULL,\s+SU\.lastRefreshedReputationPoints = NULL,\s+SU\.lastRefreshedReputationRank = NULL/
    );
    calls.push(['flags', transaction?.id, [...replacements.banListIDs]]);
  }
};
const Ban = {
  async count({ where, distinct, col }) {
    calls.push(['count bans', [...where.banList]]);
    if (distinct) {
      assert.strictEqual(col, 'steamUser');
      return counts.steamUsers;
    }
    return counts.bans;
  },
  async destroy({ where, transaction }) {
    calls.push(['destroy bans', transaction?.id, [...where.banList]]);
  }
};
const BanList = {
  // No other ban list of the organisation has the name being checked.
  async findOne() {
    return null;
  },
  async destroy({ where, transaction }) {
    calls.push(['destroy ban lists', transaction?.id, [...where.id]]);
  }
};
const ExportBanListConfig = {
  async count() {
    return counts.exportBanListConfigs;
  },
  async destroy({ where, transaction }) {
    calls.push(['destroy export ban list configs', transaction?.id, [...where.banList]]);
  }
};

// The slash command is built when the module loads; any builder call returns another builder.
const builder = () =>
  new Proxy(
    {},
    {
      get:
        () =>
        (...args) => {
          for (const arg of args) if (typeof arg === 'function') arg(builder());
          return builder();
        }
    }
  );
const discord = {
  SlashCommandBuilder: function SlashCommandBuilder() {
    return builder();
  },
  EmbedBuilder: function EmbedBuilder() {
    return builder();
  },
  escapeMarkdown: (text) => text,
  time: (date) => String(date),
  TimestampStyles: {}
};

class UserError extends Error {}

const context = vm.createContext({});
async function load(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency of ${path}: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  return module.namespace;
}

const database = {
  'scbl-lib/db': {
    sequelize,
    async isRunLockHeld() {
      calls.push(['check run lock']);
      return importerRunning;
    }
  },
  'scbl-lib/db/models': { Ban, BanList, ExportBanListConfig },
  'scbl-lib/db/sequelize': { Op: { ne: 'ne' } }
};
const format = await load('../src/utils/format.js', { 'discord.js': discord });
const deletion = await load('../src/utils/delete-ban-lists.js', {
  ...database,
  './format.js': format
});
const { default: applyChanges } = await load('../src/utils/apply-changes.js', {});

const option = (value) => value;
const utils = {
  ...format,
  ...deletion,
  applyChanges,
  audit: (interaction, change) => audits.push(change),
  banListOption: option,
  banListSourceOption: option,
  banListTypeOption: option,
  async checkBanListSourceOption(interaction, type, source) {
    calls.push(['check source', type, source]);
    return 'Found 3 bans.';
  },
  async checkBanListSourceUnused() {},
  async confirm(interaction, content, confirmLabel) {
    calls.push(['confirm']);
    prompts.push({ content, confirmLabel });
    return confirmAnswer;
  },
  findBanList: async () => record,
  findOrganisation: async () => record.Organisation,
  organisationOption: option,
  parseBanListSource: (type, input) => input.trim(),
  skipCheckOption: option,
  suggestBanLists() {},
  suggestOrganisations() {},
  UserError
};
const { default: command } = await load('../src/commands/banlist.js', {
  ...database,
  'discord.js': discord,
  '../utils/index.js': utils
});

// The ban list being changed, as findBanList returns it.
let record;
function reset(bans = 0, steamUsers = 0, exportBanListConfigs = 0) {
  for (const list of [calls, prompts, replies, audits]) list.length = 0;
  transactions = 0;
  confirmAnswer = true;
  importerRunning = false;
  counts = { bans, steamUsers, exportBanListConfigs };
  record = {
    id: 5,
    name: 'Main',
    type: 'battlemetrics',
    source: 'old-list',
    Organisation: { id: 2, name: 'Org' },
    async save(options) {
      calls.push(['save', options?.transaction?.id, this.type, this.source, this.name]);
    }
  };
}
function run(subcommand, options) {
  return command.execute({
    user: { tag: 'admin', id: '1' },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null
    },
    async editReply(reply) {
      replies.push(reply);
    }
  });
}

// Renaming a list keeps its bans, without asking first.
reset(3, 2);
await run('update', { banlist: '5', name: 'Renamed' });
assert.deepStrictEqual(calls, [
  ['begin', 1],
  ['save', 1, 'battlemetrics', 'old-list', 'Renamed'],
  ['commit', 1]
]);
assert.strictEqual(prompts.length, 0);
assert.strictEqual(replies.length, 1);
assert.strictEqual(replies[0].content, 'Updated **Org** / **Renamed**.');
assert.deepStrictEqual(audits, [
  'updated ban list "Main" (ID: 5) of organisation "Org" (ID: 2): name "Main" → "Renamed".'
]);

// A new source deletes the list's bans, which came from the old one, in the same transaction that
// saves the source, once the change is confirmed and no ban importer run is under way. The players
// are queued for an update.
reset(3, 2);
await run('update', { banlist: '5', source: 'new-list' });
assert.deepStrictEqual(prompts, [
  {
    content:
      "Change the source of **Org** / **Main**? This deletes its 3 bans on 2 players, and the new source's bans are imported on the next ban importer run.",
    confirmLabel: 'Change source'
  }
]);
assert.deepStrictEqual(calls, [
  ['check source', 'battlemetrics', 'new-list'],
  ['count bans', [5]],
  ['count bans', [5]],
  ['confirm'],
  ['check run lock'],
  ['begin', 1],
  ['flags', 1, [5]],
  ['destroy bans', 1, [5]],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['commit', 1]
]);
assert.strictEqual(
  replies.at(-1).content,
  'Updated **Org** / **Main**. Found 3 bans. Its bans are re-imported on the next ban importer run.'
);
assert.deepStrictEqual(audits, [
  'updated ban list "Main" (ID: 5) of organisation "Org" (ID: 2): source "old-list" → "new-list", deleting 3 bans on 2 players.'
]);

// So does a new type, here with a new name too.
reset(1, 1);
await run('update', { banlist: '5', name: 'Renamed', type: 'remote', source: 'https://x.test/b' });
assert.match(
  prompts[0].content,
  /^Change the source of \*\*Org\*\* \/ \*\*Main\*\*\? .* 1 ban on 1 player,/
);
assert.deepStrictEqual(calls.slice(-7), [
  ['confirm'],
  ['check run lock'],
  ['begin', 1],
  ['flags', 1, [5]],
  ['destroy bans', 1, [5]],
  ['save', 1, 'remote', 'https://x.test/b', 'Renamed'],
  ['commit', 1]
]);

// Nothing is changed when the change is not confirmed.
reset(3, 2);
confirmAnswer = false;
await run('update', { banlist: '5', source: 'new-list' });
assert.strictEqual(prompts.length, 1);
assert.ok(
  !calls.some(([call]) =>
    ['check run lock', 'begin', 'flags', 'destroy bans', 'save'].includes(call)
  )
);
assert.strictEqual(audits.length, 0);
assert.strictEqual(replies.length, 0);

// A list without bans gets its new source without being asked.
reset(0, 0);
await run('update', { banlist: '5', source: 'new-list' });
assert.strictEqual(prompts.length, 0);
assert.deepStrictEqual(calls.slice(-4), [
  ['check run lock'],
  ['begin', 1],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['commit', 1]
]);
assert.deepStrictEqual(audits, [
  'updated ban list "Main" (ID: 5) of organisation "Org" (ID: 2): source "old-list" → "new-list".'
]);

// While a ban importer run is under way, which could save the old source's bans again after they
// are deleted, a new type or source is refused once confirmed, and nothing is changed, with or
// without bans to delete. A rename still works.
for (const [bans, steamUsers] of [
  [3, 2],
  [0, 0]
]) {
  reset(bans, steamUsers);
  importerRunning = true;
  await assert.rejects(
    run('update', { banlist: '5', name: 'Renamed', type: 'remote', source: 'https://x.test/b' }),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.strictEqual(
        err.message,
        'The ban importer is running, so nothing was changed. Change the type or source again once the run has finished; renaming still works meanwhile.'
      );
      return true;
    }
  );
  assert.strictEqual(prompts.length, bans > 0 ? 1 : 0);
  assert.deepStrictEqual(calls.at(-1), ['check run lock']);
  assert.ok(!calls.some(([call]) => ['begin', 'flags', 'destroy bans', 'save'].includes(call)));
  assert.strictEqual(audits.length, 0);
  assert.strictEqual(replies.length, 0);
}
reset(3, 2);
importerRunning = true;
await run('update', { banlist: '5', name: 'Renamed' });
assert.deepStrictEqual(calls, [
  ['begin', 1],
  ['save', 1, 'battlemetrics', 'old-list', 'Renamed'],
  ['commit', 1]
]);

// Removing a list still deletes its bans, its export ban list configs and the list together.
reset(3, 2, 1);
await run('remove', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  'Remove **Org** / **Main**? This permanently deletes 3 bans on 2 players and 1 export ban list config.'
);
assert.deepStrictEqual(calls.slice(-6), [
  ['begin', 1],
  ['flags', 1, [5]],
  ['destroy bans', 1, [5]],
  ['destroy export ban list configs', 1, [5]],
  ['destroy ban lists', 1, [5]],
  ['commit', 1]
]);

console.log(
  'Ban list command checks passed: renames keep bans, source changes delete them once confirmed and only while no import runs, and removal.'
);
