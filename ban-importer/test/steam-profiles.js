import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';
import { crc32 } from 'zlib';

import describeError from '../../scbl-lib/utils/describe-error.js';

// Check the Steam step without a database or network requests: which players a run takes and in
// what order, the budget of each run and how it follows the schedule, that new players come first
// and may take the slots of the players due a refresh, that a player Steam leaves out is tried
// again a day later rather than on every run, that IDs that are not SteamIDs are never sent, how
// profiles are saved, how failed calls stop the step, and where it stops. The database is a
// stand-in that keeps the players and the importer's state in memory and runs the statements the
// step sends as MySQL would, with MySQL's CRC32 for each player's refresh interval. Steam answers
// from the stand-in below, and waits between attempts are skipped but recorded.

class DatabaseError extends Error {
  constructor(message, original = {}) {
    super(message);
    this.name = 'SequelizeDatabaseError';
    this.original = original;
  }
}
class ForeignKeyConstraintError extends DatabaseError {}
class ValidationError extends Error {}
const deadlock = () =>
  new DatabaseError('Deadlock found when trying to get lock; try restarting transaction', {
    errno: 1213
  });

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const NOW = Date.parse('2026-10-22T15:00:00.000Z');
// An hour in seconds, for schedules as IMPORTER_CADENCE_SECONDS gives them.
const HOURS = 60 * 60;

// The players, by ID, with their times as milliseconds, and the importer's state, by name.
const users = new Map();
const state = new Map();
// What the database did, as [what, IDs], and the IDs of each call to Steam.
const events = [];
const calls = [];
const delays = [];
const logs = [];
// Errors for the statements that save profiles to fail with, one each time, for the statements
// whose IDs the test function (when) accepts.
const saveErrors = [];
// An error for the statement that counts the players due to fail with, each time, or null.
let countError = null;
// Steam's answer to each call, from the IDs asked for and the number of the call; by default the
// players it knows, which are all but those in unknown.
let answer = null;
const unknown = new Set();

// A time as MySQL reads text in DATETIME's format: in UTC, as the importer's connections use UTC.
const timeOf = (text) => {
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  return Date.parse(`${text.replace(' ', 'T')}Z`);
};
// lastRefreshedInfo is a DATETIME, which MySQL keeps to the second, rounding a time to the nearest.
const toSecond = (ms) => Math.round(ms / SECOND) * SECOND;
// Each player's refresh interval, from 6 days up to 8, as MySQL works it out from their ID.
const hash = (id) => crc32(Buffer.from(id, 'utf8')) % (2 * 24 * 60 * 60);
const interval = (id) => (6 * 24 * 60 * 60 + hash(id)) * SECOND;
const isDue = (user, time) =>
  user.lastRefreshedInfo !== null && user.lastRefreshedInfo < time - interval(user.id);
const byID = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const rowsOf = (replacements, n) =>
  Array.from({ length: replacements.length / n }, (_, i) => replacements.slice(i * n, i * n + n));

const IS_DUE =
  'lastRefreshedInfo < CAST(? AS DATETIME(3)) - INTERVAL (518400 + CRC32(id) % 172800) SECOND';
const COUNT_DUE = `SELECT COUNT(*) AS players, COUNT(CASE WHEN lastRefreshedInfo IS NULL OR ${IS_DUE} THEN 1 END) AS due, COUNT(*) - COUNT(lastRefreshedInfo) AS new FROM SteamUsers`;
const FIND_NEW =
  'SELECT id FROM SteamUsers WHERE lastRefreshedInfo IS NULL ORDER BY createdAt DESC, id DESC LIMIT ?';
const FIND_DUE_AFTER = `SELECT id FROM SteamUsers WHERE id > ? AND ${IS_DUE} ORDER BY id LIMIT ?`;
const FIND_DUE_UP_TO = `SELECT id FROM SteamUsers WHERE id <= ? AND ${IS_DUE} ORDER BY id LIMIT ?`;
const SAVE_PROFILES =
  /^UPDATE SteamUsers su JOIN \(VALUES (ROW\(\?, \?, \?, \?, \?, \?\)(, )?)+\) AS p \(id, name, profileURL, avatar, avatarMedium, avatarFull\) ON su\.id = p\.id SET su\.name = p\.name, su\.profileURL = p\.profileURL, su\.avatar = p\.avatar, su\.avatarMedium = p\.avatarMedium, su\.avatarFull = p\.avatarFull, su\.lastRefreshedInfo = \?, su\.updatedAt = \?$/;
const RETRY_LATER =
  'UPDATE SteamUsers SET lastRefreshedInfo = CAST(? AS DATETIME(3)) - INTERVAL (432000 + CRC32(id) % 172800) SECOND WHERE id IN (?)';
const MARK_CHECKED = 'UPDATE SteamUsers SET lastRefreshedInfo = ? WHERE id IN (?)';

