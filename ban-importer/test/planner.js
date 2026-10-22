import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check how the importer plans each list's read, without a database or network requests: which
// lists are read in full and why, in what order, when a list's next full read is due, what a head
// poll's pages say about drift and overflow, and how its settings are read. import-bans.js checks
// the importer acting on the plans.

const context = vm.createContext({});
const url = new URL('../src/planner.js', import.meta.url);
const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
  context,
  identifier: url.href
});
await module.link(() => {
  throw new Error('planner.js has no imports');
});
await module.evaluate();
const {
  checkHead,
  compareReads,
  DEFAULT_FULL_SCAN_MINUTES,
  FULL_SCAN_JITTER,
  MAX_HEAD_PAGES,
  MAX_HEAD_UIDS,
  nextFullScan,
  planRead,
  readFullScanMinutes,
  readHeadUids,
  REASONS,
  scheduleAfter,
  shouldFollow,
  writeHeadUids
} = module.namespace;

// Copy a value made in the module's context into one of this test's own, to compare it.
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.deepStrictEqual(plain(REASONS), {
  NEW: 'new',
  SOURCE: 'source',
  REMOVAL: 'removal',
  DRIFT: 'drift',
  OVERFLOW: 'overflow',
  PERIODIC: 'periodic',
  EVERY_RUN: 'every_run',
  REMOTE: 'remote'
});
assert.deepStrictEqual(
  [DEFAULT_FULL_SCAN_MINUTES, FULL_SCAN_JITTER, MAX_HEAD_UIDS, MAX_HEAD_PAGES],
  [30, 0.2, 100, 10]
);

// IMPORTER_FULL_SCAN_MINUTES is a whole number of minutes from 1 to a week, with spaces or one pair
// of quotes around it. Without it, lists are read in full every 30 minutes, as they are with an
// invalid value, with a warning.
for (const [value, minutes] of [
  [undefined, 30],
  ['', 30],
  [' ', 30],
  ['15', 15],
  [' 60 ', 60],
  ['"45"', 45],
  ["'1'", 1],
  ['10080', 10080],
  [90, 90]
])
  assert.deepStrictEqual(plain(readFullScanMinutes(value)), { minutes }, String(value));
for (const value of ['0', '-5', '1.5', '10081', 'thirty', '30 # minutes', '1e3'])
  assert.deepStrictEqual(
    plain(readFullScanMinutes(value)),
    {
      minutes: 30,
      invalid: true,
      warning: `Warning: IMPORTER_FULL_SCAN_MINUTES must be a whole number from 1 to 10080, not "${value}", so lists are read in full every 30 minutes.`
    },
    value
  );

// A row keeps the IDs of a list's newest bans as JSON, each once, at most 100. Anything else in the
// column, such as text from before or a hand edit, is read as none.
const hundredAndTen = Array.from({ length: 110 }, (_, n) => `u${n}`);
assert.strictEqual(writeHeadUids(['a', 'b', 'a', 'c']), '["a","b","c"]');
assert.deepStrictEqual(
  plain(readHeadUids(writeHeadUids(hundredAndTen))),
  hundredAndTen.slice(0, 100)
);
assert.deepStrictEqual(plain(readHeadUids('[]')), []);
for (const value of [
  null,
  undefined,
  '',
  'a,b',
  '{"a":1}',
  '[1,2]',
  '["a",""]',
  '["a",null]',
  JSON.stringify(hundredAndTen),
  42
])
  assert.strictEqual(readHeadUids(value), null, String(value));

