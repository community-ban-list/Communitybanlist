import { steam } from 'scbl-lib/apis';
import { sequelize } from 'scbl-lib/db';
import { ImporterState } from 'scbl-lib/db/importer-models';
import { QueryTypes } from 'scbl-lib/db/sequelize';
import { Logger } from 'scbl-lib/utils';

import { isRetryable, placeholders, retryOperation, sqlTime } from './apply-list.js';
import { unquote } from './ban-list-sync.js';
import { reportProgress, stopIfRequested } from './run-control.js';
import { isSteamID } from './steam-id.js';

// Refreshing players' Steam profiles, their names and avatars, within a budget for each run. A run
// takes first the players who were never refreshed or were queued for a refresh as their bans
// changed, the newest first, then the players whose profile is due a refresh, in the order of their
// IDs, carrying on from where the last run stopped. It asks Steam for 100 players a call, and saves
// each call's profiles with one statement. A player Steam leaves out of its answer, e.g. as the
// account no longer exists, is tried again a day later rather than on every run, and a player whose
// ID is not a SteamID is never sent to Steam.

// At most this many players who were never refreshed, or were queued for a refresh, are refreshed
// in a run, the newest first, as the export ban lists' alerts name the players they add.
export const NEW_PER_RUN = 300;

// After them, at most this many players whose profile is due a refresh are refreshed in a run,
// unless IMPORTER_STEAM_REFRESH_PER_RUN says otherwise, which may be at most MAX_REFRESH_PER_RUN, a
// hundred calls to Steam.
export const DEFAULT_REFRESH_PER_RUN = 200;
export const MAX_REFRESH_PER_RUN = 10000;

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
const INTERVAL = `(${6 * DAY} + CRC32(id) % ${2 * DAY})`;

// A player Steam leaves out is tried again this long after, in seconds, rather than on every run:
// they are marked refreshed this much less than their interval ago (RETRY_STAMP, in SQL), e.g. 6
// days ago for a player refreshed every 7 days.
const RETRY_MISSING_AFTER = DAY;
const RETRY_STAMP = `(${6 * DAY - RETRY_MISSING_AFTER} + CRC32(id) % ${2 * DAY})`;

// Whether a player's profile is due a refresh, given the time now, in UTC, as the importer writes
// every time, so the comparison is right whatever the time zone of the database or the connection.
// A player never refreshed has no time, and is taken as new instead.
const IS_DUE = `lastRefreshedInfo < CAST(? AS DATETIME(3)) - INTERVAL ${INTERVAL} SECOND`;

// How many players are due a refresh, and of those how many are new.
const COUNT_DUE = `SELECT COUNT(*) AS due, COUNT(*) - COUNT(lastRefreshedInfo) AS new FROM SteamUsers WHERE lastRefreshedInfo IS NULL OR ${IS_DUE}`;

// The players never refreshed, or queued for a refresh, the newest first.
const FIND_NEW =
  'SELECT id FROM SteamUsers WHERE lastRefreshedInfo IS NULL ORDER BY createdAt DESC, id DESC LIMIT ?';

// The players due a refresh in the order of their IDs: after the one the last run stopped at, and
// then from the first, up to and including that one.
const FIND_DUE_AFTER = `SELECT id FROM SteamUsers WHERE id > ? AND ${IS_DUE} ORDER BY id LIMIT ?`;
const FIND_DUE_UP_TO = `SELECT id FROM SteamUsers WHERE id <= ? AND ${IS_DUE} ORDER BY id LIMIT ?`;

// Players' profiles, as Steam gave them, are saved with one statement, which marks them refreshed.
// MySQL 8.0.19 and later take a row alias, here new, for the values given.
const SAVE_PROFILES =
  'INSERT INTO SteamUsers (id, name, profileURL, avatar, avatarMedium, avatarFull, lastRefreshedInfo, createdAt, updatedAt) VALUES';
const ON_DUPLICATE_PROFILE =
  'AS new ON DUPLICATE KEY UPDATE name = new.name, profileURL = new.profileURL, avatar = new.avatar, avatarMedium = new.avatarMedium, avatarFull = new.avatarFull, lastRefreshedInfo = new.lastRefreshedInfo, updatedAt = new.updatedAt';