const QueryTypes = { SELECT: 'SELECT' };
const select = (type) => assert.strictEqual(type, QueryTypes.SELECT);
const sequelize = {
  async query(sql, { replacements, type, transaction } = {}) {
    // Every statement is its own, as nothing the step writes needs a transaction.
    assert.strictEqual(transaction, undefined);
    await new Promise(setImmediate);
    if (sql === COUNT_DUE) {
      select(type);
      if (countError) throw countError;
      const time = timeOf(replacements[0]);
      const due = [...users.values()].filter(
        (user) => user.lastRefreshedInfo === null || isDue(user, time)
      );
      // mysql2 gives COUNT(*) as a number.
      return [
        {
          players: users.size,
          due: due.length,
          new: due.filter((user) => user.lastRefreshedInfo === null).length
        }
      ];
    }
    if (sql === FIND_NEW) {
      select(type);
      events.push(['find new', replacements[0]]);
      return [...users.values()]
        .filter((user) => user.lastRefreshedInfo === null)
        .sort((a, b) => b.createdAt - a.createdAt || byID(b, a))
        .slice(0, replacements[0])
        .map(({ id }) => ({ id }));
    }
    if (sql === FIND_DUE_AFTER || sql === FIND_DUE_UP_TO) {
      select(type);
      const [cursor, text, limit] = replacements;
      events.push([sql === FIND_DUE_AFTER ? 'find due after' : 'find due up to', cursor, limit]);
      const time = timeOf(text);
      return [...users.values()]
        .filter((user) => (sql === FIND_DUE_AFTER ? user.id > cursor : user.id <= cursor))
        .filter((user) => isDue(user, time))
        .sort(byID)
        .slice(0, limit)
        .map(({ id }) => ({ id }));
    }
    if (SAVE_PROFILES.test(sql)) {
      const rows = rowsOf(replacements.slice(0, -2), 6);
      const [refreshed, updatedAt] = replacements.slice(-2);
      assert.strictEqual(updatedAt, refreshed);
      const ids = rows.map(([id]) => id);
      const error = saveErrors.find(({ when }) => when(ids))?.errors.shift();
      if (error) throw error;
      events.push(['save', ids]);
      // Only the players' rows are updated: a player that is not there is not added.
      for (const [id, name, profileURL, avatar, avatarMedium, avatarFull] of rows)
        if (users.has(id))
          Object.assign(users.get(id), {
            name,
            profileURL,
            avatar,
            avatarMedium,
            avatarFull,
            lastRefreshedInfo: toSecond(timeOf(refreshed))
          });
      // Sequelize resolves with [result, result] for an UPDATE.
      const result = { affectedRows: ids.filter((id) => users.has(id)).length };
      return [result, result];
    }
    if (sql === RETRY_LATER || sql === MARK_CHECKED) {
      const [text, ids] = replacements;
      events.push([sql === RETRY_LATER ? 'retry later' : 'checked', [...ids]]);
      const time = timeOf(text);
      for (const id of ids) {
        const user = users.get(id);
        if (!user) continue;
        user.lastRefreshedInfo =
          sql === MARK_CHECKED
            ? toSecond(time)
            : toSecond(time - (5 * 24 * 60 * 60 + hash(id)) * SECOND);
      }
      return [{ affectedRows: ids.length }, { affectedRows: ids.length }];
    }
    throw new Error(`Unexpected statement: ${sql}`);
  }
};

// The importer's state, as the ImporterState model reads and saves it.
const ImporterState = {
  async findByPk(name) {
    return state.has(name) ? { name, value: state.get(name) } : null;
  },
  async upsert({ name, value }) {
    events.push(['save cursor', value]);
    state.set(name, value);
  }
};

// An error as the Steam client throws one: an ApiError, which never holds the key.
function apiError(message, { status, ...details } = {}) {
  const err = Object.assign(new Error(message), { name: 'ApiError', status, ...details });
  if (status) err.response = { status, data: { errors: [] } };
  return err;
}
const unavailable = () =>
  apiError('Steam GET ISteamUser/GetPlayerSummaries/v2 failed after 3 attempts: HTTP 503', {
    status: 503,
    auth: false
  });
// The players Steam knows of those asked for, as GetPlayerSummaries gives them.
const known = (ids) => ({
  data: {
    response: {
      players: ids
        .filter((id) => !unknown.has(id))
        .map((steamid) => ({
          steamid,
          personaname: `Player ${steamid.slice(-4)}`,
          profileurl: `https://steamcommunity.com/profiles/${steamid}/`,
          avatar: `https://avatars.example/${steamid}.jpg`,
          avatarmedium: `https://avatars.example/${steamid}_medium.jpg`,
          avatarfull: `https://avatars.example/${steamid}_full.jpg`
        }))
    }
  }
});