// planRead, from rows made here. Times are numbers unless a case gives them otherwise.
const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const MINUTE = 60 * 1000;
const KEY = 'k'.repeat(64);
// A row whose list was read in full 10 minutes ago, and is next due in 15, with its newest page.
const rowOf = (fields = {}) => ({
  banList: 7,
  sourceKey: KEY,
  state: 'ok',
  lastFullScanAt: NOW - 10 * MINUTE,
  nextFullScanAt: NOW + 15 * MINUTE,
  scanReason: 'periodic',
  replacePending: 0,
  headUids: '["a","b","c"]',
  headTotal: 3,
  allowFullRemovalUntil: null,
  ...fields
});
const plan = (row, extra = {}) =>
  plain(
    planRead({
      type: 'battlemetrics',
      row,
      sourceKey: KEY,
      now: NOW,
      ...extra
    })
  );
const full = (reason) => ({ read: 'full', reason });

// A list that is not due anything is only polled.
assert.deepStrictEqual(plan(rowOf()), { read: 'head' });
// A new list, one that has never been read in full, and one whose type or source was changed, or
// whose old source's bans are still being replaced, is read in full.
assert.deepStrictEqual(plan(null), full('new'));
assert.deepStrictEqual(plan(rowOf({ lastFullScanAt: null })), full('new'));
assert.deepStrictEqual(plan(rowOf({ sourceKey: 'o'.repeat(64) })), full('source'));
assert.deepStrictEqual(plan(rowOf({ replacePending: 1 })), full('source'));
assert.deepStrictEqual(plan(rowOf({ replacePending: true })), full('source'));
// So is a list whose newest page or count is not known, which a poll compares its own with.
for (const fields of [
  { headUids: null },
  { headUids: 'not JSON' },
  { headTotal: null },
  { headTotal: undefined }
])
  assert.deepStrictEqual(plan(rowOf(fields)), full('new'), JSON.stringify(fields));
assert.deepStrictEqual(plan(rowOf({ headUids: '[]', headTotal: 0 })), { read: 'head' });

// A list with a missing ban that is due to be confirmed as gone is read in full, which removes it.
// One whose first missing ban is not due yet is not, nor is one CBL cannot read, as it is never
// swept.
assert.deepStrictEqual(
  plan(rowOf(), { pending: { confirmAt: NOW - 1, held: 0 } }),
  full('removal')
);
assert.deepStrictEqual(plan(rowOf(), { pending: { confirmAt: NOW, held: 0 } }), full('removal'));
assert.deepStrictEqual(plan(rowOf(), { pending: { confirmAt: NOW + 1, held: 0 } }), {
  read: 'head'
});
assert.deepStrictEqual(plan(rowOf(), { pending: { confirmAt: null, held: 0 } }), {
  read: 'head'
});
assert.deepStrictEqual(
  plan(rowOf({ state: 'access_lost' }), { pending: { confirmAt: NOW - 1, held: 0 } }),
  { read: 'head' }
);
// So is a list held for an admin once the admin allows it to lose its bans, until that runs out,
// and a list IMPORTER_ALLOW_MASS_REMOVAL names.
const allowed = rowOf({ state: 'held', allowFullRemovalUntil: new Date(NOW + 60 * MINUTE) });
assert.deepStrictEqual(plan(allowed, { pending: { confirmAt: null, held: 12 } }), full('removal'));
assert.deepStrictEqual(plan(allowed, { pending: { confirmAt: null, held: 0 } }), { read: 'head' });
assert.deepStrictEqual(
  plan(rowOf({ state: 'held', allowFullRemovalUntil: new Date(NOW - 1) }), {
    pending: { confirmAt: null, held: 12 }
  }),
  { read: 'head' }
);
assert.deepStrictEqual(plan(rowOf(), { allowMassRemoval: true }), full('removal'));

