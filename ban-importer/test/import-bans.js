import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isSameBattlemetricsID, {
  normaliseBattlemetricsID
} from '../../scbl-lib/utils/battlemetrics-id.js';
import classifyBanReason from '../../scbl-lib/utils/classify-ban-reason.js';
import describeError from '../../scbl-lib/utils/describe-error.js';

// Exercise BanImporter, BanFetcher, apply-list.js and planner.js together without a database or
// network requests. The database is a stand-in that keeps ban lists, Steam users, bans, the bans recorded as
// missing, the lists' sync state and CBL's export ban lists in memory, and runs the statements the
// importer sends as MySQL would, in transactions that a failure rolls back. BattleMetrics and remote
// lists answer from the tables below, and waits between attempts are skipped. The run holds its run
// lock, so the importer may remove bans.

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

const banLists = new Map();
const steamUsers = new Map();
const bans = new Map();
// The bans recorded as missing, by `${banList},${banId}`.
const pendingRows = new Map();
const events = [];
const logs = [];
const delays = [];
// Errors to throw from the statement that writes a ban, by the ban's ID, one each time a statement
// writes it, alone or with others.
const writeErrors = new Map();
// Called with the IDs of the bans each statement that writes bans writes, before it writes them,
// and with a list's ID as its bans are counted for its sync state, after its import.
let onWrite = null;
let onCount = null;
// Errors for the next statement that records missing bans, and the next that removes bans, to fail
// with.
let pendingError = null;
let removeError = null;
let transactions = 0;
// Lines for the log channel must be logged as important, which none of the importer's level-1
// lines may skip.
let verboseLevelOneLines = 0;

const tick = () => new Promise(setImmediate);
// A time as MySQL's DATETIME columns keep it, from what a statement gives: text in UTC.
const dateOf = (value) =>
  value === null || value === undefined ? null : new Date(`${String(value).replace(' ', 'T')}Z`);

// A stored ban as MySQL gives it back to a raw query: its expiry as a Date, and whether it has
// expired as 1 or 0.
const asRow = (ban) => ({
  id: ban.id,
  steamUser: ban.steamUser,
  expires: ban.expires === null ? null : new Date(ban.expires.getTime()),
  expired: ban.expired === null ? null : Number(ban.expired),
  reason: ban.reason,
  rawReason: ban.rawReason,
  rawNote: ban.rawNote
});
// The values of a statement's rows, given n values at a time.
const rowsOf = (replacements, n) =>
  Array.from({ length: replacements.length / n }, (_, i) => replacements.slice(i * n, i * n + n));

// Run a statement on the stand-in database, as MySQL would, and say what it did in events. Each
// statement the importer sends is known by its text.
async function runStatement(sql, replacements, transaction) {
  const tx = transaction?.id ?? null;
  if (
    sql ===
    'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ?'
  ) {
    events.push(['select', replacements[0]]);
    return [...bans.values()].filter((ban) => ban.banList === replacements[0]).map(asRow);
  }
  if (
    sql ===
    'SELECT id, steamUser, expires, expired, reason, rawReason, rawNote FROM Bans WHERE banList = ? AND id IN (?)'
  ) {
    const [list, ids] = replacements;
    events.push(['select some', list, [...ids]]);
    return [...bans.values()]
      .filter((ban) => ban.banList === list && ids.includes(ban.id))
      .map(asRow);
  }
  // Each list's first missing ban that is not held for an admin, and how many are, as MySQL gives
  // them: a DATETIME as a Date, and a SUM as text.
  if (
    sql ===
    'SELECT banList, MIN(CASE WHEN heldAt IS NULL THEN firstMissingAt END) AS firstMissingAt, SUM(heldAt IS NOT NULL) AS held FROM BanListPendingRemovals GROUP BY banList'
  ) {
    const summaries = new Map();
    for (const row of pendingRows.values()) {
      const summary = summaries.get(row.banList) ?? { first: null, held: 0 };
      if (row.heldAt !== null) summary.held++;
      else summary.first = Math.min(summary.first ?? Infinity, row.firstMissingAt);
      summaries.set(row.banList, summary);
    }
    return [...summaries].map(([banList, { first, held }]) => ({
      banList,
      firstMissingAt: first === null ? null : new Date(first),
      held: String(held)
    }));
  }
  if (
    sql === 'SELECT banId, firstMissingAt, heldAt FROM BanListPendingRemovals WHERE banList = ?'
  ) {
    events.push(['select pending', replacements[0]]);
    return [...pendingRows.values()]
      .filter((row) => row.banList === replacements[0])
      .map(({ banId, firstMissingAt, heldAt }) => ({
        banId,
        firstMissingAt: new Date(firstMissingAt),
        heldAt: heldAt === null ? null : new Date(heldAt)
      }));
  }
  if (/^INSERT IGNORE INTO SteamUsers \(id, createdAt, updatedAt\) VALUES /.test(sql)) {
    const ids = rowsOf(replacements, 3).map(([id]) => id);
    events.push(['add users', ids, tx]);
    for (const id of ids) if (!steamUsers.has(id)) steamUsers.set(id, newUser(id));
    return [{ affectedRows: 0 }, { affectedRows: 0 }];
  }
  if (
    /^INSERT INTO Bans \(id, created, expires, expired, reason, rawReason, rawNote, steamUser, banList, createdAt, updatedAt\) VALUES .* AS new ON DUPLICATE KEY UPDATE steamUser = new\.steamUser, expires = new\.expires, expired = new\.expired, reason = new\.reason, rawReason = new\.rawReason, rawNote = new\.rawNote, updatedAt = new\.updatedAt$/.test(
      sql
    )
  ) {
    const rows = rowsOf(replacements, 11);
    const ids = rows.map(([id]) => id);
    if (onWrite) await onWrite(ids);
    await tick();
    for (const id of ids) {
      const error = writeErrors.get(id)?.shift();
      if (error) throw error;
    }
    events.push(['write', ids, tx]);
    let affected = 0;
    for (const [
      id,
      created,
      expires,
      expired,
      reason,
      rawReason,
      rawNote,
      steamUser,
      list
    ] of rows) {
      if (!banLists.has(list)) throw new ForeignKeyConstraintError('banList');
      if (!steamUsers.has(steamUser)) throw new ForeignKeyConstraintError('steamUser');
      const values = { steamUser, expires: dateOf(expires), expired, reason, rawReason, rawNote };
      const ban = bans.get(id);
      if (ban) {
        Object.assign(ban, values);
        affected += 2;
      } else {
        bans.set(id, { id, created: dateOf(created), ...values, banList: list });
        affected++;
      }
    }
    return [0, affected];
  }
  if (
    sql ===
    'UPDATE SteamUsers SET lastRefreshedInfo = NULL, lastRefreshedExport = NULL, lastRefreshedReputationPoints = NULL, lastRefreshedReputationRank = NULL WHERE id IN (?)'
  ) {
    const ids = [...replacements[0]];
    events.push(['flags', ids, tx]);
    for (const id of ids)
      if (steamUsers.has(id))
        Object.assign(steamUsers.get(id), {
          lastRefreshedInfo: null,
          lastRefreshedExport: null,
          lastRefreshedReputationPoints: null,
          lastRefreshedReputationRank: null
        });
    return [{ affectedRows: ids.length }, { affectedRows: ids.length }];
  }
  if (sql === 'DELETE FROM Bans WHERE banList = ? AND id IN (?)') {
    const [list, ids] = replacements;
    if (removeError) {
      const error = removeError;
      removeError = null;
      throw error;
    }
    events.push(['remove', [...ids], tx]);
    let removed = 0;
    for (const id of ids)
      if (bans.get(id)?.banList === list) {
        bans.delete(id);
        removed++;
      }
    return [{ affectedRows: removed }, { affectedRows: removed }];
  }
  if (sql === 'DELETE FROM BanListPendingRemovals WHERE banList = ? AND banId IN (?)') {
    const [list, ids] = replacements;
    events.push(['clear pending', [...ids], tx]);
    for (const id of ids) pendingRows.delete(`${list},${id}`);
    return [{ affectedRows: 0 }, { affectedRows: 0 }];
  }
  if (
    /^INSERT INTO BanListPendingRemovals \(banList, banId, firstMissingAt, lastMissingAt, heldAt\) VALUES .* AS new ON DUPLICATE KEY UPDATE lastMissingAt = new\.lastMissingAt, heldAt = COALESCE\(BanListPendingRemovals\.heldAt, new\.heldAt\)$/.test(
      sql
    )
  ) {
    const rows = rowsOf(replacements, 5);
    const held = rows.some(([, , , , heldAt]) => heldAt !== null);
    events.push([held ? 'save held' : 'save pending', rows.map(([, id]) => id), tx]);
    if (pendingError) {
      const error = pendingError;
      pendingError = null;
      throw error;
    }
    for (const [list, banId, first, last, heldAt] of rows) {
      if (!banLists.has(list)) throw new ForeignKeyConstraintError('banList');
      const key = `${list},${banId}`;
      const row = pendingRows.get(key);
      if (row)
        Object.assign(row, {
          lastMissingAt: dateOf(last).getTime(),
          heldAt: row.heldAt ?? dateOf(heldAt)?.getTime() ?? null
        });
      else
        pendingRows.set(key, {
          banList: list,
          banId,
          firstMissingAt: dateOf(first).getTime(),
          lastMissingAt: dateOf(last).getTime(),
          heldAt: dateOf(heldAt)?.getTime() ?? null
        });
    }
    return [0, rows.length];
  }
  if (
    sql ===
    'UPDATE BanListPendingRemovals SET firstMissingAt = ?, lastMissingAt = ?, heldAt = NULL WHERE banList = ? AND heldAt IS NOT NULL'
  ) {
    const [first, last, list] = replacements;
    const released = [...pendingRows.values()].filter(
      (row) => row.banList === list && row.heldAt !== null
    );
    events.push(['release held', released.map(({ banId }) => banId), tx]);
    for (const row of released)
      Object.assign(row, {
        firstMissingAt: dateOf(first).getTime(),
        lastMissingAt: dateOf(last).getTime(),
        heldAt: null
      });
    return [{ affectedRows: released.length }, { affectedRows: released.length }];
  }
  throw new Error(`Unexpected statement: ${sql}`);
}

// The tables a transaction may change, so a failure can put them back as they were.
const snapshot = () => ({
  steamUsers: new Map([...steamUsers].map(([id, user]) => [id, { ...user }])),
  bans: new Map([...bans].map(([id, ban]) => [id, { ...ban }])),
  pendingRows: new Map([...pendingRows].map(([key, row]) => [key, { ...row }]))
});
function restore(saved) {
  for (const [store, copy] of [
    [steamUsers, saved.steamUsers],
    [bans, saved.bans],
    [pendingRows, saved.pendingRows]
  ]) {
    store.clear();
    for (const [key, value] of copy) store.set(key, value);
  }
}

const QueryTypes = { SELECT: 'SELECT' };
const sequelize = {
  query: (sql, { replacements, transaction } = {}) => runStatement(sql, replacements, transaction),
  async transaction(callback) {
    const transaction = { id: ++transactions };
    const saved = snapshot();
    events.push(['begin', transaction.id]);
    try {
      const value = await callback(transaction);
      events.push(['commit', transaction.id]);
      return value;
    } catch (err) {
      restore(saved);
      events.push(['rollback', transaction.id]);
      throw err;
    }
  }
};

const Ban = {
  async count({ where }) {
    if (onCount) onCount(where.banList);
    return [...bans.values()].filter((ban) => ban.banList === where.banList).length;
  }
};

// The lists' BanListSyncs rows, by list. A row is saved as MySQL's INSERT ... ON DUPLICATE KEY
// UPDATE saves it: a new row with all the values given, and an existing one with only the fields
// named. The row of a list that is gone fails its foreign key, as in MySQL. Each save is recorded,
// and syncError, if set, fails every save.
const syncRows = new Map();
const syncSaves = [];
let syncError = null;
const BanListSync = {
  async findAll({ raw }) {
    assert.strictEqual(raw, true);
    return Array.from(syncRows.values(), (row) => ({ ...row }));
  },
  async upsert(values, { fields }) {
    syncSaves.push({ values: { ...values }, fields: [...fields] });
    if (syncError) throw syncError;
    if (!banLists.has(values.banList)) throw new ForeignKeyConstraintError('banList');
    const row = syncRows.get(values.banList);
    if (!row) syncRows.set(values.banList, { ...values });
    else for (const field of fields) row[field] = values[field];
  }
};

// CBL's export ban lists, as { id, battlemetricsID }.
const exportBanLists = [];
const ExportBanList = {
  async findAll({ attributes, raw }) {
    assert.deepStrictEqual([...attributes], ['id', 'battlemetricsID']);
    assert.strictEqual(raw, true);
    return exportBanLists.map((exportBanList) => ({ ...exportBanList }));
  }
};

const BanList = {
  async findAll() {
    return Array.from(banLists.values(), ({ id, type, source }) => ({ id, type, source }));
  },
  async findByPk(id) {
    events.push(['read list', id]);
    return banLists.get(id) || null;
  }
};

// BattleMetrics lists, by source: each page is a list of [uid, SteamID, reason, identifiers]
// entries, an error, or a function that returns either when the page is fetched. Each page gives
// BattleMetrics' count of the list's bans: the number of entries on its pages, including those
// that pages made by functions will give (their entries), unless battlemetricsTotals gives
// another count, none (null), or a function that gives the count for each page by its index.
const battlemetricsLists = new Map();
const battlemetricsTotals = new Map();
const battlemetricsRequests = [];
// Each request's parameters, as the importer sent them.
const battlemetricsParams = [];

// BattleMetrics' list of the ban lists CBL can see, read a page at a time by
// readBattlemetricsPages: the sources of all the BattleMetrics lists, unless visibleBanLists is set
// to the IDs it gives instead, or to an error.
let visibleBanLists = null;
const banListReads = [];
async function readBattlemetricsPages(endpoint, params) {
  banListReads.push([endpoint, params]);
  const visible =
    visibleBanLists ??
    Array.from(battlemetricsLists.keys()).filter((source) =>
      Array.from(banLists.values()).some((banList) => banList.source === source)
    );
  if (visible instanceof Error) throw visible;
  return visible.map((id) => ({ type: 'banList', id, attributes: { name: `List ${id}` } }));
}
const record = ([uid, steamUser, reason = 'Cheating', identifiers]) => ({
  type: 'ban',
  attributes: {
    uid,
    timestamp: '2026-01-01T00:00:00.000Z',
    expires: null,
    reason,
    note: null,
    identifiers: identifiers ?? [{ type: 'steamID', identifier: steamUser }]
  }
});
const countOf = (pages) =>
  pages.reduce(
    (count, page) => count + (Array.isArray(page) ? page.length : (page?.entries?.length ?? 0)),
    0
  );
async function battlemetrics(method, endpoint, params) {
  battlemetricsRequests.push(params['filter[banList]']);
  battlemetricsParams.push({ ...params });
  const pages = battlemetricsLists.get(params['filter[banList]']);
  const index = Number(params['page[key]'] || 0);
  const page = typeof pages[index] === 'function' ? pages[index]() : pages[index];
  if (page instanceof Error) throw page;
  const next =
    index + 1 < pages.length
      ? `https://api.battlemetrics.com/bans?filter[banList]=${params['filter[banList]']}&page[key]=${index + 1}&page[size]=100`
      : null;
  let total = battlemetricsTotals.has(params['filter[banList]'])
    ? battlemetricsTotals.get(params['filter[banList]'])
    : countOf(pages);
  if (typeof total === 'function') total = total(index);
  const meta = total === null ? undefined : { total };
  return { data: { meta, data: page.map(record), links: { next } } };
}
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
// A page that fails the first time it is fetched, and returns the entries after that.
const failsOnce = (entries, error = httpError(502)) => {
  let fetched = false;
  const page = () => {
    if (fetched) return entries;
    fetched = true;
    return error;
  };
  page.entries = entries;
  return page;
};

// Remote lists, by URL: the body of the file, or an error, or { status, data, headers } to answer
// with. Each request is recorded with the headers it sent.
const remoteLists = new Map();
const remoteRequests = [];
const remoteHeaders = [];

const env = {};
const dependencies = {
  axios: {
    default: {
      async get(url, options) {
        remoteRequests.push(url);
        remoteHeaders.push({ ...options?.headers });
        const body = remoteLists.get(url);
        if (body instanceof Error) throw body;
        if (body && typeof body === 'object') {
          if (!options.validateStatus(body.status))
            throw Object.assign(new Error(`Request failed with status code ${body.status}`), {
              response: { status: body.status }
            });
          return body;
        }
        return { status: 200, data: body, headers: {} };
      }
    }
  },
  crypto: { createHash },
  'scbl-lib/apis': { battlemetrics, readBattlemetricsPages },
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/importer-models': { BanListSync },
  'scbl-lib/db/models': { Ban, BanList, ExportBanList },
  'scbl-lib/db/sequelize': {
    ForeignKeyConstraintError,
    QueryTypes,
    ValidationError,
    isDatabaseUnavailable: (err) => err instanceof ConnectionError
  },
  'scbl-lib/utils': {
    classifyBanReason,
    describeError,
    isSameBattlemetricsID,
    Logger: {
      verbose: (module, level, message) => {
        if (level === 1) verboseLevelOneLines++;
        logs.push({ level, message });
      },
      // The import no longer posts a progress bar, as the run's status shows how far it has got,
      // so the logger has none to give it.
      important: (module, message) => logs.push({ level: 1, message, important: true })
    },
    normaliseBattlemetricsID
  }
};

const context = vm.createContext({
  URL,
  AbortSignal,
  process: { env },
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  },
  clearTimeout: () => {}
});
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const module = await load('../src/ban-importer.js');
// The importer, the fetcher and apply-list.js share the real run-control.js.
const runControl = load('../src/run-control.js');
// The importer and ban-list-sync.js share the real planner.js.
const planner = load('../src/planner.js');
const link = async (specifier) => {
  if (specifier === './ban-fetcher.js') return load('../src/ban-fetcher.js');
  if (specifier === './steam-id.js') return load('../src/steam-id.js');
  if (specifier === './ban-list-sync.js') return load('../src/ban-list-sync.js');
  if (specifier === './apply-list.js') return load('../src/apply-list.js');
  if (specifier === './planner.js') return planner;
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
};
await module.link(link);
await module.evaluate();
const BanImporter = module.namespace.default;
const control = (await runControl).namespace;
control.setRunLock({ isHeld: async () => true });

const FRESH = 'refreshed';
function user(id) {
  return {
    id,
    lastRefreshedInfo: FRESH,
    lastRefreshedExport: FRESH,
    lastRefreshedReputationPoints: FRESH,
    lastRefreshedReputationRank: FRESH
  };
}
// A player added by the import, whose times of update are NULL, as MySQL makes them.
function newUser(id) {
  return {
    id,
    lastRefreshedInfo: null,
    lastRefreshedExport: null,
    lastRefreshedReputationPoints: null,
    lastRefreshedReputationRank: null
  };
}
const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;

function reset() {
  for (const store of [
    banLists,
    steamUsers,
    bans,
    pendingRows,
    writeErrors,
    remoteLists,
    battlemetricsLists,
    battlemetricsTotals,
    syncRows
  ])
    store.clear();
  for (const list of [
    events,
    logs,
    delays,
    remoteRequests,
    remoteHeaders,
    battlemetricsRequests,
    battlemetricsParams,
    banListReads,
    syncSaves,
    exportBanLists
  ])
    list.length = 0;
  onWrite = null;
  onCount = null;
  pendingError = null;
  removeError = null;
  syncError = null;
  visibleBanLists = null;
  transactions = 0;
  for (const name of [
    'IMPORTER_ALLOW_MASS_REMOVAL',
    'IMPORTER_ACCESS_CHECK',
    'IMPORTER_SCAN_COUNT_CHECK',
    'IMPORTER_SCAN_COUNT_CHECK_SKIP',
    'IMPORTER_DRY_RUN',
    'IMPORTER_APPLY_STEAMID_MOVES',
    'IMPORTER_HEAD_POLL',
    'IMPORTER_DRIFT',
    'IMPORTER_FULL_SCAN_MINUTES'
  ])
    delete env[name];
  // The checks before the head polls' own read every list in full on every run, as runs did before
  // head polls, which IMPORTER_HEAD_POLL=0 keeps them doing. Those checks run their lists again
  // within seconds, which head polls would only poll.
  env.IMPORTER_HEAD_POLL = '0';
}

