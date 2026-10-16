import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import describeError from '../utils/describe-error.js';

const password = 'secret-password';

// MySQL has stopped answering.
const noAnswer = () => new Promise(() => {});

// A stand-in for a mysql2/promise connection, which answers queries with answer(sql, values). As
// with mysql2, destroying its socket fails the queries still waiting for an answer, or reports the
// connection as lost if none is waiting, while destroy() only half-closes it, which fails nothing.
class FakeConnection extends EventEmitter {
  constructor(answer) {
    super();
    this.answer = answer;
    this.queries = [];
    this.waiting = new Set();
    this.ended = false;
    this.destroyed = false;
    this.socketDestroyed = false;
    this.connection = {
      stream: {
        destroy: () => {
          this.socketDestroyed = true;
          const err = new Error('Connection lost: The server closed the connection.');
          if (this.waiting.size === 0) this.emit('error', err);
          for (const fail of this.waiting) fail(err);
          this.waiting.clear();
        }
      }
    };
  }

  query({ sql, timeout }, values) {
    // Copy the values, which were made in the test's context, so they compare as plain arrays.
    this.queries.push({ sql, timeout, values: values && [...values] });
    return new Promise((resolve, reject) => {
      this.waiting.add(reject);
      const answered = (finish) => (value) => {
        this.waiting.delete(reject);
        finish(value);
      };
      Promise.resolve()
        .then(() => this.answer(sql, values))
        .then(
          answered((rows) => resolve([rows, []])),
          answered(reject)
        );
    });
  }

  async end() {
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

// Load run-lock.js with a stand-in for mysql2, Sequelize settings read from a DATABASE_URI and a
// Sequelize pool that answers IS_FREE_LOCK with pool.free, a console that records what it is given,
// and timers that only run when the test moves the clock on.
async function loadRunLock() {
  const mysql = { options: [], connect: async () => connection };
  let connection = null;
  const pool = { queries: [], free: 1 };
  const output = [];
  const intervals = [];
  const timers = new Set();
  let now = 0;
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
        },
        async query(sql, { type }) {
          pool.queries.push({ sql, type });
          return [{ free: pool.free }];
        }
      },
      QueryTypes: { SELECT: 'SELECT' }
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
    setTimeout: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer)
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
    isRunLockHeld: module.namespace.isRunLockHeld,
    mysql,
    pool,
    output,
    intervals,
    timers,
    // Answer queries on the next connection made.
    connectAnswering(answer) {
      connection = new FakeConnection(answer);
      return connection;
    },
    // Move the clock on, running the timers that fall due, in order.
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [next] = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = end;
    }
  };
}

// Let promise callbacks run.
const settle = () => new Promise(setImmediate);

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
  await settle();
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
  assert.ok(!connection.socketDestroyed);
  assert.deepStrictEqual(runLock.output, []);
  assert.strictEqual(runLock.timers.size, 0);
}

// When another run holds the lock, there is no lock and the connection is closed.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(0));
  assert.strictEqual(await runLock.takeRunLock(), null);
  assert.ok(connection.ended);
  assert.strictEqual(runLock.intervals.length, 0);

  // If MySQL does not let it close, its socket is destroyed at once.
  const stuck = runLock.connectAnswering(getLock(0));
  stuck.end = () => Promise.reject(new Error("Can't add new command when connection is closed"));
  assert.strictEqual(await runLock.takeRunLock(), null);
  assert.ok(stuck.socketDestroyed);
}

// A NULL from GET_LOCK, a failed query or a failed connection is an error, which never includes
// the connection settings, and the connection is closed.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(null));
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock/);
  assert.ok(connection.ended);

  // Destroying the socket of a connection nothing else listens to is reported as an error, which
  // must not escape.
  const failing = runLock.connectAnswering(() => {
    throw Object.assign(new Error("Incorrect user-level lock name 'NULL'."), { code: 'ER' });
  });
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock: .*lock name/);
  assert.ok(failing.socketDestroyed);

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
  await settle();
  connection.emit('error', new Error('Another error'));
  connection.emit('end');

  assert.strictEqual(lock.lost, true);
  assert.strictEqual(losses.length, 1);
  assert.match(losses[0], reason);
  assert.ok(connection.socketDestroyed);
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
  assert.ok(connection.socketDestroyed);
}

