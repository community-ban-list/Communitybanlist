import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import sourceKey from '../../scbl-lib/utils/ban-list-source-key.js';
import logText from '../../scbl-lib/utils/log-text.js';

// Exercise /banlist update, remove, suspend, resume, status, resync and confirm-removal without
// Discord or a database. The command and the helpers that change the database are the real ones;
// the database, the table of paused lists, Discord and the source checks are stand-ins that record
// what is done.
const calls = [];
const prompts = [];
const replies = [];
const audits = [];
let transactions = 0;
let confirmAnswer = true;
// What happens while the admin is asked, e.g. a cycle of the ban importer changing a list's hold.
let whileAsked = null;
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
// The importer's rows of BanListHolds, whether that table is still to be made, as it came with a
// later migration than the others, and whether a list's row of BanListSyncs is gone by the time the
// bot marks it, e.g. as the list was removed meanwhile.
let holdRows = [];
let holdsMissing = false;
let goneAtMark = false;
// The database's clock, which the marks of a list's row set its times by.
const DB_NOW = new Date();
const HOUR = 60 * 60 * 1000;
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
  async query(sql, { replacements, transaction, type }) {
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
    // Why the importer holds the bans it holds for an admin.
    if (sql.includes('FROM BanListHolds')) {
      assert.strictEqual(
        sql,
        'SELECT banList, reason, storedCount FROM BanListHolds WHERE banList IN (:banListIDs)'
      );
      assert.strictEqual(type, 'SELECT');
      if (tablesMissing || holdsMissing) throw noTable();
      return holdRows
        .filter(({ banList }) => replacements.banListIDs.includes(banList))
        .map((row) => ({ ...row }));
    }
    // The mark on a list's row that its source was changed, which sets nothing else, and nothing
    // for a list without a row.
    if (sql === 'UPDATE BanListSyncs SET replacePending = 1 WHERE banList = ?') {
      calls.push(['mark source changed', transaction?.id, ...replacements]);
      if (tablesMissing) throw noTable();
      if (markError) throw markError;
      for (const row of syncRows) if (row.banList === replacements[0]) row.replacePending = 1;
      return;
    }
    // The marks that a list is to be read in full, and that an admin confirmed the removal of its
    // held bans, which set nothing else, by the database's clock, and only in a row of the list's
    // current source. Each resolves with how many rows it changed, as MySQL counts them for
    // Sequelize, which connects without CLIENT_FOUND_ROWS: a row found as the mark would set it is
    // not counted.
    if (sql.startsWith('UPDATE BanListSyncs')) {
      const marks = {
        'UPDATE BanListSyncs SET nextFullScanAt = UTC_TIMESTAMP(3) WHERE banList = ? AND sourceKey = ?':
          ['read in full', { nextFullScanAt: DB_NOW }],
        'UPDATE BanListSyncs SET remoteEtag = NULL, remoteLastModified = NULL, remoteBodyHash = NULL WHERE banList = ? AND sourceKey = ?':
          ['forget file', { remoteEtag: null, remoteLastModified: null, remoteBodyHash: null }],
        'UPDATE BanListSyncs SET allowFullRemovalUntil = UTC_TIMESTAMP(3) + INTERVAL 2 HOUR, nextFullScanAt = UTC_TIMESTAMP(3) WHERE banList = ? AND sourceKey = ?':
          [
            'confirm removal, read in full',
            {
              allowFullRemovalUntil: new Date(DB_NOW.getTime() + 2 * HOUR),
              nextFullScanAt: DB_NOW
            }
          ],
        'UPDATE BanListSyncs SET allowFullRemovalUntil = UTC_TIMESTAMP(3) + INTERVAL 2 HOUR WHERE banList = ? AND sourceKey = ?':
          ['confirm removal', { allowFullRemovalUntil: new Date(DB_NOW.getTime() + 2 * HOUR) }]
      };
      assert.ok(marks[sql], `Unexpected statement: ${sql}`);
      assert.strictEqual(type, 'BULKUPDATE');
      const [mark, values] = marks[sql];
      calls.push([mark, ...replacements]);
      if (tablesMissing) throw noTable();
      if (goneAtMark) syncRows = syncRows.filter((row) => row.banList !== replacements[0]);
      const rows = syncRows.filter(
        (row) => row.banList === replacements[0] && row.sourceKey === replacements[1]
      );
      const changed = rows.filter((row) =>
        Object.entries(values).some(([column, value]) => row[column] !== value)
      );
      for (const row of rows) Object.assign(row, values);
      return changed.length;
    }
    // A list's row of its current source, looked for, or read for until when an admin's
    // confirmation lasts.
    if (sql.startsWith('SELECT') && sql.includes('FROM BanListSyncs')) {
      const reads = {
        'SELECT banList FROM BanListSyncs WHERE banList = ? AND sourceKey = ?': [
          'look for row',
          ({ banList }) => ({ banList })
        ],
        'SELECT allowFullRemovalUntil FROM BanListSyncs WHERE banList = ? AND sourceKey = ?': [
          'read confirmation',
          ({ allowFullRemovalUntil }) => ({ allowFullRemovalUntil })
        ]
      };
      assert.ok(reads[sql], `Unexpected statement: ${sql}`);
      assert.strictEqual(type, 'SELECT');
      const [read, columns] = reads[sql];
      calls.push([read, ...replacements]);
      return syncRows
        .filter((row) => row.banList === replacements[0] && row.sourceKey === replacements[1])
        .map(columns);
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
  'scbl-lib/db/sequelize': {
    Op: { ne: 'ne' },
    QueryTypes: { SELECT: 'SELECT', BULKUPDATE: 'BULKUPDATE' }
  },
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
  audit: (interaction, change, { important = false } = {}) =>
    audits.push(important ? `[important] ${change}` : change),
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
    if (whileAsked) await whileAsked();
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
  whileAsked = null;
  importerRunning = false;
  checkResult = 'Found 3 bans.';
  pausedRows = [];
  syncRows = [];
  removalRows = [];
  storedBans = [];
  tablesMissing = false;
  suspendAnswer = null;
  markError = null;
  holdRows = [];
  holdsMissing = false;
  goneAtMark = false;
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

// Until the ban importer has made its tables, nothing can be suspended, resumed, read in full or
// confirmed, and no status shown, which the bot says.
const NO_TABLES =
  'The ban importer has not created its tables yet, so this cannot be done until its next cycle has run.';
for (const subcommand of ['suspend', 'resume', 'status', 'resync', 'confirm-removal']) {
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
      "Resume **Org** / **Main**? The ban importer reads it in full on its next cycle, and its 3 bans on 2 players count again once it has caught up with it: once its reads have confirmed the bans its owner removed meanwhile, which takes a later read, at least 10 minutes after the first read that missed them, when at least 10 of them, and 5% of the list, are missing, and longer when it seems to have lost all of them, or a large part of them at once. /banlist status shows when. Export bans follow from the cycle after it counts again, and players' reputation points within 1 cycle of it.",
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
// The list is suspended, and its held ban, without a row of BanListHolds, is shown as held as the
// list lost all of its bans (see whyHeld in ban-importer/src/apply-list.js).
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
const fieldOf = (reply, field) => reply.embeds[0].fields.find(({ name }) => name === field)?.value;
const importOf = (reply) => fieldOf(reply, 'Import');
const HELD_AT_TEXT = String(new Date('2026-10-29T10:30:00.000Z'));
assert.strictEqual(
  importOf(replies[0]),
  `Imported, with removals held until they are confirmed · last imported ${String(new Date('2026-10-29T11:00:00.000Z'))} · last read in full ${String(new Date('2026-10-29T10:00:00.000Z'))}\n3 bans stored · 4 bans on BattleMetrics\nRemovals: 2 bans waiting for a confirming read, 1 ban held for an admin`
);
assert.strictEqual(
  fieldOf(replies[0], 'Held for an admin'),
  `1 ban since ${HELD_AT_TEXT}, as a complete read found none of the bans it had then, which more likely means that its source broke. They are kept until one of those the hold began with comes back, or an admin confirms the removal.\nOnce it is resumed, if the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.`
);
await run('status', {});
assert.strictEqual(replies.length, 2);
assert.deepStrictEqual(replies[1], {
  title: 'Ban lists: 1 list, 1 paused',
  lines: [
    `**Org** / **Main** (#5) · **suspended** · Imported, with removals held until they are confirmed · last imported ${String(new Date('2026-10-29T11:00:00.000Z'))} · **1 ban held for an admin, as it lost all of them** · 2 removals waiting for a confirming read`
  ]
});
assert.ok(!calls.some(([call]) => ['begin', 'flags', 'suspend', 'resume', 'save'].includes(call)));
const { readStatus } = status;
const read = await readStatus([record]);
// Made in the module's context, so copied into this one to compare, the time by its milliseconds.
const { heldSince, heldLast, ...removalCounts } = read.removals.get(5);
assert.deepStrictEqual({ ...removalCounts }, { waiting: 2, held: 1 });
assert.strictEqual(heldSince.getTime(), new Date('2026-10-29T10:30:00.000Z').getTime());
assert.strictEqual(heldLast.getTime(), heldSince.getTime());
assert.deepStrictEqual(
  { ...read.holds.get(5), since: read.holds.get(5).since.getTime() },
  { kind: 'full', held: 1, waiting: 2, since: heldSince.getTime() }
);
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
  // An admin's confirmation of a removal of the old source's bans (see fullRemovalAllowed in
  // ban-importer/src/ban-importer.js).
  { allowFullRemovalUntil: new Date(Date.now() + HOUR) },
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

// So does a row of the list's source that says the switch is still under way, but whose
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
// all of it, saying first that the importer has not finished switching it to the new source, while
// the row says so. Here BattleMetrics does not list the new source for CBL, so the importer reads it
// in full and saves its bans on every run, but removes none of its bans, so the switch is not done.
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
  'Its type or source was changed, and the ban importer has not finished switching it to the new source yet.';
const REPLACING_IMPORT = `${REPLACING}\nCBL cannot read it on BattleMetrics · last imported ${String(ATTEMPTED_AT)} · last read in full ${String(ATTEMPTED_AT)}\nNext read in full: on the next cycle\n12 bans stored · 12 bans on BattleMetrics\nLast error: ${replacingSync.lastError}`;
reset(0, 0);
syncRows = [{ ...replacingSync }];
removalRows = banIDs('old', 40).map((banId) => removal(banId, true));
storedBans = banIDs('new', 12);
await run('status', { banlist: '5' });
await run('status', {});
assert.strictEqual(importOf(replies[0]), REPLACING_IMPORT);
assert.deepStrictEqual(replies[1].lines, [
  `**Org** / **Main** (#5) · type or source changed, switch not finished yet · CBL cannot read it on BattleMetrics · last imported ${String(ATTEMPTED_AT)}`
]);
const replacing = await readStatus([record]);
assert.strictEqual(replacing.syncs.get(5).sourceChange, 'replacing');
assert.strictEqual(replacing.removals.has(5), false);
// A source changed by hand still has its old bans, and the importer's first complete read of the
// new source left those it did not find waiting for a confirming read, which the status gives, as
// the list still has them, though not the records of bans it no longer has, nor as a hold (see
// holdOf). Once the replacing is done, the row no longer says so, and nor does the status.
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
  `${REPLACING}\n${heldLine} · last read in full ${String(ATTEMPTED_AT)}\nNext read in full: on the next cycle\n40 bans stored · 10 bans on BattleMetrics\nRemovals: 30 bans waiting for a confirming read`
);
assert.strictEqual(fieldOf(replies[0], 'Held for an admin'), undefined);
assert.deepStrictEqual(replies[1].lines, [
  `**Org** / **Main** (#5) · type or source changed, switch not finished yet · ${heldLine} · 30 removals waiting for a confirming read`
]);
// Nor are the records of bans held for an admin before the change given as held, here with the same
// IDs as stored bans: the status gives only the bans that wait, if any (see describeImport).
removalRows = banIDs('old', 30).map((banId) => removal(banId, true));
await run('status', { banlist: '5' });
assert.strictEqual(
  importOf(replies.at(-1)),
  `${REPLACING}\n${heldLine} · last read in full ${String(ATTEMPTED_AT)}\nNext read in full: on the next cycle\n40 bans stored · 10 bans on BattleMetrics`
);
removalRows = banIDs('old', 30).map((banId, i) => removal(banId, i >= 20));
await run('status', { banlist: '5' });
assert.strictEqual(
  importOf(replies.at(-1)),
  `${REPLACING}\n${heldLine} · last read in full ${String(ATTEMPTED_AT)}\nNext read in full: on the next cycle\n40 bans stored · 10 bans on BattleMetrics\nRemovals: 20 bans waiting for a confirming read`
);
syncRows[0].replacePending = 0;
assert.strictEqual(format.summariseImport((await readStatus([record])).syncs.get(5)), heldLine);

// A rename leaves the list's updatedAt as it was, so a list the importer is still switching to its
// new source keeps its status, rather than being taken for one the importer has not read since the change. A
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

// Resuming a list the importer has not read since its type or source was changed, or has not
// finished switching to its new source, asks only that, as the importer replaces them with the new
// source's without holding them for an admin. Here the list has no bans, as /banlist update deleted
// them with the change. One that still has bans, as its source was changed by hand, which keeps its
// old ones, or as the importer has saved some of the new source's, catches up only once the
// importer's reads have confirmed those the new source does not have, as any list does, so the
// question says that too.
const CONFIRMING =
  ': once its reads have confirmed which of its 12 bans on 5 players the new source does not have, which takes a later read, at least 10 minutes after the first read that missed them, when at least 10 of them, and 5% of the list, are missing';
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

// The importer measures a confirming read from the first read that missed a ban, so bans that
// already waited before the list was suspended are confirmed by the first read after the resume,
// if that is 10 minutes after the read that missed them. The question measures the wait from that
// read too, not from the resume. Here the source was changed by hand, and the importer's first read
// of the new one left the 30 old bans waiting.
reset(40, 40);
pausedRows = [paused()];
syncRows = [{ ...replacingSync }];
removalRows = banIDs('old', 30).map((banId) => removal(banId));
storedBans = [...banIDs('old', 30), ...banIDs('new', 10)];
await run('resume', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Resume **Org** / **Main**? ${REPLACING} The ban importer reads it in full on its next cycle, and the list counts again once it has caught up with it: once its reads have confirmed which of its 40 bans on 40 players the new source does not have, which takes a later read, at least 10 minutes after the first read that missed them, when at least 10 of them, and 5% of the list, are missing. /banlist status shows when. Export bans follow from the cycle after it counts again, and players' reputation points within 1 cycle of it.`
);

// The ban importer's holds of a list's bans for an admin, which its status can show: why, how many
// bans, since when, and what ends the hold, and in short in the list of every list, besides the bans
// that only wait for a confirming read. The list here is a BattleMetrics list whose last read in
// full was 5 minutes ago, and whose next is due at its slot, in 20 minutes. Bans are held from
// SINCE, a day before that read, and some later, so the hold is since the first of them.
const READ_AT = new Date(Date.now() - 5 * 60 * 1000);
const NEXT_AT = new Date(Date.now() + 20 * 60 * 1000);
const SINCE = new Date(READ_AT.getTime() - 24 * HOUR);
const LATER = new Date(SINCE.getTime() + 20 * 60 * 1000);
const heldRecords = (prefix, n, heldAt = SINCE) =>
  banIDs(prefix, n).map((banId, i) => ({ banList: 5, banId, heldAt: i === 1 ? LATER : heldAt }));
const heldSync = (fields = {}) => ({
  banList: 5,
  sourceKey: sourceKey(record),
  replacePending: 0,
  state: 'held',
  lastAttemptAt: READ_AT,
  lastSuccessAt: READ_AT,
  lastFullScanAt: READ_AT,
  nextFullScanAt: NEXT_AT,
  scanReason: 'periodic',
  storedCount: 200,
  headTotal: 0,
  headUids: '[]',
  lastError: null,
  allowFullRemovalUntil: null,
  ...fields
});
const HELD_LINE = `Imported, with removals held until they are confirmed · last imported ${String(READ_AT)}`;
const CONFIRM_IT = '\nIf the list really lost them, confirm it with /banlist confirm-removal.';
// What the status asks an admin to have checked before confirming a hold of 'full' or 'large' (see
// HOLDS in format.js).
const CONFIRM_LOST =
  '\nIf the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.';
async function statusOf() {
  replies.length = 0;
  await run('status', { banlist: '5' });
  await run('status', {});
  return {
    import: importOf(replies[0]),
    held: fieldOf(replies[0], 'Held for an admin'),
    list: replies[1]
  };
}

// Held as it lost all of its bans: its bans are recorded as held, without a row of BanListHolds.
// Some other bans wait for a confirming read, and one of the held bans was held later.
reset(0, 0);
syncRows = [heldSync({ storedCount: 230, headTotal: 15 })];
removalRows = [...heldRecords('h', 200), ...banIDs('w', 15).map((banId) => removal(banId))];
storedBans = [...banIDs('h', 200), ...banIDs('w', 15), ...banIDs('n', 15)];
let shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n230 bans stored · 15 bans on BattleMetrics\nRemovals: 15 bans waiting for a confirming read, 200 bans held for an admin`
);
assert.strictEqual(
  shown.held,
  `200 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. They are kept until one of those the hold began with comes back, or an admin confirms the removal.${CONFIRM_LOST}`
);
assert.deepStrictEqual(shown.list, {
  title: 'Ban lists: 1 list, 0 paused',
  lines: [
    `**Org** / **Main** (#5) · ${HELD_LINE} · **200 bans held for an admin, as it lost all of them** · 15 removals waiting for a confirming read`
  ]
});

