import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise how ExportBanManager.updateExportBans brings each batch's export bans up to date,
// without a database: the ExportBans table is a Map, which the stand-ins for Sequelize's findAll,
// bulkCreate, update and destroy read and change as MySQL would. Every statement is recorded,
// written out as SQL, in order with the log lines, so the checks say which statements are made,
// with which conditions, between which log lines.

const Op = {
  in: Symbol('in'),
  notIn: Symbol('notIn'),
  not: Symbol('not'),
  ne: Symbol('ne'),
  or: Symbol('or')
};
// When the export bans were last changed, before the run.
const earlier = Date.UTC(2026, 9, 15, 12);
// Objects the manager makes belong to its own context, so they are copied into this one before
// they are compared.
const copy = (value) => JSON.parse(JSON.stringify(value));

const table = new Map();
const events = [];
// How far the manager said it had got, for the run's status, as [done, total, unit].
const progress = [];
// The type of each export ban list, as ExportBanLists holds it.
let listTypes = {};
// The players SteamUsers holds, and the export ban lists each qualifies for, which the stand-in for
// the generating query gives.
let players = [];
let qualifies = {};
// Called once a batch has read its export bans, to change rows before the batch writes.
let afterRead = () => {};
// The players of the batch being updated.
let batch = [];
let listTypeReads = 0;

// Write a where clause out as Sequelize writes it for MySQL.
function sql(column, condition) {
  if (condition === null) return `${column} IS NULL`;
  if (typeof condition !== 'object') return `${column} = '${condition}'`;
  const parts = Object.getOwnPropertySymbols(condition).map((op) => {
    const value = condition[op];
    if (op === Op.in) return `${column} IN (${value.join(' ')})`;
    if (op === Op.not && value === null) return `${column} IS NOT NULL`;
    if (op === Op.ne) return `${column} != '${value}'`;
    if (op === Op.or) return `(${value.map((item) => sql(column, item)).join(' OR ')})`;
    throw new Error(`Unexpected condition on ${column}`);
  });
  return parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0];
}
const where = (conditions) => {
  assert.deepStrictEqual(Object.getOwnPropertySymbols(conditions), []);
  return Object.entries(conditions)
    .map(([column, condition]) => sql(column, condition))
    .join(' AND ');
};

// Whether a row matches a where clause, as MySQL decides: a comparison with NULL is never true.
function test(value, condition) {
  if (condition === null) return value === null;
  if (typeof condition !== 'object') return value === condition;
  return Object.getOwnPropertySymbols(condition).every((op) => {
    const operand = condition[op];
    if (op === Op.in) return operand.includes(value);
    if (op === Op.not && operand === null) return value !== null;
    if (op === Op.ne) return value !== null && value !== operand;
    if (op === Op.or) return operand.some((item) => test(value, item));
    throw new Error('Unexpected condition');
  });
}
const matches = (row, conditions) =>
  Object.entries(conditions).every(([column, condition]) => test(row[column], condition));

// Every write names only export bans of the batch's players.
function checkBatch(ids) {
  for (const id of ids)
    assert.ok(
      batch.includes(id.split(',')[0]),
      `${id} is not an export ban of the batch's players`
    );
}

// A transaction is open while its work runs, and ends when the work has finished.
const sequelize = {
  async transaction(options, work) {
    const transaction = { isolationLevel: options.isolationLevel, open: true };
    events.push(`BEGIN ${transaction.isolationLevel}`);
    try {
      return await work(transaction);
    } finally {
      transaction.open = false;
      events.push('COMMIT');
    }
  }
};

// The statement that says which export bans the batch's players qualify for, which scbl-lib holds.
// It runs on its own, in a SERIALIZABLE transaction that is still open when it is made.
async function membershipForPlayers(steamUserIDs, { transaction, ...rest }) {
  assert.deepStrictEqual(rest, {});
  assert.strictEqual(transaction.isolationLevel, 'SERIALIZABLE');
  assert.strictEqual(transaction.open, true);
  batch = [...steamUserIDs];
  events.push(`GENERATE for ${batch.join(' ')}`);
  return batch.flatMap((steamUser) =>
    (qualifies[steamUser] || []).map((list) => ({
      id: `${steamUser},${list}`,
      status: 'TO_BE_CREATED',
      steamUser,
      exportBanList: list
    }))
  );
}

