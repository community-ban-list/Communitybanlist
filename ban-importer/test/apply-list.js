import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check how a ban list's fetched bans are compared with its stored ones and written, without a
// database: the values compared and how each is read, which player a ban is for, which missing bans
// are removed, kept or held, and the statements each write runs, in their transactions and
// batches, with their retries. The database is a stand-in that records each statement and answers
// as MySQL would, and waits between attempts are skipped but recorded. import-bans.js checks the
// importer using all of this.

// Stand-ins for Sequelize's errors.
class DatabaseError extends Error {
  constructor(message, original = {}) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = original;
  }
}
class ForeignKeyConstraintError extends DatabaseError {
  constructor(field) {
    super('Cannot add or update a child row: a foreign key constraint fails', { errno: 1452 });
    this.name = 'SequelizeForeignKeyConstraintError';
    this.fields = [field];
  }
}
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SequelizeValidationError';
  }
}
class ConnectionError extends Error {
  constructor() {
    super('connect ECONNREFUSED 10.0.0.2:3306');
    this.name = 'SequelizeConnectionRefusedError';
  }
}
const deadlock = () =>
  new DatabaseError('Deadlock found when trying to get lock; try restarting transaction', {
    errno: 1213
  });
const lockWaitTimeout = () =>
  new DatabaseError('Lock wait timeout exceeded; try restarting transaction', { errno: 1205 });

// What the database did: each statement, as [sql, replacements, transaction], and each
// transaction's start and end. A statement whose text matches one of failures fails with its
// error, once for each error given, in order.
const events = [];
const failures = [];
let transactions = 0;
const delays = [];
const logs = [];
// What the stand-in answers a SELECT with, by its text, and the rows a DELETE of bans removes.
let selects = {};
let deleted = 0;

// Each statement's values are recorded as copies made in this test's context, with Dates as their
// ISO text, to compare them.
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const QueryTypes = { SELECT: 'SELECT' };
const sequelize = {
  async query(sql, { replacements, transaction, type } = {}) {
    events.push(['query', sql, copy(replacements), transaction?.id ?? null]);
    const failure = failures.find(({ match }) => match.test(sql) && match.errors.length > 0);
    if (failure) throw failure.match.errors.shift();
    if (type === QueryTypes.SELECT) return selects[sql] ?? [];
    // Sequelize resolves with [insertId, affectedRows] for an INSERT, and [result, result] for any
    // other statement.
    if (/^INSERT INTO/.test(sql)) return [0, replacements.length];
    const result = { affectedRows: /^DELETE FROM Bans/.test(sql) ? deleted : 0 };
    return [result, result];
  },
  async transaction(work) {
    const transaction = { id: ++transactions };
    events.push(['begin', transaction.id]);
    try {
      const value = await work(transaction);
      events.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      events.push(['rollback', transaction.id]);
      throw err;
    }
  }
};
// Make statements whose text matches pattern fail with these errors, one each time.
function fail(pattern, ...errors) {
  pattern.errors = errors;
  failures.push({ match: pattern });
}

