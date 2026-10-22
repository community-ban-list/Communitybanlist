import { steam } from 'scbl-lib/apis';
import { sequelize } from 'scbl-lib/db';
import { ImporterState } from 'scbl-lib/db/importer-models';
import { QueryTypes } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import { isRetryable, retryOperation, sqlTime } from './apply-list.js';
import { unquote } from './ban-list-sync.js';
import { reportProgress, stopIfRequested } from './run-control.js';
import { isSteamID } from './steam-id.js';

// Refreshing players' Steam profiles, their names and avatars, within a budget for each run, which
// comes from how often runs start, so each profile is refreshed about once a week whatever the
// schedule. A run takes first the players who were never refreshed or were queued for a refresh as
// their bans changed, the newest first, then the players whose profile is due a refresh, in the
// order of their IDs, carrying on from where the last run stopped. It asks Steam for 100 players a
// call, and saves each call's profiles with one statement. A player Steam leaves out of its answer,
// e.g. as the account no longer exists, is tried again a day later rather than on every run, and a
// player whose ID is not a SteamID is never sent to Steam.

// A run takes this many players who were never refreshed, or were queued for a refresh, the newest
// first, as the export ban lists' alerts name the players they add. When there are more, e.g. after
// a ban list was added, they also take the slots of the players due a refresh.
export const NEW_PER_RUN = 300;

// After them, a run takes at most as many players whose profile is due a refresh as
// IMPORTER_STEAM_REFRESH_PER_RUN says, from 0 up to MAX_REFRESH_PER_RUN, a hundred calls to Steam.
// Without it, a run takes enough to refresh every player within the shortest interval, 6 days, at
// a run every IMPORTER_CADENCE_SECONDS (refreshPerRunFor). That is about 15% more than intervals of
// 6 to 8 days need, so the players Steam leaves out, and those a run could not take, are caught up
// on. With 145,000 players it is about 6,050 a run every 6 hours, 1,010 every hour and 250 every 15
// minutes. It is at least MIN_REFRESH_PER_RUN, so that runs a minute or two apart still catch up
// quickly, and at most MAX_REFRESH_PER_RUN.
export const MIN_REFRESH_PER_RUN = 200;
export const MAX_REFRESH_PER_RUN = 10000;

// How often runs start, in seconds, when the step is not told: every 6 hours, as run.js takes it
// when IMPORTER_CADENCE_SECONDS is not set.
const DEFAULT_CADENCE_SECONDS = 6 * 60 * 60;

// Steam's GetPlayerSummaries takes at most this many SteamIDs a call.
export const IDS_PER_CALL = 100;

// The step stops once this many calls in a row have failed, as Steam is then most likely down and
// the rest would fail too. The players left stay due, so a later run refreshes them.
export const MAX_FAILED_CALLS = 2;

// The ImporterState row that keeps the ID of the last player whose profile was due a refresh that a
// run refreshed, after which the next run carries on.
export const CURSOR = 'steamRefreshCursor';

const DAY = 24 * 60 * 60;

// A profile is refreshed every 7 days, give or take a day: each player's own interval, from 6 days
// up to 8, comes from their ID, so players refreshed in the same run fall due over two days, rather
// than all in one run week after week. In SQL, in seconds.
const SHORTEST_INTERVAL = 6 * DAY;
const INTERVAL = `(${SHORTEST_INTERVAL} + CRC32(id) % ${2 * DAY})`;

// A player Steam leaves out is tried again this long after, in seconds, rather than on every run:
// they are marked refreshed this much less than their interval ago (RETRY_STAMP, in SQL), e.g. 6
// days ago for a player refreshed every 7 days.
const RETRY_MISSING_AFTER = DAY;
const RETRY_STAMP = `(${SHORTEST_INTERVAL - RETRY_MISSING_AFTER} + CRC32(id) % ${2 * DAY})`;