// A reason a poll found is kept in the row, due at once, until the list is read in full.
assert.deepStrictEqual(plan(rowOf({ scanReason: 'drift', nextFullScanAt: NOW })), full('drift'));
assert.deepStrictEqual(
  plan(rowOf({ scanReason: 'overflow', nextFullScanAt: NOW - MINUTE })),
  full('overflow')
);
assert.deepStrictEqual(
  plan(rowOf({ scanReason: 'removal', nextFullScanAt: NOW - MINUTE })),
  full('removal')
);
// A periodic read is due once nextFullScanAt has passed, or the list has none, or its last full
// read is older than IMPORTER_FULL_SCAN_MINUTES, e.g. once that was made shorter.
assert.deepStrictEqual(plan(rowOf({ nextFullScanAt: NOW })), full('periodic'));
assert.deepStrictEqual(plan(rowOf({ nextFullScanAt: null })), full('periodic'));
assert.deepStrictEqual(plan(rowOf({ scanReason: null, nextFullScanAt: NOW })), full('periodic'));
assert.deepStrictEqual(
  plan(rowOf({ lastFullScanAt: NOW - 31 * MINUTE, nextFullScanAt: NOW + MINUTE })),
  full('periodic')
);
assert.deepStrictEqual(plan(rowOf(), { fullScanMinutes: 10 }), full('periodic'));
assert.deepStrictEqual(plan(rowOf(), { fullScanMinutes: 11 }), { read: 'head' });
// Times read from MySQL work as Dates and as text, in UTC.
assert.deepStrictEqual(
  plan(
    rowOf({
      lastFullScanAt: new Date(NOW - 10 * MINUTE),
      nextFullScanAt: '2026-10-22 18:15:00.000'
    })
  ),
  { read: 'head' }
);
assert.deepStrictEqual(
  plan(rowOf({ nextFullScanAt: '2026-10-22 17:59:59.999' })),
  full('periodic')
);

// With head polls off, every list is read in full on every run. A remote list's file is read on
// every run, as it is all read at once.
assert.deepStrictEqual(plan(rowOf(), { headPoll: false }), full('every_run'));
assert.deepStrictEqual(plan(rowOf({ headUids: null }), { headPoll: false }), full('every_run'));
assert.deepStrictEqual(plan(rowOf(), { type: 'remote' }), full('remote'));
assert.deepStrictEqual(plan(null, { type: 'remote' }), full('new'));

// When several reasons apply, the most urgent is given: a new or changed source, then removals to
// confirm, then drift, overflow, and the periodic read.
assert.deepStrictEqual(
  plan(rowOf({ sourceKey: 'o'.repeat(64), lastFullScanAt: null }), { allowMassRemoval: true }),
  full('source')
);
assert.deepStrictEqual(
  plan(rowOf({ lastFullScanAt: null }), { allowMassRemoval: true }),
  full('new')
);
assert.deepStrictEqual(
  plan(rowOf({ scanReason: 'drift', nextFullScanAt: NOW - MINUTE }), {
    pending: { confirmAt: NOW - 1, held: 0 }
  }),
  full('removal')
);
assert.deepStrictEqual(
  plan(rowOf({ scanReason: 'drift', nextFullScanAt: NOW - MINUTE, headUids: null }), {
    headPoll: false
  }),
  full('drift')
);

// Lists are read with head polls first, then those read in full, the most urgent first, each kind
// in the order the lists were found.
const plans = [
  { id: 1, read: 'full', reason: 'periodic' },
  { id: 2, read: 'head' },
  { id: 3, read: 'full', reason: 'drift' },
  { id: 4, read: 'full', reason: 'remote' },
  { id: 5, read: 'full', reason: 'new' },
  { id: 6, read: 'full', reason: 'overflow' },
  { id: 7, read: 'head' },
  { id: 8, read: 'full', reason: 'source' },
  { id: 9, read: 'full', reason: 'removal' },
  { id: 10, read: 'full', reason: 'every_run' }
];
assert.deepStrictEqual(
  plans.sort(compareReads).map(({ id }) => id),
  [2, 7, 5, 8, 9, 3, 6, 1, 4, 10]
);