async function steam(method, path, params) {
  assert.deepStrictEqual([method, path], ['get', 'ISteamUser/GetPlayerSummaries/v2']);
  const ids = params.steamids.split(',');
  calls.push(ids);
  return (answer ?? known)(ids, calls.length);
}

const env = {};
const context = vm.createContext({
  process: { env },
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const dependencies = {
  crypto: { createHash },
  'scbl-lib/apis': { steam, readBattlemetricsPages: async () => [] },
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/importer-models': { ImporterState },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: () => false
  },
  'scbl-lib/utils': {
    describeError,
    Logger: {
      verbose: (module, level, message, ...extras) => logs.push({ level, message, extras }),
      important: (module, message) => logs.push({ level: 1, message, important: true })
    },
    normaliseBattlemetricsID: (id) => String(id ?? '').trim()
  }
};
// The step, with the real apply-list.js, ban-list-sync.js, planner.js, run-control.js and
// steam-id.js, each loaded once.
const modules = new Map();
const load = (path) => {
  if (!modules.has(path))
    modules.set(
      path,
      readFile(new URL(path, import.meta.url), 'utf8').then(
        (source) => new vm.SourceTextModule(source, { context })
      )
    );
  return modules.get(path);
};
const OWN = [
  './apply-list.js',
  './ban-list-sync.js',
  './planner.js',
  './run-control.js',
  './steam-id.js'
];
const module = await load('../src/steam-profiles.js');
await module.link(async (specifier) => {
  if (OWN.includes(specifier)) return load(`../src/${specifier.slice(2)}`);
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
  CURSOR,
  IDS_PER_CALL,
  MAX_FAILED_CALLS,
  MAX_REFRESH_PER_RUN,
  MIN_REFRESH_PER_RUN,
  NEW_PER_RUN,
  nextCursor,
  readRefreshPerRun,
  refreshPerRunFor,
  updateSteamUserInfo
} = module.namespace;
const control = (await load('../src/run-control.js')).namespace;
// How far the step said it had got, for the run's status, as [done, total, unit].
const progress = [];
control.setProgressListener(({ done, total, unit }) => progress.push([done, total, unit]));

const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// Add a player, made at createdAt and last refreshed at refreshed, or never (null).
function addUser(id, { createdAt = NOW - 30 * DAY, refreshed = null } = {}) {
  users.set(id, {
    id,
    createdAt,
    lastRefreshedInfo: refreshed,
    name: null,
    profileURL: null,
    avatar: null,
    avatarMedium: null,
    avatarFull: null
  });
}
function reset() {
  users.clear();
  state.clear();
  unknown.clear();
  for (const array of [events, calls, delays, logs, saveErrors, progress]) array.length = 0;
  answer = null;
  countError = null;
}
// Run the step at the time given, NOW by default, with the setting and the schedule given, or none.
// Resolves with what it counted.
async function update({ at = NOW, refreshPerRun, cadenceSeconds } = {}) {
  for (const array of [events, calls, delays, logs, progress]) array.length = 0;
  const counts = {};
  await updateSteamUserInfo(counts, { now: new Date(at), refreshPerRun, cadenceSeconds });
  return { ...counts };
}
const asked = () => calls.flat();
const levelOne = () =>
  logs
    .filter(({ level }) => level === 1)
    .map(({ message, extras }) => message + extras.map((err) => err.message).join(''));
const isDueAt = (id, at) => isDue(users.get(id), at);
const findsDue = () => events.filter(([what]) => what.startsWith('find due'));

// IDs players were saved with before SteamIDs were checked, which are not SteamIDs Steam knows: one
// below the range of players' accounts, one in a profile's address, one of 18 digits and one with a
// space before it.
const INVALID = [
  '76561197960265728',
  'https://steamcommunity.com/profiles/76561198000099999',
  '765611980000000001',
  ' 76561198000000002'
];

// A run takes the players never refreshed, or queued for a refresh, the newest first, and then the
// players due a refresh, in the order of their IDs: with 854 players and a run every 6 hours, at
// most 200 due a refresh, and new players beyond 300 take their slots. It asks Steam for 100 at a
// time, and never for an ID that is not a SteamID, which it marks as looked at instead. Players
// Steam leaves out are marked to be tried again a day later, and the others are saved with one
// statement a call.
{
  reset();
  for (const n of range(1, 400)) addUser(steamID(n), { createdAt: NOW - DAY + n * SECOND });
  INVALID.forEach((id, index) => addUser(id, { createdAt: NOW - index * SECOND }));
  for (const n of range(1001, 1350)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  for (const n of range(2001, 2100)) addUser(steamID(n), { refreshed: NOW - 60 * 60 * SECOND });
  for (const n of [400, 399, 1001]) unknown.add(steamID(n));

  const counts = await update();
  assert.deepStrictEqual(counts, {
    due: 754,
    new: 404,
    updated: 493,
    missing: 3,
    skipped: 4,
    unsaved: 0,
    left: 254,
    calls: 5
  });
  // It took all 404 new players, as up to 500 may be new, and in the 96 slots they left, players
  // due a refresh from the first.
  assert.deepStrictEqual(events[0], ['find new', 500]);
  assert.deepStrictEqual(findsDue(), [['find due after', '', 96]]);
  // The newest of the new players first, then the players due a refresh, 100 at a time, without
  // the IDs that are not SteamIDs.
  assert.deepStrictEqual(
    calls.map((ids) => ids.length),
    [100, 100, 100, 100, 96]
  );
  assert.deepStrictEqual(asked(), [
    ...range(1, 400).reverse().map(steamID),
    ...range(1001, 1096).map(steamID)
  ]);
  assert.ok(asked().every((id) => !INVALID.includes(id)));
  // Each call's profiles are saved with one statement, and the players Steam left out of it are
  // marked to be tried again with one more.
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'save').map(([, ids]) => ids.length),
    [98, 100, 100, 100, 95]
  );
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'retry later'),
    [
      ['retry later', [steamID(400), steamID(399)]],
      ['retry later', [steamID(1001)]]
    ]
  );
  assert.deepStrictEqual(
    events.find(([what]) => what === 'checked'),
    ['checked', INVALID]
  );
  const saved = users.get(steamID(1096));
  assert.deepStrictEqual(
    [saved.name, saved.profileURL, saved.avatarMedium, saved.lastRefreshedInfo],
    [
      'Player 1096',
      `https://steamcommunity.com/profiles/${steamID(1096)}/`,
      `https://avatars.example/${steamID(1096)}_medium.jpg`,
      NOW
    ]
  );
  // The next run carries on after the last player due a refresh this one took.
  assert.strictEqual(state.get(CURSOR), steamID(1096));
  // The players this run did not take are still due.
  assert.ok(isDueAt(steamID(1097), NOW));
  // The IDs that are not SteamIDs are looked at again once their interval has passed.
  for (const id of INVALID) {
    assert.strictEqual(users.get(id).lastRefreshedInfo, NOW);
    assert.strictEqual(users.get(id).name, null);
  }
  // A player Steam left out is due again a day later, not before.
  for (const id of [steamID(400), steamID(399), steamID(1001)]) {
    assert.strictEqual(users.get(id).name, null);
    assert.ok(!isDueAt(id, NOW + DAY - SECOND), id);
    assert.ok(isDueAt(id, NOW + DAY + SECOND), id);
  }
  // The step says how far it has got, for the run's status.
  assert.deepStrictEqual(
    progress.map(([done]) => done),
    [4, 104, 204, 304, 404, 500]
  );
  assert.ok(progress.every(([, total, unit]) => total === 500 && unit === 'Steam users'));
  assert.deepStrictEqual(levelOne(), []);

  // The next run, an hour later, does not ask Steam again for the players it left out, and carries
  // on with the players due a refresh after the last run's, 200 of them, as no new ones took their
  // slots.
  const second = await update({ at: NOW + 60 * 60 * SECOND });
  assert.deepStrictEqual(asked(), range(1097, 1296).map(steamID));
  assert.deepStrictEqual(second, {
    due: 254,
    new: 0,
    updated: 200,
    missing: 0,
    skipped: 0,
    unsaved: 0,
    left: 54,
    calls: 2
  });
  assert.deepStrictEqual(findsDue(), [['find due after', steamID(1096), 200]]);
  assert.strictEqual(state.get(CURSOR), steamID(1296));

  // The run after takes the rest, and finds no more due from the first player up to where the
  // last run stopped.
  const third = await update({ at: NOW + 2 * 60 * 60 * SECOND });
  assert.deepStrictEqual(asked(), range(1297, 1350).map(steamID));
  assert.deepStrictEqual([third.due, third.updated, third.left], [54, 54, 0]);
  assert.deepStrictEqual(findsDue(), [
    ['find due after', steamID(1296), 200],
    ['find due up to', steamID(1296), 146]
  ]);
  assert.strictEqual(state.get(CURSOR), steamID(1350));

  // A run a day later asks for the players Steam left out once more, from the first player, as the
  // last run took every player due after them. Those it leaves out again wait another day.
  unknown.delete(steamID(399));
  const fourth = await update({ at: NOW + DAY + 2 * 60 * 60 * SECOND });
  assert.deepStrictEqual(asked(), [steamID(399), steamID(400), steamID(1001)]);
  assert.deepStrictEqual(fourth, {
    due: 3,
    new: 0,
    updated: 1,
    missing: 2,
    skipped: 0,
    unsaved: 0,
    left: 0,
    calls: 1
  });
  assert.strictEqual(users.get(steamID(399)).name, 'Player 0399');
  assert.strictEqual(state.get(CURSOR), steamID(1001));
  await update({ at: NOW + DAY + 3 * 60 * 60 * SECOND });
  assert.deepStrictEqual(calls, []);
}

