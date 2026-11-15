import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import sourceKey from '../../scbl-lib/utils/ban-list-source-key.js';
import logText from '../../scbl-lib/utils/log-text.js';

// Exercise /banlist update, remove, suspend, resume and status without Discord or a database. The
// command and the helpers that change the database are the real ones; the database, the table of
// paused lists, Discord and the source checks are stand-ins that record what is done.
const calls = [];
const prompts = [];
const replies = [];
const audits = [];
let transactions = 0;
let confirmAnswer = true;
let counts = { bans: 0, steamUsers: 0, exportBanListConfigs: 0 };
// Whether a ban importer run holds its run lock.
let importerRunning = false;
// What the check of a new source says it found.
let checkResult = 'Found 3 bans.';

// The paused lists' rows, the ban importer's rows of BanListSyncs and of BanListPendingRemovals,
// the IDs of the bans the lists still have, whether the importer has made its tables yet, what a
// suspension answers, when not as the rows say, and the error marking a list's row fails with, if
// any.
let pausedRows = [];
let syncRows = [];
let removalRows = [];
let storedBans = [];
let tablesMissing = false;
let suspendAnswer = null;
let markError = null;
// The paused lists the importer's reputation check last settled players without.
let settled = [];
const SUSPENDED_AT = new Date('2026-10-29T12:00:00.000Z');
// When the ban list's type or source was last changed, by /banlist update, and when a save moves
// its updatedAt to, as Sequelize moves it on any save that is not silent.
const CHANGED_AT = new Date('2026-10-29T11:30:00.000Z');
const SAVED_AT = new Date('2026-10-29T11:50:00.000Z');
const noTable = () =>
  Object.assign(new Error("Table 'cbl.BanListSuspensions' doesn't exist"), {
    original: { errno: 1146 }
  });
