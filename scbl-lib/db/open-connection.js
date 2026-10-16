import mysql from 'mysql2/promise';

import sequelize from './sequelize.js';

// Open a MySQL connection of its own, outside the Sequelize pool, for work that must run all its
// statements on one connection, such as schema changes made with a session setting. Like the run
// lock's connection, it is made with the settings the pool read from DATABASE_URI, which hold the
// password, so they are never printed. Close it with end().
export default async function openConnection() {
  const { host, port, username, password, database, dialectOptions } = sequelize.config;
  const connection = await mysql.createConnection({
    host,
    port,
    user: username,
    password,
    database,
    ...dialectOptions
  });
  // A connection that fails while it waits between statements reports it as an error event, which
  // would stop the process with nothing listening for it. Its next statement fails instead.
  connection.on('error', () => {});
  return connection;
}
