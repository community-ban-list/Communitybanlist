import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../utils/describe-error.js';

const password = 'secret-password';

// A stand-in for a mysql2/promise connection, which answers queries with answer(sql, values).
class FakeConnection extends EventEmitter {
  constructor(answer) {
    super();
    this.answer = answer;
    this.queries = [];
    this.ended = false;
    this.destroyed = false;
  }

  async query({ sql, timeout }, values) {
    // Copy the values, which were made in the test's context, so they compare as plain arrays.
    this.queries.push({ sql, timeout, values: values && [...values] });
    return [await this.answer(sql, values), []];
  }

  async end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

// Load run-lock.js with a stand-in for mysql2, Sequelize settings read from a DATABASE_URI, and
// timers and a console that record what they are given.
async function loadRunLock() {
  const mysql = { options: [], connect: async () => connection };
  let connection = null;
  const output = [];
  const intervals = [];
  const dependencies = {
    'mysql2/promise': {
      default: {
        createConnection: async (options) => {
          mysql.options.push({ ...options });
          return mysql.connect();
        }
      }
    },
    '../utils/describe-error.js': { default: describeError },
    './sequelize.js': {
      default: {
        config: {
          host: 'db',
          port: 3306,
          username: 'cbl',
          password,
          database: 'cbl',
          dialectOptions: { charset: 'utf8mb4' },
          pool: {}
        }
      }
    }
  };
  const context = vm.createContext({
    // Format what is printed as the console does, so an object printed whole would show in full.
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    setInterval: (callback, ms) => {
      const interval = { callback, ms, unrefed: false, cleared: false };
      interval.unref = () => {
        interval.unrefed = true;
        return interval;
      };
      intervals.push(interval);
      return interval;
    },
    clearInterval: (interval) => {
      if (interval) interval.cleared = true;
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    clearTimeout
  });
  const url = new URL('../db/run-lock.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { context });
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

  return {
    takeRunLock: module.namespace.default,
    mysql,
    output,
    intervals,
    // Answer queries on the next connection made.
    connectAnswering(answer) {
      connection = new FakeConnection(answer);
      return connection;
    }
  };
}

const lockQuery = (connection) => connection.queries.map(({ sql }) => sql);

// GET_LOCK gives 1 when the lock is taken, 0 when another connection holds it, and NULL on error.
const getLock =
  (acquired, extra = () => [{ held: 1 }]) =>
  (sql, values) =>
    /GET_LOCK/.test(sql) ? [{ acquired, name: 'cbl-importer:cbl' }] : extra(sql, values);

// The lock is taken on a connection of its own, made with the settings the Sequelize pool read
// from DATABASE_URI, without waiting.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const lock = await runLock.takeRunLock();
  assert.ok(lock);
  assert.deepStrictEqual(runLock.mysql.options, [
    {
      host: 'db',
      port: 3306,
      user: 'cbl',
      password,
      database: 'cbl',
      charset: 'utf8mb4'
    }
  ]);
  assert.deepStrictEqual(lockQuery(connection), [
    "SELECT GET_LOCK(CONCAT('cbl-importer:', DATABASE()), 0) AS acquired, CONCAT('cbl-importer:', DATABASE()) AS name"
  ]);
  assert.ok(connection.queries[0].timeout > 0);

  // It is kept alive every minute by a timer that does not keep the process running.
  assert.strictEqual(runLock.intervals.length, 1);
  const [keepAlive] = runLock.intervals;
  assert.strictEqual(keepAlive.ms, 60 * 1000);
  assert.ok(keepAlive.unrefed);
  keepAlive.callback();
  await new Promise(setImmediate);
  assert.strictEqual(connection.queries[1].sql, 'DO 1');
  assert.ok(connection.queries[1].timeout > 0);

  // isHeld() asks MySQL whether this connection holds the lock.
  assert.strictEqual(await lock.isHeld(), true);
  assert.deepStrictEqual(connection.queries[2], {
    sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held',
    timeout: connection.queries[2].timeout,
    values: ['cbl-importer:cbl']
  });
  assert.strictEqual(lock.lost, false);

  // release() frees the lock, closes the connection and stops the keep-alive. Closing the
  // connection is not reported as losing the lock.
  await lock.release();
  assert.deepStrictEqual(connection.queries[3].values, ['cbl-importer:cbl']);
  assert.strictEqual(connection.queries[3].sql, 'SELECT RELEASE_LOCK(?)');
  assert.ok(connection.ended);
  assert.ok(keepAlive.cleared);
  connection.emit('end');
  assert.strictEqual(lock.lost, false);
  assert.strictEqual(await lock.isHeld(), false);
  await lock.release();
  assert.strictEqual(connection.queries.length, 4);
  assert.deepStrictEqual(runLock.output, []);
}

// When another run holds the lock, there is no lock and the connection is closed.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(0));
  assert.strictEqual(await runLock.takeRunLock(), null);
  assert.ok(connection.ended);
  assert.strictEqual(runLock.intervals.length, 0);

  // If MySQL does not let it close, it is closed at once.
  const stuck = runLock.connectAnswering(getLock(0));
  stuck.end = () => Promise.reject(new Error("Can't add new command when connection is closed"));
  assert.strictEqual(await runLock.takeRunLock(), null);
  assert.ok(stuck.destroyed);
}

// A NULL from GET_LOCK, a failed query or a failed connection is an error, which never includes
// the connection settings, and the connection is closed.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(null));
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock/);
  assert.ok(connection.ended);

  const failing = runLock.connectAnswering(() => {
    throw Object.assign(new Error("Incorrect user-level lock name 'NULL'."), { code: 'ER' });
  });
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock: .*lock name/);
  assert.ok(failing.destroyed);

  // Errors from connecting can hold the settings they were given.
  runLock.mysql.connect = async () => {
    throw Object.assign(new Error("Access denied for user 'cbl'@'10.0.0.5'"), {
      config: { password }
    });
  };
  const error = await runLock.takeRunLock().catch((err) => err);
  assert.match(error.message, /^Could not connect to the database to take the run lock: .*denied/);
  assert.ok(!format(error).includes(password));
  assert.ok(!error.config);
  assert.deepStrictEqual(runLock.output, []);
}

