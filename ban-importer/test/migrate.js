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
// given, as Sequelize made it, or is missing if that is null. fail(sql), if given, returns an error
// for a statement to fail with.
function fakeDatabase({
  bans = { characterSet: 'utf8mb3', collationName: 'utf8mb3_general_ci' },
  defaults = { characterSet: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' },
  banListsID = 'int',
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
  if (bans) database.tables.set('Bans', { columns: ['id'], ...bans });
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
    if ((match = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\) (.*)$/))) {
      const [, name, body, options] = match;
      if (!database.tables.has(name)) {
        const columns = body
          .split(',')
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
const ALL = ['001-importer-state', '002-ban-list-syncs'];

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
// ImporterState, and migration 002 BanListSyncs. Each is recorded, and the run is told, as it is
// applied. The connection first makes schema changes wait at most 3 seconds for a table, as other
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
    ['002-ban-list-syncs', ALL]
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
  // The new tables use the existing tables' character set and collation, read from Bans.
  for (const table of ['ImporterSchemaMigrations', 'ImporterState', 'BanListSyncs'])
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
  // Every statement has a time limit, and the connection is closed.
  const [connection] = database.connections;
  assert.ok(connection.queries.every(({ timeout }) => timeout === 5 * 60 * 1000));
  assert.ok(connection.ended);
  // The column check reads the models' tables after the migrations.
  assert.match(database.statements.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(plain(connection.queries.at(-1).values), [
    ['ImporterSchemaMigrations', 'ImporterState', 'BanListSyncs']
  ]);

  // A second run applies nothing, and changes nothing, but still checks the columns.
  const before = database.statements.length;
  assert.deepStrictEqual(plain(await migrate({ onApplied })), { applied: [], unknown: [] });
  assert.strictEqual(told.length, 2);
  const again = database.statements.slice(before);
  assert.ok(!again.some((sql) => /^(CREATE|INSERT|ALTER|DROP)/.test(sql)));
  assert.strictEqual(again[0], 'SET SESSION lock_wait_timeout = 3');
  assert.match(again.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(database.migrations, ALL);
}

// A database that has migration 001, from the importer before this one, is given only migration
// 002.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  await migrate({ migrations: MIGRATIONS.slice(0, 1), models: IMPORTER_MODELS.slice(0, 2) });
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
  assert.ok(!database.tables.has('BanListSyncs'));
  const before = database.statements.length;
  assert.deepStrictEqual(plain(await migrate()), { applied: ['002-ban-list-syncs'], unknown: [] });
  const creates = database.statements.slice(before).filter((sql) => sql.startsWith('CREATE'));
  assert.deepStrictEqual(
    creates.map((sql) => sql.split(' ')[5]),
    ['BanListSyncs']
  );
  assert.deepStrictEqual(database.migrations, ALL);
}

// The foreign key's column has whatever integer type BanLists.id has, as the two must match. A
// BanLists.id that is missing, or not an integer, fails migration 002 before it makes anything.
for (const type of ['int unsigned', 'bigint', 'INT(11)']) {
  const database = fakeDatabase({ banListsID: type });
  const { migrate } = await loadMigrate(database);
  await migrate();
  assert.ok(
    database.statements.some((sql) =>
      sql.startsWith(`CREATE TABLE IF NOT EXISTS BanListSyncs ( banList ${type} NOT NULL,`)
    ),
    type
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

// Without a Bans table, the database's default character set and collation are used.
{
  const database = fakeDatabase({ bans: null });
  const { migrate } = await loadMigrate(database);
  await migrate();
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
    applied: ['002-ban-list-syncs'],
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
      "The importer's tables are missing columns after migration 002-ban-list-syncs: ImporterState.value, BanListSyncs.headTotal."
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
  assert.strictEqual(error.migration, '002-ban-list-syncs');
  assert.match(
    error.message,
    /missing columns after migration 002-ban-list-syncs: ImporterState\.cursor\.$/
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
  database.migrations.push('003-ban-list-pending-removals');
  assert.deepStrictEqual(plain(await migrate()), {
    applied: [],
    unknown: ['003-ban-list-pending-removals']
  });
}

// The models' tables and columns, which migrations 001 and 002 make, as the checks above show.
assert.deepStrictEqual(
  IMPORTER_MODELS.map((model) => [model.getTableName(), Object.keys(model.getAttributes())]),
  [
    ['ImporterSchemaMigrations', ['id', 'appliedAt']],
    ['ImporterState', ['name', 'value', 'updatedAt']],
    ['BanListSyncs', BAN_LIST_SYNC_COLUMNS]
  ]
);

console.log(
  'Importer migration checks passed: a new database, one with migration 001, a second run, BanListSyncs and its foreign key, failures, the column check and newer migrations.'
);