const ExportBan = {
  async findAll({ attributes, where: conditions, raw, ...rest }) {
    assert.deepStrictEqual(rest, {});
    assert.deepStrictEqual(copy(attributes), ['id', 'exportBanList', 'status', 'battlemetricsID']);
    assert.strictEqual(raw, true);
    events.push(`SELECT WHERE ${where(conditions)}`);
    const rows = [...table.values()]
      .filter((row) => matches(row, conditions))
      .map((row) => Object.fromEntries(attributes.map((attribute) => [attribute, row[attribute]])));
    afterRead();
    return rows;
  },
  async bulkCreate(rows, { ignoreDuplicates, ...rest }) {
    assert.deepStrictEqual(rest, {});
    assert.strictEqual(ignoreDuplicates, true);
    checkBatch(rows.map((row) => row.id));
    events.push(`INSERT IGNORE ${rows.map((row) => row.id).join(' ')}`);
    for (const row of rows) {
      assert.deepStrictEqual(Object.keys(row), ['id', 'status', 'steamUser', 'exportBanList']);
      if (!table.has(row.id))
        table.set(row.id, { ...row, battlemetricsID: null, updatedAt: 'now' });
    }
  },
  async update(values, { where: conditions, silent, ...rest }) {
    assert.deepStrictEqual(rest, {});
    assert.deepStrictEqual(Object.keys(values), ['status']);
    checkBatch(conditions.id[Op.in]);
    events.push(
      `UPDATE SET status = '${values.status}'${silent ? ' (silent)' : ''} WHERE ${where(conditions)}`
    );
    let changed = 0;
    for (const row of table.values())
      if (matches(row, conditions)) {
        Object.assign(row, values, silent ? {} : { updatedAt: 'now' });
        changed++;
      }
    return [changed];
  },
  async destroy({ where: conditions, ...rest }) {
    assert.deepStrictEqual(rest, {});
    checkBatch(conditions.id[Op.in]);
    events.push(`DELETE WHERE ${where(conditions)}`);
    let deleted = 0;
    for (const [id, row] of table)
      if (matches(row, conditions)) {
        table.delete(id);
        deleted++;
      }
    return deleted;
  }
};

const dependencies = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/export-membership': { membershipForPlayers },
  'scbl-lib/db/models': {
    ExportBan,
    ExportBanList: {
      async findAll(options) {
        assert.deepStrictEqual(copy(options), { attributes: ['id', 'type'], raw: true });
        listTypeReads++;
        events.push('SELECT id, type FROM ExportBanLists');
        return Object.entries(listTypes).map(([id, type]) => ({ id: Number(id), type }));
      }
    },
    SteamUser: {
      async findAll(options) {
        assert.deepStrictEqual(copy(options), { attributes: ['id'] });
        return players.map((id) => ({ id }));
      },
      async update(values, { where: conditions }) {
        assert.deepStrictEqual(Object.keys(values), ['lastRefreshedExport']);
        assert.deepStrictEqual(copy(conditions.id[Op.in]), copy(batch));
        events.push(`STAMP ${batch.join(' ')}`);
      }
    }
  },
  'scbl-lib/db/sequelize': {
    Op,
    Transaction: { ISOLATION_LEVELS: { SERIALIZABLE: 'SERIALIZABLE' } }
  },
  'scbl-lib/utils': {
    // The manager no longer posts a progress bar, as the run's status shows how far it has got, so
    // the logger has none to give it.
    Logger: {
      verbose(module, verboseness, message) {
        assert.strictEqual(module, 'ExportBanManager');
        // The times in the lines change from run to run.
        events.push(`LOG ${message.replace(/\d+\.\d\ds/g, 'X.XXs')}`);
      }
    }
  },
  // The batch's statements are run again after a deadlock, which lock-retries.js checks.
  './apply-list.js': { retryOperation: (operation) => operation() },
  './run-control.js': {
    stopIfRequested() {},
    reportProgress: (...args) => progress.push(args)
  }
};