// A ban as the import stores it from a BattleMetrics entry [uid, SteamID, reason].
function storedBan(id, uid, steamUser, reason = 'Cheating') {
  return {
    id: `${id},${uid}`,
    created: new Date('2026-01-01T00:00:00.000Z'),
    expires: null,
    expired: false,
    reason: classifyBanReason(reason, null),
    rawReason: reason,
    rawNote: null,
    steamUser,
    banList: id
  };
}
// Add a BattleMetrics ban list with stored bans, each [uid, SteamID], and the pages it will return.
function battlemetricsList(id, stored, pages, source = `bm-${id}`) {
  banLists.set(id, { id, type: 'battlemetrics', source });
  for (const [uid, steamUser] of stored) {
    steamUsers.set(steamUser, user(steamUser));
    bans.set(`${id},${uid}`, storedBan(id, uid, steamUser));
  }
  battlemetricsLists.set(source, pages);
}
// Add a remote ban list with a stored ban for each of the players, and the body it will return.
function remoteList(id, players, body) {
  const source = `https://bans.example/${id}.txt`;
  banLists.set(id, { id, type: 'remote', source });
  remoteLists.set(source, body);
  for (const n of players) {
    steamUsers.set(steamID(n), user(steamID(n)));
    bans.set(`${id},${steamID(n)},null`, {
      id: `${id},${steamID(n)},null`,
      created: new Date('2026-01-01T00:00:00.000Z'),
      expires: null,
      expired: false,
      reason: classifyBanReason('Cheating'),
      rawReason: 'Cheating',
      rawNote: null,
      steamUser: steamID(n),
      banList: id
    });
  }
}
const pairs = (prefix, from, to) =>
  Array.from({ length: to - from }, (_, i) => [`${prefix}${from + i}`, steamID(from + i)]);
const storedIDs = (list) =>
  [...bans.values()].filter((ban) => ban.banList === list).map((b) => b.id);
const pendingIDs = (list) =>
  [...pendingRows.values()].filter((row) => row.banList === list).map((row) => row.banId);
const heldIDs = (list) =>
  [...pendingRows.values()]
    .filter((row) => row.banList === list && row.heldAt !== null)
    .map((row) => row.banId);
const logged = (level, pattern) =>
  logs.filter((log) => log.level === level && pattern.test(log.message));
const run = (options) => new BanImporter(options).importBans();
// What the import wrote: the IDs of the bans written, the bans removed, and the players queued.
const written = () => events.filter(([type]) => type === 'write').flatMap(([, ids]) => ids);
const removedIDs = () => events.filter(([type]) => type === 'remove').flatMap(([, ids]) => ids);
const writes = () =>
  events.filter(([type]) =>
    [
      'write',
      'remove',
      'save pending',
      'save held',
      'clear pending',
      'release held',
      'flags',
      'add users'
    ].includes(type)
  );
// What happened in a transaction, in order.
const inTransaction = (tx) =>
  events
    .filter(([type, first, second]) =>
      ['begin', 'commit', 'rollback'].includes(type) ? first === tx : second === tx
    )
    .map(([type]) => type);
// Make the recorded missing bans of a list look as if they were first missing, and held if they
// are, minutes earlier, as though that long has passed since the run that recorded them.
function age(list, minutes) {
  for (const row of pendingRows.values())
    if (row.banList === list) {
      row.firstMissingAt -= minutes * 60 * 1000;
      row.lastMissingAt -= minutes * 60 * 1000;
      if (row.heldAt !== null) row.heldAt -= minutes * 60 * 1000;
    }
}

// Each run ends with one line that sums up the import, printed to the console only, as the run's
// status message in Discord shows the same totals. Level-1 lines are about lists that need looking
// at.
const SUMMARY =
  /^Got [\d,]+ deleted bans?\. Imported [\d,]+ (of [\d,]+ )?ban lists?( before the run stopped)?: /;
const warnings = () => logs.filter((log) => log.level === 1 && !SUMMARY.test(log.message));
function summary() {
  const lines = logs.filter((log) => SUMMARY.test(log.message));
  assert.strictEqual(lines.length, 1, 'One summary line per run');
  assert.strictEqual(lines[0].level, 2, 'The summary line is not posted to Discord');
  assert.ok(!lines[0].important);
  return lines[0].message;
}

// A list that fails part-way through keeps every stored ban, and none of its bans are saved, while
// a complete list in the same run loses exactly the bans it no longer has.
reset();
battlemetricsList(1, pairs('a', 0, 5), [
  pairs('a', 0, 2),
  new Error('Request failed with status code 500')
]);
battlemetricsList(2, pairs('b', 0, 4), [
  pairs('b', 0, 2),
  [...pairs('b', 3, 4), ['b9', steamID(9)]]
]);
let results = await run();
assert.deepStrictEqual(storedIDs(1), ['1,a0', '1,a1', '1,a2', '1,a3', '1,a4']);
assert.ok(!written().some((id) => id.startsWith('1,')));
assert.strictEqual(results[0].error, 'Error: Request failed with status code 500');
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 1\) while fetching it, so none of its bans were removed\. Error: Request failed with status code 500$/
  ).length,
  1
);
// It is tried again after the other list, a minute later, and fails the same way.
assert.deepStrictEqual(battlemetricsRequests, ['bm-1', 'bm-1', 'bm-2', 'bm-2', 'bm-1', 'bm-1']);
assert.deepStrictEqual(delays, [60 * 1000]);
assert.strictEqual(results[0].attempt, 2);
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 1\) again while fetching it, so none of its bans were removed\. Error: Request failed with status code 500$/
  ).length,
  1
);
assert.deepStrictEqual(storedIDs(2), ['2,b0', '2,b1', '2,b3', '2,b9']);
// Only the new ban is written, in one transaction that adds its player and queues it for an update.
// The unchanged bans are not written at all.
assert.deepStrictEqual(
  writes().map(([type, ids]) => [type, ids]),
  [
    ['add users', [steamID(9)]],
    ['write', ['2,b9']],
    ['flags', [steamID(9)]],
    ['flags', [steamID(2)]],
    ['remove', ['2,b2']],
    ['clear pending', ['2,b2']]
  ]
);
// The players who lost a ban are queued for an update in the same transaction as the removal.
const removalTx = events.find(([type]) => type === 'remove')[2];
assert.deepStrictEqual(inTransaction(removalTx), [
  'begin',
  'flags',
  'remove',
  'clear pending',
  'commit'
]);
assert.strictEqual(steamUsers.get(steamID(2)).lastRefreshedInfo, null);
assert.strictEqual(steamUsers.get(steamID(3)).lastRefreshedInfo, FRESH);
// The new ban's player is queued for an update too, including its Steam profile.
assert.strictEqual(steamUsers.get(steamID(9)).lastRefreshedReputationPoints, null);
assert.strictEqual(steamUsers.get(steamID(9)).lastRefreshedInfo, null);
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 2\): 4 bans fetched, 1 new, 0 updated, 1 removed\.$/).length,
  1
);
assert.strictEqual(logged(2, /^Found new ban \(ID: 2,b9\) in ban list \(ID: 2\)\.$/).length, 1);
assert.deepStrictEqual(
  Array.from(results, ({ id, fetched, created, removed }) => [id, fetched, created, removed]),
  [
    [1, 0, 0, 0],
    [2, 4, 1, 1]
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 2 ban lists: 4 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 1 list failed.'
);

// A second run with nothing changed reads each list's stored bans and its missing bans, and
// writes nothing at all: no ban, no player and no record of a missing ban.
events.length = 0;
logs.length = 0;
battlemetricsLists.set('bm-1', [pairs('a', 0, 5)]);
await run();
await run();
events.length = 0;
logs.length = 0;
results = await run();
assert.deepStrictEqual(writes(), []);
assert.deepStrictEqual(
  events.filter(([type]) => type !== 'read list'),
  [
    ['select', 1],
    ['select pending', 1],
    ['select', 2],
    ['select pending', 2]
  ]
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 2 ban lists: 9 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 0 lists failed.'
);

// The import reports the same totals for the run record, with each list's own counts and what went
// wrong. Before it has run, it reports nothing.
reset();
battlemetricsList(1, pairs('a', 0, 5), [
  pairs('a', 0, 2),
  new Error('Request failed with status code 500')
]);
battlemetricsList(2, pairs('b', 0, 4), [
  pairs('b', 0, 2),
  [...pairs('b', 3, 4), ['b9', steamID(9)]]
]);
const reporter = new BanImporter();
// Copied into this test's own objects, as the report is made in the importer's context.
const report = () => JSON.parse(JSON.stringify(reporter.report()));
assert.deepStrictEqual(report(), {
  lists: 0,
  imported: 0,
  fetched: 0,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  pending: 0,
  moves: 0,
  failedLists: 0,
  selfImports: 0,
  accessLost: 0,
  headPolls: 0,
  fullReads: 0,
  accessCheck: 'unused',
  requests: { head: 0, follow: 0, full: 0 },
  banLists: []
});
await reporter.importBans();
// A list's state is given when it is not ok, and the access check was read. Both lists are new, so
// they are read in full, and every request is one of a full read, the failed list's both times.
assert.deepStrictEqual(report(), {
  lists: 2,
  imported: 2,
  fetched: 4,
  new: 1,
  updated: 0,
  removed: 1,
  held: 0,
  pending: 0,
  moves: 0,
  failedLists: 1,
  selfImports: 0,
  accessLost: 0,
  headPolls: 0,
  fullReads: 2,
  accessCheck: 'ok',
  requests: { head: 0, follow: 0, full: 6 },
  banLists: [
    {
      id: 1,
      fetched: 0,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      read: 'full',
      reason: 'new',
      state: 'failing',
      attempt: 2,
      error: 'Error: Request failed with status code 500',
      stage: 'fetching it'
    },
    {
      id: 2,
      fetched: 4,
      new: 1,
      updated: 0,
      removed: 1,
      held: 0,
      read: 'full',
      reason: 'new',
      stored: 4
    }
  ]
});

// Every write has finished before any of the list's bans are removed. The bans it had are read
// before its bans are written, so what it lost is measured against the bans it had before the run.
reset();
battlemetricsList(3, pairs('c', 0, 6), [
  pairs('c', 0, 3),
  [...pairs('c', 4, 6), ['c7', steamID(7)]]
]);
await run();
const select = events.findIndex(([type, list]) => type === 'select' && list === 3);
const firstWrite = events.findIndex(([type]) => type === 'write');
assert.ok(select >= 0 && select < firstWrite);
const writeTx = events[firstWrite][2];
const removeAt = events.findIndex(([type]) => type === 'remove');
assert.ok(removeAt > events.findIndex(([type, tx]) => type === 'commit' && tx === writeTx));
assert.deepStrictEqual(storedIDs(3), ['3,c0', '3,c1', '3,c2', '3,c4', '3,c5', '3,c7']);

// A list that returns no bans keeps its stored bans, with a warning that says how to remove them.
reset();
battlemetricsList(4, pairs('d', 0, 5), [[]]);
results = await run();
assert.strictEqual(storedIDs(4).length, 5);
assert.deepStrictEqual(removedIDs(), []);
assert.deepStrictEqual(pendingIDs(4), []);
assert.strictEqual(results[0].hold, 'empty');
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 4\): it returned no bans, so its 5 stored bans were kept in case the list is broken\. If the list really is empty, set IMPORTER_ALLOW_MASS_REMOVAL=4 for one run\.$/
  ).length,
  1
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 0 bans fetched, 0 new, 0 updated, 0 removed, 5 held, 0 lists failed.'
);
// It is held however long the bans have been missing, and however small the list.
for (const stored of [5, 1]) {
  reset();
  battlemetricsList(4, pairs('d', 0, stored), [[]]);
  await run();
  await run();
  assert.strictEqual(storedIDs(4).length, stored);
  assert.deepStrictEqual(removedIDs(), []);
}

// Once IMPORTER_ALLOW_MASS_REMOVAL names it, an empty list loses all its bans.
reset();
battlemetricsList(4, pairs('d', 0, 5), [[]]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '4';
await run();
assert.deepStrictEqual(storedIDs(4), []);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 4\): 0 bans fetched, 0 new, 0 updated, 5 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list\. Remove it from the setting once the removal is done\.$/
  ).length,
  1
);
assert.strictEqual(warnings().length, 1);
assert.strictEqual(
  summary(),
  'Got 5 deleted bans. Imported 1 ban list: 0 bans fetched, 0 new, 0 updated, 5 removed, 0 held, 0 lists failed.'
);

// Missing bans fewer than 10, and 5% of the bans a list had before the run, are removed at once.
// More are recorded as missing, and kept, until a complete read of the list at least 10 minutes
// after the first that did not have them still does not. A list that now returns only other bans,
// as when its source was changed to a bigger list, keeps all its old ones for an admin to confirm.
// Each case is [stored, kept, added, what happens: removed, pending or held].
for (const [stored, kept, added, outcome] of [
  [30, 21, 0, 'removed'],
  [30, 20, 0, 'pending'],
  [300, 286, 0, 'removed'],
  [300, 285, 0, 'pending'],
  [300, 280, 5, 'pending'],
  [9, 0, 5, 'removed'],
  [30, 0, 400, 'held']
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, stored), [
    [...pairs('e', 0, kept), ...pairs('n', 1000, 1000 + added)]
  ]);
  const [result] = await run();
  const label = `${stored} stored, ${kept} kept, ${added} added`;
  const missing = stored - kept;
  assert.strictEqual(storedIDs(5).length, (outcome === 'removed' ? kept : stored) + added, label);
  assert.strictEqual(removedIDs().length, outcome === 'removed' ? missing : 0, label);
  assert.deepStrictEqual(
    [result.stored, result.held, result.pending, result.removed, result.hold],
    {
      removed: [stored, 0, 0, missing, null],
      pending: [stored, missing, missing, 0, null],
      held: [stored, missing, 0, 0, 'full']
    }[outcome],
    label
  );
  // The bans that wait for a later read are recorded, and so are those held for an admin, as held.
  assert.strictEqual(pendingIDs(5).length, outcome === 'removed' ? 0 : missing, label);
  assert.strictEqual(heldIDs(5).length, outcome === 'held' ? missing : 0, label);
  // Bans waiting for a later read are routine, so only the list held for an admin is posted.
  const holds = logged(
    1,
    new RegExp(
      `^Imported ban list \\(ID: 5\\): ${kept + added} bans fetched, ${added} new, 0 updated\\. Kept all ${stored} of its stored bans, as it no longer has any of them, which more likely means that its source broke\\. They are kept until one of them comes back\\. If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run\\.$`
    )
  );
  assert.strictEqual(holds.length, outcome === 'held' ? 1 : 0, label);
  assert.strictEqual(warnings().length, outcome === 'held' ? 1 : 0, label);
  assert.strictEqual(
    logged(
      2,
      new RegExp(
        `^Imported ban list \\(ID: 5\\): .*\\. Kept the ${missing} of its ${stored} stored bans that it no longer has until a complete read of it at least 10 minutes after the first one without them still does not have them\\.$`
      )
    ).length,
    outcome === 'pending' ? 1 : 0,
    label
  );
  assert.match(
    summary(),
    new RegExp(
      `, ${outcome === 'removed' ? missing : 0} removed, ${outcome === 'removed' ? 0 : missing} held, `
    ),
    label
  );
  if (outcome !== 'pending') continue;

  // A read sooner than 10 minutes later keeps them waiting, as when it was first missing.
  events.length = 0;
  await run();
  assert.deepStrictEqual([removedIDs().length, pendingIDs(5).length], [0, missing], label);
  // 10 minutes after the first read without them, they are removed, with their records.
  age(5, 10);
  events.length = 0;
  logs.length = 0;
  const [confirmed] = await run();
  assert.deepStrictEqual(
    [storedIDs(5).length, removedIDs().length, pendingIDs(5).length, confirmed.removed],
    [kept + added, missing, 0, missing],
    label
  );
  assert.match(summary(), new RegExp(`, ${missing} removed, 0 held, `), label);
}

