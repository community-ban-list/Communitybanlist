import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check that the statements that recalculate players' reputation points, ranks and export bans are
// run again when MySQL ends them in a deadlock or a lock wait timeout, as a bot command that
// deletes ban lists' bans at the same time can make it: a statement made on its own as a whole, and
// the read of the export bans players qualify for as its whole transaction, never as a statement of
// a transaction MySQL rolled back. Other errors are not retried. There is no database: a stand-in
// records each statement and transaction, and fails those a check names, as MySQL would, and the
// waits between attempts are skipped but recorded. core.js and export-ban-manager.js are loaded
// with the real apply-list.js and run-control.js.

// Stand-ins for Sequelize's errors, with MySQL's error number, as Sequelize gives it.
class DatabaseError extends Error {
  constructor(message, errno) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = { errno };
  }
}
class ForeignKeyConstraintError extends DatabaseError {}
class ValidationError extends Error {}
const deadlock = () =>
  new DatabaseError('Deadlock found when trying to get lock; try restarting transaction', 1213);
const lockWaitTimeout = () =>
  new DatabaseError('Lock wait timeout exceeded; try restarting transaction', 1205);
const syntaxError = () => new DatabaseError('You have an error in your SQL syntax', 1064);

// What the database was sent, in order: each statement, by its kind, with the transaction it was in
// or null, and each transaction's start and end.
const events = [];
const delays = [];
const logs = [];
// The errors each kind of statement fails with, one each time it is sent, in order.
const failures = new Map();
const fail = (kind, ...errors) => failures.set(kind, errors);

// Send a statement. One that fails is rolled back, so it changes nothing. A deadlock rolls back its
// whole transaction, as MySQL does, and a later statement in that transaction would then run on its
// own, outside it, which must never happen, so it fails this check. A lock wait timeout rolls back
// the statement alone, as MySQL does by default.
function send(kind, transaction = null) {
  events.push([kind, transaction?.id ?? null]);
  if (transaction?.rolledBack)
    throw new Error(`A ${kind} statement was sent in a transaction MySQL had rolled back`);
  const error = failures.get(kind)?.shift();
  if (!error) return;
  if (transaction && error.original.errno === 1213) transaction.rolledBack = true;
  throw error;
}

// The statements Core sends, by their start.
const KINDS = [
  [/^UPDATE SteamUsers\s+SET\s+reputationPoints = 0/, 'orphans'],
  [/^UPDATE SteamUsers SU\s+LEFT JOIN/, 'points'],
  [/^UPDATE SteamUsers su\s+JOIN \(\s+SELECT id, RANK\(\)/, 'ranks']
];
let transactions = 0;
const sequelize = {
  QueryTypes: { BULKUPDATE: 'BULKUPDATE', SELECT: 'SELECT' },
  async query(sql, { transaction } = {}) {
    const [, kind] = KINDS.find(([pattern]) => pattern.test(sql.trim())) ?? [null, 'other'];
    send(kind, transaction);
    return 7;
  },
  async transaction(options, work) {
    const transaction = { id: ++transactions, isolationLevel: options.isolationLevel, open: true };
    events.push(['begin', transaction.id, transaction.isolationLevel]);
    try {
      const value = await work(transaction);
      events.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      events.push(['rollback', transaction.id]);
      throw err;
    } finally {
      transaction.open = false;
    }
  }
};

// Sequelize's operators, and a where clause as MySQL reads it, for the export bans.
const Op = { in: Symbol('in'), not: Symbol('not'), ne: Symbol('ne'), or: Symbol('or') };
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
const matches = (row, where) =>
  Object.entries(where).every(([column, condition]) => test(row[column], condition));

// The ExportBans table, by ID, the players SteamUsers holds, and the export ban lists each player
// qualifies for, which the stand-in for the statement that works them out gives.
const table = new Map();
let players = [];
let qualifies = {};
const stamped = [];
async function membershipForPlayers(steamUserIDs, { transaction }) {
  assert.strictEqual(transaction.isolationLevel, 'SERIALIZABLE');
  assert.strictEqual(transaction.open, true);
  send('generate', transaction);
  return steamUserIDs.flatMap((steamUser) =>
    (qualifies[steamUser] ?? []).map((list) => ({
      id: `${steamUser},${list}`,
      status: 'TO_BE_CREATED',
      steamUser,
      exportBanList: list
    }))
  );
}
const ExportBan = {
  async findAll({ attributes, where }) {
    send('read');
    return [...table.values()]
      .filter((row) => matches(row, where))
      .map((row) => Object.fromEntries(attributes.map((column) => [column, row[column]])));
  },
  async bulkCreate(rows, { ignoreDuplicates }) {
    assert.strictEqual(ignoreDuplicates, true);
    send('create');
    for (const row of rows)
      if (!table.has(row.id)) table.set(row.id, { ...row, battlemetricsID: null });
  },
  async update(values, { where }) {
    send('update');
    let changed = 0;
    for (const row of table.values())
      if (matches(row, where)) {
        Object.assign(row, values);
        changed++;
      }
    return [changed];
  },
  async destroy({ where }) {
    send('destroy');
    for (const [id, row] of table) if (matches(row, where)) table.delete(id);
  }
};
const ExportBanList = {
  async findAll() {
    return [
      { id: 1, type: 'battlemetrics' },
      { id: 2, type: 'remote' }
    ];
  }
};
const SteamUser = {
  async findAll() {
    return players.map((id) => ({ id }));
  },
  async update(values, { where }) {
    send('stamp');
    stamped.push(...where.id[Op.in]);
  }
};

const stubs = {
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/export-membership': { membershipForPlayers },
  'scbl-lib/db/models': { ExportBan, ExportBanList, SteamUser },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    isDatabaseUnavailable: () => false,
    Op,
    QueryTypes: sequelize.QueryTypes,
    Transaction: { ISOLATION_LEVELS: { SERIALIZABLE: 'SERIALIZABLE' } },
    ValidationError
  },
  'scbl-lib/utils': {
    createDiscordWebhookMessage() {},
    DELETED_WEBHOOK_CODES: [10015, 50027],
    describeError,
    isDiscordWebhookUrl: () => false,
    Logger: {
      verbose: (module, level, message) => logs.push({ module, level, message }),
      important: (module, message) => logs.push({ module, level: 1, message })
    },
    sendDiscordWebhook() {}
  }
};

