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
    takeServiceLock: module.namespace.takeServiceLock,
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

// The queries that take the locks, as MySQL is sent them.
const SET_WAIT_TIMEOUT = 'SET SESSION wait_timeout = 300';
const GET_SERVICE_LOCK =
  "SELECT GET_LOCK(CONCAT('cbl-importer-service:', DATABASE()), 0) AS acquired, CONCAT('cbl-importer-service:', DATABASE()) AS name";
const GET_RUN_LOCK =
  "SELECT GET_LOCK(CONCAT('cbl-importer:', DATABASE()), 0) AS acquired, CONCAT('cbl-importer:', DATABASE()) AS name";

// What MySQL answers: GET_LOCK gives 1 when a lock is taken, 0 when another connection holds it,
// and NULL on error, here for the service lock and the run lock, the run lock's answers in turn,
// the last again and again. RELEASE_LOCK gives released. Other queries are answered by extra.
const lockAnswers =
  ({ service = 1, run = 1, released = 1, extra = () => [{ held: 1 }] } = {}) =>
  (sql, values) => {
    if (sql === SET_WAIT_TIMEOUT) return [];
    if (sql === GET_SERVICE_LOCK) return [{ acquired: service, name: 'cbl-importer-service:cbl' }];
    if (sql === GET_RUN_LOCK) {
      const acquired = Array.isArray(run) ? (run.length > 1 ? run.shift() : run[0]) : run;
      return [{ acquired, name: 'cbl-importer:cbl' }];
    }
    if (/RELEASE_LOCK\(/.test(sql)) return [{ released }];
    return extra(sql, values);
  };
// GET_LOCK gives acquired for both locks.
const getLock = (acquired, extra) => lockAnswers({ service: acquired, run: acquired, extra });

// A run's locks, the service lock and the run lock, are taken on a connection of their own, made
// with the settings the Sequelize pool read from DATABASE_URI, without waiting, once the connection
// is told to close after 5 minutes idle rather than MySQL's 8 hours, so a connection cut off from
// the importer, e.g. by a network partition, frees the locks in time.
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
  assert.deepStrictEqual(lockQuery(connection), [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK, GET_RUN_LOCK]);
  assert.ok(connection.queries.every(({ timeout }) => timeout > 0));

  // It is kept alive every minute by a timer that does not keep the process running.
  assert.strictEqual(runLock.intervals.length, 1);
  const [keepAlive] = runLock.intervals;
  assert.strictEqual(keepAlive.ms, 60 * 1000);
  assert.ok(keepAlive.unrefed);
  keepAlive.callback();
  await settle();
  assert.strictEqual(connection.queries[3].sql, 'DO 1');
  assert.ok(connection.queries[3].timeout > 0);

  // isHeld() asks MySQL whether this connection holds both locks.
  assert.strictEqual(await lock.isHeld(), true);
  assert.deepStrictEqual(connection.queries[4], {
    sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AND IS_USED_LOCK(?) = CONNECTION_ID() AS held',
    timeout: connection.queries[4].timeout,
    values: ['cbl-importer-service:cbl', 'cbl-importer:cbl']
  });
  assert.strictEqual(lock.lost, false);

  // release() frees the locks, closes the connection and stops the keep-alive. Closing the
  // connection is not reported as losing the lock.
  await lock.release();
  assert.deepStrictEqual(connection.queries[5], {
    sql: 'SELECT RELEASE_ALL_LOCKS()',
    timeout: connection.queries[5].timeout,
    values: undefined
  });
  assert.ok(connection.ended);
  assert.ok(keepAlive.cleared);
  connection.emit('end');
  assert.strictEqual(lock.lost, false);
  assert.strictEqual(await lock.isHeld(), false);
  await lock.release();
  assert.strictEqual(connection.queries.length, 6);
  assert.ok(!connection.socketDestroyed);
  assert.deepStrictEqual(runLock.output, []);
  assert.strictEqual(runLock.timers.size, 0);
}

