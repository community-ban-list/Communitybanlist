import mysql from 'mysql2/promise';

import describeError from '../utils/describe-error.js';
import sequelize, { QueryTypes } from './sequelize.js';

// The ban importer holds two MySQL locks, so only one importer works on the database at a time,
// and the bot can tell when it is working. They are named after the database, as MySQL's lock
// names are shared by the whole server:
// - the service lock, held by an importer process for as long as it runs: a run in once mode for
//   its whole run, and the importer service, in loop mode, from when it starts until it stops. A
//   run started while another process holds it is skipped.
// - the run lock, held while the importer works on the database: a run in once mode for its whole
//   run, as before there was a service lock, and the importer service only during each cycle, not
//   between cycles. The bot asks whether it is held before a change that must not happen while the
//   importer works (see isRunLockHeld), and importers from before the service lock held only it.
//
// The locks belong to a connection of their own, outside the Sequelize pool: the pool closes idle
// connections after 10 seconds, which would free them, and a connection kept from the pool would
// stop disconnect() from finishing. MySQL frees them as soon as their connection closes, so a run
// that crashes or is killed never leaves them held.

// The locks' names, in SQL, as they are worked out from the database the connection uses.
const SERVICE_LOCK_NAME = "CONCAT('cbl-importer-service:', DATABASE())";
const LOCK_NAME = "CONCAT('cbl-importer:', DATABASE())";

// The locks' connection is used this often, so MySQL never closes it for being idle.
const KEEP_ALIVE_INTERVAL = 60 * 1000;

// MySQL closes the locks' connection once it has been idle this long, in seconds, rather than after
// its default 8 hours. The keep-alive uses it every minute, so a process that holds the locks never
// leaves it idle this long, but one cut off from the database without closing the connection, e.g.
// by a network partition, leaves MySQL a connection that holds the locks and that it would
// otherwise keep for hours, so no importer could take them. This way they are freed within 5
// minutes.
const LOCK_WAIT_TIMEOUT = 5 * 60;

// A query on the locks' connection that takes longer than this means the connection has stopped
// working, so the locks are treated as lost.
const QUERY_TIMEOUT = 30 * 1000;

// How long to wait for the locks to be freed, and then for their connection to close, before the
// connection is closed at once.
const RELEASE_TIMEOUT = 5 * 1000;

// MySQL's error number for a KILL of a connection that is not there, e.g. as it has closed since.
const NO_SUCH_THREAD = 1094;

// Connect with the settings the Sequelize pool read from DATABASE_URI, so the locks are taken on the
// database the run works on. They hold the password, so they are never printed.
function connectionOptions() {
  const { host, port, username, password, database, dialectOptions } = sequelize.config;
  return { host, port, user: username, password, database, ...dialectOptions };
}

// Wait for a promise, but give up after ms milliseconds.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Close a connection at once, without telling MySQL, which frees the locks it holds. mysql2's own
// destroy() only half-closes the socket and then ignores it closing, so queries still waiting on
// the connection would never settle. Destroying the socket makes mysql2 fail them, and report the
// connection as lost, which must not crash the importer when nothing else is listening.
function drop(connection) {
  connection.on('error', () => {});
  const socket = connection.connection?.stream;
  if (typeof socket?.destroy === 'function') socket.destroy();
  else connection.destroy();
}

// Close a connection, telling MySQL first, or at once if that takes too long.
async function close(connection) {
  try {
    await withTimeout(connection.end(), RELEASE_TIMEOUT);
  } catch {
    drop(connection);
  }
}

// Take a lock on a connection, without waiting for it. Resolves with the lock's name, as MySQL
// worked it out, and whether it was taken, or is busy, as another connection holds it. GET_LOCK
// gives 1 when it took the lock, 0 when another connection holds it, and NULL after an error, when
// it is neither.
async function getLock(query, lockName) {
  const [[{ acquired, name }]] = await query(
    `SELECT GET_LOCK(${lockName}, 0) AS acquired, ${lockName} AS name`
  );
  return {
    name,
    taken: Number(acquired) === 1,
    busy: acquired !== null && Number(acquired) === 0
  };
}

const NO_RESULT = 'MySQL gave no result for GET_LOCK.';