// destroy() closes the connection at once, for a run that has to exit straight away.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const lock = await runLock.takeRunLock({ onLost: () => assert.fail('Not lost') });
  lock.destroy();
  assert.ok(connection.socketDestroyed);
  assert.ok(runLock.intervals[0].cleared);
  connection.emit('end');
  assert.strictEqual(connection.queries.length, 1);
}

// A query that waits behind one MySQL never answers still gives up in time, as its deadline starts
// when it is made, not when mysql2 sends it. Here isHeld() waits behind a keep-alive. Once the
// keep-alive's deadline passes, the lock is lost and the connection's socket is destroyed, which
// fails the queries still waiting, so isHeld() answers at once.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const losses = [];
  const lock = await runLock.takeRunLock({ onLost: (why) => losses.push(why) });
  connection.answer = noAnswer;
  runLock.intervals[0].callback();
  runLock.advance(10 * 1000);
  const held = lock.isHeld();
  await settle();
  runLock.advance(20 * 1000);

  assert.strictEqual(await held, false);
  assert.strictEqual(lock.lost, true);
  assert.deepStrictEqual(losses, ['Error: Timed out']);
  assert.ok(connection.socketDestroyed);
  await settle();
  assert.strictEqual(connection.waiting.size, 0);
  assert.strictEqual(runLock.timers.size, 0);
}

// Even when closing the connection fails nothing, as mysql2's destroy() does when there is no
// socket to destroy, a waiting query gives up at its own deadline, 30 seconds after it was made.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const lock = await runLock.takeRunLock();
  connection.connection = undefined;
  connection.answer = noAnswer;
  runLock.intervals[0].callback();
  runLock.advance(10 * 1000);
  let held;
  lock.isHeld().then((value) => {
    held = value;
  });
  await settle();
  runLock.advance(20 * 1000);
  await settle();
  assert.strictEqual(lock.lost, true);
  assert.ok(connection.destroyed);
  assert.strictEqual(held, undefined);

  runLock.advance(10 * 1000);
  await settle();
  assert.strictEqual(held, false);
  assert.strictEqual(runLock.timers.size, 0);
}

// release() gives up on freeing the lock after 5 seconds, even while a keep-alive MySQL never
// answers is ahead of it, and then destroys the socket, which frees the lock.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(1));
  const lock = await runLock.takeRunLock({ onLost: () => assert.fail('Not lost') });
  connection.answer = noAnswer;
  runLock.intervals[0].callback();
  let released = false;
  const release = lock.release().then(() => {
    released = true;
  });
  await settle();
  runLock.advance(5000 - 1);
  await settle();
  assert.strictEqual(released, false);

  runLock.advance(1);
  await release;
  assert.ok(connection.socketDestroyed);
  assert.ok(!connection.ended);
  await settle();
  assert.strictEqual(connection.waiting.size, 0);
  assert.strictEqual(runLock.timers.size, 0);
}

// isRunLockHeld() asks MySQL, on the Sequelize pool rather than a connection of its own, whether a
// connection holds the lock under the name it is taken by. NULL, MySQL's answer after an error,
// counts as held.
{
  const runLock = await loadRunLock();
  const answers = [];
  for (const free of [1, 0, null]) {
    runLock.pool.free = free;
    answers.push(await runLock.isRunLockHeld());
  }
  assert.deepStrictEqual(answers, [false, true, true]);
  assert.deepStrictEqual(
    runLock.pool.queries,
    Array(3).fill({
      sql: "SELECT IS_FREE_LOCK(CONCAT('cbl-importer:', DATABASE())) AS free",
      type: 'SELECT'
    })
  );
  assert.deepStrictEqual(runLock.mysql.options, []);
}

console.log(
  'Run lock checks passed: taking, keeping, losing and releasing it, also when MySQL stops answering, and asking whether a run holds it.'
);
