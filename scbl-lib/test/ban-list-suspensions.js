import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check the statements on the importer's BanListSuspensions table, without a database: a stand-in
// for Sequelize keeps the table's rows in memory, answers the statements the module sends as MySQL
// would, and records them. It checks reading the paused lists, also before the importer has made
// the table, the two sets of IDs, the SQL piece that leaves their bans out, and how a suspension,
// a resumption and the end of one change the rows.

// A statement on one line, with no space after an opening bracket or before a closing one.
const tidy = (sql) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
// Values made in the module's context are copied into this one before they are compared.
const copy = (value) => JSON.parse(JSON.stringify(value));
// An error the module throws is made in its own context, so it is told by its name.
const typeError = (message) => (err) => err.name === 'TypeError' && message.test(err.message);

// MySQL's errors as Sequelize gives them, with MySQL's number.
const mysqlError = (message, errno) =>
  Object.assign(new Error(message), { name: 'SequelizeDatabaseError', original: { errno } });
const noTable = () => mysqlError("Table 'cbl.BanListSuspensions' doesn't exist", 1146);

// The table, by ban list, the lists that exist, which its foreign key needs, the statements sent,
// in order, and errors for the next statements of a kind to fail with.
const rows = new Map();
const banLists = new Set([7, 46]);
const sent = [];
const failures = new Map();
let tableExists = true;
let now = Date.parse('2026-10-29T12:00:00.000Z');
// Called as an insert is made, e.g. to add the row of another connection's suspension first.
let onInsert = null;
// The lists whose rows the transaction under way changed, which a rollback restores.
let touched = null;

const COLUMNS =
  'SELECT banList, suspendedAt, suspendedBy, reason, resumedAt FROM BanListSuspensions';
const QueryTypes = { SELECT: 'SELECT', BULKDELETE: 'BULKDELETE' };
const rowOut = (row) => ({ ...row, banList: String(row.banList) });

const sequelize = {
  async query(sql, { type, replacements, transaction } = {}) {
    const statement = tidy(sql);
    const values = Array.isArray(replacements) ? [...replacements] : { ...replacements };
    let kind;
    if (statement === `${COLUMNS} ORDER BY banList`) kind = 'read all';
    else if (statement === `${COLUMNS} WHERE banList = ?`) kind = 'read one';
    else if (statement === `${COLUMNS} WHERE banList = :banList FOR UPDATE`) kind = 'lock one';
    else if (statement.startsWith('INSERT INTO BanListSuspensions')) kind = 'insert';
    else if (statement.startsWith('UPDATE BanListSuspensions SET suspendedAt'))
      kind = 'suspend again';
    else if (statement.startsWith('UPDATE BanListSuspensions SET resumedAt')) kind = 'resume';
    else if (statement.startsWith('DELETE FROM BanListSuspensions')) kind = 'end';
    else throw new Error(`Unexpected statement: ${statement}`);
    sent.push({ kind, values, type, transaction: Boolean(transaction) });
    const error = failures.get(kind)?.shift();
    if (error) throw error;
    if (!tableExists) throw noTable();

    switch (kind) {
      case 'read all':
        assert.strictEqual(type, QueryTypes.SELECT);
        return [...rows.values()].sort((a, b) => a.banList - b.banList).map(rowOut);
      case 'read one':
        assert.strictEqual(type, QueryTypes.SELECT);
        return rows.has(values[0]) ? [rowOut(rows.get(values[0]))] : [];
      case 'lock one':
        assert.strictEqual(type, QueryTypes.SELECT);
        return rows.has(values.banList) ? [rowOut(rows.get(values.banList))] : [];
      case 'insert':
        onInsert?.();
        onInsert = null;
        assert.match(
          statement,
          /^INSERT INTO BanListSuspensions \(banList, suspendedAt, suspendedBy, reason, resumedAt\) VALUES \(:banList, UTC_TIMESTAMP\(3\), :by, :reason, NULL\)$/
        );
        if (!banLists.has(values.banList))
          throw mysqlError(
            'Cannot add or update a child row: a foreign key constraint fails',
            1452
          );
        if (rows.has(values.banList)) throw mysqlError('Duplicate entry', 1062);
        touched?.add(values.banList);
        rows.set(values.banList, {
          banList: values.banList,
          suspendedAt: new Date(now),
          suspendedBy: values.by,
          reason: values.reason,
          resumedAt: null
        });
        return [];
      case 'suspend again':
        touched?.add(values.banList);
        assert.strictEqual(
          statement,
          'UPDATE BanListSuspensions SET suspendedAt = UTC_TIMESTAMP(3), suspendedBy = :by, reason = :reason, resumedAt = NULL WHERE banList = :banList'
        );
        Object.assign(rows.get(values.banList), {
          suspendedAt: new Date(now),
          suspendedBy: values.by,
          reason: values.reason,
          resumedAt: null
        });
        return [];
      case 'resume': {
        assert.strictEqual(
          statement,
          'UPDATE BanListSuspensions SET resumedAt = UTC_TIMESTAMP(3) WHERE banList = ? AND resumedAt IS NULL'
        );
        const row = rows.get(values[0]);
        touched?.add(values[0]);
        if (row && row.resumedAt === null) row.resumedAt = new Date(now);
        return [];
      }
      case 'end': {
        assert.strictEqual(
          statement,
          'DELETE FROM BanListSuspensions WHERE banList = ? AND resumedAt = ?'
        );
        assert.strictEqual(type, QueryTypes.BULKDELETE);
        const [banList, resumedAt] = values;
        const row = rows.get(banList);
        if (!row || row.resumedAt?.getTime() !== resumedAt.getTime()) return 0;
        rows.delete(banList);
        return 1;
      }
    }
  },
  // A transaction runs its work, and is rolled back when it fails: the rows it changed are restored,
  // and those other connections changed meanwhile are left.
  async transaction(work) {
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    touched = new Set();
    sent.push({ kind: 'begin' });
    try {
      const value = await work({ id: 'transaction' });
      sent.push({ kind: 'commit' });
      return value;
    } catch (err) {
      for (const id of touched)
        if (before.has(id)) rows.set(id, before.get(id));
        else rows.delete(id);
      sent.push({ kind: 'rollback' });
      throw err;
    } finally {
      touched = null;
    }
  }
};

