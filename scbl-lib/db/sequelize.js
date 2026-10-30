import Sequelize from 'sequelize';

if (!process.env.DATABASE_URI)
  throw new Error('Environmental variable DATABASE_URI must be provided.');

// The options every pool of connections to the database is made with, so their connections work
// alike: e.g. Sequelize sets each one's time zone to UTC, the days that bans' ages are counted in.
const OPTIONS = { logging: false };

export default new Sequelize.Sequelize(process.env.DATABASE_URI, OPTIONS);

// A pool of connections of its own to the same database, with these settings for it (Sequelize's
// pool option, e.g. { max: 1, acquire: 2000 }), for work that must neither wait for the connections
// the rest of the process shares nor take them up. Close it with its close().
export function createPool(pool) {
  return new Sequelize.Sequelize(process.env.DATABASE_URI, { ...OPTIONS, pool });
}

const { Op, QueryTypes, Transaction, ForeignKeyConstraintError, ValidationError } = Sequelize;

// Shown instead of the database's own error, which names internal hosts and addresses.
const DATABASE_UNAVAILABLE_MESSAGE =
  'The database is unavailable at the moment. Please try again shortly.';

// MySQL error codes for queries that were cut off because the server shut down or the connection
// dropped.
const DROPPED_CONNECTION_CODES = ['ER_SERVER_SHUTDOWN', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET'];

// Whether an error means the database could not be reached, e.g. while it restarts, rather than
// that something was wrong with the query.
function isDatabaseUnavailable(err) {
  return (
    err instanceof Sequelize.ConnectionError ||
    (err instanceof Sequelize.DatabaseError &&
      DROPPED_CONNECTION_CODES.includes(err.original?.code))
  );
}

export {
  Op,
  QueryTypes,
  Transaction,
  ForeignKeyConstraintError,
  ValidationError,
  DATABASE_UNAVAILABLE_MESSAGE,
  isDatabaseUnavailable
};