const suspensions = {
  MAX_REASON_LENGTH: 500,
  isMissingTable: (err) => err?.original?.errno === 1146,
  async readSettledPausedBanLists() {
    return tablesMissing ? [] : [...settled];
  },
  async readPausedBanLists({ banList = null, missingTable = 'empty' } = {}) {
    if (tablesMissing) {
      if (missingTable === 'throw') throw noTable();
      return [];
    }
    return pausedRows
      .filter((row) => banList === null || row.banList === banList)
      .map((row) => ({ ...row }));
  },
  async suspendBanList(banList, values) {
    calls.push(['suspend', banList, { ...values }]);
    if (tablesMissing) throw noTable();
    if (suspendAnswer) return suspendAnswer;
    pausedRows = pausedRows.filter((row) => row.banList !== banList);
    const row = { banList, suspendedAt: SUSPENDED_AT, ...values, resumedAt: null };
    pausedRows.push(row);
    return { outcome: 'suspended', row: { ...row } };
  },
  async resumeBanList(banList) {
    calls.push(['resume', banList]);
    const row = pausedRows.find((paused) => paused.banList === banList);
    if (!row) return { outcome: 'not_paused', row: null };
    row.resumedAt = new Date(SUSPENDED_AT.getTime() + 60000);
    return { outcome: 'resuming', row: { ...row } };
  }
};
const BanListSync = {
  async findAll({ where, raw }) {
    assert.strictEqual(raw, true);
    if (tablesMissing) throw noTable();
    return syncRows.filter((row) => where.banList.includes(row.banList)).map((row) => ({ ...row }));
  }
};

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
    // The bans the importer holds back from removing, for /banlist status, and which of them the
    // lists still have.
    if (sql.includes('FROM BanListPendingRemovals')) {
      assert.strictEqual(
        sql,
        'SELECT banList, banId, heldAt FROM BanListPendingRemovals WHERE banList IN (:banListIDs)'
      );
      if (tablesMissing) throw noTable();
      return removalRows
        .filter(({ banList }) => replacements.banListIDs.includes(banList))
        .map((row) => ({ ...row }));
    }
    if (/^SELECT .* FROM Bans /.test(sql)) {
      assert.strictEqual(sql, 'SELECT id, banList FROM Bans WHERE id IN (:banIds)');
      return storedBans
        .filter((id) => replacements.banIds.includes(id))
        .map((id) => ({ id, banList: Number(id.split(',')[0]) }));
    }
    // The mark on a list's row that its source was changed, which sets nothing else, and nothing
    // for a list without a row.
    if (sql.startsWith('UPDATE BanListSyncs')) {
      assert.strictEqual(sql, 'UPDATE BanListSyncs SET replacePending = 1 WHERE banList = ?');
      calls.push(['mark source changed', transaction?.id, ...replacements]);
      if (tablesMissing) throw noTable();
      if (markError) throw markError;
      for (const row of syncRows) if (row.banList === replacements[0]) row.replacePending = 1;
      return;
    }
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
  // Every ban list, with its organisation, for /banlist status.
  async findAll({ include }) {
    assert.strictEqual(include[0].required, true);
    return [record];
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
// An embed keeps its fields, so a status's can be read, and leaves out the rest.
class EmbedBuilder {
  fields = [];
  addFields(...fields) {
    this.fields.push(...fields);
    return this;
  }

  setColor() {
    return this;
  }

  setTitle() {
    return this;
  }

  setDescription() {
    return this;
  }

  setFooter() {
    return this;
  }
}
const discord = {
  SlashCommandBuilder: function SlashCommandBuilder() {
    return builder();
  },
  EmbedBuilder,
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
  'scbl-lib/db/models': { Ban, BanList, ExportBanListConfig, Organisation: {} },
  'scbl-lib/db/sequelize': { Op: { ne: 'ne' }, QueryTypes: { SELECT: 'SELECT' } },
  'scbl-lib/db/ban-list-suspensions': suspensions,
  'scbl-lib/db/importer-models': { BanListSync },
  // The importer's key of a list's type and source, the real one, which the importer shares, and
  // the real logText, which keeps names in the log on one line and shown as written.
  'scbl-lib/utils': { logText, sourceKey }
};
const format = await load('../src/utils/format.js', {
  'discord.js': discord,
  'scbl-lib/utils': database['scbl-lib/utils']
});
const deletion = await load('../src/utils/delete-ban-lists.js', {
  ...database,
  './format.js': format
});
const { default: applyChanges } = await load('../src/utils/apply-changes.js', {
  './format.js': format
});
const status = await load('../src/utils/ban-list-status.js', {
  ...database,
  './user-error.js': { default: UserError }
});

const option = (value) => value;
const utils = {
  ...format,
  ...deletion,
  ...status,
  applyChanges,
  audit: (interaction, change) => audits.push(change),
  banListOption: option,
  banListSourceOption: option,
  banListTypeOption: option,
  async checkBanListSourceOption(interaction, type, source) {
    calls.push(['check source', type, source]);
    return checkResult;
  },
  async checkBanListSourceUnused() {},
  async confirm(interaction, content, confirmLabel) {
    calls.push(['confirm']);
    prompts.push({ content, confirmLabel });
    return confirmAnswer;
  },
  // The list of every ban list, as one reply with its title and lines.
  async paginate(interaction, title, lines) {
    await interaction.editReply({ title, lines: [...lines] });
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
  checkResult = 'Found 3 bans.';
  pausedRows = [];
  syncRows = [];
  removalRows = [];
  storedBans = [];
  tablesMissing = false;
  suspendAnswer = null;
  markError = null;
  settled = [];
  counts = { bans, steamUsers, exportBanListConfigs };
  record = {
    id: 5,
    name: 'Main',
    type: 'battlemetrics',
    source: 'old-list',
    updatedAt: CHANGED_AT,
    Organisation: { id: 2, name: 'Org' },
    async save(options) {
      calls.push(['save', options?.transaction?.id, this.type, this.source, this.name]);
      if (!options?.silent) this.updatedAt = SAVED_AT;
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
// saves the source and marks the list's row of the ban importer's, once the change is confirmed and
// no ban importer run is under way. The question gives what the check found of the new source. The
// players are queued for an update.
reset(3, 2);
await run('update', { banlist: '5', source: 'new-list' });
assert.deepStrictEqual(prompts, [
  {
    content:
      "Change the source of **Org** / **Main**? This deletes its 3 bans on 2 players, and the new source's bans are imported on the next ban importer run. Found 3 bans.",
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
  ['mark source changed', 1, 5],
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
assert.deepStrictEqual(calls.slice(-8), [
  ['confirm'],
  ['check run lock'],
  ['begin', 1],
  ['flags', 1, [5]],
  ['destroy bans', 1, [5]],
  ['save', 1, 'remote', 'https://x.test/b', 'Renamed'],
  ['mark source changed', 1, 5],
  ['commit', 1]
]);

// Nothing is changed when the change is not confirmed, as when the check warns of the new source,
// here that BattleMetrics does not list it for CBL, which the question gives before any ban is
// deleted.
reset(3, 2);
checkResult =
  'Found 2+ bans on the BattleMetrics ban list "Partner bans". **BattleMetrics does not list it among the ban lists the CBL organisation can see**, so its new bans are saved, but none are removed while BattleMetrics does not list it.';
confirmAnswer = false;
await run('update', { banlist: '5', source: 'new-list' });
assert.deepStrictEqual(
  prompts.map(({ content }) => content),
  [
    `Change the source of **Org** / **Main**? This deletes its 3 bans on 2 players, and the new source's bans are imported on the next ban importer run. ${checkResult}`
  ]
);
assert.ok(
  !calls.some(([call]) =>
    ['check run lock', 'begin', 'flags', 'destroy bans', 'save', 'mark source changed'].includes(
      call
    )
  )
);
assert.strictEqual(audits.length, 0);
assert.strictEqual(replies.length, 0);

// A list without bans gets its new source without being asked, and its row is marked all the same,
// or would be if it had one.
reset(0, 0);
await run('update', { banlist: '5', source: 'new-list' });
assert.strictEqual(prompts.length, 0);
assert.deepStrictEqual(calls.slice(-5), [
  ['check run lock'],
  ['begin', 1],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['mark source changed', 1, 5],
  ['commit', 1]
]);
assert.deepStrictEqual(audits, [
  'updated ban list "Main" (ID: 5) of organisation "Org" (ID: 2): source "old-list" → "new-list".'
]);

// A source changed back before the ban importer read the one it was changed to leaves the list's
// row with the source it is back to, so without the mark the importer would take that source's
// file as unchanged, or poll only its newest page, and the bans the first change deleted would not
// come back. So both changes mark the row, each in the transaction that saves it, including the
// second, which has no bans to delete and asks nothing.
reset(3, 2);
syncRows = [{ banList: 5, sourceKey: 'o'.repeat(64), state: 'ok', replacePending: 0 }];
await run('update', { banlist: '5', source: 'new-list' });
assert.deepStrictEqual(calls.slice(-6), [
  ['begin', 1],
  ['flags', 1, [5]],
  ['destroy bans', 1, [5]],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['mark source changed', 1, 5],
  ['commit', 1]
]);
assert.strictEqual(syncRows[0].replacePending, 1);
// The first change deleted the list's bans. The mark is cleared here only to see that the second
// change sets it too.
counts = { bans: 0, steamUsers: 0, exportBanListConfigs: 0 };
syncRows[0].replacePending = 0;
calls.length = 0;
prompts.length = 0;
await run('update', { banlist: '5', source: 'old-list' });
assert.strictEqual(prompts.length, 0);
assert.deepStrictEqual(calls, [
  ['check source', 'battlemetrics', 'old-list'],
  ['count bans', [5]],
  ['count bans', [5]],
  ['check run lock'],
  ['begin', 2],
  ['save', 2, 'battlemetrics', 'old-list', 'Main'],
  ['mark source changed', 2, 5],
  ['commit', 2]
]);
assert.strictEqual(syncRows[0].replacePending, 1);
assert.strictEqual(
  replies.at(-1).content,
  'Updated **Org** / **Main**. Found 3 bans. Its bans are re-imported on the next ban importer run.'
);

// Until the importer has made its tables there is no row to mark, and the change is saved all the
// same. Any other error marking the row rolls the change back, bans and all.
reset(3, 2);
tablesMissing = true;
await run('update', { banlist: '5', source: 'new-list' });
assert.deepStrictEqual(calls.slice(-3), [
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['mark source changed', 1, 5],
  ['commit', 1]
]);
assert.strictEqual(audits.length, 1);
reset(3, 2);
markError = Object.assign(new Error('Deadlock found when trying to get lock'), {
  original: { errno: 1213 }
});
await assert.rejects(
  run('update', { banlist: '5', source: 'new-list' }),
  (err) => err === markError
);
assert.deepStrictEqual(calls.slice(-2), [
  ['mark source changed', 1, 5],
  ['rollback', 1]
]);
assert.strictEqual(audits.length, 0);
assert.strictEqual(replies.length, 0);

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
  assert.ok(
    !calls.some(([call]) =>
      ['begin', 'flags', 'destroy bans', 'save', 'mark source changed'].includes(call)
    )
  );
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

const rejectsWith = (message) => (err) => {
  assert.ok(err instanceof UserError, String(err));
  assert.strictEqual(err.message, message);
  return true;
};
const paused = (fields = {}) => ({
  banList: 5,
  suspendedAt: SUSPENDED_AT,
  suspendedBy: 'admin (1)',
  reason: null,
  resumedAt: null,
  ...fields
});

// Suspending a list asks first, saying what it does to its bans, the import and how long its
// players take, then adds its row, as the admin who did it, with the reason given, and logs it.
reset(3, 2);
await run('suspend', { banlist: '5', reason: '  Dispute over appeals  ' });
assert.deepStrictEqual(prompts, [
  {
    content:
      "Suspend **Org** / **Main**? Its 3 bans on 2 players stop counting toward reputation and export ban lists, and are left out of the website's lists of bans. The ban importer stops importing it until it is resumed. Export bans follow from the next ban importer cycle, and players' reputation points within 1 cycle of it.",
    confirmLabel: 'Suspend ban list'
  }
]);
assert.deepStrictEqual(calls.slice(-2), [
  ['confirm'],
  ['suspend', 5, { by: 'admin (1)', reason: 'Dispute over appeals' }]
]);
assert.deepStrictEqual(audits, [
  'suspended ban list "Main" (ID: 5) of organisation "Org" (ID: 2), for the reason "Dispute over appeals".'
]);
assert.strictEqual(
  replies.at(-1).content,
  'Suspended **Org** / **Main**. Resume it with /banlist resume.'
);
// A large list's players take a cycle for each 1,000.
reset(30000, 4500);
await run('suspend', { banlist: '5' });
assert.match(prompts[0].content, /reputation points within 5 cycles of it\.$/);
assert.deepStrictEqual(calls.at(-1), ['suspend', 5, { by: 'admin (1)', reason: null }]);
assert.deepStrictEqual(audits, [
  'suspended ban list "Main" (ID: 5) of organisation "Org" (ID: 2).'
]);

// Nothing is changed when it is not confirmed, or the list is suspended already, which says since
// when and by whom. A resuming list is suspended again, and the question says it stops resuming.
reset(3, 2);
confirmAnswer = false;
await run('suspend', { banlist: '5' });
assert.ok(!calls.some(([call]) => call === 'suspend'));
assert.strictEqual(audits.length, 0);
reset(3, 2);
pausedRows = [paused({ reason: 'Dispute' })];
await assert.rejects(
  run('suspend', { banlist: '5' }),
  rejectsWith(
    `**Org** / **Main** is suspended already.\nSuspended since ${String(SUSPENDED_AT)} by admin (1): it is not imported, and its bans count for nothing.\nReason: Dispute`
  )
);
assert.strictEqual(prompts.length, 0);
reset(3, 2);
pausedRows = [paused({ resumedAt: new Date(SUSPENDED_AT.getTime() + 1) })];
await run('suspend', { banlist: '5' });
assert.match(prompts[0].content, /until it is resumed\. It stops resuming\. Export bans/);
assert.deepStrictEqual(calls.at(-1)[0], 'suspend');

// A list removed, or suspended by someone else, while the admin was asked changes nothing more.
reset(3, 2);
suspendAnswer = { outcome: 'gone', row: null };
await assert.rejects(
  run('suspend', { banlist: '5' }),
  rejectsWith('**Org** / **Main** was removed meanwhile, so nothing was suspended.')
);
assert.strictEqual(audits.length, 0);
reset(3, 2);
suspendAnswer = { outcome: 'already', row: paused({ suspendedBy: 'other (2)' }) };
await run('suspend', { banlist: '5' });
assert.strictEqual(
  replies.at(-1).content,
  '**Org** / **Main** was suspended meanwhile, so nothing was changed.'
);
assert.strictEqual(audits.length, 0);

// Until the ban importer has made its tables, nothing can be suspended or resumed, and no status
// shown, which the bot says.
const NO_TABLES =
  'The ban importer has not created its tables yet, so this cannot be done until its next cycle has run.';
for (const subcommand of ['suspend', 'resume', 'status']) {
  reset(3, 2);
  tablesMissing = true;
  await assert.rejects(
    run(subcommand, subcommand === 'status' ? {} : { banlist: '5' }),
    rejectsWith(NO_TABLES)
  );
  assert.strictEqual(prompts.length, 0);
  assert.strictEqual(audits.length, 0);
}

// Resuming a suspended list asks first, sets it resuming and logs it. A list that is not suspended,
// or is resuming already, is refused.
reset(3, 2);
pausedRows = [paused()];
await run('resume', { banlist: '5' });
assert.deepStrictEqual(prompts, [
  {
    content:
      "Resume **Org** / **Main**? The ban importer reads it in full on its next cycle, and its 3 bans on 2 players count again once it has caught up with it: once its reads have confirmed the bans its owner removed meanwhile, which takes at least 10 more minutes when there are any, and longer when it seems to have lost all of them, or a large part of them at once. /banlist status shows when. Export bans follow from the cycle after it counts again, and players' reputation points within 1 cycle of it.",
    confirmLabel: 'Resume ban list'
  }
]);
assert.deepStrictEqual(calls.at(-1), ['resume', 5]);
assert.deepStrictEqual(audits, ['resumed ban list "Main" (ID: 5) of organisation "Org" (ID: 2).']);
assert.strictEqual(
  replies.at(-1).content,
  'Resumed **Org** / **Main**. It counts again once the ban importer has caught up with it, which /banlist status shows.'
);
await assert.rejects(
  run('resume', { banlist: '5' }),
  rejectsWith(
    `**Org** / **Main** is resuming already.\nResuming since ${String(new Date(SUSPENDED_AT.getTime() + 60000))}, after being suspended since ${String(SUSPENDED_AT)} by admin (1): it is imported again, and its bans count again once the ban importer has read it in full and confirmed the bans it no longer has.`
  )
);
reset(3, 2);
await assert.rejects(
  run('resume', { banlist: '5' }),
  rejectsWith('**Org** / **Main** is not suspended.')
);
reset(3, 2);
pausedRows = [paused()];
confirmAnswer = false;
await run('resume', { banlist: '5' });
assert.ok(!calls.some(([call]) => call === 'resume'));

// A new source for a suspended list deletes its bans without queueing its players, as its bans
// count for nothing and the importer has settled its players, and its new source's bans are
// imported once it is resumed.
reset(3, 2);
pausedRows = [paused()];
settled = [5];
await run('update', { banlist: '5', source: 'new-list' });
assert.strictEqual(
  prompts[0].content,
  "Change the source of **Org** / **Main**? This deletes its 3 bans on 2 players, and the new source's bans are imported once it is resumed. Found 3 bans."
);
assert.deepStrictEqual(calls.slice(-5), [
  ['begin', 1],
  ['destroy bans', 1, [5]],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
  ['mark source changed', 1, 5],
  ['commit', 1]
]);
assert.strictEqual(
  replies.at(-1).content,
  'Updated **Org** / **Main**. Found 3 bans. Its bans are imported from the new source once it is resumed.'
);
// A resuming list's players are not queued either, but its new source is imported at once.
reset(3, 2);
pausedRows = [paused({ resumedAt: new Date(SUSPENDED_AT.getTime() + 1) })];
settled = [5];
await run('update', { banlist: '5', source: 'new-list' });
assert.match(prompts[0].content, /imported on the next ban importer run\. Found 3 bans\.$/);
assert.ok(!calls.some(([call]) => call === 'flags'));
// A list paused since the importer's reputation check last ran has players it has not settled, so
// they are queued as for any list.
reset(3, 2);
pausedRows = [paused()];
settled = [7];
await run('update', { banlist: '5', source: 'new-list' });
assert.ok(calls.some(([call]) => call === 'flags'));

// Removing a suspended list queues none of its players either, once the importer has settled them.
reset(3, 2, 1);
pausedRows = [paused()];
settled = [5];
await run('remove', { banlist: '5' });
assert.deepStrictEqual(calls.slice(-5), [
  ['begin', 1],
  ['destroy bans', 1, [5]],
  ['destroy export ban list configs', 1, [5]],
  ['destroy ban lists', 1, [5]],
  ['commit', 1]
]);
assert.strictEqual(
  replies.at(-1),
  'Removed **Org** / **Main**. It was paused, so its bans already counted for nothing.'
);
reset(3, 2, 1);
pausedRows = [paused()];
await run('remove', { banlist: '5' });
assert.deepStrictEqual(calls.slice(-6)[1], ['flags', 1, [5]]);
assert.strictEqual(
  replies.at(-1),
  "Removed **Org** / **Main**. Affected players' reputation is recalculated on the next ban importer run."
);

// A record of a ban of list 5 that the ban importer holds back from removing: held for an admin, or
// waiting for a confirming read.
const removal = (banId, held = false) => ({
  banList: 5,
  banId,
  heldAt: held ? new Date('2026-10-29T10:30:00.000Z') : null
});
const banIDs = (prefix, n) => Array.from({ length: n }, (_, i) => `5,${prefix}${i}`);

// The status of one list, or of every list, reads whether each is paused, its BanListSyncs row and
// the bans held back from removing it, and changes nothing. The row here is of the list's source.
reset(3, 2);
pausedRows = [paused({ reason: 'Dispute' })];
syncRows = [
  {
    banList: 5,
    sourceKey: sourceKey(record),
    replacePending: 0,
    state: 'held',
    lastSuccessAt: new Date('2026-10-29T11:00:00.000Z'),
    lastFullScanAt: new Date('2026-10-29T10:00:00.000Z'),
    storedCount: 3,
    headTotal: 4,
    lastError: null
  }
];
removalRows = [removal('5,a', true), removal('5,b'), removal('5,c')];
storedBans = ['5,a', '5,b', '5,c'];
await run('status', { banlist: '5' });
assert.strictEqual(replies.length, 1);
assert.strictEqual(replies[0].embeds.length, 1);
const importOf = (reply) => reply.embeds[0].fields.find(({ name }) => name === 'Import').value;
assert.strictEqual(
  importOf(replies[0]),
  `Imported, with removals held until they are confirmed · last imported ${String(new Date('2026-10-29T11:00:00.000Z'))} · last read in full ${String(new Date('2026-10-29T10:00:00.000Z'))}\n3 bans stored · 4 bans on BattleMetrics\nRemovals: 2 bans waiting for a confirming read, 1 ban held for an admin`
);
await run('status', {});
assert.strictEqual(replies.length, 2);
assert.deepStrictEqual(replies[1], {
  title: 'Ban lists: 1 list, 1 paused',
  lines: [
    `**Org** / **Main** (#5) · **suspended** · Imported, with removals held until they are confirmed · last imported ${String(new Date('2026-10-29T11:00:00.000Z'))} · 3 removals held`
  ]
});
assert.ok(!calls.some(([call]) => ['begin', 'flags', 'suspend', 'resume', 'save'].includes(call)));
const { readStatus } = status;
const read = await readStatus([record]);
// Made in the module's context, so copied into this one to compare.
assert.deepStrictEqual({ ...read.removals.get(5) }, { waiting: 2, held: 1 });
assert.strictEqual(read.paused.get(5).reason, 'Dispute');
assert.strictEqual(read.syncs.get(5).state, 'held');
assert.strictEqual(read.syncs.get(5).sourceChange, null);
assert.strictEqual(
  format.describeImport(read.syncs.get(5), read.removals.get(5)),
  `Imported, with removals held until they are confirmed · last imported ${String(new Date('2026-10-29T11:00:00.000Z'))} · last read in full ${String(new Date('2026-10-29T10:00:00.000Z'))}\n3 bans stored · 4 bans on BattleMetrics\nRemovals: 2 bans waiting for a confirming read, 1 ban held for an admin`
);
assert.strictEqual(format.describeImport(null), 'Not imported yet.');
assert.strictEqual(format.describePause(null), 'Not paused: it is imported, and its bans count.');
assert.deepStrictEqual(
  [
    format.pauseState(null),
    format.pauseState(paused()),
    format.pauseState(paused({ resumedAt: SUSPENDED_AT }))
  ],
  [null, 'suspended', 'resuming']
);

// Once a list's type or source was changed, until the ban importer has read it since, its row and
// the bans held back from removing it are of its old source, so its status says only that its
// source was changed: not the row's state, counts or error, nor its removals, also of bans the list
// still has, as a source changed by hand keeps its old bans until the importer replaces them. Here
// the row is still of the old source, as the importer has not tried the list since, and held 1,200
// bans, or failed, or lost access.
const changedSync = {
  banList: 5,
  sourceKey: sourceKey({ type: 'remote', source: 'https://old.test/bans.txt' }),
  replacePending: 1,
  state: 'held',
  lastAttemptAt: new Date('2026-10-29T11:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-29T11:00:00.000Z'),
  lastFullScanAt: new Date('2026-10-29T10:00:00.000Z'),
  storedCount: 1200,
  headTotal: null,
  lastError: null
};
const oldStates = [
  {},
  { state: 'failing', lastError: 'Could not fetch the remote ban list: HTTP 503.' },
  {
    state: 'access_lost',
    lastError:
      'BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list), so its bans are not checked for removal.'
  }
];
const UNREAD = 'Its type or source was changed, and the ban importer has not read it since.';
const UNREAD_LINE = '**Org** / **Main** (#5) · type or source changed, not read since';
for (const fields of oldStates) {
  reset(0, 0);
  syncRows = [{ ...changedSync, ...fields }];
  removalRows = banIDs('old', 1200).map((banId) => removal(banId, true));
  storedBans = banIDs('old', 1200);
  await run('status', { banlist: '5' });
  await run('status', {});
  assert.deepStrictEqual(
    [importOf(replies[0]), replies[1].lines],
    [UNREAD, [UNREAD_LINE]],
    JSON.stringify(fields)
  );
}
const changed = await readStatus([record]);
assert.strictEqual(changed.syncs.get(5).sourceChange, 'unread');
assert.strictEqual(changed.removals.has(5), false);
// A row of another source says so even when the importer has finished with it, as it no longer has
// the list's source.
syncRows = [{ ...changedSync, replacePending: 0 }];
assert.strictEqual(format.describeImport((await readStatus([record])).syncs.get(5)), UNREAD);

// So does a row of the list's source that says the old bans are still to be replaced, but whose
// latest attempt is from before the list's type or source was last changed, as when the source was
// changed back before the importer read the one it was changed to: its state, counts and error are
// from before the change, and the bans it held were deleted with it.
for (const fields of oldStates) {
  reset(0, 0);
  syncRows = [{ ...changedSync, sourceKey: sourceKey(record), ...fields }];
  removalRows = banIDs('old', 1200).map((banId) => removal(banId, true));
  await run('status', { banlist: '5' });
  await run('status', {});
  assert.deepStrictEqual(
    [importOf(replies[0]), replies[1].lines],
    [UNREAD, [UNREAD_LINE]],
    JSON.stringify(fields)
  );
  assert.strictEqual((await readStatus([record])).syncs.get(5).sourceChange, 'unread');
}

// Once the importer has tried the list since, its row is of the list's source, so the status gives
// all of it, saying first that the importer has not finished replacing the old bans, while the row
// says so. Here BattleMetrics does not list the new source for CBL, so the importer reads it in full
// and saves its bans on every run, but removes none of its bans, and has not replaced the old ones.
// The records of the bans the change deleted are left out, as the importer leaves them out.
const ATTEMPTED_AT = new Date('2026-10-29T11:40:00.000Z');
const replacingSync = {
  ...changedSync,
  sourceKey: sourceKey(record),
  state: 'access_lost',
  lastAttemptAt: ATTEMPTED_AT,
  lastSuccessAt: ATTEMPTED_AT,
  lastFullScanAt: ATTEMPTED_AT,
  storedCount: 12,
  headTotal: 12,
  lastError:
    'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.'
};
const REPLACING =
  'Its type or source was changed, and the ban importer has not finished replacing its old bans yet.';
const REPLACING_IMPORT = `${REPLACING}\nCBL cannot read it on BattleMetrics · last imported ${String(ATTEMPTED_AT)} · last read in full ${String(ATTEMPTED_AT)}\n12 bans stored · 12 bans on BattleMetrics\nLast error: ${replacingSync.lastError}`;
reset(0, 0);
syncRows = [{ ...replacingSync }];
removalRows = banIDs('old', 40).map((banId) => removal(banId, true));
storedBans = banIDs('new', 12);
await run('status', { banlist: '5' });
await run('status', {});
assert.strictEqual(importOf(replies[0]), REPLACING_IMPORT);
assert.deepStrictEqual(replies[1].lines, [
  `**Org** / **Main** (#5) · type or source changed, old bans not replaced yet · CBL cannot read it on BattleMetrics · last imported ${String(ATTEMPTED_AT)}`
]);
const replacing = await readStatus([record]);
assert.strictEqual(replacing.syncs.get(5).sourceChange, 'replacing');
assert.strictEqual(replacing.removals.has(5), false);
// A source changed by hand still has its old bans, and the importer's first complete read of the
// new source left those it did not find waiting for a confirming read, which the status gives, as
// the list still has them, though not the records of bans it no longer has. Once the replacing is
// done, the row no longer says so, and nor does the status.
reset(0, 0);
syncRows = [{ ...replacingSync, state: 'held', storedCount: 40, headTotal: 10, lastError: null }];
removalRows = [
  ...banIDs('old', 30).map((banId) => removal(banId)),
  ...banIDs('gone', 5).map((banId) => removal(banId, true))
];
storedBans = [...banIDs('old', 30), ...banIDs('new', 10)];
await run('status', { banlist: '5' });
await run('status', {});
const heldLine = `Imported, with removals held until they are confirmed · last imported ${String(ATTEMPTED_AT)}`;
assert.strictEqual(
  importOf(replies[0]),
  `${REPLACING}\n${heldLine} · last read in full ${String(ATTEMPTED_AT)}\n40 bans stored · 10 bans on BattleMetrics\nRemovals: 30 bans waiting for a confirming read, 0 bans held for an admin`
);
assert.deepStrictEqual(replies[1].lines, [
  `**Org** / **Main** (#5) · type or source changed, old bans not replaced yet · ${heldLine} · 30 removals held`
]);
syncRows[0].replacePending = 0;
assert.strictEqual(format.summariseImport((await readStatus([record])).syncs.get(5)), heldLine);

// A rename leaves the list's updatedAt as it was, so a list whose old bans are still being replaced
// keeps its status, rather than being taken for one the importer has not read since the change. A
// new type or source moves it, so once the source is changed and changed back, the same row, of
// the source the list is back to, is taken for one from before the change.
reset(0, 0);
syncRows = [{ ...replacingSync }];
await run('update', { banlist: '5', name: 'Renamed' });
await run('status', { banlist: '5' });
assert.strictEqual(importOf(replies.at(-1)), REPLACING_IMPORT);
await run('update', { banlist: '5', source: 'new-list' });
await run('update', { banlist: '5', source: 'old-list' });
await run('status', { banlist: '5' });
assert.strictEqual(importOf(replies.at(-1)), UNREAD);

// Resuming a list the importer has not read since its type or source was changed, or whose old bans
// it has not finished replacing, asks only that, as the importer replaces them with the new
// source's without holding them for an admin. Here the list has no bans, as /banlist update deleted
// them with the change. One that still has bans, as its source was changed by hand, which keeps its
// old ones, or as the importer has saved some of the new source's, catches up only once the
// importer's reads have confirmed those the new source does not have, as any list does, so the
// question says that too.
const CONFIRMING =
  ': once its reads have confirmed which of its 12 bans on 5 players the new source does not have, which takes at least 10 more minutes when there are any';
for (const [sync, changedLine] of [
  [changedSync, UNREAD],
  [replacingSync, REPLACING]
]) {
  for (const [bans, steamUsers, confirming] of [
    [0, 0, ''],
    [12, 5, CONFIRMING]
  ]) {
    reset(bans, steamUsers);
    pausedRows = [paused()];
    syncRows = [{ ...sync }];
    await run('resume', { banlist: '5' });
    assert.strictEqual(
      prompts[0].content,
      `Resume **Org** / **Main**? ${changedLine} The ban importer reads it in full on its next cycle, and the list counts again once it has caught up with it${confirming}. /banlist status shows when. Export bans follow from the cycle after it counts again, and players' reputation points within 1 cycle of it.`
    );
    assert.deepStrictEqual(calls.at(-1), ['resume', 5]);
  }
}

// Names and reasons are as admins typed them, so the log keeps each on one line and shows it as
// written, as the website's lines show names (logText): a line break cannot start what looks like
// another entry, Markdown is shown as typed, and a character that turns text around becomes a
// space. A rename gives both names so. The replies escape names with bold only, which this test's
// escapeMarkdown leaves as they are, so they are as typed.
reset(3, 2);
record.name = 'Main\n**x** ||y||';
record.Organisation = { id: 2, name: 'Org_\u202eA' };
const LOGGED =
  'ban list "Main \\*\\*x\\*\\* \\|\\|y\\|\\|" (ID: 5) of organisation "Org\\_ A" (ID: 2)';
await run('suspend', { banlist: '5', reason: 'Dispute\n[DiscordBot][1] admin (1) *resumed*' });
assert.deepStrictEqual(audits, [
  `suspended ${LOGGED}, for the reason "Dispute \\[DiscordBot\\]\\[1\\] admin (1) \\*resumed\\*".`
]);
assert.strictEqual(
  replies.at(-1).content,
  'Suspended **Org_\u202eA** / **Main\n**x** ||y||**. Resume it with /banlist resume.'
);
reset(3, 2);
record.name = 'Main\n**x** ||y||';
record.Organisation = { id: 2, name: 'Org_\u202eA' };
await run('update', { banlist: '5', name: 'New\n_name_' });
assert.deepStrictEqual(audits, [
  `updated ${LOGGED}: name "Main \\*\\*x\\*\\* \\|\\|y\\|\\|" → "New \\_name\\_".`
]);
assert.strictEqual(replies.at(-1).content, 'Updated **Org_\u202eA** / **New\n_name_**.');

console.log(
  "Ban list command checks passed: renames keep bans, source changes delete them once confirmed and only while no import runs, and mark the importer's row, also when changed back, removal, suspending and resuming lists, which then queue no players, and their status, which leaves out a changed source's old state until the importer has read the list since, and then gives the new one's while its old bans are being replaced, also once the list is renamed."
);
