import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check the statements on the importer's floors and heartbeat rows, without a database: a stand-in
// for Sequelize keeps ImporterState's rows in memory, answers the statements the module sends as
// MySQL would, with its row lock, its gap lock where a row would be, its deadlock between two
// inserts and its refusal of JSON with half a surrogate pair, and records them. It checks the
// heartbeat, creating and reading the floors row, also before the importer has made the table, and
// how a raise changes the row, also with another at the same time.

const NOW = Date.parse('2026-11-05T17:00:00.000Z');
const AT = new Date(NOW).toISOString();

// A statement on one line, with no space after an opening bracket or before a closing one.
const tidy = (sql) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
// Values made in the module's context are copied into this one before they are compared.
const copy = (value) => JSON.parse(JSON.stringify(value));

// MySQL's errors as Sequelize gives them, of Sequelize's kind of error, with MySQL's number and
// code.
class DatabaseError extends Error {}
const mysqlError = (message, errno, code = undefined) =>
  Object.assign(new DatabaseError(message), {
    name: 'SequelizeDatabaseError',
    original: { errno, code }
  });
const noTable = () => mysqlError("Table 'cbl.ImporterState' doesn't exist", 1146);
const deadlock = () => mysqlError('Deadlock found when trying to get lock', 1213);
const duplicate = () => mysqlError("Duplicate entry 'floors' for key 'PRIMARY'", 1062);
const halfPair = () =>
  mysqlError(
    'Invalid JSON text in argument 1 to function cast_as_json: "The surrogate pair in string is invalid."',
    3141
  );

// Whether every text in a JSON value is whole, with no half of a surrogate pair, which MySQL's
// JSON refuses.
const wellFormed = (value) =>
  typeof value === 'string'
    ? value.isWellFormed()
    : value === null ||
      typeof value !== 'object' ||
      Object.entries(value).every(([key, inner]) => key.isWellFormed() && wellFormed(inner));

const STATEMENTS = {
  heartbeat:
    'INSERT INTO ImporterState (name, value, updatedAt) VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3)) AS new ON DUPLICATE KEY UPDATE value = new.value, updatedAt = new.updatedAt',
  find: 'SELECT name FROM ImporterState WHERE name = :name',
  create:
    'INSERT IGNORE INTO ImporterState (name, value, updatedAt) VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3))',
  read: 'SELECT value FROM ImporterState WHERE name = :name',
  lock: 'SELECT value FROM ImporterState WHERE name = :name FOR UPDATE',
  insert:
    'INSERT INTO ImporterState (name, value, updatedAt) VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3))',
  update:
    'UPDATE ImporterState SET value = CAST(:value AS JSON), updatedAt = UTC_TIMESTAMP(3) WHERE name = :name'
};
const kindOf = (statement) =>
  Object.entries(STATEMENTS).find(([, text]) => text === statement)?.[0];

// The table, as each row's JSON text by name, the statements sent, in order, errors for the next
// statements of a kind to fail with, and whether the table is there. A row read comes back parsed,
// as the driver gives it, unless asText says it gives text.
const rows = new Map();
const sent = [];
const failures = new Map();
let tableExists = true;
let asText = false;
// Called as an insert is made, e.g. to add the row of another connection's raise first.
let onInsert = null;

// What InnoDB holds: the transaction that holds the row's lock, those that hold the gap where the
// row would be, as a FOR UPDATE that finds no row leaves it, and those whose insert waits for the
// gap. Those waiting are woken whenever a transaction ends.
let holder = null;
const gap = new Set();
const inserting = new Set();
const waiting = [];
const wake = () => {
  for (const resolve of waiting.splice(0)) resolve();
};
const until = async (free) => {
  while (!free()) await new Promise((resolve) => waiting.push(resolve));
};

const parsed = (name) => (asText ? rows.get(name) : JSON.parse(rows.get(name)));