// The lock is lost when its connection fails, closes, or stops answering, or when MySQL says the
// connection no longer holds it. The run is told once, with the reason, and the connection is
// closed in case it still holds the lock.
for (const [loseLock, reason] of [
  [(connection) => connection.emit('error', new Error('Connection lost')), /Connection lost/],
  [(connection) => connection.emit('end'), /closed the connection/],
  [
    (connection, runLock) => {
      connection.answer = () => {
        throw new Error('Query inactivity timeout');
      };
      runLock.intervals[0].callback();
    },
    /Query inactivity timeout/
  ],
  [
    (connection, runLock, lock) => {
      connection.answer = () => [{ held: 0 }];
      return lock.isHeld().then((held) => assert.strictEqual(held, false));
    },
    /no longer holds it/
  ]
]) {
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const losses = [];
  const lock = await runLock.takeRunLock({ onLost: (why) => losses.push(why) });
  await loseLock(connection, runLock, lock);
  await new Promise(setImmediate);
  connection.emit('error', new Error('Another error'));
  connection.emit('end');

  assert.strictEqual(lock.lost, true);
  assert.strictEqual(losses.length, 1);
  assert.match(losses[0], reason);
  assert.ok(connection.destroyed);
  assert.ok(runLock.intervals[0].cleared);
  assert.strictEqual(await lock.isHeld(), false);

  // Releasing a lost lock does nothing more.
  const queries = connection.queries.length;
  await lock.release();
  assert.strictEqual(connection.queries.length, queries);
  assert.strictEqual(connection.ended, false);
}

// If the lock cannot be freed, closing its connection frees it.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(
    getLock(1, () => {
      throw new Error('Connection lost');
    })
  );
  const lock = await runLock.takeRunLock({ onLost: () => assert.fail('Not lost') });
  await lock.release();
  assert.ok(connection.destroyed);
}

// destroy() closes the connection at once, for a run that has to exit straight away.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const lock = await runLock.takeRunLock({ onLost: () => assert.fail('Not lost') });
  lock.destroy();
  assert.ok(connection.destroyed);
  assert.ok(runLock.intervals[0].cleared);
  connection.emit('end');
  assert.strictEqual(connection.queries.length, 1);
}

console.log('Run lock checks passed: taking, keeping, losing and releasing it.');