// Held as it lost a large part of its bans at once, as BanListHolds says, while at least fewestHeld
// of them are held: 40, a fifth of the 200 it is measured against. With fewer, or until the
// importer has made BanListHolds, the status gives them as held as the list lost all of them (see
// whyHeld in ban-importer/src/apply-list.js).
reset(0, 0);
syncRows = [heldSync({ storedCount: 200, headTotal: 120 })];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 40);
storedBans = banIDs('h', 200);
shown = await statusOf();
assert.strictEqual(
  shown.held,
  `40 bans since ${String(SINCE)}, as a complete read lost a large part of its bans at once, which more likely means that its source broke, or leaves them out. They are kept until enough of them come back, or an admin confirms the removal.${CONFIRM_LOST}`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **40 bans held for an admin, as it lost a large part at once**`
]);
removalRows = heldRecords('h', 39);
shown = await statusOf();
assert.match(
  shown.held,
  /^39 bans since .*, as a complete read found none of the bans it had then,/
);
removalRows = heldRecords('h', 40);
holdsMissing = true;
shown = await statusOf();
assert.match(
  shown.held,
  /^40 bans since .*, as a complete read found none of the bans it had then,/
);

// The hold of a list CBL cannot read is shown without what ends it (see importBanList in
// ban-importer/src/ban-importer.js), and the command that confirms it can only be used once CBL
// can read it again. Suspended too, it can be used only once it is resumed and CBL can read it
// again: resumed while CBL still cannot read it, it is refused as a list CBL cannot read.
reset(0, 0);
syncRows = [heldSync({ state: 'access_lost', storedCount: 200, headTotal: 120 })];
removalRows = heldRecords('h', 60);
storedBans = banIDs('h', 200);
shown = await statusOf();
assert.strictEqual(
  shown.held,
  `60 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke.\nOnce CBL can read it again, if the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.`
);
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
shown = await statusOf();
assert.strictEqual(
  shown.held,
  `60 bans since ${String(SINCE)}, as a complete read lost a large part of its bans at once, which more likely means that its source broke, or leaves them out.\nOnce CBL can read it again, if the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.`
);
holdRows = [];
pausedRows = [paused()];
shown = await statusOf();
assert.strictEqual(
  shown.held,
  `60 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke.\nOnce it is resumed and CBL can read it again, if the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.`
);
pausedRows = [];
// A list whose last attempt failed, or that is resuming, can be confirmed at once, as the command
// refuses neither, so its Held field says so plainly, after what ends the hold.
const HELD_60 = `60 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. They are kept until one of those the hold began with comes back, or an admin confirms the removal.${CONFIRM_LOST}`;
syncRows[0].state = 'failing';
shown = await statusOf();
assert.strictEqual(shown.held, HELD_60);
syncRows[0].state = 'held';
pausedRows = [paused({ resumedAt: new Date(READ_AT.getTime() - 60 * 1000) })];
shown = await statusOf();
assert.strictEqual(shown.held, HELD_60);
pausedRows = [];

// A BattleMetrics list held without records whose count is not 0, or not known, is shown as up to
// all of its stored bans held (see holdOf, and Confirming a removal in ban-importer/README.md), and
// its status asks the admin to confirm the removal if the list really lost them, or really has no
// bans with a SteamID. A suspended list's status says so too, for once it is resumed.
const CONFIRM_UP_TO =
  '\nIf the list really lost them, or really has no bans with a SteamID, confirm it with /banlist confirm-removal.';
reset(0, 0);
syncRows = [heldSync({ storedCount: 8, headTotal: 8 })];
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n8 bans stored · 8 bans on BattleMetrics`
);
assert.strictEqual(
  shown.held,
  `Up to 8 bans, those its last complete read did not find, or found without their SteamIDs, as it gave none of them, or for a small list none with a SteamID, which more likely means that the list is broken. Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once.${CONFIRM_UP_TO}`
);
assert.deepStrictEqual(shown.list, {
  title: 'Ban lists: 1 list, 0 paused',
  lines: [
    `**Org** / **Main** (#5) · ${HELD_LINE} · **up to 8 bans held for an admin, as it gave none, or none with a SteamID**`
  ]
});
syncRows[0].headTotal = null;
shown = await statusOf();
assert.match(
  shown.held,
  /^Up to 8 bans, those its last complete read did not find, or found without their SteamIDs, /
);
assert.ok(shown.held.endsWith(CONFIRM_UP_TO));
pausedRows = [paused()];
shown = await statusOf();
assert.ok(
  shown.held.endsWith(
    '\nOnce it is resumed, if the list really lost them, or really has no bans with a SteamID, confirm it with /banlist confirm-removal.'
  )
);
pausedRows = [];
// A remote list held without records has all of its bans shown as held (see holdOf).
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ storedCount: 8, headTotal: null, nextFullScanAt: null })];
shown = await statusOf();
assert.strictEqual(
  shown.held,
  `All 8 bans, as its last complete read gave none of them, which more likely means that the list is broken. Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once.${CONFIRM_IT}`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **all 8 bans held for an admin, as it gave none**`
]);

// An 'empty' hold (see holdOf): all of the list's bans are shown as held, since a time that is not
// known. A BattleMetrics list whose row shows a count of 0 and an empty newest page is shown so
// though some of its bans are recorded as waiting, which its Import field gives as recorded before
// its last complete read. One whose count is not 0 is shown by its records, as a remote list is:
// its bans wait, and its Import field gives its records as they are.
reset(0, 0);
syncRows = [heldSync()];
storedBans = banIDs('h', 200);
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n200 bans stored · 0 bans on BattleMetrics`
);
assert.strictEqual(
  shown.held,
  `All 200 bans, as its last complete read gave none of them, which more likely means that the list is broken. Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once.${CONFIRM_IT}`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **all 200 bans held for an admin, as it gave none**`
]);
removalRows = banIDs('h', 20).map((banId) => removal(banId));
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n200 bans stored · 0 bans on BattleMetrics\nRemovals recorded before its last complete read: 20 bans waiting for a confirming read`
);
assert.match(shown.held, /^All 200 bans, as its last complete read gave none of them,/);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **all 200 bans held for an admin, as it gave none**`
]);
syncRows[0].headTotal = 180;
shown = await statusOf();
assert.match(
  shown.import,
  /\n200 bans stored · 180 bans on BattleMetrics\nRemovals: 20 bans waiting for a confirming read$/
);
assert.strictEqual(shown.held, undefined);
assert.deepStrictEqual(shown.list, {
  title: 'Ban lists: 1 list, 0 paused',
  lines: [`**Org** / **Main** (#5) · ${HELD_LINE} · 20 removals waiting for a confirming read`]
});
// A list that is not held has none, whatever its row's count.
syncRows[0] = heldSync({ state: 'ok', headTotal: 0 });
removalRows = [];
shown = await statusOf();
assert.strictEqual(shown.held, undefined);
// A count of 0 is taken as a read that gave none only with an empty newest page in the row (see
// holdOf). Without one, such a list's bans are shown as its records give them: held as it lost all
// of them, which the question gives, or, when they only wait, not held at all, which
// confirm-removal refuses, and its Import field gives its records as they are. With no records, it
// is held as up to all of its bans.
for (const headUids of ['["u1"]', null]) {
  const imported = `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: ${headUids === null ? 'on the next cycle' : `due ${String(NEXT_AT)}`}\n23 bans stored · 0 bans on BattleMetrics\nRemovals: `;
  reset(0, 0);
  syncRows = [heldSync({ storedCount: 23, headUids })];
  removalRows = heldRecords('h', 20);
  storedBans = [...banIDs('h', 20), ...banIDs('n', 3)];
  shown = await statusOf();
  assert.strictEqual(
    shown.import,
    `${imported}0 bans waiting for a confirming read, 20 bans held for an admin`,
    String(headUids)
  );
  assert.strictEqual(
    shown.held,
    `20 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. They are kept until one of those the hold began with comes back, or an admin confirms the removal.${CONFIRM_LOST}`,
    String(headUids)
  );
  assert.deepStrictEqual(
    shown.list,
    {
      title: 'Ban lists: 1 list, 0 paused',
      lines: [
        `**Org** / **Main** (#5) · ${HELD_LINE} · **20 bans held for an admin, as it lost all of them**`
      ]
    },
    String(headUids)
  );
  confirmAnswer = false;
  await run('confirm-removal', { banlist: '5' });
  assert.match(
    prompts.at(-1).content,
    /^Confirm the removal for \*\*Org\*\* \/ \*\*Main\*\*\? The ban importer has held 20 bans of \*\*Org\*\* \/ \*\*Main\*\* for an admin since /,
    String(headUids)
  );
  removalRows = banIDs('h', 12).map((banId) => removal(banId));
  shown = await statusOf();
  assert.strictEqual(
    shown.import,
    `${imported}12 bans waiting for a confirming read`,
    String(headUids)
  );
  assert.strictEqual(shown.held, undefined, String(headUids));
  assert.deepStrictEqual(
    shown.list,
    {
      title: 'Ban lists: 1 list, 0 paused',
      lines: [`**Org** / **Main** (#5) · ${HELD_LINE} · 12 removals waiting for a confirming read`]
    },
    String(headUids)
  );
  prompts.length = 0;
  await assert.rejects(
    run('confirm-removal', { banlist: '5' }),
    rejectsWith(
      "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main** for an admin. 12 bans wait for a confirming read, which needs no admin's confirmation. If the importer's line about the list in the log channel says instead that it returned no bans, or none with a SteamID, so its stored bans were kept, which its records do not show, set IMPORTER_ALLOW_MASS_REMOVAL to the list's ID for one run."
    ),
    String(headUids)
  );
  assert.deepStrictEqual(prompts, [], String(headUids));
  removalRows = [];
  shown = await statusOf();
  assert.match(
    shown.held,
    /^Up to 23 bans, those its last complete read did not find,/,
    String(headUids)
  );
}

