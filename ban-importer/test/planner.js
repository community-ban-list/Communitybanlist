import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check how the importer plans each list's read, without a database or network requests: which
// lists are read in full and why, in what order, when a list's next full read is due, at its slot,
// what a head poll's pages say about drift and overflow, and how its settings are read. Cycles of
// the importer service are simulated over hours, to check that the lists' full reads spread out
// over them, and stay so. import-bans.js checks the importer acting on the plans.

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
  EARLY_SHARE,
  fullScanSlots,
  latestFullScan,
  MAX_HEAD_PAGES,
  MAX_HEAD_UIDS,
  nextFullScan,
  PAGE_SIZE,
  pagesOf,
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
  [DEFAULT_FULL_SCAN_MINUTES, EARLY_SHARE, PAGE_SIZE, MAX_HEAD_UIDS, MAX_HEAD_PAGES],
  [30, 0.1, 100, 100, 10]
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
// With runs at most half of IMPORTER_FULL_SCAN_MINUTES apart, a list waits for its slot for up to
// 1.5 times IMPORTER_FULL_SCAN_MINUTES less a cadence after its last full read: 35 minutes with a
// cycle every 10 minutes, 44 with one every minute. Past that, it is read in full however its row
// was scheduled. With runs further apart, or a cadence that is not known, it is 30 minutes, as
// before slots.
for (const [cadenceSeconds, waits] of [
  [600, 35],
  [120, 43],
  [60, 44],
  [900, 30],
  [1200, 30],
  [21600, 30],
  [null, 30]
]) {
  const lastRead = (minutes) =>
    rowOf({ lastFullScanAt: NOW - minutes * MINUTE, nextFullScanAt: NOW + MINUTE });
  assert.strictEqual(latestFullScan(30, cadenceSeconds), waits * MINUTE, String(cadenceSeconds));
  assert.deepStrictEqual(
    plan(lastRead(waits - 1), { cadenceSeconds }),
    { read: 'head' },
    String(cadenceSeconds)
  );
  assert.deepStrictEqual(
    plan(lastRead(waits), { cadenceSeconds }),
    full('periodic'),
    String(cadenceSeconds)
  );
}
assert.strictEqual(latestFullScan(120, 3600), 120 * MINUTE);
assert.strictEqual(latestFullScan(60, 0), 60 * MINUTE);
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
// The lists read in full as their time has come, periodic, every_run and remote, go the one read in
// full longest ago first, by the time a read gives with its plan, from the list's row, as a number,
// a Date or MySQL's text, and one without it first. Those read in full at the same time keep the
// order they were found in, and so do the lists read for the more urgent reasons, whatever their
// last full reads.
const lastRead = (minutes) => NOW - minutes * MINUTE;
const timely = [
  { id: 1, read: 'full', reason: 'periodic', lastFullScanAt: lastRead(30) },
  { id: 2, read: 'full', reason: 'drift', lastFullScanAt: lastRead(10) },
  { id: 3, read: 'full', reason: 'periodic', lastFullScanAt: new Date(lastRead(45)) },
  { id: 4, read: 'full', reason: 'remote', lastFullScanAt: lastRead(10) },
  { id: 5, read: 'full', reason: 'drift', lastFullScanAt: lastRead(50) },
  { id: 6, read: 'full', reason: 'periodic', lastFullScanAt: '2026-10-22 17:25:00.000' },
  { id: 7, read: 'head', lastFullScanAt: lastRead(90) },
  { id: 8, read: 'full', reason: 'every_run', lastFullScanAt: lastRead(31) },
  { id: 9, read: 'full', reason: 'periodic' },
  { id: 10, read: 'full', reason: 'periodic', lastFullScanAt: lastRead(30) },
  { id: 11, read: 'full', reason: 'new', lastFullScanAt: null }
];
assert.deepStrictEqual(
  timely.sort(compareReads).map(({ id }) => id),
  [7, 11, 2, 5, 9, 3, 6, 8, 1, 10, 4]
);