// The list held for an admin saved the bans its read found, so its old bans are no longer all of
// its bans, but it stays held, however long they have been missing, on every run until an admin
// confirms it, and its line is posted on every run, with since when. So does a list whose old bans
// are fewer than the rule for few missing bans would remove at once, and one whose read found a
// single other ban. Each case is [stored, bans the read finds].
for (const [stored, others] of [
  [30, 400],
  [20, 400],
  [50, 1]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, stored), [pairs('n', 1000, 1000 + others)]);
  const label = `${stored} stored, then ${others} others`;
  const old = pairs('e', 0, stored).map(([uid]) => `5,${uid}`);
  await run();
  const since = new Date(pendingRows.get(`5,${old[0]}`).heldAt);
  for (let again = 1; again <= 3; again++) {
    age(5, 60);
    events.length = 0;
    logs.length = 0;
    const [result] = await run();
    const at = `${label}, run ${again + 1}`;
    assert.deepStrictEqual(
      [result.hold, result.held, result.pending, result.removed, result.stored],
      ['full', stored, 0, 0, stored + others],
      at
    );
    assert.deepStrictEqual(removedIDs(), [], at);
    assert.ok(
      old.every((id) => bans.has(id)),
      at
    );
    assert.deepStrictEqual(heldIDs(5).sort(), [...old].sort(), at);
    assert.strictEqual(row(5).state, 'held', at);
    since.setTime(since.getTime() - 60 * 60 * 1000);
    assert.deepStrictEqual(
      warnings().map(({ message }) => message),
      [
        `Imported ban list (ID: 5): ${others} bans fetched, 0 new, 0 updated. Still kept the ${stored} bans it had when it lost all of its bans at once, held since ${since.toISOString()}, as none of them has come back, which more likely means that its source broke. If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
      ],
      at
    );
    assert.match(summary(), new RegExp(`, 0 removed, ${stored} held, `), at);
  }
  // Named in IMPORTER_ALLOW_MASS_REMOVAL, it loses them, with their records.
  env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
  logs.length = 0;
  const [confirmed] = await run();
  assert.deepStrictEqual(
    [confirmed.removed, confirmed.held, confirmed.massRemoval, storedIDs(5).length],
    [stored, 0, true, others],
    label
  );
  assert.deepStrictEqual([pendingIDs(5), row(5).state], [[], 'ok'], label);
  assert.strictEqual(
    logged(
      1,
      new RegExp(`^Imported ban list \\(ID: 5\\): .*, ${stored} removed, as IMPORTER_ALLOW_MASS`)
    ).length,
    1,
    label
  );
}
// Bans the held list saved since, that it no longer has, are removed as usual while it stays held:
// a few at once, and more once a later complete read confirms they are gone. The line says so.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
battlemetricsLists.set('bm-5', [pairs('n', 1005, 1400)]);
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, storedIDs(5).length],
  ['full', 5, 30, 425]
);
battlemetricsLists.set('bm-5', [pairs('n', 1105, 1400)]);
logs.length = 0;
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, results[0].pending],
  ['full', 0, 130, 100]
);
assert.deepStrictEqual([heldIDs(5).length, pendingIDs(5).length], [30, 130]);
assert.match(
  warnings()[0].message,
  /^Imported ban list \(ID: 5\): 295 bans fetched, 0 new, 0 updated\. Still kept the 30 bans it had when .* for one run\. Of the bans it saved since, 100 that it no longer has are kept until a later complete read of it confirms they are gone\.$/
);
age(5, 10);
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, storedIDs(5).length],
  ['full', 100, 30, 325]
);
// Once one of its held bans comes back, the hold ends: that ban loses its record, and the others
// wait for a later complete read, as if first missing now, however long they were held, so they
// are not removed until then. It is then a list whose missing bans wait, which is not posted.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
age(5, 600);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('n', 1000, 1400)]]);
events.length = 0;
logs.length = 0;
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].pending, results[0].held],
  [null, 0, 29, 29]
);
assert.deepStrictEqual(
  [heldIDs(5), pendingIDs(5).length, pendingRows.has('5,5,e0')],
  [[], 29, false]
);
assert.ok(pendingRows.get('5,5,e1').firstMissingAt >= Date.now() - 60 * 1000);
assert.deepStrictEqual(
  writes()
    .filter(([type]) => type.endsWith('pending') || type.endsWith('held'))
    .map(([type, ids]) => [type, ids.length]),
  [
    ['clear pending', 1],
    ['release held', 29],
    ['save pending', 29]
  ]
);
assert.deepStrictEqual(warnings(), []);
age(5, 10);
results = await run();
assert.deepStrictEqual([results[0].removed, storedIDs(5).length], [29, 401]);
// A read that is not complete does not end the hold, though it finds a held ban: the ban keeps its
// record, so the next complete read finds that it came back.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('n', 1000, 1400)]]);
battlemetricsTotals.set('bm-5', 900);
results = await run();
assert.deepStrictEqual([results[0].complete, heldIDs(5).length], [false, 30]);
battlemetricsTotals.delete('bm-5');
results = await run();
assert.deepStrictEqual([results[0].hold, results[0].pending, heldIDs(5)], [null, 29, []]);
// A held ban that the list no longer has at all, e.g. as an admin deleted it, has not come back: it
// loses its record, and the list stays held.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
bans.delete('5,e0');
results = await run();
assert.deepStrictEqual([results[0].hold, results[0].held, heldIDs(5).length], ['full', 29, 29]);

// A recorded ban that comes back loses its record, and is never removed. When the rest that wait
// would be too few to wait, they are removed at once, with those that were missing long enough.
reset();
battlemetricsList(6, pairs('f', 0, 100), [pairs('f', 20, 100)]);
await run();
assert.deepStrictEqual(
  pendingIDs(6),
  pairs('f', 0, 20).map(([uid]) => `6,${uid}`)
);
battlemetricsLists.set('bm-6', [[...pairs('f', 12, 100)]]);
age(6, 10);
events.length = 0;
let [result] = await run();
assert.deepStrictEqual([result.removed, result.pending, result.held], [12, 0, 0]);
assert.deepStrictEqual(
  storedIDs(6),
  pairs('f', 12, 100).map(([uid]) => `6,${uid}`)
);
assert.deepStrictEqual(pendingIDs(6), []);
// Those that came back lost their records first.
assert.deepStrictEqual(
  events.find(([type]) => type === 'clear pending')[1],
  pairs('f', 12, 20).map(([uid]) => `6,${uid}`)
);
// A recorded ban that the list no longer has at all, e.g. as the bot deleted it, loses its record.
reset();
battlemetricsList(6, pairs('f', 0, 100), [pairs('f', 20, 100)]);
await run();
for (const [uid] of pairs('f', 0, 5)) bans.delete(`6,${uid}`);
events.length = 0;
await run();
assert.deepStrictEqual(
  pendingIDs(6),
  pairs('f', 5, 20).map(([uid]) => `6,${uid}`)
);

// Named in IMPORTER_ALLOW_MASS_REMOVAL, the list that now returns only other bans loses its old ones.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
await run();
assert.strictEqual(storedIDs(5).length, 400);
assert.ok(!storedIDs(5).some((id) => id.startsWith('5,e')));
assert.strictEqual(
  logged(1, /^Imported ban list \(ID: 5\): 400 bans fetched, 400 new, 0 updated, 30 removed, as/)
    .length,
  1
);
// So does a list an admin allowed to lose all its bans, by its row, until a time not yet passed,
// once the import has read it in full. A time that has passed allows nothing.
for (const [hours, removes] of [
  [2, true],
  [-1, false]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1010)]);
  syncRows.set(5, {
    banList: 5,
    sourceKey: createHash('sha256')
      .update(JSON.stringify(['battlemetrics', 'bm-5']))
      .digest('hex'),
    state: 'held',
    consecutiveFailures: 0,
    allowFullRemovalUntil: new Date(Date.now() + hours * 60 * 60 * 1000)
  });
  [result] = await run();
  assert.deepStrictEqual(
    [storedIDs(5).length, result.removed, result.held],
    removes ? [10, 30, 0] : [40, 0, 30],
    `${hours} hours`
  );
  assert.strictEqual(
    logged(
      1,
      /^Imported ban list \(ID: 5\): .*, as an admin confirmed that it may lose them all\.$/
    ).length,
    removes ? 1 : 0
  );
}

reset();
battlemetricsList(5, pairs('e', 0, 2600), [pairs('e', 0, 50)]);
battlemetricsList(6, pairs('f', 0, 30), [pairs('f', 0, 2)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = ' 9, 5 ';
await run();
assert.deepStrictEqual(storedIDs(5).length, 50);
assert.deepStrictEqual(storedIDs(6).length, 30);
// The removal is made in batches of 500 bans, each in its own transaction.
assert.deepStrictEqual(
  events.filter(([type]) => type === 'remove').map(([, ids, tx]) => [tx, ids.length]),
  [
    [1, 500],
    [2, 500],
    [3, 500],
    [4, 500],
    [5, 500],
    [6, 50]
  ]
);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 5\): 50 bans fetched, 0 new, 0 updated, 2550 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list/
  ).length,
  1
);
assert.deepStrictEqual(pendingIDs(6).length, 28);
assert.strictEqual(
  summary(),
  'Got 2,550 deleted bans. Imported 2 ban lists: 52 bans fetched, 0 new, 0 updated, 2,550 removed, 28 held, 0 lists failed.'
);

// Remote lists: an empty file keeps the list's bans, after a single request, and an error page
// fails the list, which is tried once more after the other list.
reset();
remoteList(7, [7], '');
remoteList(8, [8], '<html><body>Please sign in</body></html>');
await run();
assert.deepStrictEqual(remoteRequests, [
  'https://bans.example/7.txt',
  'https://bans.example/8.txt',
  'https://bans.example/8.txt'
]);
assert.strictEqual(storedIDs(7).length, 1);
assert.strictEqual(storedIDs(8).length, 1);
assert.strictEqual(logged(1, /^Imported ban list \(ID: 7\): it returned no bans/).length, 1);
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 8\) while fetching it, .*error page/).length,
  1
);
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 8\) again while fetching it, .*error page/).length,
  1
);

// An unchanged remote ban has no note, which matches the NULL stored for it, so it is not written
// again. A changed one is, and its player is queued for an update.
reset();
remoteList(9, [1, 2], `${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Teamkilling`);
await run();
assert.deepStrictEqual(written(), [`9,${steamID(2)},null`]);
assert.strictEqual(bans.get(`9,${steamID(2)},null`).rawReason, 'Teamkilling');
assert.deepStrictEqual(
  [steamUsers.get(steamID(1)).lastRefreshedExport, steamUsers.get(steamID(2)).lastRefreshedExport],
  [FRESH, null]
);
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 9\): 2 bans fetched, 0 new, 1 updated\.$/).length,
  1
);
assert.strictEqual(
  logged(
    2,
    /^Found updated ban \(ID: 9,76561198000000002,null\) in ban list \(ID: 9\): reason, rawReason changed\.$/
  ).length,
  1
);

// Errors that would only happen again are not retried. The batch is written again a ban at a time,
// so a ban that cannot be saved is counted, and the rest of the list is still saved and checked
// for removed bans. Deadlocks and lock wait timeouts are retried, as a whole batch.
reset();
battlemetricsList(10, pairs('g', 0, 6), [
  [...pairs('g', 0, 5), ['g8', steamID(8)], ['g9', steamID(9)]]
]);
for (const id of ['10,g1', '10,g2']) bans.get(id).reason = 'Old';
writeErrors.set('10,g8', [
  new DatabaseError('Deadlock found when trying to get lock', { errno: 1213 }),
  new ValidationError('Validation error: reason cannot be null'),
  new ValidationError('Validation error: reason cannot be null')
]);
writeErrors.set('10,g2', [new DatabaseError('Lock wait timeout exceeded', { errno: 1205 })]);
results = await run();
// The batch of 4 is tried twice, failing for the deadlock and the validation error, and then each
// of its bans alone: g2's lock wait timeout is tried again.
assert.deepStrictEqual(
  events.filter(([type]) => type === 'write').map(([, ids]) => ids),
  [['10,g9'], ['10,g1'], ['10,g2']]
);
assert.deepStrictEqual(delays, [5000, 5000]);
assert.deepStrictEqual(storedIDs(10), ['10,g0', '10,g1', '10,g2', '10,g3', '10,g4', '10,g9']);
assert.deepStrictEqual([results[0].failed, results[0].created, results[0].updated], [1, 1, 2]);
assert.strictEqual(
  logged(
    1,
    /^Imported ban list \(ID: 10\): 7 bans fetched, 1 new, 2 updated, 1 removed, 1 failed to save \(SequelizeValidationError: Validation error: reason cannot be null\)\.$/
  ).length,
  1
);
assert.strictEqual(logged(1, /Attempt/).length, 0);
assert.strictEqual(
  logged(2, /^Failed to save raw ban \(ID: 10,g8\) in ban list \(ID: 10\)/).length,
  1
);

// A list removed during the run, so that its bans fail its foreign key, is dropped once the list
// is confirmed gone, without retries or a sweep.
reset();
battlemetricsList(11, pairs('h', 0, 3), [
  () => {
    banLists.delete(11);
    for (const id of storedIDs(11)) bans.delete(id);
    return pairs('h', 0, 8);
  }
]);
battlemetricsTotals.set('bm-11', 8);
battlemetricsList(12, [], [pairs('i', 0, 2)]);
await run();
assert.ok(!events.some(([type]) => type === 'remove'));
assert.strictEqual(events.filter(([type, list]) => type === 'read list' && list === 11).length, 2);
assert.strictEqual(
  logged(2, /^Skipped ban list \(ID: 11\), as it was removed during the run\.$/).length,
  1
);
assert.strictEqual(warnings().length, 0);
assert.deepStrictEqual(storedIDs(12), ['12,i0', '12,i1']);
assert.deepStrictEqual(delays, []);

// A list removed before it is read is skipped without being fetched.
reset();
battlemetricsList(13, pairs('j', 0, 2), [pairs('j', 0, 2)]);
battlemetricsList(14, pairs('k', 0, 2), [pairs('k', 0, 2)]);
const importer = new BanImporter();
const originalFindAll = BanList.findAll;
BanList.findAll = async () => {
  const lists = await originalFindAll();
  banLists.delete(13);
  return lists;
};
await importer.importBans();
BanList.findAll = originalFindAll;
assert.deepStrictEqual(battlemetricsRequests, ['bm-14']);
assert.strictEqual(logged(2, /^Skipped ban list \(ID: 13\)/).length, 1);

// So is a list removed once its bans are saved, when it is read again before it is swept.
reset();
battlemetricsList(13, pairs('j', 0, 3), [pairs('j', 0, 2)]);
const originalFindByPk = BanList.findByPk;
BanList.findByPk = async (id, options) => {
  if (options?.attributes) {
    banLists.delete(id);
    for (const banID of storedIDs(id)) bans.delete(banID);
  }
  return originalFindByPk(id);
};
results = await run();
BanList.findByPk = originalFindByPk;
assert.deepStrictEqual(
  events.filter(([type]) => type === 'read list'),
  [
    ['read list', 13],
    ['read list', 13]
  ]
);
assert.ok(!events.some(([type]) => type === 'begin' || type === 'remove'));
assert.ok(results[0].gone);
assert.strictEqual(logged(2, /^Skipped ban list \(ID: 13\)/).length, 1);
assert.strictEqual(warnings().length, 0);

// A list whose bans cannot be saved because the database stays unavailable stops after the
// retries, and keeps its stored bans. It is not fetched again later in the run.
reset();
battlemetricsList(15, pairs('l', 0, 4), [[...pairs('l', 0, 1), ...pairs('l', 5, 7)]]);
battlemetricsList(16, [], [[]]);
writeErrors.set(
  '15,l5',
  Array.from({ length: 5 }, () => new ConnectionError())
);
await run();
assert.strictEqual(events.filter(([type]) => type === 'rollback').length, 5);
assert.deepStrictEqual(storedIDs(15), ['15,l0', '15,l1', '15,l2', '15,l3']);
assert.ok(!events.some(([type]) => type === 'remove'));
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 15\) while saving its bans, so none of its bans were removed \(3 bans fetched, 0 new, 0 updated\)\. SequelizeConnectionRefusedError: connect ECONNREFUSED/
  ).length,
  1
);
assert.deepStrictEqual(battlemetricsRequests, ['bm-15', 'bm-16']);
assert.ok(!delays.includes(60 * 1000));

// A list that could not be fetched, e.g. during a short BattleMetrics outage, is tried again a
// minute after the other lists, and its second attempt is imported as usual.
reset();
battlemetricsList(17, pairs('m', 0, 3), [
  pairs('m', 0, 1),
  failsOnce([...pairs('m', 2, 3), ['m5', steamID(5)]])
]);
battlemetricsList(18, pairs('o', 0, 2), [pairs('o', 0, 2)]);
// The import says how many lists it has done, for the run's status: before the first and after
// each one, and then how many of the lists it tried again.
const progress = [];
control.setProgressListener((report) => progress.push({ ...report }));
results = await run();
control.setProgressListener(null);
assert.deepStrictEqual(progress, [
  { done: 0, total: 2, unit: 'ban lists' },
  { done: 1, total: 2, unit: 'ban lists' },
  { done: 2, total: 2, unit: 'ban lists' },
  { done: 0, total: 1, unit: 'ban lists tried again' },
  { done: 1, total: 1, unit: 'ban lists tried again' }
]);
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-17', 'bm-18', 'bm-17', 'bm-17']);
assert.deepStrictEqual(delays, [60 * 1000]);
assert.deepStrictEqual(storedIDs(17), ['17,m0', '17,m2', '17,m5']);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, error }) => [id, attempt, error]),
  [
    [17, 2, undefined],
    [18, 1, undefined]
  ]
);
assert.deepStrictEqual(
  warnings().map((log) => log.message),
  [
    'Failed to import ban list (ID: 17) while fetching it, so none of its bans were removed. Error: Request failed with status code 502',
    'Imported ban list (ID: 17) at the second attempt: 3 bans fetched, 1 new, 0 updated, 1 removed.'
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 2 ban lists: 5 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);

// When no list could be fetched, the source is down, so nothing is tried again.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(502)]);
battlemetricsList(18, pairs('o', 0, 2), [new Error('timeout')]);
await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
assert.deepStrictEqual(delays, []);
assert.strictEqual(warnings().length, 2);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 2 ban lists: 0 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 2 lists failed.'
);
// Nor when the only other list imports one of CBL's export ban lists, as that list is never
// fetched, so says nothing about whether the source is down.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(503)]);
battlemetricsList(18, pairs('o', 0, 2), [httpError(503)]);
battlemetricsList(19, pairs('p', 0, 2), [pairs('p', 0, 2)], 'c0ffee00-cb1e-4a00-b000-0000000000dd');
exportBanLists.push({ id: 3, battlemetricsID: 'c0ffee00-cb1e-4a00-b000-0000000000dd' });
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
assert.deepStrictEqual(delays, []);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, selfImport }) => [id, attempt, selfImport]),
  [
    [17, 1, undefined],
    [18, 1, undefined],
    [19, 1, 3]
  ]
);

// Nor is a list its source refused, e.g. as it was deleted, as that would happen again.
reset();
battlemetricsList(17, pairs('m', 0, 3), [httpError(404)]);
remoteList(19, [1], new Error('getaddrinfo ENOTFOUND bans.example'));
remoteList(20, [2], Object.assign(httpError(403), { code: 'ERR_BAD_REQUEST' }));
battlemetricsList(18, pairs('o', 0, 2), [pairs('o', 0, 2)]);
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-17', 'bm-18']);
// The remote list that could not be reached is tried 3 times, and 3 more after the other lists.
assert.deepStrictEqual(remoteRequests, [
  ...Array(3).fill('https://bans.example/19.txt'),
  'https://bans.example/20.txt',
  ...Array(3).fill('https://bans.example/19.txt')
]);
assert.deepStrictEqual(
  Array.from(results, ({ id, attempt, error }) => [id, attempt, Boolean(error)]),
  [
    [17, 1, true],
    [19, 2, true],
    [20, 1, true],
    [18, 1, false]
  ]
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 4 ban lists: 2 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 3 lists failed.'
);

// One line sums up the run, however each list went, and lists without problems, or with bans
// waiting for a later read, are only logged to the console.
reset();
battlemetricsList(21, pairs('p', 0, 10), [
  [
    ...pairs('p', 0, 4),
    ['p4', steamID(4), 'Teamkilling'],
    ...pairs('p', 5, 9),
    ['p20', steamID(20)],
    ['p21', steamID(21)]
  ]
]);
battlemetricsList(22, pairs('q', 0, 30), [pairs('q', 0, 2)]);
battlemetricsList(23, pairs('r', 0, 2), [httpError(404)]);
battlemetricsList(24, pairs('s', 0, 3), [[]]);
await run();
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 21\): 11 bans fetched, 2 new, 1 updated, 1 removed\.$/)
    .length,
  1
);
assert.deepStrictEqual(
  warnings().map((log) => Number(log.message.match(/ban list \(ID: (\d+)\)/)[1])),
  [23, 24]
);
assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 23\) while fetching it/).length, 1);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 4 ban lists: 13 bans fetched, 2 new, 1 updated, 1 removed, 31 held, 1 list failed.'
);

// A list given a new type or source while its bans are being saved, with its bans deleted in the
// same transaction as /banlist update does, has the bans fetched from its old source removed, with
// their players queued for an update, instead of being checked for the bans it no longer has.
// Nothing is held, and the next run imports the new source. The bans are written 10 at a time
// here, so the change comes between two batches.
for (const change of [{ type: 'remote' }, { source: 'bm-99' }]) {
  reset();
  battlemetricsList(
    25,
    [...pairs('u', 0, 40), ...pairs('x', 100, 105)],
    [pairs('u', 0, 30), pairs('u', 30, 60)]
  );
  onWrite = (ids) => {
    if (ids[0] !== '25,u50') return;
    for (const banID of storedIDs(25)) bans.delete(banID);
    banLists.set(25, { ...banLists.get(25), ...change });
  };
  const [result] = await run({ batchSize: 10 });
  const label = JSON.stringify(change);
  // The bans saved before the change were deleted with it, and those saved after it are removed.
  assert.deepStrictEqual(storedIDs(25), [], label);
  assert.deepStrictEqual(
    events.filter(([type]) => type === 'remove').map(([, ids]) => ids),
    [
      pairs('u', 0, 10).map(([uid]) => `25,${uid}`),
      pairs('u', 10, 20).map(([uid]) => `25,${uid}`),
      pairs('u', 20, 30).map(([uid]) => `25,${uid}`),
      pairs('u', 30, 40).map(([uid]) => `25,${uid}`),
      pairs('u', 40, 50).map(([uid]) => `25,${uid}`),
      pairs('u', 50, 60).map(([uid]) => `25,${uid}`)
    ],
    label
  );
  assert.deepStrictEqual(
    inTransaction(events.find(([type]) => type === 'remove')[2]),
    ['begin', 'flags', 'remove', 'clear pending', 'commit'],
    label
  );
  assert.strictEqual(steamUsers.get(steamID(0)).lastRefreshedInfo, null, label);
  assert.strictEqual(steamUsers.get(steamID(59)).lastRefreshedInfo, null, label);
  // Nothing is swept: the player of an old ban that was not fetched, deleted with the change, is
  // not queued by the run.
  assert.strictEqual(steamUsers.get(steamID(100)).lastRefreshedInfo, FRESH, label);
  assert.deepStrictEqual(
    [result.sourceChanged, result.fetched, result.created, result.removed, result.held],
    [true, 60, 20, 10, 0],
    label
  );
  assert.deepStrictEqual(
    warnings().map(({ message, important }) => [message, important]),
    [
      [
        'Removed the bans fetched for ban list (ID: 25), as its type or source was changed while it was imported (60 bans fetched, 20 new, 0 updated, 10 removed). Its new source is imported on the next run.',
        true
      ]
    ],
    label
  );
  assert.strictEqual(
    summary(),
    'Got 10 deleted bans. Imported 1 ban list: 60 bans fetched, 20 new, 0 updated, 10 removed, 0 held, 0 lists failed.',
    label
  );
}
// The next run imports the new source, and has no bans of the old one to hold.
logs.length = 0;
onWrite = null;
battlemetricsLists.set('bm-99', [pairs('v', 0, 20)]);
await run();
assert.deepStrictEqual(
  storedIDs(25),
  pairs('v', 0, 20).map(([uid]) => `25,${uid}`)
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 20 bans fetched, 20 new, 0 updated, 0 removed, 0 held, 0 lists failed.'
);
// Each list's sync state is saved in its BanListSyncs row after its import. row(id) copies a row
// into this test's own objects, with its times as numbers.
function row(id) {
  const saved = syncRows.get(id);
  if (!saved) return undefined;
  const time = (value) => (value && typeof value.getTime === 'function' ? value.getTime() : value);
  return Object.fromEntries(Object.entries(saved).map(([field, value]) => [field, time(value)]));
}
const sha256 = (type, source) =>
  createHash('sha256')
    .update(JSON.stringify([type, source]))
    .digest('hex');
// The columns the import saves on every run, and those a new row, or the row of a list whose type
// or source was changed, also starts with. A remote list's row also keeps its file.
const IMPORT_FIELDS = [
  'banList',
  'sourceKey',
  'state',
  'lastAttemptAt',
  'lastSuccessAt',
  'lastFullScanAt',
  'consecutiveFailures',
  'incompleteScans',
  'lastError',
  'storedCount',
  'headTotal',
  'replacePending'
];
const REMOTE_FIELDS = ['remoteEtag', 'remoteLastModified', 'remoteBodyHash'];
const FRESH_FIELDS = {
  lastHeadPollAt: null,
  nextFullScanAt: null,
  scanReason: null,
  headUids: null,
  allowFullRemovalUntil: null,
  remoteEtag: null,
  remoteLastModified: null,
  remoteBodyHash: null
};
const savedFields = (id) =>
  syncSaves.filter(({ values }) => values.banList === id).map(({ fields }) => [...fields].sort());
// The alerts about lists, posted once each: a list failing 3 runs in a row, CBL losing access to
// one, or to many at once, and one importing a CBL export ban list.
const ALERT =
  /^(Ban list \(ID: \d+\) (has failed to import|is not imported|is not among)|CBL (can no longer read|cannot read|lost access))/;
const alerts = () => logged(1, ALERT).map((log) => log.message);

// After one run, every list that was not removed during it has a row: imported (ok), failed
// (failing), or imported with some of the bans it no longer has kept (held). It says when the list
// was tried, last imported and last read in full, how many runs in a row it failed and why, how
// many bans it has here and BattleMetrics' count of them, the key of its type and source, and
// whether its old source's bans are being replaced. A new row starts with every column. A remote
// list's row also keeps the SHA-256 of the file it was imported from.
reset();
battlemetricsList(1, pairs('a', 0, 3), [pairs('a', 0, 4)]);
battlemetricsTotals.set('bm-1', 4);
battlemetricsList(2, pairs('b', 0, 2), [httpError(503)]);
battlemetricsList(3, pairs('c', 0, 30), [pairs('c', 0, 2)]);
remoteList(4, [1, 2], `${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Cheating`);
battlemetricsList(5, pairs('e', 0, 1), [
  () => {
    banLists.delete(5);
    return pairs('e', 0, 2);
  }
]);
const started = Date.now();
const firstRun = new BanImporter();
await firstRun.importBans();
const ended = Date.now();
assert.deepStrictEqual(
  [...syncRows.keys()].sort((a, b) => a - b),
  [1, 2, 3, 4]
);
const imported = row(1);
assert.ok(imported.lastAttemptAt >= started && imported.lastAttemptAt <= ended);
// Its next full read is due 30 minutes after this one, less up to a fifth of that at random. Read
// with head polls off, its first page is not its newest, so it keeps no newest bans.
const MINUTE = 60 * 1000;
const dueIn = (saved, from, to) =>
  saved.nextFullScanAt >= saved.lastAttemptAt + from * MINUTE &&
  saved.nextFullScanAt <= saved.lastAttemptAt + to * MINUTE;
assert.ok(dueIn(imported, 24, 30), `due ${imported.nextFullScanAt - imported.lastAttemptAt}`);
assert.deepStrictEqual(imported, {
  ...FRESH_FIELDS,
  banList: 1,
  sourceKey: sha256('battlemetrics', 'bm-1'),
  state: 'ok',
  lastAttemptAt: imported.lastAttemptAt,
  lastSuccessAt: imported.lastAttemptAt,
  lastFullScanAt: imported.lastAttemptAt,
  nextFullScanAt: imported.nextFullScanAt,
  scanReason: 'periodic',
  consecutiveFailures: 0,
  incompleteScans: 0,
  lastError: null,
  storedCount: 4,
  headTotal: 4,
  replacePending: false
});
// Both of the failed list's attempts count as one failed run.
assert.deepStrictEqual(row(2), {
  ...FRESH_FIELDS,
  banList: 2,
  sourceKey: sha256('battlemetrics', 'bm-2'),
  state: 'failing',
  lastAttemptAt: row(2).lastAttemptAt,
  lastSuccessAt: null,
  lastFullScanAt: null,
  consecutiveFailures: 1,
  incompleteScans: 0,
  lastError: 'Error: Request failed with status code 503',
  storedCount: 2,
  headTotal: null,
  replacePending: false
});
assert.ok(row(2).lastAttemptAt >= imported.lastAttemptAt);
assert.deepStrictEqual(
  [row(3).state, row(3).storedCount, row(3).consecutiveFailures, row(3).lastError],
  ['held', 30, 0, null]
);
assert.strictEqual(row(3).lastSuccessAt, row(3).lastAttemptAt);
// The list whose missing bans wait for a confirming read is due to be read in full again once the
// first of them can be confirmed, 10 minutes after this read. The read and the row's save each read
// the clock, a moment apart.
const confirmsIn = (saved, minutes) =>
  saved.scanReason === 'removal' &&
  Math.abs(saved.nextFullScanAt - saved.lastAttemptAt - minutes * MINUTE) < 1000;
assert.ok(confirmsIn(row(3), 10), JSON.stringify(row(3)));
assert.deepStrictEqual(
  [row(4).state, row(4).sourceKey, row(4).storedCount, row(4).headTotal],
  ['ok', sha256('remote', 'https://bans.example/4.txt'), 2, null]
);
assert.deepStrictEqual(
  [row(4).remoteEtag, row(4).remoteLastModified, row(4).remoteBodyHash],
  [
    null,
    null,
    createHash('sha256')
      .update(`${steamID(1)}:0 //Cheating\n${steamID(2)}:0 //Cheating`)
      .digest('hex')
  ]
);
assert.deepStrictEqual(savedFields(1), [[...IMPORT_FIELDS, ...Object.keys(FRESH_FIELDS)].sort()]);
// Saving a row posts nothing.
assert.deepStrictEqual(alerts(), []);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(firstRun.report())).banLists.map(({ id, state }) => [id, state]),
  [
    [1, undefined],
    [2, 'failing'],
    [3, 'held'],
    [4, undefined],
    [5, undefined]
  ]
);

// A list that fails 3 runs in a row is posted about once, at the 3rd, and not at the runs after.
// A run's second attempt at it counts with its first. Once it imports again, it is back to ok, with
// a line in the console, and is posted about again only after another 3 failed runs in a row.
reset();
battlemetricsList(6, pairs('f', 0, 2), [httpError(503)]);
// The other list keeps the second attempts going.
battlemetricsList(7, [], [pairs('g', 0, 1)]);
const failureAlert = (lastImported) =>
  `Ban list (ID: 6) has failed to import 3 runs in a row, so its bans may be out of date: ${lastImported}. Its latest error: Error: Request failed with status code 503`;
for (let run = 1; run <= 5; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  await new BanImporter().importBans();
  assert.deepStrictEqual(battlemetricsRequests, ['bm-6', 'bm-7', 'bm-6'], `run ${run}`);
  assert.deepStrictEqual(
    [row(6).state, row(6).consecutiveFailures, row(6).lastSuccessAt],
    ['failing', run, null],
    `run ${run}`
  );
  assert.deepStrictEqual(
    alerts(),
    run === 3
      ? [failureAlert('the importer has no record of importing it from its current source')]
      : [],
    `run ${run}`
  );
  // Its failures are still posted, as on every run.
  assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 6\)/).length, 2, `run ${run}`);
  // Its row is saved once a run, by its second attempt.
  assert.strictEqual(savedFields(6).length, run, `run ${run}`);
}
logs.length = 0;
battlemetricsLists.set('bm-6', [pairs('f', 0, 2)]);
await run();
assert.deepStrictEqual(
  [row(6).state, row(6).consecutiveFailures, row(6).lastError],
  ['ok', 0, null]
);
const lastImported = row(6).lastSuccessAt;
assert.strictEqual(lastImported, row(6).lastAttemptAt);
assert.strictEqual(
  logged(
    2,
    /^Ban list \(ID: 6\) is back to normal: it was imported again, after failing 5 runs in a row\.$/
  ).length,
  1
);
assert.deepStrictEqual(alerts(), []);
battlemetricsLists.set('bm-6', [httpError(503)]);
for (let run = 1; run <= 3; run++) {
  logs.length = 0;
  await new BanImporter().importBans();
  assert.strictEqual(row(6).lastSuccessAt, lastImported);
  assert.deepStrictEqual(
    alerts(),
    run === 3
      ? [failureAlert(`it was last imported at ${new Date(lastImported).toISOString()}`)]
      : [],
    `run ${run} after it imported`
  );
}

