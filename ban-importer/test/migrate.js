import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the importer's migrations, without a database: they are applied once each, in order, on a
// connection of their own that waits at most 10 seconds for a table, recorded as they are applied,
// and checked against the importer's models.

// The importer's real models, to check the real migrations against. Loading them makes a Sequelize
// instance, which needs a DATABASE_URI but makes no connection until it is used, which it never is.
process.env.DATABASE_URI ||= 'mysql://cbl:unused@127.0.0.1:1/cbl';
const { IMPORTER_MODELS } = await import('../../scbl-lib/db/models/importer/index.js');

// A stand-in for a MySQL database, as the migration connection sees it. It knows the statements the
// migrations run, makes the tables their CREATE TABLE statements describe, and answers
// information_schema queries from those tables. fail(sql), if given, returns an error for a
// statement to fail with.
function fakeDatabase({
  bans = { characterSet: 'utf8mb3', collationName: 'utf8mb3_general_ci' },
  defaults = { characterSet: 'utf8mb4', collationName: 'utf8mb4_0900_ai_ci' },
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

// On a database without the importer's tables, migration 001 makes ImporterSchemaMigrations and
// ImporterState and is recorded. The connection first makes schema changes wait at most 10 seconds
// for a table, and is closed at the end.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  assert.deepStrictEqual(plain(await migrate()), { applied: ['001-importer-state'], unknown: [] });
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
  assert.strictEqual(database.statements[0], 'SET SESSION lock_wait_timeout = 10');
  assert.deepStrictEqual(database.tables.get('ImporterSchemaMigrations').columns, [
    'id',
    'appliedAt'
  ]);
  assert.deepStrictEqual(database.tables.get('ImporterState').columns, [
    'name',
    'value',
    'updatedAt'
  ]);
  // The new tables use the existing tables' character set and collation, read from Bans.
  for (const table of ['ImporterSchemaMigrations', 'ImporterState'])
    assert.strictEqual(
      database.tables.get(table).options,
      'ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci'
    );
  // Every statement has a time limit, and the connection is closed.
  const [connection] = database.connections;
  assert.ok(connection.queries.every(({ timeout }) => timeout === 5 * 60 * 1000));
  assert.ok(connection.ended);
  // The column check reads the models' tables after the migrations.
  assert.match(database.statements.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(plain(connection.queries.at(-1).values), [
    ['ImporterSchemaMigrations', 'ImporterState']
  ]);

  // A second run applies nothing, and changes nothing, but still checks the columns.
  const before = database.statements.length;
  assert.deepStrictEqual(plain(await migrate()), { applied: [], unknown: [] });
  const again = database.statements.slice(before);
  assert.ok(!again.some((sql) => /^(CREATE|INSERT|ALTER|DROP)/.test(sql)));
  assert.strictEqual(again[0], 'SET SESSION lock_wait_timeout = 10');
  assert.match(again.at(-1), /information_schema\.COLUMNS/);
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
}

// Without a Bans table, the database's default character set and collation are used.
{
  const database = fakeDatabase({ bans: null });
  const { migrate } = await loadMigrate(database);
  await migrate();
  assert.strictEqual(
    database.tables.get('ImporterState').options,
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
        ? Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), {
            code: 'ER_LOCK_WAIT_TIMEOUT'
          })
        : null
  });
  const { migrate, MigrationError } = await loadMigrate(database);
  const error = await migrate().catch((err) => err);
  assert.ok(error instanceof MigrationError);
  assert.strictEqual(error.migration, '001-importer-state');
  assert.strictEqual(
    error.message,
    'Importer migration 001-importer-state failed: Error: Lock wait timeout exceeded; try restarting transaction'
  );
  assert.deepStrictEqual(database.migrations, []);
  assert.ok(database.tables.has('ImporterSchemaMigrations'));
  assert.ok(database.connections[0].ended);

  failing = false;
  assert.deepStrictEqual(plain(await migrate()), { applied: ['001-importer-state'], unknown: [] });
  assert.ok(database.tables.has('ImporterState'));
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
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
  // A column dropped by hand.
  database.tables.get('ImporterState').columns = ['name', 'updatedAt'];
  await assert.rejects(migrate(), {
    name: 'MigrationError',
    message:
      "The importer's tables are missing columns after migration 001-importer-state: ImporterState.value."
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
  const error = await migrate().catch((err) => err);
  assert.strictEqual(error.name, 'MigrationError');
  assert.strictEqual(error.migration, '001-importer-state');
  assert.match(
    error.message,
    /missing columns after migration 001-importer-state: ImporterState\.cursor\.$/
  );
  // The migration itself was applied and recorded.
  assert.deepStrictEqual(database.migrations, ['001-importer-state']);
}

// Migrations the database has that this version does not know, from a newer version, are left as
// they are and named, so a rollback to an older importer still runs.
{
  const database = fakeDatabase();
  const { migrate } = await loadMigrate(database);
  await migrate();
  database.migrations.push('002-ban-list-syncs');
  assert.deepStrictEqual(plain(await migrate()), {
    applied: [],
    unknown: ['002-ban-list-syncs']
  });
}

// The models' tables and columns, which migration 001 makes, as the checks above show.
assert.deepStrictEqual(
  IMPORTER_MODELS.map((model) => [model.getTableName(), Object.keys(model.getAttributes())]),
  [
    ['ImporterSchemaMigrations', ['id', 'appliedAt']],
    ['ImporterState', ['name', 'value', 'updatedAt']]
  ]
);

console.log(
  'Importer migration checks passed: a new database, a second run, failures, the column check and newer migrations.'
);