// How many pages a read of all of a list takes, about: BattleMetrics' count of its bans at its last
// read, or else the bans stored, a page for every 100, and at least one, from MySQL's numbers or
// text. A list without either count takes null, as nothing says.
for (const [row, pages] of [
  [{ headTotal: 9217, storedCount: 9001 }, 93],
  [{ headTotal: null, storedCount: 9001 }, 91],
  [{ headTotal: '100' }, 1],
  [{ headTotal: 101 }, 2],
  [{ headTotal: 0, storedCount: 500 }, 1],
  [null, null],
  [undefined, null],
  [{}, null],
  [{ headTotal: null, storedCount: null }, null],
  [{ headTotal: 'many' }, null]
])
  assert.strictEqual(pagesOf(row), pages, JSON.stringify(row));

// The lists' slots: in the order of their IDs, they share the interval by their pages, each at the
// middle of its share, in milliseconds from the start of the interval. A list's pages are at least
// one.
const INTERVAL = 30 * MINUTE;
const slotsOf = (lists, minutes = 30) => Object.fromEntries(fullScanSlots(lists, minutes));
assert.deepStrictEqual(
  slotsOf([
    { id: 3, pages: 1 },
    { id: 1, pages: 2 },
    { id: 2, pages: 1 }
  ]),
  { 1: 7.5 * MINUTE, 2: 18.75 * MINUTE, 3: 26.25 * MINUTE }
);
assert.deepStrictEqual(
  slotsOf([
    { id: 10, pages: 0 },
    { id: 20, pages: null },
    { id: 30, pages: 1 },
    { id: 40, pages: 1 }
  ]),
  { 10: 3.75 * MINUTE, 20: 11.25 * MINUTE, 30: 18.75 * MINUTE, 40: 26.25 * MINUTE }
);
assert.deepStrictEqual(slotsOf([{ id: 5, pages: 93 }], 60), { 5: 30 * MINUTE });
assert.deepStrictEqual(slotsOf([]), {});

// NOW is the start of an interval, as intervals are counted from midnight UTC on 1 January 1970.
assert.strictEqual(NOW % INTERVAL, 0);
const SLOT = 7.5 * MINUTE;
const next = (readAt, cadenceSeconds, slot = SLOT, fullScanMinutes = 30) =>
  nextFullScan({ readAt, fullScanMinutes, cadenceSeconds, slot });
// With a cycle every 10 minutes, a list read in full is next due at its slot in the 30 minutes up
// to 35 minutes after the read: read 2 minutes into the interval, at its slot 7.5 minutes into it,
// and read 3 minutes into it, at its slot in the next interval, as the 5.5 minutes before its slot
// this interval would be too soon.
assert.strictEqual(next(NOW + 2 * MINUTE, 600), NOW + 7.5 * MINUTE);
assert.strictEqual(next(NOW + 3 * MINUTE, 600), NOW + 37.5 * MINUTE);
// A list read in the cycle that started next after its slot, however far into that cycle, is due
// at its slot an interval later, so it stays at its slot.
for (const minutes of [0, 0.01, 4, 9.99, 14])
  assert.strictEqual(
    next(NOW + SLOT + minutes * MINUTE, 600),
    NOW + SLOT + INTERVAL,
    String(minutes)
  );
// Wherever its slot, a list is due at it at least half an interval less a cycle after its read,
// and at most 1.5 intervals less a cycle after it, never at once: 5 to 35 minutes with a cycle every
// 10 minutes, 14 to 44 with one every minute, and 0 to 30 with one every 15 or 20 minutes.
for (const [cadenceSeconds, soonest, latest] of [
  [600, 5, 35],
  [120, 13, 43],
  [60, 14, 44],
  [900, 0, 30],
  [1200, 0, 30]
])
  for (let slot = 0; slot < INTERVAL; slot += 37 * 1000)
    for (const readAt of [NOW, NOW + 61 * 1000, NOW + 17 * MINUTE + 3]) {
      const due = next(readAt, cadenceSeconds, slot);
      const which = `cadence ${cadenceSeconds}, slot ${slot}, read at ${readAt - NOW}`;
      assert.strictEqual((((due - slot) % INTERVAL) + INTERVAL) % INTERVAL, 0, which);
      assert.ok(due > readAt + soonest * MINUTE && due <= readAt + latest * MINUTE, which);
    }