// A list's row is saved once the run knows how its import ended. In a list's 3rd run that may fail,
// a first attempt that fails waits for the second, so when the second imports the list, the run is
// not counted as failed, and nothing is posted. When no list can be tried again, as every list
// failed, the first attempt is final: its row is saved after the first pass, and posted about.
const failedTwice = (id, lastSuccessAt) => ({
  banList: id,
  sourceKey: sha256('battlemetrics', `bm-${id}`),
  state: 'failing',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt,
  consecutiveFailures: 2,
  lastError: 'Error: Request failed with status code 503',
  storedCount: 2,
  headTotal: 2
});
const IMPORTED_AT = new Date('2026-10-15T18:00:00.000Z');
reset();
battlemetricsList(40, pairs('a', 0, 2), [failsOnce(pairs('a', 0, 2), httpError(503))]);
battlemetricsList(41, [], [pairs('b', 0, 1)]);
syncRows.set(40, failedTwice(40, IMPORTED_AT));
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-40', 'bm-41', 'bm-40']);
assert.deepStrictEqual([results[0].attempt, results[0].error], [2, undefined]);
assert.deepStrictEqual(
  [row(40).state, row(40).consecutiveFailures, row(40).lastError],
  ['ok', 0, null]
);
assert.strictEqual(savedFields(40).length, 1);
assert.deepStrictEqual(alerts(), []);
assert.strictEqual(logged(2, /is back to normal/).length, 0);
// Its two lines say what happened, as before.
assert.deepStrictEqual(
  warnings().map(({ message }) => message.split(',')[0]),
  [
    'Failed to import ban list (ID: 40) while fetching it',
    'Imported ban list (ID: 40) at the second attempt: 2 bans fetched'
  ]
);
reset();
battlemetricsList(40, pairs('a', 0, 2), [httpError(503)]);
battlemetricsList(41, [], [httpError(503)]);
syncRows.set(40, failedTwice(40, IMPORTED_AT));
await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-40', 'bm-41']);
assert.deepStrictEqual(delays, []);
assert.deepStrictEqual(
  [row(40).state, row(40).consecutiveFailures, row(41).state, row(41).consecutiveFailures],
  ['failing', 3, 'failing', 1]
);
assert.strictEqual(savedFields(40).length, 1);
assert.deepStrictEqual(alerts(), [
  'Ban list (ID: 40) has failed to import 3 runs in a row, so its bans may be out of date: it was last imported at 2026-10-15T18:00:00.000Z. Its latest error: Error: Request failed with status code 503'
]);

// The access check reads BattleMetrics' list of the ban lists CBL can see, once a run, and compares
// their IDs with the lists' sources ignoring case, hyphens and spaces. A list whose source is not
// among them is still fetched and its new bans saved, but none of its bans are removed, even when
// IMPORTER_ALLOW_MASS_REMOVAL names it. It is posted about once, when CBL loses access, without the
// advice to remove it, as its fetch worked, and its row says why. Once CBL can see it again, it is
// checked for removed bans again.
reset();
battlemetricsList(8, pairs('h', 0, 3), [[...pairs('h', 0, 1), ['h9', steamID(9)]]]);
battlemetricsList(9, pairs('i', 0, 3), [pairs('i', 0, 2)], 'C0FFEE00-cb1e-4a00-b000-0000000000cc');
battlemetricsList(10, pairs('j', 0, 3), [pairs('j', 0, 3)]);
visibleBanLists = [' c0ffee00cb1e4a00b0000000000000cc ', 'BM-10', 'another-list'];
env.IMPORTER_ALLOW_MASS_REMOVAL = '8';
let checked = new BanImporter();
results = await checked.importBans();
assert.deepStrictEqual(banListReads, [['ban-lists', undefined]]);
assert.deepStrictEqual(battlemetricsRequests, [
  'bm-8',
  'C0FFEE00-cb1e-4a00-b000-0000000000cc',
  'bm-10'
]);
assert.deepStrictEqual(storedIDs(8), ['8,h0', '8,h1', '8,h2', '8,h9']);
assert.deepStrictEqual(storedIDs(9), ['9,i0', '9,i1']);
assert.ok(
  !events.some(([type, ids]) => type === 'remove' && ids.some((id) => id.startsWith('8,')))
);
const NOT_SEEN = 'its source is not among the BattleMetrics ban lists the CBL organisation can see';
assert.deepStrictEqual(
  [row(8).state, row(8).consecutiveFailures, row(8).storedCount, row(8).lastError],
  [
    'access_lost',
    0,
    4,
    'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.'
  ]
);
// The list was fetched in full and its bans saved, so it was last imported now.
assert.strictEqual(row(8).lastSuccessAt, row(8).lastAttemptAt);
assert.deepStrictEqual([row(9).state, row(10).state], ['ok', 'ok']);
assert.deepStrictEqual(alerts(), [
  'Ban list (ID: 8) is not among the BattleMetrics ban lists the CBL organisation can see, although CBL could still read it. Its new bans are saved, but none of its 4 stored bans are removed from it until BattleMetrics lists it again.'
]);
// The list's own line goes only to the console, as the alert says what needs looking at.
assert.strictEqual(
  logged(
    2,
    new RegExp(
      `^Imported ban list \\(ID: 8\\): 2 bans fetched, 1 new, 0 updated\\. None of its bans were checked for removal, as ${NOT_SEEN}\\.$`
    )
  ).length,
  1
);
assert.deepStrictEqual(warnings(), logged(1, ALERT));
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 3 ban lists: 7 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);
let counts = JSON.parse(JSON.stringify(checked.report()));
assert.deepStrictEqual(
  [counts.accessLost, counts.accessCheck, counts.banLists[0].state],
  [1, 'ok', 'access_lost']
);
assert.ok(results[0].accessLost);
// The next run is not posted about again.
logs.length = 0;
await run();
assert.deepStrictEqual([row(8).state, storedIDs(8).length], ['access_lost', 4]);
assert.deepStrictEqual(alerts(), []);
// Once CBL can see the list again, it loses the bans it no longer has.
logs.length = 0;
visibleBanLists = null;
delete env.IMPORTER_ALLOW_MASS_REMOVAL;
await run();
assert.deepStrictEqual(storedIDs(8), ['8,h0', '8,h9']);
assert.deepStrictEqual([row(8).state, row(8).lastError], ['ok', null]);
assert.strictEqual(
  logged(2, /^Ban list \(ID: 8\) is back to normal: CBL can read it on BattleMetrics again\.$/)
    .length,
  1
);
assert.deepStrictEqual(alerts(), []);

// A failed read of BattleMetrics' ban lists never holds up the import: the run goes without the
// check, so no list is marked for it, and says so in the console and the run record.
reset();
battlemetricsList(11, pairs('k', 0, 3), [pairs('k', 0, 2)]);
battlemetricsList(12, pairs('l', 0, 3), [pairs('l', 0, 3)]);
visibleBanLists = new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503');
checked = new BanImporter();
await checked.importBans();
assert.strictEqual(banListReads.length, 1);
assert.deepStrictEqual(battlemetricsRequests, ['bm-11', 'bm-12']);
assert.deepStrictEqual(storedIDs(11), ['11,k0', '11,k1']);
assert.deepStrictEqual([row(11).state, row(12).state], ['ok', 'ok']);
assert.strictEqual(
  logged(
    2,
    /^Could not read which BattleMetrics ban lists the CBL organisation can see, so this run does not check them: Error: BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503$/
  ).length,
  1
);
assert.deepStrictEqual(warnings(), []);
assert.strictEqual(checked.report().accessCheck, 'failed');
// Nor does a read that has a ban list without an ID.
reset();
battlemetricsList(11, pairs('k', 0, 3), [pairs('k', 0, 2)]);
visibleBanLists = ['bm-11', ''];
checked = new BanImporter();
await checked.importBans();
assert.deepStrictEqual([storedIDs(11).length, row(11).state], [2, 'ok']);
assert.strictEqual(checked.report().accessCheck, 'failed');
assert.strictEqual(
  logged(2, /^Could not read .*: Error: BattleMetrics returned a ban list without an ID\.$/).length,
  1
);

// A list CBL had lost access to stays so in a run that cannot tell whether CBL can read it again:
// one whose access check could not be made, or whose fetch failed for another reason. It is not
// swept, posted about again, or said to be back to normal, and its row keeps why it lost access.
// Here the list is not among those BattleMetrics lists, then the check cannot be made, then it is
// not among them again, as its first fetch fails, and at last it is. That failure, and so its
// second attempt, are posted as for any list, as they are not about its access.
reset();
battlemetricsList(50, pairs('t', 0, 3), [pairs('t', 0, 1)]);
battlemetricsList(51, [], [pairs('u', 0, 1)]);
const UNLISTED_ERROR =
  'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.';
for (const [run, visible] of [
  [1, ['bm-51']],
  [2, new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503')],
  [3, ['bm-51']],
  [4, null]
]) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  visibleBanLists = visible;
  battlemetricsLists.set('bm-50', [
    run === 3 ? failsOnce(pairs('t', 0, 1), httpError(503)) : pairs('t', 0, 1)
  ]);
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    battlemetricsRequests,
    run === 3 ? ['bm-50', 'bm-51', 'bm-50'] : ['bm-50', 'bm-51'],
    label
  );
  assert.deepStrictEqual(
    [row(50).state, row(50).lastError, storedIDs(50).length],
    run < 4 ? ['access_lost', UNLISTED_ERROR, 3] : ['ok', null, 1],
    label
  );
  assert.strictEqual(alerts().length, run === 1 ? 1 : 0, label);
  assert.strictEqual(logged(2, /is back to normal/).length, run === 4 ? 1 : 0, label);
  // The start of each line posted about the list: its alert, its failure, and its import.
  assert.deepStrictEqual(
    warnings()
      .filter(({ message }) => message.includes('(ID: 50)'))
      .map(({ message }) => message.replace(/ \(ID: 50\).*$/, '')),
    { 1: ['Ban list'], 2: [], 3: ['Failed to import ban list', 'Imported ban list'], 4: [] }[run],
    label
  );
  if (run === 2)
    assert.strictEqual(
      logged(
        2,
        /^Imported ban list \(ID: 50\): 1 bans fetched, 0 new, 0 updated\. None of its bans were checked for removal, as CBL had lost access to it, and this run could not tell whether it has access again\.$/
      ).length,
      1
    );
}

// With the access check off, a list CBL had lost access to is back to normal once its fetch works,
// as nothing else can show that CBL can read it.
reset();
battlemetricsList(54, pairs('x', 0, 3), [pairs('x', 0, 2)]);
syncRows.set(54, {
  banList: 54,
  sourceKey: sha256('battlemetrics', 'bm-54'),
  state: 'access_lost',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-16T06:00:00.000Z'),
  consecutiveFailures: 0,
  lastError: UNLISTED_ERROR,
  storedCount: 3,
  headTotal: 3
});
await run({ accessCheck: '0' });
assert.deepStrictEqual([row(54).state, storedIDs(54).length], ['ok', 2]);
assert.strictEqual(
  logged(2, /^Ban list \(ID: 54\) is back to normal: CBL can read it on BattleMetrics again\.$/)
    .length,
  1
);
// A list whose source was changed starts afresh, even if CBL had lost access to its old source,
// so a run that cannot tell treats it as it would any new list: it is swept, and not posted about.
reset();
battlemetricsList(55, pairs('y', 0, 3), [pairs('y', 0, 2)], 'bm-55-new');
syncRows.set(55, {
  banList: 55,
  sourceKey: sha256('battlemetrics', 'bm-55'),
  state: 'access_lost',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: null,
  consecutiveFailures: 2,
  lastError: UNLISTED_ERROR,
  storedCount: 3,
  headTotal: 3
});
visibleBanLists = new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503');
await run();
assert.deepStrictEqual(
  [row(55).state, row(55).sourceKey, row(55).lastError, storedIDs(55).length],
  ['ok', sha256('battlemetrics', 'bm-55-new'), null, 2]
);
assert.deepStrictEqual(alerts(), []);

