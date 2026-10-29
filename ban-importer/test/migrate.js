import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the importer's migrations, without a database: they are applied once each, in order, on a
// connection of their own that waits at most 3 seconds for a table, recorded as they are applied,
// and checked against the importer's models.

// The importer's real models, to check the real migrations against. Loading them makes a Sequelize
// instance, which needs a DATABASE_URI but makes no connection until it is used, which it never is.
process.env.DATABASE_URI ||= 'mysql://cbl:unused@127.0.0.1:1/cbl';
const { IMPORTER_MODELS } = await import('../../scbl-lib/db/models/importer/index.js');
// The real migrations, which have no imports, to give migrate only some of them.
const { default: MIGRATIONS } = await import('../src/schema/migrations.js');

// A stand-in for a MySQL database, as the migration connection sees it. It knows the statements the
// migrations run, makes the tables their CREATE TABLE statements describe, and answers
// information_schema queries from those tables. The CBL's BanLists table has an id of the type
// given, as Sequelize made it, or is missing if that is null, and its Bans table has an id with the
// type, character set and collation given. fail(sql), if given, returns an error for a statement
// to fail with.
function fakeDatabase({
  bans = { characterSet: 'utf8mb3', collationName: 'utf8mb3_general_ci' },
  defaults = { characterSet: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' },
  banListsID = 'int',
  bansID = {
    columnType: 'varchar(255)',
    characterSet: 'utf8mb3',
    collationName: 'utf8mb3_general_ci'
  },
  fail = () => null
} = {}) {
  const database = {
    // Each table's columns and options, by name.
    tables: new Map(),
    migrations: [],
    statements: [],
    connections: [],
    fail
  };
  if (bans) database.tables.set('Bans', { columns: ['id'], ...bans, id: bansID });
  if (banListsID) database.tables.set('BanLists', { columns: ['id'], idType: banListsID });

  const answer = (sql, values) => {
    let match;
    if ((match = sql.match(/^SET SESSION lock_wait_timeout = (\d+)$/))) return [];
    if (/^SELECT COUNT\(\*\) AS count FROM information_schema\.TABLES WHERE/.test(sql))
      return [{ count: database.tables.has(values[0]) ? 1 : 0 }];
    if (sql === 'SELECT id FROM ImporterSchemaMigrations') {
      assert.ok(database.tables.has('ImporterSchemaMigrations'));
      return database.migrations.map((id) => ({ id }));
    }
    if (
      (match = sql.match(
        /FROM information_schema\.TABLES T JOIN information_schema\.COLLATIONS C ON C\.COLLATION_NAME = T\.TABLE_COLLATION WHERE T\.TABLE_SCHEMA = DATABASE\(\) AND T\.TABLE_NAME = '(\w+)'$/
      ))
    ) {
      const table = database.tables.get(match[1]);
      return table?.collationName
        ? [{ characterSet: table.characterSet, collationName: table.collationName }]
        : [];
    }
    if (/FROM information_schema\.SCHEMATA WHERE SCHEMA_NAME = DATABASE\(\)$/.test(sql))
      return [defaults];
    if (
      /^SELECT COLUMN_TYPE AS columnType FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND COLUMN_NAME = 'id'$/.test(
        sql
      )
    ) {
      const table = database.tables.get(values[0]);
      return table?.idType ? [{ columnType: table.idType }] : [];
    }
    if (
      /^SELECT COLUMN_TYPE AS columnType, CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collationName FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \? AND COLUMN_NAME = \?$/.test(
        sql
      )
    ) {
      const column = database.tables.get(values[0])?.[values[1]];
      return column ? [column] : [];
    }
    if ((match = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\) (.*)$/))) {
      const [, name, body, options] = match;
      if (!database.tables.has(name)) {
        // The definitions are separated by the commas outside parentheses.
        const columns = body
          .split(/,(?![^(]*\))/)
          .map((part) => part.trim().split(' ')[0])
          .filter((word) => !/^(PRIMARY|KEY|INDEX|UNIQUE|CONSTRAINT|FOREIGN)$/.test(word));
        database.tables.set(name, { columns, options });
      }
      return [];
    }
    if (
      sql === 'INSERT INTO ImporterSchemaMigrations (id, appliedAt) VALUES (?, UTC_TIMESTAMP(3))'
    ) {
      assert.ok(database.tables.has('ImporterSchemaMigrations'));
      assert.ok(!database.migrations.includes(values[0]), `${values[0]} is recorded once`);
      database.migrations.push(values[0]);
      return [];
    }
    if (
      /FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME IN/.test(
        sql
      )
    )
      return [...database.tables]
        .filter(([name]) => values[0].includes(name))
        .flatMap(([tableName, { columns }]) =>
          columns.map((columnName) => ({ tableName, columnName }))
        );
    throw new Error(`Unexpected statement: ${sql}`);
  };

  // A stand-in for a mysql2/promise connection.
  database.connect = () => {
    const connection = {
      queries: [],
      ended: false,
      destroyed: false,
      async query({ sql, timeout }, values) {
        assert.ok(!this.ended && !this.destroyed, 'The connection is open');
        const statement = sql.replace(/\s+/g, ' ').trim();
        this.queries.push({ sql: statement, timeout, values });
        database.statements.push(statement);
        const error = database.fail(statement);
        if (error) throw error;
        return [answer(statement, values), []];
      },
      async end() {
        this.ended = true;
      },
      destroy() {
        this.destroyed = true;
      }
    };
    database.connections.push(connection);
    return connection;
  };
  return database;
}