const sequelize = {
  async query(sql, { type, replacements, transaction } = {}) {
    // Let another transaction get on, as a statement to the database would.
    await new Promise(setImmediate);
    const statement = tidy(sql);
    const kind = kindOf(statement);
    assert.ok(kind, `Unexpected statement: ${statement}`);
    const { name, value } = replacements;
    sent.push({ kind, values: { ...replacements }, type, transaction: transaction ?? null });
    const error = failures.get(kind)?.shift();
    if (error) throw error;
    if (!tableExists) throw noTable();
    if (value !== undefined && !wellFormed(JSON.parse(value))) throw halfPair();

    switch (kind) {
      case 'heartbeat':
        assert.strictEqual(name, 'features:importer');
        rows.set(name, value);
        return [];
      case 'find':
        assert.strictEqual(type, 'SELECT');
        return rows.has(name) ? [{ name }] : [];
      case 'create':
        assert.strictEqual(name, 'floors');
        if (!rows.has(name)) rows.set(name, value);
        return [];
      case 'read':
        assert.strictEqual(type, 'SELECT');
        return rows.has(name) ? [{ value: parsed(name) }] : [];
      case 'lock':
        assert.strictEqual(type, 'SELECT');
        await until(() => holder === null || holder === transaction);
        if (rows.has(name)) {
          holder = transaction;
          return [{ value: parsed(name) }];
        }
        gap.add(transaction);
        return [];
      case 'insert': {
        onInsert?.();
        onInsert = null;
        const others = () => [...gap].filter((other) => other !== transaction);
        // Each waits for the other's gap lock, so MySQL ends the one that closed the circle.
        if (others().some((other) => inserting.has(other))) throw deadlock();
        inserting.add(transaction);
        await until(() => others().length === 0);
        inserting.delete(transaction);
        if (rows.has(name)) throw duplicate();
        transaction.undo = () => rows.delete(name);
        rows.set(name, value);
        holder = transaction;
        return [];
      }
      case 'update': {
        const before = rows.get(name);
        transaction.undo = () => rows.set(name, before);
        rows.set(name, value);
        return [];
      }
    }
    return [];
  },
  // A transaction runs its work, and is rolled back when it fails. Its locks end with it.
  async transaction(work) {
    const transaction = { undo: null };
    sent.push({ kind: 'begin' });
    try {
      const result = await work(transaction);
      sent.push({ kind: 'commit' });
      return result;
    } catch (err) {
      transaction.undo?.();
      sent.push({ kind: 'rollback' });
      throw err;
    } finally {
      gap.delete(transaction);
      inserting.delete(transaction);
      if (holder === transaction) holder = null;
      wake();
    }
  }
};

class FakeDate extends Date {
  constructor(...args) {
    super(...(args.length > 0 ? args : [NOW]));
  }
}

const context = vm.createContext({ Date: FakeDate });
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const names = await load('../floors.js');
await names.link(() => assert.fail('floors.js has no imports'));
const module = await load('../db/floors.js');
await module.link((specifier) => {
  if (specifier === '../floors.js') return names;
  assert.strictEqual(specifier, './sequelize.js');
  return new vm.SyntheticModule(
    ['default', 'QueryTypes'],
    function () {
      this.setExport('default', sequelize);
      this.setExport('QueryTypes', { SELECT: 'SELECT' });
    },
    { context }
  );
});
await module.evaluate();
const { IMPORTER_FEATURES, IMPORTER_GAMES, KNOWN_FEATURES } = names.namespace;
const {
  createFloorsRow,
  FLOORS_ROW,
  hasFloorsRow,
  HEARTBEAT_ROW,
  raiseImporterFloor,
  readFloors,
  withFloorRetries,
  writeImporterHeartbeat
} = module.namespace;

const kinds = () => sent.map(({ kind }) => kind);
const row = (name = FLOORS_ROW) => JSON.parse(rows.get(name));
function reset(floors) {
  rows.clear();
  if (floors !== undefined)
    rows.set(FLOORS_ROW, typeof floors === 'string' ? floors : JSON.stringify(floors));
  sent.length = 0;
  failures.clear();
  tableExists = true;
  asText = false;
  onInsert = null;
}

// The other services and the importer reach both modules by these names.
const { exports: entries } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);
assert.strictEqual(entries['./floors'], './floors.js');
assert.strictEqual(entries['./db/floors'], './db/floors.js');

// This commit's importer has one feature, and every feature it has can be raised.
assert.deepStrictEqual(copy(IMPORTER_FEATURES), ['native-false']);
assert.deepStrictEqual(copy(IMPORTER_GAMES), ['squad']);
assert.deepStrictEqual(copy(KNOWN_FEATURES), ['game-rule', 'native-false']);
assert.ok(IMPORTER_FEATURES.every((feature) => KNOWN_FEATURES.includes(feature)));
assert.deepStrictEqual([FLOORS_ROW, HEARTBEAT_ROW], ['floors', 'features:importer']);