const source = await readFile(new URL('../src/export-ban-manager.js', import.meta.url), 'utf8');
// Load the manager, with the environment it reads its batch size from.
async function load(env) {
  const context = vm.createContext({ process: { env } });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  return module.namespace.default;
}
const ExportBanManager = await load({});

// Set up the tables for a run. Each export ban is [list, status, battlemetricsID], of the player it
// is listed under.
function setUp({ types, steamUsers, exportBans, qualifying, onRead = () => {} }) {
  table.clear();
  events.length = 0;
  listTypeReads = 0;
  listTypes = types;
  players = steamUsers;
  qualifies = qualifying;
  afterRead = onRead;
  for (const [steamUser, rows] of Object.entries(exportBans))
    for (const [list, status, battlemetricsID] of rows) {
      const id = `${steamUser},${list}`;
      table.set(id, {
        id,
        steamUser,
        exportBanList: list,
        status,
        battlemetricsID,
        updatedAt: earlier
      });
    }
}
// An export ban as [status, battlemetricsID, whether its time was kept or set to now], or undefined
// once it is deleted.
function state(id) {
  const row = table.get(id);
  return (
    row && [row.status, row.battlemetricsID, row.updatedAt === earlier ? 'kept' : row.updatedAt]
  );
}
const logs = () => events.filter((event) => event.startsWith('LOG '));
const writes = () => events.filter((event) => /^(INSERT|UPDATE|DELETE)/.test(event));

// Lists 1 to 4, 7 and 8 are BattleMetrics lists, 5, 6 and 9 remote ones.
const TYPES = {
  1: 'battlemetrics',
  2: 'battlemetrics',
  3: 'battlemetrics',
  4: 'battlemetrics',
  5: 'remote',
  6: 'remote',
  7: 'battlemetrics',
  8: 'battlemetrics',
  9: 'remote'
};
// Export bans of a player the run does not update, e.g. one added since it started, in every
// status. They are never changed.
const OTHER = [
  [1, 'CREATED', '111'],
  [2, 'TO_BE_CREATED', null],
  [3, 'TO_BE_CREATED', 'pending'],
  [4, 'TO_BE_CREATED', '444'],
  [5, 'TO_BE_DELETED', null],
  [7, 'TO_BE_DELETED', '777'],
  [8, 'TO_BE_DELETED', 'pending']
];
const others = () =>
  [...table.values()].filter((row) => row.steamUser === 'Z').map((row) => state(row.id));
const OTHERS_UNCHANGED = OTHER.map(([, status, battlemetricsID]) => [
  status,
  battlemetricsID,
  'kept'
]);