// A list held for a large loss, or as it lost all of its bans, whose row then shows a read that
// gave none, by a count of 0 and an empty newest page: its status gives all of its bans as held,
// with the hold its records and its row of BanListHolds give as recorded before that read, and its
// Import field gives those records as recorded before that read. The list had 80 bans when it lost
// all of them, and has gained others since.
for (const [reason, why, kept] of [
  [
    'large',
    'as a complete read lost a large part of its bans at once',
    'until enough of them come back'
  ],
  [
    null,
    'as a complete read found none of its bans',
    'until one of those the hold began with comes back'
  ]
]) {
  reset(0, 0);
  syncRows = [heldSync()];
  holdRows = reason ? [{ banList: 5, reason, storedCount: 200 }] : [];
  removalRows = heldRecords('h', 80);
  storedBans = banIDs('h', 200);
  shown = await statusOf();
  assert.strictEqual(
    shown.import,
    `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n200 bans stored · 0 bans on BattleMetrics\nRemovals recorded before its last complete read: 0 bans waiting for a confirming read, 80 bans held for an admin`,
    String(reason)
  );
  assert.strictEqual(
    shown.held,
    `All 200 bans, as its last complete read gave none of them, which more likely means that the list is broken. Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once. Before its last complete read, it held 80 of them since ${String(SINCE)}, ${why}, and holds those again once a read gives bans, ${kept}, or an admin confirms the removal.${CONFIRM_IT}`,
    String(reason)
  );
  assert.deepStrictEqual(
    shown.list,
    {
      title: 'Ban lists: 1 list, 0 paused',
      lines: [
        `**Org** / **Main** (#5) · ${HELD_LINE} · **all 200 bans held for an admin, as it gave none**`
      ]
    },
    String(reason)
  );
}
// A list whose row's state is failing, or a remote list, which gives no count, is shown with its
// hold as recorded (see holdOf).
reset(0, 0);
syncRows = [heldSync({ state: 'failing' })];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 80);
storedBans = banIDs('h', 200);
shown = await statusOf();
assert.match(
  shown.held,
  /^80 bans since .*, as a complete read lost a large part of its bans at once, .* or an admin confirms the removal\.\n/
);
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ headTotal: null, nextFullScanAt: null })];
shown = await statusOf();
assert.match(
  shown.held,
  /^80 bans since .*, as a complete read lost a large part of its bans at once, .* or an admin confirms the removal\.\n/
);
// So is a list with bans held after its row's last read in full (see holdOf). Here the 20 bans were
// held after the row's read, which counted 0, and 5 new bans were saved since.
reset(0, 0);
const HELD_LATER = new Date(READ_AT.getTime() + 60 * 1000);
syncRows = [heldSync({ storedCount: 20 })];
holdRows = [{ banList: 5, reason: 'full', storedCount: 20 }];
removalRows = banIDs('h', 20).map((banId) => ({ banList: 5, banId, heldAt: HELD_LATER }));
storedBans = [...banIDs('h', 20), ...banIDs('n', 5)];
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n20 bans stored · 0 bans on BattleMetrics\nRemovals: 0 bans waiting for a confirming read, 20 bans held for an admin`
);
assert.match(
  shown.held,
  /^20 bans since .*, as a complete read found none of the bans it had then,/
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **20 bans held for an admin, as it lost all of them**`
]);
// So is one whose first held ban is from before the row's last read in full, but whose last is not.
// The question gives that hold too.
reset(0, 0);
syncRows = [heldSync({ storedCount: 23 })];
holdRows = [{ banList: 5, reason: 'full', storedCount: 20 }];
removalRows = [
  ...banIDs('h', 20).map((banId) => ({ banList: 5, banId, heldAt: SINCE })),
  ...banIDs('n', 3).map((banId) => ({ banList: 5, banId, heldAt: HELD_LATER }))
];
storedBans = [...banIDs('h', 20), ...banIDs('n', 3), ...banIDs('m', 2)];
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: due ${String(NEXT_AT)}\n23 bans stored · 0 bans on BattleMetrics\nRemovals: 0 bans waiting for a confirming read, 23 bans held for an admin`
);
assert.strictEqual(
  shown.held,
  `23 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. They are kept until one of those the hold began with comes back, or an admin confirms the removal.${CONFIRM_LOST}`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **23 bans held for an admin, as it lost all of them**`
]);
const lastRead = await status.readStatus([record]);
assert.deepStrictEqual(
  [lastRead.removals.get(5).heldSince.getTime(), lastRead.removals.get(5).heldLast.getTime()],
  [SINCE.getTime(), HELD_LATER.getTime()]
);
confirmAnswer = false;
await run('confirm-removal', { banlist: '5' });
assert.match(
  prompts.at(-1).content,
  /^Confirm the removal for \*\*Org\*\* \/ \*\*Main\*\*\? The ban importer has held 23 bans of \*\*Org\*\* \/ \*\*Main\*\* for an admin since /
);