// IMPORTER_ACCESS_CHECK turns the check off with 0, false, off or no, and the import then reads no
// list of ban lists and marks no list for it. It is on by default, and an invalid value leaves it
// on, with a warning posted to the log channel. A run without BattleMetrics lists has no need to
// read it.
for (const [setting, on] of [
  [undefined, true],
  ['', true],
  ['1', true],
  [' yes ', true],
  ['"1"', true],
  ['0', false],
  ['false', false],
  ['OFF', false],
  ['no', false],
  ["'0'", false],
  ['maybe', true]
]) {
  reset();
  battlemetricsList(13, pairs('m', 0, 3), [pairs('m', 0, 2)]);
  visibleBanLists = [];
  if (setting !== undefined) env.IMPORTER_ACCESS_CHECK = setting;
  checked = new BanImporter();
  await checked.importBans();
  const label = JSON.stringify(setting);
  assert.strictEqual(banListReads.length, on ? 1 : 0, label);
  assert.strictEqual(checked.report().accessCheck, on ? 'ok' : 'off', label);
  assert.deepStrictEqual(
    [row(13).state, storedIDs(13).length],
    on ? ['access_lost', 3] : ['ok', 2],
    label
  );
  assert.strictEqual(
    logged(
      2,
      /^IMPORTER_ACCESS_CHECK is off, so this run does not check which BattleMetrics ban lists the CBL organisation can see\.$/
    ).length,
    on ? 0 : 1,
    label
  );
  assert.strictEqual(
    logged(
      1,
      /^Warning: IMPORTER_ACCESS_CHECK must be 1 or 0, not "maybe", so the access check stays on\.$/
    ).length,
    setting === 'maybe' ? 1 : 0,
    label
  );
}
reset();
remoteList(14, [1], `${steamID(1)}:0 //Cheating`);
checked = new BanImporter();
await checked.importBans();
assert.deepStrictEqual([banListReads.length, checked.report().accessCheck], [0, 'unused']);

// BattleMetrics gives a list that CBL may see, but not its bans, with no bans that it still
// counts. That is not an emptied list: its fetch fails as hidden bans, it is not tried again, none
// of its bans are removed even when IMPORTER_ALLOW_MASS_REMOVAL names it, and CBL is taken to have
// lost access to it, with BattleMetrics' count kept in its row. A list that gives no bans and
// counts none really is empty, and keeps its bans as before, held for confirmation.
reset();
battlemetricsList(15, pairs('n', 0, 5), [[]]);
battlemetricsTotals.set('bm-15', 4376);
battlemetricsList(16, pairs('o', 0, 5), [[]]);
battlemetricsTotals.set('bm-16', 0);
battlemetricsList(17, [], [pairs('p', 0, 1)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '15';
results = await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-15', 'bm-16', 'bm-17']);
assert.deepStrictEqual([storedIDs(15).length, storedIDs(16).length], [5, 5]);
assert.ok(!events.some(([type]) => type === 'remove'));
const HIDDEN =
  'Error: BattleMetrics counts 4,376 bans on the list but gave none of them, so CBL may no longer be allowed to see its bans.';
assert.deepStrictEqual(
  [row(15).state, row(15).headTotal, row(15).consecutiveFailures, row(15).lastError],
  ['access_lost', 4376, 1, HIDDEN]
);
assert.deepStrictEqual([row(16).state, row(16).headTotal], ['held', 0]);
assert.strictEqual(
  logged(
    1,
    new RegExp(
      `^Failed to import ban list \\(ID: 15\\) while fetching it, so none of its bans were removed\\. ${RegExp.escape(HIDDEN)}$`
    )
  ).length,
  1
);
assert.deepStrictEqual(alerts(), [
  "CBL cannot read ban list (ID: 15) on BattleMetrics, as BattleMetrics counts 4,376 bans on it but gave none of them, so none of its 5 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
]);
assert.strictEqual(logged(1, /^Imported ban list \(ID: 16\): it returned no bans/).length, 1);
assert.deepStrictEqual(
  [results[0].retry, Boolean(results[0].accessLost), Boolean(results[1].accessLost)],
  [false, true, false]
);

// BattleMetrics answers HTTP 404, Unknown ban list, for a list CBL cannot see. That list is taken
// to have lost access, and is not tried again. Its failed runs go on counting, without the alert
// for 3 failed runs in a row, as its loss of access was posted. Its failure is posted in the run
// that finds it, and after that only goes to the console. Any other 404 is a failure, posted on
// every run.
const unknownBanList = () =>
  Object.assign(new Error('BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'), {
    name: 'ApiError',
    status: 404,
    titles: ['Unknown ban list'],
    response: { status: 404, data: { errors: [{ status: '404', title: 'Unknown ban list' }] } }
  });
reset();
battlemetricsList(18, pairs('q', 0, 2), [unknownBanList()]);
battlemetricsList(19, pairs('r', 0, 2), [httpError(404)]);
battlemetricsList(20, [], [pairs('s', 0, 1)]);
for (let run = 1; run <= 3; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  await new BanImporter().importBans();
  assert.deepStrictEqual(battlemetricsRequests, ['bm-18', 'bm-19', 'bm-20'], `run ${run}`);
  assert.deepStrictEqual(
    [row(18).state, row(18).consecutiveFailures, row(19).state, row(19).consecutiveFailures],
    ['access_lost', run, 'failing', run],
    `run ${run}`
  );
  assert.deepStrictEqual(
    alerts(),
    {
      1: [
        "CBL cannot read ban list (ID: 18) on BattleMetrics, as BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list), so none of its 2 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
      ],
      2: [],
      3: [
        'Ban list (ID: 19) has failed to import 3 runs in a row, so its bans may be out of date: the importer has no record of importing it from its current source. Its latest error: Error: Request failed with status code 404'
      ]
    }[run],
    `run ${run}`
  );
  const failure = /^Failed to import ban list \(ID: 18\) while fetching it, .*Unknown ban list\)$/;
  assert.deepStrictEqual(
    [logged(1, failure).length, logged(2, failure).length],
    run === 1 ? [1, 0] : [0, 1],
    `run ${run}`
  );
  assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 19\)/).length, 1, `run ${run}`);
}
assert.strictEqual(
  row(18).lastError,
  'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'
);
// A list imported before it is said to be one CBL can no longer read, and its failure is posted,
// as its row was ok.
reset();
battlemetricsList(18, pairs('q', 0, 2), [unknownBanList()]);
syncRows.set(18, {
  banList: 18,
  sourceKey: sha256('battlemetrics', 'bm-18'),
  state: 'ok',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-16T06:00:00.000Z'),
  consecutiveFailures: 0,
  lastError: null,
  storedCount: 2,
  headTotal: 2
});
await run();
assert.match(alerts()[0], /^CBL can no longer read ban list \(ID: 18\) on BattleMetrics, as /);
assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 18\)/).length, 1);

// A 404 Unknown ban list, then a 503, then the 404 again: the list stays access_lost, its failures
// count 1, 2, 3, and it is posted about once. The 404's failure is posted in the first run only,
// and the 503's at both attempts, as for any list, as it says something new. Both attempts of the
// run with the 503 count as one run, which keeps why the list lost access.
reset();
battlemetricsList(52, pairs('v', 0, 2), [unknownBanList()]);
battlemetricsList(53, [], [pairs('w', 0, 1)]);
for (const [run, page] of [
  [1, unknownBanList()],
  [2, httpError(503)],
  [3, unknownBanList()]
]) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  battlemetricsLists.set('bm-52', [page]);
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    battlemetricsRequests,
    run === 2 ? ['bm-52', 'bm-53', 'bm-52'] : ['bm-52', 'bm-53'],
    label
  );
  assert.deepStrictEqual(
    [row(52).state, row(52).consecutiveFailures, row(52).lastError],
    ['access_lost', run, 'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'],
    label
  );
  assert.strictEqual(alerts().length, run === 1 ? 1 : 0, label);
  const failures = /^Failed to import ban list \(ID: 52\)/;
  assert.deepStrictEqual(
    [logged(1, failures).length, logged(2, failures).length],
    { 1: [1, 0], 2: [2, 0], 3: [0, 1] }[run],
    label
  );
  assert.deepStrictEqual(storedIDs(52), ['52,v0', '52,v1'], label);
}

// When at least 3 lists, and at least half of the BattleMetrics lists the run tried, lose access
// in the same run, CBL's own BattleMetrics token, or its role in the CBL organisation, is the
// likelier cause, so they are posted about together, once, with the advice to check the token
// before removing any of them. Their rows and their failures are as for one list. Here BattleMetrics
// gives 3 lists' counts but not their bans, does not know a 4th, and does not list a 5th, of 7.
reset();
for (const id of [60, 61, 62]) {
  battlemetricsList(id, pairs(`h${id}-`, 0, 2), [[]]);
  battlemetricsTotals.set(`bm-${id}`, 40);
}
battlemetricsList(63, pairs('i', 0, 2), [pairs('i', 0, 2)]);
battlemetricsList(64, pairs('j', 0, 2), [unknownBanList()]);
battlemetricsList(65, [], [pairs('k', 0, 1)]);
battlemetricsList(66, [], [pairs('l', 0, 1)]);
visibleBanLists = ['bm-60', 'bm-61', 'bm-62', 'bm-64', 'bm-65', 'bm-66'];
for (let run = 1; run <= 2; run++) {
  logs.length = 0;
  await new BanImporter().importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    [60, 61, 62, 63, 64, 65].map((id) => row(id).state),
    [...Array(5).fill('access_lost'), 'ok'],
    label
  );
  assert.deepStrictEqual(
    alerts(),
    run === 1
      ? [
          "CBL lost access to 5 of the 7 BattleMetrics ban lists it tried in this run (IDs: 60, 61, 62, 63, 64): it cannot read them, or BattleMetrics does not list them among the ban lists the CBL organisation can see. So many at once points at CBL's BattleMetrics token, or its role in the CBL organisation, rather than at the lists' owners, so check the token before removing any of these lists. None of their bans are removed while this lasts."
        ]
      : [],
    label
  );
  assert.strictEqual(logged(1, /^Failed to import ban list/).length, run === 1 ? 4 : 0, label);
}
assert.deepStrictEqual([storedIDs(60).length, storedIDs(64).length], [2, 2]);
// Fewer are posted about one by one.
reset();
for (const id of [60, 61]) {
  battlemetricsList(id, pairs(`h${id}-`, 0, 2), [[]]);
  battlemetricsTotals.set(`bm-${id}`, 40);
}
for (const id of [62, 63, 64]) battlemetricsList(id, [], [pairs(`m${id}-`, 0, 1)]);
await run();
assert.deepStrictEqual(
  alerts().map((alert) => alert.slice(0, 32)),
  ['CBL cannot read ban list (ID: 60', 'CBL cannot read ban list (ID: 61']
);

// If CBL's export ban lists, or the lists' rows, cannot be read, nothing is imported: a list that
// imports an export ban list could not be told from the others, and every list's row would look
// new, so its alerts would be posted again. No list is read, fetched, saved or swept, and no row is
// saved or posted about.
for (const [model, error] of [
  [ExportBanList, new Error('SELECT command denied to user for table ExportBanLists')],
  [BanListSync, new Error("Table 'cbl.BanListSyncs' doesn't exist")]
]) {
  reset();
  battlemetricsList(70, pairs('n', 0, 2), [pairs('n', 0, 1)]);
  battlemetricsList(71, pairs('o', 0, 2), [[]]);
  battlemetricsTotals.set('bm-71', 2);
  exportBanLists.push({ id: 5, battlemetricsID: 'bm-70' });
  syncRows.set(71, { ...failedTwice(71, IMPORTED_AT), state: 'access_lost' });
  const findAll = model.findAll;
  model.findAll = async () => {
    throw error;
  };
  await assert.rejects(run(), { message: error.message });
  model.findAll = findAll;
  const label = error.message;
  assert.deepStrictEqual([battlemetricsRequests, written()], [[], []], label);
  assert.ok(!events.some(([type]) => ['read list', 'begin', 'remove'].includes(type)), label);
  assert.deepStrictEqual([storedIDs(70).length, storedIDs(71).length], [2, 2], label);
  assert.deepStrictEqual(syncSaves, [], label);
  assert.deepStrictEqual(alerts(), [], label);
}

// An alert is posted only once its row is saved, so a row that cannot be saved is posted about by
// the next run that saves it, once.
reset();
battlemetricsList(72, pairs('p', 0, 2), [[]]);
battlemetricsTotals.set('bm-72', 2);
battlemetricsList(73, pairs('q', 0, 1), [pairs('q', 0, 1)], 'c0ffee00-cb1e-4a00-b000-0000000000ee');
exportBanLists.push({ id: 6, battlemetricsID: 'c0ffee00-cb1e-4a00-b000-0000000000ee' });
syncError = new ValidationError('Validation error: Validation len on lastError failed');
await run();
assert.deepStrictEqual([syncRows.size, alerts()], [0, []]);
assert.strictEqual(logged(2, /^Could not save the sync state of ban list/).length, 2);
for (let run = 1; run <= 2; run++) {
  syncError = null;
  logs.length = 0;
  await new BanImporter().importBans();
  // The list that imports an export ban list is posted about at once, and the one CBL cannot read
  // once every list has been tried.
  assert.deepStrictEqual(
    alerts().map((alert) => alert.slice(0, 32)),
    run === 1 ? ['Ban list (ID: 73) is not importe', 'CBL cannot read ban list (ID: 72'] : [],
    `run ${run} after the failed save`
  );
}
// A failed fetch that never got BattleMetrics' count of the list's bans keeps the count the row has.
reset();
battlemetricsList(74, pairs('r', 0, 2), [httpError(500)]);
syncRows.set(74, {
  ...failedTwice(74, IMPORTED_AT),
  state: 'ok',
  consecutiveFailures: 0,
  lastError: null,
  headTotal: 4
});
await run();
assert.deepStrictEqual([row(74).state, row(74).headTotal], ['failing', 4]);