const context = vm.createContext({});
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const piece = await load('../db/excluded-ban-lists.js');
const module = await load('../db/ban-list-suspensions.js');
await module.link((specifier) => {
  if (specifier === './excluded-ban-lists.js') return piece;
  assert.strictEqual(specifier, './sequelize.js');
  return new vm.SyntheticModule(
    ['default', 'QueryTypes'],
    function () {
      this.setExport('default', sequelize);
      this.setExport('QueryTypes', QueryTypes);
    },
    { context }
  );
});
await module.evaluate();
const {
  MAX_REASON_LENGTH,
  endResumption,
  excludedBanListsSQL,
  isMissingTable,
  pausedSets,
  readExcludedBanLists,
  readPausedBanLists,
  resumeBanList,
  suspendBanList
} = module.namespace;

const kinds = () => sent.map(({ kind }) => kind);
function reset() {
  rows.clear();
  sent.length = 0;
  failures.clear();
  tableExists = true;
}

// Before the importer has made the table, no list is paused, unless the caller asks for the error,
// as the importer does once its migrations have run. Other errors are passed on.
reset();
tableExists = false;
assert.deepStrictEqual(copy(await readPausedBanLists()), []);
assert.deepStrictEqual(copy(await readExcludedBanLists()), []);
await assert.rejects(readPausedBanLists({ missingTable: 'throw' }), (err) => isMissingTable(err));
tableExists = true;
const down = mysqlError('Connection lost', 2013);
failures.set('read all', [down]);
await assert.rejects(readPausedBanLists(), (err) => err === down);
assert.ok(isMissingTable(noTable()));
assert.ok(isMissingTable({ parent: { errno: 1146 } }));
assert.ok(!isMissingTable(down));
assert.ok(!isMissingTable(undefined));

// A suspension adds the list's row, saying who suspended it, why, and since when, in one
// transaction; the reason is kept to MAX_REASON_LENGTH characters, and none is NULL.
reset();
let result = await suspendBanList(46, { by: 'admin (1)', reason: 'Dispute' });
assert.strictEqual(result.outcome, 'suspended');
assert.strictEqual(result.resumed, false);
assert.deepStrictEqual(copy(result.row), {
  banList: 46,
  suspendedAt: new Date(now).toISOString(),
  suspendedBy: 'admin (1)',
  reason: 'Dispute',
  resumedAt: null
});
assert.deepStrictEqual(kinds(), ['begin', 'lock one', 'insert', 'read one', 'commit']);
assert.ok(
  sent.filter(({ kind }) => kind !== 'begin' && kind !== 'commit').every((s) => s.transaction)
);
assert.strictEqual(MAX_REASON_LENGTH, 500);
result = await suspendBanList(7, { by: 'admin (1)', reason: 'x'.repeat(600) });
assert.strictEqual(result.row.reason.length, 500);
result = await suspendBanList(7, { by: 'admin (1)' });
assert.strictEqual(result.outcome, 'already');
assert.strictEqual(result.row.reason.length, 500);

// Suspending a suspended list changes nothing, and says since when and by whom.
sent.length = 0;
result = await suspendBanList(46, { by: 'other (2)', reason: 'Again' });
assert.deepStrictEqual(
  [result.outcome, result.row.suspendedBy, result.row.reason],
  ['already', 'admin (1)', 'Dispute']
);
assert.deepStrictEqual(kinds(), ['begin', 'lock one', 'commit']);