// A list read in full is next due 30 minutes later, less up to a fifth of that at random, so lists
// read together come due spread over 6 minutes.
assert.strictEqual(
  nextFullScan(NOW, 30, () => 0),
  NOW + 30 * MINUTE
);
assert.strictEqual(
  nextFullScan(NOW, 30, () => 1),
  NOW + 24 * MINUTE
);
assert.strictEqual(
  nextFullScan(NOW, 30, () => 0.5),
  NOW + 27 * MINUTE
);
assert.strictEqual(
  nextFullScan(NOW, 15, () => 1),
  NOW + 12 * MINUTE
);
for (let n = 0; n < 1000; n++) {
  const due = nextFullScan(NOW, 30);
  assert.ok(due > NOW + 24 * MINUTE - 1 && due <= NOW + 30 * MINUTE, String(due - NOW));
}

// After a full read that completed without an error, the next periodic read is scheduled, or the
// read that confirms the removal of bans left waiting, if that is sooner. A poll that found a
// reason to read the list in full, which was not then read in full without an error, leaves it due
// at once. Anything else keeps the schedule.
const schedule = (extra) =>
  plain(scheduleAfter({ now: NOW, fullScanMinutes: 30, random: () => 0, ...extra }) ?? null);
assert.deepStrictEqual(schedule({ completed: true }), {
  nextFullScanAt: NOW + 30 * MINUTE,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, confirmAt: NOW + 10 * MINUTE }), {
  nextFullScanAt: NOW + 10 * MINUTE,
  scanReason: 'removal'
});
assert.deepStrictEqual(schedule({ completed: true, confirmAt: NOW + 31 * MINUTE }), {
  nextFullScanAt: NOW + 30 * MINUTE,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, trigger: 'drift' }), {
  nextFullScanAt: NOW + 30 * MINUTE,
  scanReason: 'periodic'
});
for (const trigger of ['drift', 'overflow'])
  assert.deepStrictEqual(schedule({ trigger }), { nextFullScanAt: NOW, scanReason: trigger });
assert.strictEqual(schedule({}), null);
assert.strictEqual(schedule({ confirmAt: NOW + MINUTE }), null);
// The next periodic read is counted from when the run planned its reads, its now, so a list read in
// full 8 minutes into a run is due by the run that starts 30 minutes after that one, however the
// fifth at random falls, and the run 15 minutes after it only polls the list.
for (const random of [() => 0, () => 0.5, () => 0.9999]) {
  const { nextFullScanAt, scanReason } = scheduleAfter({
    now: NOW,
    fullScanMinutes: 30,
    completed: true,
    random
  });
  const readLate = rowOf({ lastFullScanAt: NOW + 8 * MINUTE, nextFullScanAt, scanReason });
  assert.deepStrictEqual(plan(readLate, { now: NOW + 15 * MINUTE }), { read: 'head' });
  assert.deepStrictEqual(plan(readLate, { now: NOW + 30 * MINUTE }), full('periodic'));
}

// What a head poll's pages say. Each page has its ban IDs, with or without a SteamID, its count of
// the list's bans and whether another page follows. Here the list's last read saw a, b and c on its
// newest page, with a count of 50.
const page = (uids, count = null, next = true) => ({ uids, total: count, next });
const seen = (...uids) => new Set(uids);
const head = (pages, known, extra = {}) =>
  plain(checkHead({ pages, known, previousTotal: 50, ...extra }));