// Whether a player's profile is due a refresh, given the time now, in UTC, as the importer writes
// every time, so the comparison is right whatever the time zone of the database or the connection.
// A player never refreshed has no time, and is taken as new instead.
const IS_DUE = `lastRefreshedInfo < CAST(? AS DATETIME(3)) - INTERVAL ${INTERVAL} SECOND`;

// How many players there are, how many of them are due a refresh, and of those how many are new.
const COUNT_DUE = `SELECT COUNT(*) AS players, COUNT(CASE WHEN lastRefreshedInfo IS NULL OR ${IS_DUE} THEN 1 END) AS due, COUNT(*) - COUNT(lastRefreshedInfo) AS new FROM SteamUsers`;

// The players never refreshed, or queued for a refresh, the newest first.
const FIND_NEW =
  'SELECT id FROM SteamUsers WHERE lastRefreshedInfo IS NULL ORDER BY createdAt DESC, id DESC LIMIT ?';

// The players due a refresh in the order of their IDs: after the one the last run stopped at, and
// then from the first, up to and including that one.
const FIND_DUE_AFTER = `SELECT id FROM SteamUsers WHERE id > ? AND ${IS_DUE} ORDER BY id LIMIT ?`;
const FIND_DUE_UP_TO = `SELECT id FROM SteamUsers WHERE id <= ? AND ${IS_DUE} ORDER BY id LIMIT ?`;

// Players' profiles, as Steam gave them, are saved with one statement, which marks them refreshed.
// It only updates the players' rows, joined by ID with a table of the profiles, which MySQL 8.0.19
// and later make with VALUES ROW(...), here p. So it never makes a row again for a player removed
// since the step read them, and needs nothing of the table's other columns.
const PROFILE_ROW = 'ROW(?, ?, ?, ?, ?, ?)';
const SAVE_PROFILES = 'UPDATE SteamUsers su JOIN (VALUES';
const SET_PROFILES =
  ') AS p (id, name, profileURL, avatar, avatarMedium, avatarFull) ON su.id = p.id SET su.name = p.name, su.profileURL = p.profileURL, su.avatar = p.avatar, su.avatarMedium = p.avatarMedium, su.avatarFull = p.avatarFull, su.lastRefreshedInfo = ?, su.updatedAt = ?';

// Mark players to be tried again RETRY_MISSING_AFTER from now.
const RETRY_LATER = `UPDATE SteamUsers SET lastRefreshedInfo = CAST(? AS DATETIME(3)) - INTERVAL ${RETRY_STAMP} SECOND WHERE id IN (?)`;

// Mark players whose ID is not a SteamID as looked at now, so they are looked at again only once
// their interval has passed, as there is nothing to retry.
const MARK_CHECKED = 'UPDATE SteamUsers SET lastRefreshedInfo = ? WHERE id IN (?)';

// IDs are written to the database at most this many in one statement.
const IDS_PER_STATEMENT = 500;

// The invalid IMPORTER_STEAM_REFRESH_PER_RUN that was last posted about.
let warnedRefreshPerRun;

// A count written with thousands separators, e.g. 4,376.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

// How many players due a refresh a run takes when IMPORTER_STEAM_REFRESH_PER_RUN is not given, for
// that many players and a run every cadenceSeconds: enough to refresh them all within the shortest
// interval, but at least MIN_REFRESH_PER_RUN and at most MAX_REFRESH_PER_RUN.
export function refreshPerRunFor(players, cadenceSeconds) {
  const needed = Math.ceil((players * cadenceSeconds) / SHORTEST_INTERVAL);
  return Math.min(MAX_REFRESH_PER_RUN, Math.max(MIN_REFRESH_PER_RUN, needed));
}

// Read IMPORTER_STEAM_REFRESH_PER_RUN: a whole number from 0 to MAX_REFRESH_PER_RUN, with spaces or
// one pair of quotes around it. It is defaultCount, which refreshPerRunFor works out from the run's
// schedule, when it is not given, and an invalid value is replaced with that, with a warning to log.
export function readRefreshPerRun(value, defaultCount) {
  const setting = unquote(value);
  if (setting === '') return { count: defaultCount };
  if (/^[0-9]+$/.test(setting) && Number(setting) <= MAX_REFRESH_PER_RUN)
    return { count: Number(setting) };
  return {
    count: defaultCount,
    warning: `Warning: IMPORTER_STEAM_REFRESH_PER_RUN must be a whole number from 0 to ${formatCount(MAX_REFRESH_PER_RUN)}, not "${value}", so the default for the run's schedule, ${formatCount(defaultCount)}, is used.`
  };
}

