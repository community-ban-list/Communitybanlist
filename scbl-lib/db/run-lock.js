import mysql from 'mysql2/promise';

import describeError from '../utils/describe-error.js';
import sequelize from './sequelize.js';

// The ban importer holds this MySQL lock while it runs, so only one run at a time works on the
// database. It is named after the database, as MySQL's lock names are shared by the whole server.
//
// The lock belongs to a connection of its own, outside the Sequelize pool: the pool closes idle
// connections after 10 seconds, which would free the lock, and a connection kept from the pool
// would stop disconnect() from finishing. MySQL frees the lock as soon as its connection closes,
// so a run that crashes or is killed never leaves it held.

// The lock's connection is used this often, so MySQL never closes it for being idle (wait_timeout).
const KEEP_ALIVE_INTERVAL = 60 * 1000;

// A query on the lock's connection that takes longer than this means the connection has stopped
// working, so the lock is treated as lost.
const QUERY_TIMEOUT = 30 * 1000;

// How long to wait for the lock to be freed, and then for its connection to close, before the
// connection is closed at once.
const RELEASE_TIMEOUT = 5 * 1000;

// Connect with the settings the Sequelize pool read from DATABASE_URI, so the lock is taken on the
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

// Close a connection, telling MySQL first, or at once if that takes too long.
async function close(connection) {
  try {
    await withTimeout(connection.end(), RELEASE_TIMEOUT);
  } catch {
    connection.destroy();
  }
}

class RunLock {
  constructor(connection, name, onLost) {
    this.connection = connection;
    this.name = name;
    this.onLost = onLost;
    this.lost = false;
    this.released = false;

    // The lock goes with its connection, e.g. when MySQL restarts.
    connection.on('error', (err) => this.markLost(describeError(err)));
    connection.on('end', () => this.markLost('The database closed the connection.'));

    this.keepAlive = setInterval(() => {
      this.query('DO 1').catch((err) => this.markLost(describeError(err)));
    }, KEEP_ALIVE_INTERVAL);
    // It must not keep the process running.
    this.keepAlive.unref();
  }

  query(sql, values, timeout = QUERY_TIMEOUT) {
    return this.connection.query({ sql, timeout }, values);
  }

  markLost(reason) {
    if (this.lost || this.released) return;
    this.lost = true;
    clearInterval(this.keepAlive);
    // Close the connection, in case it still holds the lock but has stopped answering.
    this.connection.destroy();
    if (this.onLost) this.onLost(reason);
  }

  // Whether this run still holds the lock. Steps that delete or export bans check it first.
  async isHeld() {
    if (this.lost || this.released) return false;
    try {
      const [[{ held }]] = await this.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [
        this.name
      ]);
      if (Number(held) === 1) return true;
      this.markLost('MySQL says this connection no longer holds it.');
    } catch (err) {
      this.markLost(describeError(err));
    }
    return false;
  }

  // Free the lock and close its connection. This never fails: if the lock cannot be freed, closing
  // the connection frees it.
  async release() {
    if (this.released) return;
    const { lost } = this;
    this.released = true;
    clearInterval(this.keepAlive);
    // A lost lock's connection is already closed.
    if (lost) return;

    try {
      await this.query('SELECT RELEASE_LOCK(?)', [this.name], RELEASE_TIMEOUT);
    } catch {
      this.connection.destroy();
      return;
    }
    await close(this.connection);
  }

  // Close the connection at once, which frees the lock, for a run that has to exit straight away.
  destroy() {
    if (this.released) return;
    this.released = true;
    clearInterval(this.keepAlive);
    this.connection.destroy();
  }
}

// Take the importer's run lock, without waiting for it. Resolves with the lock, or with null if
// another run holds it. onLost(reason) is called if the lock is lost later, e.g. because its
// connection dropped. Errors never include the connection settings.
export default async function takeRunLock({ onLost } = {}) {
  let connection;
  try {
    connection = await mysql.createConnection(connectionOptions());
  } catch (err) {
    throw new Error(
      `Could not connect to the database to take the run lock: ${describeError(err)}`
    );
  }

  let acquired, name;
  try {
    // GET_LOCK gives 1 when it took the lock, 0 when another connection holds it, and NULL after
    // an error.
    [[{ acquired, name }]] = await connection.query({
      sql: "SELECT GET_LOCK(CONCAT('cbl-importer:', DATABASE()), 0) AS acquired, CONCAT('cbl-importer:', DATABASE()) AS name",
      timeout: QUERY_TIMEOUT
    });
  } catch (err) {
    connection.destroy();
    throw new Error(`Could not take the run lock: ${describeError(err)}`);
  }

  if (Number(acquired) === 1) return new RunLock(connection, name, onLost);

  await close(connection);
  if (acquired !== null && Number(acquired) === 0) return null;
  throw new Error('Could not take the run lock: MySQL gave no result for GET_LOCK.');
}
