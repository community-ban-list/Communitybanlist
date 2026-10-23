// Which ban lists a run reads in full and which it only polls, and when each list's next full read
// is due. A head poll reads a BattleMetrics list's newest page of bans, newest first, with
// BattleMetrics' count of the list's bans. It saves the new and changed bans on it but never
// removes any, as only a read of every page can show that a ban is gone. A list is read in full
// when one of the reasons below applies, and otherwise polled, so a run in which nothing is due
// makes one request a list. ban-importer.js reads and saves the lists; this works out what to do,
// without the database or BattleMetrics.
//
// This file has no imports, so it can be loaded on its own.

// Why a list is read in full, the most urgent first.
export const REASONS = {
  // There is no complete read of the list's current source to poll it against: it is new, has
  // never been read in full, or was last read with head polls off.
  NEW: 'new',
  // Its type or source was changed, so its old source's bans are being replaced.
  SOURCE: 'source',
  // Bans it no longer had wait for a later complete read to confirm that they are gone, and one is
  // due, or an admin allowed it to lose bans, which a complete read applies.
  REMOVAL: 'removal',
  // BattleMetrics' count of its bans no longer matches its count at its last read plus the new bans
  // on its newest page: a ban was removed, or added or moved below its newest page.
  DRIFT: 'drift',
  // Its newest pages held only new bans, more than a head poll follows.
  OVERFLOW: 'overflow',
  // Its periodic full read is due, at its slot in IMPORTER_FULL_SCAN_MINUTES (see nextFullScan), or
  // its last full read is older than a list may wait (see latestFullScan).
  PERIODIC: 'periodic',
  // Head polls are off, so every list is read in full on every run.
  EVERY_RUN: 'every_run',
  // A remote list's file is asked about on every run, as it is all read at once.
  REMOTE: 'remote'
};

// The order in which lists are read in full, by their reasons: new or changed sources first, then
// removals to confirm, drift, overflow, and the periodic reads last.
const PRIORITY = {
  [REASONS.NEW]: 0,
  [REASONS.SOURCE]: 0,
  [REASONS.REMOVAL]: 1,
  [REASONS.DRIFT]: 2,
  [REASONS.OVERFLOW]: 3,
  [REASONS.PERIODIC]: 4,
  [REASONS.EVERY_RUN]: 4,
  [REASONS.REMOTE]: 4
};

// The reasons a head poll can find, which are kept in a list's row until a full read is made.
const TRIGGERS = [REASONS.REMOVAL, REASONS.DRIFT, REASONS.OVERFLOW];

// By default a list is read in full every 30 minutes, at a time of its own in each 30 minutes, its
// slot, so that the lists' full reads are spread over the runs by their pages (see fullScanSlots).
// IMPORTER_FULL_SCAN_MINUTES changes it, to at most a week.
export const DEFAULT_FULL_SCAN_MINUTES = 30;
const MAX_FULL_SCAN_MINUTES = 7 * 24 * 60;
const MINUTE = 60 * 1000;

// BattleMetrics gives a list's bans 100 to a page, so a read of all of a list takes a request for
// about every 100 of its bans.
export const PAGE_SIZE = 100;

// A list's row keeps the IDs of the bans on its newest page, at most a page of them.
export const MAX_HEAD_UIDS = 100;

// A head poll whose page holds only bans it has not seen follows the list's pages, newest first,
// until it reaches one it has seen, for at most this many pages in all, e.g. after a burst of new
// bans. A list with more new bans than that is read in full (overflow).
export const MAX_HEAD_PAGES = 10;