// A player's profile, as the columns of SteamUsers keep it, from a player in Steam's answer.
function profileOf(player) {
  const text = (value) => (typeof value === 'string' ? value : null);
  return {
    id: player.steamid,
    name: text(player.personaname),
    profileURL: text(player.profileurl),
    avatar: text(player.avatar),
    avatarMedium: text(player.avatarmedium),
    avatarFull: text(player.avatarfull)
  };
}

// The profiles of the players asked for in a call, by ID, from the players Steam gave. Any other
// player Steam gives is left out.
export function profilesOf(players, asked) {
  const requested = new Set(asked);
  const profiles = new Map();
  for (const player of players) {
    const id = player?.steamid;
    if (typeof id === 'string' && requested.has(id) && !profiles.has(id))
      profiles.set(id, profileOf(player));
  }
  return profiles;
}

// Run a statement for IDs, at most IDS_PER_STATEMENT at a time, each run again while it fails in a
// way that could pass.
async function forIDs(sql, time, ids) {
  for (let i = 0; i < ids.length; i += IDS_PER_STATEMENT) {
    const some = ids.slice(i, i + IDS_PER_STATEMENT);
    await retryOperation(() => sequelize.query(sql, { replacements: [time, some] }));
  }
}

// Save the profiles with one statement, which marks them refreshed at time.
function writeProfiles(profiles, time) {
  const rows = Array(profiles.length).fill(PROFILE_ROW).join(', ');
  return sequelize.query(`${SAVE_PROFILES} ${rows}${SET_PROFILES}`, {
    replacements: [
      ...profiles.flatMap((profile) => [
        profile.id,
        profile.name,
        profile.profileURL,
        profile.avatar,
        profile.avatarMedium,
        profile.avatarFull
      ]),
      time,
      time
    ]
  });
}

// Save the profiles with one statement, run again while it fails in a way that could pass. One
// that fails in another way, e.g. as a name holds a character the table cannot store, is saved
// again a profile at a time, so only the profiles that cannot be saved are left out. Resolves with
// those, each as { id, err }.
async function saveProfiles(profiles, time) {
  if (profiles.length === 0) return [];
  try {
    await retryOperation(() => writeProfiles(profiles, time));
    return [];
  } catch (err) {
    if (isRetryable(err)) throw err;
    if (profiles.length === 1) return [{ id: profiles[0].id, err }];
  }
  const unsaved = [];
  for (const profile of profiles) {
    try {
      await retryOperation(() => writeProfiles([profile], time));
    } catch (err) {
      if (isRetryable(err)) throw err;
      unsaved.push({ id: profile.id, err });
    }
  }
  return unsaved;
}

// The players whose profile is due a refresh, at most limit of them, in the order of their IDs,
// after the one cursor names, and then from the first one, if there are fewer than limit after it.
async function findDue(time, cursor, limit) {
  const select = (sql, count) =>
    retryOperation(() =>
      sequelize.query(sql, { replacements: [cursor, time, count], type: QueryTypes.SELECT })
    );
  const ids = (await select(FIND_DUE_AFTER, limit)).map(({ id }) => id);
  if (ids.length < limit && cursor !== '')
    ids.push(...(await select(FIND_DUE_UP_TO, limit - ids.length)).map(({ id }) => id));
  return ids;
}

// The ID of the player the last run stopped at, or '' to start from the first.
async function readCursor() {
  const row = await retryOperation(() => ImporterState.findByPk(CURSOR));
  return typeof row?.value === 'string' ? row.value : '';
}

