import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check that deleting ban lists runs its transaction again when it ends in a deadlock or a lock
// wait timeout, as a ban importer run writing the same players can cause, and only then, without a
// database. The database is a stand-in that records each statement and each transaction, and
// fails the transactions it is given errors for, and the waits between attempts are skipped but
// recorded.
const calls = [];
const delays = [];
// Errors for the transactions to fail with, in order, one each.
const failures = [];
let transactions = 0;

const sequelize = {
  async transaction(callback) {
    const transaction = { id: ++transactions };
    calls.push(['begin', transaction.id]);
    try {
      const value = await callback(transaction);
      const failure = failures.shift();
      if (failure) throw failure;
      calls.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      calls.push(['rollback', transaction.id]);
      throw err;
    }
  },
  async query(sql, { replacements, transaction }) {
    calls.push(['flags', transaction.id, [...replacements.banListIDs]]);
  }
};
const destroy =
  (name, field) =>
  async ({ where, transaction }) =>
    calls.push([name, transaction.id, [...where[field]]]);
const models = {
  Ban: { count: async () => 0, destroy: destroy('destroy bans', 'banList') },
  BanList: { destroy: destroy('destroy ban lists', 'id') },
  ExportBanListConfig: {
    count: async () => 0,
    destroy: destroy('destroy export ban list configs', 'banList')
  }
};

const context = vm.createContext({
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const dependencies = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/models': models,
  './format.js': { plural: (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}` }
};
const source = await readFile(new URL('../src/utils/delete-ban-lists.js', import.meta.url), 'utf8');
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
const { deleteBanLists } = module.namespace;

// Sequelize's error for a statement MySQL refused, with MySQL's error number.
const databaseError = (message, errno) =>
  Object.assign(new Error(message), { name: 'SequelizeDatabaseError', original: { errno } });
const deadlock = () =>
  databaseError('Deadlock found when trying to get lock; try restarting transaction', 1213);
const lockWaitTimeout = () =>
  databaseError('Lock wait timeout exceeded; try restarting transaction', 1205);

function reset(...errors) {
  calls.length = 0;
  delays.length = 0;
  failures.length = 0;
  failures.push(...errors);
  transactions = 0;
}
// The statements of one attempt to delete list 5 and its organisation, in its transaction.
const deletion = (id) => [
  ['begin', id],
  ['flags', id, [5]],
  ['destroy bans', id, [5]],
  ['destroy export ban list configs', id, [5]],
  ['destroy ban lists', id, [5]],
  ['destroy organisation', id]
];
const organisation = {
  async destroy({ transaction }) {
    calls.push(['destroy organisation', transaction.id]);
  }
};

// A deletion with nothing in its way is one transaction.
reset();
await deleteBanLists([5], organisation);
assert.deepStrictEqual(calls, [...deletion(1), ['commit', 1]]);
assert.deepStrictEqual(delays, []);

// A deletion that ends in a deadlock, or a lock wait timeout, is rolled back and run again as a
// whole, each statement once more, after a wait that grows with each attempt, up to 3 attempts.
reset(deadlock(), lockWaitTimeout());
await deleteBanLists([5], organisation);
assert.deepStrictEqual(calls, [
  ...deletion(1),
  ['rollback', 1],
  ...deletion(2),
  ['rollback', 2],
  ...deletion(3),
  ['commit', 3]
]);
assert.deepStrictEqual(delays, [1000, 2000]);
// An error from Sequelize that keeps MySQL's error as its parent is retried too.
reset(Object.assign(new Error('Deadlock found'), { parent: { errno: 1213 } }));
await deleteBanLists([5]);
assert.strictEqual(transactions, 2);

// One that keeps ending so fails after the 3rd attempt, with its error.
reset(deadlock(), deadlock(), deadlock(), deadlock());
await assert.rejects(deleteBanLists([5]), { message: deadlock().message });
assert.deepStrictEqual([transactions, delays], [3, [1000, 2000]]);

// Any other error fails it at once.
for (const error of [
  databaseError('Cannot delete or update a parent row: a foreign key constraint fails', 1451),
  new Error('connect ECONNREFUSED 10.0.0.2:3306')
]) {
  reset(error);
  await assert.rejects(deleteBanLists([5]), { message: error.message });
  assert.deepStrictEqual([transactions, delays], [1, []], error.message);
}

// The players of paused lists are not queued, as their bans count for nothing, while those of the
// other lists deleted with them are; with every list paused, no player is.
reset();
await deleteBanLists([5, 6, 7], organisation, { paused: [6] });
assert.deepStrictEqual(calls[1], ['flags', 1, [5, 7]]);
reset();
await deleteBanLists([5], organisation, { paused: [5] });
assert.deepStrictEqual(calls, [
  ['begin', 1],
  ['destroy bans', 1, [5]],
  ['destroy export ban list configs', 1, [5]],
  ['destroy ban lists', 1, [5]],
  ['destroy organisation', 1],
  ['commit', 1]
]);

console.log(
  'Ban list deletion checks passed: one transaction, run again after deadlocks and lock wait timeouts, at most 3 times, other errors at once, and no players queued for paused lists.'
);