// Every transition. Player A qualifies for lists 1 to 9, and player B for none of them.
setUp({
  types: TYPES,
  steamUsers: ['A', 'B'],
  qualifying: { A: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  exportBans: {
    // A,1 does not exist yet.
    A: [
      [2, 'TO_BE_DELETED', null],
      [3, 'TO_BE_DELETED', 'pending'],
      [4, 'TO_BE_DELETED', '444'],
      [5, 'TO_BE_DELETED', null],
      [6, 'TO_BE_CREATED', null],
      [7, 'CREATED', '777'],
      [8, 'TO_BE_CREATED', 'pending'],
      [9, 'CREATED', null]
    ],
    B: [
      [1, 'CREATED', '111'],
      [5, 'CREATED', null],
      [2, 'TO_BE_CREATED', null],
      [6, 'TO_BE_CREATED', null],
      [3, 'TO_BE_CREATED', 'pending'],
      [4, 'TO_BE_CREATED', '444'],
      [7, 'TO_BE_DELETED', '777'],
      [8, 'TO_BE_DELETED', 'pending'],
      [9, 'TO_BE_DELETED', null]
    ],
    Z: OTHER
  }
});
await ExportBanManager.updateExportBans();

assert.deepStrictEqual(events, [
  'LOG Fetching Steam users to update...',
  'LOG Fetched 2 Steam users to update. Took X.XXs',
  'SELECT id, type FROM ExportBanLists',
  "LOG Updating batch of 2 Steam users' export bans (0 remaining)... Batch time: X.XXs",
  // Which export bans the batch's players qualify for is worked out in a transaction of its own,
  // which ends before the batch's export bans are read and written.
  'BEGIN SERIALIZABLE',
  'GENERATE for A B',
  'COMMIT',
  'LOG Saving 9 export bans... Batch time: X.XXs',
  // The batch's export bans are read once, by player.
  'SELECT WHERE steamUser IN (A B)',
  'INSERT IGNORE A,1',
  'LOG Step Create 9 new bans done. Batch time: X.XXs',
  // A cancelled deletion is created again on a BattleMetrics list with no ban, or a claimed one,
  // keeping its time, and is marked as created when it has a ban, or is on a remote list.
  "UPDATE SET status = 'TO_BE_CREATED' (silent) WHERE id IN (A,2 A,3) AND status = 'TO_BE_DELETED' AND (battlemetricsID IS NULL OR battlemetricsID = 'pending')",
  "UPDATE SET status = 'CREATED' WHERE id IN (A,4) AND status = 'TO_BE_DELETED' AND (battlemetricsID IS NOT NULL AND battlemetricsID != 'pending')",
  "UPDATE SET status = 'CREATED' WHERE id IN (A,5) AND status = 'TO_BE_DELETED'",
  'LOG Step Cancel deletion of bans that should still be present done. Batch time: X.XXs',
  "UPDATE SET status = 'TO_BE_DELETED' WHERE id IN (B,1 B,5) AND status = 'CREATED'",
  'LOG Step Queue existing bans to be deleted done. Batch time: X.XXs',
  // One not yet created is queued to be deleted, keeping its time, when its BattleMetrics ban was
  // made or claimed, and deleted otherwise.
  "UPDATE SET status = 'TO_BE_DELETED' (silent) WHERE id IN (B,3 B,4) AND status = 'TO_BE_CREATED' AND battlemetricsID IS NOT NULL",
  "DELETE WHERE id IN (B,2 B,6) AND status = 'TO_BE_CREATED' AND battlemetricsID IS NULL",
  'LOG Step Delete bans that have not yet been created done. Batch time: X.XXs',
  'STAMP A B',
  'LOG Finished Updating batch. (0 remaining) Overall batch time: X.XXs',
  'LOG Finished updating ExportBans. Took X.XXs'
]);
assert.deepStrictEqual(['A,1', 'A,2', 'A,3', 'A,4', 'A,5', 'A,6', 'A,7', 'A,8', 'A,9'].map(state), [
  ['TO_BE_CREATED', null, 'now'],
  ['TO_BE_CREATED', null, 'kept'],
  ['TO_BE_CREATED', 'pending', 'kept'],
  ['CREATED', '444', 'now'],
  ['CREATED', null, 'now'],
  ['TO_BE_CREATED', null, 'kept'],
  ['CREATED', '777', 'kept'],
  ['TO_BE_CREATED', 'pending', 'kept'],
  ['CREATED', null, 'kept']
]);
assert.deepStrictEqual(['B,1', 'B,5', 'B,2', 'B,6', 'B,3', 'B,4', 'B,7', 'B,8', 'B,9'].map(state), [
  ['TO_BE_DELETED', '111', 'now'],
  ['TO_BE_DELETED', null, 'now'],
  undefined,
  undefined,
  ['TO_BE_DELETED', 'pending', 'kept'],
  ['TO_BE_DELETED', '444', 'kept'],
  ['TO_BE_DELETED', '777', 'kept'],
  ['TO_BE_DELETED', 'pending', 'kept'],
  ['TO_BE_DELETED', null, 'kept']
]);
assert.deepStrictEqual(others(), OTHERS_UNCHANGED);

// An export ban that something else changed after the batch read it, or deleted, is left as it is,
// as each write only changes export bans still as they were read. Otherwise, e.g., one whose
// BattleMetrics ban was deleted would be marked as created without one, and one claimed meanwhile
// would be deleted while its ban may be being made.
setUp({
  types: TYPES,
  steamUsers: ['A', 'B'],
  qualifying: { A: [1, 2, 3, 4, 5, 6, 7, 8] },
  exportBans: {
    A: [
      [2, 'TO_BE_DELETED', null],
      [3, 'TO_BE_DELETED', 'pending'],
      [4, 'TO_BE_DELETED', '444'],
      [7, 'TO_BE_DELETED', '777'],
      [8, 'TO_BE_DELETED', '888'],
      [5, 'TO_BE_DELETED', null]
    ],
    B: [
      [1, 'CREATED', '111'],
      [9, 'CREATED', null],
      [3, 'TO_BE_CREATED', 'pending'],
      [4, 'TO_BE_CREATED', '444'],
      [2, 'TO_BE_CREATED', null],
      [6, 'TO_BE_CREATED', null]
    ],
    Z: OTHER
  },
  onRead() {
    const change = (id, changes) =>
      Object.assign(table.get(id), changes, { updatedAt: 'meanwhile' });
    // Created by another run.
    table.set('A,1', {
      id: 'A,1',
      steamUser: 'A',
      exportBanList: 1,
      status: 'CREATED',
      battlemetricsID: '100',
      updatedAt: 'meanwhile'
    });
    change('A,2', { battlemetricsID: '222' });
    change('A,3', { status: 'CREATED' });
    change('A,4', { battlemetricsID: null });
    change('A,7', { battlemetricsID: 'pending' });
    change('A,8', { status: 'TO_BE_CREATED' });
    change('A,5', { status: 'TO_BE_CREATED' });
    change('B,1', { status: 'TO_BE_CREATED' });
    table.delete('B,9');
    change('B,3', { battlemetricsID: null });
    change('B,4', { status: 'CREATED' });
    change('B,2', { battlemetricsID: 'pending' });
    change('B,6', { status: 'CREATED' });
  }
});
await ExportBanManager.updateExportBans();
// The writes are still made, for the export bans as they were read.
assert.deepStrictEqual(writes(), [
  'INSERT IGNORE A,1 A,6',
  "UPDATE SET status = 'TO_BE_CREATED' (silent) WHERE id IN (A,2 A,3) AND status = 'TO_BE_DELETED' AND (battlemetricsID IS NULL OR battlemetricsID = 'pending')",
  "UPDATE SET status = 'CREATED' WHERE id IN (A,4 A,7 A,8) AND status = 'TO_BE_DELETED' AND (battlemetricsID IS NOT NULL AND battlemetricsID != 'pending')",
  "UPDATE SET status = 'CREATED' WHERE id IN (A,5) AND status = 'TO_BE_DELETED'",
  "UPDATE SET status = 'TO_BE_DELETED' WHERE id IN (B,1 B,9) AND status = 'CREATED'",
  "UPDATE SET status = 'TO_BE_DELETED' (silent) WHERE id IN (B,3 B,4) AND status = 'TO_BE_CREATED' AND battlemetricsID IS NOT NULL",
  "DELETE WHERE id IN (B,2 B,6) AND status = 'TO_BE_CREATED' AND battlemetricsID IS NULL"
]);
assert.deepStrictEqual(['A,1', 'A,6', 'A,2', 'A,3', 'A,4', 'A,7', 'A,8', 'A,5'].map(state), [
  ['CREATED', '100', 'meanwhile'],
  ['TO_BE_CREATED', null, 'now'],
  ['TO_BE_DELETED', '222', 'meanwhile'],
  ['CREATED', 'pending', 'meanwhile'],
  ['TO_BE_DELETED', null, 'meanwhile'],
  ['TO_BE_DELETED', 'pending', 'meanwhile'],
  ['TO_BE_CREATED', '888', 'meanwhile'],
  ['TO_BE_CREATED', null, 'meanwhile']
]);
assert.deepStrictEqual(['B,1', 'B,9', 'B,3', 'B,4', 'B,2', 'B,6'].map(state), [
  ['TO_BE_CREATED', '111', 'meanwhile'],
  undefined,
  ['TO_BE_CREATED', null, 'meanwhile'],
  ['CREATED', '444', 'meanwhile'],
  ['TO_BE_CREATED', 'pending', 'meanwhile'],
  ['CREATED', null, 'meanwhile']
]);
assert.deepStrictEqual(others(), OTHERS_UNCHANGED);

// When nothing changes, as in most batches of most runs, nothing is written to ExportBans: export
// bans the players qualify for and have, created or not yet, and ones queued to be deleted of
// players who no longer qualify, stay as they are. Neither is anything written for players with no
// export bans who qualify for none.
setUp({
  types: TYPES,
  steamUsers: ['A', 'B', 'C'],
  qualifying: { A: [1, 2, 3, 4, 5] },
  exportBans: {
    A: [
      [1, 'CREATED', '111'],
      [2, 'CREATED', null],
      [3, 'TO_BE_CREATED', null],
      [4, 'TO_BE_CREATED', 'pending'],
      [5, 'TO_BE_CREATED', null]
    ],
    B: [
      [7, 'TO_BE_DELETED', '777'],
      [8, 'TO_BE_DELETED', 'pending'],
      [2, 'TO_BE_DELETED', null],
      [9, 'TO_BE_DELETED', null]
    ],
    Z: OTHER
  }
});
const before = [...table.values()].map((row) => ({ ...row }));
await ExportBanManager.updateExportBans();
assert.deepStrictEqual(writes(), []);
assert.deepStrictEqual(
  events.filter((event) => !event.startsWith('LOG ')),
  [
    'SELECT id, type FROM ExportBanLists',
    'BEGIN SERIALIZABLE',
    'GENERATE for A B C',
    'COMMIT',
    'SELECT WHERE steamUser IN (A B C)',
    'STAMP A B C'
  ]
);
assert.deepStrictEqual([...table.values()], before);
// Every step still logs its line, so the batch's lines and times compare with earlier runs'.
assert.deepStrictEqual(logs().slice(2, -1), [
  "LOG Updating batch of 3 Steam users' export bans (0 remaining)... Batch time: X.XXs",
  'LOG Saving 5 export bans... Batch time: X.XXs',
  'LOG Step Create 5 new bans done. Batch time: X.XXs',
  'LOG Step Cancel deletion of bans that should still be present done. Batch time: X.XXs',
  'LOG Step Queue existing bans to be deleted done. Batch time: X.XXs',
  'LOG Step Delete bans that have not yet been created done. Batch time: X.XXs',
  'LOG Finished Updating batch. (0 remaining) Overall batch time: X.XXs'
]);

// The type of each export ban list is read once a run, not once a batch, and says how a cancelled
// deletion is made: the same export ban with no BattleMetrics ban, or a claimed one, is created
// again on a BattleMetrics list, and marked as created on a remote list. Batches of 2 players here.
const InSmallBatches = await load({ UPDATE_EXPORT_BANS_BATCH_SIZE: '2' });
for (const type of ['battlemetrics', 'remote']) {
  setUp({
    types: { 10: type, 11: type },
    steamUsers: ['A', 'B', 'C'],
    qualifying: { A: [10, 11], C: [10, 11] },
    exportBans: {
      A: [
        [10, 'TO_BE_DELETED', null],
        [11, 'TO_BE_DELETED', 'pending']
      ],
      C: [
        [10, 'TO_BE_DELETED', null],
        [11, 'TO_BE_DELETED', 'pending']
      ]
    }
  });
  progress.length = 0;
  const counts = {};
  await InSmallBatches.updateExportBans(counts);
  assert.strictEqual(listTypeReads, 1);
  // The manager says how many players it has recalculated before the first batch and after each
  // one, for the run's status, and counts them for the run record.
  assert.deepStrictEqual(progress, [
    [0, 3, 'players'],
    [2, 3, 'players'],
    [3, 3, 'players']
  ]);
  assert.deepStrictEqual({ ...counts }, { players: 3 });
  // Each batch works out its export bans in a transaction of its own.
  assert.deepStrictEqual(
    events.filter((event) => /^(SELECT|BEGIN|GENERATE|COMMIT|STAMP)/.test(event)),
    [
      'SELECT id, type FROM ExportBanLists',
      'BEGIN SERIALIZABLE',
      'GENERATE for A B',
      'COMMIT',
      'SELECT WHERE steamUser IN (A B)',
      'STAMP A B',
      'BEGIN SERIALIZABLE',
      'GENERATE for C',
      'COMMIT',
      'SELECT WHERE steamUser IN (C)',
      'STAMP C'
    ]
  );
  const outcome = type === 'battlemetrics' ? 'TO_BE_CREATED' : 'CREATED';
  const time = type === 'battlemetrics' ? 'kept' : 'now';
  assert.deepStrictEqual(['A,10', 'A,11', 'C,10', 'C,11'].map(state), [
    [outcome, null, time],
    [outcome, 'pending', time],
    [outcome, null, time],
    [outcome, 'pending', time]
  ]);
}

// However many export bans change, no statement names more than 1,000, so each stays small and
// MySQL finds its export bans by primary key. Here every kind of change is made to more than 1,000
// export bans, each of its own player. A newly qualifies for 1,001 lists. B no longer qualifies
// for 2,500 created export bans, C for 2,001 not yet created and D for 1,001 claimed ones. E, F
// and G qualify again for 1,001 export bans queued to be deleted: on BattleMetrics lists with no
// BattleMetrics ban and with one, and on remote lists.
const lists = (first, count) => [...Array(count)].map((_, i) => first + i);
const exportBansOn = (first, count, status, battlemetricsID) =>
  lists(first, count).map((list) => [list, status, battlemetricsID]);
setUp({
  types: Object.fromEntries([
    ...lists(20000, 1001).map((list) => [list, 'battlemetrics']),
    ...lists(30000, 1001).map((list) => [list, 'remote'])
  ]),
  steamUsers: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  qualifying: {
    A: lists(1000, 1001),
    E: lists(20000, 1001),
    F: lists(20000, 1001),
    G: lists(30000, 1001)
  },
  exportBans: {
    B: exportBansOn(5000, 2500, 'CREATED', null),
    C: exportBansOn(9000, 2001, 'TO_BE_CREATED', null),
    D: exportBansOn(20000, 1001, 'TO_BE_CREATED', 'pending'),
    E: exportBansOn(20000, 1001, 'TO_BE_DELETED', null),
    F: exportBansOn(20000, 1001, 'TO_BE_DELETED', '1'),
    G: exportBansOn(30000, 1001, 'TO_BE_DELETED', null)
  }
});
await ExportBanManager.updateExportBans();
// Each statement as its kind, the player whose export bans it names and how many it names.
assert.deepStrictEqual(
  writes().map((event) => [
    event.split(' ')[0],
    event.match(/([A-Z]),\d/)[1],
    event.split(',').length - 1
  ]),
  [
    ['INSERT', 'A', 1000],
    ['INSERT', 'A', 1],
    ['UPDATE', 'E', 1000],
    ['UPDATE', 'E', 1],
    ['UPDATE', 'F', 1000],
    ['UPDATE', 'F', 1],
    ['UPDATE', 'G', 1000],
    ['UPDATE', 'G', 1],
    ['UPDATE', 'B', 1000],
    ['UPDATE', 'B', 1000],
    ['UPDATE', 'B', 500],
    ['UPDATE', 'D', 1000],
    ['UPDATE', 'D', 1],
    ['DELETE', 'C', 1000],
    ['DELETE', 'C', 1000],
    ['DELETE', 'C', 1]
  ]
);
// Every one of them is changed, and C's are all deleted.
const statesOf = (steamUser) =>
  [...table.values()].filter((row) => row.steamUser === steamUser).map((row) => state(row.id));
assert.deepStrictEqual(statesOf('A'), Array(1001).fill(['TO_BE_CREATED', null, 'now']));
assert.deepStrictEqual(statesOf('B'), Array(2500).fill(['TO_BE_DELETED', null, 'now']));
assert.deepStrictEqual(statesOf('C'), []);
assert.deepStrictEqual(statesOf('D'), Array(1001).fill(['TO_BE_DELETED', 'pending', 'kept']));
assert.deepStrictEqual(statesOf('E'), Array(1001).fill(['TO_BE_CREATED', null, 'kept']));
assert.deepStrictEqual(statesOf('F'), Array(1001).fill(['CREATED', '1', 'now']));
assert.deepStrictEqual(statesOf('G'), Array(1001).fill(['CREATED', null, 'now']));
assert.strictEqual(table.size, 7505);

console.log(
  'Export ban manager checks passed: one read a batch, every transition by ID with its conditions, no writes when nothing changes.'
);