// Each player's refresh interval is 7 days, give or take a day, from their ID, so players refreshed
// in the same run fall due over two days rather than all in the same run: none before 6 days, about
// half by 7, and all by 8. A player's interval stays the same.
{
  reset();
  for (const n of range(1, 1000)) addUser(steamID(n), { refreshed: NOW });
  const dueAt = async (days) => (await update({ at: NOW + days * DAY, refreshPerRun: '0' })).due;
  assert.strictEqual(await dueAt(6), 0);
  const half = await dueAt(7);
  assert.ok(half > 400 && half < 600, `${half} of 1,000 were due after 7 days`);
  assert.ok((await dueAt(6.5)) < half);
  assert.strictEqual(await dueAt(8), 1000);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(interval(steamID(1)), interval(steamID(1)));
  assert.ok(range(1, 1000).every((n) => interval(steamID(n)) >= 6 * DAY));
  assert.ok(range(1, 1000).every((n) => interval(steamID(n)) < 8 * DAY));
}

// Without IMPORTER_STEAM_REFRESH_PER_RUN, a run takes enough players due a refresh to refresh them
// all within 6 days at its schedule, but at least 200 and at most 10,000: for 145,094 players,
// 6,046 a run every 6 hours, 1,008 every hour and 252 every 15 minutes, and 200 every 2 minutes.
assert.strictEqual(MIN_REFRESH_PER_RUN, 200);
assert.strictEqual(MAX_REFRESH_PER_RUN, 10000);
assert.strictEqual(NEW_PER_RUN, 300);
assert.strictEqual(IDS_PER_CALL, 100);
assert.strictEqual(MAX_FAILED_CALLS, 2);
for (const [players, cadence, count] of [
  [145094, 6 * HOURS, 6046],
  [145094, HOURS, 1008],
  [145094, HOURS / 4, 252],
  [145094, 120, 200],
  [0, 6 * HOURS, 200],
  // It grows with the players, up to the most a run may take.
  [239975, 6 * HOURS, 9999],
  [240000, 6 * HOURS, 10000],
  [240001, 6 * HOURS, 10000],
  [2 * 145094, 6 * HOURS, 10000],
  [1000000, 24 * HOURS, 10000]
])
  assert.strictEqual(refreshPerRunFor(players, cadence), count, `${players} ${cadence}`);