// With IMPORTER_ACCESS_CHECK=0, the other two signs of lost access still count: a 404 Unknown ban
// list, and a list that gives no bans but counts some. Neither list is swept.
reset();
battlemetricsList(75, pairs('s', 0, 2), [unknownBanList()]);
battlemetricsList(76, pairs('t', 0, 2), [[]]);
battlemetricsTotals.set('bm-76', 9);
battlemetricsList(77, [], [pairs('u', 0, 1)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '76';
checked = new BanImporter({ accessCheck: '0' });
await checked.importBans();
assert.deepStrictEqual(
  [row(75).state, row(76).state, storedIDs(75).length, storedIDs(76).length],
  ['access_lost', 'access_lost', 2, 2]
);
assert.deepStrictEqual([checked.report().accessCheck, banListReads.length], ['off', 0]);
assert.ok(!events.some(([type]) => type === 'remove'));

// A BattleMetrics list whose source is one of CBL's own export ban lists, however its case, hyphens
// and spaces are written, is neither fetched nor swept, so its bans stay as they are until it is
// removed. It is posted about once, and its row says so, without a time it was tried. A remote
// list with the same source, an export ban list without a BattleMetrics ID, and a source that is
// only part of an export ban list's ID are imported as usual.
const EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000aa';
const OTHER_EXPORT_ID = 'c0ffee00-cb1e-4a00-b000-0000000000bb';
reset();
exportBanLists.push(
  { id: 12, battlemetricsID: EXPORT_ID },
  { id: 13, battlemetricsID: null },
  { id: 14, battlemetricsID: ' - ' },
  { id: 15, battlemetricsID: ` ${OTHER_EXPORT_ID.toUpperCase()} ` }
);
battlemetricsList(21, pairs('t', 0, 3), [pairs('t', 0, 1)], EXPORT_ID.toUpperCase());
battlemetricsList(22, pairs('u', 0, 2), [pairs('u', 0, 1)], EXPORT_ID.replace(/-/g, ''));
battlemetricsList(23, pairs('v', 0, 2), [pairs('v', 0, 1)], ` ${OTHER_EXPORT_ID} `);
battlemetricsList(24, pairs('w', 0, 3), [pairs('w', 0, 2)], EXPORT_ID.slice(0, 8));
banLists.set(25, { id: 25, type: 'remote', source: EXPORT_ID });
remoteLists.set(EXPORT_ID, `${steamID(1)}:0 //Cheating`);
for (let run = 1; run <= 2; run++) {
  logs.length = 0;
  battlemetricsRequests.length = 0;
  remoteRequests.length = 0;
  checked = new BanImporter();
  await checked.importBans();
  assert.deepStrictEqual(battlemetricsRequests, [EXPORT_ID.slice(0, 8)], `run ${run}`);
  assert.deepStrictEqual(remoteRequests, [EXPORT_ID], `run ${run}`);
  assert.deepStrictEqual(
    [21, 22, 23].map((id) => storedIDs(id).length),
    [3, 2, 2],
    `run ${run}`
  );
  for (const id of [21, 22, 23])
    assert.deepStrictEqual(
      [row(id).state, row(id).lastAttemptAt, row(id).lastSuccessAt, row(id).consecutiveFailures],
      ['self_import', null, null, 0],
      `run ${run}, list ${id}`
    );
  assert.deepStrictEqual(
    [row(21).storedCount, row(23).storedCount, row(24).state, row(25).state],
    [3, 2, 'ok', 'ok'],
    `run ${run}`
  );
  assert.deepStrictEqual(storedIDs(24), ['24,w0', '24,w1']);
  assert.deepStrictEqual(
    alerts(),
    run === 1
      ? [
          "Ban list (ID: 21) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 3 stored bans are kept until the list is removed with /banlist remove, which removes them too.",
          "Ban list (ID: 22) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 2 stored bans are kept until the list is removed with /banlist remove, which removes them too.",
          "Ban list (ID: 23) is not imported, as its source is CBL's own export ban list (#15), and importing it would feed the players CBL exports back in as new bans. Its 2 stored bans are kept until the list is removed with /banlist remove, which removes them too."
        ]
      : [],
    `run ${run}`
  );
  assert.strictEqual(
    logged(
      2,
      /^Skipped ban list \(ID: 21\), as its source is CBL's own export ban list \(#12\), so none of its bans were fetched or removed\.$/
    ).length,
    1,
    `run ${run}`
  );
  counts = JSON.parse(JSON.stringify(checked.report()));
  assert.deepStrictEqual(
    [counts.selfImports, counts.banLists.map(({ state }) => state)],
    [3, ['self_import', 'self_import', 'self_import', undefined, undefined]],
    `run ${run}`
  );
  assert.strictEqual(
    summary(),
    run === 1
      ? 'Got 1 deleted ban. Imported 5 ban lists: 3 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
      : 'Got 0 deleted bans. Imported 5 ban lists: 3 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 0 lists failed.',
    `run ${run}`
  );
}

// A list whose type or source was changed since its row was saved, as /banlist update does, starts
// afresh: what was known about its old source, such as its failures, is forgotten, and every
// column of its row is saved again. Otherwise only the import's own columns are saved, so a value
// the bot set in another column is kept.
reset();
battlemetricsList(26, pairs('x', 0, 2), [httpError(503)]);
battlemetricsList(27, [], [pairs('y', 0, 1)]);
await run();
await run();
const due = new Date('2026-10-16T12:00:00.000Z');
syncRows.get(26).nextFullScanAt = due;
syncSaves.length = 0;
await run();
assert.deepStrictEqual([row(26).consecutiveFailures, row(26).nextFullScanAt], [3, due.getTime()]);
// The row is saved once, by the list's second attempt. With head polls off, as here, it also forgets
// the list's newest page, which head polls would compare theirs with.
assert.deepStrictEqual(savedFields(26), [[...IMPORT_FIELDS, 'headUids'].sort()]);
for (const id of storedIDs(26)) bans.delete(id);
banLists.set(26, { ...banLists.get(26), source: 'bm-new' });
battlemetricsLists.set('bm-new', [httpError(503)]);
logs.length = 0;
syncSaves.length = 0;
await run();
assert.deepStrictEqual(
  [
    row(26).sourceKey,
    row(26).consecutiveFailures,
    row(26).nextFullScanAt,
    row(26).storedCount,
    row(26).replacePending
  ],
  [sha256('battlemetrics', 'bm-new'), 1, null, 0, true]
);
assert.deepStrictEqual(savedFields(26).at(-1), [
  ...[...IMPORT_FIELDS, ...Object.keys(FRESH_FIELDS)].sort()
]);
assert.deepStrictEqual(alerts(), []);

// A list removed after its import, before its row is saved, has no row: its foreign key fails, as
// the list is gone, which is not tried again and needs no warning. So does a list removed during
// its import.
reset();
battlemetricsList(28, pairs('z', 0, 2), [pairs('z', 0, 2)]);
battlemetricsList(29, [], [pairs('a', 0, 1)]);
onCount = (id) => {
  if (id === 28) banLists.delete(28);
};
await run();
assert.deepStrictEqual([...syncRows.keys()], [29]);
assert.strictEqual(savedFields(28).length, 1);
assert.strictEqual(logged(2, /Could not save the sync state/).length, 0);
assert.deepStrictEqual(warnings(), []);

// A row that cannot be saved, as the database stays unavailable, costs the list only its row: its
// import is unaffected, and the console says so.
reset();
battlemetricsList(30, pairs('b', 0, 3), [pairs('b', 0, 2)]);
syncError = new ConnectionError();
results = await run();
assert.deepStrictEqual(storedIDs(30), ['30,b0', '30,b1']);
assert.strictEqual(results[0].error, undefined);
assert.strictEqual(syncSaves.length, 5);
assert.deepStrictEqual(delays, [5000, 5000, 5000, 5000]);
assert.strictEqual(
  logged(
    2,
    /^Could not save the sync state of ban list \(ID: 30\): SequelizeConnectionRefusedError: connect ECONNREFUSED/
  ).length,
  1
);
assert.deepStrictEqual(warnings(), []);

// A BattleMetrics list read to its last page is read in full only if it read as many different
// bans, with or without a SteamID, as BattleMetrics counts on its first page, give or take 2 and
// however much that count changed by the last page. A list that was not has its new and changed
// bans saved, but none of its bans removed, and fails, so it is tried again after the other lists.
// Its row counts the incomplete read, which a complete one resets.
reset();
battlemetricsList(80, pairs('a', 0, 20), [[...pairs('a', 0, 15), ['a99', steamID(99)]]]);
battlemetricsTotals.set('bm-80', 40);
battlemetricsList(81, [], [pairs('b', 0, 1)]);
results = await run();
assert.deepStrictEqual(
  storedIDs(80),
  [...pairs('a', 0, 20), ['a99']].map(([uid]) => `80,${uid}`)
);
assert.deepStrictEqual(removedIDs(), []);
assert.deepStrictEqual(battlemetricsRequests, ['bm-80', 'bm-81', 'bm-80']);
assert.deepStrictEqual(
  [results[0].attempt, results[0].error, results[0].stage, results[0].complete],
  [
    2,
    'Error: BattleMetrics counts 40 bans on the list, but 16 were read.',
    'checking that it was read in full',
    false
  ]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Failed to import ban list (ID: 80) while checking that it was read in full, so none of its bans were removed (16 bans fetched, 1 new, 0 updated). Error: BattleMetrics counts 40 bans on the list, but 16 were read.',
    'Failed to import ban list (ID: 80) again while checking that it was read in full, so none of its bans were removed (16 bans fetched, 0 new, 0 updated). Error: BattleMetrics counts 40 bans on the list, but 16 were read.'
  ]
);
assert.deepStrictEqual(
  [row(80).state, row(80).consecutiveFailures, row(80).incompleteScans, row(80).lastFullScanAt],
  ['failing', 1, 1, null]
);
assert.strictEqual(JSON.parse(JSON.stringify(results[0])).complete, false);
// Within the tolerance it is read in full, and loses the bans it no longer has.
battlemetricsTotals.set('bm-80', 18);
results = await run();
assert.deepStrictEqual(
  [results[0].removed, results[0].error, row(80).state, row(80).incompleteScans],
  [5, undefined, 'ok', 0]
);
assert.strictEqual(row(80).lastFullScanAt, row(80).lastSuccessAt);
// Bans without a SteamID count as read, and a count that grew while the list was read widens the
// tolerance by as much.
reset();
const noSteamID = (uid) => [uid, null, 'Cheating', [{ type: 'eosID', identifier: uid }]];
battlemetricsList(82, pairs('c', 0, 12), [
  [...pairs('c', 0, 10), noSteamID('x1'), noSteamID('x2')],
  pairs('c', 10, 11)
]);
battlemetricsTotals.set('bm-82', 13);
results = await run();
assert.deepStrictEqual(
  [results[0].complete, results[0].removed, results[0].fetched],
  [true, 1, 11]
);
reset();
battlemetricsList(82, pairs('c', 0, 12), [pairs('c', 0, 6), pairs('c', 6, 11)]);
battlemetricsTotals.set('bm-82', (page) => (page === 0 ? 8 : 12));
results = await run();
assert.deepStrictEqual([results[0].complete, results[0].removed], [true, 1]);
// A read that found more bans than the count is complete while it is over by no more than 2, and 5
// more, or 0.5% of the count if that is more, as bans it read cannot be missing: here by 3, as one
// list in production is on every read. Over by more, it is not.
reset();
battlemetricsList(82, pairs('c', 0, 12), [pairs('c', 0, 6), pairs('c', 6, 11)]);
battlemetricsTotals.set('bm-82', 8);
results = await run({ countCheck: '1' });
assert.deepStrictEqual([results[0].complete, results[0].removed], [true, 1]);
reset();
battlemetricsList(82, pairs('c', 0, 12), [pairs('c', 0, 6), pairs('c', 6, 11)]);
battlemetricsTotals.set('bm-82', 3);
results = await run({ countCheck: '1' });
assert.deepStrictEqual([results[0].complete, results[0].removed], [false, 0]);
assert.strictEqual(
  results[0].error,
  'Error: BattleMetrics counts 3 bans on the list, but 11 were read.'
);
// A list without a count cannot be checked, so it is not read in full.
reset();
battlemetricsList(83, pairs('d', 0, 3), [pairs('d', 0, 2)]);
battlemetricsTotals.set('bm-83', null);
results = await run();
assert.match(
  results[0].error,
  /^Error: BattleMetrics gave no count of the list's bans, so it could not be checked that every ban was read\.$/
);
assert.strictEqual(storedIDs(83).length, 3);
// Bans recorded as missing that an incomplete read found lose their records, while those it did
// not find keep theirs.
reset();
battlemetricsList(84, pairs('e', 0, 100), [pairs('e', 20, 100)]);
await run();
assert.strictEqual(pendingIDs(84).length, 20);
battlemetricsLists.set('bm-84', [[...pairs('e', 10, 100)]]);
battlemetricsTotals.set('bm-84', 200);
age(84, 60);
results = await run();
assert.deepStrictEqual(
  [results[0].complete, results[0].removed, pendingIDs(84)],
  [false, 0, pairs('e', 0, 10).map(([uid]) => `84,${uid}`)]
);
// IMPORTER_SCAN_COUNT_CHECK=0 turns the check off, so a list read to its last page is read in
// full, and the import says so. An invalid value leaves it on, with a warning posted to the log
// channel.
for (const [setting, on] of [
  ['0', false],
  ['off', false],
  ['1', true],
  ['maybe', true]
]) {
  reset();
  battlemetricsList(85, pairs('f', 0, 5), [pairs('f', 0, 4)]);
  battlemetricsTotals.set('bm-85', 40);
  env.IMPORTER_SCAN_COUNT_CHECK = setting;
  results = await run();
  assert.deepStrictEqual(
    [results[0].complete, results[0].removed, storedIDs(85).length],
    on ? [false, 0, 5] : [true, 1, 4],
    setting
  );
  assert.strictEqual(
    logged(
      2,
      /^IMPORTER_SCAN_COUNT_CHECK is off, so a BattleMetrics list read to its last page counts as read in full/
    ).length,
    on ? 0 : 1,
    setting
  );
  assert.strictEqual(
    logged(
      1,
      /^Warning: IMPORTER_SCAN_COUNT_CHECK must be 1 or 0, not "maybe", so the count check stays on\.$/
    ).length,
    setting === 'maybe' ? 1 : 0
  );
}
// Without the check, a list that gives no bans but counts some is still not an emptied list.
reset();
battlemetricsList(86, pairs('g', 0, 5), [[]]);
battlemetricsTotals.set('bm-86', 4376);
env.IMPORTER_SCAN_COUNT_CHECK = '0';
env.IMPORTER_ALLOW_MASS_REMOVAL = '86';
results = await run();
assert.deepStrictEqual([storedIDs(86).length, row(86).state], [5, 'access_lost']);

// A list whose type or source was changed by hand since it was last imported still has its old
// source's bans, which its new source's replace. They are removed as other missing bans are, a few
// at once and more once a later complete read confirms they are gone, but never held for an
// admin, though the list lost all of them. Its row says the replace is under way until none of the
// old bans is left, and its line is posted while bans are being replaced.
reset();
battlemetricsList(90, pairs('o', 0, 30), [pairs('n', 100, 110)], 'bm-90-new');
syncRows.set(90, {
  banList: 90,
  sourceKey: sha256('battlemetrics', 'bm-90'),
  state: 'ok',
  consecutiveFailures: 0,
  replacePending: 0
});
results = await run();
assert.deepStrictEqual(
  [storedIDs(90).length, pendingIDs(90).length, results[0].replace, results[0].held],
  [40, 30, true, 30]
);
assert.deepStrictEqual(
  [row(90).sourceKey, row(90).replacePending, row(90).state],
  [sha256('battlemetrics', 'bm-90-new'), true, 'held']
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 90): 10 bans fetched, 10 new, 0 updated. Its type or source was changed since it was last imported, so the bans of its old source are being replaced: 0 were removed, and 30 more are kept until a later complete read of it confirms they are gone.'
  ]
);
// The next run, at least 10 minutes on, removes them, and the replace is done.
age(90, 10);
logs.length = 0;
results = await run();
assert.deepStrictEqual(
  [storedIDs(90).length, results[0].removed, results[0].replace, row(90).replacePending],
  [10, 30, true, false]
);
assert.match(warnings()[0].message, /being replaced: 30 were removed\.$/);
logs.length = 0;
results = await run();
assert.deepStrictEqual([results[0].replace, results[0].removed, warnings()], [false, 0, []]);
// A list whose old bans the bot deleted with /banlist update has none to replace, so the replace
// is done at once, and nothing is posted.
reset();
battlemetricsList(91, [], [pairs('n', 0, 3)], 'bm-91-new');
syncRows.set(91, { banList: 91, sourceKey: sha256('battlemetrics', 'bm-91'), state: 'ok' });
results = await run();
assert.deepStrictEqual([results[0].replace, row(91).replacePending, warnings()], [true, false, []]);
// A changed source that gives no bans at all is a replace too, not held for an admin.
reset();
battlemetricsList(92, pairs('o', 0, 30), [[]], 'bm-92-new');
syncRows.set(92, { banList: 92, sourceKey: sha256('battlemetrics', 'bm-92'), state: 'ok' });
results = await run();
assert.deepStrictEqual([results[0].hold, results[0].pending], [null, 30]);
age(92, 10);
results = await run();
assert.deepStrictEqual([storedIDs(92).length, row(92).replacePending], [0, false]);

// A remote list's file is kept by its ETag, Last-Modified and SHA-256 once the list is imported
// from it in full. The next run asks its host whether the file has changed, and an answer of 304
// Not Modified means it has not: its bans are not written again, but whether each has expired is
// brought up to date. A host that answers with the file again, without an ETag, gives the same
// SHA-256, so the file has not changed either. A changed file is imported as usual.
reset();
const REMOTE = 'https://bans.example/95.txt';
banLists.set(95, { id: 95, type: 'remote', source: REMOTE });
const FILE = `${steamID(1)}:0 //Cheating\n${steamID(2)}:946684800 //Toxic`;
const LAST_MODIFIED = 'Wed, 21 Oct 2026 10:00:00 GMT';
remoteLists.set(REMOTE, {
  status: 200,
  data: FILE,
  headers: { etag: '"v1"', 'last-modified': LAST_MODIFIED }
});
results = await run();
assert.deepStrictEqual([results[0].created, remoteHeaders], [2, [{}]]);
const fileHash = createHash('sha256').update(FILE).digest('hex');
assert.deepStrictEqual(
  [row(95).remoteEtag, row(95).remoteLastModified, row(95).remoteBodyHash],
  ['"v1"', LAST_MODIFIED, fileHash]
);
// Meanwhile one of its bans has expired: here it was saved before it did.
const expiredID = `95,${steamID(2)},946684800000`;
bans.get(expiredID).expired = false;
steamUsers.set(steamID(2), user(steamID(2)));
remoteLists.set(REMOTE, { status: 304, data: '', headers: {} });
events.length = 0;
logs.length = 0;
results = await run();
assert.deepStrictEqual(remoteHeaders.at(-1), {
  'If-None-Match': '"v1"',
  'If-Modified-Since': LAST_MODIFIED
});
assert.deepStrictEqual(
  [results[0].unchanged, results[0].fetched, results[0].created, results[0].updated],
  [true, 2, 0, 1]
);
assert.deepStrictEqual(written(), [expiredID]);
assert.strictEqual(bans.get(expiredID).expired, true);
assert.strictEqual(steamUsers.get(steamID(2)).lastRefreshedExport, null);
assert.strictEqual(
  logged(
    2,
    /^Imported ban list \(ID: 95\): its file is unchanged since it was last imported, so it was not read again \(2 bans fetched, 0 new, 1 updated\)\.$/
  ).length,
  1
);
assert.deepStrictEqual(
  [row(95).remoteEtag, row(95).remoteLastModified, row(95).remoteBodyHash],
  ['"v1"', LAST_MODIFIED, fileHash]
);
// A remote list's row is saved with the import's columns and its file's.
assert.deepStrictEqual(savedFields(95).at(-1), [...IMPORT_FIELDS, ...REMOTE_FIELDS].sort());
// The same file without an ETag has not changed either, and nothing is written.
remoteLists.set(REMOTE, FILE);
events.length = 0;
results = await run();
assert.deepStrictEqual([results[0].unchanged, writes()], [true, []]);
assert.deepStrictEqual(
  [row(95).remoteEtag, row(95).remoteLastModified, row(95).remoteBodyHash],
  [null, null, fileHash]
);
// So the next run has no question to ask, and reads a changed file in full.
remoteLists.set(REMOTE, `${FILE}\n${steamID(3)}:0 //Cheating`);
results = await run();
assert.deepStrictEqual(remoteHeaders.at(-1), {});
assert.deepStrictEqual([results[0].unchanged, results[0].created], [undefined, 1]);
// A list some of whose bans were kept back, or that failed, forgets its file, so the next run
// reads it in full.
reset();
remoteList(96, [1, 2], { status: 200, data: '', headers: { etag: '"empty"' } });
await run();
assert.deepStrictEqual(
  [row(96).state, row(96).remoteEtag, row(96).remoteBodyHash],
  ['held', null, null]
);
await run();
assert.deepStrictEqual(remoteHeaders, [{}, {}]);
reset();
remoteList(96, [1], `${steamID(1)}:0 //Cheating`);
await run();
assert.ok(row(96).remoteBodyHash);
remoteLists.set('https://bans.example/96.txt', httpError(404));
await run();
assert.strictEqual(row(96).remoteBodyHash, null);
// A list whose bans are being replaced never asks about its file.
reset();
remoteList(97, [1], `${steamID(1)}:0 //Cheating`);
syncRows.set(97, {
  banList: 97,
  sourceKey: sha256('remote', 'https://bans.example/old.txt'),
  state: 'ok',
  remoteEtag: '"v1"',
  remoteBodyHash: 'a'.repeat(64)
});
await run();
assert.deepStrictEqual(remoteHeaders, [{}]);

// IMPORTER_DRY_RUN=1 reads everything and writes nothing: no ban, player, record of a missing ban
// or row is written, and nothing is posted about the lists, only that the run is a dry run. Its
// counts and its lines in the console say what the import would have done, and its report says it
// was a dry run. Quotes around the value, which docker run --env-file keeps, make no difference.
for (const setting of ['1', '"1"']) {
  reset();
  battlemetricsList(98, pairs('d', 0, 30), [
    [['d0', steamID(0), 'Teamkilling'], ...pairs('d', 1, 25), ['d99', steamID(99)]]
  ]);
  battlemetricsList(99, pairs('e', 0, 30), [pairs('e', 0, 15)]);
  battlemetricsList(100, pairs('f', 0, 5), [[]]);
  env.IMPORTER_DRY_RUN = setting;
  const dryRun = new BanImporter();
  results = await dryRun.importBans();
  assert.ok(dryRun.dryRun, setting);
  assert.deepStrictEqual(writes(), [], setting);
  assert.deepStrictEqual([syncSaves, [...pendingRows.keys()]], [[], []], setting);
  assert.deepStrictEqual(
    [storedIDs(98).length, storedIDs(99).length, steamUsers.has(steamID(99))],
    [30, 30, false],
    setting
  );
  assert.deepStrictEqual(
    Array.from(results, ({ created, updated, removed, held, pending }) => [
      created,
      updated,
      removed,
      held,
      pending
    ]),
    [
      [1, 1, 5, 0, 0],
      [0, 0, 0, 15, 15],
      [0, 0, 0, 5, 0]
    ],
    setting
  );
  const counts = JSON.parse(JSON.stringify(dryRun.report()));
  assert.deepStrictEqual(
    [counts.dryRun, counts.new, counts.updated, counts.removed, counts.held, counts.pending],
    [true, 1, 1, 5, 20, 15],
    setting
  );
  // Only that the run is a dry run is posted, so one left on by mistake is seen.
  assert.deepStrictEqual(
    warnings().map(({ message }) => message),
    [
      'IMPORTER_DRY_RUN is on, so this run writes nothing: it only says what the import would change.'
    ],
    setting
  );
  for (const pattern of [
    /^Would save new ban \(ID: 98,d99\) in ban list \(ID: 98\)\.$/,
    /^Would save updated ban \(ID: 98,d0\) in ban list \(ID: 98\): reason, rawReason changed\.$/,
    /^Would remove ban \(ID: 98,d25\) from ban list \(ID: 98\)\.$/,
    /^Checked ban list \(ID: 98\): 26 bans fetched, 1 new, 1 updated, 5 removed\. Nothing was written, as IMPORTER_DRY_RUN is on\.$/,
    /^Checked ban list \(ID: 100\): it returned no bans, so its 5 stored bans were kept in case the list is broken\. .* Nothing was written, as IMPORTER_DRY_RUN is on\.$/
  ])
    assert.strictEqual(logged(2, pattern).length, 1, `${setting}: ${pattern}`);
  assert.match(summary(), / Nothing was written, as IMPORTER_DRY_RUN is on\.$/, setting);
}
// A list whose type or source is changed while a dry run imports it has none of the bans fetched
// removed, as the dry run saved none of them, and the bans it had stay as they were.
reset();
battlemetricsList(98, pairs('d', 0, 30), [[...pairs('d', 0, 25), ['d99', steamID(99)]]]);
env.IMPORTER_DRY_RUN = '1';
const findListOnce = BanList.findByPk;
BanList.findByPk = async (id, options) => {
  // The list is read again before its bans are checked for removal, after its source changed.
  if (options?.attributes?.includes('source'))
    banLists.set(id, { ...banLists.get(id), source: 'bm-98-new' });
  return findListOnce(id, options);
};
results = await run();
BanList.findByPk = findListOnce;
assert.deepStrictEqual(writes(), []);
assert.deepStrictEqual(
  storedIDs(98),
  pairs('d', 0, 30).map(([uid]) => `98,${uid}`)
);
assert.deepStrictEqual(
  [results[0].sourceChanged, results[0].created, results[0].removed],
  [true, 1, 0]
);
assert.strictEqual(
  logged(
    2,
    /^Checked ban list \(ID: 98\), but its type or source was changed while it was read \(26 bans fetched, 1 new, 0 updated\)\. Its new source is imported on the next run\. Nothing was written, as IMPORTER_DRY_RUN is on\.$/
  ).length,
  1
);
// Nor does a dry run's read that is not complete drop the records of the missing bans it found.
reset();
battlemetricsList(99, pairs('e', 0, 30), [pairs('e', 0, 25)]);
battlemetricsTotals.set('bm-99', 90);
for (const [uid] of pairs('e', 0, 10))
  pendingRows.set(`99,99,${uid}`, {
    banList: 99,
    banId: `99,${uid}`,
    firstMissingAt: Date.now() - 60 * 60 * 1000,
    lastMissingAt: Date.now() - 60 * 60 * 1000,
    heldAt: null
  });
