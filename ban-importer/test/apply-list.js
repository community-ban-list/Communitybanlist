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
  clearHoldReason,
  clearPendingRemovals,
  COMPARED_FIELDS,
  CONFIRM_AFTER,
  diffBans,
  fewestHeld,
  flagOf,
  FULL_REMOVAL_BANS,
  isLargeLoss,
  isMissingBanList,
  isRetryable,
  LARGE_REMOVAL_BANS,
  LARGE_REMOVAL_SHARE,
  largeLossBans,
  planRemovals,
  readHold,
  readPendingRemovals,
  readStoredBans,
  RECORDED_HOLDS,
  removeBans,
  REMOVE_AT_ONCE_BANS,
  REMOVE_AT_ONCE_SHARE,
  retryOperation,
  saveHold,
  savePendingRemovals,
  sqlTime,
  textOf,
  timeOf,
  whyHeld,
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
assert.deepStrictEqual([LARGE_REMOVAL_BANS, LARGE_REMOVAL_SHARE], [25, 0.2]);
// A large loss is at least 25 bans, and a fifth of the list: the 25 decide for a list of up to 125
// bans, and the fifth above that. None is never one.
assert.deepStrictEqual(
  [
    [24, 30],
    [25, 30],
    [25, 125],
    [25, 126],
    [26, 126],
    [2355, 11780],
    [2356, 11780],
    [0, 0]
  ].map(([count, stored]) => isLargeLoss(count, stored)),
  [false, true, true, false, true, false, true, false]
);
// The fewest that are a large loss: 25 up to 125 bans, and a fifth, rounded up, above that.
assert.deepStrictEqual(
  [0, 30, 125, 126, 200, 1000, 1001, 11780].map(largeLossBans),
  [25, 25, 25, 26, 40, 200, 201, 2356]
);
// The fewest of a 'large' hold's bans still missing that keep it, of the bans it is measured
// against: as many, but all of them when they are fewer than 25, as for a hold that took in that of
// a list that lost all of its 20 bans, and never none.
assert.deepStrictEqual(
  [0, 1, 20, 24, 25, 30, 125, 126, 200, 1000, 11780].map(fewestHeld),
  [1, 1, 20, 24, 25, 25, 25, 26, 40, 200, 2356]
);
assert.deepStrictEqual(plain(RECORDED_HOLDS), ['full', 'large']);
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
  hold: null,
  held: [],
  released: []
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
  hold: null,
  held: [],
  released: []
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
  hold: null,
  held: [],
  released: []
});
// Once fewer would wait, they are all removed at once.
assert.deepStrictEqual(plan({ missing: range(0, 39), stored: 200, fetched: 161, pending }), {
  remove: range(0, 39),
  wait: [],
  hold: null,
  held: [],
  released: []
});
// A read that found no bans at all, or none of a list's 10 or more bans, holds them all for an
// admin, however long they have been missing. A smaller list that lost all its bans to other bans
// is not held, and loses them at once.
pending = pendingSince(range(0, 12), 60);
assert.deepStrictEqual(plan({ missing: range(0, 3), stored: 3, fetched: 0 }), {
  remove: [],
  wait: [],
  hold: 'empty',
  held: range(0, 3),
  released: []
});
assert.deepStrictEqual(plan({ missing: range(0, 12), stored: 12, fetched: 40, pending }), {
  remove: [],
  wait: [],
  hold: 'full',
  held: range(0, 12),
  released: []
});
assert.deepStrictEqual(plan({ missing: range(0, 9), stored: 9, fetched: 40 }).remove, range(0, 9));
// A list held as it lost all its bans has saved the bans its read found since, so its bans from
// before are no longer all of it, but it stays held while none of them has come back, however long
// they have been missing, here 30 of 430. The bans it saved since, and no longer has, are removed
// as usual: at once when few, and after a later read when many.
const held = new Set(range(0, 30));
pending = pendingSince(range(0, 30), 600);
assert.deepStrictEqual(plan({ missing: range(0, 30), stored: 430, fetched: 400, pending, held }), {
  remove: [],
  wait: [],
  hold: 'full',
  held: range(0, 30),
  released: []
});
assert.deepStrictEqual(plan({ missing: range(0, 35), stored: 430, fetched: 395, pending, held }), {
  remove: range(30, 35),
  wait: [],
  hold: 'full',
  held: range(0, 30),
  released: []
});
assert.deepStrictEqual(plan({ missing: range(0, 60), stored: 430, fetched: 370, pending, held }), {
  remove: [],
  wait: range(30, 60),
  hold: 'full',
  held: range(0, 30),
  released: []
});
// So do 20 of 420, which the rule for few missing bans would otherwise remove at once, and a list
// whose read found a single other ban.
assert.deepStrictEqual(
  plan({
    missing: range(0, 20),
    stored: 420,
    fetched: 400,
    pending,
    held: new Set(range(0, 20))
  }).hold,
  'full'
);
assert.deepStrictEqual(
  plan({ missing: range(0, 30), stored: 31, fetched: 1, pending, held }).held,
  range(0, 30)
);
// Once one of them comes back, the hold ends: the rest wait for a later complete read, as if first
// missing now, however long they were held, or are removed at once when they are few.
assert.deepStrictEqual(plan({ missing: range(1, 30), stored: 430, fetched: 401, pending, held }), {
  remove: [],
  wait: range(1, 30),
  hold: null,
  held: [],
  released: range(1, 30)
});
assert.deepStrictEqual(plan({ missing: range(25, 30), stored: 430, fetched: 425, pending, held }), {
  remove: range(25, 30),
  wait: [],
  hold: null,
  held: [],
  released: range(25, 30)
});
// As it does for a list whose bans are being replaced.
assert.deepStrictEqual(
  plan({ missing: range(0, 30), stored: 430, fetched: 400, pending, held, replace: true }),
  { remove: [], wait: range(0, 30), hold: null, held: [], released: range(0, 30) }
);
// An admin's confirmation removes them.
assert.deepStrictEqual(
  plan({ missing: range(0, 30), stored: 430, fetched: 400, pending, held, confirmed: true }).remove,
  range(0, 30)
);
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
  hold: null,
  held: [],
  released: []
});
assert.deepStrictEqual(
  plan({ missing: range(0, 12), stored: 12, fetched: 0, replace: true, pending }).remove,
  range(0, 12)
);

