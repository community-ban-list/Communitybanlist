import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check how ExportBanList makes changes from the website and the Discord bot wait for each other in
// the database: the transactions they run, once more after a deadlock, the lock on a user's lists,
// and the deletion lock, against stand-ins for Sequelize and MySQL. That MySQL's locks work this way
// across connections is checked against MySQL itself, outside these checks.

// Every query, in order, and what the stand-ins answer.
const calls = [];

// A stand-in for Sequelize's Model, whose findAll records its options.
class Model {
  static init() {}

  static async findAll(options) {
    calls.push(['findAll', options]);
    return lockedLists.map((id) => ({ id }));
  }
}
const dataType = () => dataType;
// Sequelize's error for a database it cannot reach, which the web server shows as unavailable.
class ConnectionError extends Error {
  constructor(parent) {
    super(parent.message);
    this.parent = parent;
  }
}
let lockedLists = [];

// The transactions run, and how each attempt ends: an error for each attempt in turn, until they
// run out.
let attempts = [];
let transactions = 0;
const sequelize = {
  async transaction(work) {
    const transaction = { number: ++transactions };
    calls.push(['begin', transaction.number]);
    const failure = attempts.shift();
    try {
      const result = await work(transaction);
      if (failure) throw failure;
      calls.push(['commit', transaction.number]);
      return result;
    } catch (error) {
      calls.push(['rollback', transaction.number]);
      throw error;
    }
  },
  async query(sql, options) {
    calls.push(['query', sql, options]);
    return { holder };
  }
};
// The connection holding the deletion lock, as IS_USED_LOCK gives it, or null when none does.
let holder = null;

// The deletion lock's connections, each with what was run on it and whether it was closed. GET_LOCK
// answers with `taken`, and end() with `ending`, a promise, or an error.
const connections = [];
let taken = 1;
let ending = null;
let openFailure = null;
async function openConnection() {
  if (openFailure) throw openFailure;
  const connection = {
    queries: [],
    closed: null,
    async query(sql, values) {
      this.queries.push([sql, values]);
      return [[{ taken }]];
    },
    end() {
      if (ending instanceof Error) return Promise.reject(ending);
      if (ending) return ending.then(() => (this.closed = 'ended'));
      this.closed = 'ended';
      return Promise.resolve();
    },
    destroy() {
      this.closed = 'destroyed';
    }
  };
  connections.push(connection);
  return connection;
}

// Timers fire at once, recording how long they were set for, so a connection that will not close
// is closed at once without the checks waiting.
const timers = [];
const context = vm.createContext({
  setTimeout(callback, ms) {
    timers.push(ms);
    return setTimeout(callback, 0);
  },
  clearTimeout
});
const dependencies = {
  sequelize: {
    default: { Model, DataTypes: new Proxy({}, { get: () => dataType }), ConnectionError }
  },
  '../sequelize.js': { default: sequelize },
  '../open-connection.js': { default: openConnection },
  '../export-membership.js': { countMembers: () => assert.fail('Players were counted.') },
  '../../apis/index.js': { battlemetrics: () => assert.fail('BattleMetrics was asked.') },
  '../../apis/delete-battlemetrics-ban-list.js': {
    checkOwnership() {},
    findVisibleBanLists() {},
    removeInvitesAndSubscribers() {},
    removeOwner() {}
  },
  '../../export-list-limits.js': { checkRules: () => [], DEFAULT_SETTINGS: {} },
  '../../utils/index.js': { Logger: { verbose() {}, important() {} } },
  '../../utils/log-text.js': { default: (text) => text },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: '42', EXPORT_LIST_LIMITS: {} }
};
const module = new vm.SourceTextModule(
  await readFile(new URL('../db/models/export-ban-list.js', import.meta.url), 'utf8'),
  { context }
);
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
const ExportBanList = module.namespace.default;

function reset() {
  calls.length = 0;
  connections.length = 0;
  timers.length = 0;
  attempts = [];
  transactions = 0;
  lockedLists = [];
  holder = null;
  taken = 1;
  ending = null;
  openFailure = null;
}
// MySQL's errors as Sequelize gives them, with MySQL's own as original and parent.
const mysqlError = (errno, message) => {
  const original = Object.assign(new Error(message), { errno });
  return Object.assign(new Error(message), { original, parent: original });
};
const deadlock = () =>
  mysqlError(1213, 'Deadlock found when trying to get lock; try restarting transaction');
const lockWaitTimeout = () =>
  mysqlError(1205, 'Lock wait timeout exceeded; try restarting transaction');
// The calls copied out of the module's context, to compare them.
const copied = () => JSON.parse(JSON.stringify(calls));

// A transaction's work runs in it, and what it gives is given once it is committed.
reset();
assert.strictEqual(
  await ExportBanList.inTransaction(async (transaction) => {
    calls.push(['work', transaction.number]);
    return 'done';
  }),
  'done'
);
assert.deepStrictEqual(copied(), [
  ['begin', 1],
  ['work', 1],
  ['commit', 1]
]);