// The heartbeat is one statement, not in a transaction, whose updatedAt is the database's clock
// (see STATEMENTS), and which replaces what the row said before.
reset();
rows.set(HEARTBEAT_ROW, JSON.stringify({ features: ['older'], games: [], gitSha: 'old' }));
await writeImporterHeartbeat({
  features: ['native-false'],
  games: ['squad'],
  gitSha: 'abc1234'
});
assert.deepStrictEqual(kinds(), ['heartbeat']);
assert.strictEqual(sent[0].transaction, null);
assert.deepStrictEqual(row(HEARTBEAT_ROW), {
  features: ['native-false'],
  games: ['squad'],
  gitSha: 'abc1234'
});

// Creating the floors row leaves a row that is there as it is, as it may name floors.
reset();
await createFloorsRow();
assert.deepStrictEqual(kinds(), ['create']);
assert.deepStrictEqual(row(), { importer: [], raised: [] });
reset({ importer: ['game-rule'], raised: [], other: 1 });
await createFloorsRow();
assert.deepStrictEqual(row(), { importer: ['game-rule'], raised: [], other: 1 });

// Whether the row is there is read on its own, with no lock and in no transaction, so it waits for
// no raise that holds the row. A table that is not there is passed on, as the database gives it.
reset();
assert.strictEqual(await hasFloorsRow(), false);
reset({ importer: [], raised: [] });
assert.strictEqual(await hasFloorsRow(), true);
assert.deepStrictEqual(kinds(), ['find']);
assert.strictEqual(sent[0].transaction, null);
reset();
tableExists = false;
await assert.rejects(hasFloorsRow(), (err) => err.original.errno === 1146);