// A read that finds a large part of a list missing at once holds those bans for an admin: at least
// 25 of them, and a fifth of the bans the list had before the read, so the 25 decide for a list of
// up to 125 bans, and the fifth above that, e.g. 2,356 of 11,780. One ban fewer, by either, waits
// for a later complete read, as any other loss does. The hold is measured against the bans the
// list had before the read (heldOf). Each case is [stored, the fewest held].
const lose = (count, from = 0) => range(from, from + count);
for (const [stored, fewest] of [
  [30, 25],
  [100, 25],
  [125, 25],
  [126, 26],
  [1000, 200],
  [11780, 2356]
]) {
  const label = `${stored} stored`;
  assert.deepStrictEqual(
    plan({ missing: lose(fewest - 1), stored, fetched: stored - fewest + 1 }),
    { remove: [], wait: lose(fewest - 1), hold: null, held: [], released: [] },
    label
  );
  assert.deepStrictEqual(
    plan({ missing: lose(fewest), stored, fetched: stored - fewest }),
    { remove: [], wait: [], hold: 'large', held: lose(fewest), released: [], heldOf: stored },
    label
  );
}
// The smaller loss is removed once a complete read at least 10 minutes after the first without it
// still does not have it, as before, and a small one at once.
assert.deepStrictEqual(
  plan({ missing: lose(199), stored: 1000, fetched: 801, pending: pendingSince(lose(199), 10) }),
  { remove: lose(199), wait: [], hold: null, held: [], released: [] }
);
assert.deepStrictEqual(plan({ missing: lose(49), stored: 1000, fetched: 951 }).remove, lose(49));
// A read that found no bans, or none of a list's bans, is held as it was, however many it lost.
assert.strictEqual(plan({ missing: lose(30), stored: 30, fetched: 0 }).hold, 'empty');
assert.strictEqual(plan({ missing: lose(30), stored: 30, fetched: 400 }).hold, 'full');
// Only the bans no earlier read had missed count towards a large loss, and only they are held. Those
// already waiting for their confirming read go on waiting, or are removed once it comes: here 150
// that first went missing 5 minutes, or 10, before a read that lost 100 more, or 200.
pending = pendingSince(lose(150), 5);
assert.deepStrictEqual(plan({ missing: lose(250), stored: 1000, fetched: 750, pending }), {
  remove: [],
  wait: lose(250),
  hold: null,
  held: [],
  released: []
});
assert.deepStrictEqual(plan({ missing: lose(350), stored: 1000, fetched: 650, pending }), {
  remove: [],
  wait: lose(150),
  hold: 'large',
  held: lose(200, 150),
  released: [],
  heldOf: 1000
});
pending = pendingSince(lose(150), 10);
assert.deepStrictEqual(plan({ missing: lose(350), stored: 1000, fetched: 650, pending }), {
  remove: lose(150),
  wait: [],
  hold: 'large',
  held: lose(200, 150),
  released: [],
  heldOf: 1000
});
// The hold lasts, as 'large', while those of its bans still missing are a large loss of the bans
// it is measured against (heldOf), here 300 of 1,000, however long they have been missing, and
// however much the list has grown since, here to 2,000 bans, of which 300 would no longer be a
// large loss: it is measured against the fewer of heldOf and the bans the list had before the
// read. Its other missing bans are removed as usual meanwhile, as those of a list held as it lost
// all of its bans are: a few at once, and more, up to one ban fewer than a large loss of the list,
// after a confirming read.
const heldLarge = { held: new Set(lose(300)), heldFor: 'large', heldOf: 1000 };
pending = pendingSince(lose(300), 600);
assert.deepStrictEqual(
  plan({ missing: lose(300), stored: 2000, fetched: 1700, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(300), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({ missing: lose(305), stored: 1000, fetched: 695, pending, ...heldLarge }),
  { remove: lose(5, 300), wait: [], hold: 'large', held: lose(300), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({ missing: lose(499), stored: 1000, fetched: 501, pending, ...heldLarge }),
  { remove: [], wait: lose(199, 300), hold: 'large', held: lose(300), released: [], heldOf: 1000 }
);
// But while it lasts, a read that loses a large part of the list's other bans, of those no earlier
// read had missed, holds every missing ban, as 'large', from now, here 200 more of 1,000, and of
// 2,000 a fifth of them, 400, still measured against the 1,000 it is measured against. That takes
// in the bans waiting for a confirming read too, here 50 due to be removed. Held bans that came
// back, and lost their records, count as no earlier read had missed them once they are missing
// again: here 200 of a hold of 500, of which 300 are still held.
assert.deepStrictEqual(
  plan({ missing: lose(500), stored: 1000, fetched: 500, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(500), released: [], heldOf: 1000 }
);
// Only the bans no earlier read had missed count: here 100 more, with 150 already waiting for a
// confirming read, which go on waiting with them.
assert.deepStrictEqual(
  plan({
    missing: lose(550),
    stored: 1000,
    fetched: 450,
    pending: new Map([...pending, ...pendingSince(lose(150, 300), 5)]),
    ...heldLarge
  }),
  { remove: [], wait: lose(250, 300), hold: 'large', held: lose(300), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({
    missing: lose(750),
    stored: 2000,
    fetched: 1250,
    pending: new Map([...pending, ...pendingSince(lose(50, 300), 11)]),
    ...heldLarge
  }),
  { remove: [], wait: [], hold: 'large', held: lose(750), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({
    missing: lose(500),
    stored: 1000,
    fetched: 500,
    ...heldLarge,
    pending: pendingSince(lose(300, 200), 600),
    held: new Set(lose(300, 200))
  }),
  { remove: [], wait: [], hold: 'large', held: lose(500), released: [], heldOf: 1000 }
);
// Without heldFor, a hold an earlier run began is taken as one of a list that lost all its bans, the
// only hold an importer recorded before 'large', which ends as soon as one of them comes back.
assert.strictEqual(
  plan({ missing: lose(300), stored: 1000, fetched: 700, pending, held: heldLarge.held }).hold,
  'full'
);
assert.deepStrictEqual(
  plan({ missing: lose(299, 1), stored: 1000, fetched: 701, pending, held: heldLarge.held }),
  { remove: [], wait: lose(299, 1), hold: null, held: [], released: lose(299, 1) }
);
// Those of its bans that come back are no longer held, but the hold goes on while those still
// missing are a large loss: here 299, and then 200, a fifth of the 1,000 bans the list had when it
// began, however much the list grew since.
assert.deepStrictEqual(
  plan({ missing: lose(299, 1), stored: 1000, fetched: 701, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(299, 1), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({ missing: lose(200, 100), stored: 2000, fetched: 1800, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(200, 100), released: [], heldOf: 1000 }
);
// A list that shrank since has its hold measured against the bans it has now, as a hold that
// began on the smaller list would be: here 120, a fifth of the 600 it had before the read, keep it,
// which it is measured against from now, and 119 end it. However much the list grows back later,
// the hold is measured against 600 (see whyHeld).
assert.deepStrictEqual(
  plan({ missing: lose(120, 180), stored: 600, fetched: 480, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(120, 180), released: [], heldOf: 600 }
);
assert.deepStrictEqual(
  plan({ missing: lose(119, 181), stored: 600, fetched: 481, pending, ...heldLarge }),
  { remove: [], wait: lose(119, 181), hold: null, held: [], released: lose(119, 181) }
);
// A ban that came back, and is missing again later, is no longer held: it is removed as the list's
// other bans are, here at once, as it is the only one, unless those missing again with it are a
// large loss (above).
assert.deepStrictEqual(
  plan({
    missing: lose(300),
    stored: 1000,
    fetched: 700,
    ...heldLarge,
    pending: pendingSince(lose(299, 1), 600),
    held: new Set(lose(299, 1))
  }),
  { remove: lose(1), wait: [], hold: 'large', held: lose(299, 1), released: [], heldOf: 1000 }
);
// Once fewer are still missing, here 199, the hold ends: the rest wait for a later complete read,
// as if first missing now, however long they were held, and are not held again as a large loss,
// as an earlier read missed them, or are removed at once when they are few. A list that had up to
// 125 bans keeps its hold while 25 are still missing.
assert.deepStrictEqual(
  plan({ missing: lose(199, 101), stored: 1000, fetched: 801, pending, ...heldLarge }),
  { remove: [], wait: lose(199, 101), hold: null, held: [], released: lose(199, 101) }
);
assert.deepStrictEqual(
  plan({ missing: lose(9, 291), stored: 1000, fetched: 991, pending, ...heldLarge }),
  { remove: lose(9, 291), wait: [], hold: null, held: [], released: lose(9, 291) }
);
const heldSmall = { held: new Set(lose(30)), heldFor: 'large', heldOf: 100 };
assert.deepStrictEqual(
  plan({ missing: lose(25, 5), stored: 100, fetched: 75, pending, ...heldSmall }).held,
  lose(25, 5)
);
assert.deepStrictEqual(
  plan({ missing: lose(24, 6), stored: 100, fetched: 76, pending, ...heldSmall }),
  { remove: [], wait: lose(24, 6), hold: null, held: [], released: lose(24, 6) }
);
// A hold whose bans all came back ends with nothing to release.
assert.deepStrictEqual(plan({ missing: [], stored: 1000, fetched: 1000, pending, ...heldLarge }), {
  remove: [],
  wait: [],
  hold: null,
  held: [],
  released: []
});
// Without heldOf, as for a hold whose start is not known, those still missing are measured against
// the bans the list had before the read.
assert.deepStrictEqual(
  [1000, 2000].map(
    (stored) =>
      plan({
        missing: lose(300),
        stored,
        fetched: stored - 300,
        pending,
        held: heldLarge.held,
        heldFor: 'large'
      }).hold
  ),
  ['large', null]
);
// A read that finds none of the bans of a list held as it lost a large part of them, while that
// hold lasts, holds them all as 'large' still, so the hold goes on by its own rule, measured as
// before, here against 1,000 bans however much the list has grown, rather than as 'full', which
// would end as soon as one of them came back. So does one of a list whose only bans are those it
// holds, measured against the 300 it has. A list whose hold no longer lasts, here as fewer than a
// fifth of the 1,000 bans it is measured against are held, and one held as it lost all of its
// bans, whose other bans are too few to be a large loss, are held as 'full', as any list is: all
// of their bans, the 10 the second saved since among them.
assert.deepStrictEqual(
  plan({ missing: lose(2000), stored: 2000, fetched: 50, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(2000), released: [], heldOf: 1000 }
);
assert.deepStrictEqual(
  plan({ missing: lose(300), stored: 300, fetched: 50, pending, ...heldLarge }),
  { remove: [], wait: [], hold: 'large', held: lose(300), released: [], heldOf: 300 }
);
assert.deepStrictEqual(
  [{ ...heldLarge, held: new Set(lose(199)), heldOf: 2000 }, { held: new Set(lose(990)) }].map(
    (hold) => plan({ missing: lose(1000), stored: 1000, fetched: 50, pending, ...hold })
  ),
  [
    { remove: [], wait: [], hold: 'full', held: lose(1000), released: [] },
    { remove: [], wait: [], hold: 'full', held: lose(1000), released: [] }
  ]
);
// Only one of the bans a 'full' hold began with ends it as it comes back (firstHeld): here a list
// held as it lost all of its 30 bans, which then lost all of the 35 it had, too few of them saved
// since to be a large loss, so it holds the 5 it saved since with its 30. One of the 5 that comes
// back is no longer held, and the hold goes on with the rest, as it does once all 5 came back, and
// once one of the 30 comes back, the hold ends: the rest wait for a later complete read, the 4 it
// saved since among them. Without firstHeld, all of its held bans are those it began with, as for
// a hold whose bans were all held in one read, and any one of them ends it.
const heldAgain = { held: new Set(lose(35)), firstHeld: new Set(lose(30)) };
pending = pendingSince(lose(35), 600);
assert.deepStrictEqual(
  [
    plan({ missing: lose(34), stored: 36, fetched: 2, pending, ...heldAgain }),
    plan({ missing: lose(30), stored: 36, fetched: 6, pending, ...heldAgain }),
    plan({ missing: lose(34, 1), stored: 36, fetched: 2, pending, ...heldAgain }),
    plan({ missing: lose(34), stored: 36, fetched: 2, pending, held: heldAgain.held })
  ],
  [
    { remove: [], wait: [], hold: 'full', held: lose(34), released: [] },
    { remove: [], wait: [], hold: 'full', held: lose(30), released: [] },
    { remove: [], wait: lose(34, 1), hold: null, held: [], released: lose(34, 1) },
    { remove: [], wait: lose(34), hold: null, held: [], released: lose(34) }
  ]
);
// A list held as it lost all of its bans, here 20, whose read loses a large part of the bans it
// saved since, here 100 of the 400 it saved, or all of them, holds every missing ban as 'large'
// from now, measured against the 20 it held: they stay held while 20 are still missing, so at
// least until one of those 20 comes back, as the 'full' hold would have kept them, and the 100
// too, while they are still missing. Kept as 'full', all of them would have been let go as soon as
// any one of them came back.
const heldFull = { held: new Set(lose(20)) };
pending = pendingSince(lose(20), 600);
assert.deepStrictEqual(
  plan({ missing: lose(120), stored: 420, fetched: 300, pending, ...heldFull }),
  { remove: [], wait: [], hold: 'large', held: lose(120), released: [], heldOf: 20 }
);
assert.deepStrictEqual(
  plan({ missing: lose(420), stored: 420, fetched: 300, pending, ...heldFull }),
  { remove: [], wait: [], hold: 'large', held: lose(420), released: [], heldOf: 20 }
);
const tookIn = { held: new Set(lose(120)), heldFor: 'large', heldOf: 20 };
pending = pendingSince(lose(120), 600);
assert.deepStrictEqual(plan({ missing: lose(20), stored: 420, fetched: 400, pending, ...tookIn }), {
  remove: [],
  wait: [],
  hold: 'large',
  held: lose(20),
  released: [],
  heldOf: 20
});
assert.deepStrictEqual(
  plan({ missing: lose(19, 1), stored: 420, fetched: 401, pending, ...tookIn }),
  { remove: lose(19, 1), wait: [], hold: null, held: [], released: lose(19, 1) }
);
pending = pendingSince(lose(300), 600);
// A large loss in the read that ends the hold, of bans no read had missed, is held anew, as a hold
// that begins. While the hold goes on, such a loss is held with it (above).
assert.deepStrictEqual(
  plan({
    missing: [...lose(199, 101), ...lose(200, 300)],
    stored: 1000,
    fetched: 601,
    pending,
    ...heldLarge
  }),
  {
    remove: [],
    wait: lose(199, 101),
    hold: 'large',
    held: lose(200, 300),
    released: lose(199, 101),
    heldOf: 1000
  }
);
assert.deepStrictEqual(
  plan({
    missing: [...lose(299, 1), ...lose(200, 300)],
    stored: 1000,
    fetched: 501,
    pending,
    ...heldLarge
  }),
  {
    remove: [],
    wait: [],
    hold: 'large',
    held: [...lose(299, 1), ...lose(200, 300)],
    released: [],
    heldOf: 1000
  }
);
// The bans of a list whose source was replaced are never held as a large loss, and a hold of its
// old source's bans ends.
assert.deepStrictEqual(plan({ missing: lose(300), stored: 1000, fetched: 700, replace: true }), {
  remove: [],
  wait: lose(300),
  hold: null,
  held: [],
  released: []
});
assert.deepStrictEqual(
  plan({ missing: lose(300), stored: 1000, fetched: 700, pending, ...heldLarge, replace: true }),
  { remove: [], wait: lose(300), hold: null, held: [], released: lose(300) }
);
// An admin's confirmation removes them all at once, whether the read held them or an earlier one.
assert.deepStrictEqual(
  plan({ missing: lose(300), stored: 1000, fetched: 700, confirmed: true }).remove,
  lose(300)
);
assert.deepStrictEqual(
  plan({ missing: lose(300), stored: 1000, fetched: 700, pending, ...heldLarge, confirmed: true }),
  { remove: lose(300), wait: [], hold: null, held: [], released: [] }
);

// Reading a list's stored bans and its recorded missing bans takes one query each, by the list. A
// recorded ban says when it was first missing, and when a run began holding it for an admin, if
// one did.
reset();
const STORED_BANS =
  'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ?';
const PENDING_BANS =
  'SELECT banId, firstMissingAt, heldAt FROM BanListPendingRemovals WHERE banList = ?';
selects = {
  [STORED_BANS]: [storedBan('a')],
  [PENDING_BANS]: [
    { banId: '1,x', firstMissingAt: new Date(ago(5)), heldAt: null },
    { banId: '1,y', firstMissingAt: '2026-10-21 11:00:00.000', heldAt: new Date(ago(30)) }
  ]
};
assert.deepStrictEqual(plain(await readStoredBans(1)), plain([storedBan('a')]));
assert.deepStrictEqual(
  Array.from(await readPendingRemovals(1), ([banId, { firstMissingAt, heldAt }]) => [
    banId,
    firstMissingAt,
    heldAt
  ]),
  [
    ['1,x', ago(5), null],
    ['1,y', ago(60), ago(30)]
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
// While the batch is written a ban at a time, a ban that cannot be written as the database stays
// unavailable, or as the list is not in the database, stops the writes, as it would for the batch.
// It is not passed on as a ban that cannot be saved, and no other ban is written.
for (const [errors, rejection] of [
  [Array.from({ length: 5 }, () => new ConnectionError()), ConnectionError],
  [[new ForeignKeyConstraintError('banList')], (err) => isMissingBanList(err)]
]) {
  reset();
  fail(WRITE_BANS, new ValidationError('Validation error'), ...errors);
  failed.length = 0;
  batches.length = 0;
  await assert.rejects(
    writeBans(7, diff.added, {
      now: WRITTEN_AT,
      onWritten: (batch) => batches.push(batch.length),
      onFailed: (ban) => failed.push(ban.id)
    }),
    rejection
  );
  assert.deepStrictEqual([failed, batches], [[], []], describeError(errors[0]));
  assert.strictEqual(transactions, 1 + errors.length, describeError(errors[0]));
}

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
// Each committed batch is counted as it is removed, so one that fails for good after the first,
// e.g. as the database stays unavailable, still counts the bans the first removed.
reset();
deleted = 2;
let deletes = 0;
fail(
  { test: (sql) => /^DELETE FROM Bans /.test(sql) && ++deletes > 1 },
  ...Array.from({ length: 5 }, () => new ConnectionError())
);
const counted = [];
await assert.rejects(
  removeBans(
    7,
    [
      { id: '7,a', steamUser: steamID(1) },
      { id: '7,b', steamUser: steamID(1) },
      { id: '7,c', steamUser: steamID(2) }
    ],
    { batchSize: 2, onRemoved: (count) => counted.push(count) }
  ),
  { name: 'SequelizeConnectionRefusedError' }
);
assert.deepStrictEqual([counted, events.filter(([type]) => type === 'commit').length], [[2], 1]);

// Missing bans are recorded with one statement per batch, which keeps when a ban was first missing
// and updates when it was last, and their records are dropped the same way.
reset();
const SAVE_PENDING = (rows) =>
  `INSERT INTO BanListPendingRemovals (banList, banId, firstMissingAt, lastMissingAt, heldAt) VALUES ${Array(
    rows
  )
    .fill('(?, ?, ?, ?, ?)')
    .join(
      ', '
    )} AS new ON DUPLICATE KEY UPDATE lastMissingAt = new.lastMissingAt, heldAt = COALESCE(BanListPendingRemovals.heldAt, new.heldAt)`;
const RELEASE_HELD =
  'UPDATE BanListPendingRemovals SET firstMissingAt = ?, lastMissingAt = ?, heldAt = NULL WHERE banList = ? AND heldAt IS NOT NULL';
const AT = '2026-10-21 12:00:00.000';
const CLEAR_PENDING = 'DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)';
await savePendingRemovals(7, ['7,a', '7,b', '7,c'], { now: new Date(NOW), batchSize: 2 });
await clearPendingRemovals(7, ['7,d', '7,e', '7,f'], { batchSize: 2 });
assert.deepStrictEqual(
  events.map(([, sql, replacements, transaction]) => [sql, replacements, transaction]),
  [
    [SAVE_PENDING(2), [7, '7,a', AT, AT, null, 7, '7,b', AT, AT, null], null],
    [SAVE_PENDING(1), [7, '7,c', AT, AT, null], null],
    [CLEAR_PENDING, [7, ['7,d', '7,e']], null],
    [CLEAR_PENDING, [7, ['7,f']], null]
  ]
);
// A deadlock runs a statement again.
reset();
fail(/^DELETE FROM BanListPendingRemovals /, deadlock());
await clearPendingRemovals(7, ['7,d']);
assert.deepStrictEqual([statements().length, delays], [2, [5000]]);
// Each statement's bans are counted once they are recorded, so records cut short after the first
// statement, as the database stays unavailable, count only those it recorded.
reset();
let inserts = 0;
fail(
  { test: (sql) => /^INSERT INTO BanListPendingRemovals /.test(sql) && ++inserts > 1 },
  ...Array.from({ length: 5 }, () => new ConnectionError())
);
const recorded = [];
await assert.rejects(
  savePendingRemovals(7, ['7,a', '7,b', '7,c'], {
    now: new Date(NOW),
    batchSize: 2,
    onSaved: (count) => recorded.push(count)
  }),
  { name: 'SequelizeConnectionRefusedError' }
);
assert.deepStrictEqual([recorded, statements().length], [[2], 6]);

// What a read changes of a hold for an admin is written in one transaction, whole or not at all.
// A hold that begins saves why the list's bans are held, with the bans a 'large' hold is measured
// against, then its bans, a statement for each batch, recorded as held from now, unless they
// already were, which keeps when that began. One that begins anew, as it takes in all of the
// list's missing bans, releases the list's held bans first, so all of its bans are held from now.
// One that goes on saves its bans alone, or, after the records of its bans that came back are
// dropped, a batch at a time, with the count it is measured against from now. One that ends drops
// those records, releases the rest and deletes why the list's bans were held, or, as another hold
// begins with it, saves why for that one, and holds its bans.
reset();
const SAVE_HOLD_REASON =
  'INSERT INTO BanListHolds (banList, reason, storedCount) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE reason = new.reason, storedCount = new.storedCount';
const CLEAR_HOLD_REASON = 'DELETE FROM BanListHolds WHERE banList = ?';
await saveHold(7, ['7,e', '7,f', '7,g'], {
  reason: 'large',
  stored: 12,
  now: new Date(NOW),
  batchSize: 2
});
await saveHold(7, ['7,e', '7,f'], { release: true, now: new Date(NOW) });
await saveHold(7, ['7,e'], { stored: 30, now: new Date(NOW) });
await saveHold(7, ['7,e'], {
  back: ['7,x', '7,y', '7,z'],
  reason: 'large',
  stored: 9,
  now: new Date(NOW),
  batchSize: 2
});
await saveHold(7, [], { back: ['7,x'], release: true, end: true, now: new Date(NOW) });
await saveHold(7, ['7,n'], {
  back: ['7,x'],
  release: true,
  reason: 'large',
  stored: 500,
  end: true,
  now: new Date(NOW)
});
assert.deepStrictEqual(
  events.map(([type, sql, replacements, transaction]) =>
    type === 'query' ? [sql, replacements, transaction] : [type, sql]
  ),
  [
    ['begin', 1],
    [SAVE_HOLD_REASON, [7, 'large', 12], 1],
    [SAVE_PENDING(2), [7, '7,e', AT, AT, AT, 7, '7,f', AT, AT, AT], 1],
    [SAVE_PENDING(1), [7, '7,g', AT, AT, AT], 1],
    ['commit', 1],
    ['begin', 2],
    [RELEASE_HELD, [AT, AT, 7], 2],
    [SAVE_PENDING(2), [7, '7,e', AT, AT, AT, 7, '7,f', AT, AT, AT], 2],
    ['commit', 2],
    ['begin', 3],
    [SAVE_PENDING(1), [7, '7,e', AT, AT, AT], 3],
    ['commit', 3],
    ['begin', 4],
    [CLEAR_PENDING, [7, ['7,x', '7,y']], 4],
    [CLEAR_PENDING, [7, ['7,z']], 4],
    [SAVE_HOLD_REASON, [7, 'large', 9], 4],
    [SAVE_PENDING(1), [7, '7,e', AT, AT, AT], 4],
    ['commit', 4],
    ['begin', 5],
    [CLEAR_PENDING, [7, ['7,x']], 5],
    [RELEASE_HELD, [AT, AT, 7], 5],
    [CLEAR_HOLD_REASON, [7], 5],
    ['commit', 5],
    ['begin', 6],
    [CLEAR_PENDING, [7, ['7,x']], 6],
    [RELEASE_HELD, [AT, AT, 7], 6],
    [SAVE_HOLD_REASON, [7, 'large', 500], 6],
    [SAVE_PENDING(1), [7, '7,n', AT, AT, AT], 6],
    ['commit', 6]
  ]
);
// A failure that could pass, e.g. a deadlock, in any of its statements runs the whole transaction
// again, and one that lasts, e.g. as the database is down, leaves none of it saved: the batches
// saved before it are rolled back with it, so no part of the hold is saved without the rest. So
// does a hold that ends: the records of its bans that came back are dropped again with the rest,
// and one cut short as it releases them drops none of them.
const LAST_BATCH = /^INSERT INTO BanListPendingRemovals .* VALUES \(\?, \?, \?, \?, \?\) AS new /;
const steps = () =>
  events.map(([type, sql, replacements, transaction]) => {
    if (type !== 'query') return [type, sql];
    const step = {
      [SAVE_HOLD_REASON]: 'reason',
      [CLEAR_HOLD_REASON]: 'forget',
      [CLEAR_PENDING]: 'back',
      [RELEASE_HELD]: 'release'
    }[sql];
    return [step ?? `held ${replacements.length / 5}`, transaction];
  });
reset();
fail(LAST_BATCH, deadlock());
await saveHold(7, ['7,e', '7,f', '7,g'], { reason: 'large', now: new Date(NOW), batchSize: 2 });
assert.deepStrictEqual(steps(), [
  ['begin', 1],
  ['reason', 1],
  ['held 2', 1],
  ['held 1', 1],
  ['rollback', 1],
  ['begin', 2],
  ['reason', 2],
  ['held 2', 2],
  ['held 1', 2],
  ['commit', 2]
]);
assert.deepStrictEqual(delays, [5000]);
reset();
fail(LAST_BATCH, ...Array.from({ length: 5 }, () => new ConnectionError()));
await assert.rejects(
  saveHold(7, ['7,e', '7,f', '7,g'], { reason: 'large', now: new Date(NOW), batchSize: 2 }),
  { name: 'SequelizeConnectionRefusedError' }
);
assert.deepStrictEqual(
  ['begin', 'held 2', 'rollback', 'commit'].map(
    (step) => steps().filter(([type]) => type === step).length
  ),
  [5, 5, 5, 0]
);
reset();
fail(/^UPDATE BanListPendingRemovals /, deadlock());
await saveHold(7, [], { back: ['7,x'], release: true, end: true, now: new Date(NOW) });
assert.deepStrictEqual(steps(), [
  ['begin', 1],
  ['back', 1],
  ['release', 1],
  ['rollback', 1],
  ['begin', 2],
  ['back', 2],
  ['release', 2],
  ['forget', 2],
  ['commit', 2]
]);
reset();
fail(/^UPDATE BanListPendingRemovals /, ...Array.from({ length: 5 }, () => new ConnectionError()));
await assert.rejects(
  saveHold(7, [], { back: ['7,x'], release: true, end: true, now: new Date(NOW) }),
  { name: 'SequelizeConnectionRefusedError' }
);
assert.deepStrictEqual(
  ['begin', 'back', 'release', 'forget', 'rollback', 'commit'].map(
    (step) => steps().filter(([type]) => type === step).length
  ),
  [5, 5, 5, 0, 5, 0]
);

// Why a list's bans are held, and of how many bans, is read by the list, or none, and forgotten,
// each with one statement. A count MySQL gives as text is a number, and none is null. A lock wait
// runs the delete again.
reset();
const HOLD_REASON = 'SELECT reason, storedCount FROM BanListHolds WHERE banList = ?';
selects = { [HOLD_REASON]: [{ reason: 'large', storedCount: 200 }] };
assert.deepStrictEqual(plain(await readHold(7)), { reason: 'large', stored: 200 });
for (const [storedCount, stored] of [
  ['11780', 11780],
  [null, null],
  [undefined, null]
]) {
  selects = { [HOLD_REASON]: [{ reason: 'full', storedCount }] };
  assert.deepStrictEqual(plain(await readHold(7)), { reason: 'full', stored }, `${storedCount}`);
}
selects = {};
assert.strictEqual(await readHold(8), null);
events.length = 0;
await readHold(7);
await readHold(8);
await clearHoldReason(7);
assert.deepStrictEqual(
  events.map(([, sql, replacements, transaction]) => [sql, replacements, transaction]),
  [
    [HOLD_REASON, [7], null],
    [HOLD_REASON, [8], null],
    ['DELETE FROM BanListHolds WHERE banList = ?', [7], null]
  ]
);
reset();
fail(/^DELETE FROM BanListHolds /, lockWaitTimeout());
await clearHoldReason(7);
assert.deepStrictEqual([statements().length, delays], [2, [5000]]);

// The hold a list's held bans are taken for, by why they are held, how many of them there are and
// how many bans the list had before the read. A 'large' hold, with the count it was saved with, as
// long as at least fewestHeld of the fewer of that count and the list before the read are held: 40
// of 200, however much the list grew, 25 of 200 once the list has 100, 20 of a hold that took in
// one of 20 bans, and with no count, of the list before the read, 25 of 100 or 200 of 1,000. The
// importer never leaves a 'large' hold with fewer, so with fewer, its reason outlived it, and they
// are taken as 'full', as are those held with no reason, as by an importer from before
// BanListHolds, or with any other.
assert.deepStrictEqual(
  [
    [{ reason: 'large', stored: 200 }, 40, 2000],
    [{ reason: 'large', stored: 200 }, 39, 2000],
    [{ reason: 'large', stored: 200 }, 25, 100],
    [{ reason: 'large', stored: 200 }, 24, 100],
    [{ reason: 'large', stored: 20 }, 20, 420],
    [{ reason: 'large', stored: 20 }, 19, 420],
    [{ reason: 'large', stored: null }, 25, 100],
    [{ reason: 'large', stored: null }, 24, 100],
    [{ reason: 'large', stored: null }, 200, 1000],
    [{ reason: 'large', stored: null }, 199, 1000],
    [{ reason: 'large', stored: 200 }, 0, 100],
    [{ reason: 'full', stored: 30 }, 30, 30],
    [null, 30, 30],
    [{ reason: 'empty', stored: 30 }, 30, 30]
  ].map(([recorded, held, stored]) => plain(whyHeld(recorded, held, stored))),
  [
    { heldFor: 'large', heldOf: 200 },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'large', heldOf: 200 },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'large', heldOf: 20 },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'large', heldOf: null },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'large', heldOf: null },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'full', heldOf: null },
    { heldFor: 'full', heldOf: null }
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
  'Apply checks passed: values compared, players kept and moved, removals planned, holds of lists that lost all their bans, which last until confirmed or one of the bans they began with comes back, or a large part of them at once, which last until confirmed or fewer than a large loss of the fewer of the bans the list had then and has now are still missing, and which take in a large loss while they last, also into a hold of a list that lost all its bans, and reasons that outlived their holds, batched writes, retries, failed bans, bans written alone, removals counted a batch at a time, records of missing bans, counted a statement at a time, holds begun, gone on with, taken in and ended in one transaction, with why they are held and against how many bans, or not at all, and stops.'
);