// Every list that is paused is read in order, with its ID as a number, and the sets of those not
// imported (suspended) and those whose bans count for nothing (excluded).
now += 60 * 1000;
assert.strictEqual((await resumeBanList(46)).outcome, 'resuming');
const paused = await readPausedBanLists();
assert.deepStrictEqual(
  paused.map(({ banList }) => banList),
  [7, 46]
);
assert.deepStrictEqual(copy(pausedSets(paused)), { suspended: [7], excluded: [7, 46] });
assert.deepStrictEqual(copy(pausedSets([])), { suspended: [], excluded: [] });
assert.deepStrictEqual(copy(await readExcludedBanLists()), [7, 46]);
assert.strictEqual((await readPausedBanLists({ banList: 46 }))[0].suspendedBy, 'admin (1)');

// A resuming list suspended again is suspended from now, as the admin says, and the result says it
// was resuming.
now += 60 * 1000;
sent.length = 0;
result = await suspendBanList(46, { by: 'other (2)', reason: null });
assert.deepStrictEqual(
  [result.outcome, result.resumed, result.row.suspendedBy, result.row.reason, result.row.resumedAt],
  ['suspended', true, 'other (2)', null, null]
);
assert.strictEqual(result.row.suspendedAt.getTime(), now);
assert.deepStrictEqual(kinds(), ['begin', 'lock one', 'suspend again', 'read one', 'commit']);

// A list removed meanwhile cannot be suspended, as its foreign key says. Another suspension of the
// same list that got in first, a duplicate key or a deadlock, makes the suspension try again, and
// find it suspended. Other errors are passed on, and the transaction is rolled back.
reset();
assert.deepStrictEqual(copy(await suspendBanList(99, { by: 'admin (1)' })), {
  outcome: 'gone',
  row: null
});
assert.strictEqual(rows.size, 0);
reset();
// The other suspension's row, made after the first attempt found none.
onInsert = () =>
  rows.set(46, {
    banList: 46,
    suspendedAt: new Date(now),
    suspendedBy: 'other (2)',
    reason: null,
    resumedAt: null
  });
result = await suspendBanList(46, { by: 'admin (1)' });
assert.deepStrictEqual([result.outcome, result.row.suspendedBy], ['already', 'other (2)']);
reset();
failures.set('insert', [mysqlError('Deadlock found', 1213)]);
assert.strictEqual((await suspendBanList(46, { by: 'admin (1)' })).outcome, 'suspended');
assert.deepStrictEqual(kinds().filter((kind) => kind === 'rollback').length, 1);
reset();
failures.set('insert', [
  mysqlError('Deadlock found', 1213),
  mysqlError('Deadlock found', 1213),
  mysqlError('Deadlock found', 1213)
]);
await assert.rejects(suspendBanList(46, { by: 'admin (1)' }), (err) => err.original.errno === 1213);
reset();
tableExists = false;
await assert.rejects(suspendBanList(46, { by: 'admin (1)' }), (err) => isMissingTable(err));

// A resumption sets resumedAt on a suspended list, from now, and nothing else. A list resuming
// already, or not paused, is left as it is.
reset();
await suspendBanList(46, { by: 'admin (1)', reason: 'Dispute' });
now += 60 * 1000;
sent.length = 0;
result = await resumeBanList(46);
assert.strictEqual(result.outcome, 'resuming');
assert.strictEqual(result.row.resumedAt.getTime(), now);
assert.deepStrictEqual([result.row.suspendedBy, result.row.reason], ['admin (1)', 'Dispute']);
assert.deepStrictEqual(kinds(), ['begin', 'read one', 'resume', 'read one', 'commit']);
const resumedAt = result.row.resumedAt;
now += 60 * 1000;
result = await resumeBanList(46);
assert.deepStrictEqual(
  [result.outcome, result.row.resumedAt.getTime()],
  ['already', resumedAt.getTime()]
);
assert.deepStrictEqual(copy(await resumeBanList(7)), { outcome: 'not_paused', row: null });
tableExists = false;
await assert.rejects(resumeBanList(46), (err) => isMissingTable(err));
tableExists = true;

// The importer ends a resumption by deleting the row, only while it has the resumedAt the importer
// read, and is told whether it did. A list suspended or resumed again since keeps its row.
assert.strictEqual(await endResumption(46, new Date(resumedAt.getTime() + 1)), false);
assert.ok(rows.has(46));
assert.strictEqual(await endResumption(46, resumedAt), true);
assert.ok(!rows.has(46));
assert.strictEqual(await endResumption(46, resumedAt), false);

// The SQL piece: the paused lists' IDs, in order, or nothing for none, and anything but positive
// whole IDs, each once, refused.
assert.strictEqual(excludedBanListsSQL([46, 7]), 'B.banList NOT IN (7, 46)');
assert.strictEqual(excludedBanListsSQL([7], 'X'), 'X.banList NOT IN (7)');
assert.strictEqual(excludedBanListsSQL([]), null);
for (const ids of [undefined, null, 7, '7', [0], [-1], [2.5], ['7'], [7, 7], [2 ** 53]])
  assert.throws(() => excludedBanListsSQL(ids), typeError(/excluded ban list/), String(ids));

console.log(
  'Ban list suspension checks passed: reads before and after the table is made, the two sets, suspensions, also of resuming lists, of removed lists and against each other, resumptions, the end of one only while unchanged, and the SQL piece.'
);
