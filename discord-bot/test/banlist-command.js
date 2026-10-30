import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

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

// The paused lists' rows, the ban importer's rows of BanListSyncs and of BanListPendingRemovals,
// whether the importer has made its tables yet, and what a suspension answers, when not as the
// rows say.
let pausedRows = [];
let syncRows = [];
let removalRows = [];
let tablesMissing = false;
let suspendAnswer = null;
// The paused lists the importer's reputation check last settled players without.
let settled = [];
const SUSPENDED_AT = new Date('2026-10-29T12:00:00.000Z');
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
    // The bans the importer holds back from removing, for /banlist status.
    if (sql.includes('FROM BanListPendingRemovals')) {
      if (tablesMissing) throw noTable();
      return removalRows.filter(({ banList }) => replacements.banListIDs.includes(banList));
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
  'scbl-lib/db/models': { Ban, BanList, ExportBanListConfig, Organisation: {} },
  'scbl-lib/db/sequelize': { Op: { ne: 'ne' }, QueryTypes: { SELECT: 'SELECT' } },
  'scbl-lib/db/ban-list-suspensions': suspensions,
  'scbl-lib/db/importer-models': { BanListSync }
};
const format = await load('../src/utils/format.js', { 'discord.js': discord });
const deletion = await load('../src/utils/delete-ban-lists.js', {
  ...database,
  './format.js': format
});
const { default: applyChanges } = await load('../src/utils/apply-changes.js', {});
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
    return 'Found 3 bans.';
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
  pausedRows = [];
  syncRows = [];
  removalRows = [];
  tablesMissing = false;
  suspendAnswer = null;
  settled = [];
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
  "Change the source of **Org** / **Main**? This deletes its 3 bans on 2 players, and the new source's bans are imported once it is resumed."
);
assert.deepStrictEqual(calls.slice(-4), [
  ['begin', 1],
  ['destroy bans', 1, [5]],
  ['save', 1, 'battlemetrics', 'new-list', 'Main'],
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
assert.match(prompts[0].content, /imported on the next ban importer run\.$/);
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

// The status of one list, or of every list, reads whether each is paused, its BanListSyncs row and
// the bans held back from removing it, and changes nothing.
reset(3, 2);
pausedRows = [paused({ reason: 'Dispute' })];
syncRows = [
  {
    banList: 5,
    state: 'held',
    lastSuccessAt: new Date('2026-10-29T11:00:00.000Z'),
    lastFullScanAt: new Date('2026-10-29T10:00:00.000Z'),
    storedCount: 3,
    headTotal: 4,
    lastError: null
  }
];
removalRows = [{ banList: 5, bans: '3', held: '1' }];
await run('status', { banlist: '5' });
assert.strictEqual(replies.length, 1);
assert.strictEqual(replies[0].embeds.length, 1);
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
const read = await readStatus([5]);
// Made in the module's context, so copied into this one to compare.
assert.deepStrictEqual({ ...read.removals.get(5) }, { waiting: 2, held: 1 });
assert.strictEqual(read.paused.get(5).reason, 'Dispute');
assert.strictEqual(read.syncs.get(5).state, 'held');
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

console.log(
  'Ban list command checks passed: renames keep bans, source changes delete them once confirmed and only while no import runs, removal, suspending and resuming lists, which then queue no players, and their status.'
);