// When another run or the importer service holds the service lock, or a run of an importer from
// before the service lock holds the run lock, there are no locks and the connection is closed,
// which frees the service lock if it was taken. It says which lock is held, for the run's line and
// record. The run lock is not asked for without the service lock.
for (const [answers, queries, busy] of [
  [{ service: 0 }, [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK], 'service'],
  [{ run: 0 }, [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK, GET_RUN_LOCK], 'run'],
  [{ service: 0, run: 0 }, [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK], 'service']
]) {
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(lockAnswers(answers));
  assert.deepStrictEqual({ ...(await runLock.takeRunLock()) }, { busy });
  assert.deepStrictEqual(lockQuery(connection), queries);
  assert.ok(connection.ended);
  assert.ok(!connection.socketDestroyed);
  assert.strictEqual(runLock.intervals.length, 0);

  // If MySQL does not let it close, its socket is destroyed at once.
  const stuck = runLock.connectAnswering(lockAnswers(answers));
  stuck.end = () => Promise.reject(new Error("Can't add new command when connection is closed"));
  assert.deepStrictEqual({ ...(await runLock.takeRunLock()) }, { busy });
  assert.ok(stuck.socketDestroyed);
}

// A NULL from GET_LOCK, a failed query or a failed connection is an error, which never includes
// the connection settings, and the connection is closed.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(getLock(null));
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock/);
  assert.ok(connection.ended);
  for (const answers of [{ run: null }, { service: null }]) {
    const nothing = runLock.connectAnswering(lockAnswers(answers));
    await assert.rejects(
      runLock.takeRunLock(),
      /^Error: Could not take the run lock: MySQL gave no result for GET_LOCK\.$/
    );
    assert.ok(nothing.ended);
  }

  // A connection that cannot be told its idle time takes no lock.
  const unset = runLock.connectAnswering(() => {
    throw new Error("Variable 'wait_timeout' can't be set");
  });
  await assert.rejects(runLock.takeRunLock(), /Could not take the run lock: .*wait_timeout/);
  assert.deepStrictEqual(lockQuery(unset), [SET_WAIT_TIMEOUT]);
  assert.ok(unset.socketDestroyed);

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
  assert.strictEqual(connection.queries.length, 3);
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

// The importer service takes only the service lock, on a connection of its own with the same short
// idle time, and keeps it. Each cycle takes the run lock with beginCycle(), without waiting for it,
// and frees it with endCycle(), so between cycles only the service lock is held, and the bot's
// commands that wait for a run to end work. isHeld() asks about the locks it should hold now.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(lockAnswers());
  const lock = await runLock.takeServiceLock({ onLost: () => assert.fail('Not lost') });
  assert.deepStrictEqual(lockQuery(connection), [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK]);
  const isUsed = 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held';
  const bothUsed =
    'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AND IS_USED_LOCK(?) = CONNECTION_ID() AS held';
  assert.strictEqual(await lock.isHeld(), true);
  assert.deepStrictEqual(connection.queries.at(-1), {
    sql: isUsed,
    timeout: connection.queries.at(-1).timeout,
    values: ['cbl-importer-service:cbl']
  });

  assert.strictEqual(await lock.beginCycle(), true);
  assert.strictEqual(connection.queries.at(-1).sql, GET_RUN_LOCK);
  assert.ok(connection.queries.at(-1).timeout > 0);
  // It is taken once, however often a cycle asks for it.
  assert.strictEqual(await lock.beginCycle(), true);
  assert.strictEqual(connection.queries.filter(({ sql }) => sql === GET_RUN_LOCK).length, 1);
  assert.strictEqual(await lock.isHeld(), true);
  assert.deepStrictEqual(
    [connection.queries.at(-1).sql, connection.queries.at(-1).values],
    [bothUsed, ['cbl-importer-service:cbl', 'cbl-importer:cbl']]
  );

  await lock.endCycle();
  assert.deepStrictEqual(
    [connection.queries.at(-1).sql, connection.queries.at(-1).values],
    ['SELECT RELEASE_LOCK(?) AS released', ['cbl-importer:cbl']]
  );
  // Freed once: a second endCycle() sends nothing.
  const sent = connection.queries.length;
  await lock.endCycle();
  assert.strictEqual(connection.queries.length, sent);
  assert.strictEqual(await lock.isHeld(), true);
  assert.deepStrictEqual(connection.queries.at(-1).values, ['cbl-importer-service:cbl']);

  // The next cycle takes it again, and release() frees both.
  assert.strictEqual(await lock.beginCycle(), true);
  await lock.release();
  assert.strictEqual(connection.queries.at(-1).sql, 'SELECT RELEASE_ALL_LOCKS()');
  assert.ok(connection.ended);
  assert.strictEqual(await lock.beginCycle(), false);
  assert.strictEqual(lock.lost, false);

  // Another run or service holds the service lock: no locks.
  const busy = runLock.connectAnswering(lockAnswers({ service: 0 }));
  assert.deepStrictEqual({ ...(await runLock.takeServiceLock()) }, { busy: 'service' });
  assert.deepStrictEqual(lockQuery(busy), [SET_WAIT_TIMEOUT, GET_SERVICE_LOCK]);
  assert.ok(busy.ended);
}