env.IMPORTER_DRY_RUN = '1';
results = await run();
assert.deepStrictEqual(writes(), []);
assert.deepStrictEqual(
  [results[0].complete, results[0].stage, pendingIDs(99).length],
  [false, 'checking that it was read in full', 10]
);
// An invalid value, such as one with a comment after it, which docker run --env-file keeps too,
// fails the import before it reads anything, as the run cannot tell whether it may write. Until
// then the run is taken to be a dry run, so it runs no other step.
for (const setting of ['maybe', '0 # done', '"0']) {
  reset();
  battlemetricsList(98, [], [pairs('d', 0, 1)]);
  env.IMPORTER_DRY_RUN = setting;
  const refused = new BanImporter();
  await assert.rejects(refused.importBans(), {
    message: `IMPORTER_DRY_RUN must be 1 or 0, not "${setting}", so the run imported nothing, as it cannot tell whether it may write. Set it to 1 for a dry run, or to 0 or nothing for a run that writes.`
  });
  assert.ok(refused.dryRun, setting);
  assert.deepStrictEqual([events, battlemetricsRequests, syncSaves, logs], [[], [], [], []]);
  assert.deepStrictEqual(storedIDs(98), [], setting);
}
// Without the setting, or with it off, a run writes.
for (const setting of [undefined, '0', '"0"', " 'off' "]) {
  reset();
  if (setting !== undefined) env.IMPORTER_DRY_RUN = setting;
  battlemetricsList(98, [], [pairs('d', 0, 1)]);
  const writing = new BanImporter();
  await writing.importBans();
  assert.deepStrictEqual(
    [writing.dryRun, storedIDs(98).length, JSON.parse(JSON.stringify(writing.report())).dryRun],
    [false, 1, undefined],
    String(setting)
  );
  assert.deepStrictEqual(warnings(), [], String(setting));
}

// A ban whose stored player is no longer one of its SteamIDs, e.g. as its partner corrected the
// SteamID, would move to the first SteamID an admin added to it, or else to its first. Until
// IMPORTER_APPLY_STEAMID_MOVES=1, such a ban keeps its stored player, and is counted and logged,
// while its other changes are still saved. A ban whose stored player is still one of its SteamIDs
// keeps it, whichever comes first. A new ban is for the first SteamID an admin added.
reset();
const steamIDs = (...entries) =>
  entries.map(([n, manual]) => ({ type: 'steamID', identifier: steamID(n), manual }));
battlemetricsList(
  110,
  [
    ['a', steamID(1)],
    ['b', steamID(2)],
    ['c', steamID(3)]
  ],
  [
    [
      ['a', null, 'Cheating', steamIDs([11, true])],
      ['b', null, 'Toxic', steamIDs([12, false], [13, true])],
      ['c', null, 'Cheating', steamIDs([14, true], [3, false])],
      ['d', null, 'Cheating', steamIDs([15, false], [16, true])]
    ]
  ]
);
results = await run();
assert.deepStrictEqual(
  ['a', 'b', 'c', 'd'].map((uid) => bans.get(`110,${uid}`).steamUser),
  [steamID(1), steamID(2), steamID(3), steamID(16)]
);
assert.strictEqual(bans.get('110,b').rawReason, 'Toxic');
assert.deepStrictEqual(written(), ['110,d', '110,b']);
assert.deepStrictEqual([results[0].moves, results[0].created, results[0].updated], [2, 1, 1]);
assert.strictEqual(
  logged(
    2,
    /^Ban \(ID: 110,a\) in ban list \(ID: 110\) is for player 76561198000000001, who is no longer one of its SteamIDs, so it would move to 76561198000000011 with IMPORTER_APPLY_STEAMID_MOVES=1\.$/
  ).length,
  1
);
assert.strictEqual(
  logged(
    2,
    /^Imported ban list \(ID: 110\): 4 bans fetched, 1 new, 1 updated, 2 bans to move to another SteamID\.$/
  ).length,
  1
);
assert.strictEqual(
  logged(
    2,
    /^2 bans are for a player who is no longer one of the ban's SteamIDs\. They keep their player until IMPORTER_APPLY_STEAMID_MOVES=1 moves them\.$/
  ).length,
  1
);
assert.deepStrictEqual(warnings(), []);
// With the setting on, they move, and both the old and the new player of each are queued.
env.IMPORTER_APPLY_STEAMID_MOVES = '1';
for (const n of [1, 2, 11, 13])
  if (steamUsers.has(steamID(n))) steamUsers.set(steamID(n), user(steamID(n)));
events.length = 0;
logs.length = 0;
results = await run();
assert.deepStrictEqual(
  ['a', 'b', 'c', 'd'].map((uid) => bans.get(`110,${uid}`).steamUser),
  [steamID(11), steamID(13), steamID(3), steamID(16)]
);
assert.deepStrictEqual([results[0].moves, results[0].updated], [2, 2]);
for (const n of [1, 2, 11, 13])
  assert.strictEqual(steamUsers.get(steamID(n)).lastRefreshedReputationPoints, null, `player ${n}`);
assert.strictEqual(steamUsers.get(steamID(3)).lastRefreshedReputationPoints, FRESH);
assert.strictEqual(
  logged(
    2,
    /^Moving ban \(ID: 110,a\) in ban list \(ID: 110\) from player 76561198000000001 to 76561198000000011, as 76561198000000001 is no longer one of its SteamIDs\.$/
  ).length,
  1
);
assert.ok(!logs.some(({ message }) => /keep their player/.test(message)));
// Once moved, they stay.
results = await run();
assert.deepStrictEqual([results[0].moves, results[0].updated], [0, 0]);
// A single such ban is counted as one.
reset();
battlemetricsList(111, [['a', steamID(1)]], [[['a', null, 'Cheating', steamIDs([11, true])]]]);
await run();
assert.strictEqual(
  logged(
    2,
    /^Imported ban list \(ID: 111\): 1 bans fetched, 0 new, 0 updated, 1 ban to move to another SteamID\.$/
  ).length,
  1
);
assert.strictEqual(
  logged(
    2,
    /^1 ban is for a player who is no longer one of the ban's SteamIDs\. It keeps its player until IMPORTER_APPLY_STEAMID_MOVES=1 moves it\.$/
  ).length,
  1
);

// An admin's permission to lose all its bans is for the list's source when it was given. A list
// whose source was changed since, by hand, has its old source's bans replaced as usual: those
// missing wait for a later complete read, rather than being removed at once.
reset();
battlemetricsList(120, pairs('a', 0, 30), [[]], 'bm-120-new');
syncRows.set(120, {
  banList: 120,
  sourceKey: sha256('battlemetrics', 'bm-120'),
  state: 'held',
  consecutiveFailures: 0,
  allowFullRemovalUntil: new Date(Date.now() + 2 * 60 * 60 * 1000)
});
results = await run();
assert.deepStrictEqual(
  [results[0].replace, results[0].removed, results[0].pending, storedIDs(120).length],
  [true, 0, 30, 30]
);
assert.strictEqual(results[0].massRemoval, undefined);

// A remote list whose bans were not all removed, as the removal failed, or not all saved, forgets
// its file, so the next run reads it in full and tries them again.
reset();
remoteList(121, [1, 2], {
  status: 200,
  data: `${steamID(1)}:0 //Cheating`,
  headers: { etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2026 10:00:00 GMT' }
});
removeError = new DatabaseError(
  'Cannot delete or update a parent row: a foreign key constraint fails',
  { errno: 1451 }
);
results = await run();
assert.deepStrictEqual(
  [results[0].stage, results[0].removed, storedIDs(121).length],
  ['removing the bans it no longer has', 0, 2]
);
assert.match(results[0].error, /^SequelizeDatabaseError: Cannot delete/);
assert.deepStrictEqual(
  [row(121).remoteEtag, row(121).remoteLastModified, row(121).remoteBodyHash],
  [null, null, null]
);
reset();
remoteList(122, [1], {
  status: 200,
  data: `${steamID(1)}:0 //Toxic\n${steamID(3)}:0 //Cheating`,
  headers: { etag: '"v1"' }
});
writeErrors.set(`122,${steamID(3)},null`, [
  new ValidationError('Validation error'),
  new ValidationError('Validation error')
]);
results = await run();
assert.deepStrictEqual(
  [results[0].failed, results[0].updated, results[0].error],
  [1, 1, undefined]
);
assert.deepStrictEqual(
  [row(122).remoteEtag, row(122).remoteLastModified, row(122).remoteBodyHash],
  [null, null, null]
);

// A ban written alone, once its batch failed, that cannot be written as the database stays
// unavailable stops the list, as the batch would have: the list fails, none of its bans are
// removed, and the ban is not counted as one that could not be saved.
reset();
battlemetricsList(123, pairs('b', 0, 5), [
  [...pairs('b', 0, 3), ['b7', steamID(7)], ['b8', steamID(8)]]
]);
writeErrors.set('123,b7', [
  new ValidationError('Validation error'),
  ...Array.from({ length: 5 }, () => new ConnectionError())
]);
results = await run();
assert.deepStrictEqual(
  [results[0].failed, results[0].stage, removedIDs(), written()],
  [0, 'saving its bans', [], []]
);
assert.match(results[0].error, /^SequelizeConnectionRefusedError: /);
assert.deepStrictEqual(
  storedIDs(123),
  pairs('b', 0, 5).map(([uid]) => `123,${uid}`)
);

// A list whose source is changed while it is imported has the bans fetched from its old source
// removed, each with its players queued for an update: the one the fetcher chose for it, and the
// one it was saved with, here that of a ban whose SteamID was corrected, which it keeps until
// moves are applied.
reset();
battlemetricsList(
  124,
  [
    ['a', steamID(1)],
    ['b', steamID(2)]
  ],
  [
    [
      ['a', null, 'Cheating', [{ type: 'steamID', identifier: steamID(11) }]],
      ['b', steamID(2)]
    ]
  ]
);
steamUsers.set(steamID(11), user(steamID(11)));
const readBeforeChange = BanList.findByPk;
BanList.findByPk = async (id, options) => {
  if (options?.attributes?.includes('source'))
    banLists.set(id, { ...banLists.get(id), source: 'bm-124-new' });
  return readBeforeChange(id, options);
};
results = await run();
BanList.findByPk = readBeforeChange;
assert.deepStrictEqual(
  [results[0].sourceChanged, results[0].moves, results[0].removed, storedIDs(124)],
  [true, 1, 2, []]
);
for (const n of [1, 2, 11])
  assert.strictEqual(steamUsers.get(steamID(n)).lastRefreshedExport, null, `player ${n}`);

// A read whose last page counts no bans, though its first counted 300, cannot widen the count
// check's tolerance to most of the list: it is not complete, so none of the bans it did not find
// are recorded or removed.
reset();
battlemetricsList(125, pairs('c', 0, 300), [pairs('c', 0, 50), pairs('c', 50, 100)]);
battlemetricsTotals.set('bm-125', (page) => (page === 0 ? 300 : 0));
results = await run();
assert.deepStrictEqual(
  [results[0].complete, results[0].removed, results[0].held, pendingIDs(125)],
  [false, 0, 0, []]
);
assert.strictEqual(storedIDs(125).length, 300);
assert.match(
  results[0].error,
  /^Error: BattleMetrics counts 300 bans on the list's first page, but 0 on a later one, /
);

// A list that IMPORTER_SCAN_COUNT_CHECK_SKIP names is left out of the count check, so a read of it
// to its last page is complete, whatever its count, and it loses the bans it no longer has. The
// other lists are checked, and the import says which it leaves out.
reset();
battlemetricsList(126, pairs('d', 0, 5), [pairs('d', 0, 4)]);
battlemetricsTotals.set('bm-126', 40);
battlemetricsList(127, pairs('e', 0, 5), [pairs('e', 0, 4)]);
battlemetricsTotals.set('bm-127', 40);
env.IMPORTER_SCAN_COUNT_CHECK_SKIP = ' "126" ';
results = await run();
assert.deepStrictEqual(
  Array.from(results, ({ id, complete, removed }) => [id, complete, removed]),
  [
    [126, true, 1],
    [127, false, 0]
  ]
);
assert.deepStrictEqual([storedIDs(126).length, storedIDs(127).length], [4, 5]);
assert.strictEqual(
  logged(
    2,
    /^IMPORTER_SCAN_COUNT_CHECK_SKIP turns the count check off for ban lists 126, so each of them read to its last page counts as read in full\.$/
  ).length,
  1
);

// A list whose last run did not read it in full either is not tried again in the run, and its
// failure only goes to the console, as it was posted when it started. Its row counts the runs, and
// the alert for 3 failed runs in a row still comes.
reset();
battlemetricsList(128, pairs('f', 0, 5), [pairs('f', 0, 4)]);
battlemetricsTotals.set('bm-128', 40);
battlemetricsList(129, [], [pairs('g', 0, 1)]);
for (let attempt = 1; attempt <= 3; attempt++) {
  logs.length = 0;
  delays.length = 0;
  battlemetricsRequests.length = 0;
  await run();
  const label = `run ${attempt}`;
  assert.deepStrictEqual(
    [battlemetricsRequests, delays],
    attempt === 1 ? [['bm-128', 'bm-129', 'bm-128'], [60 * 1000]] : [['bm-128', 'bm-129'], []],
    label
  );
  assert.deepStrictEqual(
    [row(128).incompleteScans, row(128).consecutiveFailures, storedIDs(128).length],
    [attempt, attempt, 5],
    label
  );
  const failures = /^Failed to import ban list \(ID: 128\)/;
  assert.deepStrictEqual(
    [logged(1, failures).length, logged(2, failures).length],
    attempt === 1 ? [2, 0] : [0, 1],
    label
  );
  assert.deepStrictEqual(
    alerts().map((alert) => alert.slice(0, 61)),
    attempt === 3 ? ['Ban list (ID: 128) has failed to import 3 runs in a row, so i'] : [],
    label
  );
}
// Reads of a list's old source say nothing about its new one, which is tried again and posted.
reset();
battlemetricsList(128, pairs('f', 0, 5), [pairs('f', 0, 4)], 'bm-128-new');
battlemetricsTotals.set('bm-128-new', 40);
battlemetricsList(129, [], [pairs('g', 0, 1)]);
syncRows.set(128, {
  banList: 128,
  sourceKey: sha256('battlemetrics', 'bm-128'),
  state: 'failing',
  consecutiveFailures: 2,
  incompleteScans: 2
});
await run();
assert.deepStrictEqual(battlemetricsRequests, ['bm-128-new', 'bm-129', 'bm-128-new']);
assert.strictEqual(logged(1, /^Failed to import ban list \(ID: 128\)/).length, 2);

// A list removed by the bot just after it is read again, before its missing bans are recorded,
// fails their records' foreign key, as it is gone. It is skipped as removed during the run, as it
// would be while its bans are saved, rather than failing: nothing is posted, and it counts as no
// failed list.
reset();
battlemetricsList(130, pairs('h', 0, 30), [pairs('h', 0, 15)]);
const readBeforeRemoval = BanList.findByPk;
BanList.findByPk = async (id, options) => {
  const list = await readBeforeRemoval(id, options);
  if (options?.attributes?.includes('source')) {
    banLists.delete(id);
    for (const banID of storedIDs(id)) bans.delete(banID);
  }
  return list;
};
const removedMeanwhile = new BanImporter();
results = await removedMeanwhile.importBans();
BanList.findByPk = readBeforeRemoval;
assert.deepStrictEqual(
  [results[0].gone, results[0].error, results[0].held, results[0].pending],
  [true, undefined, 0, 0]
);
assert.deepStrictEqual(warnings(), []);
assert.strictEqual(
  logged(2, /^Skipped ban list \(ID: 130\), as it was removed during the run\.$/).length,
  1
);
assert.deepStrictEqual(
  [JSON.parse(JSON.stringify(removedMeanwhile.report())).failedLists, syncRows.has(130)],
  [0, false]
);
assert.match(summary(), /, 0 held, 0 lists failed\.$/);
// The same error while the list is still there fails it, as any other failure would.
reset();
battlemetricsList(131, pairs('i', 0, 30), [pairs('i', 0, 15)]);
pendingError = new ForeignKeyConstraintError('banList');
results = await run();
assert.deepStrictEqual(
  [results[0].gone, results[0].stage, storedIDs(131).length],
  [undefined, 'removing the bans it no longer has', 30]
);
assert.match(results[0].error, /^SequelizeForeignKeyConstraintError: /);
assert.strictEqual(
  logged(
    1,
    /^Failed to import ban list \(ID: 131\) while removing the bans it no longer has, so none of its bans were removed/
  ).length,
  1
);

// Head polls. From here the lists are read as runs read them by default: a list that is not due a
// full read only has its newest bans read. A list's bans are served newest first, 5 to a page here,
// from entries a check changes between runs, and BattleMetrics' pages move as bans are added or
// removed.
const paged = (entries, size = 5) => {
  const pages = [];
  for (let i = 0; i < entries.length; i += size) pages.push(entries.slice(i, i + size));
  return pages.length > 0 ? pages : [[]];
};
const serve = (id, entries) => battlemetricsLists.set(`bm-${id}`, paged(entries));
// What a run asked BattleMetrics for: each request's list, and its page, or newest for a first page.
const asked = () =>
  battlemetricsParams.map((params) => [params['filter[banList]'], params['page[key]'] ?? 'newest']);
// One run, with what it logged, did and asked for alone, and its report for the run record.
async function pollRun(options) {
  for (const list of [logs, events, battlemetricsRequests, battlemetricsParams, delays])
    list.length = 0;
  const importer = new BanImporter(options);
  const ran = await importer.importBans();
  return { results: ran, report: JSON.parse(JSON.stringify(importer.report())) };
}
const readsOf = (polled) =>
  polled.report.banLists.map(({ id, read, reason }) => [id, read, reason ?? null]);

// A new list is read in full, newest first, as a poll needs its newest page to start from. Its row
// keeps the IDs of the bans on that page, all of them, with or without a SteamID, and
// BattleMetrics' count, and the list is due its next full read in 24 to 30 minutes.
reset();
delete env.IMPORTER_HEAD_POLL;
let newestFirst = [...pairs('h', 0, 4), noSteamID('hx'), ...pairs('h', 4, 22)];
battlemetricsList(90, [], paged(newestFirst));
battlemetricsList(91, [], paged(pairs('i', 0, 4)));
let polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [90, 'full', 'new'],
  [91, 'full', 'new']
]);
assert.deepStrictEqual(
  [polled.report.headPolls, polled.report.fullReads, polled.report.requests],
  [0, 2, { head: 0, follow: 0, full: 6 }]
);
assert.deepStrictEqual(battlemetricsParams[0], {
  'filter[banList]': 'bm-90',
  sort: '-timestamp',
  'page[size]': 100
});
const firstRead = row(90);
assert.deepStrictEqual(
  [
    JSON.parse(firstRead.headUids),
    firstRead.headTotal,
    firstRead.lastHeadPollAt,
    firstRead.lastFullScanAt,
    firstRead.scanReason,
    storedIDs(90).length
  ],
  [
    ['h0', 'h1', 'h2', 'h3', 'hx'],
    23,
    firstRead.lastAttemptAt,
    firstRead.lastAttemptAt,
    'periodic',
    22
  ]
);
assert.ok(dueIn(firstRead, 24, 30));