// Bans added on top add to the count as much as to the new bans, so nothing else happened.
assert.deepStrictEqual(head([page(['n1', 'n2', 'a', 'b'], 52)], seen('a', 'b', 'c')), {
  complete: false,
  overflow: false,
  newBans: 2,
  drift: null
});
// A ban removed, from the newest page or below it, makes the count smaller than that.
assert.deepStrictEqual(head([page(['a', 'b'], 49)], seen('a', 'b', 'c')).drift, {
  total: 49,
  expected: 50
});
assert.deepStrictEqual(head([page(['n1', 'a', 'b', 'c'], 50)], seen('a', 'b', 'c')).drift, {
  total: 50,
  expected: 51
});
// A ban added below the newest page, e.g. one backdated, makes it larger.
assert.deepStrictEqual(head([page(['a', 'b', 'c'], 51)], seen('a', 'b', 'c')).drift, {
  total: 51,
  expected: 50
});
// A ban stored, or on the newest page last time, is not new wherever it is now, so a ban that
// moved up when one above it was removed adds nothing, and the removal shows. A ban without a
// SteamID, which is never stored, is new until a newest page has had it.
assert.deepStrictEqual(head([page(['a', 'c', 'd'], 49)], seen('a', 'b', 'c', 'd')).drift, {
  total: 49,
  expected: 50
});
assert.deepStrictEqual(head([page(['x', 'a', 'b'], 51)], seen('a', 'b', 'c')).drift, null);
// A count that is missing, now or from the last read, cannot be compared, nor is it with the
// comparison off.
assert.strictEqual(head([page(['a', 'b'], null)], seen('a', 'b', 'c')).drift, null);
assert.strictEqual(head([page(['a'], 40)], seen('a'), { previousTotal: null }).drift, null);
assert.strictEqual(head([page(['a'], 40)], seen('a'), { previousTotal: undefined }).drift, null);
assert.strictEqual(head([page(['a'], 40)], seen('a'), { drift: false }).drift, null);
// Counts read from MySQL may come as text.
assert.strictEqual(head([page(['a'], 50)], seen('a'), { previousTotal: '50' }).drift, null);
// The new bans on pages a poll followed count too, each once.
assert.deepStrictEqual(
  head([page(['n1', 'n2'], 54), page(['n3', 'n4', 'n2']), page(['a', 'b'])], seen('a', 'b')),
  { complete: false, overflow: false, newBans: 4, drift: null }
);
// Pages that reach the list's last page are all of it, which is read as such, whatever its count.
assert.deepStrictEqual(head([page(['n1', 'a'], 10, false)], seen('a')), {
  complete: true,
  overflow: false,
  newBans: 1,
  drift: null
});
// As many pages as a poll follows, all of them new bans, with more to come, overflow, and are not
// compared with the count. Had the last of them a ban seen before, they would not.
const newPages = (count) =>
  Array.from({ length: count }, (_, n) => page([`n${2 * n}`, `n${2 * n + 1}`], 70));
assert.deepStrictEqual(head(newPages(10), seen('a')), {
  complete: false,
  overflow: true,
  newBans: 20,
  drift: null
});
assert.deepStrictEqual(head([...newPages(9), page(['n99', 'a'])], seen('a')).overflow, false);
assert.deepStrictEqual(head(newPages(3), seen('a'), { maxPages: 3 }).overflow, true);
assert.deepStrictEqual(head([...newPages(9), page(['n99'], null, false)], seen('a')), {
  complete: true,
  overflow: false,
  newBans: 19,
  drift: null
});

// A poll follows the next page while the last one it read holds no ban it has seen, another page
// follows, and it has read fewer than 10 pages.
assert.strictEqual(shouldFollow([page(['n1', 'n2'])], seen('a')), true);
assert.strictEqual(shouldFollow([page([])], seen('a')), true);
assert.strictEqual(shouldFollow([page(['n1', 'a'])], seen('a')), false);
assert.strictEqual(shouldFollow([page(['n1'], null, false)], seen('a')), false);
assert.strictEqual(shouldFollow(newPages(9), seen('a')), true);
assert.strictEqual(shouldFollow(newPages(10), seen('a')), false);
assert.strictEqual(shouldFollow(newPages(2), seen('a'), 2), false);

console.log(
  'Planner checks passed: IMPORTER_FULL_SCAN_MINUTES, the newest bans a row keeps, which lists are read in full and why, the order of reads, when the next full read is due, counted from the start of the run, and what a head poll finds about drift and overflow.'
);