// IMPORTER_STEAM_REFRESH_PER_RUN sets how many players due a refresh a run takes, from 0, which
// takes none, up to 10,000, whatever the schedule. Not given, it is what the schedule gives, as is
// an invalid value, with a warning.
{
  for (const [value, count] of [
    [undefined, 6046],
    ['', 6046],
    ['  ', 6046],
    ['0', 0],
    ['1000', 1000],
    [' "5200" ', 5200],
    ["'10000'", 10000]
  ])
    assert.deepStrictEqual({ ...readRefreshPerRun(value, 6046) }, { count }, `${value}`);
  for (const value of ['10001', '-1', '1.5', 'lots', '200 # per run', '1e3'])
    assert.deepStrictEqual(
      { ...readRefreshPerRun(value, 6046) },
      {
        count: 6046,
        warning: `Warning: IMPORTER_STEAM_REFRESH_PER_RUN must be a whole number from 0 to 10,000, not "${value}", so the default for the run's schedule, 6,046, is used.`
      }
    );

  reset();
  for (const n of range(1, 450)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  // With a run every 3 days, 450 players need 225 a run to be refreshed within 6 days.
  assert.strictEqual((await update({ cadenceSeconds: 72 * HOURS })).updated, 225);
  assert.strictEqual(state.get(CURSOR), steamID(225));
  // With a run every 6 hours, the step's default, they would need 19, so it takes 200.
  assert.strictEqual((await update()).updated, 200);
  assert.strictEqual(state.get(CURSOR), steamID(425));
  // The setting wins over the schedule.
  assert.strictEqual((await update({ refreshPerRun: '0', cadenceSeconds: 72 * HOURS })).updated, 0);
  assert.deepStrictEqual(findsDue(), []);
  assert.strictEqual(state.get(CURSOR), steamID(425));
  assert.strictEqual(
    (await update({ refreshPerRun: '10', cadenceSeconds: 72 * HOURS })).updated,
    10
  );
  assert.strictEqual(state.get(CURSOR), steamID(435));
  // The step reads the setting itself when it is not given.
  env.IMPORTER_STEAM_REFRESH_PER_RUN = 'lots';
  const counts = {};
  await updateSteamUserInfo(counts, { now: new Date(NOW) });
  delete env.IMPORTER_STEAM_REFRESH_PER_RUN;
  assert.strictEqual(counts.updated, 15);
  assert.deepStrictEqual(
    logs.filter(({ important }) => important).map(({ message }) => message),
    [
      `Warning: IMPORTER_STEAM_REFRESH_PER_RUN must be a whole number from 0 to 10,000, not "lots", so the default for the run's schedule, 200, is used.`
    ]
  );
  // It carried on after the players the first runs took.
  assert.strictEqual(state.get(CURSOR), steamID(450));
}

// New players come first, and those beyond 300 take the slots of the players due a refresh: with
// 1,000 a run, a run with 1,500 new players takes 1,300 of them and none due a refresh, and moves
// nothing on for the players due. The slots new players leave unused are not given to the players
// due a refresh.
{
  reset();
  for (const n of range(1, 1500)) addUser(steamID(n), { createdAt: NOW - DAY + n * SECOND });
  for (const n of range(5001, 6500)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });

  const first = await update({ refreshPerRun: '1000' });
  assert.deepStrictEqual(asked(), range(201, 1500).reverse().map(steamID));
  assert.deepStrictEqual(
    [first.due, first.new, first.updated, first.left, first.calls],
    [3000, 1500, 1300, 1700, 13]
  );
  assert.deepStrictEqual(events[0], ['find new', 1300]);
  assert.deepStrictEqual(findsDue(), []);
  assert.ok(!state.has(CURSOR));

  // The next run takes the 200 new players left and 1,000 due a refresh, not 1,100.
  const second = await update({ refreshPerRun: '1000' });
  assert.deepStrictEqual(asked(), [
    ...range(1, 200).reverse().map(steamID),
    ...range(5001, 6000).map(steamID)
  ]);
  assert.deepStrictEqual([second.new, second.updated, second.left], [200, 1200, 500]);
  assert.deepStrictEqual(findsDue(), [['find due after', '', 1000]]);
  assert.strictEqual(state.get(CURSOR), steamID(6000));

  // With the default of 200, a run still takes 500 new players.
  reset();
  for (const n of range(1, 600)) addUser(steamID(n), { createdAt: NOW - DAY + n * SECOND });
  for (const n of range(5001, 5100)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  const counts = await update();
  assert.deepStrictEqual(asked(), range(101, 600).reverse().map(steamID));
  assert.deepStrictEqual([counts.updated, counts.left], [500, 200]);
  assert.ok(!state.has(CURSOR));
}

// The players due a refresh are taken in the order of their IDs, after where the last run stopped
// and then from the first, but no more than the run's budget in all.
{
  reset();
  for (const n of range(1, 300)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  state.set(CURSOR, steamID(250));
  const counts = await update({ refreshPerRun: '100' });
  assert.deepStrictEqual(asked(), [...range(251, 300), ...range(1, 50)].map(steamID));
  assert.deepStrictEqual(findsDue(), [
    ['find due after', steamID(250), 100],
    ['find due up to', steamID(250), 50]
  ]);
  assert.deepStrictEqual([counts.due, counts.updated, counts.left], [300, 100, 200]);
  // The next run carries on after the last of them, before where this one started.
  assert.strictEqual(state.get(CURSOR), steamID(50));
}

// Where the next run carries on: after the last player due a refresh up to which each was dealt
// with, and nowhere new when the first was not.
{
  const ids = ['a', 'b', 'c', 'd'];
  assert.strictEqual(nextCursor(ids, new Set(ids)), 'd');
  assert.strictEqual(nextCursor(ids, new Set(['a', 'b', 'd'])), 'b');
  assert.strictEqual(nextCursor(ids, new Set(['b', 'c', 'd'])), null);
  assert.strictEqual(nextCursor([], new Set()), null);
}

// A call that fails is logged with its error, and the next call is still made. Its players stay
// as they were, so they are taken again: the new ones as new, and the next run carries on from
// before the first of those due a refresh. Nothing waits between calls.
{
  reset();
  for (const n of range(1, 50)) addUser(steamID(n));
  for (const n of range(101, 300)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  answer = (ids, call) => {
    if (call === 2) throw unavailable();
    return known(ids);
  };
  const counts = await update();
  assert.deepStrictEqual(
    calls.map((ids) => ids.length),
    [100, 100, 50]
  );
  assert.deepStrictEqual(levelOne(), [
    `Failed to update 100 Steam users: ${unavailable().message}`
  ]);
  assert.strictEqual(logs.find(({ level }) => level === 1).extras[0].name, 'ApiError');
  assert.deepStrictEqual(delays, []);
  assert.deepStrictEqual(counts, {
    due: 250,
    new: 50,
    updated: 150,
    missing: 0,
    skipped: 0,
    unsaved: 0,
    left: 100,
    calls: 3
  });
  // The first call had the 50 new players and the first 50 due, so the second's failed from the
  // 51st due player on.
  assert.ok(isDueAt(steamID(151), NOW) && isDueAt(steamID(250), NOW));
  assert.ok(!isDueAt(steamID(251), NOW));
  assert.strictEqual(state.get(CURSOR), steamID(150));
  answer = null;
  await update();
  assert.deepStrictEqual(asked(), range(151, 250).map(steamID));
}

// When the first call, of new players, fails, the next run still carries on after the players due
// a refresh this one dealt with, never after a new player.
{
  reset();
  for (const n of range(1, 100)) addUser(steamID(n));
  for (const n of range(101, 250)) addUser(steamID(n), { refreshed: NOW - 9 * DAY });
  answer = (ids, call) => {
    if (call === 1) throw unavailable();
    return known(ids);
  };
  const counts = await update();
  assert.deepStrictEqual([counts.calls, counts.updated, counts.left], [3, 150, 100]);
  assert.strictEqual(state.get(CURSOR), steamID(250));
  assert.ok(range(1, 100).every((n) => users.get(steamID(n)).lastRefreshedInfo === null));
}

// Calls that fail between calls that work do not stop the step, as the calls that failed were not
// in a row.
{
  reset();
  for (const n of range(1, 400)) addUser(steamID(n), { createdAt: NOW - DAY + n * SECOND });
  answer = (ids, call) => {
    if (call === 1 || call === 3) throw unavailable();
    return known(ids);
  };
  const counts = await update();
  assert.strictEqual(calls.length, 4);
  assert.deepStrictEqual(levelOne(), [
    `Failed to update 100 Steam users: ${unavailable().message}`,
    `Failed to update 100 Steam users: ${unavailable().message}`
  ]);
  assert.deepStrictEqual([counts.calls, counts.updated, counts.left], [4, 200, 200]);
  // The players of the calls that worked were saved, and those of the calls that failed were not.
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'save').map(([, ids]) => ids),
    [range(201, 300).reverse().map(steamID), range(1, 100).reverse().map(steamID)]
  );
  assert.strictEqual(users.get(steamID(300)).name, 'Player 0300');
  assert.strictEqual(users.get(steamID(400)).lastRefreshedInfo, null);
}

// Once 2 calls in a row have failed, the step stops, as Steam is most likely down and the rest
// would fail too. An answer without a list of players counts as a failed call, and leaves the
// players as they were. The step's counts say how far it got.
{
  reset();
  for (const n of range(1, 300)) addUser(steamID(n));
  answer = () => ({ data: { response: {} } });
  const counts = await update();
  const noList = 'Steam answered GetPlayerSummaries without a list of players.';
  assert.deepStrictEqual(levelOne(), [
    `Failed to update 100 Steam users: ${noList}`,
    `Stopped updating Steam users, as 2 calls in a row failed: ${noList}`
  ]);
  assert.strictEqual(calls.length, 2);
  assert.ok([...users.values()].every((user) => user.lastRefreshedInfo === null));
  assert.deepStrictEqual(counts, {
    due: 300,
    new: 300,
    updated: 0,
    missing: 0,
    skipped: 0,
    unsaved: 0,
    left: 300,
    calls: 2
  });
  assert.deepStrictEqual(progress.at(-1), [0, 300, 'Steam users']);
}

// When Steam refuses the key, the step stops at once, as every other call would be refused too,
// and so it does when Steam still answers 429 after the client's own retries and pauses.
for (const [err, why] of [
  [
    apiError('Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 403', {
      status: 403,
      auth: true
    }),
    'Steam refused the API key'
  ],
  [
    apiError('Steam GET ISteamUser/GetPlayerSummaries/v2 failed after 3 attempts: HTTP 429', {
      status: 429,
      auth: false
    }),
    'Steam is still limiting requests'
  ]
]) {
  reset();
  for (const n of range(1, 300)) addUser(steamID(n));
  answer = () => {
    throw err;
  };
  const counts = await update();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(levelOne(), [`Stopped updating Steam users, as ${why}: ${err.message}`]);
  assert.strictEqual(counts.left, 300);
}

// A step that cannot count the players due counts nothing, rather than saying that none were due.
{
  reset();
  addUser(steamID(1));
  countError = new DatabaseError("Table 'cbl.SteamUsers' doesn't exist", { errno: 1146 });
  const counts = {};
  await assert.rejects(updateSteamUserInfo(counts, { now: new Date(NOW) }), countError);
  assert.deepStrictEqual({ ...counts }, {});
  assert.deepStrictEqual(calls, []);
}

// Players Steam gives that were not asked for are left out, and none is added.
{
  reset();
  addUser(steamID(1));
  answer = (ids) => {
    const answered = known([...ids, steamID(2)]);
    answered.data.response.players.push({ steamid: 1 }, null);
    return answered;
  };
  const counts = await update();
  assert.deepStrictEqual([counts.updated, counts.missing], [1, 0]);
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'save'),
    [['save', [steamID(1)]]]
  );
  assert.deepStrictEqual([...users.keys()], [steamID(1)]);
}