// Load migrate.js with the real migrations, a stand-in for the database and the real importer
// models, or the models given.
async function loadMigrate(database, { models = IMPORTER_MODELS, connectError = null } = {}) {
  const dependencies = {
    'scbl-lib/db': {
      openConnection: async () => {
        if (connectError) throw connectError;
        return database.connect();
      }
    },
    'scbl-lib/db/importer-models': { IMPORTER_MODELS: models },
    'scbl-lib/utils': { describeError }
  };
  const context = vm.createContext({ setTimeout, clearTimeout });
  const url = new URL('../src/schema/migrate.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    const exports = dependencies[specifier];
    if (exports)
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    // The real migrations.
    assert.strictEqual(specifier, './migrations.js', `Unexpected dependency: ${specifier}`);
    const migrations = new URL(specifier, referencingModule.identifier);
    return new vm.SourceTextModule(await readFile(migrations, 'utf8'), {
      context,
      identifier: migrations.href
    });
  });
  await module.evaluate();
  return { migrate: module.namespace.default, MigrationError: module.namespace.MigrationError };
}

// Copy a value made in migrate.js's context into one of this test's own, to compare it.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Every migration, in order.
const ALL = [
  '001-importer-state',
  '002-ban-list-syncs',
  '003-ban-list-pending-removals',
  '004-ban-list-suspensions'
];

// The columns of BanListSuspensions, which migration 004 makes.
const SUSPENSION_COLUMNS = ['banList', 'suspendedAt', 'suspendedBy', 'reason', 'resumedAt'];

// The columns of BanListPendingRemovals, which migration 003 makes.
const PENDING_REMOVAL_COLUMNS = ['banList', 'banId', 'firstMissingAt', 'lastMissingAt', 'heldAt'];

// The columns of BanListSyncs, which migration 002 makes.
const BAN_LIST_SYNC_COLUMNS = [
  'banList',
  'sourceKey',
  'state',
  'lastAttemptAt',
  'lastSuccessAt',
  'lastHeadPollAt',
  'lastFullScanAt',
  'nextFullScanAt',
  'scanReason',
  'consecutiveFailures',
  'incompleteScans',
  'lastError',
  'storedCount',
  'headTotal',
  'headUids',
  'replacePending',
  'allowFullRemovalUntil',
  'remoteEtag',
  'remoteLastModified',
  'remoteBodyHash',
  'updatedAt'
];