// Where the next run carries on: after the last of the players due a refresh, in the order they
// were taken (ids), up to which every one was dealt with, so one whose call failed is taken again
// first. null when the first of them was not dealt with, as the cursor then stays.
export function nextCursor(ids, dealtWith) {
  let cursor = null;
  for (const id of ids) {
    if (!dealtWith.has(id)) break;
    cursor = id;
  }
  return cursor;
}

// Refresh the Steam profiles of the players that are due, within the run's budget, counting in
// counts how many were due, of those how many were new, and how many it updated, found missing on
// Steam, skipped as not SteamIDs and could not save, how many are left for later runs, and how many
// calls it made, also when the step stops part-way. It counts nothing until it has counted the
// players due. A run that is asked to stop does so between calls. now is the time the players' last
// refresh is compared with, refreshPerRun the setting of how many players due a refresh it takes
// after the new ones, and cadenceSeconds how often runs start, from which it works out how many
// when that is not set.
export async function updateSteamUserInfo(
  counts = {},
  {
    now = new Date(),
    refreshPerRun = process.env.IMPORTER_STEAM_REFRESH_PER_RUN,
    cadenceSeconds = DEFAULT_CADENCE_SECONDS
  } = {}
) {
  const startTime = Date.now();
  const time = sqlTime(now);

  Logger.verbose('Steam', 2, 'Finding Steam users to update...');
  const [backlog] = await retryOperation(() =>
    sequelize.query(COUNT_DUE, { replacements: [time], type: QueryTypes.SELECT })
  );
  // Only now are there counts, so a step that could not count the players due does not say that
  // none were due.
  Object.assign(counts, {
    due: Number(backlog?.due ?? 0),
    new: Number(backlog?.new ?? 0),
    updated: 0,
    missing: 0,
    skipped: 0,
    unsaved: 0,
    left: 0,
    calls: 0
  });
  const setting = readRefreshPerRun(
    refreshPerRun,
    refreshPerRunFor(Number(backlog?.players ?? 0), cadenceSeconds)
  );
  // An invalid setting is posted the first time, and then only printed in the console, as the
  // importer service runs this step every cycle with the same settings.
  if (setting.warning && refreshPerRun === warnedRefreshPerRun)
    Logger.verbose('Steam', 2, setting.warning);
  else if (setting.warning) {
    warnedRefreshPerRun = refreshPerRun;
    Logger.important('Steam', setting.warning);
  }

  // The players this run takes: first the new ones, at most NEW_PER_RUN plus the setting, as new
  // ones beyond NEW_PER_RUN take the slots of the players due a refresh, and then the players due a
  // refresh, in the slots that are left.
  const budget = NEW_PER_RUN + setting.count;
  const newIDs =
    counts.new > 0
      ? (
          await retryOperation(() =>
            sequelize.query(FIND_NEW, { replacements: [budget], type: QueryTypes.SELECT })
          )
        ).map(({ id }) => id)
      : [];
  const dueBudget = Math.min(setting.count, budget - newIDs.length);
  const cursor = await readCursor();
  const dueIDs =
    counts.due > counts.new && dueBudget > 0 ? await findDue(time, cursor, dueBudget) : [];
  const ids = [...newIDs, ...dueIDs];
  Logger.verbose(
    'Steam',
    2,
    `Updating ${ids.length} Steam users, ${newIDs.length} new and ${dueIDs.length} due a refresh, of ${counts.due} due (${counts.new} new), taking at most ${setting.count} due a refresh a run...`
  );

  // The players dealt with: refreshed, found missing on Steam, skipped or not saved.
  const dealtWith = new Set();
  const dealt = (some) => {
    for (const id of some) dealtWith.add(id);
    counts.left = Math.max(0, counts.due - dealtWith.size);
  };
  counts.left = counts.due;

  // A player whose ID is not a SteamID is never sent to Steam, which could only fail the call.
  const steamIDs = ids.filter(isSteamID);
  const invalid = ids.filter((id) => !isSteamID(id));
  if (invalid.length > 0) {
    await forIDs(MARK_CHECKED, time, invalid);
    counts.skipped = invalid.length;
    dealt(invalid);
    Logger.verbose(
      'Steam',
      2,
      `Skipped ${invalid.length} Steam users whose IDs are not SteamIDs: ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? ', ...' : ''}`
    );
  }

  // The profiles that could not be saved, each logged in the console as it happens, and posted
  // about once, also when the step stops part-way.
  const unsaved = [];
  let failedCalls = 0;
  try {
    for (let i = 0; i < steamIDs.length; i += IDS_PER_CALL) {
      reportProgress(dealtWith.size, ids.length, 'Steam users');
      // A run that is asked to stop does so between calls.
      stopIfRequested();
      const asked = steamIDs.slice(i, i + IDS_PER_CALL);

      let players;
      try {
        counts.calls++;
        const response = await steam('get', 'ISteamUser/GetPlayerSummaries/v2', {
          steamids: asked.join(',')
        });
        players = response?.data?.response?.players;
        if (!Array.isArray(players))
          throw new Error('Steam answered GetPlayerSummaries without a list of players.');
      } catch (err) {
        // Steam refused the key, so it would refuse every other call too, and
        // partner.steam-api.com limits the whole IP address after repeated refusals.
        if (err.auth) {
          Logger.verbose(
            'Steam',
            1,
            `Stopped updating Steam users, as Steam refused the API key: ${err.message}`
          );
          break;
        }

        // Steam is still limiting requests after the client's retries and minute-long pauses, so
        // every other call would wait out the same pauses. The players left stay due, so a later
        // run updates them, and the later steps do not need fresh Steam data.
        if (err.status === 429) {
          Logger.verbose(
            'Steam',
            1,
            `Stopped updating Steam users, as Steam is still limiting requests: ${err.message}`
          );
          break;
        }

        failedCalls++;
        if (failedCalls >= MAX_FAILED_CALLS) {
          Logger.verbose(
            'Steam',
            1,
            `Stopped updating Steam users, as ${failedCalls} calls in a row failed: ${err.message}`
          );
          break;
        }

        // The Steam client throws ApiErrors, which never hold the key, so the error is logged
        // whole.
        Logger.verbose('Steam', 1, `Failed to update ${asked.length} Steam users: `, err);
        continue;
      }
      failedCalls = 0;

      // The players Steam gave are saved, and those it left out are tried again a day later. So
      // are those whose profile could not be saved.
      const profiles = profilesOf(players, asked);
      const notSaved = await saveProfiles([...profiles.values()], time);
      for (const { id, err } of notSaved)
        Logger.verbose('Steam', 2, `Could not save the Steam profile of ${id}: `, err);
      const missing = asked.filter((id) => !profiles.has(id));
      await forIDs(RETRY_LATER, time, [...missing, ...notSaved.map(({ id }) => id)]);
      counts.updated += profiles.size - notSaved.length;
      counts.missing += missing.length;
      counts.unsaved += notSaved.length;
      unsaved.push(...notSaved);
      dealt(asked);
    }
    reportProgress(dealtWith.size, ids.length, 'Steam users');
  } finally {
    if (unsaved.length > 0)
      Logger.verbose(
        'Steam',
        1,
        `Could not save the Steam profiles of ${unsaved.length} Steam users, e.g. ${unsaved[0].id}, so they are tried again in a day: `,
        unsaved[0].err
      );
  }

  // The next run carries on after the players due a refresh this one dealt with.
  const next = nextCursor(dueIDs, dealtWith);
  if (next !== null && next !== cursor)
    await retryOperation(() => ImporterState.upsert({ name: CURSOR, value: next }));

  Logger.verbose(
    'Steam',
    2,
    `Finished updating Steam users: ${counts.updated} updated, ${counts.missing} not found on Steam, ${counts.skipped} skipped and ${counts.unsaved} not saved, with ${counts.calls} calls, and ${counts.left} left for later runs. Took ${((Date.now() - startTime) / 1000).toFixed(2)}s`
  );
}
