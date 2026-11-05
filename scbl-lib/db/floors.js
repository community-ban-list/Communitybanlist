import { KNOWN_FEATURES } from '../floors.js';
import sequelize, { QueryTypes } from './sequelize.js';

// Two rows of the importer's ImporterState table, which keep an importer image that is too old for
// the data from getting it wrong (see the importer's README):
// - floors: the features an importer must have, as
//   {"importer": [...names], "raised": [{"feature", "by", "at"}]}. The importer creates the row,
//   with no names, the bot, the web server and the importer raise it with the first data of each
//   kind, and only a person lowers it, by hand. An importer that lacks a feature in it skips the
//   steps that need the feature (see ban-importer/src/run.js).
// - features:importer: the heartbeat, which only the importer writes, as a run's steps begin: what
//   the image of the latest run can do, as {"features": [...], "games": [...], "gitSha": "..."},
//   and in updatedAt when it wrote that, by the database's clock. It is fresh within 30 minutes.

export const FLOORS_ROW = 'floors';
export const HEARTBEAT_ROW = 'features:importer';

// MySQL's error numbers for a table that does not exist, a duplicate key and a deadlock.
const NO_SUCH_TABLE = 1146;
const DUPLICATE_KEY = 1062;
const DEADLOCK = 1213;

// A raise is tried this many times when another one gets in its way.
const ATTEMPTS = 3;

// The most of who raised a floor that the row keeps.
const MAX_BY_LENGTH = 100;

const errnoOf = (err) => (err?.original ?? err?.parent ?? err)?.errno;

// Written in one statement, which takes no lock on anything else, with updatedAt by the database's
// clock, as whatever reads the row is to compare it with that clock.
const SAVE_HEARTBEAT = `INSERT INTO ImporterState (name, value, updatedAt)
  VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3)) AS new
  ON DUPLICATE KEY UPDATE value = new.value, updatedAt = new.updatedAt`;

// Keeps a row that is there already, which may name floors.
const CREATE_FLOORS = `INSERT IGNORE INTO ImporterState (name, value, updatedAt)
  VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3))`;

const READ_FLOORS = 'SELECT value FROM ImporterState WHERE name = :name';
const LOCK_FLOORS = `${READ_FLOORS} FOR UPDATE`;

const INSERT_FLOORS = `INSERT INTO ImporterState (name, value, updatedAt)
  VALUES (:name, CAST(:value AS JSON), UTC_TIMESTAMP(3))`;

const UPDATE_FLOORS = `UPDATE ImporterState
  SET value = CAST(:value AS JSON), updatedAt = UTC_TIMESTAMP(3)
  WHERE name = :name`;

// The floors a row's value holds, or { unreadable: true } when it is not an object, or its importer
// is not a list of names, e.g. after an edit by hand. The database gives JSON as text or parsed,
// depending on the server and the driver.
function parseFloors(value) {
  let floors = value;
  if (typeof floors === 'string') {
    try {
      floors = JSON.parse(floors);
    } catch {
      return { unreadable: true };
    }
  }
  const readable =
    Array.isArray(floors?.importer) && floors.importer.every((name) => typeof name === 'string');
  return readable ? floors : { unreadable: true };
}

// Say what the importer image of this run can do, whatever the row said before.
export async function writeImporterHeartbeat({ features, games, gitSha }) {
  await sequelize.query(SAVE_HEARTBEAT, {
    replacements: {
      name: HEARTBEAT_ROW,
      value: JSON.stringify({ features, games, gitSha })
    }
  });
}

// Create the floors row, with no names, unless it is there already.
export async function createFloorsRow() {
  await sequelize.query(CREATE_FLOORS, {
    replacements: {
      name: FLOORS_ROW,
      value: JSON.stringify({ importer: [], raised: [] })
    }
  });
}

// The floors, as { importer, raised, ... }, or { unreadable: true } for a row that cannot be read,
// which is not to be taken for no floors. A table the importer has not made yet, and a row it has
// not created yet, give no floors, as no floor can have been raised before they are there. Other
// errors are passed on, as nobody should act without knowing.
export async function readFloors() {
  try {
    const [row] = await sequelize.query(READ_FLOORS, {
      type: QueryTypes.SELECT,
      replacements: { name: FLOORS_ROW }
    });
    return row ? parseFloors(row.value) : { importer: [] };
  } catch (err) {
    if (errnoOf(err) === NO_SUCH_TABLE) return { importer: [] };
    throw err;
  }
}

// Add the names that the row lacks, in the transaction given, reading the row with a row lock, so
// two raises at once both keep their names. A row with no such names is left as it is, and one
// that cannot be read is never overwritten, as that could lose a floor.
async function addToFloors(names, by, transaction) {
  const [row] = await sequelize.query(LOCK_FLOORS, {
    type: QueryTypes.SELECT,
    replacements: { name: FLOORS_ROW },
    transaction
  });
  const floors = row ? parseFloors(row.value) : { importer: [], raised: [] };
  if (floors.unreadable)
    throw new Error(
      `Could not raise the importer's floor to ${names.join(', ')}, as the floors row in ImporterState cannot be read. Fix the row by hand (see the importer's README).`
    );

  const added = names.filter((name) => !floors.importer.includes(name));
  if (added.length === 0) return { importer: floors.importer, added };

  const at = new Date().toISOString();
  const value = {
    ...floors,
    importer: [...floors.importer, ...added],
    raised: [
      ...(Array.isArray(floors.raised) ? floors.raised : []),
      ...added.map((feature) => ({ feature, by: String(by).slice(0, MAX_BY_LENGTH), at }))
    ]
  };
  await sequelize.query(row ? UPDATE_FLOORS : INSERT_FLOORS, {
    replacements: { name: FLOORS_ROW, value: JSON.stringify(value) },
    transaction
  });
  return { importer: value.importer, added };
}

// Run work(transaction) in a transaction, and all of it again when another raise gets in its way:
// of two first raises at once, each finds no row and locks the gap where it would be, so MySQL ends
// one in a deadlock, and a raise whose row another made since it looked finds a duplicate key. The
// next attempt finds the row. A raise in a transaction of its caller's, as when it is made with the
// data that needs it, cannot run the caller's work again itself, so the caller runs its transaction
// with this. Resolves as work does, and fails as the last attempt did.
export async function withFloorRetries(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sequelize.transaction(work);
    } catch (err) {
      const errno = errnoOf(err);
      if (attempt < ATTEMPTS && (errno === DUPLICATE_KEY || errno === DEADLOCK)) continue;
      throw err;
    }
  }
}

// Raise the importer's floor to the features given, a name or a list of names, as by says, e.g.
// 'bot', with the first data that needs them. It never lowers a floor or changes the row's other
// keys. Resolves with { importer, added }: the names the row now holds, and those it did not hold
// before. A name not in KNOWN_FEATURES is refused, as it would stop every step of every importer. A
// transaction given is the caller's, who runs it with withFloorRetries; without one, the raise has
// a transaction of its own, and tries it again itself. A missing table is passed on as the database
// gives it.
export async function raiseImporterFloor(features, { by, transaction = null } = {}) {
  const names = [...new Set([features].flat())];
  for (const name of names)
    if (!KNOWN_FEATURES.includes(name))
      throw new Error(
        `Could not raise the importer's floor to "${name}", as no such feature is known.`
      );
  if (transaction) return addToFloors(names, by, transaction);
  return withFloorRetries((own) => addToFloors(names, by, own));
}