// A transaction MySQL ends in a deadlock, which rolls all of it back, is run once more, as a whole,
// whether Sequelize gives MySQL's error as original or only as parent.
for (const error of [deadlock(), Object.assign(deadlock(), { original: undefined })]) {
  reset();
  attempts = [error];
  const ran = [];
  assert.strictEqual(
    await ExportBanList.inTransaction(async (transaction) => {
      ran.push(transaction.number);
      return 'done';
    }),
    'done'
  );
  assert.deepStrictEqual(ran, [1, 2]);
  assert.deepStrictEqual(copied(), [
    ['begin', 1],
    ['rollback', 1],
    ['begin', 2],
    ['commit', 2]
  ]);
}

// Only once: a second deadlock is given to the caller, as is any other error, at once, such as a
// lock MySQL gave up waiting for, which would only wait as long again, or the work's own refusal.
reset();
attempts = [deadlock(), deadlock()];
await assert.rejects(
  ExportBanList.inTransaction(async () => 'done'),
  ({ original }) => original.errno === 1213
);
assert.strictEqual(transactions, 2);
for (const error of [lockWaitTimeout(), new Error('Export ban list does not exist!')]) {
  reset();
  await assert.rejects(
    ExportBanList.inTransaction(async () => {
      throw error;
    }),
    (thrown) => thrown === error
  );
  assert.strictEqual(transactions, 1);
}

// A user's lists are locked by reading only their IDs FOR UPDATE, in the transaction, by owner, so
// MySQL locks the user's rows of the owner index, and the gap after them, until the transaction
// ends: another list cannot be given to the user meanwhile. It gives how many lists they have.
reset();
lockedLists = [3, 7, 9];
const transaction = { number: 5 };
assert.strictEqual(await ExportBanList.lockListsOf('76561198000000001', { transaction }), 3);
assert.strictEqual(calls.length, 1);
const [[, options]] = calls;
assert.deepStrictEqual(JSON.parse(JSON.stringify(options.attributes)), ['id']);
assert.deepStrictEqual({ ...options.where }, { owner: '76561198000000001' });
assert.strictEqual(options.lock, true);
assert.strictEqual(options.transaction, transaction);

// A deletion runs while its connection holds the list's deletion lock, which it takes without
// waiting, and the connection is closed once the deletion has finished, which frees the lock. Its
// name is worked out by MySQL from the list's ID, as a value, and the database's name, as lock
// names are shared by the whole server, cut to the 64 characters MySQL takes.
const NAME = "LEFT(CONCAT('cbl-export-ban-list-deletion:', ?, ':', DATABASE()), 64)";
reset();
let held;
assert.strictEqual(
  await ExportBanList.whileDeleting(42, async () => {
    // The values come from the module's own context, so they are copied before comparing.
    held = {
      queries: JSON.parse(JSON.stringify(connections[0].queries)),
      closed: connections[0].closed
    };
    return 'deleted';
  }),
  'deleted'
);
assert.deepStrictEqual(held, {
  queries: [[`SELECT GET_LOCK(${NAME}, 0) AS taken`, [42]]],
  closed: null
});
assert.strictEqual(connections.length, 1);
assert.strictEqual(connections[0].closed, 'ended');
// It uses no connection of the Sequelize pool, and no transaction.
assert.deepStrictEqual(calls, []);

// A deletion that fails is given to the caller, and its connection is closed all the same.
reset();
const failure = new Error('Deleting its BattleMetrics ban list failed');
await assert.rejects(
  ExportBanList.whileDeleting(42, async () => {
    throw failure;
  }),
  (error) => error === failure
);
assert.strictEqual(connections[0].closed, 'ended');

// While another connection holds the list's deletion lock, the deletion does not run.
reset();
taken = 0;
let ran = false;
await assert.rejects(
  ExportBanList.whileDeleting(42, async () => {
    ran = true;
  }),
  { message: 'This export ban list is already being deleted.' }
);
assert.strictEqual(ran, false);
assert.strictEqual(connections[0].closed, 'ended');

// A connection that cannot be opened is reported as the database being unavailable, which the web
// server shows in its own words, as mysql2's message can name the database's address.
reset();
openFailure = new Error('connect ECONNREFUSED 10.0.0.2:3306');
await assert.rejects(
  ExportBanList.whileDeleting(42, async () => assert.fail('The deletion ran.')),
  (error) => error instanceof ConnectionError && error.parent === openFailure
);

// A connection that does not close within 5 seconds, or fails to, is closed at once, which frees
// the lock too.
for (const end of [new Promise(() => {}), new Error('Connection lost')]) {
  reset();
  ending = end;
  assert.strictEqual(await ExportBanList.whileDeleting(42, async () => 'deleted'), 'deleted');
  assert.strictEqual(connections[0].closed, 'destroyed');
  assert.deepStrictEqual(timers, [5000]);
}

// Whether a list is being deleted is whether any connection holds its deletion lock, by the same
// name, asked in the caller's transaction.
for (const [connection, expected] of [
  [null, false],
  [1234, true]
]) {
  reset();
  holder = connection;
  assert.strictEqual(await ExportBanList.isBeingDeleted(42, { transaction }), expected);
  assert.strictEqual(calls.length, 1);
  const [[, sql, queryOptions]] = calls;
  assert.strictEqual(sql, `SELECT IS_USED_LOCK(${NAME}) AS holder`);
  assert.deepStrictEqual([...queryOptions.replacements], [42]);
  assert.strictEqual(queryOptions.plain, true);
  assert.strictEqual(queryOptions.transaction, transaction);
}

console.log(
  "Export ban list lock checks passed: transactions run again after a deadlock, the lock on a user's lists, and the deletion lock."
);