// Load the importer's modules once each, the real ones for relative imports and the stand-ins above
// for packages, in a context whose waits are skipped and recorded.
const context = vm.createContext({
  process: { env: {} },
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const loaded = new Map();
function moduleFor(specifier, referencingModule) {
  const key = specifier.startsWith('.')
    ? new URL(specifier, referencingModule.identifier).href
    : specifier;
  if (!loaded.has(key))
    loaded.set(
      key,
      specifier.startsWith('.')
        ? readFile(new URL(key), 'utf8').then(
            (source) => new vm.SourceTextModule(source, { context, identifier: key })
          )
        : Promise.resolve().then(() => {
            const exports = stubs[specifier];
            assert.ok(exports, `Unexpected dependency: ${specifier}`);
            return new vm.SyntheticModule(
              Object.keys(exports),
              function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
              },
              { context }
            );
          })
    );
  return loaded.get(key);
}
async function load(path) {
  const module = await moduleFor(path, { identifier: import.meta.url });
  if (module.status === 'unlinked') await module.link(moduleFor);
  if (module.status === 'linked') await module.evaluate();
  return module.namespace.default;
}
const Core = await load('../src/core.js');
const ExportBanManager = await load('../src/export-ban-manager.js');

function reset() {
  events.length = 0;
  delays.length = 0;
  logs.length = 0;
  failures.clear();
  stamped.length = 0;
  transactions = 0;
}
const retryLines = () =>
  logs.filter(({ message }) => /^Attempt \d failed \(.*\)\. Retrying in 5s\.\.\.$/.test(message));

// Each of Core's statements that recalculate reputation points and ranks is one statement, outside
// any transaction. A deadlock, or a lock wait timeout, rolls it back, and it is sent again as a
// whole, 5 seconds later, until it goes through, and the step then finishes as usual.
for (const [step, kind] of [
  ['clearOrphanedUsers', 'orphans'],
  ['updateReputationPoints', 'points'],
  ['updateReputationRank', 'ranks']
]) {
  reset();
  fail(kind, deadlock(), lockWaitTimeout());
  await Core[step]();
  assert.deepStrictEqual(
    events,
    [
      [kind, null],
      [kind, null],
      [kind, null]
    ],
    step
  );
  assert.deepStrictEqual(delays, [5000, 5000], step);
  assert.deepStrictEqual(
    retryLines().map(({ level, message }) => [
      level,
      /Deadlock found|Lock wait timeout/.exec(message)?.[0]
    ]),
    [
      [2, 'Deadlock found'],
      [2, 'Lock wait timeout']
    ],
    step
  );
  assert.match(logs.at(-1).message, / of 7 /, step);

  // Another error is not retried, and fails the step.
  reset();
  fail(kind, syntaxError());
  await assert.rejects(Core[step](), /error in your SQL syntax/, step);
  assert.deepStrictEqual([events, delays], [[[kind, null]], []], step);

  // Nor is one that lasts: the statement is sent 5 times in all, and the step then fails with it.
  reset();
  fail(kind, ...Array.from({ length: 5 }, deadlock));
  await assert.rejects(Core[step](), /Deadlock found/, step);
  assert.deepStrictEqual([events.length, delays], [5, [5000, 5000, 5000, 5000]], step);
}

// Recalculating export bans: players A, B, C and D, in one batch. A qualifies for lists 1 and 2 and
// has no export bans yet, B qualifies for list 1, whose export ban is queued to be deleted, C
// qualifies for none, but has a created one on list 1, and D for none, but has one on list 2 that
// is still to be created.
function setUpExportBans() {
  table.clear();
  players = ['A', 'B', 'C', 'D'];
  qualifies = { A: [1, 2], B: [1] };
  table.set('B,1', {
    id: 'B,1',
    steamUser: 'B',
    exportBanList: 1,
    status: 'TO_BE_DELETED',
    battlemetricsID: null
  });
  table.set('C,1', {
    id: 'C,1',
    steamUser: 'C',
    exportBanList: 1,
    status: 'CREATED',
    battlemetricsID: '111'
  });
  table.set('D,2', {
    id: 'D,2',
    steamUser: 'D',
    exportBanList: 2,
    status: 'TO_BE_CREATED',
    battlemetricsID: null
  });
}
const tableState = () =>
  [...table.values()].map(({ id, status }) => [id, status]).sort(([a], [b]) => a.localeCompare(b));
const RECALCULATED = [
  ['A,1', 'TO_BE_CREATED'],
  ['A,2', 'TO_BE_CREATED'],
  ['B,1', 'TO_BE_CREATED'],
  ['C,1', 'TO_BE_DELETED']
];

// Without a failure, the batch reads in one SERIALIZABLE transaction which export bans its players
// qualify for, and then reads and writes the export bans with one statement for each kind of
// change, each on its own: A's are created, B's is created again, C's is queued to be deleted and
// D's deleted, and the players are marked as recalculated.
reset();
setUpExportBans();
let counts = {};
await ExportBanManager.updateExportBans(counts);
const WRITES = [
  ['read', null],
  ['create', null],
  ['update', null],
  ['update', null],
  ['destroy', null],
  ['stamp', null]
];
assert.deepStrictEqual(
  events,
  [
    ['begin', 1, 'SERIALIZABLE'],
    ['generate', 1],
    ['commit', 1]
  ].concat(WRITES)
);
assert.deepStrictEqual(
  [tableState(), stamped, counts.players, delays],
  [RECALCULATED, players, 4, []]
);

// A deadlock in that read rolls back its whole transaction, so the transaction is run again, as a
// new one, 5 seconds later, and the statement is never sent again in the one MySQL rolled back.
// The batch then goes on as usual.
reset();
setUpExportBans();
fail('generate', deadlock());
counts = {};
await ExportBanManager.updateExportBans(counts);
assert.deepStrictEqual(
  events,
  [
    ['begin', 1, 'SERIALIZABLE'],
    ['generate', 1],
    ['rollback', 1],
    ['begin', 2, 'SERIALIZABLE'],
    ['generate', 2],
    ['commit', 2]
  ].concat(WRITES)
);
assert.deepStrictEqual([tableState(), counts.players, delays], [RECALCULATED, 4, [5000]]);
assert.strictEqual(retryLines().length, 1);

// A write that ends in a deadlock or a lock wait timeout, on its own, is rolled back and sent again
// by itself, and the writes after it carry on as usual, so each change is made once. So is the
// statement that marks the players as recalculated.
reset();
setUpExportBans();
fail('create', deadlock());
fail('update', lockWaitTimeout());
fail('destroy', deadlock());
fail('stamp', lockWaitTimeout(), deadlock());
counts = {};
await ExportBanManager.updateExportBans(counts);
assert.deepStrictEqual(events, [
  ['begin', 1, 'SERIALIZABLE'],
  ['generate', 1],
  ['commit', 1],
  ['read', null],
  ['create', null],
  ['create', null],
  ['update', null],
  ['update', null],
  ['update', null],
  ['destroy', null],
  ['destroy', null],
  ['stamp', null],
  ['stamp', null],
  ['stamp', null]
]);
assert.deepStrictEqual(
  [tableState(), stamped, counts.players, delays],
  [RECALCULATED, players, 4, [5000, 5000, 5000, 5000, 5000]]
);

// Another error is not retried, and fails the step, with the batch's players not marked as
// recalculated.
reset();
setUpExportBans();
fail('create', syntaxError());
await assert.rejects(ExportBanManager.updateExportBans({}), /error in your SQL syntax/);
assert.deepStrictEqual(
  [events.filter(([kind]) => kind === 'create').length, stamped, delays],
  [1, [], []]
);

console.log(
  'Lock retry checks passed: reputation points, orphans and ranks sent again as whole statements, the export recalculation read run again as a new transaction, its writes sent again on their own, and other errors not retried.'
);