// A cycle that finds the run lock held, e.g. by a run of an importer from before the service lock,
// is told so, and nothing is lost, so it can wait and ask again. A GET_LOCK that gives NULL, a
// query that fails, or a run lock that MySQL says this connection no longer held when the cycle
// frees it, loses the locks, and the service is told, once.
{
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(lockAnswers({ run: [0, 0, 1] }));
  const lock = await runLock.takeServiceLock({ onLost: () => assert.fail('Not lost') });
  assert.deepStrictEqual(
    [await lock.beginCycle(), await lock.beginCycle(), await lock.beginCycle()],
    [false, false, true]
  );
  assert.strictEqual(connection.queries.filter(({ sql }) => sql === GET_RUN_LOCK).length, 3);
  await lock.endCycle();
  assert.strictEqual(lock.lost, false);
}
const failing = (message) => () => {
  throw new Error(message);
};
for (const [answers, act, reason] of [
  [
    { run: null },
    async (lock) => assert.strictEqual(await lock.beginCycle(), false),
    /^MySQL gave no result for GET_LOCK\.$/
  ],
  [
    {},
    async (lock, connection) => {
      connection.answer = failing('Connection lost');
      assert.strictEqual(await lock.beginCycle(), false);
    },
    /Connection lost/
  ],
  [
    { released: 0 },
    async (lock) => {
      await lock.beginCycle();
      await lock.endCycle();
    },
    /no longer held the run lock/
  ],
  [
    {},
    async (lock, connection) => {
      await lock.beginCycle();
      connection.answer = failing('Query inactivity timeout');
      await lock.endCycle();
    },
    /Query inactivity timeout/
  ]
]) {
  const runLock = await loadRunLock();
  const connection = runLock.connectAnswering(lockAnswers(answers));
  const losses = [];
  const lock = await runLock.takeServiceLock({ onLost: (why) => losses.push(why) });
  await act(lock, connection);
  assert.strictEqual(lock.lost, true);
  assert.strictEqual(losses.length, 1);
  assert.match(losses[0], reason);
  assert.ok(connection.socketDestroyed);
  assert.strictEqual(await lock.beginCycle(), false);
  assert.strictEqual(await lock.isHeld(), false);
}

// isRunLockHeld() asks MySQL, on the Sequelize pool rather than a connection of its own, whether a
// connection holds the run lock under the name it is taken by: a run, or a cycle of the importer
// service, but not the service between its cycles, which holds only the service lock. NULL, MySQL's
// answer after an error, counts as held.
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
  "Run lock checks passed: taking, keeping, losing and releasing a run's locks and the importer service's, with a short idle time, also when MySQL stops answering, which lock another run holds, the run lock taken and freed for each cycle, and asking whether a run holds it."
);