// Saving a profile only updates its player's row, so a player removed while Steam was asked is not
// added again.
{
  reset();
  for (const n of range(1, 3)) addUser(steamID(n));
  const removed = steamID(2);
  answer = (ids) => {
    users.delete(removed);
    return known(ids);
  };
  await update();
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'save'),
    [['save', [steamID(3), steamID(2), steamID(1)]]]
  );
  assert.deepStrictEqual([...users.keys()], [steamID(1), steamID(3)]);
  assert.deepStrictEqual(
    [users.get(steamID(1)).name, users.get(steamID(3)).name],
    ['Player 0001', 'Player 0003']
  );
}

// A statement that saves profiles and fails in a way that could pass, e.g. in a deadlock, is run
// again. One that fails in another way, e.g. as a name holds a character the table cannot store,
// is run again a profile at a time, so only the profiles that cannot be saved are left out. Those
// are tried again a day later, and posted about once, with the first error.
{
  reset();
  for (const n of range(1, 5)) addUser(steamID(n));
  const incorrect = new DatabaseError(
    "Incorrect string value: '\\xF0\\x9F\\x98\\x80' for column 'name'",
    {
      errno: 1366
    }
  );
  saveErrors.push(
    { when: (ids) => ids.length === 5, errors: [deadlock(), incorrect] },
    { when: (ids) => ids.includes(steamID(3)), errors: [incorrect] }
  );
  const counts = await update();
  assert.deepStrictEqual(delays, [5000]);
  // New players made at the same time are taken by their IDs, the highest first.
  assert.deepStrictEqual(
    events.filter(([what]) => what === 'save' || what === 'retry later'),
    [
      ['save', [steamID(5)]],
      ['save', [steamID(4)]],
      ['save', [steamID(2)]],
      ['save', [steamID(1)]],
      ['retry later', [steamID(3)]]
    ]
  );
  assert.deepStrictEqual([counts.updated, counts.unsaved, counts.missing], [4, 1, 0]);
  assert.ok(
    isDueAt(steamID(3), NOW + DAY + SECOND) && !isDueAt(steamID(3), NOW + 2 * 60 * 60 * SECOND)
  );
  assert.deepStrictEqual(levelOne(), [
    `Could not save the Steam profiles of 1 Steam users, e.g. ${steamID(3)}, so they are tried again in a day: ${incorrect.message}`
  ]);
  // There were no players due a refresh, so there is nowhere new to carry on from.
  assert.ok(!state.has(CURSOR));
}

