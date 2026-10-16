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
  // CBL can no longer read it on BattleMetrics, so none of its bans are removed.
  ACCESS_LOST: 'access_lost',
  // Its source is one of CBL's own export ban lists, so it is neither imported nor swept.
  SELF_IMPORT: 'self_import',
  // It was imported, but removing the bans it no longer has waits for confirmation.
  HELD: 'held'
};

// A list that fails to import this many runs in a row is posted about, once.
export const FAILURE_ALERT_RUNS = 3;

// Why the access check says CBL cannot read a list.
export const NOT_VISIBLE =
  'its source is not among the BattleMetrics ban lists the CBL organisation can see';

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

// Read IMPORTER_ACCESS_CHECK, which turns the access check off when it is 0, false, off or no. It is
// on when the setting is not given, and an invalid value leaves it on, with a warning to log.
export function readAccessCheck(value) {
  if (typeof value === 'boolean') return { on: value };
  if (value === undefined || value === null || String(value).trim() === '') return { on: true };
  const setting = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(setting)) return { on: true };
  if (['0', 'false', 'off', 'no'].includes(setting)) return { on: false };
  return {
    on: true,
    warning: `Warning: IMPORTER_ACCESS_CHECK must be 1 or 0, not "${value}", so the access check stays on.`
  };
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
// to 500 characters.
export function cleanError(text) {
  const clean = String(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[address]')
    .replace(/\s+/g, ' ')
    .trim()
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
// attempt's error, the bans it held, the bans the list has here, and BattleMetrics' count of its
// bans, or undefined when the attempt got none. Returns:
// - values: the row's new values;
// - fields: the columns to write. A list whose type or source was changed starts afresh, so all
//   of its columns are written, and otherwise only those the import sets;
// - alerts: what to post about the list: reaching FAILURE_ALERT_RUNS failed runs in a row, and
//   starting to import a CBL export ban list or losing access, each only when it starts, so never
//   again while the list stays so;
// - recovered: why the list is back to normal, if it is.
// A list whose source is a CBL export ban list is never fetched, so its attempt neither fails nor
// succeeds. A run's second attempt at a list is worked out from the same row as its first, so the
// run counts once.
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
  if (failed) lastError = cleanError(outcome.error);
  else if (outcome.accessLost)
    lastError = cleanError(
      `${outcome.accessLost[0].toUpperCase()}${outcome.accessLost.slice(1)}, so its bans are not checked for removal.`
    );

  const values = {
    ...(reset ? FRESH : {}),
    banList: outcome.banList,
    sourceKey: outcome.sourceKey,
    state,
    lastAttemptAt: attempted ? outcome.now : previous.lastAttemptAt,
    lastSuccessAt: attempted && !failed ? outcome.now : previous.lastSuccessAt,
    consecutiveFailures,
    lastError,
    storedCount: outcome.storedCount ?? previous.storedCount,
    headTotal: outcome.headTotal === undefined ? previous.headTotal : outcome.headTotal
  };

  const alerts = [];
  if (state !== previous.state && [STATES.SELF_IMPORT, STATES.ACCESS_LOST].includes(state))
    alerts.push(state);
  if (state === STATES.FAILING && consecutiveFailures === FAILURE_ALERT_RUNS)
    alerts.push(STATES.FAILING);

  let recovered = null;
  if (attempted && !failed && state !== STATES.ACCESS_LOST) {
    if (previous.state === STATES.ACCESS_LOST) recovered = 'CBL can read it on BattleMetrics again';
    else if (previous.consecutiveFailures >= FAILURE_ALERT_RUNS)
      recovered = `it was imported again, after failing ${plural(previous.consecutiveFailures, 'run')} in a row`;
  }

  return { values, fields: Object.keys(values), alerts, recovered };
}

// The alert to post about a list, as nextSync asked for, from its new row and the attempt's
// outcome.
export function describeAlert(kind, values, outcome) {
  const stored = values.storedCount ?? 0;
  switch (kind) {
    case STATES.FAILING:
      return `Ban list (ID: ${values.banList}) has failed to import ${FAILURE_ALERT_RUNS} runs in a row, so its bans may be out of date: ${
        values.lastSuccessAt
          ? `it was last imported at ${new Date(values.lastSuccessAt).toISOString()}`
          : 'it has not been imported from its current source yet'
      }. Its latest error: ${values.lastError}`;
    case STATES.ACCESS_LOST: {
      let kept = `none of its ${plural(stored, 'stored ban')} are`;
      if (stored === 0) kept = 'none of its bans are';
      else if (stored === 1) kept = 'its 1 stored ban is not';
      return `CBL can no longer read ban list (ID: ${values.banList}) on BattleMetrics, as ${outcome.accessLost}, so ${kept} removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too.`;
    }
    case STATES.SELF_IMPORT: {
      let kept = `Its ${plural(stored, 'stored ban')} are kept until the list is removed with /banlist remove, which removes them too.`;
      if (stored === 0) kept = 'Remove the list with /banlist remove.';
      else if (stored === 1)
        kept =
          'Its 1 stored ban is kept until the list is removed with /banlist remove, which removes the ban too.';
      return `Ban list (ID: ${values.banList}) is not imported, as its source is CBL's own export ban list (#${outcome.selfImport}), and importing it would feed the players CBL exports back in as new bans. ${kept}`;
    }
    default:
      throw new Error(`Unknown ban list alert: ${kind}`);
  }
}