// The next read in full that a list's status gives (see describeNextRead): for a BattleMetrics
// list, its row's next time, at its slot or for the bans that wait for a confirming read, though
// not as for them for a row whose state is access_lost, nor once its records show none waiting, and
// the next cycle when that time has passed, its row has no read in full, it keeps no newest page or
// no count, or the list was resumed since its last read in full. A suspended list's status gives
// none, but still gives an admin's confirmation. The confirmation's time is given too, in the list
// of every list as well, and for a row whose state is access_lost with "once CBL can read it
// again".
const nextLineOf = (reply) =>
  importOf(reply)
    .split('\n')
    .find((line) => line.startsWith('Next read in full: '));
const CONFIRMED_AT = new Date(Date.now() + HOUR);
for (const [label, setup, next] of [
  ['at its slot', () => {}, `due ${String(NEXT_AT)}`],
  [
    'for the bans that wait for a confirming read',
    () => {
      syncRows[0].scanReason = 'removal';
      removalRows = [...removalRows, ...banIDs('w', 12).map((banId) => removal(banId))];
      storedBans = [...storedBans, ...banIDs('w', 12)];
    },
    `due ${String(NEXT_AT)}, for the bans that wait for a confirming read`
  ],
  [
    'for the bans that waited for a confirming read, all found again by a read that was not complete',
    () => {
      syncRows[0].scanReason = 'removal';
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'for the bans that wait for a confirming read, while CBL cannot read it',
    () => {
      syncRows[0].scanReason = 'removal';
      syncRows[0].state = 'access_lost';
      removalRows = [...removalRows, ...banIDs('w', 12).map((banId) => removal(banId))];
      storedBans = [...storedBans, ...banIDs('w', 12)];
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'due already',
    () => {
      syncRows[0].nextFullScanAt = new Date(Date.now() - 60000);
    },
    'on the next cycle'
  ],
  [
    'never read in full',
    () => {
      syncRows[0].lastFullScanAt = null;
    },
    'on the next cycle'
  ],
  [
    'with no newest page in its row, as after a run with head polls off',
    () => {
      syncRows[0].headUids = null;
    },
    'on the next cycle'
  ],
  [
    'with no count from BattleMetrics in its row',
    () => {
      syncRows[0].headTotal = null;
    },
    'on the next cycle'
  ],
  [
    'resumed since its last read in full',
    () => {
      pausedRows = [paused({ resumedAt: new Date(Date.now() - 60000) })];
    },
    'on the next cycle'
  ],
  [
    'read in full since it was resumed',
    () => {
      pausedRows = [paused({ resumedAt: new Date(READ_AT.getTime() - 60000) })];
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'suspended',
    () => {
      pausedRows = [paused()];
    },
    null
  ],
  [
    'suspended, confirmed by an admin',
    () => {
      pausedRows = [paused()];
      syncRows[0].allowFullRemovalUntil = CONFIRMED_AT;
    },
    null
  ],
  [
    'suspended, with nothing held',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'ok';
      removalRows = [];
    },
    null
  ],
  [
    'confirmed by an admin',
    () => {
      syncRows[0].allowFullRemovalUntil = CONFIRMED_AT;
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'confirmed by an admin, after a read that gave none of its bans',
    () => {
      syncRows[0].allowFullRemovalUntil = CONFIRMED_AT;
      syncRows[0].headTotal = 0;
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'confirmed by an admin, which ran out',
    () => {
      syncRows[0].allowFullRemovalUntil = new Date(Date.now() - 1);
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'confirmed by an admin while CBL cannot read it',
    () => {
      syncRows[0].allowFullRemovalUntil = CONFIRMED_AT;
      syncRows[0].state = 'access_lost';
    },
    `due ${String(NEXT_AT)}`
  ],
  [
    'confirmed by an admin, with no bans recorded as held',
    () => {
      syncRows[0].allowFullRemovalUntil = CONFIRMED_AT;
      removalRows = [];
    },
    `due ${String(NEXT_AT)}`
  ]
]) {
  reset(0, 0);
  syncRows = [heldSync({ storedCount: 50, headTotal: 10 })];
  removalRows = heldRecords('h', 50);
  storedBans = banIDs('h', 50);
  setup();
  shown = await statusOf();
  assert.strictEqual(
    nextLineOf(replies[0]),
    next === null ? undefined : `Next read in full: ${next}`,
    label
  );
  const confirmed = syncRows[0].allowFullRemovalUntil > Date.now();
  const unreadable = syncRows[0].state === 'access_lost' ? 'once CBL can read it again, ' : '';
  assert.strictEqual(
    shown.import.includes(
      `\nRemoval confirmed by an admin until ${String(CONFIRMED_AT)}: until then, ${unreadable}complete reads of it can remove every ban they do not find, at once.`
    ),
    confirmed,
    label
  );
  assert.strictEqual(
    shown.list.lines[0].endsWith(` · removal confirmed until ${String(CONFIRMED_AT)}`),
    confirmed,
    label
  );
  // The same list, suspended: its status gives no next read.
  pausedRows = [paused()];
  await run('status', { banlist: '5' });
  assert.strictEqual(nextLineOf(replies.at(-1)), undefined, `${label}, suspended`);
}
// A remote list's status gives its next read in full as on the next cycle, with what that cycle
// does with its file while its row keeps any of it (see lastFile in
// ban-importer/src/ban-importer.js), and so does a resuming one's. A suspended one's status gives
// no next read, as for a suspended BattleMetrics list, nor does that of a list whose row's state is
// self_import.
const REMOTE_FILE = {
  remoteEtag: '"abc"',
  remoteLastModified: 'Mon, 16 Nov 2026 09:00:00 GMT',
  remoteBodyHash: 'f'.repeat(64)
};
reset(0, 0);
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ state: 'ok', headTotal: null, nextFullScanAt: null, ...REMOTE_FILE })];
await run('status', { banlist: '5' });
assert.strictEqual(
  nextLineOf(replies.at(-1)),
  'Next read in full: on the next cycle, which reads its file again only if it has changed'
);
pausedRows = [paused({ resumedAt: new Date(Date.now() - 60000) })];
await run('status', { banlist: '5' });
assert.strictEqual(
  nextLineOf(replies.at(-1)),
  'Next read in full: on the next cycle, which reads its file again only if it has changed'
);
pausedRows = [paused()];
await run('status', { banlist: '5' });
assert.strictEqual(nextLineOf(replies.at(-1)), undefined);
pausedRows = [];
syncRows[0].remoteEtag = null;
syncRows[0].remoteLastModified = null;
syncRows[0].remoteBodyHash = null;
await run('status', { banlist: '5' });
assert.strictEqual(nextLineOf(replies.at(-1)), 'Next read in full: on the next cycle');
reset(0, 0);
syncRows = [heldSync({ state: 'self_import' })];
await run('status', { banlist: '5' });
assert.strictEqual(nextLineOf(replies.at(-1)), undefined);

// /banlist resync sets a BattleMetrics list's row of its current source due now, by the database's
// clock, which its status then says. Nothing else in the row changes, and it is logged. The mark is
// made while a cycle runs too (see planRead in ban-importer/src/planner.js).
reset(0, 0);
syncRows = [heldSync({ state: 'ok', storedCount: 120, headTotal: 120 })];
importerRunning = true;
await run('resync', { banlist: '5' });
assert.deepStrictEqual(calls, [['read in full', 5, sourceKey(record)]]);
assert.deepStrictEqual(syncRows, [
  heldSync({ state: 'ok', storedCount: 120, headTotal: 120, nextFullScanAt: DB_NOW })
]);
assert.deepStrictEqual(audits, [
  'asked for ban list "Main" (ID: 5) of organisation "Org" (ID: 2) to be read in full on the ban importer\'s next cycle.'
]);
assert.strictEqual(
  replies.at(-1),
  'The ban importer reads **Org** / **Main** in full on its next cycle, unless a cycle under way reads it in full first. /banlist status shows when it was last read in full.'
);
await run('status', { banlist: '5' });
assert.strictEqual(nextLineOf(replies.at(-1)), 'Next read in full: on the next cycle');
// A list whose row's state is access_lost is marked too, and its reply says what that read does if
// CBL still cannot read it (see importBanList in ban-importer/src/ban-importer.js).
reset(0, 0);
syncRows = [heldSync({ state: 'access_lost' })];
await run('resync', { banlist: '5' });
assert.deepStrictEqual(calls, [['read in full', 5, sourceKey(record)]]);
assert.strictEqual(
  replies.at(-1),
  'The ban importer reads **Org** / **Main** in full on its next cycle, unless a cycle under way reads it in full first. If CBL still cannot read it on BattleMetrics by then, that read saves any new bans it finds, but removes none. /banlist status shows when it was last read in full.'
);
// The reply gives an admin's confirmation that still lasts, as /banlist status gives it, with "once
// CBL can read it again" for a row whose state is access_lost, but not what the read it asks for
// removes. A confirmation that has run out is not given.
const RESYNC_UNTIL = new Date(Date.now() + HOUR);
const STILL_LOST =
  ' If CBL still cannot read it on BattleMetrics by then, that read saves any new bans it finds, but removes none.';
for (const [label, fields, clause] of [
  [
    'confirmed',
    { state: 'held', allowFullRemovalUntil: RESYNC_UNTIL },
    ` Removal confirmed by an admin until ${String(RESYNC_UNTIL)}: until then, complete reads of it can remove every ban they do not find, at once.`
  ],
  [
    'confirmed, CBL cannot read it',
    { state: 'access_lost', allowFullRemovalUntil: RESYNC_UNTIL },
    `${STILL_LOST} Removal confirmed by an admin until ${String(RESYNC_UNTIL)}: until then, once CBL can read it again, complete reads of it can remove every ban they do not find, at once.`
  ],
  [
    'confirmation run out',
    { state: 'held', allowFullRemovalUntil: new Date(Date.now() - 1000) },
    ''
  ]
]) {
  reset(0, 0);
  syncRows = [heldSync(fields)];
  await run('resync', { banlist: '5' });
  assert.strictEqual(
    replies.at(-1),
    `The ban importer reads **Org** / **Main** in full on its next cycle, unless a cycle under way reads it in full first.${clause} /banlist status shows when it was last read in full.`,
    label
  );
}
// A remote list's row forgets its file (see lastFile in ban-importer/src/ban-importer.js), but not
// while the importer's run lock is held.
reset(0, 0);
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ state: 'ok', headTotal: null, nextFullScanAt: null, ...REMOTE_FILE })];
importerRunning = true;
await assert.rejects(
  run('resync', { banlist: '5' }),
  rejectsWith(
    'The ban importer is running, so nothing was changed: the cycle under way may still check the file of **Org** / **Main** as it did before, and keep it. Ask again once the cycle has finished.'
  )
);
assert.deepStrictEqual([calls, audits], [[['check run lock']], []]);
assert.strictEqual(syncRows[0].remoteEtag, REMOTE_FILE.remoteEtag);
importerRunning = false;
calls.length = 0;
await run('resync', { banlist: '5' });
assert.deepStrictEqual(calls, [['check run lock'], ['forget file', 5, sourceKey(record)]]);
assert.deepStrictEqual(syncRows, [
  heldSync({
    state: 'ok',
    headTotal: null,
    nextFullScanAt: null,
    remoteEtag: null,
    remoteLastModified: null,
    remoteBodyHash: null
  })
]);
assert.strictEqual(
  replies.at(-1),
  'The ban importer downloads the file of **Org** / **Main** whole on its next cycle, even if the file has not changed. /banlist status shows when it was last read in full.'
);
await run('status', { banlist: '5' });
assert.strictEqual(nextLineOf(replies.at(-1)), 'Next read in full: on the next cycle');
// Asked again, the row keeps none of the file already, so the mark changes nothing, and MySQL
// counts no row for it, but the row is there, so it is logged and answered as before.
calls.length = 0;
audits.length = 0;
await run('resync', { banlist: '5' });
assert.deepStrictEqual(calls, [
  ['check run lock'],
  ['forget file', 5, sourceKey(record)],
  ['look for row', 5, sourceKey(record)]
]);
assert.strictEqual(audits.length, 1);
assert.match(
  replies.at(-1),
  /^The ban importer downloads the file of \*\*Org\*\* \/ \*\*Main\*\* whole/
);
// While an admin's confirmation lasts, a remote list's reply gives it too.
syncRows[0].allowFullRemovalUntil = RESYNC_UNTIL;
await run('resync', { banlist: '5' });
assert.strictEqual(
  replies.at(-1),
  `The ban importer downloads the file of **Org** / **Main** whole on its next cycle, even if the file has not changed. Removal confirmed by an admin until ${String(RESYNC_UNTIL)}: until then, complete reads of it can remove every ban they do not find, at once. /banlist status shows when it was last read in full.`
);