// A profile saved on its own that keeps failing in a way that could pass, e.g. in deadlocks, fails
// the step after its attempts, rather than being counted as one that cannot be saved.
{
  reset();
  for (const n of range(1, 3)) addUser(steamID(n));
  const incorrect = new DatabaseError("Incorrect string value: '\\xF0\\x9F\\x98\\x80'", {
    errno: 1366
  });
  const deadlocks = range(1, 5).map(deadlock);
  saveErrors.push(
    { when: (ids) => ids.length === 3, errors: [incorrect] },
    { when: (ids) => ids.length === 1 && ids[0] === steamID(3), errors: [...deadlocks] }
  );
  const counts = {};
  await assert.rejects(updateSteamUserInfo(counts, { now: new Date(NOW) }), deadlocks[4]);
  assert.deepStrictEqual(delays, [5000, 5000, 5000, 5000]);
  assert.deepStrictEqual([counts.updated, counts.unsaved], [0, 0]);
  assert.deepStrictEqual(levelOne(), []);
}

// A run that is asked to stop does so between calls: the profiles of the call under way are saved,
// and the next call is not made. A profile that could not be saved is still posted about.
{
  reset();
  for (const n of range(1, 250)) addUser(steamID(n));
  answer = (ids) => {
    control.requestStop('it received SIGTERM');
    return known(ids);
  };
  const tooLong = new DatabaseError("Data too long for column 'name' at row 1", { errno: 1406 });
  saveErrors.push(
    { when: (ids) => ids.length > 1, errors: [tooLong] },
    { when: (ids) => ids.includes(steamID(250)), errors: [tooLong] }
  );
  const counts = {};
  await assert.rejects(updateSteamUserInfo(counts, { now: new Date(NOW) }), {
    name: 'RunStopped'
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(events.filter(([what]) => what === 'save').length, 99);
  assert.deepStrictEqual(
    [counts.updated, counts.unsaved, counts.left, counts.calls],
    [99, 1, 150, 1]
  );
  assert.deepStrictEqual(levelOne(), [
    `Could not save the Steam profiles of 1 Steam users, e.g. ${steamID(250)}, so they are tried again in a day: ${tooLong.message}`
  ]);
}

console.log(
  'Steam profile checks passed: the budget of each run from its schedule, new players first and in the slots of those due, the refresh interval, players Steam leaves out tried again a day later, invalid IDs never sent, saves, failed calls and stops.'
);