// Before the importer has made the table, or created the row, there are no floors, for any service.
// Other errors are passed on, saying that it was the floors that could not be read, but still the
// database's own error, of its kind and with its number and code, e.g. for whatever tells whether
// the database is unavailable.
reset();
assert.deepStrictEqual(copy(await readFloors()), { importer: [] });
tableExists = false;
assert.deepStrictEqual(copy(await readFloors()), { importer: [] });
reset({ importer: ['game-rule'], raised: [] });
const down = mysqlError('Connection lost', 2013, 'PROTOCOL_CONNECTION_LOST');
failures.set('read', [down]);
await assert.rejects(readFloors(), (err) => {
  assert.strictEqual(err.message, "Could not read the importer's floors: Connection lost");
  assert.ok(err instanceof DatabaseError);
  assert.strictEqual(err.name, 'SequelizeDatabaseError');
  assert.deepStrictEqual(err.original, { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' });
  return true;
});
// The error it came from is left as it was.
assert.strictEqual(down.message, 'Connection lost');
failures.set('read', ['broken']);
await assert.rejects(readFloors(), /^Error: Could not read the importer's floors: broken$/);

// A readable row is given as it is, whether the driver parsed its JSON or left it as text.
for (const text of [false, true]) {
  reset({ importer: ['game-rule'], raised: [{ feature: 'game-rule', by: 'bot', at: AT }], x: 1 });
  asText = text;
  assert.deepStrictEqual(copy(await readFloors()), {
    importer: ['game-rule'],
    raised: [{ feature: 'game-rule', by: 'bot', at: AT }],
    x: 1
  });
}

// A row that is not an object, or whose importer is not a list of names, cannot be read, which is
// not the same as no floors. A raise refuses to overwrite it, and rolls back.
const UNREADABLE = [
  '"text"',
  '3',
  'null',
  '[1, 2]',
  '{}',
  '{"raised": []}',
  '{"importer": "game-rule"}',
  '{"importer": {"game-rule": true}}',
  '{"importer": ["game-rule", 1]}',
  '{"importer": [null]}'
];
for (const text of UNREADABLE) {
  reset(text);
  assert.deepStrictEqual(copy(await readFloors()), { unreadable: true }, text);
  sent.length = 0;
  await assert.rejects(raiseImporterFloor(['game-rule'], { by: 'bot' }), /cannot be read/, text);
  assert.strictEqual(rows.get(FLOORS_ROW), text);
  assert.deepStrictEqual(kinds(), ['begin', 'lock', 'rollback'], text);
}
// Text that is not JSON cannot be read either, as a driver could only give it for a broken row.
reset('{"importer": ["game-rule"]}');
asText = true;
rows.set(FLOORS_ROW, 'not JSON');
assert.deepStrictEqual(copy(await readFloors()), { unreadable: true });
await assert.rejects(raiseImporterFloor(['game-rule'], { by: 'bot' }), /cannot be read/);
assert.strictEqual(rows.get(FLOORS_ROW), 'not JSON');

// The first raise makes the row, and says what it added, who raised it and when. It reads the row
// with a row lock, in one transaction.
reset();
let result = await raiseImporterFloor(['game-rule'], { by: 'bot' });
assert.deepStrictEqual(copy(result), { importer: ['game-rule'], added: ['game-rule'] });
assert.deepStrictEqual(row(), {
  importer: ['game-rule'],
  raised: [{ feature: 'game-rule', by: 'bot', at: AT }]
});
assert.deepStrictEqual(kinds(), ['begin', 'lock', 'insert', 'commit']);
assert.ok(sent.filter(({ values }) => values).every(({ transaction }) => transaction));

// A later raise adds to the row, by a row lock, keeping what it had, and other keys.
reset({
  importer: ['game-rule'],
  raised: [{ feature: 'game-rule', by: 'bot', at: '2026-11-01T00:00:00.000Z' }],
  note: 'kept'
});
result = await raiseImporterFloor(['native-false'], { by: 'web' });
assert.deepStrictEqual(copy(result), {
  importer: ['game-rule', 'native-false'],
  added: ['native-false']
});
assert.deepStrictEqual(row(), {
  importer: ['game-rule', 'native-false'],
  raised: [
    { feature: 'game-rule', by: 'bot', at: '2026-11-01T00:00:00.000Z' },
    { feature: 'native-false', by: 'web', at: AT }
  ],
  note: 'kept'
});
assert.deepStrictEqual(kinds(), ['begin', 'lock', 'update', 'commit']);

// A raise never removes a name, also one it does not know, and adds a raised entry only for what it
// adds. With nothing to add, it writes nothing.
reset({ importer: ['a-later-feature', 'game-rule'], raised: [] });
result = await raiseImporterFloor(['game-rule', 'native-false', 'native-false'], {
  by: 'importer'
});
assert.deepStrictEqual(copy(result), {
  importer: ['a-later-feature', 'game-rule', 'native-false'],
  added: ['native-false']
});
assert.deepStrictEqual(row(), {
  importer: ['a-later-feature', 'game-rule', 'native-false'],
  raised: [{ feature: 'native-false', by: 'importer', at: AT }]
});
sent.length = 0;
const before = rows.get(FLOORS_ROW);
result = await raiseImporterFloor(['game-rule'], { by: 'bot' });
assert.deepStrictEqual(copy(result), {
  importer: ['a-later-feature', 'game-rule', 'native-false'],
  added: []
});
assert.strictEqual(rows.get(FLOORS_ROW), before);
assert.deepStrictEqual(kinds(), ['begin', 'lock', 'commit']);

// A row whose importer can be read keeps it, also when its raised list was broken by hand.
reset({ importer: ['game-rule'], raised: 'broken' });
await raiseImporterFloor(['native-false'], { by: 'bot' });
assert.deepStrictEqual(row(), {
  importer: ['game-rule', 'native-false'],
  raised: [{ feature: 'native-false', by: 'bot', at: AT }]
});

// One name may be given on its own, and what the row keeps of who raised it has a limit.
reset();
result = await raiseImporterFloor('native-false', { by: 'x'.repeat(150) });
assert.deepStrictEqual(copy(result.added), ['native-false']);
assert.strictEqual(row().raised[0].by, 'x'.repeat(100));

// It is cut on a character boundary, as MySQL refuses JSON with half a surrogate pair, such as half
// an emoji, and a lone half already in it is replaced, so the raise, and the caller's data with
// it, is not refused. A whole emoji is kept.
for (const [by, kept] of [
  ['x'.repeat(99) + '\u{1F600}', 'x'.repeat(99)],
  ['x'.repeat(98) + '\u{1F600}', 'x'.repeat(98) + '\u{1F600}'],
  ['bot \uD83D', 'bot �'],
  ['\uDE00 bot', '� bot']
]) {
  reset();
  await raiseImporterFloor('game-rule', { by });
  assert.strictEqual(row().raised[0].by, kept, JSON.stringify(by));
}

// A name that is not known is refused before anything is sent, as it would stop every step of every
// importer, also when the other names given are known.
for (const features of [['game-rule', 'a-later-feature'], ['Game-Rule'], [''], 'a-later-feature']) {
  reset();
  await assert.rejects(
    raiseImporterFloor(features, { by: 'bot' }),
    /no such feature is known/,
    String(features)
  );
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(rows.size, 0);
}

// A raise that is told of a missing table passes it on, as the data it goes with must not be saved
// without it, and other errors are passed on too, without trying again.
reset();
tableExists = false;
await assert.rejects(
  raiseImporterFloor(['game-rule'], { by: 'bot' }),
  (err) => err.original.errno === 1146
);
assert.deepStrictEqual(kinds(), ['begin', 'lock', 'rollback']);
reset();
failures.set('insert', [down]);
await assert.rejects(raiseImporterFloor(['game-rule'], { by: 'bot' }), (err) => err === down);
assert.deepStrictEqual(kinds(), ['begin', 'lock', 'insert', 'rollback']);

// Two first raises at once: each finds no row and locks the gap where it would be, so each insert
// waits for the other's lock. MySQL ends the one that closed the circle in a deadlock, and the
// raise tries again, finds the other's row and adds to it. Both names are kept.
{
  reset();
  const results = await Promise.all([
    raiseImporterFloor(['game-rule'], { by: 'bot' }),
    raiseImporterFloor(['native-false'], { by: 'web' })
  ]);
  assert.strictEqual(kinds().filter((kind) => kind === 'rollback').length, 1);
  assert.strictEqual(kinds().filter((kind) => kind === 'commit').length, 2);
  assert.deepStrictEqual(kinds().filter((kind) => kind === 'insert').length, 2);
  assert.deepStrictEqual(kinds().filter((kind) => kind === 'update').length, 1);
  assert.deepStrictEqual(copy(results[0].added), ['game-rule']);
  assert.deepStrictEqual(copy(results[1].added), ['native-false']);
  assert.deepStrictEqual(row().importer.toSorted(), ['game-rule', 'native-false']);
  assert.strictEqual(row().raised.length, 2);
}

// A raise whose row another raise made after it looked, as where no gap was locked, finds a
// duplicate key, tries again, and adds to that row, which it keeps.
{
  reset();
  onInsert = () =>
    rows.set(
      FLOORS_ROW,
      JSON.stringify({
        importer: ['native-false'],
        raised: [{ feature: 'native-false', by: 'web' }]
      })
    );
  const { added } = await raiseImporterFloor(['game-rule'], { by: 'bot' });
  assert.deepStrictEqual(copy(added), ['game-rule']);
  assert.deepStrictEqual(kinds(), [
    'begin',
    'lock',
    'insert',
    'rollback',
    'begin',
    'lock',
    'update',
    'commit'
  ]);
  assert.deepStrictEqual(row(), {
    importer: ['native-false', 'game-rule'],
    raised: [
      { feature: 'native-false', by: 'web' },
      { feature: 'game-rule', by: 'bot', at: AT }
    ]
  });
}

// A raise is tried 3 times, as a suspension is, whichever of the two errors got in its way.
reset();
failures.set('insert', [deadlock(), duplicate()]);
assert.deepStrictEqual(copy((await raiseImporterFloor(['game-rule'], { by: 'bot' })).added), [
  'game-rule'
]);
assert.strictEqual(kinds().filter((kind) => kind === 'begin').length, 3);
reset();
failures.set('insert', [deadlock(), deadlock(), deadlock()]);
await assert.rejects(
  raiseImporterFloor(['game-rule'], { by: 'bot' }),
  (err) => err.original.errno === 1213
);
assert.strictEqual(kinds().filter((kind) => kind === 'begin').length, 3);
assert.strictEqual(rows.size, 0);
// An error in the row's update is tried again too.
reset({ importer: [], raised: [] });
failures.set('update', [deadlock()]);
await raiseImporterFloor(['game-rule'], { by: 'bot' });
assert.deepStrictEqual(row().importer, ['game-rule']);

// In a caller's transaction, a raise uses that transaction, starts and ends none, and cannot try
// again by itself, so its error goes to the caller.
{
  reset();
  const transaction = { undo: null };
  const { added } = await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
  assert.deepStrictEqual(copy(added), ['game-rule']);
  assert.deepStrictEqual(kinds(), ['lock', 'insert']);
  assert.ok(sent.every((statement) => statement.transaction === transaction));
  holder = null;

  reset();
  failures.set('insert', [deadlock()]);
  await assert.rejects(
    raiseImporterFloor(['game-rule'], { by: 'bot', transaction: { undo: null } }),
    (err) => err.original.errno === 1213
  );
  assert.deepStrictEqual(kinds(), ['lock', 'insert']);
  assert.strictEqual(rows.size, 0);
  gap.clear();
  // An unknown name is refused there too.
  reset();
  await assert.rejects(
    raiseImporterFloor(['a-later-feature'], { by: 'bot', transaction: { undo: null } }),
    /no such feature is known/
  );
  assert.deepStrictEqual(sent, []);
}

// withFloorRetries runs all of a caller's transaction again when a raise in it ends in a deadlock
// or finds a duplicate key, up to 3 times, and resolves as its work does. Other errors, and what
// the third attempt fails with, are passed on.
{
  for (const failure of [deadlock(), duplicate()]) {
    reset();
    let attempts = 0;
    const saved = [];
    failures.set('insert', [failure]);
    const value = await withFloorRetries(async (transaction) => {
      attempts++;
      saved.push(attempts);
      await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
      return 'done';
    });
    assert.strictEqual(value, 'done');
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(saved, [1, 2]);
    assert.deepStrictEqual(kinds(), [
      'begin',
      'lock',
      'insert',
      'rollback',
      'begin',
      'lock',
      'insert',
      'commit'
    ]);
    assert.deepStrictEqual(row().importer, ['game-rule']);
  }

  reset();
  let attempts = 0;
  failures.set('insert', [deadlock(), deadlock(), deadlock()]);
  await assert.rejects(
    withFloorRetries((transaction) => {
      attempts++;
      return raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
    }),
    (err) => err.original.errno === 1213
  );
  assert.strictEqual(attempts, 3);

  reset();
  attempts = 0;
  await assert.rejects(
    withFloorRetries(async () => {
      attempts++;
      throw down;
    }),
    (err) => err === down
  );
  assert.strictEqual(attempts, 1);

  // A duplicate key in the caller's own data, e.g. a name that is taken, would only come again, so
  // it is passed on at once, with work run once, while a deadlock is tried again wherever it came
  // from, as MySQL can end any transaction in one.
  reset();
  attempts = 0;
  const taken = mysqlError("Duplicate entry 'taken' for key 'ReviewLists.name'", 1062);
  await assert.rejects(
    withFloorRetries(async (transaction) => {
      attempts++;
      await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
      throw taken;
    }),
    (err) => err === taken
  );
  assert.strictEqual(attempts, 1);
  assert.strictEqual(rows.size, 0);
  reset();
  attempts = 0;
  const resolved = await withFloorRetries(async (transaction) => {
    attempts++;
    await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
    if (attempts === 1) throw deadlock();
    return 'done';
  });
  assert.strictEqual(resolved, 'done');
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(row().importer, ['game-rule']);

  // The raise goes with what it was made for, so it is rolled back with it.
  reset();
  await assert.rejects(
    withFloorRetries(async (transaction) => {
      await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
      throw new Error('The data could not be saved');
    }),
    /The data could not be saved/
  );
  assert.strictEqual(rows.size, 0);

  // Two callers at once both end with their names, each having run its work again if it had to.
  reset();
  const ran = [0, 0];
  await Promise.all([
    withFloorRetries(async (transaction) => {
      ran[0]++;
      await raiseImporterFloor(['game-rule'], { by: 'bot', transaction });
    }),
    withFloorRetries(async (transaction) => {
      ran[1]++;
      await raiseImporterFloor(['native-false'], { by: 'web', transaction });
    })
  ]);
  assert.strictEqual(ran[0] + ran[1], 3);
  assert.deepStrictEqual(row().importer.toSorted(), ['game-rule', 'native-false']);
  assert.strictEqual(row().raised.length, 2);
}

console.log(
  'Importer floors checks passed: the heartbeat, looking for, creating and reading the floors row, a read that fails, a row that cannot be read, raises that keep what is there and refuse what is not known, who raised it cut on a character boundary, two first raises at once, and a raise in a transaction of its caller, run again as a whole on a deadlock or its own duplicate key.'
);