// A list that is suspended, that has no row, whose row's state is self_import, or whose type or
// source was changed, is left as it is, which the reply says. So is a list removed, or given a new
// source, meanwhile, which the mark finds no row of. The reply to a list with no row does not say
// which read comes next, a suspended list is told to ask again once it is resumed, not what
// resuming it does, and the reply to a list whose type or source was changed does not say which
// cycle reads it. A row whose sourceChange is 'unread' (see readStatus) says nothing of the new
// source.
const SUSPENDED_RESYNC =
  '**Org** / **Main** is suspended, so nothing was changed. Ask again once it is resumed.';
const resyncRefusals = [
  [
    'suspended',
    () => {
      pausedRows = [paused()];
    },
    SUSPENDED_RESYNC
  ],
  [
    'suspended, whose row says its source is one of the export ban lists',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'self_import';
    },
    SUSPENDED_RESYNC
  ],
  [
    'suspended, given a new source since its row said its source is one of the export ban lists',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'self_import';
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    SUSPENDED_RESYNC
  ],
  [
    'suspended, while an admin confirmation lasts',
    () => {
      pausedRows = [paused()];
      syncRows[0].allowFullRemovalUntil = new Date(Date.now() + HOUR);
    },
    SUSPENDED_RESYNC
  ],
  [
    'suspended, a remote list whose row keeps its file',
    () => {
      record.type = 'remote';
      record.source = 'https://x.test/bans.txt';
      syncRows = [heldSync({ state: 'ok', remoteEtag: '"v1"', remoteBodyHash: 'a'.repeat(64) })];
      pausedRows = [paused()];
    },
    SUSPENDED_RESYNC
  ],
  [
    'not imported',
    () => {
      syncRows = [];
    },
    '/banlist status shows **Org** / **Main** as not imported yet, so nothing was changed.'
  ],
  [
    'an export ban list',
    () => {
      syncRows[0].state = 'self_import';
    },
    "The ban importer does not read **Org** / **Main**, as its source is one of CBL's own export ban lists. Remove it with /banlist remove."
  ],
  [
    'given a new source since its row said its source is one of the export ban lists',
    () => {
      syncRows[0].state = 'self_import';
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    'The type or source of **Org** / **Main** was changed, so the ban importer reads it in full anyway.'
  ],
  [
    'not read since its source changed',
    () => {
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    'The type or source of **Org** / **Main** was changed, so the ban importer reads it in full anyway.'
  ],
  [
    'switching to its new source',
    () => {
      syncRows[0].replacePending = 1;
    },
    'The type or source of **Org** / **Main** was changed, so the ban importer reads it in full anyway.'
  ]
];
for (const [label, setup, message] of resyncRefusals) {
  reset(0, 0);
  syncRows = [heldSync({ state: 'ok' })];
  setup();
  await assert.rejects(run('resync', { banlist: '5' }), rejectsWith(message), label);
  assert.deepStrictEqual([calls, audits], [[], []], label);
}
reset(0, 0);
syncRows = [heldSync({ state: 'ok' })];
goneAtMark = true;
await assert.rejects(
  run('resync', { banlist: '5' }),
  rejectsWith(
    '**Org** / **Main** was removed, or given a new type or source, meanwhile, so nothing was changed.'
  )
);
assert.deepStrictEqual(calls, [
  ['read in full', 5, sourceKey(record)],
  ['look for row', 5, sourceKey(record)]
]);
assert.deepStrictEqual(audits, []);

// /banlist confirm-removal asks first, with the list's hold (see describeConfirmation). Once
// confirmed, the list's row of its current source has allowFullRemovalUntil 2 hours on, by the
// database's clock, and a BattleMetrics list's nextFullScanAt now (see markRemovalConfirmed). It is
// logged as important, with the hold, and the reply says until when it lasts. For bans held as
// recorded, the question gives the list's stored bans as the most the read can remove, not only
// those held, with any saved since. It names IMPORTER_EOS_IMPORT, and leaves a ban whose SteamID
// was corrected out of the bans that move (see placeBan in ban-importer/src/apply-list.js).
const UNTIL = new Date(DB_NOW.getTime() + 2 * HOUR);
const confirmTail = (removes) =>
  ` Once you confirm, the ban importer reads it in full on its next cycle, or, if a cycle under way reads it in full first, at its next full read, and, if that is within 2 hours, can remove every ban that read does not find, at once: ${removes}. For 2 hours, complete reads of it can do the same, without holding any. A ban whose account changed, other than by a corrected SteamID, can move to its new account instead, but one it gives without a SteamID only to an EOS ID, on a BattleMetrics list whose EOS IDs are imported (IMPORTER_EOS_IMPORT), and can otherwise be removed.`;
const heldTail = (these, stored) =>
  confirmTail(
    `these ${these} if it still does not have them, and any other ban it no longer has, up to all of its ${stored}, and any saved since, if it gives none of them`
  );
const emptyTail = (all) =>
  confirmTail(
    `all ${all}, and any saved since, if it still gives none of them, and otherwise those it does not give`
  );
const CONFIRMED_REPLY = `Confirmed the removal for **Org** / **Main**. The ban importer reads it in full on its next cycle, or, if a cycle under way reads it in full first, at its next full read, and, if that is by ${String(UNTIL)}, can remove any ban it still does not find. Until then, complete reads of it can remove every ban they do not find, at once.`;
const confirmedLog = (hold) =>
  `[important] confirmed the removal of the bans the ban importer holds back from ban list "Main" (ID: 5) of organisation "Org" (ID: 2) (${hold}): until ${UNTIL.toISOString()}, complete reads of it can remove every ban they do not find at once.`;
function holdFull() {
  syncRows = [heldSync({ storedCount: 230, headTotal: 15 })];
  removalRows = [...heldRecords('h', 200), ...banIDs('w', 15).map((banId) => removal(banId))];
  storedBans = [...banIDs('h', 200), ...banIDs('w', 15), ...banIDs('n', 15)];
}
reset(0, 0);
holdFull();
await run('confirm-removal', { banlist: '5' });
assert.deepStrictEqual(prompts, [
  {
    content: `Confirm the removal for **Org** / **Main**? The ban importer has held 200 bans of **Org** / **Main** for an admin since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. 15 other bans wait for a confirming read.${heldTail('215 bans', '230 stored bans')}`,
    confirmLabel: 'Confirm removal'
  }
]);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal, read in full', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(syncRows, [
  heldSync({
    storedCount: 230,
    headTotal: 15,
    allowFullRemovalUntil: UNTIL,
    nextFullScanAt: DB_NOW
  })
]);
assert.deepStrictEqual(audits, [
  confirmedLog(
    `200 bans held since ${SINCE.toISOString()}, as a complete read found none of its bans, and 15 other bans waiting for a confirming read; 230 bans stored`
  )
]);
assert.strictEqual(replies.at(-1), CONFIRMED_REPLY);
// Its status then gives the confirmation, and its read in full on the next cycle.
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `${HELD_LINE} · last read in full ${String(READ_AT)}\nNext read in full: on the next cycle\n230 bans stored · 15 bans on BattleMetrics\nRemovals: 15 bans waiting for a confirming read, 200 bans held for an admin\nRemoval confirmed by an admin until ${String(UNTIL)}: until then, complete reads of it can remove every ban they do not find, at once.`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · ${HELD_LINE} · **200 bans held for an admin, as it lost all of them** · 15 removals waiting for a confirming read · removal confirmed until ${String(UNTIL)}`
]);
// Asked again while that lasts, the question is the same, and says so at its end.
prompts.length = 0;
confirmAnswer = false;
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Confirm the removal for **Org** / **Main**? The ban importer has held 200 bans of **Org** / **Main** for an admin since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke. 15 other bans wait for a confirming read.${heldTail('215 bans', '230 stored bans')} An earlier confirmation lasts until ${String(UNTIL)}.`
);
// Should CBL lose the list on BattleMetrics while that lasts, its status gives its next slot (see
// removalDue in ban-importer/src/planner.js), and says that its complete reads can remove the bans
// they do not find once CBL can read it again, and that the command can be used once it can. Its
// row is set as after the read in full that found so: why, and its next slot. Its records stay as
// they were.
const LOST_AT = new Date();
Object.assign(syncRows[0], {
  state: 'access_lost',
  lastAttemptAt: LOST_AT,
  lastSuccessAt: LOST_AT,
  lastFullScanAt: LOST_AT,
  nextFullScanAt: NEXT_AT,
  lastError:
    'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.'
});
shown = await statusOf();
assert.strictEqual(
  shown.import,
  `CBL cannot read it on BattleMetrics · last imported ${String(LOST_AT)} · last read in full ${String(LOST_AT)}\nNext read in full: due ${String(NEXT_AT)}\n230 bans stored · 15 bans on BattleMetrics\nRemovals: 15 bans waiting for a confirming read, 200 bans held for an admin\nRemoval confirmed by an admin until ${String(UNTIL)}: until then, once CBL can read it again, complete reads of it can remove every ban they do not find, at once.\nLast error: Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.`
);
assert.strictEqual(
  shown.held,
  `200 bans since ${String(SINCE)}, as a complete read found none of the bans it had then, which more likely means that its source broke.\nOnce CBL can read it again, if the list really lost them, or really gives them for other accounts, e.g. without a SteamID, confirm it with /banlist confirm-removal.`
);
assert.deepStrictEqual(shown.list.lines, [
  `**Org** / **Main** (#5) · CBL cannot read it on BattleMetrics · last imported ${String(LOST_AT)} · **200 bans held for an admin, as it lost all of them** · 15 removals waiting for a confirming read · removal confirmed until ${String(UNTIL)}`
]);