const context = vm.createContext({
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const dependencies = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: (err) => err instanceof ConnectionError
  },
  'scbl-lib/utils': {
    describeError,
    Logger: { verbose: (module, level, message) => logs.push({ level, message }) }
  }
};
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const runControl = await load('../src/run-control.js');
const module = await load('../src/apply-list.js');
await module.link(async (specifier) => {
  if (specifier === './run-control.js') return runControl;
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
const {
  BATCH_SIZE,
  chooseSteamUser,
  clearPendingRemovals,
  COMPARED_FIELDS,
  CONFIRM_AFTER,
  diffBans,
  flagOf,
  FULL_REMOVAL_BANS,
  isMissingBanList,
  isRetryable,
  planRemovals,
  readPendingRemovals,
  readStoredBans,
  removeBans,
  REMOVE_AT_ONCE_BANS,
  REMOVE_AT_ONCE_SHARE,
  retryOperation,
  savePendingRemovals,
  sqlTime,
  textOf,
  timeOf,
  writeBans
} = module.namespace;
const control = runControl.namespace;

// Copy a value made in the module's context into one of this test's own, to compare it.
const plain = (value) => JSON.parse(JSON.stringify(value));

function reset() {
  events.length = 0;
  failures.length = 0;
  delays.length = 0;
  logs.length = 0;
  transactions = 0;
  selects = {};
  deleted = 0;
}

assert.strictEqual(BATCH_SIZE, 500);
assert.strictEqual(CONFIRM_AFTER, 10 * 60 * 1000);
assert.deepStrictEqual(
  [REMOVE_AT_ONCE_BANS, REMOVE_AT_ONCE_SHARE, FULL_REMOVAL_BANS],
  [10, 0.05, 10]
);
assert.deepStrictEqual(plain(COMPARED_FIELDS), [
  'steamUser',
  'expires',
  'expired',
  'reason',
  'rawReason',
  'rawNote'
]);

// Times compare by their milliseconds: a Date, as MySQL's DATETIME columns come back, text in their
// format, read as UTC, an ISO time or a number. None is null, and an invalid time NaN.
const MS = Date.UTC(2027, 1, 3, 4, 5, 6, 789);
for (const value of [
  new Date(MS),
  '2027-02-03 04:05:06.789',
  '2027-02-03 04:05:06.789000',
  ' 2027-02-03T04:05:06.789 ',
  '2027-02-03T04:05:06.789Z',
  MS
])
  assert.strictEqual(timeOf(value), MS, JSON.stringify(value));
assert.strictEqual(timeOf('2027-02-03 04:05:06'), MS - 789);
assert.strictEqual(timeOf(null), null);
assert.strictEqual(timeOf(undefined), null);
assert.ok(Number.isNaN(timeOf(new Date('not a time'))));
assert.ok(Number.isNaN(timeOf('soon')));
// Whether a ban has expired compares MySQL's 1 and 0 with true and false.
for (const [value, flag] of [
  [1, true],
  [0, false],
  [true, true],
  [false, false],
  ['1', true],
  ['0', false],
  [null, null],
  [undefined, null]
])
  assert.strictEqual(flagOf(value), flag, String(value));
// A missing text is the same as NULL, and any other value is its text.
assert.deepStrictEqual(
  [textOf(undefined), textOf(null), textOf(''), textOf('Cheating'), textOf(12)],
  [null, null, '', 'Cheating', '12']
);

// A time is written to the millisecond, in UTC, as the models write DATETIME(6) columns. None is
// NULL, and an invalid time cannot be written.
assert.strictEqual(sqlTime(new Date(MS)), '2027-02-03 04:05:06.789');
assert.strictEqual(sqlTime(Date.UTC(2026, 0, 1)), '2026-01-01 00:00:00.000');
assert.strictEqual(sqlTime(null), null);
assert.strictEqual(sqlTime(undefined), null);
assert.throws(() => sqlTime(new Date('not a time')), { name: 'RangeError' });

// The bans of a list as MySQL gives them back, and as the fetcher gives them.
const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;
const storedBan = (uid, overrides = {}) => ({
  id: `1,${uid}`,
  steamUser: steamID(1),
  expires: new Date(MS),
  expired: 0,
  reason: 'Cheating',
  rawReason: 'Cheating 😀 trailing  ',
  rawNote: null,
  ...overrides
});
const fetchedBan = (uid, overrides = {}) => ({
  id: `1,${uid}`,
  steamUser: steamID(1),
  steamIDs: [{ steamID: steamID(1), manual: true }],
  created: new Date('2026-01-01T00:00:00.123Z'),
  expires: new Date(MS),
  expired: false,
  reason: 'Cheating',
  rawReason: 'Cheating 😀 trailing  ',
  rawNote: undefined,
  banList: { id: 1 },
  ...overrides
});

// A ban as it is stored is unchanged, however MySQL gives its values back: a Date for a Date, 1
// or 0 for true or false, and NULL for a note the source does not give. So is one with no expiry.
let diff = diffBans(
  [fetchedBan('a'), fetchedBan('b', { expires: null }), fetchedBan('c', { expired: true })],
  [storedBan('a'), storedBan('b', { expires: null }), storedBan('c', { expired: 1 })]
);
assert.deepStrictEqual(plain(diff), { added: [], changed: [], moves: [], unchanged: 3 });

// Each value that differs makes the ban changed, by itself: an expiry a millisecond later, one
// added or removed, the ban expiring, its reasons and its note. Only the fields that differ are
// named, and the ban keeps its player.
for (const [overrides, fields] of [
  [{ expires: new Date(MS + 1) }, ['expires']],
  [{ expires: null }, ['expires']],
  [{ expired: true }, ['expired']],
  [{ reason: 'Toxic' }, ['reason']],
  [{ rawReason: 'Cheating 😀 trailing ' }, ['rawReason']],
  [{ rawNote: 'Appeal denied' }, ['rawNote']],
  [{ rawNote: '' }, ['rawNote']],
  [{ expired: true, reason: 'Toxic', rawNote: 'x' }, ['expired', 'reason', 'rawNote']]
]) {
  diff = diffBans([fetchedBan('a', overrides)], [storedBan('a')]);
  const label = JSON.stringify(overrides);
  assert.deepStrictEqual(diff.added.length + diff.unchanged, 0, label);
  assert.deepStrictEqual(plain(diff.changed[0].fields), fields, label);
  assert.strictEqual(diff.changed[0].steamUser, steamID(1), label);
  assert.strictEqual(diff.changed[0].previousSteamUser, steamID(1), label);
}
// A stored expiry where the source has none differs too, as does a stored NULL flag.
diff = diffBans([fetchedBan('a')], [storedBan('a', { expires: null, expired: null })]);
assert.deepStrictEqual(plain(diff.changed[0].fields), ['expires', 'expired']);

// A ban the list has not stored is new, with the values to write: a missing note as NULL, and its
// time of creation. The stored bans the list no longer has are not the diff's business.
diff = diffBans([fetchedBan('n')], [storedBan('gone')]);
assert.deepStrictEqual(plain(diff.added), [
  {
    id: '1,n',
    steamUser: steamID(1),
    created: '2026-01-01T00:00:00.123Z',
    expires: new Date(MS).toISOString(),
    expired: false,
    reason: 'Cheating',
    rawReason: 'Cheating 😀 trailing  ',
    rawNote: null
  }
]);
assert.deepStrictEqual([diff.changed.length, diff.unchanged], [0, 0]);

// Which player a ban is for. A ban keeps its stored player while that is still one of its SteamIDs,
// whatever their order and whichever an admin added, so a ban never moves only because BattleMetrics
// lists its SteamIDs another way. Once the stored player is gone from it, it moves to the player the
// fetcher chose for it: the first SteamID an admin added, or else the first. A new ban is for that
// player too, and so is a remote ban, which has one SteamID.
const ids = (...entries) =>
  entries.map(([n, manual]) => ({ steamID: steamID(n), manual: Boolean(manual) }));
const banWith = (steamIDs, steamUser) => ({ id: '1,a', steamIDs, steamUser });
assert.strictEqual(
  chooseSteamUser(banWith(ids([2, true], [1]), steamID(2)), steamID(1)),
  steamID(1)
);
assert.strictEqual(
  chooseSteamUser(banWith(ids([1], [2, true]), steamID(2)), steamID(1)),
  steamID(1)
);
assert.strictEqual(
  chooseSteamUser(banWith(ids([3], [2, true]), steamID(2)), steamID(1)),
  steamID(2)
);
assert.strictEqual(chooseSteamUser(banWith(ids([3], [4]), steamID(3)), steamID(1)), steamID(3));
assert.strictEqual(chooseSteamUser(banWith(ids([3], [2, true]), steamID(2))), steamID(2));
assert.strictEqual(chooseSteamUser({ id: '1,x', steamUser: steamID(5) }, steamID(5)), steamID(5));
// A stored player that is malformed, from before SteamIDs were checked, is not one of the ban's.
assert.strictEqual(
  chooseSteamUser(banWith(ids([1, true]), steamID(1)), `${steamID(1)}/`),
  steamID(1)
);

// A ban whose stored player is no longer one of its SteamIDs is a move. Without applyMoves it is
// counted but keeps its stored player, so a ban with nothing else changed is not written, and one
// with something else changed is written with its stored player. With applyMoves it moves, which
// changes its player, and both its old and its new player are named.
const moved = fetchedBan('a', { steamUser: steamID(2), steamIDs: ids([2, true], [3]) });
const editedAndMoved = fetchedBan('b', {
  steamUser: steamID(2),
  steamIDs: ids([2, true]),
  reason: 'Toxic'
});
const kept = fetchedBan('c', { steamUser: steamID(2), steamIDs: ids([2, true], [1]) });
const stored3 = [storedBan('a'), storedBan('b'), storedBan('c')];
diff = diffBans([moved, editedAndMoved, kept], stored3);
assert.deepStrictEqual(plain(diff.moves), [
  { id: '1,a', from: steamID(1), to: steamID(2) },
  { id: '1,b', from: steamID(1), to: steamID(2) }
]);
assert.deepStrictEqual(
  Array.from(diff.changed, ({ id, steamUser, fields }) => [id, steamUser, [...fields]]),
  [['1,b', steamID(1), ['reason']]]
);
assert.strictEqual(diff.unchanged, 2);
diff = diffBans([moved, editedAndMoved, kept], stored3, { applyMoves: true });
assert.strictEqual(diff.moves.length, 2);
assert.deepStrictEqual(
  Array.from(diff.changed, ({ id, steamUser, previousSteamUser, fields }) => [
    id,
    steamUser,
    previousSteamUser,
    [...fields]
  ]),
  [
    ['1,a', steamID(2), steamID(1), ['steamUser']],
    ['1,b', steamID(2), steamID(1), ['steamUser', 'reason']]
  ]
);
assert.strictEqual(diff.unchanged, 1);

// Which of the bans missing from a complete read of a list are removed, kept for a later read, or
// held for an admin. Each case is [the rules' inputs, what they decide].
const NOW = Date.UTC(2026, 9, 21, 12);
const ago = (minutes) => NOW - minutes * 60 * 1000;
const range = (from, to) => Array.from({ length: to - from }, (_, i) => `1,m${from + i}`);
const pendingSince = (ids, minutes) => new Map(ids.map((id) => [id, ago(minutes)]));
const plan = (rules) => plain(planRemovals({ now: NOW, ...rules }));
// Nothing missing, nothing to do.
assert.deepStrictEqual(plan({ missing: [], stored: 50, fetched: 50 }), {
  remove: [],
  wait: [],
  hold: null
});
// Fewer than 10 missing bans, and 5% of the list, are removed at once.
assert.deepStrictEqual(
  plan({ missing: range(0, 9), stored: 100, fetched: 91 }).remove,
  range(0, 9)
);
assert.deepStrictEqual(
  plan({ missing: range(0, 49), stored: 1000, fetched: 951 }).remove,
  range(0, 49)
);
// More wait for a later complete read.
assert.deepStrictEqual(plan({ missing: range(0, 10), stored: 100, fetched: 90 }), {
  remove: [],
  wait: range(0, 10),
  hold: null
});
assert.deepStrictEqual(
  plan({ missing: range(0, 50), stored: 1000, fetched: 950 }).wait,
  range(0, 50)
);
// Those missing for at least 10 minutes, by their first missing read and this one, are removed,
// and the others wait, as long as they are not too few to wait.
let pending = new Map([...pendingSince(range(0, 30), 10), ...pendingSince(range(30, 40), 9)]);
assert.deepStrictEqual(plan({ missing: range(0, 60), stored: 200, fetched: 140, pending }), {
  remove: range(0, 30),
  wait: range(30, 60),
  hold: null
});
// Once fewer would wait, they are all removed at once.
assert.deepStrictEqual(plan({ missing: range(0, 39), stored: 200, fetched: 161, pending }), {
  remove: range(0, 39),
  wait: [],
  hold: null
});
// A read that found no bans at all, or none of a list's 10 or more bans, holds them all for an
// admin, however long they have been missing. A smaller list that lost all its bans to other bans
// is not held, and loses them at once.
pending = pendingSince(range(0, 12), 60);
assert.deepStrictEqual(plan({ missing: range(0, 3), stored: 3, fetched: 0 }), {
  remove: [],
  wait: [],
  hold: 'empty'
});
assert.deepStrictEqual(
  plan({ missing: range(0, 12), stored: 12, fetched: 40, pending }).hold,
  'full'
);
assert.deepStrictEqual(plan({ missing: range(0, 9), stored: 9, fetched: 40 }).remove, range(0, 9));
// An admin's confirmation removes them all at once.
assert.deepStrictEqual(
  plan({ missing: range(0, 12), stored: 12, fetched: 0, confirmed: true }).remove,
  range(0, 12)
);
assert.deepStrictEqual(
  plan({ missing: range(0, 60), stored: 200, fetched: 140, confirmed: true }).remove,
  range(0, 60)
);
// The bans of a list whose source was replaced are never held, but still wait for a later read.
assert.deepStrictEqual(plan({ missing: range(0, 12), stored: 12, fetched: 40, replace: true }), {
  remove: [],
  wait: range(0, 12),
  hold: null
});
assert.deepStrictEqual(
  plan({ missing: range(0, 12), stored: 12, fetched: 0, replace: true, pending }).remove,
  range(0, 12)
);

// Reading a list's stored bans and its recorded missing bans takes one query each, by the list.
reset();
const STORED_BANS =
  'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ?';
const PENDING_BANS = 'SELECT banId, firstMissingAt FROM BanListPendingRemovals WHERE banList = ?';
selects = {
  [STORED_BANS]: [storedBan('a')],
  [PENDING_BANS]: [
    { banId: '1,x', firstMissingAt: new Date(ago(5)) },
    { banId: '1,y', firstMissingAt: '2026-10-21 11:00:00.000' }
  ]
};
assert.deepStrictEqual(plain(await readStoredBans(1)), plain([storedBan('a')]));
assert.deepStrictEqual(
  Array.from(await readPendingRemovals(1), ([banId, firstMissingAt]) => [banId, firstMissingAt]),
  [
    ['1,x', ago(5)],
    ['1,y', ago(60)]
  ]
);
assert.deepStrictEqual(
  events.map(([, sql, replacements]) => [sql, replacements]),
  [
    [STORED_BANS, [1]],
    [PENDING_BANS, [1]]
  ]
);

// Writing bans: each batch is one transaction of three statements. It adds the batch's players
// that are new, once each, writes the bans with one INSERT that updates a ban that exists without
// ever changing when it was created, and queues for an update each ban's player and, for a changed
// ban, the player it had before. Times are written to the millisecond.
const INSERT_PLAYERS = /^INSERT IGNORE INTO SteamUsers \(id, createdAt, updatedAt\) VALUES /;
const WRITE_BANS =
  /^INSERT INTO Bans \(id, created, expires, expired, reason, rawReason, rawNote, steamUser, banList, createdAt, updatedAt\) VALUES (.*) AS new ON DUPLICATE KEY UPDATE steamUser = new\.steamUser, expires = new\.expires, expired = new\.expired, reason = new\.reason, rawReason = new\.rawReason, rawNote = new\.rawNote, updatedAt = new\.updatedAt$/;
const QUEUE_PLAYERS =
  'UPDATE SteamUsers SET lastRefreshedInfo = NULL, lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)';
const statements = () => events.filter(([type]) => type === 'query');
reset();
const WRITTEN_AT = new Date('2026-10-21T12:00:00.500Z');
diff = diffBans(
  [
    fetchedBan('a', { reason: 'Toxic', steamUser: steamID(9), steamIDs: ids([9, true]) }),
    fetchedBan('n1', { steamUser: steamID(2), steamIDs: ids([2]) }),
    fetchedBan('n2', { steamUser: steamID(2), steamIDs: ids([2]), expires: null }),
    fetchedBan('n3', { steamUser: steamID(3), steamIDs: ids([3]), created: undefined })
  ],
  [storedBan('a')],
  { applyMoves: true }
);
const writes = [...diff.added, ...diff.changed];
const batches = [];
let result = await writeBans(7, writes, {
  batchSize: 3,
  now: WRITTEN_AT,
  onWritten: (batch) => batches.push(Array.from(batch, ({ id }) => id))
});
assert.deepStrictEqual(plain(result), { stopped: false });
assert.deepStrictEqual(batches, [['1,n1', '1,n2', '1,n3'], ['1,a']]);
assert.deepStrictEqual(
  events.map(([type, sql, , transaction]) =>
    type === 'query' ? [sql.split(' ').slice(0, 3).join(' '), transaction] : [type, sql]
  ),
  [
    ['begin', 1],
    ['INSERT IGNORE INTO', 1],
    ['INSERT INTO Bans', 1],
    ['UPDATE SteamUsers SET', 1],
    ['commit', 1],
    ['begin', 2],
    ['INSERT IGNORE INTO', 2],
    ['INSERT INTO Bans', 2],
    ['UPDATE SteamUsers SET', 2],
    ['commit', 2]
  ]
);
const [addPlayers, write, queue] = statements();
assert.match(addPlayers[1], INSERT_PLAYERS);
assert.ok(addPlayers[1].endsWith('VALUES (?, ?, ?), (?, ?, ?)'));
assert.deepStrictEqual(addPlayers[2], [
  steamID(2),
  WRITTEN_AT.toISOString(),
  WRITTEN_AT.toISOString(),
  steamID(3),
  ...Array(2).fill(WRITTEN_AT.toISOString())
]);
assert.match(write[1], WRITE_BANS);
assert.strictEqual(
  write[1].match(WRITE_BANS)[1],
  Array(3)
    .fill(`(${Array(11).fill('?').join(', ')})`)
    .join(', ')
);
const at = WRITTEN_AT.toISOString();
assert.deepStrictEqual(write[2], [
  ...['1,n1', '2026-01-01 00:00:00.123', '2027-02-03 04:05:06.789', false, 'Cheating'],
  ...['Cheating 😀 trailing  ', null, steamID(2), 7, at, at],
  ...['1,n2', '2026-01-01 00:00:00.123', null, false, 'Cheating'],
  ...['Cheating 😀 trailing  ', null, steamID(2), 7, at, at],
  // A new remote ban, which has no time of its own, was created when it was first saved.
  ...['1,n3', '2026-10-21 12:00:00.500', '2027-02-03 04:05:06.789', false, 'Cheating'],
  ...['Cheating 😀 trailing  ', null, steamID(3), 7, at, at]
]);
assert.strictEqual(queue[1], QUEUE_PLAYERS);
assert.deepStrictEqual(queue[2], [[steamID(2), steamID(3)]]);
// The moved ban queues both its new and its old player.
const [, , queueMoved] = statements().slice(3);
assert.deepStrictEqual(queueMoved[2], [[steamID(9), steamID(1)]]);

// A batch that ends in a deadlock or a lock wait timeout is rolled back and run again as a whole,
// after 5 seconds, so no statement of it is left applied on its own.
reset();
fail(WRITE_BANS, deadlock(), lockWaitTimeout());
batches.length = 0;
await writeBans(7, diff.added, {
  now: WRITTEN_AT,
  onWritten: (batch) => batches.push(batch.length)
});
assert.deepStrictEqual(
  events.filter(([type]) => type !== 'query'),
  [
    ['begin', 1],
    ['rollback', 1],
    ['begin', 2],
    ['rollback', 2],
    ['begin', 3],
    ['commit', 3]
  ]
);
assert.deepStrictEqual(
  statements().map(([, sql, , transaction]) => [sql.slice(0, 18), transaction]),
  [
    ['INSERT IGNORE INTO', 1],
    ['INSERT INTO Bans (', 1],
    ['INSERT IGNORE INTO', 2],
    ['INSERT INTO Bans (', 2],
    ['INSERT IGNORE INTO', 3],
    ['INSERT INTO Bans (', 3],
    ['UPDATE SteamUsers ', 3]
  ]
);
assert.deepStrictEqual(delays, [5000, 5000]);
assert.deepStrictEqual(batches, [3]);
assert.strictEqual(logs.filter(({ message }) => /^Attempt \d failed/.test(message)).length, 2);
assert.ok(logs.every(({ level }) => level === 2));

// A database that stays unavailable is tried 5 times in all, and then stops the writes.
reset();
fail(INSERT_PLAYERS, ...Array.from({ length: 5 }, () => new ConnectionError()));
await assert.rejects(writeBans(7, diff.added, { now: WRITTEN_AT }), ConnectionError);
assert.strictEqual(events.filter(([type]) => type === 'begin').length, 5);
assert.deepStrictEqual(delays, [5000, 5000, 5000, 5000]);

// A batch that fails in a way that would only fail again is written a ban at a time, so only the
// ban that cannot be saved is left out, and passed on with its error. Such errors are not retried.
reset();
const tooLong = new DatabaseError("Data too long for column 'rawReason' at row 2", {
  errno: 1406
});
fail(WRITE_BANS, tooLong, new ValidationError('Validation error'));
const failed = [];
batches.length = 0;
await writeBans(7, diff.added, {
  now: WRITTEN_AT,
  onWritten: (batch) => batches.push(Array.from(batch, ({ id }) => id)),
  onFailed: (ban, err) => failed.push([ban.id, describeError(err)])
});
assert.deepStrictEqual(batches, [['1,n2'], ['1,n3']]);
assert.deepStrictEqual(failed, [['1,n1', 'SequelizeValidationError: Validation error']]);
assert.deepStrictEqual(delays, []);
assert.deepStrictEqual(
  events.filter(([type]) => type === 'commit').map(([, transaction]) => transaction),
  [3, 4]
);
// A batch of one ban that fails so is not written again.
reset();
fail(WRITE_BANS, new ValidationError('Validation error'));
failed.length = 0;
await writeBans(7, diff.added.slice(0, 1), {
  now: WRITTEN_AT,
  onFailed: (ban) => failed.push(ban.id)
});
assert.deepStrictEqual([failed, transactions], [['1,n1'], 1]);

// A list that is not in the database fails the bans' foreign key, which stops the writes at once,
// without retries or writing the bans one at a time.
reset();
fail(WRITE_BANS, new ForeignKeyConstraintError('banList'));
await assert.rejects(writeBans(7, diff.added, { now: WRITTEN_AT }), (err) => isMissingBanList(err));
assert.deepStrictEqual([transactions, delays], [1, []]);
assert.ok(!isMissingBanList(new ForeignKeyConstraintError('steamUser')));
assert.ok(!isMissingBanList(new Error('Cannot add or update a child row')));

// Which errors are retried: deadlocks, lock wait timeouts, a transaction MySQL already rolled back
// and an unavailable database, but never foreign key or validation errors.
for (const [err, retried] of [
  [deadlock(), true],
  [lockWaitTimeout(), true],
  [
    new Error('Transaction cannot be committed because it has been finished with state: rollback'),
    true
  ],
  [new ConnectionError(), true],
  [new ForeignKeyConstraintError('banList'), false],
  [new ValidationError('Validation error'), false],
  [tooLong, false],
  [new Error('Something else'), false]
])
  assert.strictEqual(isRetryable(err), retried, describeError(err));
reset();
let calls = 0;
assert.strictEqual(
  await retryOperation(async () => {
    if (++calls < 3) throw deadlock();
    return 'done';
  }),
  'done'
);
assert.deepStrictEqual([calls, delays], [3, [5000, 5000]]);

// Removing bans: each batch is one transaction that queues the bans' players, and any player a ban
// had before, for an update, deletes the bans of that list, and drops their records as missing
// bans. The bans removed are those MySQL deleted. A deadlock runs the batch again as a whole.
reset();
deleted = 2;
fail(/^DELETE FROM Bans /, deadlock());
const removed = await removeBans(
  7,
  [
    { id: '7,a', steamUser: steamID(1) },
    { id: '7,b', steamUser: steamID(1), previousSteamUser: steamID(4) },
    { id: '7,c', steamUser: steamID(2) }
  ],
  { batchSize: 2 }
);
assert.strictEqual(removed, 4);
assert.deepStrictEqual(
  events.map(([type, sql, replacements, transaction]) =>
    type === 'query' ? [sql, replacements, transaction] : [type, sql]
  ),
  [
    ['begin', 1],
    [QUEUE_PLAYERS, [[steamID(1), steamID(4)]], 1],
    ['DELETE FROM Bans WHERE banList = ? AND id IN (?)', [7, ['7,a', '7,b']], 1],
    ['rollback', 1],
    ['begin', 2],
    [QUEUE_PLAYERS, [[steamID(1), steamID(4)]], 2],
    ['DELETE FROM Bans WHERE banList = ? AND id IN (?)', [7, ['7,a', '7,b']], 2],
    [
      'DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)',
      [7, ['7,a', '7,b']],
      2
    ],
    ['commit', 2],
    ['begin', 3],
    [QUEUE_PLAYERS, [[steamID(2)]], 3],
    ['DELETE FROM Bans WHERE banList = ? AND id IN (?)', [7, ['7,c']], 3],
    ['DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)', [7, ['7,c']], 3],
    ['commit', 3]
  ]
);

// Missing bans are recorded with one statement per batch, which keeps when a ban was first missing
// and updates when it was last, and their records are dropped the same way.
reset();
await savePendingRemovals(7, ['7,a', '7,b', '7,c'], { now: new Date(NOW), batchSize: 2 });
await clearPendingRemovals(7, ['7,d'], { batchSize: 2 });
assert.deepStrictEqual(
  events.map(([, sql, replacements, transaction]) => [sql, replacements, transaction]),
  [
    [
      'INSERT INTO BanListPendingRemovals (banList, banId, firstMissingAt, lastMissingAt) VALUES (?, ?, ?, ?), (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE lastMissingAt = new.lastMissingAt',
      [
        7,
        '7,a',
        '2026-10-21 12:00:00.000',
        '2026-10-21 12:00:00.000',
        7,
        '7,b',
        '2026-10-21 12:00:00.000',
        '2026-10-21 12:00:00.000'
      ],
      null
    ],
    [
      'INSERT INTO BanListPendingRemovals (banList, banId, firstMissingAt, lastMissingAt) VALUES (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE lastMissingAt = new.lastMissingAt',
      [7, '7,c', '2026-10-21 12:00:00.000', '2026-10-21 12:00:00.000'],
      null
    ],
    ['DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)', [7, ['7,d']], null]
  ]
);

// Once the run is asked to stop, the batch under way is finished, and no other is started.
reset();
batches.length = 0;
const many = Array.from({ length: 5 }, (_, i) => ({ ...diff.added[0], id: `1,s${i}` }));
let stopAfter = 2;
result = await writeBans(7, many, {
  batchSize: 2,
  now: WRITTEN_AT,
  onWritten: (batch) => {
    batches.push(batch.length);
    if (--stopAfter === 0) control.requestStop('it received SIGTERM');
  }
});
assert.deepStrictEqual(plain(result), { stopped: true });
assert.deepStrictEqual(batches, [2, 2]);
assert.strictEqual(events.filter(([type]) => type === 'commit').length, 2);

console.log(
  'Apply checks passed: values compared, players kept and moved, removals planned, batched writes, retries, failed bans, removals and stops.'
);