// With runs at least IMPORTER_FULL_SCAN_MINUTES apart, as in once mode every 6 hours, or without a
// cadence or a slot, a list is next due IMPORTER_FULL_SCAN_MINUTES after its run planned its reads,
// less a tenth of it, however late in the run it was read: 27 minutes after the plan with 30, 54
// with 60 and 4.5 with 5. So a run that starts an interval after this one, or a little less, or
// that plans its reads a little sooner after its start, finds it due, and reads it in full again.
for (const [cadenceSeconds, slot] of [
  [1800, SLOT],
  [3600, SLOT],
  [21600, SLOT],
  [null, SLOT],
  [600, null]
])
  for (const readAt of [NOW + 3 * MINUTE, NOW + 14 * MINUTE])
    assert.strictEqual(
      nextFullScan({ readAt, plannedAt: NOW, fullScanMinutes: 30, cadenceSeconds, slot }),
      NOW + 27 * MINUTE,
      `${cadenceSeconds}, read at ${readAt - NOW}`
    );
assert.strictEqual(
  nextFullScan({
    readAt: NOW + 40 * MINUTE,
    plannedAt: NOW,
    fullScanMinutes: 60,
    cadenceSeconds: 3600
  }),
  NOW + 54 * MINUTE
);
assert.strictEqual(
  nextFullScan({ readAt: NOW + MINUTE, plannedAt: NOW, fullScanMinutes: 5, cadenceSeconds: 600 }),
  NOW + 4.5 * MINUTE
);
// Without a plannedAt, it is counted from the read.
assert.strictEqual(next(NOW + 3 * MINUTE, 3600), NOW + 30 * MINUTE);
// Hourly runs with IMPORTER_FULL_SCAN_MINUTES=120 read a list at its slot within 2 hours.
assert.strictEqual(next(NOW, 3600, 100 * MINUTE, 120), NOW + 100 * MINUTE);

// After a full read that completed without an error, the next periodic read is scheduled, at the
// list's slot, or the read that confirms the removal of bans left waiting, if that is sooner. A
// poll that found a reason to read the list in full, which was not then read in full without an
// error, leaves it due at once. Anything else keeps the schedule.
const schedule = (extra) =>
  plain(scheduleAfter({ now: NOW, fullScanMinutes: 30, ...extra }) ?? null);
const atSlot = { cadenceSeconds: 600, slot: SLOT };
assert.deepStrictEqual(schedule({ completed: true }), {
  nextFullScanAt: NOW + 27 * MINUTE,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, ...atSlot }), {
  nextFullScanAt: NOW + SLOT,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, confirmAt: NOW + 10 * MINUTE }), {
  nextFullScanAt: NOW + 10 * MINUTE,
  scanReason: 'removal'
});
assert.deepStrictEqual(schedule({ completed: true, ...atSlot, confirmAt: NOW + 5 * MINUTE }), {
  nextFullScanAt: NOW + 5 * MINUTE,
  scanReason: 'removal'
});
assert.deepStrictEqual(schedule({ completed: true, ...atSlot, confirmAt: NOW + 10 * MINUTE }), {
  nextFullScanAt: NOW + SLOT,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, confirmAt: NOW + 31 * MINUTE }), {
  nextFullScanAt: NOW + 27 * MINUTE,
  scanReason: 'periodic'
});
assert.deepStrictEqual(schedule({ completed: true, ...atSlot, trigger: 'drift' }), {
  nextFullScanAt: NOW + SLOT,
  scanReason: 'periodic'
});
for (const trigger of ['drift', 'overflow'])
  assert.deepStrictEqual(schedule({ trigger, ...atSlot }), {
    nextFullScanAt: NOW,
    scanReason: trigger
  });