// On a database without the importer's tables, migration 001 makes ImporterSchemaMigrations and
// ImporterState, migration 002 BanListSyncs, migration 003 BanListPendingRemovals and migration 004
// BanListSuspensions. Each is
// recorded, and the run is told, as it is applied. The connection first makes schema changes wait at most 3 seconds for a table, as other
// queries on the table wait behind them, and is closed at the end.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  const told = [];
  const onApplied = (id) => told.push([id, [...database.migrations]]);
  assert.deepStrictEqual(plain(await migrate({ onApplied })), { applied: ALL, unknown: [] });
  assert.deepStrictEqual(database.migrations, ALL);
  assert.deepStrictEqual(told, [
    ['001-importer-state', ['001-importer-state']],
    ['002-ban-list-syncs', ALL.slice(0, 2)],
    ['003-ban-list-pending-removals', ALL.slice(0, 3)],
    ['004-ban-list-suspensions', ALL]
  ]);
  assert.strictEqual(database.statements[0], 'SET SESSION lock_wait_timeout = 3');
  assert.deepStrictEqual(database.tables.get('ImporterSchemaMigrations').columns, [
    'id',
    'appliedAt'
  ]);
  assert.deepStrictEqual(database.tables.get('ImporterState').columns, [
    'name',
    'value',
    'updatedAt'
  ]);
  assert.deepStrictEqual(database.tables.get('BanListSyncs').columns, BAN_LIST_SYNC_COLUMNS);
  assert.deepStrictEqual(
    database.tables.get('BanListPendingRemovals').columns,
    PENDING_REMOVAL_COLUMNS
  );
  assert.deepStrictEqual(database.tables.get('BanListSuspensions').columns, SUSPENSION_COLUMNS);
  // The new tables use the existing tables' character set and collation, read from Bans.
  for (const table of [
    'ImporterSchemaMigrations',
    'ImporterState',
    'BanListSyncs',
    'BanListPendingRemovals',
    'BanListSuspensions'
  ])
    assert.strictEqual(
      database.tables.get(table).options,
      'ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci'
    );
  // A list's row is keyed by the list, and deleted with it, through a foreign key to the INT key of
  // BanLists, whose type it has. Its state is text, so a new state needs no change to the table,
  // and it is ok until the importer says otherwise. Its error fits in 500 characters.
  const banListSyncs = database.statements.find((sql) =>
    sql.startsWith('CREATE TABLE IF NOT EXISTS BanListSyncs ')
  );
  for (const definition of [
    'banList int NOT NULL,',
    "state VARCHAR(16) NOT NULL DEFAULT 'ok',",
    'consecutiveFailures INT UNSIGNED NOT NULL DEFAULT 0,',
    'lastError VARCHAR(500) NULL,',
    'replacePending TINYINT(1) NOT NULL DEFAULT 0,',
    'updatedAt DATETIME(3) NOT NULL,',
    'PRIMARY KEY (banList),',
    'CONSTRAINT BanListSyncs_banList FOREIGN KEY (banList) REFERENCES BanLists (id) ON DELETE CASCADE )'
  ])
    assert.ok(banListSyncs.includes(definition), definition);
  // A missing ban is keyed by its list and its ban. Its list's foreign key deletes it with the list.
  // Its ban is a plain column, with the type, character set and collation of Bans.id, as Bans.id
  // is not an INT, so the two compare as equal. A ban that only waits for a later read is held for
  // no admin.
  const pendingRemovals = database.statements.find((sql) =>
    sql.startsWith('CREATE TABLE IF NOT EXISTS BanListPendingRemovals ')
  );
  for (const definition of [
    'banList int NOT NULL,',
    'banId varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,',
    'firstMissingAt DATETIME(3) NOT NULL,',
    'lastMissingAt DATETIME(3) NOT NULL,',
    'heldAt DATETIME(3) NULL,',
    'PRIMARY KEY (banList, banId),',
    'CONSTRAINT BanListPendingRemovals_banList FOREIGN KEY (banList) REFERENCES BanLists (id) ON DELETE CASCADE )'
  ])
    assert.ok(pendingRemovals.includes(definition), definition);
  // A paused list is keyed by the list, and deleted with it, through a foreign key to the INT key
  // of BanLists, whose type it has. Who suspended it fits the bot's audit line's name and ID, and
  // why in 500 characters; it is suspended until resumedAt is set.
  const suspensions = database.statements.find((sql) =>
    sql.startsWith('CREATE TABLE IF NOT EXISTS BanListSuspensions ')
  );
  for (const definition of [
    'banList int NOT NULL,',
    'suspendedAt DATETIME(3) NOT NULL,',
    'suspendedBy VARCHAR(100) NOT NULL,',
    'reason VARCHAR(500) NULL,',
    'resumedAt DATETIME(3) NULL,',
    'PRIMARY KEY (banList),',
    'CONSTRAINT BanListSuspensions_banList FOREIGN KEY (banList) REFERENCES BanLists (id) ON DELETE CASCADE )'
  ])
    assert.ok(suspensions.includes(definition), definition);
  // Every statement has a time limit, and the connection is closed.
  const [connection] = database.connections;
  assert.ok(connection.queries.every(({ timeout }) => timeout === 5 * 60 * 1000));
  assert.ok(connection.ended);
  // The column check reads the models' tables after the migrations.
  assert.match(database.statements.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(plain(connection.queries.at(-1).values), [
    [
      'ImporterSchemaMigrations',
      'ImporterState',
      'BanListSyncs',
      'BanListPendingRemovals',
      'BanListSuspensions'
    ]
  ]);

  // A second run applies nothing, and changes nothing, but still checks the columns.
  const before = database.statements.length;
  assert.deepStrictEqual(plain(await migrate({ onApplied })), { applied: [], unknown: [] });
  assert.strictEqual(told.length, 4);
  const again = database.statements.slice(before);
  assert.ok(!again.some((sql) => /^(CREATE|INSERT|ALTER|DROP)/.test(sql)));
  assert.strictEqual(again[0], 'SET SESSION lock_wait_timeout = 3');
  assert.match(again.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(database.migrations, ALL);
}

// A database that has migration 001, or 001 and 002, or 001 to 003, from the importers before this
// one, is given only the migrations it does not have.
for (const [had, given] of [
  [1, ['BanListSyncs', 'BanListPendingRemovals', 'BanListSuspensions']],
  [2, ['BanListPendingRemovals', 'BanListSuspensions']],
  [3, ['BanListSuspensions']]
]) {
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  await migrate({
    migrations: MIGRATIONS.slice(0, had),
    models: IMPORTER_MODELS.slice(0, had + 1)
  });
  assert.deepStrictEqual(database.migrations, ALL.slice(0, had));
  assert.ok(!database.tables.has('BanListSuspensions'));
  const before = database.statements.length;
  assert.deepStrictEqual(plain(await migrate()), { applied: ALL.slice(had), unknown: [] });
  const creates = database.statements.slice(before).filter((sql) => sql.startsWith('CREATE'));
  assert.deepStrictEqual(
    creates.map((sql) => sql.split(' ')[5]),
    given
  );
  assert.deepStrictEqual(database.migrations, ALL);
}

// The foreign key's column has whatever integer type BanLists.id has, as the two must match. A
// BanLists.id that is missing, or not an integer, fails migration 002 before it makes anything.
for (const type of ['int unsigned', 'bigint', 'INT(11)']) {
  const database = fakeDatabase({ banListsID: type });
  const { migrate } = await loadMigrate(database);
  await migrate();
  for (const table of ['BanListSyncs', 'BanListPendingRemovals'])
    assert.ok(
      database.statements.some((sql) =>
        sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} ( banList ${type} NOT NULL,`)
      ),
      `${table}: ${type}`
    );
}
for (const type of [null, 'varchar(255)', 'int; DROP TABLE Bans']) {
  const database = fakeDatabase({ banListsID: type });
  const { migrate } = await loadMigrate(database);
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      'Importer migration 002-ban-list-syncs failed: Error: Could not read the type of BanLists.id, which a foreign key refers to.'
  });
  assert.deepStrictEqual(database.migrations, ['001-importer-state'], String(type));
  assert.ok(!database.tables.has('BanListSyncs'));
}

// The column for a missing ban has whatever VARCHAR type, character set and collation Bans.id has.
// A Bans.id that is missing, not a VARCHAR, or has names that could not be put safely into DDL,
// fails migration 003 before it makes anything.
{
  const database = fakeDatabase({
    bansID: { columnType: 'varchar(191)', characterSet: 'utf8mb4', collationName: 'utf8mb4_bin' }
  });
  const { migrate } = await loadMigrate(database);
  await migrate();
  assert.ok(
    database.statements.some((sql) =>
      sql.includes(' banId varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,')
    )
  );
}
for (const bansID of [
  null,
  { columnType: 'int', characterSet: null, collationName: null },
  { columnType: 'varchar(255)', characterSet: 'utf8mb4', collationName: null },
  { columnType: 'varchar(255)', characterSet: 'utf8mb4; DROP TABLE Bans', collationName: 'x' }
]) {
  const database = fakeDatabase({ bansID });
  const { migrate } = await loadMigrate(database);
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      'Importer migration 003-ban-list-pending-removals failed: Error: Could not read the type of Bans.id, which a column refers to.'
  });
  assert.deepStrictEqual(database.migrations, ALL.slice(0, 2), JSON.stringify(bansID));
  assert.ok(!database.tables.has('BanListPendingRemovals'));
}

// Without a Bans table, the database's default character set and collation are used, but a missing
// ban's column has no Bans.id to take its type from, so migration 003 fails.
{
  const database = fakeDatabase({ bans: null });
  const { migrate } = await loadMigrate(database);
  await assert.rejects(
    migrate(),
    /^MigrationError: Importer migration 003-ban-list-pending-removals failed: Error: Could not read the type of Bans\.id/
  );
  for (const table of ['ImporterState', 'BanListSyncs'])
    assert.strictEqual(
      database.tables.get(table).options,
      'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
    );
}
{
  // Names that could not be put safely into DDL fail the migration.
  const database = fakeDatabase({
    bans: { characterSet: 'utf8mb4', collationName: 'x; DROP TABLE Bans' }
  });
  const { migrate } = await loadMigrate(database);
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      'Importer migration 001-importer-state failed: Error: Could not read the character set and collation of the existing tables.'
  });
  assert.ok(!database.tables.has('ImporterState'));
}

// A migration that fails throws an error naming it, is not recorded, and is applied in full by the
// next run, as its statements can run again. The connection is still closed.
{
  let failing = true;
  const database = fakeDatabase({
    fail: (sql) =>
      failing && /^CREATE TABLE IF NOT EXISTS ImporterState /.test(sql)
        ? Object.assign(new Error("Can't create table 'cbl.ImporterState' (errno: 28)"), {
            errno: 1005,
            code: 'ER_CANT_CREATE_TABLE'
          })
        : null
  });
  const { migrate, MigrationError } = await loadMigrate(database);
  const told = [];
  const error = await migrate({ onApplied: (id) => told.push(id) }).catch((err) => err);
  assert.ok(error instanceof MigrationError);
  assert.strictEqual(error.migration, '001-importer-state');
  assert.strictEqual(
    error.message,
    "Importer migration 001-importer-state failed: Error: Can't create table 'cbl.ImporterState' (errno: 28)"
  );
  assert.deepStrictEqual(database.migrations, []);
  assert.deepStrictEqual(told, []);
  assert.ok(database.tables.has('ImporterSchemaMigrations'));
  assert.ok(database.connections[0].ended);

  failing = false;
  assert.deepStrictEqual(plain(await migrate()), { applied: ALL, unknown: [] });
  assert.ok(database.tables.has('ImporterState'));
  assert.deepStrictEqual(database.migrations, ALL);
}

// A later migration that fails, e.g. as a long transaction on BanLists kept its foreign key from
// being made in time, leaves the earlier ones applied and recorded, and is applied by the next run.
// Its failure says what kept it waiting, and how to find that, as mysql2 gives the timeout with
// MySQL's error number.
{
  let failing = true;
  const database = fakeDatabase({
    fail: (sql) =>
      failing && /^CREATE TABLE IF NOT EXISTS BanListSyncs /.test(sql)
        ? Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), {
            errno: 1205,
            code: 'ER_LOCK_WAIT_TIMEOUT',
            sqlState: 'HY000'
          })
        : null
  });
  const { migrate, MigrationError } = await loadMigrate(database);
  const told = [];
  const error = await migrate({ onApplied: (id) => told.push(id) }).catch((err) => err);
  assert.ok(error instanceof MigrationError);
  assert.strictEqual(error.migration, '002-ban-list-syncs');
  assert.strictEqual(
    error.message,
    'Importer migration 002-ban-list-syncs failed: Error: Lock wait timeout exceeded; try restarting transaction. Another connection has a transaction open on a table the migration needs, e.g. one left open in phpMyAdmin, which SELECT * FROM information_schema.innodb_trx shows. The next run tries the migration again.'
  );
  // The wait was set, for the connection, before the migration's statements ran.
  const statements = database.connections[0].queries.map(({ sql }) => sql);
  assert.ok(
    statements.indexOf('SET SESSION lock_wait_timeout = 3') <
      statements.findIndex((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS BanListSyncs '))
  );
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
  assert.deepStrictEqual(told, ['001-importer-state']);
  assert.ok(!database.tables.has('BanListSyncs'));
  assert.ok(database.connections[0].ended);

  failing = false;
  assert.deepStrictEqual(plain(await migrate({ onApplied: (id) => told.push(id) })), {
    applied: ALL.slice(1),
    unknown: []
  });
  assert.deepStrictEqual(told, ALL);
  assert.deepStrictEqual(database.migrations, ALL);
}

// A connection that cannot be made, or a database whose migrations cannot be read, fails as a
// MigrationError too, and no migration is applied.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database, {
    connectError: new Error('connect ECONNREFUSED')
  });
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      "Could not connect to the database to apply the importer's migrations: Error: connect ECONNREFUSED"
  });
}
{
  const database = fakeDatabase({
    fail: (sql) => (/^SET SESSION/.test(sql) ? new Error('Access denied') : null)
  });
  const { migrate } = await loadMigrate(database);
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      "Could not read which of the importer's migrations the database has: Error: Access denied"
  });
  assert.deepStrictEqual(database.migrations, []);
  assert.ok(!database.tables.has('ImporterState'));
  assert.ok(database.connections[0].ended);
}

// The column check: after the migrations, every column of the importer's models must be in the
// database, or the run fails, naming the columns and the latest migration.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  await migrate();
  // Columns dropped by hand.
  database.tables.get('ImporterState').columns = ['name', 'updatedAt'];
  database.tables.get('BanListSyncs').columns = BAN_LIST_SYNC_COLUMNS.filter(
    (column) => column !== 'headTotal'
  );
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      "The importer's tables are missing columns after migration 004-ban-list-suspensions: ImporterState.value, BanListSyncs.headTotal."
  });
}
{
  // A model with a column no migration makes, as a model changed without a migration would be.
  const database = fakeDatabase();
  const extraModel = {
    getTableName: () => 'ImporterState',
    getAttributes: () => ({ name: { field: 'name' }, cursor: { field: 'cursor' } })
  };
  const { migrate } = await loadMigrate(database, { models: [...IMPORTER_MODELS, extraModel] });
  const told = [];
  const error = await migrate({ onApplied: (id) => told.push(id) }).catch((err) => err);
  assert.strictEqual(error.name, 'MigrationError');
  assert.strictEqual(error.migration, '004-ban-list-suspensions');
  assert.match(
    error.message,
    /missing columns after migration 004-ban-list-suspensions: ImporterState\.cursor\.$/
  );
  // The migrations themselves were applied and recorded, and the run was told, so its record names
  // them, although the next run will not apply them again.
  assert.deepStrictEqual(database.migrations, ALL);
  assert.deepStrictEqual(told, ALL);
}

// Migrations the database has that this version does not know, from a newer version, are left as
// they are and named, so a rollback to an older importer still runs.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  await migrate();
  database.migrations.push('005-export-ban-list-syncs');
  assert.deepStrictEqual(plain(await migrate()), {
    applied: [],
    unknown: ['005-export-ban-list-syncs']
  });
}

// The models' tables and columns, which migrations 001 to 004 make, as the checks above show.
assert.deepStrictEqual(
  IMPORTER_MODELS.map((model) => [model.getTableName(), Object.keys(model.getAttributes())]),
  [
    ['ImporterSchemaMigrations', ['id', 'appliedAt']],
    ['ImporterState', ['name', 'value', 'updatedAt']],
    ['BanListSyncs', BAN_LIST_SYNC_COLUMNS],
    ['BanListPendingRemovals', PENDING_REMOVAL_COLUMNS],
    ['BanListSuspensions', SUSPENSION_COLUMNS]
  ]
);

console.log(
  'Importer migration checks passed: a new database, ones with migrations 001 to 003, a second run, BanListSyncs, BanListPendingRemovals with its held bans, BanListSuspensions, and their keys, failures, the column check and newer migrations.'
);