// Mark players to be tried again RETRY_MISSING_AFTER from now.
const RETRY_LATER = `UPDATE SteamUsers SET lastRefreshedInfo = CAST(? AS DATETIME(3)) - INTERVAL ${RETRY_STAMP} SECOND WHERE id IN (?)`;

// Mark players whose ID is not a SteamID as looked at now, so they are looked at again only once
// their interval has passed, as there is nothing to retry.
const MARK_CHECKED = 'UPDATE SteamUsers SET lastRefreshedInfo = ? WHERE id IN (?)';

// IDs are written to the database at most this many in one statement.
const IDS_PER_STATEMENT = 500;

// A count written with thousands separators, e.g. 4,376.
function formatCount(count) {
  return count.toLocaleString('en-US');
}

// Read IMPORTER_STEAM_REFRESH_PER_RUN: a whole number from 0 to MAX_REFRESH_PER_RUN, with spaces or
// one pair of quotes around it. It is DEFAULT_REFRESH_PER_RUN when it is not given, and an invalid
// value is replaced with that, with a warning to log.
export function readRefreshPerRun(value) {
  const setting = unquote(value);
  if (setting === '') return { count: DEFAULT_REFRESH_PER_RUN };
  if (/^[0-9]+$/.test(setting) && Number(setting) <= MAX_REFRESH_PER_RUN)
    return { count: Number(setting) };
  return {
    count: DEFAULT_REFRESH_PER_RUN,
    warning: `Warning: IMPORTER_STEAM_REFRESH_PER_RUN must be a whole number from 0 to ${formatCount(MAX_REFRESH_PER_RUN)}, not "${value}", so the default of ${DEFAULT_REFRESH_PER_RUN} is used.`
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

function writeProfiles(profiles, time) {
  return sequelize.query(
    `${SAVE_PROFILES} ${placeholders(profiles.length, 9)} ${ON_DUPLICATE_PROFILE}`,
    {
      replacements: profiles.flatMap((profile) => [
        profile.id,
        profile.name,
        profile.profileURL,
        profile.avatar,
        profile.avatarMedium,
        profile.avatarFull,
        time,
        time,
        time
      ])
    }
  );
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
// calls it made, also when the step stops part-way. A run that is asked to stop does so between
// calls. now is the time the players' last refresh is compared with, and refreshPerRun the setting
// of how many players due a refresh it takes after the new ones.
export async function updateSteamUserInfo(
  counts = {},
  { now = new Date(), refreshPerRun = process.env.IMPORTER_STEAM_REFRESH_PER_RUN } = {}
) {
  const startTime = Date.now();
  const time = sqlTime(now);
  Object.assign(counts, {
    due: 0,
    new: 0,
    updated: 0,
    missing: 0,
    skipped: 0,
    unsaved: 0,
    left: 0,
    calls: 0
  });
  const setting = readRefreshPerRun(refreshPerRun);
  if (setting.warning) Logger.important('Steam', setting.warning);

  Logger.verbose('Steam', 2, 'Finding Steam users to update...');
  const [backlog] = await retryOperation(() =>
    sequelize.query(COUNT_DUE, { replacements: [time], type: QueryTypes.SELECT })
  );
  counts.due = Number(backlog?.due ?? 0);
  counts.new = Number(backlog?.new ?? 0);

  // The players this run takes: the new ones first, then those due a refresh.
  const newIDs =
    counts.new > 0
      ? (
          await retryOperation(() =>
            sequelize.query(FIND_NEW, { replacements: [NEW_PER_RUN], type: QueryTypes.SELECT })
          )
        ).map(({ id }) => id)
      : [];
  const cursor = await readCursor();
  const dueIDs =
    counts.due > counts.new && setting.count > 0 ? await findDue(time, cursor, setting.count) : [];
  const ids = [...newIDs, ...dueIDs];
  Logger.verbose(
    'Steam',
    2,
    `Updating ${ids.length} Steam users, ${newIDs.length} new and ${dueIDs.length} due a refresh, of ${counts.due} due (${counts.new} new)...`
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
