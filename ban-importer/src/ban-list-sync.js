import { createHash } from 'crypto';

import { readBattlemetricsPages } from 'scbl-lib/apis';
import { normaliseBattlemetricsID } from 'scbl-lib/utils';

// The state of each ban list's import, which the importer keeps between runs in the list's
// BanListSyncs row, and the checks that set it: whether CBL can still read a list on BattleMetrics,
// and whether a list imports one of CBL's own export ban lists. This works out each list's new row
// and the alerts it calls for, without the database; ban-importer.js reads and writes the rows.

// The states of a list's import.
export const STATES = {
  // Its latest import went as it should.
  OK: 'ok',
  // Its latest import failed, e.g. as its source was down.
  FAILING: 'failing',
  // CBL cannot read it on BattleMetrics, or BattleMetrics does not list it among the ban lists the
  // CBL organisation can see, so none of its bans are removed.
  ACCESS_LOST: 'access_lost',
  // Its source is one of CBL's own export ban lists, so it is neither imported nor swept.
  SELF_IMPORT: 'self_import',
  // It was imported, but some of the bans it no longer has were kept for now: until a later
  // complete read of the list confirms that they are gone, or, for a list that lost all of its
  // bans, until an admin confirms it.
  HELD: 'held'
};

// A list that fails to import this many runs in a row is posted about, once.
export const FAILURE_ALERT_RUNS = 3;

// When at least this many lists lose access in the same run, and they are at least half of the
// BattleMetrics lists the run tried, CBL's own BattleMetrics token, or its role in the CBL
// organisation, is a likelier cause than the lists' owners, so they are posted about together.
const WIDESPREAD_LISTS = 3;

// Why the access check says CBL cannot read a list.
export const NOT_VISIBLE =
  'its source is not among the BattleMetrics ban lists the CBL organisation can see';

// Why a list CBL had lost access to is still taken to have lost it: the run could not tell, as its
// access check could not be made or the list's fetch failed for another reason, e.g. as
// BattleMetrics was down. Only a list whose row says CBL had lost access to it is given this.
export const UNCONFIRMED =
  'CBL had lost access to it, and this run could not tell whether it has access again';

// BanListSyncs.lastError holds at most this many characters.
const MAX_ERROR_LENGTH = 500;

// The error title BattleMetrics answers HTTP 404 with for a ban list it does not know, or does not
// let CBL see.
const UNKNOWN_BAN_LIST = /unknown ban ?list/i;

// A list's row as it starts: for a list imported for the first time, or whose type or source was
// changed, as nothing known about its old source applies to its new one.
const FRESH = Object.freeze({
  state: STATES.OK,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastHeadPollAt: null,
  lastFullScanAt: null,
  nextFullScanAt: null,
  scanReason: null,
  consecutiveFailures: 0,
  incompleteScans: 0,
  lastError: null,
  storedCount: null,
  headTotal: null,
  headUids: null,
  replacePending: false,
  allowFullRemovalUntil: null,
  remoteEtag: null,
  remoteLastModified: null,
  remoteBodyHash: null
});

// A count written with thousands separators, e.g. 4,376.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