assert.strictEqual(schedule({}), null);
assert.strictEqual(schedule({ confirmAt: NOW + MINUTE, ...atSlot }), null);
// With runs an interval apart or more, the next periodic read is counted from when the run planned
// its reads, not from the read, so a list read 13.5 minutes into a run every 30 minutes, with
// IMPORTER_FULL_SCAN_MINUTES=30, is due 27 minutes after the run planned its reads: the next run
// reads it in full, also when it plans its reads a few seconds sooner after its start than this
// one did, and a run started by hand 20 minutes after this one only polls it. Counted from the
// read, it would be due 43.5 minutes after the plan, so only every other run would read it in
// full. So with hourly runs and IMPORTER_FULL_SCAN_MINUTES=60, whatever the cadence they are told,
// and with 10-minute cycles and IMPORTER_FULL_SCAN_MINUTES=10.
for (const [cadenceSeconds, fullScanMinutes] of [
  [1800, 30],
  [3600, 60],
  [21600, 60],
  [600, 10]
]) {
  const interval = fullScanMinutes * MINUTE;
  const readAt = NOW + 0.45 * interval;
  const { nextFullScanAt, scanReason } = scheduleAfter({
    now: readAt,
    plannedAt: NOW,
    fullScanMinutes,
    cadenceSeconds,
    slot: SLOT,
    completed: true
  });
  assert.strictEqual(nextFullScanAt, NOW + 0.9 * interval, String(cadenceSeconds));
  const readThen = rowOf({ lastFullScanAt: readAt, nextFullScanAt, scanReason });
  const settings = { cadenceSeconds, fullScanMinutes };
  for (const early of [0, 5 * 1000, 0.09 * interval])
    assert.deepStrictEqual(
      plan(readThen, { now: NOW + interval - early, ...settings }),
      full('periodic'),
      `${cadenceSeconds}, ${early} ms early`
    );
  assert.deepStrictEqual(
    plan(readThen, { now: NOW + 0.66 * interval, ...settings }),
    { read: 'head' },
    `${cadenceSeconds}, by hand`
  );
}
// A list read in full 8 minutes into a cycle that started at its slot is due when its slot comes
// round again, so the cycle that starts 30 minutes after that one reads it, as it would one read
// at the cycle's start, and the cycle 20 minutes after it only polls it.
{
  const readAt = NOW + SLOT + 8 * MINUTE;
  const { nextFullScanAt, scanReason } = scheduleAfter({
    now: readAt,
    fullScanMinutes: 30,
    ...atSlot,
    completed: true
  });
  const readLate = rowOf({ lastFullScanAt: readAt, nextFullScanAt, scanReason });
  const cycle = { cadenceSeconds: 600 };
  assert.deepStrictEqual(plan(readLate, { now: NOW + SLOT + 20 * MINUTE, ...cycle }), {
    read: 'head'
  });
  assert.deepStrictEqual(
    plan(readLate, { now: NOW + SLOT + 30 * MINUTE, ...cycle }),
    full('periodic')
  );
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

// Cycles of the importer service, simulated with the planner as the importer uses it: each cycle
// gives the lists their slots from their rows, plans each list's read planDelay(number)
// milliseconds after its start, 0 unless given, polls the lists not due a full read, then reads the
// others in full one after another, the one read in full longest ago first among those read on
// time, each taking pageSeconds(time) seconds a page, 0.9 unless given, and schedules each one's
// next full read as the read ends, as the list's row then keeps it. Its other steps take 45
// seconds. A cycle that reaches its time limit, maxCycleSeconds after its start, if given, reads
// no more lists, and its last list stops part-way, keeping its row as it was. A cycle starts every
// cycleSeconds, or at once after one that took longer, as the service's do, and gap, if given,
// stops the cycles for gap.minutes once gap.after has passed. The planner is told that runs start
// every cadenceSeconds, cycleSeconds unless given. events(number, start, rows) may change the rows
// before a cycle plans, and return what else that cycle's plans are given: each list's pending
// removals (pending, by list), and the lists IMPORTER_ALLOW_MASS_REMOVAL names (allowMassRemoval).
// A list's sourceKey, if it has one, is its current source. Returns each cycle: when it started and
// ended, whether it stopped at its time limit, and each list it read in full, with why, its pages,
// when the read ended, and when the list was last read in full before.
const PAGE_SECONDS = 0.9;
const POLL_SECONDS = 0.5;
const OTHER_SECONDS = 45;
const HOUR = 60 * MINUTE;
// The lists of production in October 2026, by their bans: 87,193 in all, 881 pages.
const PRODUCTION = [
  7647, 11467, 6443, 2113, 1085, 11773, 9552, 942, 2352, 3795, 3076, 108, 121, 1761, 8569, 2899,
  1873, 9217, 1166, 1234
].map((bans, index) => ({ id: index + 1, bans }));
const pagesFor = ({ bans }) => Math.ceil(bans / 100);
const TOTAL = PRODUCTION.reduce((sum, list) => sum + pagesFor(list), 0);
assert.strictEqual(TOTAL, 881);
// The first simulated cycle starts at a time that is not the start of an interval.
const FIRST = NOW + 9 * MINUTE + 35 * 1000;

function simulate({
  lists = PRODUCTION,
  cycleSeconds = 600,
  cadenceSeconds = cycleSeconds,
  fullScanMinutes = 30,
  hours = 8,
  start = FIRST,
  rows = new Map(),
  gap = null,
  planDelay = () => 0,
  pageSeconds = () => PAGE_SECONDS,
  maxCycleSeconds = Infinity,
  events = () => ({})
}) {
  const cycles = [];
  const until = start + hours * HOUR;
  let paused = false;
  for (let at = start; at < until;) {
    const cycle = { number: cycles.length + 1, start: at, reads: [], stopped: false };
    const extra = events(cycle.number, at, rows) ?? {};
    const slots = fullScanSlots(
      lists.map(({ id }) => ({ id, pages: pagesOf(rows.get(id)) ?? 1 })),
      fullScanMinutes
    );
    const plannedAt = at + planDelay(cycle.number);
    const plans = lists
      .map((list) => ({
        list,
        ...planRead({
          type: 'battlemetrics',
          row: rows.get(list.id) ?? null,
          sourceKey: list.sourceKey ?? KEY,
          pending: extra.pending?.get(list.id) ?? null,
          allowMassRemoval: extra.allowMassRemoval?.has(list.id) ?? false,
          now: plannedAt,
          fullScanMinutes,
          cadenceSeconds
        }),
        lastFullScanAt: rows.get(list.id)?.lastFullScanAt ?? null
      }))
      .sort(compareReads);
    let clock = plannedAt;
    const limit = at + maxCycleSeconds * 1000;
    for (const { list, read, reason } of plans) {
      if (clock >= limit) {
        cycle.stopped = true;
        break;
      }
      if (read === 'head') {
        clock += POLL_SECONDS * 1000;
        continue;
      }
      clock += pagesFor(list) * pageSeconds(clock) * 1000;
      if (clock >= limit) {
        clock = limit;
        cycle.stopped = true;
        break;
      }
      const before = rows.get(list.id);
      cycle.reads.push({
        id: list.id,
        reason,
        pages: pagesFor(list),
        readAt: clock,
        last: before?.lastFullScanAt ?? null
      });
      const { nextFullScanAt, scanReason } = scheduleAfter({
        now: clock,
        plannedAt,
        fullScanMinutes,
        cadenceSeconds,
        slot: slots.get(list.id),
        completed: true
      });
      rows.set(
        list.id,
        rowOf({
          banList: list.id,
          sourceKey: list.sourceKey ?? KEY,
          lastFullScanAt: clock,
          nextFullScanAt,
          scanReason,
          headTotal: list.bans
        })
      );
    }
    cycle.end = cycle.stopped ? clock : clock + OTHER_SECONDS * 1000;
    cycles.push(cycle);
    at = Math.max(at + cycleSeconds * 1000, cycle.end);
    if (gap && !paused && at - start >= gap.after) {
      paused = true;
      at += gap.minutes * MINUTE;
    }
  }
  return cycles;
}
const pagesRead = (cycle, reasons = ['new', 'periodic']) =>
  cycle.reads
    .filter(({ reason }) => reasons.includes(reason))
    .reduce((sum, { pages }) => sum + pages, 0);
// For each list read in full after an earlier full read, how long after that read the cycle that
// read it again started, which a cycle every cycleSeconds keeps within 1.5 intervals.
const waits = (cycles) =>
  cycles.flatMap((cycle) =>
    cycle.reads
      .filter(({ last }) => last !== null)
      .map(({ id, last }) => ({ id, cycle: cycle.number, wait: cycle.start - last }))
  );
const longestWait = (cycles) => Math.max(...waits(cycles).map(({ wait }) => wait));
// The cycles that started at least an interval after the cycle that read every list at once ended.
const settled = (cycles, bunch, after = INTERVAL) =>
  cycles.filter((cycle) => cycle.start >= bunch.end + after);
// Whether each of the cycles read between low and high times its share of all the lists' pages.
function assertEven(cycles, cycleSeconds, low, high, label) {
  const share = (TOTAL * cycleSeconds * 1000) / INTERVAL;
  for (const cycle of cycles) {
    const pages = pagesRead(cycle);
    assert.ok(
      pages >= low * share && pages <= high * share,
      `${label}: cycle ${cycle.number} read ${pages} pages in full, its share being ${share.toFixed(1)}`
    );
  }
}

// From a full bunch, as the first cycle reads every list in full, as each is new, the full reads
// spread out within about an interval, and stay so. With a cycle every 10 minutes, the first cycle
// reads all 881 pages, as production's did, and once an interval has passed after it, each cycle
// reads its share, a third of them, give or take a list: 243 to 331 pages, about 4 to 5.5 minutes of
// requests, rather than all of them every third cycle and none in between. Over each interval
// after, every list is read in full once.
{
  const cycles = simulate({ hours: 8 });
  const [bunch] = cycles;
  assert.deepStrictEqual(
    [bunch.reads.length, pagesRead(bunch), new Set(bunch.reads.map(({ reason }) => reason)).size],
    [20, 881, 1]
  );
  assert.strictEqual(bunch.reads[0].reason, 'new');
  const later = settled(cycles, bunch);
  assert.ok(later.length >= 40, String(later.length));
  assertEven(later, 600, 0.6, 1.4, '10-minute cycles, from an interval after the bunch');
  const steady = settled(cycles, bunch, 2 * INTERVAL);
  assertEven(steady, 600, 0.8, 1.2, '10-minute cycles, settled');
  for (const cycle of steady.slice(0, -3)) {
    const interval = steady.filter(
      ({ start }) => start >= cycle.start && start < cycle.start + INTERVAL
    );
    assert.deepStrictEqual(
      interval.flatMap(({ reads }) => reads.map(({ id }) => id)).sort((a, b) => a - b),
      PRODUCTION.map(({ id }) => id),
      `the interval from cycle ${cycle.number}`
    );
  }
  // Each cycle takes a few minutes, well under the 15-minute time limit, and starts on time.
  for (const cycle of settled(cycles, bunch, 0)) assert.ok(cycle.end - cycle.start < 7 * MINUTE);
  // No list waits longer than 1.5 intervals for its next full read.
  assert.ok(longestWait(cycles) <= 1.5 * INTERVAL, String(longestWait(cycles) / MINUTE));
}

// The same with a cycle every 2 minutes or every minute, as the service may run later, and with a
// cycle every 15 or 20 minutes: once an interval has passed after the bunch, no cycle reads more
// than the largest list, 118 pages, beyond its share, and every list is read in full within each
// 1.5 intervals. Once two intervals have passed, the cycles of every interval read all the lists'
// pages once, give or take the largest list, for the cycle lengths an interval holds a whole number
// of.
for (const cycleSeconds of [60, 120, 900, 1200]) {
  const cycles = simulate({ cycleSeconds, hours: 6 });
  const [bunch] = cycles;
  const share = (TOTAL * cycleSeconds * 1000) / INTERVAL;
  for (const cycle of settled(cycles, bunch))
    assert.ok(pagesRead(cycle) <= share + 118, `${cycleSeconds}: cycle ${cycle.number}`);
  const steady = settled(cycles, bunch, 2 * INTERVAL);
  for (const cycle of INTERVAL % (cycleSeconds * 1000) === 0 ? steady : []) {
    if (cycle.start + INTERVAL > steady.at(-1).start) break;
    const pages = steady
      .filter(({ start }) => start >= cycle.start && start < cycle.start + INTERVAL)
      .reduce((sum, other) => sum + pagesRead(other), 0);
    assert.ok(
      Math.abs(pages - TOTAL) <= 118,
      `${cycleSeconds}: ${pages} pages from ${cycle.number}`
    );
  }
  // Cycles every minute or two overrun their cadence while they read a large list, which delays
  // the next ones, so allow for the longest such overrun on top of the 1.5 intervals.
  const overrun = Math.max(
    0,
    ...cycles.slice(1).map((cycle) => cycle.end - cycle.start - cycleSeconds * 1000)
  );
  assert.ok(
    longestWait(cycles) <= 1.5 * INTERVAL + overrun,
    `${cycleSeconds}: ${longestWait(cycles) / MINUTE} minutes`
  );
}

// After a restart, the lists keep their slots, so the first cycle of the new process reads only the
// lists whose slots came since the last cycle, and the cycles stay even. After a long gap, every
// list is due at once, so the first cycle after it reads every list in full, and an interval after
// that, the full reads are spread out again.
{
  const restarted = simulate({ hours: 8, gap: { after: 3 * HOUR, minutes: 3 } });
  const [bunch] = restarted;
  const afterRestart = restarted.find(({ start }) => start >= FIRST + 3 * HOUR + 3 * MINUTE);
  const share = (TOTAL * 600 * 1000) / INTERVAL;
  // That cycle comes 13 minutes after the one before, so it reads up to 13 minutes' worth.
  assert.ok(pagesRead(afterRestart) <= 1.3 * share * 1.4, String(pagesRead(afterRestart)));
  assertEven(
    settled(restarted, bunch).filter((cycle) => cycle !== afterRestart),
    600,
    0.6,
    1.4,
    'after a restart'
  );

  const cycles = simulate({ hours: 10, gap: { after: 3 * HOUR, minutes: 120 } });
  const resumed = cycles.find(({ start }) => start >= FIRST + 5 * HOUR);
  assert.deepStrictEqual(
    [resumed.reads.length, pagesRead(resumed), resumed.reads[0].reason],
    [20, 881, 'periodic']
  );
  assertEven(settled(cycles, resumed), 600, 0.6, 1.4, 'after a long gap');
  assert.ok(
    longestWait(cycles.filter(({ start }) => start > resumed.start)) <= 1.5 * INTERVAL,
    'after a long gap'
  );
}

// The reasons to read a list in full now never wait for its slot: a removal due to be confirmed,
// an admin's allowFullRemovalUntil while bans are held, IMPORTER_ALLOW_MASS_REMOVAL, drift or
// overflow a poll found, a new source, a source still being replaced, and a list never read in full
// are all read in the cycle that finds them, wherever their slots. Afterwards, each list is due at
// its slot again.
{
  const triggered = new Map([
    [2, 'removal'],
    [3, 'removal'],
    [4, 'removal'],
    [5, 'drift'],
    [6, 'overflow'],
    [7, 'source'],
    [8, 'source'],
    [9, 'new']
  ]);
  const lists = PRODUCTION.map((list) => ({ ...list }));
  let at = null;
  const cycles = simulate({
    lists,
    hours: 6,
    // From the 20th cycle on, in the first cycle in which none of these lists is due its periodic
    // full read.
    events: (number, start, rows) => {
      if (number < 20 || at !== null) return {};
      const row = (id) => rows.get(id);
      const ids = [...triggered.keys()];
      if (ids.some((id) => row(id).nextFullScanAt <= start)) return {};
      at = start;
      Object.assign(row(3), {
        state: 'held',
        allowFullRemovalUntil: new Date(start + HOUR)
      });
      Object.assign(row(5), { scanReason: 'drift', nextFullScanAt: start - 1000 });
      Object.assign(row(6), { scanReason: 'overflow', nextFullScanAt: start - 1000 });
      lists[6].sourceKey = 'n'.repeat(64);
      Object.assign(row(8), { replacePending: 1 });
      rows.delete(9);
      return {
        pending: new Map([
          [2, { confirmAt: start - 1000, held: 0 }],
          [3, { confirmAt: null, held: 4 }]
        ]),
        allowMassRemoval: new Set([4])
      };
    }
  });
  const cycle = cycles.find(({ start }) => start === at);
  for (const [id, reason] of triggered)
    assert.deepStrictEqual(
      cycle.reads.filter((read) => read.id === id).map((read) => read.reason),
      [reason],
      String(id)
    );
  // The next time each is read in full, it is at its slot again, as the others are.
  const after = cycles.filter(({ start }) => start > at);
  for (const id of triggered.keys())
    assert.deepStrictEqual(
      [
        ...new Set(
          after.flatMap(({ reads }) =>
            reads.filter((read) => read.id === id).map(({ reason }) => reason)
          )
        )
      ],
      ['periodic'],
      String(id)
    );
  assertEven(
    settled(
      cycles,
      cycles.find(({ start }) => start === at)
    ),
    600,
    0.6,
    1.4,
    'after'
  );
}

// Runs an interval apart or more read every list in full on every run, however late in its run each
// list was read, as before slots: runs every 30 minutes with IMPORTER_FULL_SCAN_MINUTES=30, or a
// little more, every hour with 60, whether they are told a cadence of an hour or of 6 hours, and
// cycles every 10 minutes with 5 or 10, which take longer than that when they read every list. So
// do runs that plan their reads a few seconds sooner after their start than the run before.
for (const [cycleSeconds, cadenceSeconds, fullScanMinutes] of [
  [1800, 1800, 30],
  [1830, 1830, 30],
  [2100, 2100, 30],
  [3600, 3600, 60],
  [3600, 21600, 60],
  [600, 600, 10],
  [600, 600, 5]
]) {
  const which = `runs every ${cycleSeconds} s, told ${cadenceSeconds} s, ${fullScanMinutes} minutes`;
  const cycles = simulate({
    cycleSeconds,
    cadenceSeconds,
    fullScanMinutes,
    hours: 12,
    planDelay: (number) => (number % 2 === 1 ? 3000 : 0)
  });
  assert.ok(cycles.length >= 6, which);
  for (const cycle of cycles)
    assert.deepStrictEqual(
      cycle.reads.map(({ id }) => id).sort((a, b) => a - b),
      PRODUCTION.map(({ id }) => id),
      `${which}: run ${cycle.number}`
    );
}

// When cycles keep stopping at their time limit before they have read every list that is due, as
// here for 3 hours, with pages taking 2.8 seconds each, the lists one cycle leaves are read first by
// the next, so every list is still read in full at least 3 times in those hours, and none waits
// more than an hour, rather than the lists with the highest IDs waiting for the 3 hours, as they
// would in the order of their IDs. Once BattleMetrics is fast again, the reads spread out again.
{
  const slowFrom = FIRST + 2 * HOUR;
  const slowUntil = FIRST + 5 * HOUR;
  const cycles = simulate({
    hours: 9,
    maxCycleSeconds: 900,
    pageSeconds: (time) => (time >= slowFrom && time < slowUntil ? 2.8 : PAGE_SECONDS)
  });
  const slow = cycles.filter(({ start }) => start >= slowFrom && start < slowUntil);
  const stopped = slow.filter((cycle) => cycle.stopped).length;
  assert.ok(stopped >= slow.length / 2, `${stopped} of ${slow.length}`);
  for (const { id } of PRODUCTION)
    assert.ok(
      slow.filter(({ reads }) => reads.some((read) => read.id === id)).length >= 3,
      `list ${id}`
    );
  assert.ok(longestWait(cycles) <= HOUR, String(longestWait(cycles) / MINUTE));
  assertEven(
    cycles.filter(({ start }) => start >= slowUntil + 2 * INTERVAL),
    600,
    0.6,
    1.4,
    'after the slow hours'
  );
}

// Once mode is unchanged: with runs every 6 hours, longer apart than IMPORTER_FULL_SCAN_MINUTES,
// every run reads every list in full, and a run started by hand 5 minutes after one only polls them.
{
  const cycles = simulate({ cycleSeconds: 21600, hours: 48 });
  assert.strictEqual(cycles.length, 8);
  for (const cycle of cycles) assert.strictEqual(cycle.reads.length, 20, String(cycle.number));
  const rows = new Map();
  simulate({ cycleSeconds: 21600, hours: 1, rows });
  const byHand = simulate({ cycleSeconds: 21600, hours: 1, rows, start: FIRST + 20 * MINUTE });
  assert.deepStrictEqual(byHand[0].reads, []);
}

// Runs every hour with IMPORTER_FULL_SCAN_MINUTES=120, as the README suggests, read each list in
// full on every other run, about half of the pages each run, rather than all of them every other
// run.
{
  const cycles = simulate({ cycleSeconds: 3600, fullScanMinutes: 120, hours: 24 });
  for (const cycle of cycles.slice(3)) {
    const pages = pagesRead(cycle);
    assert.ok(pages >= 0.25 * TOTAL && pages <= 0.75 * TOTAL, `run ${cycle.number}: ${pages}`);
  }
}

console.log(
  "Planner checks passed: IMPORTER_FULL_SCAN_MINUTES, the newest bans a row keeps, which lists are read in full and why, the order of reads, the lists' slots and when the next full read is due, what a head poll finds about drift and overflow, and simulated cycles: full reads spread out after a bunch and stay even at any cycle length, within 1.5 intervals, the reasons that do not wait, runs an interval apart or more reading every list, the oldest first when cycles stop at their time limit, and once mode."
);