// A remote list held as it lost a large part of its bans has only the confirmation marked (see
// markRemovalConfirmed).
reset(0, 0);
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ headTotal: null, nextFullScanAt: null, scanReason: null })];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 80);
storedBans = banIDs('h', 200);
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Confirm the removal for **Org** / **Main**? The ban importer has held 80 bans of **Org** / **Main** for an admin since ${String(SINCE)}, as a complete read lost a large part of its bans at once, which more likely means that its source broke, or leaves them out.${heldTail('80 bans', '200 stored bans')}`
);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(syncRows, [
  heldSync({
    headTotal: null,
    nextFullScanAt: null,
    scanReason: null,
    allowFullRemovalUntil: UNTIL
  })
]);
assert.deepStrictEqual(audits, [
  confirmedLog(
    `80 bans held since ${SINCE.toISOString()}, as a complete read lost a large part of its bans at once; 200 bans stored`
  )
]);
assert.strictEqual(replies.at(-1), CONFIRMED_REPLY);
// The most the question says the read can remove is the list's stored bans by its row, never fewer
// than those held and waiting, with any saved since, nor a number at all when the row has none, as
// all of its stored bans then takes in those saved since.
const QUESTION_HOLD = { kind: 'full', held: 3, waiting: 1, since: SINCE };
for (const [storedCount, most] of [
  [2, 'all of its 4 stored bans, and any saved since,'],
  [null, 'all of its stored bans']
])
  assert.ok(
    format
      .describeConfirmation('X', QUESTION_HOLD, { storedCount }, 2)
      .includes(
        `these 4 bans if it still does not have them, and any other ban it no longer has, up to ${most} if it gives none of them.`
      ),
    String(storedCount)
  );

// A list with an 'empty' hold is marked to be read in full too (see removalDue in
// ban-importer/src/planner.js).
reset(0, 0);
syncRows = [heldSync()];
storedBans = banIDs('h', 200);
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Confirm the removal for **Org** / **Main**? The ban importer keeps all 200 bans of **Org** / **Main** for an admin, as its last complete read gave none of them, which more likely means that the list is broken.${emptyTail('200 bans')}`
);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal, read in full', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(syncRows, [
  heldSync({ allowFullRemovalUntil: UNTIL, nextFullScanAt: DB_NOW })
]);
assert.deepStrictEqual(audits, [
  confirmedLog('all 200 bans held, as its last complete read gave none')
]);
// A BattleMetrics list held without records whose count is not 0 has an 'empty' hold with upTo (see
// holdOf): the question and the log give its stored bans as the most held, and the question says
// what the next read can remove and which bans can move, as for every hold. It is marked to be read
// in full, so its status gives that read on the next cycle, and, once its row's nextFullScanAt is
// later, that time.
reset(0, 0);
syncRows = [heldSync({ storedCount: 8, headTotal: 8 })];
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Confirm the removal for **Org** / **Main**? The ban importer keeps up to 8 bans of **Org** / **Main** for an admin, those its last complete read did not find, or found without their SteamIDs, as it gave none of them, or for a small list none with a SteamID, which more likely means that the list is broken.${emptyTail('8 bans')}`
);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal, read in full', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(syncRows, [
  heldSync({ storedCount: 8, headTotal: 8, allowFullRemovalUntil: UNTIL, nextFullScanAt: DB_NOW })
]);
assert.deepStrictEqual(audits, [
  confirmedLog(
    'up to 8 bans held, as its last complete read gave none, or for a small list none with a SteamID'
  )
]);
assert.strictEqual(replies.at(-1), CONFIRMED_REPLY);
await statusOf();
assert.strictEqual(nextLineOf(replies[0]), 'Next read in full: on the next cycle');
syncRows[0].nextFullScanAt = NEXT_AT;
await statusOf();
assert.strictEqual(nextLineOf(replies[0]), `Next read in full: due ${String(NEXT_AT)}`);
// So does a BattleMetrics list held for a large loss whose row then shows a read that gave none, by
// a count of 0 and an empty newest page: all of its bans are shown as held, and the question and
// the log give the large loss its records and its row of BanListHolds keep, as the hold recorded
// before that read.
reset(0, 0);
syncRows = [heldSync()];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 80);
storedBans = banIDs('h', 200);
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(
  prompts[0].content,
  `Confirm the removal for **Org** / **Main**? The ban importer keeps all 200 bans of **Org** / **Main** for an admin, as its last complete read gave none of them, which more likely means that the list is broken. Before that read, it held 80 of them since ${String(SINCE)}, as a complete read lost a large part of its bans at once.${emptyTail('200 bans')}`
);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal, read in full', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(audits, [
  confirmedLog(
    `all 200 bans held, as its last complete read gave none, after 80 bans held since ${SINCE.toISOString()}, as a complete read lost a large part of its bans at once`
  )
]);
assert.strictEqual(replies.at(-1), CONFIRMED_REPLY);
// A resuming list's held bans can be confirmed as any list's.
reset(0, 0);
holdFull();
pausedRows = [paused({ resumedAt: new Date(SUSPENDED_AT.getTime() + 1) })];
await run('confirm-removal', { banlist: '5' });
assert.strictEqual(replies.at(-1), CONFIRMED_REPLY);

// Nothing is confirmed, and nothing asked, for a list with no hold, though some of its bans may
// wait for a confirming read, that is suspended, that has no row, whose source is one of CBL's own
// export ban lists, by a row of its current source, that is being switched to a new source, or that
// CBL cannot read, whatever its bans held. The refusal of a list whose bans wait for a confirming
// read does not say when that read is (see planRemovals in ban-importer/src/apply-list.js).
const confirmRefusals = [
  [
    'waiting for a confirming read',
    () => {
      removalRows = banIDs('w', 15).map((banId) => removal(banId));
      syncRows[0].headTotal = 180;
    },
    "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main** for an admin. 15 bans wait for a confirming read, which needs no admin's confirmation. If the importer's line about the list in the log channel says instead that it returned no bans, or none with a SteamID, so its stored bans were kept, which its records do not show, set IMPORTER_ALLOW_MASS_REMOVAL to the list's ID for one run."
  ],
  // Also when its last attempt failed, as its records come first (see holdToConfirm).
  [
    'waiting for a confirming read, and its last attempt failed',
    () => {
      removalRows = banIDs('w', 15).map((banId) => removal(banId));
      syncRows[0].headTotal = 180;
      syncRows[0].state = 'failing';
    },
    "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main** for an admin. 15 bans wait for a confirming read, which needs no admin's confirmation. If the importer's line about the list in the log channel says instead that it returned no bans, or none with a SteamID, so its stored bans were kept, which its records do not show, set IMPORTER_ALLOW_MASS_REMOVAL to the list's ID for one run."
  ],
  [
    'one waiting for a confirming read',
    () => {
      removalRows = [removal('5,w0')];
      syncRows[0].headTotal = 180;
    },
    "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main** for an admin. 1 ban waits for a confirming read, which needs no admin's confirmation. If the importer's line about the list in the log channel says instead that it returned no bans, or none with a SteamID, so its stored bans were kept, which its records do not show, set IMPORTER_ALLOW_MASS_REMOVAL to the list's ID for one run."
  ],
  [
    'not held',
    () => {
      removalRows = [];
      syncRows[0].state = 'ok';
    },
    "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main**."
  ],
  // A list with no records whose row's state is failing is refused with what to look for.
  [
    'not held by its records, and its last attempt failed',
    () => {
      removalRows = [];
      syncRows[0].state = 'failing';
    },
    "Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main**. If its line about the list's last complete read says that it returned no bans, or none with a SteamID, so its stored bans were kept, confirm the removal once /banlist status shows them held."
  ],
  [
    'not imported',
    () => {
      syncRows = [];
    },
    'Cannot confirm: /banlist status shows **Org** / **Main** as not imported.'
  ],
  [
    'suspended',
    () => {
      pausedRows = [paused()];
    },
    '**Org** / **Main** is suspended. Confirm the removal once it is resumed, if it is still held.'
  ],
  // Resumed while CBL still cannot read it, it is refused as a list CBL cannot read.
  [
    'suspended while CBL cannot read it',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'access_lost';
    },
    '**Org** / **Main** is suspended. Confirm the removal once it is resumed and CBL can read it again, if it is still held.'
  ],
  // Nor does it say that a suspended list is read once it is resumed, also when its row's state is
  // self_import.
  [
    'suspended, whose row says its source is one of the export ban lists',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'self_import';
    },
    '**Org** / **Main** is suspended. Confirm the removal once it is resumed, if it is still held.'
  ],
  [
    'an export ban list',
    () => {
      syncRows[0].state = 'self_import';
    },
    "Nothing to confirm: the ban importer does not read **Org** / **Main**, as its source is one of CBL's own export ban lists, so it removes none of its bans. Remove it with /banlist remove, which removes its bans too."
  ],
  // A row whose sourceChange is 'unread' (see readStatus) says nothing of the new source.
  [
    'given a new source since its row said its source is one of the export ban lists',
    () => {
      syncRows[0].state = 'self_import';
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    `Nothing to confirm: its type or source was changed, and the ban importer replaces the bans of its old source with those of the new one without holding them for an admin.`
  ],
  // Nor whether CBL can read it, so a suspended list given a new source since its row said CBL
  // could not read it is told only to wait until it is resumed. A row whose sourceChange is
  // 'replacing' does say whether CBL can read it.
  [
    'suspended, and given a new source since its row said CBL could not read it',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'access_lost';
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    '**Org** / **Main** is suspended. Confirm the removal once it is resumed, if it is still held.'
  ],
  [
    'suspended while switching to a new source CBL cannot read',
    () => {
      pausedRows = [paused()];
      syncRows[0].state = 'access_lost';
      syncRows[0].replacePending = 1;
    },
    '**Org** / **Main** is suspended. Confirm the removal once it is resumed and CBL can read it again, if it is still held.'
  ],
  [
    'not read since its source changed',
    () => {
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    `Nothing to confirm: its type or source was changed, and the ban importer replaces the bans of its old source with those of the new one without holding them for an admin.`
  ],
  [
    'switching to its new source',
    () => {
      syncRows[0].replacePending = 1;
    },
    `Nothing to confirm: its type or source was changed, and the ban importer replaces the bans of its old source with those of the new one without holding them for an admin.`
  ],
  [
    'not readable by CBL',
    () => {
      syncRows[0].state = 'access_lost';
    },
    '/banlist status shows that CBL cannot read **Org** / **Main** on BattleMetrics. The ban importer removes none of its bans while CBL cannot read it, confirmed or not. Confirm the removal once CBL can read it, if it is still held.'
  ]
];
for (const [label, setup, message] of confirmRefusals) {
  reset(0, 0);
  holdFull();
  setup();
  await assert.rejects(run('confirm-removal', { banlist: '5' }), rejectsWith(message), label);
  assert.deepStrictEqual([prompts, calls, audits], [[], [], []], label);
}

// A name longer than /org and /banlist let an admin give, as one written by hand before the bot
// existed can be, is cut to their 100 characters, so the question, which gives the list's name
// twice, stays within the 2,000 characters Discord takes in a message (see test/paginate.js, with
// the real escapeMarkdown). Characters are counted as code points, so an emoji of one code point
// is not split.
reset(0, 0);
holdFull();
record.name = 'L'.repeat(255);
record.Organisation.name = `${'O'.repeat(98)}\u{1F600}\u{1F600}${'O'.repeat(10)}`;
confirmAnswer = false;
await run('confirm-removal', { banlist: '5' });
const CUT = `**${'O'.repeat(98)}\u{1F600}…** / **${'L'.repeat(99)}…**`;
assert.ok(
  prompts[0].content.startsWith(
    `Confirm the removal for ${CUT}? The ban importer has held 200 bans of ${CUT} for an admin since`
  ),
  prompts[0].content.slice(0, 300)
);
reset(0, 0);
holdFull();
record.name = 'L'.repeat(100);
record.Organisation.name = '\u{1F600}'.repeat(100);
confirmAnswer = false;
await run('confirm-removal', { banlist: '5' });
assert.ok(
  prompts[0].content.startsWith(
    `Confirm the removal for **${'\u{1F600}'.repeat(100)}** / **${'L'.repeat(100)}**? `
  ),
  prompts[0].content.slice(0, 300)
);

// Nothing is confirmed when the question is cancelled or not answered in time, or when the hold is
// not the one the question gave once it is answered: more or fewer of its bans held or waiting, or
// none, or all of them, or it was suspended, or given a new source. Nor when the list's row's
// lastAttemptAt or counts changed, whatever the hold, nor when the list was removed, or given a new
// source, just before the mark.
reset(0, 0);
holdFull();
confirmAnswer = false;
await run('confirm-removal', { banlist: '5' });
assert.deepStrictEqual([calls, audits], [[['confirm']], []]);
assert.strictEqual(syncRows[0].allowFullRemovalUntil, null);
const CHANGED_MEANWHILE =
  'The ban importer tried to read **Org** / **Main**, or its hold of it changed, while you were asked, so nothing was confirmed. Run /banlist confirm-removal again to see it as it is now.';
const READ_AGAIN_AT = new Date(READ_AT.getTime() + 60000);
for (const [label, change, message] of [
  [
    'read with no bans',
    () => {
      Object.assign(syncRows[0], {
        headTotal: 0,
        lastAttemptAt: READ_AGAIN_AT,
        lastSuccessAt: READ_AGAIN_AT,
        lastFullScanAt: READ_AGAIN_AT
      });
    },
    CHANGED_MEANWHILE
  ],
  [
    'polled',
    () => {
      syncRows[0].lastAttemptAt = READ_AGAIN_AT;
    },
    CHANGED_MEANWHILE
  ],
  [
    'counted again on BattleMetrics',
    () => {
      syncRows[0].headTotal = 16;
    },
    CHANGED_MEANWHILE
  ],
  [
    'a ban stored',
    () => {
      syncRows[0].storedCount = 231;
    },
    CHANGED_MEANWHILE
  ],
  [
    'a ban held later',
    () => {
      removalRows.push({ banList: 5, banId: '5,n0', heldAt: LATER });
    },
    CHANGED_MEANWHILE
  ],
  [
    'a held ban back',
    () => {
      removalRows = removalRows.filter(({ banId }) => banId !== '5,h0');
    },
    CHANGED_MEANWHILE
  ],
  [
    'a ban waiting',
    () => {
      removalRows.push(removal('5,n0'));
    },
    CHANGED_MEANWHILE
  ],
  [
    'held anew as a large loss',
    () => {
      holdRows = [{ banList: 5, reason: 'large', storedCount: 230 }];
    },
    CHANGED_MEANWHILE
  ],
  [
    'held since later',
    () => {
      removalRows = removalRows.map((row) => (row.heldAt ? { ...row, heldAt: LATER } : row));
    },
    CHANGED_MEANWHILE
  ],
  [
    'no longer held',
    () => {
      removalRows = [];
      syncRows[0].state = 'ok';
    },
    "Nothing was confirmed, as it changed meanwhile. Nothing to confirm: the ban importer's records hold none of the bans of **Org** / **Main**."
  ],
  [
    'suspended',
    () => {
      pausedRows = [paused()];
    },
    'Nothing was confirmed, as it changed meanwhile. **Org** / **Main** is suspended. Confirm the removal once it is resumed, if it is still held.'
  ],
  [
    'given a new source',
    () => {
      syncRows[0].sourceKey = 'o'.repeat(64);
    },
    `Nothing was confirmed, as it changed meanwhile. Nothing to confirm: its type or source was changed, and the ban importer replaces the bans of its old source with those of the new one without holding them for an admin.`
  ]
]) {
  reset(0, 0);
  holdFull();
  whileAsked = change;
  await assert.rejects(run('confirm-removal', { banlist: '5' }), rejectsWith(message), label);
  assert.deepStrictEqual([calls, audits], [[['confirm']], []], label);
  assert.strictEqual(syncRows[0].allowFullRemovalUntil, null, label);
}
// A remote list whose hold and counts stay as they were, but whose row's lastAttemptAt moves:
// nothing is confirmed either.
reset(0, 0);
record.type = 'remote';
record.source = 'https://x.test/bans.txt';
syncRows = [heldSync({ headTotal: null, nextFullScanAt: null, scanReason: null })];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 80);
storedBans = banIDs('h', 200);
whileAsked = () => {
  Object.assign(syncRows[0], {
    lastAttemptAt: READ_AGAIN_AT,
    lastSuccessAt: READ_AGAIN_AT,
    lastFullScanAt: READ_AGAIN_AT
  });
};
await assert.rejects(run('confirm-removal', { banlist: '5' }), rejectsWith(CHANGED_MEANWHILE));
assert.deepStrictEqual([calls, audits], [[['confirm']], []]);
assert.strictEqual(syncRows[0].allowFullRemovalUntil, null);
// So is a change of the recorded hold of an 'empty' hold, though all of its bans are still held.
reset(0, 0);
syncRows = [heldSync()];
holdRows = [{ banList: 5, reason: 'large', storedCount: 200 }];
removalRows = heldRecords('h', 80);
storedBans = banIDs('h', 200);
whileAsked = () => {
  removalRows = heldRecords('h', 79);
};
await assert.rejects(run('confirm-removal', { banlist: '5' }), rejectsWith(CHANGED_MEANWHILE));
assert.deepStrictEqual([calls, audits], [[['confirm']], []]);
reset(0, 0);
holdFull();
goneAtMark = true;
await assert.rejects(
  run('confirm-removal', { banlist: '5' }),
  rejectsWith(
    '**Org** / **Main** was removed, or given a new type or source, meanwhile, so nothing was confirmed.'
  )
);
assert.deepStrictEqual(calls, [
  ['confirm'],
  ['confirm removal, read in full', 5, sourceKey(record)],
  ['read confirmation', 5, sourceKey(record)]
]);
assert.deepStrictEqual(audits, []);

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
  "Ban list command checks passed: renames keep bans, source changes delete them once confirmed and only while no import runs, and mark the importer's row, also when changed back, removal, suspending and resuming lists, which then queue no players, and their status, which leaves out a changed source's old state until the importer has read the list since, and then gives the new one's while the switch is not finished, also once the list is renamed, and when a resumed list's bans wait for a confirming read, the importer's holds, their kind, bans and since when, also all of a held list's bans once a read gives none, or the most held of a small list whose read gave none with a SteamID, and its next read in full, reads in full on the next cycle, and confirmed removals, asked first with the hold and the most the next read removes, and refused for lists not held, suspended, not read, or read or changed while the admin was asked."
);