function plural(count, noun) {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// A setting's value without the spaces around it, or one pair of matching quotes around it, as
// docker run --env-file keeps quotes as part of the value. Anything else, such as a comment after
// the value, is left in it.
export function unquote(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim();
}

// Read a setting that is turned on with 1, true, on or yes, and off with 0, false, off or no, in any
// case, with spaces or quotes around it. A setting that is not given is as defaultOn says, and an
// invalid value is as invalidOn says, the safer of the two, marked invalid, with a warning to log
// that says what that means.
export function readSwitch(name, value, { defaultOn, invalidOn = defaultOn, meaning }) {
  if (typeof value === 'boolean') return { on: value };
  const setting = unquote(value).toLowerCase();
  if (setting === '') return { on: defaultOn };
  if (['1', 'true', 'on', 'yes'].includes(setting)) return { on: true };
  if (['0', 'false', 'off', 'no'].includes(setting)) return { on: false };
  return {
    on: invalidOn,
    invalid: true,
    warning: `Warning: ${name} must be 1 or 0, not "${value}", so ${meaning}.`
  };
}

// Read a setting that names ban lists by their IDs, separated by commas, with spaces or quotes
// around it, and give the IDs, as text.
export function readBanListIDs(value) {
  return new Set(
    unquote(value)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

// Read IMPORTER_ACCESS_CHECK, which turns the access check off when it is 0, false, off or no. It is
// on when the setting is not given, and an invalid value leaves it on, with a warning to log.
export function readAccessCheck(value) {
  return readSwitch('IMPORTER_ACCESS_CHECK', value, {
    defaultOn: true,
    meaning: 'the access check stays on'
  });
}

// The IDs of every BattleMetrics ban list the CBL organisation can see, its own and those it
// subscribes to, as normaliseBattlemetricsID writes them. Throws if any page cannot be read, or has
// a ban list without an ID.
export async function readVisibleBanLists() {
  const ids = new Set();
  for (const banList of await readBattlemetricsPages('ban-lists')) {
    const id = normaliseBattlemetricsID(banList?.id);
    if (id === '') throw new Error('BattleMetrics returned a ban list without an ID.');
    ids.add(id);
  }
  return ids;
}

// A SHA-256 of a list's type and source, by which its row tells that its source was changed since
// the row was written.
export function sourceKey({ type, source }) {
  return createHash('sha256')
    .update(JSON.stringify([type ?? null, source ?? null]))
    .digest('hex');
}

// A problem with a list as its row keeps it: on one line, without any address, as a remote list's
// address may hold a key, and in printable ASCII, which a column in any character set can hold, cut
// to 500 characters. Each word that holds an address is replaced as a whole. Going word by word,
// rather than searching for addresses with one pattern, keeps this quick for any text, as the text
// can come from a server.
export function cleanError(text) {
  const clean = String(text)
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (word.includes('://') ? '[address]' : word))
    .join(' ')
    .replace(/[^\x20-\x7e]/gu, '?');
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH - 3)}...` : clean;
}

// Why an error from fetching a BattleMetrics list means that CBL can no longer read it, or null if
// it does not. BattleMetrics answers HTTP 404, Unknown ban list, for a list it does not let CBL see.
// For a list CBL may see but not its bans, it gives no bans but still counts them, which the
// fetcher fails as hidden bans, as the list has not really emptied.
export function accessProblem(err) {
  if (err?.bansHidden)
    return `BattleMetrics counts ${plural(err.metaTotal, 'ban')} on it but gave none of them`;
  const status = err?.status ?? err?.response?.status;
  const titles = Array.isArray(err?.titles) ? err.titles : [];
  if (status === 404 && titles.some((title) => UNKNOWN_BAN_LIST.test(title)))
    return 'BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list)';
  return null;
}

// A list's state after an attempt at it, by what the attempt found, the most important first.
export function stateOf({ selfImport, accessLost, error, held }) {
  if (selfImport) return STATES.SELF_IMPORT;
  if (accessLost) return STATES.ACCESS_LOST;
  if (error) return STATES.FAILING;
  if (held > 0) return STATES.HELD;
  return STATES.OK;
}

// Work out a list's new row from its row as the run found it (before, or null for a list that has
// none) and what the run's attempt at the list found (outcome): the list's ID and source key, the
// time, the export ban list it imports (selfImport), why CBL cannot read it (accessLost), the
// attempt's error, the bans it held, the bans the list has here, BattleMetrics' count of its bans,
// or undefined when the attempt got none, whether the attempt read all of the list (complete: true
// or false, or undefined when it did not get that far), whether the bans of the list's old source
// are still to be replaced (replacePending, or undefined to keep it), and for a remote list, the
// ETag, Last-Modified and SHA-256 of the file to keep (remote, or undefined to keep them). Returns:
// - values: the row's new values;
// - fields: the columns to write. A list whose type or source was changed starts afresh, so all
//   of its columns are written, and otherwise only those the import sets;
// - alerts: what to post about the list: starting to import a CBL export ban list, or losing
//   access, each only when it starts, so never again while the list stays so; and failing
//   FAILURE_ALERT_RUNS runs in a row, when it reaches that, or when it starts failing with more,
//   as after a run in which it imported a CBL export ban list;
// - recovered: why the list is back to normal, if it is;
// - previous: the row it was worked out from, as it starts afresh for a new or changed source.
// A list whose source is a CBL export ban list is never fetched, so its attempt neither fails nor
// succeeds. A list CBL is still taken to have lost access to (UNCONFIRMED) keeps why it lost it.
// A run's second attempt at a list is worked out from the same row as its first, so the run counts
// once.
export function nextSync(before, outcome) {
  const reset = !before || before.sourceKey !== outcome.sourceKey;
  const previous = reset ? FRESH : before;
  const state = stateOf(outcome);
  const attempted = state !== STATES.SELF_IMPORT;
  const failed = attempted && Boolean(outcome.error);

  let consecutiveFailures = previous.consecutiveFailures;
  if (failed) consecutiveFailures++;
  else if (attempted) consecutiveFailures = 0;

  let lastError = null;
  if (outcome.accessLost === UNCONFIRMED) lastError = previous.lastError;
  else if (failed) lastError = cleanError(outcome.error);
  else if (outcome.accessLost)
    lastError = cleanError(
      `${outcome.accessLost[0].toUpperCase()}${outcome.accessLost.slice(1)}, so its bans are not checked for removal.`
    );

  // How many reads of all of the list in a row came back incomplete, which a complete one resets.
  let incompleteScans = Number(previous.incompleteScans) || 0;
  if (outcome.complete === false) incompleteScans++;
  else if (outcome.complete === true) incompleteScans = 0;

  const values = {
    ...(reset ? FRESH : {}),
    banList: outcome.banList,
    sourceKey: outcome.sourceKey,
    state,
    lastAttemptAt: attempted ? outcome.now : previous.lastAttemptAt,
    lastSuccessAt: attempted && !failed ? outcome.now : previous.lastSuccessAt,
    lastFullScanAt: outcome.complete === true ? outcome.now : previous.lastFullScanAt,
    consecutiveFailures,
    incompleteScans,
    lastError,
    storedCount: outcome.storedCount ?? previous.storedCount,
    headTotal: outcome.headTotal === undefined ? previous.headTotal : outcome.headTotal,
    replacePending: Boolean(outcome.replacePending ?? previous.replacePending)
  };
  if (outcome.remote !== undefined)
    Object.assign(values, {
      remoteEtag: outcome.remote?.etag ?? null,
      remoteLastModified: outcome.remote?.lastModified ?? null,
      remoteBodyHash: outcome.remote?.bodyHash ?? null
    });

  const alerts = [];
  if (state !== previous.state && [STATES.SELF_IMPORT, STATES.ACCESS_LOST].includes(state))
    alerts.push(state);
  if (
    state === STATES.FAILING &&
    consecutiveFailures >= FAILURE_ALERT_RUNS &&
    (consecutiveFailures === FAILURE_ALERT_RUNS || previous.state !== STATES.FAILING)
  )
    alerts.push(STATES.FAILING);

  let recovered = null;
  if (attempted && !failed && state !== STATES.ACCESS_LOST) {
    if (previous.state === STATES.ACCESS_LOST) recovered = 'CBL can read it on BattleMetrics again';
    else if (previous.consecutiveFailures >= FAILURE_ALERT_RUNS)
      recovered = `it was imported again, after failing ${plural(previous.consecutiveFailures, 'run')} in a row`;
  }

  return { values, fields: Object.keys(values), alerts, recovered, previous };
}

// The alert to post about a list, as nextSync asked for, from what nextSync gave (sync) and the
// attempt's outcome.
export function describeAlert(kind, { values, previous }, outcome) {
  const stored = values.storedCount ?? 0;
  let kept = `none of its ${plural(stored, 'stored ban')} are`;
  if (stored === 0) kept = 'none of its bans are';
  else if (stored === 1) kept = 'its 1 stored ban is not';
  switch (kind) {
    case STATES.FAILING:
      return `Ban list (ID: ${values.banList}) has failed to import ${plural(values.consecutiveFailures, 'run')} in a row, so its bans may be out of date: ${
        values.lastSuccessAt
          ? `it was last imported at ${new Date(values.lastSuccessAt).toISOString()}`
          : 'the importer has no record of importing it from its current source'
      }. Its latest error: ${values.lastError}`;
    case STATES.ACCESS_LOST:
      // A list BattleMetrics does not list, but whose bans CBL could still read, has not been
      // taken from CBL by its owner, as BattleMetrics would then refuse it too.
      if (outcome.accessLost === NOT_VISIBLE && !outcome.error)
        return `Ban list (ID: ${values.banList}) is not among the BattleMetrics ban lists the CBL organisation can see, although CBL could still read it. Its new bans are saved, but ${kept} removed from it until BattleMetrics lists it again.`;
      return `CBL ${previous.lastSuccessAt ? 'can no longer read' : 'cannot read'} ban list (ID: ${values.banList}) on BattleMetrics, as ${outcome.accessLost}, so ${kept} removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too.`;
    case STATES.SELF_IMPORT: {
      let left = `Its ${plural(stored, 'stored ban')} are kept until the list is removed with /banlist remove, which removes them too.`;
      if (stored === 0) left = 'Remove the list with /banlist remove.';
      else if (stored === 1)
        left =
          'Its 1 stored ban is kept until the list is removed with /banlist remove, which removes the ban too.';
      return `Ban list (ID: ${values.banList}) is not imported, as its source is CBL's own export ban list (#${outcome.selfImport}), and importing it would feed the players CBL exports back in as new bans. ${left}`;
    }
    default:
      throw new Error(`Unknown ban list alert: ${kind}`);
  }
}

// Whether so many lists lost access in the same run, of the BattleMetrics lists the run tried, that
// CBL's own token is the likelier cause (see WIDESPREAD_LISTS).
export function isWidespread(lost, tried) {
  return lost >= WIDESPREAD_LISTS && lost * 2 >= tried;
}

// The one alert posted, instead of an alert for each, about the lists that lost access in the same
// run, as isWidespread says: their IDs, and how many BattleMetrics lists the run tried.
export function describeWidespreadLoss(banLists, tried) {
  return `CBL lost access to ${banLists.length} of the ${plural(tried, 'BattleMetrics ban list')} it tried in this run (IDs: ${banLists.join(', ')}): it cannot read them, or BattleMetrics does not list them among the ban lists the CBL organisation can see. So many at once points at CBL's BattleMetrics token, or its role in the CBL organisation, rather than at the lists' owners, so check the token before removing any of these lists. None of their bans are removed while this lasts.`;
}