// Read IMPORTER_FULL_SCAN_MINUTES: a whole number of minutes from 1 to a week. A setting that is
// not given is the default, and an invalid one is too, with a warning to log.
export function readFullScanMinutes(value) {
  const setting = String(value ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim();
  if (setting === '') return { minutes: DEFAULT_FULL_SCAN_MINUTES };
  const minutes = Number(setting);
  if (/^\d+$/.test(setting) && minutes >= 1 && minutes <= MAX_FULL_SCAN_MINUTES) return { minutes };
  return {
    minutes: DEFAULT_FULL_SCAN_MINUTES,
    invalid: true,
    warning: `Warning: IMPORTER_FULL_SCAN_MINUTES must be a whole number from 1 to ${MAX_FULL_SCAN_MINUTES}, not "${value}", so lists are read in full every ${DEFAULT_FULL_SCAN_MINUTES} minutes.`
  };
}

// A time to compare, in milliseconds since 1970, or null for none or an invalid one. MySQL's
// DATETIME columns come back as Dates, and text in their format is read as UTC.
function timeOf(value) {
  if (value === null || value === undefined) return null;
  let time;
  if (typeof value.getTime === 'function') time = value.getTime();
  else if (typeof value === 'number') time = value;
  else {
    const text = String(value).trim();
    time = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
      ? Date.parse(`${text.replace(' ', 'T')}Z`)
      : Date.parse(text);
  }
  return Number.isFinite(time) ? time : null;
}

// The IDs of the bans on a list's newest page at its last read, as its row keeps them, as JSON, or
// null when the row has none, or something else.
export function readHeadUids(value) {
  if (typeof value !== 'string') return null;
  let uids;
  try {
    uids = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(uids) || uids.length > MAX_HEAD_UIDS) return null;
  return uids.every((uid) => typeof uid === 'string' && uid !== '') ? uids : null;
}

// The IDs of the bans on a list's newest page, for its row to keep: each once, in order.
export function writeHeadUids(uids) {
  return JSON.stringify([...new Set(uids)].slice(0, MAX_HEAD_UIDS));
}

// Whether a complete read of a list would now remove bans that wait for one: a ban it no longer had
// is due to be confirmed as gone, or an admin allowed it to lose bans. pending gives when the first
// of the bans that wait for a confirming read is due (confirmAt), in milliseconds, or null, and how
// many bans are held for an admin (held), from BanListPendingRemovals.
function removalDue({ row, pending, allowMassRemoval, now }) {
  if (allowMassRemoval) return true;
  // A list CBL cannot read is never swept, so a read would confirm nothing.
  if (row.state === 'access_lost') return false;
  const confirmAt = pending?.confirmAt ?? null;
  if (confirmAt !== null && confirmAt <= now) return true;
  const allowedUntil = timeOf(row.allowFullRemovalUntil);
  return pending?.held > 0 && allowedUntil !== null && allowedUntil > now;
}

// Decide how a list is read this run, from:
// - type: its type, battlemetrics or remote;
// - row: its BanListSyncs row from before the run, or null;
// - sourceKey: the key of its current type and source;
// - pending: when its first ban that waits for a confirming read is due (confirmAt) and how many of
//   its bans are held for an admin (held), or null when it has none;
// - allowMassRemoval: whether IMPORTER_ALLOW_MASS_REMOVAL names it;
// - now, in milliseconds;
// - headPoll: whether head polls are on;
// - fullScanMinutes: IMPORTER_FULL_SCAN_MINUTES;
// - cadenceSeconds: how often runs start, or null when it is not known.
// Returns { read: 'head' } to poll its newest page, or { read: 'full', reason } to read it in full,
// with the most urgent of the reasons that apply. A list is due its periodic full read once its
// row's nextFullScanAt has passed, or it has none, or once its last full read is older than a list
// may wait (see latestFullScan), so a run every few hours reads every list in full, as runs did
// before head polls. The other reasons do not wait for a list's slot: each is due at once.
export function planRead({
  type,
  row = null,
  sourceKey,
  pending = null,
  allowMassRemoval = false,
  now,
  headPoll = true,
  fullScanMinutes = DEFAULT_FULL_SCAN_MINUTES,
  cadenceSeconds = null
}) {
  const full = (reason) => ({ read: 'full', reason });
  if (row && row.sourceKey !== sourceKey) return full(REASONS.SOURCE);
  if (row && Boolean(Number(row.replacePending))) return full(REASONS.SOURCE);
  const lastFullScanAt = timeOf(row?.lastFullScanAt);
  if (!row || lastFullScanAt === null) return full(REASONS.NEW);
  if (removalDue({ row, pending, allowMassRemoval, now })) return full(REASONS.REMOVAL);
  if (type !== 'battlemetrics') return full(REASONS.REMOTE);

  // A reason a head poll found, kept until the list is read in full, is due at once.
  const nextFullScanAt = timeOf(row.nextFullScanAt);
  const due = nextFullScanAt === null || nextFullScanAt <= now;
  if (due && TRIGGERS.includes(row.scanReason)) return full(row.scanReason);
  if (due || lastFullScanAt <= now - latestFullScan(fullScanMinutes, cadenceSeconds))
    return full(REASONS.PERIODIC);
  if (!headPoll) return full(REASONS.EVERY_RUN);

  // A head poll compares the list's newest page with the one its last read saw, and BattleMetrics'
  // count with the one it gave then.
  if (readHeadUids(row.headUids) === null || !Number.isInteger(Number(row.headTotal ?? NaN)))
    return full(REASONS.NEW);
  return { read: 'head' };
}

// The order in which a run reads its lists, for sorting them: head polls first, so the new bans of
// lists that are only polled are saved within seconds of the start, then the lists read in full,
// the most urgent first. Lists of the same kind keep the order they were found in, as the sort
// keeps it.
export function compareReads(a, b) {
  const rank = (plan) => (plan.read === 'head' ? -1 : (PRIORITY[plan.reason] ?? 5));
  return rank(a) - rank(b);
}

// What a head poll's pages say, once read. pages are the pages read, newest first, each with the
// IDs of all of its bans (uids), with or without a SteamID, BattleMetrics' count of the list's bans
// on it (total) and whether another page follows (next). known has the IDs of the bans seen before:
// on the list's newest page at its last read, or stored. previousTotal is BattleMetrics' count at
// the list's last read, and drift whether the counts are compared. Returns:
// - complete: the pages reach the list's last page, so they are all of it;
// - overflow: they hold only new bans, but more pages follow, and as many were read as a head poll
//   follows, so the list is read in full;
// - newBans: how many different bans on them are new;
// - drift: when the count on the first page is not the one at the last read plus the new bans, it
//   and the count expected, { total, expected }, and otherwise null. Bans added on top of the list
//   only add to both, so any other difference means a ban was removed, or added or moved below the
//   pages read, which only a full read finds. Counts and IDs are BattleMetrics' own, with or without
//   a SteamID, so bans without one, which are never stored, make no difference. A list whose count
//   is missing cannot be compared.
export function checkHead({
  pages,
  known,
  previousTotal,
  drift = true,
  maxPages = MAX_HEAD_PAGES
}) {
  const last = pages.at(-1);
  const complete = !last.next;
  const fresh = new Set();
  for (const page of pages) for (const uid of page.uids) if (!known.has(uid)) fresh.add(uid);
  const overflow =
    !complete && pages.length >= maxPages && !last.uids.some((uid) => known.has(uid));

  const { total } = pages[0];
  const before = Number(previousTotal ?? NaN);
  let difference = null;
  if (drift && !complete && !overflow && Number.isInteger(total) && Number.isInteger(before)) {
    const expected = before + fresh.size;
    if (total !== expected) difference = { total, expected };
  }
  return { complete, overflow, newBans: fresh.size, drift: difference };
}

// Whether a head poll should read the page after the last one it read: that page holds only bans
// it has not seen, another page follows, and it has read fewer pages than it may.
export function shouldFollow(pages, known, maxPages = MAX_HEAD_PAGES) {
  const last = pages.at(-1);
  return Boolean(last.next) && pages.length < maxPages && !last.uids.some((uid) => known.has(uid));
}

// How many pages a read of all of a list takes, about, by its row: BattleMetrics' count of its bans
// at its last read, or else the bans it has here, a page for every 100 of them, and at least one.
// null for a list without a row, or whose row has neither count.
export function pagesOf(row) {
  for (const value of [row?.headTotal, row?.storedCount]) {
    const count = Number(value ?? NaN);
    if (Number.isInteger(count) && count >= 0) return Math.max(1, Math.ceil(count / PAGE_SIZE));
  }
  return null;
}

// Each BattleMetrics list's slot: when in each IMPORTER_FULL_SCAN_MINUTES its periodic full read
// falls due, in milliseconds from the start of the interval. Intervals are counted from midnight UTC
// on 1 January 1970, so every run finds the same slots, whenever it starts. The lists, in the order
// of their IDs, share the interval in proportion to how many pages a read of all of each takes
// (pages, see pagesOf), and each list's slot is the middle of its share. So the lists whose slots
// fall in any stretch of the interval, such as the time between two cycles of the importer service,
// take about that stretch's share of all the lists' pages, whatever the stretch, though a list is
// always read whole: a large list's read falls in one stretch, and the stretches next to it get
// less. A list that grows or shrinks moves the slots after it by little. lists is [{ id, pages }].
// Returns the slots, by list ID.
export function fullScanSlots(lists, fullScanMinutes) {
  const interval = fullScanMinutes * MINUTE;
  const shares = [...lists]
    .map(({ id, pages }) => ({ id, pages: Math.max(1, Number(pages) || 1) }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const total = shares.reduce((sum, { pages }) => sum + pages, 0);
  const slots = new Map();
  let before = 0;
  for (const { id, pages } of shares) {
    slots.set(id, Math.floor(((before + pages / 2) / total) * interval));
    before += pages;
  }
  return slots;
}

// How often runs start, in milliseconds, from cadenceSeconds, or Infinity when it is not known.
function cadenceOf(cadenceSeconds) {
  return Number.isFinite(cadenceSeconds) && cadenceSeconds > 0 ? cadenceSeconds * 1000 : Infinity;
}

// How long after its last full read a list may wait for its next one, in milliseconds. With runs
// starting every cadenceSeconds, up to half of IMPORTER_FULL_SCAN_MINUTES apart, it is 1.5 times
// IMPORTER_FULL_SCAN_MINUTES less a cadence, so the run that starts next once the list is due
// starts within 1.5 times IMPORTER_FULL_SCAN_MINUTES of its last full read. With runs further
// apart, or a cadence that is not known, it is IMPORTER_FULL_SCAN_MINUTES, as before slots.
export function latestFullScan(fullScanMinutes, cadenceSeconds = null) {
  const interval = fullScanMinutes * MINUTE;
  return interval + interval / 2 - Math.min(cadenceOf(cadenceSeconds), interval / 2);
}

// When a list read in full at readAt is next due to be read in full, in milliseconds:
// - with runs less than IMPORTER_FULL_SCAN_MINUTES apart, at its slot (see fullScanSlots), the one
//   in the IMPORTER_FULL_SCAN_MINUTES up to latestFullScan after readAt. A list read in the run that
//   started next after its slot, even minutes into that run, is then due at the same slot an
//   interval later. After a run that read many lists in full at once, e.g. the first, or the first
//   after a long gap, each is due at its own slot, some sooner than an interval later and some
//   later, though never at once, nor sooner than half an interval less a cadence after its read,
//   so within an interval their full reads are spread over the runs again;
// - with runs at least IMPORTER_FULL_SCAN_MINUTES apart, such as every 6 hours, or a cadence or slot
//   that is not known, IMPORTER_FULL_SCAN_MINUTES after readAt, as every such run reads every list
//   in full anyway.
export function nextFullScan({ readAt, fullScanMinutes, cadenceSeconds = null, slot = null }) {
  const interval = fullScanMinutes * MINUTE;
  if (cadenceOf(cadenceSeconds) >= interval || !Number.isFinite(slot)) return readAt + interval;
  const latest = readAt + latestFullScan(fullScanMinutes, cadenceSeconds);
  return latest - ((((latest - slot) % interval) + interval) % interval);
}

// The schedule to save in a BattleMetrics list's row after an attempt at it, which ended at now, as
// { nextFullScanAt, scanReason }, or undefined to keep the one it has:
// - after a full read that completed without an error, the next periodic one (see nextFullScan),
//   counted from now, which the row keeps as when the list was last read in full, or, when bans it
//   no longer had wait for a confirming read, the time the first of them is due (confirmAt), if
//   that is sooner. cadenceSeconds and slot are as for nextFullScan;
// - after a head poll that found a reason to read the list in full (trigger), when the read in full
//   did not complete without an error, at once, with that reason, so the next run reads it in full;
// - after anything else, as it was. A list whose full read failed is still due one.
export function scheduleAfter({
  now,
  fullScanMinutes,
  cadenceSeconds = null,
  slot = null,
  completed = false,
  confirmAt = null,
  trigger = null
}) {
  if (completed) {
    const periodic = nextFullScan({ readAt: now, fullScanMinutes, cadenceSeconds, slot });
    return confirmAt !== null && confirmAt < periodic
      ? { nextFullScanAt: confirmAt, scanReason: REASONS.REMOVAL }
      : { nextFullScanAt: periodic, scanReason: REASONS.PERIODIC };
  }
  if (trigger) return { nextFullScanAt: now, scanReason: trigger };
  return undefined;
}