// The locks an importer process holds, on their connection: the service lock from the start, and
// the run lock whenever it works on the database, from the start for a run in once mode, and
// during each cycle for the importer service (see beginCycle and endCycle).
class RunLock {
  constructor(connection, { serviceName, runName = null }, onLost) {
    this.connection = connection;
    this.serviceName = serviceName;
    // The run lock's name while the connection holds it, and null while it does not.
    this.runName = runName;
    this.onLost = onLost;
    this.lost = false;
    this.released = false;

    // The locks go with their connection, e.g. when MySQL restarts.
    connection.on('error', (err) => this.markLost(describeError(err)));
    connection.on('end', () => this.markLost('The database closed the connection.'));

    this.keepAlive = setInterval(() => {
      this.query('DO 1').catch((err) => this.markLost(describeError(err)));
    }, KEEP_ALIVE_INTERVAL);
    // It must not keep the process running.
    this.keepAlive.unref();
  }

  // Run a query on the locks' connection, giving up after timeout milliseconds. mysql2's own
  // timeout only starts once a query reaches the front of the connection's queue, so a query
  // waiting behind one that never gets an answer would otherwise wait forever.
  query(sql, values, timeout = QUERY_TIMEOUT) {
    return withTimeout(this.connection.query({ sql, timeout }, values), timeout);
  }

  markLost(reason) {
    if (this.lost || this.released) return;
    this.lost = true;
    clearInterval(this.keepAlive);
    // Close the connection, in case it still holds the locks but has stopped answering.
    drop(this.connection);
    if (this.onLost) this.onLost(reason);
  }

  // Whether this process still holds its locks: the service lock, and the run lock while it should
  // hold it. Steps that delete or export bans check it first.
  async isHeld() {
    if (this.lost || this.released) return false;
    const names = this.runName ? [this.serviceName, this.runName] : [this.serviceName];
    try {
      const [[{ held }]] = await this.query(
        `SELECT ${names.map(() => 'IS_USED_LOCK(?) = CONNECTION_ID()').join(' AND ')} AS held`,
        names
      );
      if (Number(held) === 1) return true;
      this.markLost('MySQL says this connection no longer holds it.');
    } catch (err) {
      this.markLost(describeError(err));
    }
    return false;
  }

  // Take the run lock for a cycle of the importer service, which holds the service lock, without
  // waiting for it. Resolves with true once it holds it, and with false while another connection
  // holds it, e.g. a run of an importer from before the service lock, or once the locks are lost,
  // as they are when this fails. It is taken once, however often this is called, as MySQL lets a
  // connection take a lock it holds again, and would then free it only once it is released as
  // often.
  async beginCycle() {
    if (this.lost || this.released) return false;
    if (this.runName) return true;
    try {
      const { name, taken, busy } = await getLock((sql) => this.query(sql), LOCK_NAME);
      if (taken) this.runName = name;
      else if (!busy) this.markLost(NO_RESULT);
      return taken;
    } catch (err) {
      this.markLost(describeError(err));
      return false;
    }
  }

  // Free the run lock at the end of a cycle, keeping the service lock. If it cannot be freed, or
  // MySQL says this connection did not hold it, the locks are treated as lost, and their connection
  // is closed, which frees them. RELEASE_LOCK gives 1 when it freed the lock.
  async endCycle() {
    if (!this.runName || this.lost || this.released) return;
    try {
      const [[{ released }]] = await this.query('SELECT RELEASE_LOCK(?) AS released', [
        this.runName
      ]);
      this.runName = null;
      if (Number(released) !== 1)
        this.markLost('MySQL says this connection no longer held the run lock.');
    } catch (err) {
      this.markLost(describeError(err));
    }
  }

  // Stop the statements this process may still have running on its other connections, such as the
  // Sequelize pool's, before it frees the locks: MySQL carries on with a statement whose client has
  // gone, e.g. one that waits for a row lock, which would then change the database while another
  // importer holds the locks. KILL closes a connection on MySQL's side, ending its statement and
  // rolling back what it had not committed, and MySQL lets a connection kill those of its own user,
  // as all of the importer's are. ids are the connections' IDs, as mysql2 gives them (threadId).
  // Resolves within ms milliseconds with the IDs it could not kill, and never fails. A connection
  // that has closed since is gone already.
  async killConnections(ids, ms = RELEASE_TIMEOUT) {
    const missed = new Set(ids);
    let timedOut = false;
    const kill = async () => {
      for (const id of ids) {
        if (timedOut || this.lost || this.released) return;
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        try {
          await this.query(`KILL ${id}`);
          missed.delete(id);
        } catch (err) {
          if (err?.errno === NO_SUCH_THREAD) missed.delete(id);
        }
      }
    };
    try {
      await withTimeout(kill(), ms);
    } catch {
      // The time is up, so the connections not killed yet are left as they are.
      timedOut = true;
    }
    return [...missed];
  }