// The next run, within 24 minutes, is not due to read them in full, so it only polls them: one
// request a list. Only the stored bans on list 90's newest page are read, and nothing is written.
// List 91's newest page is all of it, so it is read as a list read in full, with all its stored
// bans and its missing ones, which may remove any it lost.
polled = await pollRun();
assert.deepStrictEqual(asked(), [
  ['bm-90', 'newest'],
  ['bm-91', 'newest']
]);
assert.deepStrictEqual(
  [polled.report.headPolls, polled.report.fullReads, polled.report.requests],
  [2, 0, { head: 2, follow: 0, full: 0 }]
);
assert.deepStrictEqual(writes(), []);
assert.deepStrictEqual(
  events.filter(([type]) => type.startsWith('select')),
  [
    ['select some', 90, ['90,h0', '90,h1', '90,h2', '90,h3']],
    ['select', 91],
    ['select pending', 91]
  ]
);
assert.deepStrictEqual(polled.report.banLists, [
  { id: 90, fetched: 4, new: 0, updated: 0, removed: 0, held: 0, read: 'head' },
  { id: 91, fetched: 4, new: 0, updated: 0, removed: 0, held: 0, read: 'head', stored: 4 }
]);
assert.strictEqual(
  logged(2, /^Polled ban list \(ID: 90\): 4 bans fetched, 0 new, 0 updated\.$/).length,
  1
);
assert.strictEqual(
  logged(2, /^Imported ban list \(ID: 91\): 4 bans fetched, 0 new, 0 updated\.$/).length,
  1
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 2 ban lists: 8 bans fetched, 0 new, 0 updated, 0 removed, 0 held, 0 lists failed.'
);
assert.strictEqual(
  logged(
    2,
    /^Polled 2 ban lists and read 0 in full, with 2 BattleMetrics requests: 2 for newest pages, 0 following them and 0 for full reads\.$/
  ).length,
  1
);
// A poll keeps when the list was last read in full, and when it is next due to be, and saves when
// its newest page was read. List 91, read in full by its poll, is due again in 24 to 30 minutes.
assert.deepStrictEqual(
  [row(90).lastFullScanAt, row(90).nextFullScanAt, row(90).headTotal],
  [firstRead.lastFullScanAt, firstRead.nextFullScanAt, 23]
);
assert.ok(row(90).lastHeadPollAt >= firstRead.lastHeadPollAt);
assert.strictEqual(row(90).lastHeadPollAt, row(90).lastAttemptAt);
assert.strictEqual(row(91).lastFullScanAt, row(91).lastAttemptAt);
assert.ok(dueIn(row(91), 24, 30));

// A ban added on top of a list is saved by the next poll, and its player queued for an update, with
// no other request.
newestFirst = [['hn1', steamID(101)], ...newestFirst];
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual(written(), ['90,hn1']);
assert.deepStrictEqual(polled.report.requests, { head: 2, follow: 0, full: 0 });
assert.strictEqual(steamUsers.get(steamID(101)).lastRefreshedReputationPoints, null);
assert.strictEqual(logged(2, /^Found new ban \(ID: 90,hn1\) in ban list \(ID: 90\)\.$/).length, 1);
assert.deepStrictEqual(
  [JSON.parse(row(90).headUids), row(90).headTotal],
  [['hn1', 'h0', 'h1', 'h2', 'h3'], 24]
);
// So is a ban on its newest page that was changed.
newestFirst[2] = ['h1', steamID(1), 'Toxicity'];
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual([written(), polled.report.banLists[0].updated], [['90,h1'], 1]);
assert.strictEqual(bans.get('90,h1').rawReason, 'Toxicity');

// A ban removed below the newest page leaves BattleMetrics' count one short of what the new bans
// explain, so the list is read in full in the same run, from the page after its newest, which is
// not read again, and the ban is removed. The list is then due its next periodic full read.
newestFirst = newestFirst.filter(([uid]) => uid !== 'h15');
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual(asked(), [
  ['bm-90', 'newest'],
  ['bm-90', '1'],
  ['bm-90', '2'],
  ['bm-90', '3'],
  ['bm-90', '4'],
  ['bm-91', 'newest']
]);
assert.deepStrictEqual(polled.report.requests, { head: 2, follow: 0, full: 4 });
assert.deepStrictEqual(removedIDs(), ['90,h15']);
assert.deepStrictEqual(polled.report.banLists[0], {
  id: 90,
  fetched: 22,
  new: 0,
  updated: 0,
  removed: 1,
  held: 0,
  read: 'full',
  reason: 'drift',
  drift: { total: 23, expected: 24 },
  stored: 23
});
assert.strictEqual(
  logged(
    2,
    /^Reading ban list \(ID: 90\) in full, as BattleMetrics counts 23 bans on it, but its count at its last read and the 0 new bans on its newest page make 24, so a ban was removed, or added below its newest page\.$/
  ).length,
  1
);
assert.deepStrictEqual(
  [row(90).scanReason, row(90).lastFullScanAt, row(90).headTotal],
  ['periodic', row(90).lastAttemptAt, 23]
);
assert.ok(dueIn(row(90), 24, 30));
assert.strictEqual(
  logged(
    2,
    /^Polled 1 ban list and read 1 in full, with 6 BattleMetrics requests: 2 for newest pages, 0 following them and 4 for full reads\.$/
  ).length,
  1
);
// So is a ban removed from the newest page itself. The ban below it that takes its place adds to the
// new bans, here as it has no SteamID, so was never stored, while the count falls.
newestFirst = newestFirst.filter(([uid]) => uid !== 'h1');
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].reason, polled.report.banLists[0].drift, removedIDs()],
  ['drift', { total: 22, expected: 24 }, ['90,h1']]
);

// A burst of new bans, more than a page of them, is followed page by page until a page has a ban
// seen before. They are all saved, and nothing else is read.
const burst = pairs('b', 0, 7);
newestFirst = [...burst, ...newestFirst];
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual(asked(), [
  ['bm-90', 'newest'],
  ['bm-90', '1'],
  ['bm-91', 'newest']
]);
assert.deepStrictEqual(polled.report.requests, { head: 2, follow: 1, full: 0 });
assert.deepStrictEqual(
  [...written()].sort(),
  burst.map(([uid]) => `90,${uid}`)
);
assert.deepStrictEqual(polled.report.banLists[0], {
  id: 90,
  fetched: 10,
  new: 7,
  updated: 0,
  removed: 0,
  held: 0,
  read: 'head'
});
assert.deepStrictEqual(
  [JSON.parse(row(90).headUids), row(90).headTotal],
  [['b0', 'b1', 'b2', 'b3', 'b4'], 29]
);

// More new bans than a poll follows, 10 pages of them, overflow: the list is read in full, on from
// the last page the poll read. The new bans on the pages it read are saved before the rest of the
// list is read, and none of the list's bans are removed, as none are gone.
const flood = pairs('f', 0, 60);
newestFirst = [...flood, ...newestFirst];
serve(90, newestFirst);
const writtenAfter = [];
onWrite = (ids) => {
  writtenAfter.push([ids.length, battlemetricsParams.length]);
};
polled = await pollRun();
onWrite = null;
assert.deepStrictEqual(polled.report.requests, { head: 2, follow: 9, full: 8 });
assert.deepStrictEqual(writtenAfter, [
  [50, 10],
  [10, 18]
]);
assert.deepStrictEqual(
  [polled.results[0].reason, polled.results[0].created, storedIDs(90).length, removedIDs()],
  ['overflow', 60, 88, []]
);
assert.strictEqual(
  logged(2, /^Reading ban list \(ID: 90\) in full, as its newest 10 pages hold only new bans\.$/)
    .length,
  1
);

// With IMPORTER_DRIFT=0, a ban removed below the newest page is not found by polls, which never
// remove bans, but by the list's next periodic full read.
env.IMPORTER_DRIFT = '0';
newestFirst = newestFirst.filter(([uid]) => uid !== 'h20');
serve(90, newestFirst);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.report.requests, removedIDs(), storedIDs(90).includes('90,h20')],
  [{ head: 2, follow: 0, full: 0 }, [], true]
);
assert.strictEqual(
  logged(
    2,
    /^IMPORTER_DRIFT is off, so the bans a list no longer has are only found when it is read in full, every 30 minutes \(IMPORTER_FULL_SCAN_MINUTES\)\.$/
  ).length,
  1
);
syncRows.get(90).nextFullScanAt = new Date(Date.now() - 1000);
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [91, 'head', null],
  [90, 'full', 'periodic']
]);
// Its first page is read as part of its full read.
assert.deepStrictEqual(polled.report.requests, { head: 1, follow: 0, full: 18 });
assert.deepStrictEqual(removedIDs(), ['90,h20']);
delete env.IMPORTER_DRIFT;

// A list that loses many bans has them kept until a complete read at least 10 minutes later still
// does not have them, so it is due to be read in full then. Until then it is only polled, and stays
// held. Once they can be confirmed, it is read in full, which removes them.
reset();
delete env.IMPORTER_HEAD_POLL;
let confirming = pairs('c', 0, 30);
battlemetricsList(92, [], paged(confirming));
await pollRun();
confirming = confirming.filter((_, n) => n < 10 || n >= 22);
serve(92, confirming);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].reason, polled.results[0].pending, removedIDs(), row(92).state],
  ['drift', 12, [], 'held']
);
assert.ok(confirmsIn(row(92), 10), JSON.stringify(row(92)));
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].read, polled.report.requests, removedIDs(), row(92).state],
  ['head', { head: 1, follow: 0, full: 0 }, [], 'held']
);
assert.deepStrictEqual(warnings(), []);
age(92, 11);
polled = await pollRun();
assert.deepStrictEqual(
  [readsOf(polled), polled.results[0].removed, row(92).state, row(92).scanReason],
  [[[92, 'full', 'removal']], 12, 'ok', 'periodic']
);
// A list whose last full read is older than IMPORTER_FULL_SCAN_MINUTES is read in full, though its
// row says its next is due later, e.g. as the setting was made shorter.
syncRows.get(92).lastFullScanAt = new Date(Date.now() - 6 * MINUTE);
env.IMPORTER_FULL_SCAN_MINUTES = '5';
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [[92, 'full', 'periodic']]);
assert.ok(dueIn(row(92), 4, 5));
delete env.IMPORTER_FULL_SCAN_MINUTES;

// A poll that finds drift, when the list then cannot be read in full, leaves the list due a full
// read at once, for that reason, so the next run reads it in full. The poll's own bans are saved,
// and its newest page and count are kept with them. The second attempt in the run reads the list in
// full from its first page, as the new ban the first attempt saved would hide the drift from
// another poll.
reset();
delete env.IMPORTER_HEAD_POLL;
let unreadable = pairs('k', 0, 15);
battlemetricsList(93, [], paged(unreadable));
// The other list keeps the second attempts going.
battlemetricsList(94, [], paged(pairs('l', 0, 3)));
await pollRun();
unreadable = [['kn1', steamID(301)], ...unreadable.filter(([uid]) => uid !== 'k12')];
serve(93, unreadable);
battlemetricsLists.get('bm-93')[2] = httpError(503);
battlemetricsTotals.set('bm-93', 15);
polled = await pollRun();
assert.deepStrictEqual(asked(), [
  ['bm-93', 'newest'],
  ['bm-93', '1'],
  ['bm-93', '2'],
  ['bm-94', 'newest'],
  ['bm-93', 'newest'],
  ['bm-93', '1'],
  ['bm-93', '2']
]);
assert.deepStrictEqual(polled.report.requests, { head: 2, follow: 0, full: 5 });
assert.deepStrictEqual(readsOf(polled), [
  [93, 'full', 'drift'],
  [94, 'head', null]
]);
assert.deepStrictEqual(
  [row(93).state, row(93).scanReason, row(93).nextFullScanAt, row(93).headTotal],
  ['failing', 'drift', row(93).lastAttemptAt, 15]
);
assert.deepStrictEqual(JSON.parse(row(93).headUids), ['kn1', 'k0', 'k1', 'k2', 'k3']);
assert.deepStrictEqual(
  [storedIDs(93).includes('93,kn1'), storedIDs(93).includes('93,k12')],
  [true, true]
);
serve(93, unreadable);
battlemetricsTotals.delete('bm-93');
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [94, 'head', null],
  [93, 'full', 'drift']
]);
assert.deepStrictEqual(
  [removedIDs(), row(93).state, row(93).scanReason],
  [['93,k12'], 'ok', 'periodic']
);

// IMPORTER_HEAD_POLL=0 reads every list in full on every run, in the order BattleMetrics gives its
// bans, as before head polls, and their rows forget their newest pages. Turned on again, each list
// is read in full once more, as it has no newest page to compare.
env.IMPORTER_HEAD_POLL = '0';
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [93, 'full', 'every_run'],
  [94, 'full', 'every_run']
]);
assert.deepStrictEqual(battlemetricsParams[0], { 'filter[banList]': 'bm-93', 'page[size]': 100 });
assert.deepStrictEqual([row(93).headUids, row(94).headUids], [null, null]);
assert.strictEqual(
  logged(
    2,
    /^IMPORTER_HEAD_POLL is off, so every list is read in full on every run, in the order BattleMetrics gives its bans\.$/
  ).length,
  1
);
delete env.IMPORTER_HEAD_POLL;
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [93, 'full', 'new'],
  [94, 'full', 'new']
]);
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [93, 'head', null],
  [94, 'head', null]
]);
// A list whose read fails with head polls off forgets its newest page too, so it is also read in
// full before it is polled again.
env.IMPORTER_HEAD_POLL = '0';
battlemetricsLists.set('bm-93', [httpError(500)]);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].error, row(93).state, row(93).headUids],
  ['Error: Request failed with status code 500', 'failing', null]
);
serve(93, unreadable);
delete env.IMPORTER_HEAD_POLL;
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [93, 'full', 'new'],
  [94, 'full', 'new']
]);
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [93, 'head', null],
  [94, 'head', null]
]);
// An invalid setting is posted, and the safer choice taken: drift still compared, lists read in full
// every 30 minutes, and, for head polls, every list read in full on every run.
for (const [name, value, warning, reads] of [
  [
    'IMPORTER_DRIFT',
    'sometimes',
    'Warning: IMPORTER_DRIFT must be 1 or 0, not "sometimes", so head polls still compare BattleMetrics\' counts.',
    null
  ],
  [
    'IMPORTER_FULL_SCAN_MINUTES',
    '0',
    'Warning: IMPORTER_FULL_SCAN_MINUTES must be a whole number from 1 to 10080, not "0", so lists are read in full every 30 minutes.',
    null
  ],
  [
    'IMPORTER_HEAD_POLL',
    'maybe',
    'Warning: IMPORTER_HEAD_POLL must be 1 or 0, not "maybe", so every list is read in full on every run.',
    'every_run'
  ]
]) {
  env[name] = value;
  polled = await pollRun();
  assert.deepStrictEqual(
    logs.filter((log) => log.important && log.message === warning).length,
    1,
    name
  );
  assert.deepStrictEqual(
    readsOf(polled).map(([, , reason]) => reason),
    [reads, reads],
    name
  );
  delete env[name];
}

// A held list stays held while it is only polled, as a poll does not check for removed bans, and
// its line, posted when a read of all of it keeps its bans, is not posted for a poll. Here the list
// replaced all its bans, a page or more of them, so its poll follows them to its last page, which
// makes it a read of all of the list.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(95, [], paged(pairs('m', 0, 12)));
await pollRun();
serve(95, pairs('n', 0, 12));
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].read, polled.results[0].hold, row(95).state, heldIDs(95).length],
  ['head', 'full', 'held', 12]
);
assert.deepStrictEqual(polled.report.requests, { head: 1, follow: 2, full: 0 });
assert.strictEqual(warnings().length, 1);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].read, polled.results[0].complete, row(95).state, heldIDs(95).length],
  ['head', undefined, 'held', 12]
);
assert.deepStrictEqual(warnings(), []);

// A dry run polls as any run does, and writes nothing. A list a poll finds it must read in full is
// counted by its read in full alone, so its new ban is counted, and logged, once.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(96, [], paged(pairs('d', 0, 12)));
await pollRun();
env.IMPORTER_DRY_RUN = '1';
serve(96, [['dn1', steamID(201)], ...pairs('d', 0, 12)]);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].read, polled.results[0].created, writes()],
  ['head', 1, []]
);
serve(96, [['dn1', steamID(201)], ...pairs('d', 0, 12).filter(([uid]) => uid !== 'd9')]);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.results[0].reason, polled.results[0].created, polled.results[0].removed, writes()],
  ['drift', 1, 1, []]
);
assert.strictEqual(logged(2, /^Would save new ban \(ID: 96,dn1\) in ban list/).length, 1);
delete env.IMPORTER_DRY_RUN;

// Lists only polled are read first, then those read in full, the most urgent first.
reset();
delete env.IMPORTER_HEAD_POLL;
for (const id of [97, 98, 99]) battlemetricsList(id, [], paged(pairs(`o${id}-`, 0, 3)));
await pollRun();
battlemetricsList(100, [], paged(pairs('q', 0, 3)));
syncRows.get(97).nextFullScanAt = new Date(Date.now() - 1000);
Object.assign(syncRows.get(98), {
  nextFullScanAt: new Date(Date.now() - 1000),
  scanReason: 'drift'
});
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [99, 'head', null],
  [100, 'full', 'new'],
  [98, 'full', 'drift'],
  [97, 'full', 'periodic']
]);

// A run asked to stop while a list's bans are being written finishes the batch under way, with its
// players' updates, and starts no other. None of the list's bans are removed, as the bans it did not
// save would look removed, and no other list is imported. The summary counts the lists imported
// before the run stopped. This stops the importer's run control, so it comes last.
reset();
battlemetricsList(29, pairs('r', 0, 2), [pairs('r', 0, 1)]);
battlemetricsList(30, pairs('s', 0, 4), [pairs('s', 2, 10)]);
battlemetricsList(31, pairs('t', 0, 2), [pairs('t', 0, 2)]);
onWrite = (ids) => {
  if (ids.includes('30,s6')) control.requestStop('it received SIGTERM');
};
const stoppedImporter = new BanImporter({ batchSize: 2 });
const stopped = await stoppedImporter.importBans().catch((err) => err);
assert.strictEqual(stopped.name, 'RunStopped');
assert.strictEqual(stopped.reason, 'it received SIGTERM');
assert.deepStrictEqual(written(), ['30,s4', '30,s5', '30,s6', '30,s7']);
assert.deepStrictEqual(storedIDs(29), ['29,r0']);
assert.deepStrictEqual(
  storedIDs(30),
  pairs('s', 0, 8).map(([uid]) => `30,${uid}`)
);
assert.strictEqual(steamUsers.get(steamID(7)).lastRefreshedExport, null);
assert.ok(!steamUsers.has(steamID(8)));
assert.deepStrictEqual(removedIDs(), ['29,r1']);
assert.ok(!events.some(([type, id]) => type === 'read list' && id === 31));
assert.deepStrictEqual(battlemetricsRequests, ['bm-29', 'bm-30']);
// The list imported before the stop has its row, and the one stopped part-way has none, as its
// import neither failed nor finished.
assert.deepStrictEqual([...syncRows.keys()], [29]);
assert.strictEqual(row(29).state, 'ok');
// The list it stopped in the middle of has a line of its own, which says what it saved.
assert.deepStrictEqual(
  warnings().map(({ message, important }) => [message, important]),
  [
    [
      'Stopped importing ban list (ID: 30) while saving its bans, as the run is stopping, so none of its bans were removed (8 bans fetched, 4 new, 0 updated).',
      true
    ]
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 1 of 3 ban lists before the run stopped: 1 ban fetched, 0 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);
// Its report for the run record counts the same lists as its summary, and every request it made,
// that of the list it stopped in the middle of too.
assert.deepStrictEqual(JSON.parse(JSON.stringify(stoppedImporter.report())), {
  lists: 3,
  imported: 1,
  fetched: 1,
  new: 0,
  updated: 0,
  removed: 1,
  held: 0,
  pending: 0,
  moves: 0,
  failedLists: 0,
  selfImports: 0,
  accessLost: 0,
  headPolls: 0,
  fullReads: 1,
  accessCheck: 'ok',
  requests: { head: 0, follow: 0, full: 2 },
  banLists: [
    {
      id: 29,
      fetched: 1,
      new: 0,
      updated: 0,
      removed: 1,
      held: 0,
      read: 'full',
      reason: 'new',
      stored: 2
    }
  ]
});

assert.strictEqual(verboseLevelOneLines, 0, 'Lines for the log channel are logged as important');

console.log(
  'Ban import checks passed: complete lists only, writes of what changed only, removals after a second read, holds over several runs until confirmed or a held ban comes back, empty lists, the count check, counts that change too much, lists left out of it, repeated incomplete reads, replaced sources, remote files, dry runs and invalid ones, SteamID moves, second attempts, retries, sync state, the access check, lost access, self-imports, lists removed before their missing bans are recorded, head polls that never remove, drift, overflow, bursts followed, confirming and periodic full reads, the switches, stops and the run summary.'
);
