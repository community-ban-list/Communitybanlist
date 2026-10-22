import { openConnection } from 'scbl-lib/db';
import { IMPORTER_MODELS } from 'scbl-lib/db/importer-models';
import { describeError } from 'scbl-lib/utils';

import MIGRATIONS from './migrations.js';

// A schema change waits at most this many seconds for a table that another connection is using,
// e.g. in a long transaction, and then fails. While it waits, every other query on that table
// waits behind it, such as the website's and the bot's on BanLists while a foreign key to it is
// made, so the wait is kept short. The next run tries the migration again.
const LOCK_WAIT_TIMEOUT = 3;

// The error a schema change fails with when that wait runs out: MySQL's ER_LOCK_WAIT_TIMEOUT.
const LOCK_WAIT_TIMEOUT_ERROR = 1205;

// A statement that takes longer than this has stopped working, so the run fails rather than wait
// for it any longer.
const STATEMENT_TIMEOUT = 5 * 60 * 1000;

// How long to wait for the connection to close before closing it at once.
const CLOSE_TIMEOUT = 5 * 1000;

const MIGRATIONS_TABLE = 'ImporterSchemaMigrations';

// The importer's tables could not be brought up to date. The message names the migration, so the
// run's failure says which one to look at.
export class MigrationError extends Error {
  constructor(message, migration) {
    super(message);
    this.name = 'MigrationError';
    this.migration = migration;
  }
}

// Wait for a promise, but give up after ms milliseconds.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function close(connection) {
  try {
    await withTimeout(connection.end(), CLOSE_TIMEOUT);
  } catch {
    connection.destroy();
  }
}

// Why a migration failed, for the run's failure: the error, and for a lock wait timeout, what kept
// the migration waiting and how to find it.
function migrationFailure(err) {
  const reason = describeError(err);
  if (err?.errno !== LOCK_WAIT_TIMEOUT_ERROR) return reason;
  return `${reason}. Another connection has a transaction open on a table the migration needs, e.g. one left open in phpMyAdmin, which SELECT * FROM information_schema.innodb_trx shows. The next run tries the migration again.`;
}

// The ids of the migrations the database has, which is none before the first migration has made
// their table.
async function appliedMigrations(query) {
  const [[{ count }]] = await query(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [MIGRATIONS_TABLE]
  );
  if (Number(count) === 0) return new Set();
  const [rows] = await query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  return new Set(rows.map(({ id }) => id));
}

// The columns of the models' tables that are missing from the database, as table.column.
async function missingColumns(query, models) {
  const tables = models.map((model) => model.getTableName());
  const [rows] = await query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    [tables]
  );
  const found = new Set(rows.map(({ tableName, columnName }) => `${tableName}.${columnName}`));
  return models.flatMap((model) =>
    Object.values(model.getAttributes())
      .map(({ field }) => `${model.getTableName()}.${field}`)
      .filter((column) => !found.has(column))
  );
}

// Apply, in order, the importer's migrations that the database does not have yet, on a connection
// of its own, then check that every column of the importer's models is in the database, so a
// missing one fails the run here rather than its queries later. The run does this while it holds
// the run lock and before its first step, so no other run uses or changes the tables meanwhile.
// Resolves with the ids of the migrations it applied, and of any the database has that this
// version does not know, from a newer version, which are left as they are. If anything fails, it
// throws a MigrationError, which names the migration that failed, if one did. onApplied(id) is
// called as each migration is recorded, so the run record names the migrations applied before a
// failure too.
export default async function migrate({
  migrations = MIGRATIONS,
  models = IMPORTER_MODELS,
  onApplied = () => {}
} = {}) {
  const latest = migrations.at(-1)?.id;
  let connection;
  try {
    connection = await openConnection();
  } catch (err) {
    throw new MigrationError(
      `Could not connect to the database to apply the importer's migrations: ${describeError(err)}`
    );
  }
  const query = (sql, values) => connection.query({ sql, timeout: STATEMENT_TIMEOUT }, values);

  try {
    let known;
    try {
      // First, so that no schema change below can queue behind a long transaction.
      await query(`SET SESSION lock_wait_timeout = ${LOCK_WAIT_TIMEOUT}`);
      known = await appliedMigrations(query);
    } catch (err) {
      throw new MigrationError(
        `Could not read which of the importer's migrations the database has: ${describeError(err)}`
      );
    }

    const applied = [];
    for (const { id, up } of migrations) {
      if (known.has(id)) continue;
      try {
        await up(query);
        await query(
          `INSERT INTO ${MIGRATIONS_TABLE} (id, appliedAt) VALUES (?, UTC_TIMESTAMP(3))`,
          [id]
        );
      } catch (err) {
        throw new MigrationError(`Importer migration ${id} failed: ${migrationFailure(err)}`, id);
      }
      applied.push(id);
      onApplied(id);
    }

    let missing;
    try {
      missing = await missingColumns(query, models);
    } catch (err) {
      throw new MigrationError(
        `Could not check the importer's tables after migration ${latest}: ${describeError(err)}`,
        latest
      );
    }
    if (missing.length > 0)
      throw new MigrationError(
        `The importer's tables are missing columns after migration ${latest}: ${missing.join(', ')}.`,
        latest
      );

    const ids = new Set(migrations.map(({ id }) => id));
    return { applied, unknown: [...known].filter((id) => !ids.has(id)) };
  } finally {
    await close(connection);
  }
}