  // Free the locks and close their connection. This never fails: if the locks cannot be freed,
  // closing the connection frees them.
  async release() {
    if (this.released) return;
    const { lost } = this;
    this.released = true;
    clearInterval(this.keepAlive);
    // A lost lock's connection is already closed.
    if (lost) return;

    try {
      await this.query('SELECT RELEASE_ALL_LOCKS()', undefined, RELEASE_TIMEOUT);
    } catch {
      drop(this.connection);
      return;
    }
    await close(this.connection);
  }

  // Close the connection at once, which frees the locks, for a run that has to exit straight away.
  destroy() {
    if (this.released) return;
    this.released = true;
    clearInterval(this.keepAlive);
    drop(this.connection);
  }
}

// Take the service lock, and, with run, the run lock too, on a connection of their own, without
// waiting for them. Resolves with the locks, or, if another connection holds either, with
// { busy } naming the one it holds: 'service', or 'run' when only the run lock is held, as by a
// run of an importer from before the service lock.
async function takeLocks({ onLost, run }) {
  const what = run ? 'the run lock' : 'the service lock';
  let connection;
  try {
    connection = await mysql.createConnection(connectionOptions());
  } catch (err) {
    throw new Error(`Could not connect to the database to take ${what}: ${describeError(err)}`);
  }

  // The locks as they were taken, the run lock only once the service lock was.
  let locks;
  try {
    const query = (sql) => connection.query({ sql, timeout: QUERY_TIMEOUT });
    // Before any lock is taken, so none is ever held on a connection MySQL would keep for hours.
    await query(`SET SESSION wait_timeout = ${LOCK_WAIT_TIMEOUT}`);
    locks = [await getLock(query, SERVICE_LOCK_NAME)];
    if (locks[0].taken && run) locks.push(await getLock(query, LOCK_NAME));
  } catch (err) {
    drop(connection);
    throw new Error(`Could not take ${what}: ${describeError(err)}`);
  }

  const [service, runLock] = locks;
  if (locks.every(({ taken }) => taken))
    return new RunLock(connection, { serviceName: service.name, runName: runLock?.name }, onLost);
  // Closing the connection frees a lock it took.
  await close(connection);
  if (service.busy) return { busy: 'service' };
  if (runLock?.busy) return { busy: 'run' };
  throw new Error(`Could not take ${what}: ${NO_RESULT}`);
}

// Take the importer's locks for a run in once mode, the service lock and the run lock, without
// waiting for them. Resolves with the locks, or with { busy } if another run, or the importer
// service, holds either: { busy: 'service' } while the importer service, or another run, holds the
// service lock, and { busy: 'run' } while only the run lock is held, by a run of an importer from
// before the service lock. onLost(reason) is called if they are lost later, e.g. because their
// connection dropped. Errors never include the connection settings.
export default async function takeRunLock({ onLost } = {}) {
  return takeLocks({ onLost, run: true });
}

// Take the service lock for the importer service, without waiting for it. Resolves with the locks,
// whose beginCycle and endCycle take and free the run lock for each cycle, or with
// { busy: 'service' } if another run, or another service, holds it. onLost is called as for
// takeRunLock.
export async function takeServiceLock({ onLost } = {}) {
  return takeLocks({ onLost, run: false });
}

// Whether a ban importer run, or a cycle of the importer service, holds the run lock now, asked on
// the Sequelize pool, e.g. by the bot before a change that must not happen while the importer
// works. Between the service's cycles it is free. IS_FREE_LOCK gives 1 when the lock is free, 0
// when a connection holds it and NULL after an error, which counts as held.
export async function isRunLockHeld() {
  const [{ free }] = await sequelize.query(`SELECT IS_FREE_LOCK(${LOCK_NAME}) AS free`, {
    type: QueryTypes.SELECT
  });
  return Number(free) !== 1;
}
