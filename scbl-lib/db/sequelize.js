import Sequelize from 'sequelize';

if (!process.env.DATABASE_URI)
  throw new Error('Environmental variable DATABASE_URI must be provided.');

export default new Sequelize.Sequelize(process.env.DATABASE_URI, { logging: false });

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
