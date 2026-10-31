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
// Why each list's held bans are held, and how many bans the list had before the read that began
// the hold, by list, as { reason, storedCount }.
const holdRows = new Map();
const events = [];
const logs = [];
const delays = [];
// Errors to throw from the statement that writes a ban, by the ban's ID, one each time a statement
// writes it, alone or with others.
const writeErrors = new Map();
// Called with the IDs of the bans each statement that writes bans writes, before it writes them,
// and with a list's ID as its bans are counted for its sync state, after its import. Each statement
// waits for what they return, so a check can hold the import up there (see holdAt).
let onWrite = null;
let onCount = null;
// Errors for the next statement that records missing bans, and the next that removes bans, to fail
// with.
let pendingError = null;
// Called with the IDs of the bans each statement that holds bans for an admin holds, before it
// holds them: what it throws fails the statement.
let onHold = null;
let removeError = null;
// Errors for the statements that remove bans, or change a list's hold or its recorded missing bans,
// to fail with, by the event each records, e.g. 'release held', in order, one each time such a
// statement runs, before it changes anything: a null lets that one run.
const statementErrors = new Map();
function failIfAsked(type) {
  const error = statementErrors.get(type)?.shift();
  if (error) throw error;
}
let transactions = 0;
// Lines for the log channel must be logged as important, which none of the importer's level-1
// lines may skip.
let verboseLevelOneLines = 0;

const tick = () => new Promise(setImmediate);
// A place to hold the import up at, as a hook that returns hold() does where it is called, e.g. as
// a request that BattleMetrics does not answer, until release() lets it go on. reached resolves
// once the import is held there.
function holdAt() {
  let arrive;
  let release;
  const reached = new Promise((resolve) => {
    arrive = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    hold: () => {
      arrive();
      return released;
    }
  };
}
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
  // Each list's first missing ban that is not held for an admin, how many are, and how many wait for
  // a confirming read instead, as MySQL gives them: a DATETIME as a Date, and a SUM as text.
  if (
    sql ===
    'SELECT banList, MIN(CASE WHEN heldAt IS NULL THEN firstMissingAt END) AS firstMissingAt, SUM(heldAt IS NOT NULL) AS held, SUM(heldAt IS NULL) AS waiting FROM BanListPendingRemovals GROUP BY banList'
  ) {
    const summaries = new Map();
    for (const row of pendingRows.values()) {
      const summary = summaries.get(row.banList) ?? { first: null, held: 0, waiting: 0 };
      if (row.heldAt !== null) summary.held++;
      else {
        summary.waiting++;
        summary.first = Math.min(summary.first ?? Infinity, row.firstMissingAt);
      }
      summaries.set(row.banList, summary);
    }
    return [...summaries].map(([banList, { first, held, waiting }]) => ({
      banList,
      firstMissingAt: first === null ? null : new Date(first),
      held: String(held),
      waiting: String(waiting)
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
    failIfAsked('remove');
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
    failIfAsked('clear pending');
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
    if (!held) failIfAsked('save pending');
    events.push([held ? 'save held' : 'save pending', rows.map(([, id]) => id), tx]);
    if (held && onHold) onHold(rows.map(([, id]) => id));
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
    failIfAsked('release held');
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
  if (sql === 'SELECT reason, storedCount FROM BanListHolds WHERE banList = ?') {
    events.push(['read hold reason', replacements[0]]);
    return holdRows.has(replacements[0]) ? [{ ...holdRows.get(replacements[0]) }] : [];
  }
  if (
    sql ===
    'INSERT INTO BanListHolds (banList, reason, storedCount) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE reason = new.reason, storedCount = new.storedCount'
  ) {
    const [list, reason, storedCount] = replacements;
    failIfAsked('save hold reason');
    events.push(['save hold reason', [list, reason, storedCount], tx]);
    if (!banLists.has(list)) throw new ForeignKeyConstraintError('banList');
    if (!Number.isInteger(storedCount) || storedCount < 0)
      throw new DatabaseError(`Column 'storedCount' cannot be ${storedCount}`);
    holdRows.set(list, { reason, storedCount });
    return [0, 1];
  }
  if (sql === 'DELETE FROM BanListHolds WHERE banList = ?') {
    failIfAsked('clear hold reason');
    events.push(['clear hold reason', [replacements[0]], tx]);
    const had = holdRows.delete(replacements[0]) ? 1 : 0;
    return [{ affectedRows: had }, { affectedRows: had }];
  }
  throw new Error(`Unexpected statement: ${sql}`);
}

// The tables a transaction may change, so a failure can put them back as they were.
const snapshot = () => ({
  steamUsers: new Map([...steamUsers].map(([id, user]) => [id, { ...user }])),
  bans: new Map([...bans].map(([id, ban]) => [id, { ...ban }])),
  pendingRows: new Map([...pendingRows].map(([key, row]) => [key, { ...row }])),
  holdRows: new Map([...holdRows].map(([list, row]) => [list, { ...row }]))
});
function restore(saved) {
  for (const [store, copy] of [
    [steamUsers, saved.steamUsers],
    [bans, saved.bans],
    [pendingRows, saved.pendingRows],
    [holdRows, saved.holdRows]
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
    if (onCount) await onCount(where.banList);
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
// Each request's parameters, as the importer sent them. onBattlemetrics, if set, is called with
// each request's parameters as it is made, e.g. to move a check's clock on, and the request waits
// for what it returns, e.g. to hold the import up there (see holdAt).
const battlemetricsParams = [];
let onBattlemetrics = null;

// BattleMetrics' list of the ban lists CBL can see, read a page at a time by
// readBattlemetricsPages: the sources of all the BattleMetrics lists, unless visibleBanLists is set
// to the IDs it gives instead, or to an error. onBanListsRead, if set, is called as it is read, e.g.
// to move a check's clock on, and the read waits for what it returns.
let visibleBanLists = null;
const banListReads = [];
let onBanListsRead = null;
async function readBattlemetricsPages(endpoint, params) {
  banListReads.push([endpoint, params]);
  await onBanListsRead?.();
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
  await onBattlemetrics?.(params);
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

// The paused ban lists' rows, as the run reads them (see paused-lists.js), and the resumptions the
// import ended, as [banList, resumedAt], which delete the rows that still have that resumedAt.
let pausedRows = [];
const endedResumptions = [];
const pausedIDs = (rows) => rows.map(({ banList }) => banList).sort((a, b) => a - b);

const env = {};
const dependencies = {
  './paused-lists.js': {
    default: async () => ({
      rows: pausedRows.map((row) => ({ ...row })),
      suspended: pausedIDs(pausedRows.filter(({ resumedAt }) => resumedAt === null)),
      excluded: pausedIDs(pausedRows)
    })
  },
  'scbl-lib/db/ban-list-suspensions': {
    async endResumption(banList, resumedAt) {
      events.push(`end resumption ${banList}`);
      endedResumptions.push([banList, resumedAt]);
      const index = pausedRows.findIndex(
        (row) => row.banList === banList && row.resumedAt === resumedAt
      );
      if (index === -1) return false;
      pausedRows.splice(index, 1);
      return true;
    }
  },
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
// Load the importer with modules of its own: the importer, the fetcher and apply-list.js share the
// real run-control.js, and the importer and ban-list-sync.js the real planner.js. Its run holds its
// run lock. A run control that was asked to stop stays so, so a check that stops a run, and then
// runs the importer again, loads an importer for each run.
async function loadImporter() {
  const runControl = load('../src/run-control.js');
  const planner = load('../src/planner.js');
  const importer = await load('../src/ban-importer.js');
  await importer.link(async (specifier) => {
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
  });
  await importer.evaluate();
  const control = (await runControl).namespace;
  control.setRunLock({ isHeld: async () => true });
  return { BanImporter: importer.namespace.default, control };
}
const { BanImporter, control } = await loadImporter();

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
// Why a list's held bans are held, by its BanListHolds row, or undefined when it has none.
const holdReason = (list) => holdRows.get(list)?.reason;

function reset() {
  for (const store of [
    banLists,
    steamUsers,
    bans,
    pendingRows,
    holdRows,
    writeErrors,
    statementErrors,
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
    exportBanLists,
    endedResumptions
  ])
    list.length = 0;
  pausedRows = [];
  onWrite = null;
  onCount = null;
  onBattlemetrics = null;
  onBanListsRead = null;
  pendingError = null;
  onHold = null;
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
// A copy of an importer's report, in this test's own objects, as the report is made in the
// importer's context. Each list's seconds, which say how long its import took, depend on how fast
// the check runs, so each is checked to be a time, and left out. The checks of the seconds give the
// importer a clock of their own.
function plainReport(importer) {
  const report = JSON.parse(JSON.stringify(importer.report()));
  for (const list of report.banLists) {
    assert.ok(Number.isFinite(list.seconds) && list.seconds >= 0, JSON.stringify(list));
    delete list.seconds;
  }
  return report;
}
// What a list's entry in the report says about bans held for an admin: those of its fields that it
// has, of held, pending, hold, holdEnded, cameBack and massRemoval.
const holdFields = ({ held, pending, hold, holdEnded, cameBack, massRemoval }) =>
  JSON.parse(JSON.stringify({ held, pending, hold, holdEnded, cameBack, massRemoval }));
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
      'save hold reason',
      'clear hold reason',
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
// a complete list in the same run loses exactly the bans it no longer has. Its line says which page
// it failed on: here the second, which BattleMetrics' count of 2 bans on the list does not reach, so
// it says no more.
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
    /^Failed to import ban list \(ID: 1\) while fetching page 2, so none of its bans were removed\. Error: Request failed with status code 500$/
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
    /^Failed to import ban list \(ID: 1\) again while fetching page 2, so none of its bans were removed\. Error: Request failed with status code 500$/
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

// A second run with nothing changed reads each list's stored bans, its missing bans and why its bans
// are held, if they are, and writes nothing at all: no ban, no player and no record of a missing ban.
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
    ['read hold reason', 1],
    ['select', 2],
    ['select pending', 2],
    ['read hold reason', 2]
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
// The importer here tells the time by a clock of its own, which each BattleMetrics request moves on
// 1.5 seconds, and the access check 5 seconds, so each list's seconds are known: how long its import
// took, both attempts together for a list tried again, without the wait between them, and without
// the access check, which the first list waits for, and the report gives on its own.
let reporterNow = Date.parse('2026-10-23T13:39:35.889Z');
const reporter = new BanImporter({ clock: () => reporterNow });
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
onBattlemetrics = () => {
  reporterNow += 1500;
};
onBanListsRead = () => {
  reporterNow += 5000;
};
await reporter.importBans();
// A list's state is given when it is not ok, and the access check was read, in 5 seconds. Both lists
// are new, so they are read in full, and every request is one of a full read, the failed list's
// both times. The failed list took 6 seconds, 3 for each attempt, and says which page it failed
// on, and how its first attempt ended, which took 3 of them; the other took 3.
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
  accessCheckSeconds: 5,
  requests: { head: 0, follow: 0, full: 6 },
  banLists: [
    {
      id: 1,
      fetched: 0,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      seconds: 6,
      read: 'full',
      reason: 'new',
      state: 'failing',
      attempt: 2,
      error: 'Error: Request failed with status code 500',
      stage: 'fetching it',
      page: 2,
      firstAttempt: {
        seconds: 3,
        error: 'Error: Request failed with status code 500',
        stage: 'fetching it',
        page: 2
      }
    },
    {
      id: 2,
      fetched: 4,
      new: 1,
      updated: 0,
      removed: 1,
      held: 0,
      seconds: 3,
      read: 'full',
      reason: 'new',
      stored: 4
    }
  ]
});
onBattlemetrics = null;
onBanListsRead = null;

// A list read at its second attempt says how its first one ended, also when the second read it, so
// a page that fails at times, as some of BattleMetrics' pages do, shows in the run record by the
// list's entry alone: here the first attempt fails on the list's second page, after 3 seconds, and
// the second reads the list, in 3 more.
reset();
battlemetricsList(4, pairs('d', 0, 4), [pairs('d', 0, 2), failsOnce(pairs('d', 2, 4))]);
battlemetricsList(5, [], [pairs('e', 0, 1)]);
reporterNow = Date.parse('2026-10-23T13:39:35.889Z');
const secondReader = new BanImporter({ clock: () => reporterNow });
onBattlemetrics = () => {
  reporterNow += 1500;
};
await secondReader.importBans();
onBattlemetrics = null;
assert.deepStrictEqual(JSON.parse(JSON.stringify(secondReader.report().banLists[0])), {
  id: 4,
  fetched: 4,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  seconds: 6,
  read: 'full',
  reason: 'new',
  stored: 4,
  attempt: 2,
  firstAttempt: {
    seconds: 3,
    error: 'Error: Request failed with status code 502',
    stage: 'fetching it',
    page: 2
  }
});

// The report can also be taken while the import is still under way, as the importer service takes
// it when it ends a cycle at once, e.g. 45 seconds after SIGTERM, while a step still waits for
// something that does not come. It then gives the list being imported on its own (inProgress):
// its counts so far, how long it has taken so far, and what it is doing, with the page it is
// reading. The totals and banLists leave it out, as they do a list stopped part-way. Here
// BattleMetrics does not answer list 2's second page, and the report is taken 27 seconds after it
// was asked for; each request moves the clock on 1.5 seconds, and the access check 5. Once the page
// is answered, the list is in banLists, and inProgress is gone.
reset();
battlemetricsList(1, pairs('a', 0, 2), [pairs('a', 0, 2)]);
battlemetricsList(2, pairs('b', 0, 4), [pairs('b', 0, 2), pairs('b', 2, 4)]);
let underWayNow = Date.parse('2026-10-23T18:00:00.000Z');
let gate = holdAt();
onBattlemetrics = (params) => {
  underWayNow += 1500;
  if (params['filter[banList]'] === 'bm-2' && params['page[key]'] === '1') return gate.hold();
};
onBanListsRead = () => {
  underWayNow += 5000;
};
let underWay = new BanImporter({ clock: () => underWayNow });
let importing = underWay.importBans();
await gate.reached;
underWayNow += 27 * 1000;
assert.deepStrictEqual(JSON.parse(JSON.stringify(underWay.report())), {
  lists: 2,
  imported: 1,
  fetched: 2,
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
  fullReads: 1,
  accessCheck: 'ok',
  accessCheckSeconds: 5,
  requests: { head: 0, follow: 0, full: 3 },
  banLists: [
    {
      id: 1,
      fetched: 2,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      seconds: 1.5,
      read: 'full',
      reason: 'new',
      stored: 2
    }
  ],
  inProgress: {
    id: 2,
    fetched: 0,
    new: 0,
    updated: 0,
    removed: 0,
    held: 0,
    seconds: 30,
    read: 'full',
    reason: 'new',
    page: 2,
    stage: 'fetching it'
  }
});
gate.release();
await importing;
assert.deepStrictEqual(
  plainReport(underWay).banLists.map(({ id }) => id),
  [1, 2]
);
assert.ok(!('inProgress' in underWay.report()));

// While the run's access check is being read, which the first BattleMetrics list waits for, it is
// given as running, with how long it has taken so far, and the list as waiting for it, without
// that time, as its seconds once it is read are without it too, and before it is planned how the
// list is read. Here the check is held up for 40 seconds, as when it waits out a pause after
// BattleMetrics answered 429, which nothing stops.
reset();
battlemetricsList(1, pairs('a', 0, 2), [pairs('a', 0, 2)]);
underWayNow = Date.parse('2026-10-23T18:00:00.000Z');
gate = holdAt();
onBanListsRead = () => {
  underWayNow += 40 * 1000;
  return gate.hold();
};
underWay = new BanImporter({ clock: () => underWayNow });
importing = underWay.importBans();
await gate.reached;
let partial = JSON.parse(JSON.stringify(underWay.report()));
assert.deepStrictEqual(
  [partial.imported, partial.accessCheck, partial.accessCheckSeconds, partial.banLists],
  [0, 'running', 40, []]
);
assert.deepStrictEqual(partial.inProgress, {
  id: 1,
  fetched: 0,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  seconds: 0,
  stage: 'waiting for the access check'
});
gate.release();
await importing;
partial = JSON.parse(JSON.stringify(underWay.report()));
assert.deepStrictEqual(
  [
    partial.accessCheck,
    partial.accessCheckSeconds,
    partial.banLists[0].seconds,
    partial.inProgress
  ],
  ['ok', 40, 0, undefined]
);

// A list whose bans are being saved, e.g. as a batch waits for a row lock, is given with what it
// has fetched so far, and so is one whose row is being saved, once its attempt is over. A second
// attempt is given with the time of both attempts, and how its first one ended. Here list 2's first
// attempt fails on its second page, and its second waits for that page for 10 seconds.
reset();
battlemetricsList(1, pairs('a', 0, 2), [pairs('a', 0, 2)]);
battlemetricsList(2, pairs('b', 0, 2), [pairs('b', 0, 2), [...pairs('b', 2, 3)]]);
underWayNow = Date.parse('2026-10-23T18:00:00.000Z');
gate = holdAt();
onWrite = (ids) => (ids.includes('2,b2') ? gate.hold() : undefined);
onBattlemetrics = () => {
  underWayNow += 1500;
};
underWay = new BanImporter({ clock: () => underWayNow });
importing = underWay.importBans();
await gate.reached;
assert.deepStrictEqual(JSON.parse(JSON.stringify(underWay.report())).inProgress, {
  id: 2,
  fetched: 3,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  seconds: 3,
  read: 'full',
  reason: 'new',
  stored: 2,
  stage: 'saving its bans'
});
gate.release();
await importing;
onWrite = null;
gate = holdAt();
onCount = (id) => (id === 2 ? gate.hold() : undefined);
underWay = new BanImporter({ clock: () => underWayNow });
importing = underWay.importBans();
await gate.reached;
partial = JSON.parse(JSON.stringify(underWay.report()));
assert.deepStrictEqual(
  [partial.imported, partial.inProgress.id, partial.inProgress.stage, partial.inProgress.fetched],
  [1, 2, 'saving its sync state', 3]
);
gate.release();
await importing;
onCount = null;
battlemetricsLists.set('bm-2', [pairs('b', 0, 2), failsOnce(pairs('b', 2, 3))]);
let asks = 0;
gate = holdAt();
onBattlemetrics = (params) => {
  underWayNow += 1500;
  if (params['filter[banList]'] === 'bm-2' && params['page[key]'] === '1' && ++asks === 2)
    return gate.hold();
};
underWay = new BanImporter({ clock: () => underWayNow });
importing = underWay.importBans();
await gate.reached;
underWayNow += 10 * 1000;
assert.deepStrictEqual(JSON.parse(JSON.stringify(underWay.report())).inProgress, {
  id: 2,
  fetched: 0,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  seconds: 16,
  read: 'full',
  reason: 'every_run',
  attempt: 2,
  page: 2,
  firstAttempt: {
    seconds: 3,
    error: 'Error: Request failed with status code 502',
    stage: 'fetching it',
    page: 2
  },
  stage: 'fetching it'
});
gate.release();
await importing;
onBattlemetrics = null;

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
  // Named in IMPORTER_ALLOW_MASS_REMOVAL, it loses them, with their records, and its line says which
  // hold that ended.
  env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
  logs.length = 0;
  const [confirmed] = await run();
  assert.deepStrictEqual(
    [confirmed.removed, confirmed.held, confirmed.massRemoval, storedIDs(5).length],
    [stored, 0, true, others],
    label
  );
  assert.deepStrictEqual([pendingIDs(5), row(5).state], [[], 'ok'], label);
  assert.deepStrictEqual(
    warnings().map(({ message }) => message),
    [
      `Imported ban list (ID: 5): ${others} bans fetched, 0 new, 0 updated, ${stored} removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list, which ended its hold of the ${stored} bans it had when it lost all of its bans at once, held since ${since.toISOString()}. Remove it from the setting once the removal is done.`
    ],
    label
  );
}
// Bans the held list saved since, that it no longer has, are removed as usual while it stays held:
// a few at once, and more, up to one fewer than a large loss of the list, here 84 of 425, once a
// later complete read confirms they are gone. The line says so.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
battlemetricsLists.set('bm-5', [pairs('n', 1005, 1400)]);
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, storedIDs(5).length],
  ['full', 5, 30, 425]
);
battlemetricsLists.set('bm-5', [pairs('n', 1089, 1400)]);
logs.length = 0;
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, results[0].pending],
  ['full', 0, 114, 84]
);
assert.deepStrictEqual([heldIDs(5).length, pendingIDs(5).length, holdReason(5)], [30, 114, 'full']);
assert.match(
  warnings()[0].message,
  /^Imported ban list \(ID: 5\): 311 bans fetched, 0 new, 0 updated\. Still kept the 30 bans it had when .* for one run\. Of the bans it saved since, 84 that it no longer has are kept until a later complete read of it confirms they are gone\.$/
);
age(5, 10);
results = await run();
assert.deepStrictEqual(
  [results[0].hold, results[0].removed, results[0].held, storedIDs(5).length],
  ['full', 84, 30, 341]
);
// Once one of its held bans comes back, the hold ends: that ban loses its record, and the others
// wait for a later complete read, as if first missing now, however long they were held, so they
// are not removed until then, though they are still a large part of the bans the list had. The
// line of the read that ended the hold is posted, as the list's earlier lines said they were kept
// until one came back, and says when the rest are removed, and the list's record says which hold
// ended.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
assert.deepStrictEqual(holdRows.get(5), { reason: 'full', storedCount: 30 });
age(5, 600);
const fullSince = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('n', 1000, 1400)]]);
events.length = 0;
logs.length = 0;
const fullImport = new BanImporter();
results = await fullImport.importBans();
assert.deepStrictEqual(plainReport(fullImport).banLists.map(holdFields), [
  { held: 29, pending: 29, holdEnded: 'full', cameBack: 1 }
]);
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
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 401 bans fetched, 0 new, 0 updated. Stopped holding the 30 bans it had when it lost all of its bans at once, held since ${fullSince}, as 1 of them came back. The other 29, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
// Removing them, 29 of 430, is not a large part of the list, so it is not posted.
age(5, 10);
logs.length = 0;
results = await run();
assert.deepStrictEqual([results[0].removed, storedIDs(5).length, warnings()], [29, 401, []]);
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

// A list that loses a large part of its bans at once keeps them for an admin, though its read is
// complete: here 80 of 200, the expired ones, which its source now leaves out, as BattleMetrics
// would if it hid expired bans that it is not asked for, as its documentation describes its
// filter. Its count of the list's bans drops with them, so the count check passes. At least 25
// bans, and a fifth of the list, are held as 'large': recorded as held, with why and how many bans
// the list had, in one transaction, the list held, its line posted, with how many of them must
// still be missing for the hold to last, and its bans counted as held. None of their players is
// queued, so their reputation points and export bans stay as they are.
const expire = (list, uids) => {
  for (const uid of uids)
    Object.assign(bans.get(`${list},${uid}`), {
      expires: new Date('2026-06-01T00:00:00.000Z'),
      expired: true
    });
};
const lostLarge = pairs('e', 0, 80).map(([uid]) => `5,${uid}`);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
expire(
  5,
  pairs('e', 0, 80).map(([uid]) => uid)
);
const largeImporter = new BanImporter();
[result] = await largeImporter.importBans();
assert.deepStrictEqual(
  [result.complete, result.hold, result.held, result.pending, result.removed, result.stored],
  [true, 'large', 80, 0, 0, 200]
);
assert.deepStrictEqual(
  [storedIDs(5).length, heldIDs(5).sort(), holdRows.get(5), row(5).state],
  [200, [...lostLarge].sort(), { reason: 'large', storedCount: 200 }, 'held']
);
const holdTx = writes()[0]?.[2];
assert.deepStrictEqual(writes(), [
  ['save hold reason', [5, 'large', 200], holdTx],
  ['save held', lostLarge, holdTx]
]);
assert.deepStrictEqual(inTransaction(holdTx), ['begin', 'save hold reason', 'save held', 'commit']);
assert.ok(
  lostLarge.every(
    (id) => steamUsers.get(bans.get(id).steamUser).lastRefreshedReputationPoints === FRESH
  )
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 120 bans fetched, 0 new, 0 updated. Kept the 80 of its 200 stored bans that it lost at once, as losing so many at once more likely means that its source broke, or now leaves some bans out, such as its expired ones. They are kept until fewer than 40 of them are missing, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.'
  ]
);
assert.match(summary(), /, 0 removed, 80 held, 0 lists failed\.$/);
// The run's record gives the hold and the held bans, which its status message, and a cycle's embed,
// count as held.
assert.deepStrictEqual(
  [plainReport(largeImporter).held, plainReport(largeImporter).banLists],
  [
    80,
    [
      {
        id: 5,
        fetched: 120,
        new: 0,
        updated: 0,
        removed: 0,
        held: 80,
        read: 'full',
        reason: 'new',
        stored: 200,
        hold: 'large',
        state: 'held'
      }
    ]
  ]
);
// It stays held, as 'large', on every run until an admin confirms it, however long its bans have
// been missing, and its line is posted on every run, with since when, and how many of them must
// still be missing for the hold to last. Why it is held is read, and was saved as the hold began,
// and again only as the list shrank, here to 197 bans, which it is measured against from then.
// The bans it loses meanwhile are removed as usual: a few at once, and more, up to one ban fewer
// than a large loss of the list, once a later complete read confirms they are gone.
const heldSince = new Date(pendingRows.get(`5,${lostLarge[0]}`).heldAt);
for (const [again, served, removedNow, waiting, of] of [
  [1, pairs('e', 80, 200), 0, 0, 200],
  [2, pairs('e', 83, 200), 3, 0, 200],
  [3, pairs('e', 122, 200), 0, 39, 197]
]) {
  age(5, 60);
  heldSince.setTime(heldSince.getTime() - 60 * 60 * 1000);
  battlemetricsLists.set('bm-5', [served]);
  events.length = 0;
  logs.length = 0;
  [result] = await run();
  const at = `run ${again + 1}`;
  assert.deepStrictEqual(
    [result.hold, result.held, result.pending, result.removed],
    ['large', 80 + waiting, waiting, removedNow],
    at
  );
  assert.deepStrictEqual(
    [heldIDs(5).sort(), holdRows.get(5)],
    [[...lostLarge].sort(), { reason: 'large', storedCount: of }],
    at
  );
  assert.deepStrictEqual(
    events.filter(([type]) => type.endsWith('hold reason')).map(([type, ids]) => [type, ids]),
    of === 200
      ? [['read hold reason', 5]]
      : [
          ['read hold reason', 5],
          ['save hold reason', [5, 'large', 197]]
        ],
    at
  );
  const others =
    waiting > 0
      ? ` Of its other bans, ${waiting} that it no longer has are kept until a later complete read of it confirms they are gone.`
      : '';
  assert.deepStrictEqual(
    warnings().map(({ message }) => message),
    [
      `Imported ban list (ID: 5): ${served.length} bans fetched, 0 new, 0 updated${removedNow > 0 ? `, ${removedNow} removed` : ''}. Still kept the 80 bans it lost at once, held since ${heldSince.toISOString()}, as losing so many at once more likely means that its source broke, or leaves them out. They are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.${others}`
    ],
    at
  );
}
age(5, 10);
heldSince.setTime(heldSince.getTime() - 10 * 60 * 1000);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 80, 39, 158]
);
// Named in IMPORTER_ALLOW_MASS_REMOVAL, it loses them on its next read, with their records and why
// they were held, and their players are queued, as an admin confirmed the loss. Its line says which
// hold that ended, as its earlier lines said it was held, and so does its record.
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
events.length = 0;
logs.length = 0;
const confirmImporter = new BanImporter();
[result] = await confirmImporter.importBans();
assert.deepStrictEqual(
  [result.removed, result.held, result.hold, result.massRemoval, storedIDs(5).length],
  [80, 0, null, true, 78]
);
assert.deepStrictEqual(plainReport(confirmImporter).banLists.map(holdFields), [
  { held: 0, holdEnded: 'large', massRemoval: true }
]);
assert.deepStrictEqual([pendingIDs(5), holdRows.has(5), row(5).state], [[], false, 'ok']);
assert.deepStrictEqual(
  events.filter(([type]) => type.endsWith('hold reason')).map(([type, ids]) => [type, ids]),
  [
    ['read hold reason', 5],
    ['clear hold reason', [5]]
  ]
);
assert.ok(lostLarge.every((id) => !bans.has(id)));
assert.ok(
  lostLarge.every((id, n) => steamUsers.get(steamID(n)).lastRefreshedReputationPoints === null),
  'their players are queued'
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 78 bans fetched, 0 new, 0 updated, 80 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list, which ended its hold of the 80 bans it lost at once, held since ${heldSince.toISOString()}. Remove it from the setting once the removal is done.`
  ]
);

// One ban fewer than a fifth of the list, 39 of 200, is not held: it waits for a later complete
// read, which removes it at least 10 minutes on, as before, and nothing is posted.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 39, 200)]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed],
  [null, 39, 39, 0]
);
assert.deepStrictEqual([heldIDs(5), holdRows.has(5), warnings()], [[], false, []]);
age(5, 10);
[result] = await run();
assert.deepStrictEqual([result.removed, result.held, storedIDs(5).length], [39, 0, 161]);

// A held ban that comes back is no longer held, but the hold goes on while those still missing are a
// large loss of the 200 bans the list had when it began, at least 40, however much the list has
// grown since: the ban loses its record, the others stay held, as they were, and why the list is
// held stays saved. The read posts its line, with how many came back, and its record says so.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
age(5, 600);
const largeSince = new Date(pendingRows.get('5,5,e1').heldAt).toISOString();
const stillHeld = (from) => pairs('e', from, 80).map(([uid]) => `5,${uid}`);
const grown = pairs('n', 1000, 1300);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('e', 80, 200), ...grown]]);
events.length = 0;
logs.length = 0;
let largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed, result.heldSince],
  ['large', 79, 0, 0, Date.parse(largeSince)]
);
assert.deepStrictEqual(
  [heldIDs(5).sort(), pendingRows.has('5,5,e0'), holdRows.get(5)],
  [stillHeld(1).sort(), false, { reason: 'large', storedCount: 200 }]
);
assert.deepStrictEqual(
  writes()
    .filter(([type]) => !['write', 'flags', 'add users'].includes(type))
    .map(([type, ids]) => [type, ids.length]),
  [
    ['clear pending', 1],
    ['save held', 79]
  ]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 79, hold: 'large', cameBack: 1 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 421 bans fetched, 300 new, 0 updated. Still kept the 79 bans it lost at once, held since ${largeSince}, as losing so many at once more likely means that its source broke, or leaves them out. 1 of the bans it held came back, and is no longer held. The rest are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
// The list now has 500 bans, of which 79 are less than a fifth, but they are still measured against
// the 200 it had when the hold began.
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.stored, result.hold, result.held, result.removed, heldIDs(5).length],
  [500, 'large', 79, 0, 79]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 79, hold: 'large' }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 421 bans fetched, 0 new, 0 updated. Still kept the 79 bans it lost at once, held since ${largeSince}, as losing so many at once more likely means that its source broke, or leaves them out. They are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
// So does a read in which 39 come back, which leaves 40 missing.
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 40), ...pairs('e', 80, 200), ...grown]]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, heldIDs(5).sort()],
  ['large', 40, 39, stillHeld(40).sort()]
);
assert.match(
  warnings()[0]?.message ?? '',
  / as losing so many at once more likely means that its source broke, or leaves them out\. 39 of the bans it held came back, and are no longer held\. The rest are kept until fewer than 40 of them are missing\. /
);
// Once fewer are still missing, the hold ends: the 39 still missing wait for a later complete read,
// as if first missing now, however long they were held, and are not held again as a large loss. Why
// it was held is forgotten. All of that, with the record of the ban that came back, is written in
// one transaction. The read that ended the hold posts its line, with how many came back, which few
// are still missing, and when they are removed, and its record says which hold ended.
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 80, 200), ...grown]]);
events.length = 0;
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed],
  [null, 39, 39, 0]
);
assert.deepStrictEqual(
  [heldIDs(5), pendingIDs(5).sort(), holdRows.has(5), row(5).state],
  [[], stillHeld(41).sort(), false, 'held']
);
assert.ok(pendingRows.get('5,5,e41').firstMissingAt >= Date.now() - 60 * 1000);
const endTx = writes().find(([type]) => type === 'release held')[2];
assert.deepStrictEqual(
  writes().map(([type, ids, tx]) => [type, ids.length, tx === endTx]),
  [
    ['clear pending', 1, true],
    ['release held', 39, true],
    ['clear hold reason', 1, true],
    ['save pending', 39, false]
  ]
);
assert.deepStrictEqual(inTransaction(endTx), [
  'begin',
  'clear pending',
  'release held',
  'clear hold reason',
  'commit'
]);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 39, pending: 39, holdEnded: 'large', cameBack: 1 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 461 bans fetched, 0 new, 0 updated. Stopped holding the 40 bans it lost at once, held since ${largeSince}, as 1 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
// The read 10 minutes on removes them, which is not a large part of the list, so is not posted.
age(5, 10);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.removed, result.hold, result.held, storedIDs(5).length, warnings()],
  [39, null, 0, 461, []]
);
// A hold whose bans all came back ends too, which is posted, and leaves nothing to remove. When few
// are still missing, here 5, they are removed at once.
for (const [served, why, removedNow, rest] of [
  [pairs('e', 0, 200), 'all of them came back', 0, ''],
  [
    [...pairs('e', 0, 75), ...pairs('e', 80, 200)],
    '75 of them came back, which leaves fewer than 40 missing',
    5,
    ' The other 5, which it still does not have, were removed.'
  ]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  await run();
  const since = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
  battlemetricsLists.set('bm-5', [served]);
  logs.length = 0;
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.removed, pendingIDs(5), holdRows.has(5)],
    [null, 0, removedNow, [], false],
    why
  );
  assert.deepStrictEqual(
    warnings().map(({ message }) => message),
    [
      `Imported ban list (ID: 5): ${served.length} bans fetched, 0 new, 0 updated${removedNow > 0 ? `, ${removedNow} removed` : ''}. Stopped holding the 80 bans it lost at once, held since ${since}, as ${why}.${rest}`
    ],
    why
  );
}
// An admin's confirmation is said to have ended a hold only when the hold would otherwise have gone
// on. Here all 80 came back by the read that IMPORTER_ALLOW_MASS_REMOVAL names the list for: none
// is removed, and the line says the hold ended as they came back, as it would without the setting.
// Then 41 come back, which ends the hold without the setting too: the line says so, and that the
// confirmation, by the setting or in the database, removed the other 39 at once, which would
// otherwise have waited for a confirming read.
for (const [back, by, why, rest] of [
  [80, 'setting', 'all of them came back', ''],
  [
    41,
    'setting',
    '41 of them came back, which leaves fewer than 40 missing',
    ' The other 39, which it still does not have, were removed. As IMPORTER_ALLOW_MASS_REMOVAL names the list, the bans it no longer has were removed at once. Remove it from the setting once the removal is done.'
  ],
  [
    41,
    'row',
    '41 of them came back, which leaves fewer than 40 missing',
    ' The other 39, which it still does not have, were removed. As an admin confirmed that it may lose them all, the bans it no longer has were removed at once.'
  ]
]) {
  const served = [...pairs('e', 0, back), ...pairs('e', 80, 200)];
  const removedNow = 80 - back;
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  await run();
  const since = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
  battlemetricsLists.set('bm-5', [served]);
  if (by === 'setting') env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
  else syncRows.get(5).allowFullRemovalUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
  logs.length = 0;
  largeImport = new BanImporter();
  [result] = await largeImport.importBans();
  const label = `${back} back, confirmed by the ${by}`;
  assert.deepStrictEqual(
    [result.removed, pendingIDs(5), holdRows.has(5), storedIDs(5).length],
    [removedNow, [], false, 200 - removedNow],
    label
  );
  assert.deepStrictEqual(
    plainReport(largeImport).banLists.map(holdFields),
    [
      {
        held: 0,
        holdEnded: 'large',
        cameBack: back,
        ...(removedNow > 0 ? { massRemoval: true } : {})
      }
    ],
    label
  );
  assert.deepStrictEqual(
    warnings().map(({ message }) => message),
    [
      `Imported ban list (ID: 5): ${served.length} bans fetched, 0 new, 0 updated${removedNow > 0 ? `, ${removedNow} removed` : ''}. Stopped holding the 80 bans it lost at once, held since ${since}, as ${why}.${rest}`
    ],
    label
  );
}

// A read that ends a large hold, as enough of its bans came back, here 41 of 80, and loses a large
// part of the list's other bans at once, holds those as a hold that begins, with no since when, as
// none of them was held before, and says what becomes of the bans of the hold that ended, which
// wait for a confirming read, as if first missing now. Here the list grew from 200 bans to 500
// while the first hold lasted, so the hold that begins is of the 500: it lost 120 of them, and its
// bans are kept until fewer than 100 of them are missing, while the hold that ended was measured
// against the 200 it had when it began. Why the list is held is saved again, with the 500 bans the
// list had before this read, in the transaction that ends the old hold and holds them.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 80, 200), ...pairs('n', 1000, 1300)]]);
await run();
age(5, 600);
const endedSince = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
battlemetricsLists.set('bm-5', [
  [...pairs('e', 0, 41), ...pairs('e', 80, 200), ...pairs('n', 1120, 1300)]
]);
events.length = 0;
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed, result.heldSince],
  ['large', 159, 39, 0, undefined]
);
assert.deepStrictEqual(
  [heldIDs(5), pendingIDs(5).length, holdRows.get(5)],
  [pairs('n', 1000, 1120).map(([uid]) => `5,${uid}`), 159, { reason: 'large', storedCount: 500 }]
);
const againTx = writes().find(([type]) => type === 'save hold reason')[2];
assert.deepStrictEqual(
  writes()
    .filter(([type]) => !['write', 'flags', 'add users'].includes(type))
    .map(([type, ids, tx]) => [type, ids.length, tx === againTx]),
  [
    ['clear pending', 41, true],
    ['release held', 39, true],
    ['save hold reason', 3, true],
    ['save held', 120, true],
    ['save pending', 39, false]
  ]
);
assert.deepStrictEqual(
  writes().find(([type]) => type === 'save hold reason'),
  ['save hold reason', [5, 'large', 500], againTx]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 159, pending: 39, hold: 'large', holdEnded: 'large', cameBack: 41 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 341 bans fetched, 0 new, 0 updated. Kept the 120 of its 500 stored bans that it lost at once, as losing so many at once more likely means that its source broke, or now leaves some bans out, such as its expired ones. They are kept until fewer than 100 of them are missing, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run. Stopped holding the 80 bans it lost at once, held since ${endedSince}, as 41 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);

// A list held as it lost a large part of its bans that then loses all of them keeps that hold,
// which takes them all in: all of its bans are held anew, from then, in one transaction, why it is
// held, and of how many bans, stays as it was, and its line says so as a hold that begins, kept
// until fewer than 40 of them are missing, as for the large loss of the 200 bans it had then,
// though it has 230 now. The lines after it say since then, not since the large loss. Held as one
// that lost all of its bans, they would all be let go once one of them came back, to be removed 10
// minutes later: here an admin re-activates one of the expired bans, and the other 229, of which
// 79 are the large loss, stay held, and are not removed 10 minutes on. Once the source gives the
// list's other bans again, the 79 are still held.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 80, 200), ...pairs('n', 1000, 1030)]]);
await run();
age(5, 600);
battlemetricsLists.set('bm-5', [pairs('n', 2000, 2030)]);
events.length = 0;
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.heldSince, holdRows.get(5)],
  ['large', 230, 0, undefined, { reason: 'large', storedCount: 200 }]
);
const anewAt = pendingRows.get('5,5,e0').heldAt;
assert.ok(anewAt >= Date.now() - 60 * 1000);
assert.deepStrictEqual(
  [heldIDs(5).length, [...pendingRows.values()].filter(({ heldAt }) => heldAt === anewAt).length],
  [230, 230]
);
const anewTx = writes().find(([type]) => type === 'release held')[2];
assert.deepStrictEqual(inTransaction(anewTx), ['begin', 'release held', 'save held', 'commit']);
assert.deepStrictEqual(
  writes().filter(([type]) => type.endsWith('hold reason')),
  []
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 30 bans fetched, 30 new, 0 updated. Kept all 230 of its stored bans, as it no longer has any of them, which more likely means that its source broke, or leaves them out. It was already held as it lost a large part of them, so they are kept until fewer than 40 of them are missing, as for that hold, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.'
  ]
);
age(5, 60);
logs.length = 0;
[result] = await run();
const anewSince = new Date(anewAt - 60 * 60 * 1000).toISOString();
assert.deepStrictEqual(
  [result.hold, result.held, result.heldSince, holdRows.get(5)],
  ['large', 230, anewAt - 60 * 60 * 1000, { reason: 'large', storedCount: 200 }]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 30 bans fetched, 0 new, 0 updated. Still kept the 230 bans it lost at once, held since ${anewSince}, as losing so many at once more likely means that its source broke, or leaves them out. They are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('n', 2000, 2030)]]);
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed, heldIDs(5).length],
  ['large', 229, 0, 0, 229]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 229, hold: 'large', cameBack: 1 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 31 bans fetched, 0 new, 0 updated. Still kept the 229 bans it lost at once, held since ${anewSince}, as losing so many at once more likely means that its source broke, or leaves them out. 1 of the bans it held came back, and is no longer held. The rest are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 229, 0, 260]
);
battlemetricsLists.set('bm-5', [
  [
    ...pairs('e', 0, 1),
    ...pairs('e', 80, 200),
    ...pairs('n', 1000, 1030),
    ...pairs('n', 2000, 2030)
  ]
]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, result.removed, heldIDs(5).sort()],
  ['large', 79, 150, 0, stillHeld(1).sort()]
);
// A list whose only bans are those it holds as a large loss, whose read finds none of them, keeps
// its hold as it was: none of them is released, and its line says since when. Here the list shrank
// to those 50 since the hold began, as other bans of it were removed, so it is measured against the
// 50 from now, in the transaction that goes on with the hold, and kept while 25 are missing.
reset();
battlemetricsList(5, pairs('e', 0, 50), [pairs('n', 1000, 1010)]);
const largeBefore = Date.now() - 3 * 60 * 60 * 1000;
for (const [uid] of pairs('e', 0, 50))
  pendingRows.set(`5,5,${uid}`, {
    banList: 5,
    banId: `5,${uid}`,
    firstMissingAt: largeBefore,
    lastMissingAt: largeBefore,
    heldAt: largeBefore
  });
holdRows.set(5, { reason: 'large', storedCount: 200 });
events.length = 0;
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.heldSince, heldIDs(5).length, holdRows.get(5)],
  ['large', 50, largeBefore, 50, { reason: 'large', storedCount: 50 }]
);
const shrankTx = writes().find(([type]) => type === 'save held')[2];
assert.deepStrictEqual(
  writes()
    .filter(([type]) => !['write', 'flags', 'add users'].includes(type))
    .map(([type, ids, tx]) => [type, ids.length, tx === shrankTx]),
  [
    ['save hold reason', 3, true],
    ['save held', 50, true]
  ]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 10 bans fetched, 10 new, 0 updated. Still kept the 50 bans it lost at once, held since ${new Date(largeBefore).toISOString()}, as losing so many at once more likely means that its source broke, or leaves them out. They are kept until fewer than 25 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);

// A row that says 'large' while fewer of the list's bans are held than a large loss of the bans it
// names outlived its hold: here the previous image, which deletes no row, ended a 'large' hold of
// the list when it had 120 bans, then held its 20 bans as 'full', as it lost all of them, and the
// list saved 5 since. Taken as 'large', measured against 120, the hold would end with none of them
// back, and its bans would be removed 10 minutes later. They are taken as 'full', as they are: the
// hold goes on, its line says so, and the row is deleted, so the next read takes them so too, with
// no row, and removes none of them.
reset();
battlemetricsList(5, [...pairs('e', 0, 20), ...pairs('n', 1000, 1005)], [pairs('n', 1000, 1005)]);
const fullBefore = Date.now() - 3 * 60 * 60 * 1000;
for (const [uid] of pairs('e', 0, 20))
  pendingRows.set(`5,5,${uid}`, {
    banList: 5,
    banId: `5,${uid}`,
    firstMissingAt: fullBefore,
    lastMissingAt: fullBefore,
    heldAt: fullBefore
  });
holdRows.set(5, { reason: 'large', storedCount: 120 });
events.length = 0;
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.heldSince, heldIDs(5).length, holdRows.has(5)],
  ['full', 20, 0, fullBefore, 20, false]
);
assert.deepStrictEqual(
  events.filter(([type]) => type.endsWith('hold reason')).map(([type]) => type),
  ['read hold reason', 'clear hold reason']
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 5 bans fetched, 0 new, 0 updated. Still kept the 20 bans it had when it lost all of its bans at once, held since ${new Date(fullBefore).toISOString()}, as none of them has come back, which more likely means that its source broke. If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length, holdRows.has(5)],
  ['full', 20, 0, 25, false]
);
// Such a hold ends as one of its bans comes back. A large loss of the list's other bans in the
// same read is held, as a hold that begins, whose row is kept.
reset();
battlemetricsList(
  5,
  [...pairs('e', 0, 20), ...pairs('n', 1000, 1200)],
  [[...pairs('e', 0, 1), ...pairs('n', 1100, 1200)]]
);
for (const [uid] of pairs('e', 0, 20))
  pendingRows.set(`5,5,${uid}`, {
    banList: 5,
    banId: `5,${uid}`,
    firstMissingAt: fullBefore,
    lastMissingAt: fullBefore,
    heldAt: fullBefore
  });
holdRows.set(5, { reason: 'large', storedCount: 1000 });
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, heldIDs(5).length, holdRows.get(5)],
  ['large', 119, 19, 100, { reason: 'large', storedCount: 220 }]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 119, pending: 19, hold: 'large', holdEnded: 'full', cameBack: 1 }
]);

// A read that finds no bans at all while a list is held as a large loss keeps the list held, as it
// keeps any list, and keeps why: the next read that finds bans says it is still held as one.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[]]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, heldIDs(5).length, holdReason(5), storedIDs(5).length],
  ['empty', 80, 'large', 200]
);
battlemetricsLists.set('bm-5', [pairs('e', 80, 200)]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, holdReason(5)], ['large', 80, 'large']);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 5\): 120 bans fetched, 0 new, 0 updated\. Still kept the 80 bans it lost at once, held since /
);

// A hold is saved whole, with why, or not at all. Here the database goes away while the second
// batch of the hold's bans is saved, on every attempt, so the list fails, and none of the hold is
// saved: neither its first batch nor why. The next complete read finds the same loss, and holds all
// of it as a hold that begins, and the read 10 minutes on removes none of it. Had the first batch
// been saved alone, the next read would have taken the list as held, and the rest of the bans it
// lost, too few to be held on their own, as missing besides, which a confirming read removes.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
onHold = (ids) => {
  if (ids.includes('5,e50')) throw new ConnectionError();
};
events.length = 0;
[result] = await run({ batchSize: 50 });
assert.deepStrictEqual(
  [result.stage, result.error, heldIDs(5), pendingIDs(5), holdRows.has(5), storedIDs(5).length],
  [
    'holding the bans it no longer has',
    'SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.2:3306',
    [],
    [],
    false,
    200
  ]
);
assert.deepStrictEqual(
  ['begin', 'rollback', 'commit'].map((step) => events.filter(([type]) => type === step).length),
  [5, 5, 0]
);
onHold = null;
logs.length = 0;
[result] = await run({ batchSize: 50 });
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, heldIDs(5).length, holdReason(5)],
  ['large', 80, 0, 80, 'large']
);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 5\): 120 bans fetched, 0 new, 0 updated\. Kept the 80 of its 200 stored bans that it lost at once, /
);
age(5, 10);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 80, 0, 200]
);

// Why a list's bans are held is forgotten once they no longer are, also when the hold ended without
// the importer: here /banlist update gives a held list a new source, and deletes its bans, so the
// next read, of its new source, finds no held bans, and deletes the row. So does the next complete
// read of a list whose hold the previous image ended, which did not know the row.
reset();
battlemetricsList(93, pairs('o', 0, 200), [pairs('o', 80, 200)]);
await run();
assert.deepStrictEqual([heldIDs(93).length, holdReason(93)], [80, 'large']);
banLists.set(93, { ...banLists.get(93), source: 'bm-93-new' });
for (const id of storedIDs(93)) bans.delete(id);
battlemetricsLists.set('bm-93-new', [pairs('p', 0, 50)]);
events.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.replace, result.hold, result.held, pendingIDs(93), holdRows.has(93), row(93).state],
  [true, null, 0, [], false, 'ok']
);
assert.deepStrictEqual(
  events.filter(([type]) => type.endsWith('hold reason')),
  [
    ['read hold reason', 93],
    ['clear hold reason', [93], null]
  ]
);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
for (const id of pendingIDs(5)) pendingRows.delete(`5,${id}`);
assert.deepStrictEqual([pendingIDs(5), holdReason(5)], [[], 'large']);
battlemetricsLists.set('bm-5', [pairs('e', 0, 200)]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, holdRows.has(5), warnings()],
  [null, 0, false, []]
);

// A large loss of a list whose source was changed since it was last imported is never held, as its
// new source's bans replace its old ones, and a hold of the old source's bans ends, though as many
// of them as when it began are still missing, which the list's record says.
reset();
battlemetricsList(93, pairs('o', 0, 200), [pairs('o', 80, 200)], 'bm-93-new');
syncRows.set(93, {
  banList: 93,
  sourceKey: createHash('sha256')
    .update(JSON.stringify(['battlemetrics', 'bm-93']))
    .digest('hex'),
  state: 'ok'
});
[result] = await run();
assert.deepStrictEqual(
  [result.replace, result.hold, result.pending, heldIDs(93), holdRows.has(93)],
  [true, null, 80, [], false]
);
reset();
battlemetricsList(93, pairs('o', 0, 200), [pairs('o', 80, 200)]);
await run();
assert.deepStrictEqual([heldIDs(93).length, holdReason(93)], [80, 'large']);
const replacedSince = new Date(pendingRows.get('93,93,o0').heldAt).toISOString();
banLists.set(93, { ...banLists.get(93), source: 'bm-93-new' });
battlemetricsLists.set('bm-93-new', [pairs('o', 80, 200)]);
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.replace, result.hold, result.pending, heldIDs(93), holdRows.has(93)],
  [true, null, 80, [], false]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 80, pending: 80, holdEnded: 'large' }
]);
// Its line says that the hold ended with the old source's bans, as its earlier lines said they
// were held. So does that of a list whose new source gives all of the bans it held, so that none
// of them is removed or waits.
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 93): 120 bans fetched, 0 new, 0 updated. Its type or source was changed since it was last imported, so the bans of its old source are being replaced: 0 were removed, and 80 more are kept until a later complete read of it confirms they are gone. That ended its hold of the 80 bans it lost at once, held since ${replacedSince}.`
  ]
);
reset();
battlemetricsList(93, pairs('o', 0, 200), [pairs('o', 80, 200)]);
await run();
const sameSince = new Date(pendingRows.get('93,93,o0').heldAt).toISOString();
banLists.set(93, { ...banLists.get(93), source: 'bm-93-new' });
battlemetricsLists.set('bm-93-new', [pairs('o', 0, 200)]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.replace, result.removed, result.pending, heldIDs(93), holdRows.has(93)],
  [true, 0, 0, [], false]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 93): 200 bans fetched, 0 new, 0 updated. Its type or source was changed since it was last imported, so the bans of its old source are being replaced: 0 were removed. That ended its hold of the 80 bans it lost at once, held since ${sameSince}.`
  ]
);

// A dry run says it would hold them, and writes nothing: no record of them, nor why.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
env.IMPORTER_DRY_RUN = '1';
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 80, 0]);
assert.deepStrictEqual([pendingIDs(5), holdRows.has(5), writes()], [[], false, []]);
assert.deepStrictEqual(warnings().length, 1);

// The IDs of list 5's bans with the uids given, as they are stored.
const banIDs = (prefix, from, to) => pairs(prefix, from, to).map(([uid]) => `5,${uid}`);

// A hold is ended in one transaction too, with the records of its bans that came back, so a run
// cut short as it ends one, e.g. by a database outage longer than the retries or the process
// being killed, ends none of it. Here a list of 200 held for 80 grew to 500, and a read
// finds 41 of the 80 again, which ends the hold, and loses 120 of the bans it saved since, which
// begins another. The release fails on every attempt, so the list fails, with its hold, its row and
// the records of the 41 as they were, and its entry in the run's record gives none of it. The next
// read does what this one would have: it ends the old hold, holds the 120, and says so, as holds of
// large losses, not as one of a list that lost all of its bans, and the read 11 minutes later
// removes none of the 120.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 80, 200), ...pairs('n', 1000, 1300)]]);
await run();
age(5, 600);
const cutSince = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
battlemetricsLists.set('bm-5', [
  [...pairs('e', 0, 41), ...pairs('e', 80, 200), ...pairs('n', 1120, 1300)]
]);
statementErrors.set(
  'release held',
  Array.from({ length: 5 }, () => new ConnectionError())
);
events.length = 0;
const cutEnd = new BanImporter();
[result] = await cutEnd.importBans();
assert.deepStrictEqual(
  [result.stage, result.error, heldIDs(5).length, pendingRows.has('5,5,e0'), holdRows.get(5)],
  [
    'holding the bans it no longer has',
    'SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.2:3306',
    80,
    true,
    { reason: 'large', storedCount: 200 }
  ]
);
assert.deepStrictEqual(
  [plainReport(cutEnd).banLists.map(holdFields), plainReport(cutEnd).held],
  [[{ held: 0 }], 0]
);
assert.deepStrictEqual(
  ['begin', 'clear pending', 'rollback', 'commit'].map(
    (step) => events.filter(([type]) => type === step).length
  ),
  [5, 5, 5, 0]
);
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed, heldIDs(5).sort(), holdRows.get(5)],
  ['large', 159, 39, 0, banIDs('n', 1000, 1120).sort(), { reason: 'large', storedCount: 500 }]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 159, pending: 39, hold: 'large', holdEnded: 'large', cameBack: 41 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 341 bans fetched, 0 new, 0 updated. Kept the 120 of its 500 stored bans that it lost at once, as losing so many at once more likely means that its source broke, or now leaves some bans out, such as its expired ones. They are kept until fewer than 100 of them are missing, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run. Stopped holding the 80 bans it lost at once, held since ${cutSince}, as 41 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, heldIDs(5).length, storedIDs(5).length],
  ['large', 120, 39, 120, 461]
);

// So does the end of a hold cut short alone. The read after it ends the hold, as 41 of its bans
// came back, and the 39 still missing wait for a confirming read, which its line says, rather than
// being kept as the bans of a list that lost all of its bans. A large loss of the list's other bans
// after that is held, as a hold that begins, and the read 11 minutes on removes the 39, but none of
// that loss.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
age(5, 60);
const cutAloneSince = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 80, 200)]]);
statementErrors.set(
  'release held',
  Array.from({ length: 5 }, () => new ConnectionError())
);
[result] = await run();
assert.deepStrictEqual(
  [result.stage, heldIDs(5).length, pendingIDs(5).length, holdRows.get(5)],
  ['removing the bans it no longer has', 80, 80, { reason: 'large', storedCount: 200 }]
);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, heldIDs(5), pendingIDs(5).length, holdRows.has(5)],
  [null, 39, 39, [], 39, false]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 161 bans fetched, 0 new, 0 updated. Stopped holding the 80 bans it lost at once, held since ${cutAloneSince}, as 41 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 130, 200)]]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, heldIDs(5).sort(), holdRows.get(5)],
  ['large', 89, 39, banIDs('e', 80, 130).sort(), { reason: 'large', storedCount: 200 }]
);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 5\): 111 bans fetched, 0 new, 0 updated\. Kept the 50 of its 200 stored bans that it lost at once, .* Of its other bans, 39 that it no longer has are kept until a later complete read of it confirms they are gone\.$/
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, heldIDs(5).length, storedIDs(5).length],
  ['large', 50, 39, 50, 161]
);

// A list whose read fails before what it changes of a hold is written keeps that hold as it was,
// and its entry in the run's record, and the run's totals, say none of it, as for any list that
// fails: here the end of a hold of 80 of 200, as 41 of them came back, whose release fails on every
// attempt, and a hold of 80 of 200 that begins, whose bans cannot be held. One whose hold is
// written, but whose records of the bans that wait for a later complete read are cut short, says
// the hold, and the records it made: here a hold of 80 that goes on, and 10 of 30 others.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 80, 200)]]);
statementErrors.set(
  'release held',
  Array.from({ length: 5 }, () => new ConnectionError())
);
let failedHold = new BanImporter();
[result] = await failedHold.importBans();
assert.deepStrictEqual(
  [result.stage, heldIDs(5).length, holdRows.get(5)],
  ['removing the bans it no longer has', 80, { reason: 'large', storedCount: 200 }]
);
assert.deepStrictEqual(
  [
    plainReport(failedHold).banLists.map(holdFields),
    plainReport(failedHold).held,
    plainReport(failedHold).pending
  ],
  [[{ held: 0 }], 0, 0]
);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
onHold = () => {
  throw new ConnectionError();
};
logs.length = 0;
failedHold = new BanImporter();
[result] = await failedHold.importBans();
onHold = null;
assert.deepStrictEqual(
  [result.stage, heldIDs(5), holdRows.has(5)],
  ['holding the bans it no longer has', [], false]
);
assert.deepStrictEqual(
  [plainReport(failedHold).banLists.map(holdFields), plainReport(failedHold).held],
  [[{ held: 0 }], 0]
);
assert.match(summary(), /, 0 removed, 0 held, 1 list failed\.$/);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [pairs('e', 110, 200)]);
statementErrors.set('save pending', [
  null,
  ...Array.from({ length: 5 }, () => new ConnectionError())
]);
failedHold = new BanImporter({ batchSize: 10 });
[result] = await failedHold.importBans();
assert.deepStrictEqual(
  [result.stage, heldIDs(5).length, pendingIDs(5).length],
  ['removing the bans it no longer has', 80, 90]
);
assert.deepStrictEqual(
  [
    plainReport(failedHold).banLists.map(holdFields),
    plainReport(failedHold).held,
    plainReport(failedHold).pending
  ],
  [[{ held: 90, pending: 10, hold: 'large' }], 90, 10]
);
// The bans a hold's transaction releases as it ends wait for a later complete read from when it
// commits, so a list that fails, or is stopped, after that gives them as held and pending, as the
// database then has them: here a hold of 80 of 200 that ends as 41 of them come back, whose records
// of the other 39 then fail on every attempt, and the same hold ending as 40 others are lost, a
// large loss, which begins another, written before the bans are saved, whose new ban then cannot
// be saved, or SIGTERM comes as it is saved. The 39 are pending, and held with the 40 the new hold
// holds.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 80, 200)]]);
statementErrors.set(
  'save pending',
  Array.from({ length: 5 }, () => new ConnectionError())
);
failedHold = new BanImporter();
[result] = await failedHold.importBans();
assert.deepStrictEqual(
  [result.stage, heldIDs(5).length, pendingIDs(5).length, holdRows.has(5)],
  ['removing the bans it no longer has', 0, 39, false]
);
assert.deepStrictEqual(
  [
    plainReport(failedHold).banLists.map(holdFields),
    plainReport(failedHold).held,
    plainReport(failedHold).pending
  ],
  [[{ held: 39, pending: 39, holdEnded: 'large', cameBack: 41 }], 39, 39]
);
for (const cut of ['an outage', 'SIGTERM']) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  await run();
  battlemetricsLists.set('bm-5', [
    [...pairs('e', 0, 41), ...pairs('e', 80, 160), ...pairs('n', 1000, 1001)]
  ]);
  let report;
  if (cut === 'an outage') {
    writeErrors.set(
      '5,n1000',
      Array.from({ length: 5 }, () => new ConnectionError())
    );
    failedHold = new BanImporter();
    [result] = await failedHold.importBans();
    assert.deepStrictEqual([result.stage, storedIDs(5).length], ['saving its bans', 200], cut);
    report = plainReport(failedHold);
    assert.deepStrictEqual(report.banLists.map(holdFields), [
      { held: 79, pending: 39, hold: 'large', holdEnded: 'large', cameBack: 41 }
    ]);
  } else {
    const stopping = await loadImporter();
    onWrite = (ids) => {
      if (ids.includes('5,n1000')) stopping.control.requestStop('it received SIGTERM');
    };
    const stoppedImport = new stopping.BanImporter();
    const stopped = await stoppedImport.importBans().catch((err) => err);
    onWrite = null;
    assert.deepStrictEqual([stopped.name, storedIDs(5).length], ['RunStopped', 201], cut);
    report = plainReport(stoppedImport);
    assert.deepStrictEqual(holdFields(report.stopped), {
      held: 79,
      pending: 39,
      hold: 'large',
      holdEnded: 'large',
      cameBack: 41
    });
  }
  assert.deepStrictEqual(
    [heldIDs(5).length, pendingIDs(5).length, holdRows.get(5)],
    [40, 79, { reason: 'large', storedCount: 200 }],
    cut
  );
  assert.deepStrictEqual(
    [report.held, report.pending],
    cut === 'an outage' ? [79, 39] : [0, 0],
    cut
  );
}

// An admin's confirmation that ends a hold releases its bans, and forgets why they were held, in
// one transaction, before any of them is removed. So a removal cut short after its first batch
// leaves the rest waiting for a confirming read, whose removal the admin confirmed already,
// rather than held, by a row that no longer fits them. Its line says how many it removed, and its
// entry in the run's record, and the run's totals, the rest as held and pending. The next read
// keeps the rest until then, and its line only goes to the console; the read 11 minutes on removes
// them, posted as a large part of the list.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
statementErrors.set('remove', [null, ...Array.from({ length: 5 }, () => new ConnectionError())]);
events.length = 0;
logs.length = 0;
const confirmedCut = new BanImporter({ batchSize: 50 });
[result] = await confirmedCut.importBans();
assert.deepStrictEqual(
  [
    plainReport(confirmedCut).banLists.map(holdFields),
    plainReport(confirmedCut).held,
    plainReport(confirmedCut).pending
  ],
  [[{ held: 30, pending: 30, holdEnded: 'large', massRemoval: true }], 30, 30]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Failed to import ban list (ID: 5) while removing the bans it no longer has, after removing 50 of its bans (120 bans fetched, 0 new, 0 updated, 50 removed). SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.2:3306'
  ]
);
assert.deepStrictEqual(
  [
    result.stage,
    result.removed,
    storedIDs(5).length,
    heldIDs(5),
    pendingIDs(5).length,
    holdRows.has(5)
  ],
  ['removing the bans it no longer has', 50, 150, [], 30, false]
);
const releaseTx = writes().find(([type]) => type === 'release held')[2];
assert.deepStrictEqual(inTransaction(releaseTx), [
  'begin',
  'release held',
  'clear hold reason',
  'commit'
]);
assert.ok(
  writes().findIndex(([type]) => type === 'release held') <
    writes().findIndex(([type]) => type === 'remove')
);
delete env.IMPORTER_ALLOW_MASS_REMOVAL;
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.pending, result.removed, heldIDs(5), warnings()],
  [null, 30, 30, 0, [], []]
);
age(5, 11);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual([result.removed, storedIDs(5).length, pendingIDs(5)], [30, 120, []]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 120 bans fetched, 0 new, 0 updated, 30 removed. That is a large part of its 150 stored bans, removed as complete reads of it at least 10 minutes apart did not have them.'
  ]
);

// While a list is held as it lost a large part of its bans, a read that loses a large part of its
// other bans too, of those no earlier read had missed, holds every missing ban, as a hold that
// begins anew, in one transaction, still measured against the 200 bans it had. Here a source that
// left out 80 of 200 leaves out 160. Its line says so. The read 11 minutes on removes none of them,
// and once 41 of them come back, the other 119 are still held, and none of them is removed 11
// minutes later either.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
age(5, 30);
battlemetricsLists.set('bm-5', [pairs('e', 160, 200)]);
events.length = 0;
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [
    result.hold,
    result.held,
    result.pending,
    result.removed,
    result.heldSince,
    heldIDs(5).sort(),
    holdRows.get(5)
  ],
  ['large', 160, 0, 0, undefined, banIDs('e', 0, 160).sort(), { reason: 'large', storedCount: 200 }]
);
const takenInTx = writes().find(([type]) => type === 'release held')[2];
assert.deepStrictEqual(inTransaction(takenInTx), ['begin', 'release held', 'save held', 'commit']);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 40 bans fetched, 0 new, 0 updated. Kept the 160 of its 200 stored bans that it no longer has, as it lost a large part of them at once again, which more likely means that its source broke, or leaves them out. It was already held as it lost a large part of them, so they are kept until fewer than 40 of them are missing, as for that hold, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.'
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 160, 0]);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 160, 200)]]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, result.removed],
  ['large', 119, 41, 0]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 119, 0, 200]
);

// So does a read whose source gives only the bans the list saved while it was held: here 30, of a
// list grown to 230, which is not a read that found none of its bans. Some of its held bans that
// came back in the same read are no longer held, and its line says so.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 80, 200), ...pairs('n', 1000, 1030)]]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 10), ...pairs('n', 1000, 1030)]]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [
    result.hold,
    result.held,
    result.pending,
    result.removed,
    result.cameBack,
    heldIDs(5).length,
    holdRows.get(5)
  ],
  ['large', 190, 0, 0, 10, 190, { reason: 'large', storedCount: 200 }]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 40 bans fetched, 0 new, 0 updated. Kept the 190 of its 230 stored bans that it no longer has, as it lost a large part of them at once again, which more likely means that its source broke, or leaves them out. 10 of the bans it held came back, and are no longer held. It was already held as it lost a large part of them, so they are kept until fewer than 40 of them are missing, as for that hold, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.'
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 190, 0, 230]
);

// A read that would hold all of a list's missing bans anew, cut short as it holds them, saves none
// of that, and none of the bans it fetched either, as a hold is written before them, however many
// they are: here a list held for 80 of its 200 bans whose source gives none of them, but 30
// others, 401 or 600, as a batch of its held bans, all of them, or their release fails on every
// attempt. The next read finds the same loss, of all of its 200 bans, holds every missing ban
// anew, and saves the others, and the read 11 minutes on removes none. Had the read saved the
// others before its hold, the next would have measured the loss against them too: the 120 that
// no earlier read had missed are not a large loss of 601 or 800 bans, and would have been removed
// after a confirming read, with no admin.
for (const [others, fails] of [
  [30, 'a batch of its held bans'],
  [401, 'its held bans'],
  [600, 'their release']
]) {
  const label = `${others} others, ${fails} failing`;
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  await run();
  battlemetricsLists.set('bm-5', [pairs('n', 1000, 1000 + others)]);
  if (fails === 'their release')
    statementErrors.set(
      'release held',
      Array.from({ length: 5 }, () => new ConnectionError())
    );
  else
    onHold = (ids) => {
      if (fails === 'its held bans' || ids.includes('5,e150')) throw new ConnectionError();
    };
  [result] = await run({ batchSize: 50 });
  onHold = null;
  assert.deepStrictEqual(
    [result.stage, storedIDs(5).length, heldIDs(5).length, holdRows.get(5)],
    ['holding the bans it no longer has', 200, 80, { reason: 'large', storedCount: 200 }],
    label
  );
  [result] = await run({ batchSize: 50 });
  assert.deepStrictEqual(
    [result.hold, result.held, result.heldAnew, heldIDs(5).length, holdRows.get(5)],
    ['large', 200, 'large', 200, { reason: 'large', storedCount: 200 }],
    label
  );
  age(5, 11);
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.removed, storedIDs(5).length],
    ['large', 200, 0, 200 + others],
    label
  );
}

// A run cut short while the read's bans are saved, or after, leaves the hold the read wrote before
// them, which the next complete read keeps, though it measures against the list as the cut left
// it. Here a list of 200 whose source leaves out 40 of them, exactly a large loss, and
// gives 1 new ban: SIGTERM as that ban is saved leaves the 40 held, which the next read keeps,
// though 40 are not a large loss of the 201 bans the list then has, and a database outage longer
// than the retries as the hold is written saves none of it, nor the new ban, so the next read finds
// the same loss of 40 of 200, and holds it. The read 11 minutes on removes none of them either
// way. Saved before the hold, the new ban would have left the next read a loss of 40 of 201, which
// waits for a confirming read that removes it, with no admin.
for (const cut of ['SIGTERM', 'an outage']) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [[...pairs('e', 40, 200), ...pairs('n', 1000, 1001)]]);
  if (cut === 'SIGTERM') {
    const stopping = await loadImporter();
    onWrite = (ids) => {
      if (ids.includes('5,n1000')) stopping.control.requestStop('it received SIGTERM');
    };
    const stopped = await new stopping.BanImporter().importBans().catch((err) => err);
    onWrite = null;
    assert.deepStrictEqual(
      [stopped.name, storedIDs(5).length, heldIDs(5).length, holdRows.get(5)],
      ['RunStopped', 201, 40, { reason: 'large', storedCount: 200 }]
    );
  } else {
    statementErrors.set(
      'save hold reason',
      Array.from({ length: 5 }, () => new ConnectionError())
    );
    [result] = await run();
    assert.deepStrictEqual(
      [result.stage, storedIDs(5).length, heldIDs(5).length, holdRows.has(5)],
      ['holding the bans it no longer has', 200, 0, false]
    );
  }
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.pending, heldIDs(5).length, storedIDs(5).length],
    ['large', 40, 0, 40, 201],
    cut
  );
  age(5, 11);
  [result] = await run();
  assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 40, 0], cut);
}
// So does a list that loses all of its bans to a source that gives many others: here a list of 200
// whose source gives none of them, but 1,000 others, held as 'full', and a list held for 80 of its
// 200 as a large loss whose source then gives none of them, but 600 others, which takes them all
// in. SIGTERM as the last of the others is saved leaves the hold written, and the next read keeps
// all 200, though of the 1,200 bans, or the 800, the list then has, they are neither all nor a
// large loss. The read 11 minutes on removes none of them. Saved before the hold, the others would
// have left the next read 200 missing of 1,200, and 120 of 800 no earlier read had missed, which
// wait for a confirming read that removes them, with no admin.
for (const [hold, first, others] of [
  ['full', pairs('e', 0, 200), pairs('x', 2000, 3000)],
  ['large', pairs('e', 80, 200), pairs('x', 2000, 2600)]
]) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [first]);
  await run();
  battlemetricsLists.set('bm-5', [others]);
  const stopping = await loadImporter();
  const last = `5,${others.at(-1)[0]}`;
  onWrite = (ids) => {
    if (ids.includes(last)) stopping.control.requestStop('it received SIGTERM');
  };
  const stopped = await new stopping.BanImporter().importBans().catch((err) => err);
  onWrite = null;
  assert.deepStrictEqual(
    [stopped.name, storedIDs(5).length, heldIDs(5).length, holdRows.get(5)],
    ['RunStopped', 200 + others.length, 200, { reason: hold, storedCount: 200 }],
    hold
  );
  [result] = await run();
  assert.deepStrictEqual([result.hold, result.held, result.removed], [hold, 200, 0], hold);
  age(5, 11);
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.removed, storedIDs(5).length],
    [hold, 200, 0, 200 + others.length],
    hold
  );
}
// Holding bans needs the run lock, as removing them does: a run that has lost it stops before the
// hold, and before the bans it would save after it, so the next read finds the same loss.
reset();
battlemetricsList(5, pairs('e', 0, 200), [[...pairs('e', 40, 200), ...pairs('n', 1000, 1001)]]);
const lockLost = await loadImporter();
lockLost.control.setRunLock({ isHeld: async () => false });
const lost = await new lockLost.BanImporter().importBans().catch((err) => err);
assert.deepStrictEqual(
  [lost.reason, heldIDs(5), holdRows.has(5), written()],
  [lockLost.control.LOCK_LOST, [], false, []]
);
// A read whose hold only ends lets its bans go, so what it changes of the hold is written once its
// bans are saved, with those that wait or are removed, as before: here 41 of the 80 bans a list of
// 200 holds come back, with 1 new ban, and SIGTERM as that ban is saved leaves the hold as it was.
// The next read ends it, and says so.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
battlemetricsLists.set('bm-5', [
  [...pairs('e', 0, 41), ...pairs('e', 80, 200), ...pairs('n', 1000, 1001)]
]);
const endStopping = await loadImporter();
onWrite = (ids) => {
  if (ids.includes('5,n1000')) endStopping.control.requestStop('it received SIGTERM');
};
const endStopped = await new endStopping.BanImporter().importBans().catch((err) => err);
onWrite = null;
assert.deepStrictEqual(
  [endStopped.name, storedIDs(5).length, heldIDs(5).length, holdRows.get(5)],
  ['RunStopped', 201, 80, { reason: 'large', storedCount: 200 }]
);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.pending, result.holdEnded?.hold, heldIDs(5), holdRows.has(5)],
  [null, 39, 'large', [], false]
);
assert.match(
  warnings()[0]?.message ?? '',
  / Stopped holding the 80 bans it lost at once, held since .*, as 41 of them came back, which leaves fewer than 40 missing\. /
);
// A list removed while its bans are saved, after its read wrote its hold, is skipped as removed
// during the run, and its record says none of the hold, which went with it.
reset();
battlemetricsList(5, pairs('e', 0, 200), [[...pairs('e', 40, 200), ...pairs('n', 1000, 1001)]]);
onWrite = (ids) => {
  if (!ids.includes('5,n1000')) return;
  banLists.delete(5);
  for (const banID of storedIDs(5)) bans.delete(banID);
};
const removedWhileSaved = new BanImporter();
[result] = await removedWhileSaved.importBans();
onWrite = null;
assert.deepStrictEqual(
  [result.gone, result.hold, result.held, plainReport(removedWhileSaved).banLists.map(holdFields)],
  [true, null, 0, [{ held: 0 }]]
);
// So is a list removed as its hold is written: neither the hold nor any of its bans is saved.
reset();
battlemetricsList(5, pairs('e', 0, 200), [[...pairs('e', 40, 200), ...pairs('n', 1000, 1001)]]);
onHold = () => {
  banLists.delete(5);
};
events.length = 0;
[result] = await run();
onHold = null;
assert.deepStrictEqual(
  [result.gone, result.error, heldIDs(5), holdRows.has(5), written()],
  [true, undefined, [], false, []]
);
// A read drops the records of the bans it found again that waited for a confirming read before it
// saves its bans, also when it is not complete, in the transaction of any hold it writes then:
// dropped, a ban that is missing again later is missing for the first time, so it counts towards a
// large loss. So a run cut short while the bans are saved never leaves those records as they were.
// Here a list of 200 whose source left out 39 of them, too few to be a large loss, so they wait,
// gives all 200 again 20 minutes later, with 1 new ban, and SIGTERM comes as that ban is saved, a
// database outage longer than the retries fails it, or the read is not complete and SIGTERM comes
// as it is saved: the 39 have no records left. The next read loses 70 of the list's bans, the 39
// among them, a large loss, which it holds, and the read 11 minutes on removes none of them. Left
// as they were, the records would have made the 39 due at once, and the other 31 a loss too small
// to hold, removed 11 minutes later, with no admin.
for (const cut of ['SIGTERM', 'an outage', 'SIGTERM in a read that is not complete']) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 39, 200)]);
  [result] = await run();
  assert.deepStrictEqual([result.hold, result.pending, pendingIDs(5).length], [null, 39, 39], cut);
  age(5, 20);
  battlemetricsLists.set('bm-5', [[...pairs('e', 0, 200), ...pairs('n', 1000, 1001)]]);
  if (cut === 'an outage') {
    writeErrors.set(
      '5,n1000',
      Array.from({ length: 5 }, () => new ConnectionError())
    );
    [result] = await run();
    assert.deepStrictEqual([result.stage, storedIDs(5).length], ['saving its bans', 200], cut);
  } else {
    if (cut !== 'SIGTERM') battlemetricsTotals.set('bm-5', 900);
    const stopping = await loadImporter();
    onWrite = (ids) => {
      if (ids.includes('5,n1000')) stopping.control.requestStop('it received SIGTERM');
    };
    const stopped = await new stopping.BanImporter().importBans().catch((err) => err);
    onWrite = null;
    battlemetricsTotals.delete('bm-5');
    assert.deepStrictEqual([stopped.name, storedIDs(5).length], ['RunStopped', 201], cut);
  }
  assert.deepStrictEqual(pendingIDs(5), [], cut);
  battlemetricsLists.set('bm-5', [[...pairs('e', 70, 200), ...pairs('n', 1000, 1001)]]);
  [result] = await run();
  assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 70, 0], cut);
  age(5, 11);
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.removed, storedIDs(5).length],
    ['large', 70, 0, 201],
    cut
  );
}
// With a hold that keeps bans, they are dropped in its transaction: here the same list, whose
// source gives the 39 again 20 minutes later, but leaves out 100 others, a large loss, held as the
// hold begins, and SIGTERM comes as its new ban is saved.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 39, 200)]);
await run();
age(5, 20);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 100), ...pairs('n', 1000, 1001)]]);
const keepStopping = await loadImporter();
onWrite = (ids) => {
  if (ids.includes('5,n1000')) keepStopping.control.requestStop('it received SIGTERM');
};
events.length = 0;
const keepStopped = await new keepStopping.BanImporter().importBans().catch((err) => err);
onWrite = null;
assert.deepStrictEqual(
  [keepStopped.name, storedIDs(5).length, heldIDs(5).sort(), pendingIDs(5).length, holdRows.get(5)],
  ['RunStopped', 201, banIDs('e', 100, 200).sort(), 100, { reason: 'large', storedCount: 200 }]
);
const keepTx = events.find(([type]) => type === 'save hold reason')[2];
assert.deepStrictEqual(inTransaction(keepTx), [
  'begin',
  'clear pending',
  'save hold reason',
  'save held',
  'commit'
]);
assert.deepStrictEqual(
  events.find(([type]) => type === 'clear pending')[1].sort(),
  banIDs('e', 0, 39).sort()
);
// Dropping them needs the run lock, as holding bans does: a run that has lost it stops before it
// drops any, and before it saves any of the read's bans. A drop that fails, as the database stays
// unavailable, fails the list at its own stage, also before any of its bans are saved, and the
// next run drops them, and saves the new ban.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 39, 200)]);
await run();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 200), ...pairs('n', 1000, 1001)]]);
const dropLockLost = await loadImporter();
dropLockLost.control.setRunLock({ isHeld: async () => false });
events.length = 0;
const dropLost = await new dropLockLost.BanImporter().importBans().catch((err) => err);
assert.deepStrictEqual(
  [dropLost.reason, pendingIDs(5).length, written()],
  [dropLockLost.control.LOCK_LOST, 39, []]
);
statementErrors.set(
  'clear pending',
  Array.from({ length: 5 }, () => new ConnectionError())
);
[result] = await run();
assert.deepStrictEqual(
  [result.stage, result.error, pendingIDs(5).length, storedIDs(5).length],
  [
    'dropping the records of the bans it found again',
    'SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.2:3306',
    39,
    200
  ]
);
[result] = await run();
assert.deepStrictEqual(
  [result.error, pendingIDs(5).length, storedIDs(5).length],
  [undefined, 0, 201]
);

// A confirmed read that ends a hold as its bans came back, and in which a large loss of the list's
// other bans would, without the confirmation, begin a new hold, says that the hold ended as its
// bans came back: the confirmation then removed the rest, and the 50 others, at once.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
const confirmedSince = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 130, 200)]]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [
    result.removed,
    result.holdEnded.by,
    result.holdEnded.removed,
    pendingIDs(5),
    holdRows.has(5),
    storedIDs(5).length
  ],
  [89, 'read', true, [], false, 111]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 0, holdEnded: 'large', cameBack: 41, massRemoval: true }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 111 bans fetched, 0 new, 0 updated, 89 removed. Stopped holding the 80 bans it lost at once, held since ${confirmedSince}, as 41 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, were removed. As IMPORTER_ALLOW_MASS_REMOVAL names the list, the bans it no longer has were removed at once. Remove it from the setting once the removal is done.`
  ]
);
delete env.IMPORTER_ALLOW_MASS_REMOVAL;

// A held list that shrinks, as its owner lifts other bans of it, has its hold measured against the
// bans it has, as a hold that began on the smaller list would be: here 60 other bans are lifted, 5
// at a time, each removed at once, so the list has 140, and its row follows. Once 41 of the 80 come
// back, the 39 still missing are a large loss of the 140, at least 28, so the hold goes on, and
// the read 11 minutes on removes none of them. However much the list grows back after that, they
// are still measured against the 140, so its growth never ends the hold.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
for (let lifted = 5; lifted <= 60; lifted += 5) {
  battlemetricsLists.set('bm-5', [pairs('e', 80 + lifted, 200)]);
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.removed],
    ['large', 80, 5],
    `${lifted} lifted`
  );
}
assert.deepStrictEqual(
  [storedIDs(5).length, holdRows.get(5)],
  [140, { reason: 'large', storedCount: 145 }]
);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 140, 200)]]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, heldIDs(5).length, holdRows.get(5)],
  ['large', 39, 41, 39, { reason: 'large', storedCount: 140 }]
);
assert.match(
  warnings()[0]?.message ?? '',
  / 41 of the bans it held came back, and are no longer held\. The rest are kept until fewer than 28 of them are missing\. /
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 39, 0]);
battlemetricsLists.set('bm-5', [
  [...pairs('e', 0, 41), ...pairs('e', 140, 200), ...pairs('n', 1000, 1100)]
]);
await run();
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.stored, result.hold, result.held, result.removed, holdRows.get(5)],
  [240, 'large', 39, 0, { reason: 'large', storedCount: 140 }]
);
assert.match(
  warnings()[0]?.message ?? '',
  / They are kept until fewer than 28 of them are missing\. /
);

// A hold whose list shrank since the read before is measured against the bans it has, before its
// row says so: here 5 other bans of a list of 200 held for 80 are removed at once, so 39 still
// missing of the 195 it then has keep the hold, and 38, as 42 of the 80 come back, end it, posted
// with how few would have kept it.
for (const back of [41, 42]) {
  reset();
  battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  await run();
  const since = new Date(pendingRows.get('5,5,e0').heldAt).toISOString();
  battlemetricsLists.set('bm-5', [pairs('e', 85, 200)]);
  [result] = await run();
  assert.deepStrictEqual(
    [result.removed, holdRows.get(5)],
    [5, { reason: 'large', storedCount: 200 }],
    `${back} back`
  );
  battlemetricsLists.set('bm-5', [[...pairs('e', 0, back), ...pairs('e', 85, 200)]]);
  logs.length = 0;
  [result] = await run();
  if (back === 41)
    assert.deepStrictEqual(
      [result.hold, result.held, holdRows.get(5)],
      ['large', 39, { reason: 'large', storedCount: 195 }]
    );
  else {
    assert.deepStrictEqual([result.hold, result.pending, holdRows.has(5)], [null, 38, false]);
    assert.deepStrictEqual(
      warnings().map(({ message }) => message),
      [
        `Imported ban list (ID: 5): 157 bans fetched, 0 new, 0 updated. Stopped holding the 80 bans it lost at once, held since ${since}, as 42 of them came back, which leaves fewer than 39 missing. The other 38, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
      ]
    );
  }
}

// A list held as it lost all of its bans, here 30, that loses a large part of the bans it saved
// since, here 100 of the 400, holds every missing ban as 'large' from then, measured against the
// 30 it held: the release, why it is held with that count, and the 130 bans, in one transaction.
// Its line says so. Kept as 'full', the 130 would all have been let go as soon as any one of them
// came back. Once the 100 come back, the 30 are still held, as they are at least 25, a large loss
// of 30, and so are the 29 still missing once one of the 30 comes back too, which would have ended
// the 'full' hold. The read 11 minutes on removes none of them.
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
battlemetricsLists.set('bm-5', [pairs('n', 1100, 1400)]);
events.length = 0;
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [
    result.hold,
    result.held,
    result.pending,
    result.removed,
    result.heldAnew,
    heldIDs(5).length,
    holdRows.get(5)
  ],
  ['large', 130, 0, 0, 'full', 130, { reason: 'large', storedCount: 30 }]
);
const fullTakenInTx = writes().find(([type]) => type === 'release held')[2];
assert.deepStrictEqual(inTransaction(fullTakenInTx), [
  'begin',
  'release held',
  'save hold reason',
  'save held',
  'commit'
]);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 130, hold: 'large' }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 5): 300 bans fetched, 0 new, 0 updated. Kept the 130 of its 430 stored bans that it no longer has, as it lost a large part of them at once, which more likely means that its source broke, or leaves them out. It was already held as it lost all of its bans at once, and now holds all of them as a large loss instead: they are kept until fewer than 25 of them are missing, rather than until one of the bans it had then comes back, and any that comes back is no longer held. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.'
  ]
);
battlemetricsLists.set('bm-5', [pairs('n', 1000, 1400)]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, heldIDs(5).sort()],
  ['large', 30, 100, banIDs('e', 0, 30).sort()]
);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 1), ...pairs('n', 1000, 1400)]]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.cameBack], ['large', 29, 1]);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['large', 29, 0, 430]
);

// A list held as it lost all of its bans, here 30, that then loses all of the 35 it has, too few of
// them saved since to be a large loss, holds the 5 it saved since with its 30, from then, as 'full'
// still, and only one of the 30 coming back ends the hold. Here one of the 5 comes back, and none
// of the 30: that ban is no longer held, and loses its record, the hold goes on, and its line says
// so. The read 11 minutes on removes none of them. Once one of the 30 comes back, the hold ends,
// and the other 33 still missing, the 4 it saved since among them, wait for a later complete read,
// which removes them.
const fullSinceOf = () => new Date(pendingRows.get('5,5,e1').heldAt).toISOString();
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1005)]);
await run();
age(5, 60);
battlemetricsLists.set('bm-5', [pairs('x', 2000, 2001)]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.heldSince, heldIDs(5).length, holdRows.get(5)],
  ['full', 35, Date.parse(fullSinceOf()), 35, { reason: 'full', storedCount: 30 }]
);
battlemetricsLists.set('bm-5', [[...pairs('n', 1000, 1001), ...pairs('x', 2000, 2001)]]);
logs.length = 0;
largeImport = new BanImporter();
[result] = await largeImport.importBans();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, heldIDs(5).sort(), pendingRows.has('5,5,n1000')],
  ['full', 34, 0, [...banIDs('e', 0, 30), ...banIDs('n', 1001, 1005)].sort(), false]
);
assert.deepStrictEqual(plainReport(largeImport).banLists.map(holdFields), [
  { held: 34, hold: 'full', cameBack: 1 }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 2 bans fetched, 0 new, 0 updated. Still kept the 34 bans it had when it lost all of its bans at once, held since ${fullSinceOf()}, as none of them has come back, which more likely means that its source broke. 1 ban it held later came back, and is no longer held. If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.removed, storedIDs(5).length],
  ['full', 34, 0, 36]
);
battlemetricsLists.set('bm-5', [
  [...pairs('e', 0, 1), ...pairs('n', 1000, 1001), ...pairs('x', 2000, 2001)]
]);
const fullEndedSince = fullSinceOf();
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.pending, heldIDs(5), pendingIDs(5).length, holdRows.has(5)],
  [null, 33, [], 33, false]
);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 3 bans fetched, 0 new, 0 updated. Stopped holding the 34 bans it had when it lost all of its bans at once, held since ${fullEndedSince}, as 1 of them came back. The other 33, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
age(5, 11);
[result] = await run();
assert.deepStrictEqual([result.removed, storedIDs(5).length], [33, 3]);
// The bans it saved since are held after its own whatever the clock says, as those it began with
// are told by when they were held: here the read that holds the 5 tells a time an hour before the
// read that began the hold, as when the clock went back between them, and they are still held a
// millisecond after the 30, so one of them that comes back does not end the hold.
reset();
const clockAt = Date.now();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1005)]);
await run({ clock: () => clockAt });
battlemetricsLists.set('bm-5', [pairs('x', 2000, 2001)]);
await run({ clock: () => clockAt - 60 * 60 * 1000 });
assert.deepStrictEqual(
  [pendingRows.get('5,5,e0').heldAt, pendingRows.get('5,5,n1000').heldAt],
  [clockAt, clockAt + 1]
);
battlemetricsLists.set('bm-5', [[...pairs('n', 1000, 1001), ...pairs('x', 2000, 2001)]]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.cameBack], ['full', 34, 1]);
// A 'full' hold an earlier importer left is read the same way, which in two cases takes the wrong
// bans as those it began with. One that an importer from before BanListHolds held a batch at a
// time, cut short between batches, whose other bans were held as its list lost all of them again,
// here 500 of its 600 bans held an hour before the other 100, ends only as one of its first 500
// comes back: one of the other 100 that comes back is no longer held, and the line counts it among
// the bans it held later. One whose clock had gone back as it held 5 bans saved since with its 30,
// held an hour before them, ends as one of the 5 comes back, and not as one of the 30 does.
const legacyHold = (groups) => {
  for (const [ids, heldAt] of groups)
    for (const banId of ids)
      pendingRows.set(`5,${banId}`, {
        banList: 5,
        banId,
        firstMissingAt: heldAt,
        lastMissingAt: heldAt,
        heldAt
      });
};
const legacyAt = Date.now() - 2 * 60 * 60 * 1000;
reset();
battlemetricsList(5, pairs('e', 0, 600), [[...pairs('x', 2000, 2005), ...pairs('e', 550, 551)]]);
legacyHold([
  [banIDs('e', 0, 500), legacyAt],
  [banIDs('e', 500, 600), legacyAt + 60 * 60 * 1000]
]);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.held, result.cameBack, result.removed, heldIDs(5).length],
  ['full', 599, 1, 0, 599]
);
assert.match(
  warnings()[0]?.message ?? '',
  / 1 ban it held later came back, and is no longer held\. /
);
battlemetricsLists.set('bm-5', [[...pairs('x', 2000, 2005), ...pairs('e', 0, 1)]]);
[result] = await run();
assert.deepStrictEqual(
  [result.hold, result.holdEnded?.hold, result.pending, heldIDs(5)],
  [null, 'full', 599, []]
);
for (const [cameBack, ends] of [
  [pairs('e', 0, 1), false],
  [pairs('n', 1000, 1001), true]
]) {
  reset();
  battlemetricsList(
    5,
    [...pairs('e', 0, 30), ...pairs('n', 1000, 1005)],
    [[...pairs('x', 2000, 2001), ...cameBack]]
  );
  legacyHold([
    [banIDs('e', 0, 30), legacyAt],
    [banIDs('n', 1000, 1005), legacyAt - 60 * 60 * 1000]
  ]);
  holdRows.set(5, { reason: 'full', storedCount: 30 });
  [result] = await run();
  assert.deepStrictEqual(
    [result.hold, result.held, result.cameBack, result.holdEnded?.hold],
    ends ? [null, 34, 1, 'full'] : ['full', 34, 1, undefined],
    cameBack[0][0]
  );
}

// A read that removes a large part of a list's bans after a confirming read says so in whatever
// line it posts, right after its counts. Here two losses of the list's bans, each too small to be a
// large loss on its own, are removed together, 11 minutes after the second: 30 and 30 of a list of
// 200, while it is held for 80 others as a large loss, and while a hold of them ends as 41 of the
// 80 come back; 80 and 80 of a list of 430, while it is held as it lost all of its 30 bans; and of a
// list whose source was replaced, its old source's 80 of 200. Of a read an admin confirmed, only
// the bans it would have removed without the confirmation count, which its line says.
const twoLosses = async (list, kept) => {
  for (const served of kept) {
    battlemetricsLists.set('bm-5', [served]);
    await run();
  }
  age(list, 11);
  logs.length = 0;
};
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
const manySince = new Date(pendingRows.get('5,5,e0').heldAt - 11 * 60 * 1000).toISOString();
await twoLosses(5, [pairs('e', 110, 200), pairs('e', 140, 200)]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 80, 60]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 60 bans fetched, 0 new, 0 updated, 60 removed. That is a large part of its 200 stored bans, removed as complete reads of it at least 10 minutes apart did not have them. Still kept the 80 bans it lost at once, held since ${manySince}, as losing so many at once more likely means that its source broke, or leaves them out. They are kept until fewer than 40 of them are missing. If the list really lost them, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 80, 200)]);
await run();
const endedManySince = new Date(pendingRows.get('5,5,e0').heldAt - 11 * 60 * 1000).toISOString();
await twoLosses(5, [pairs('e', 110, 200), pairs('e', 140, 200)]);
battlemetricsLists.set('bm-5', [[...pairs('e', 0, 41), ...pairs('e', 140, 200)]]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.removed, result.pending], [null, 60, 39]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 101 bans fetched, 0 new, 0 updated, 60 removed. That is a large part of its 200 stored bans, removed as complete reads of it at least 10 minutes apart did not have them. Stopped holding the 80 bans it lost at once, held since ${endedManySince}, as 41 of them came back, which leaves fewer than 40 missing. The other 39, which it still does not have, are removed once a complete read of it at least 10 minutes from now still does not have them.`
  ]
);
reset();
battlemetricsList(5, pairs('e', 0, 30), [pairs('n', 1000, 1400)]);
await run();
const fullManySince = new Date(pendingRows.get('5,5,e0').heldAt - 11 * 60 * 1000).toISOString();
await twoLosses(5, [pairs('n', 1080, 1400), pairs('n', 1160, 1400)]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['full', 30, 160]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    `Imported ban list (ID: 5): 240 bans fetched, 0 new, 0 updated, 160 removed. That is a large part of its 430 stored bans, removed as complete reads of it at least 10 minutes apart did not have them. Still kept the 30 bans it had when it lost all of its bans at once, held since ${fullManySince}, as none of them has come back, which more likely means that its source broke. If the list really replaced all of its bans, set IMPORTER_ALLOW_MASS_REMOVAL=5 for one run.`
  ]
);
reset();
battlemetricsList(93, pairs('o', 0, 200), [pairs('o', 80, 200)], 'bm-93-new');
syncRows.set(93, {
  banList: 93,
  sourceKey: createHash('sha256')
    .update(JSON.stringify(['battlemetrics', 'bm-93']))
    .digest('hex'),
  state: 'ok'
});
[result] = await run();
assert.deepStrictEqual([result.replace, result.pending], [true, 80]);
age(93, 11);
logs.length = 0;
[result] = await run();
assert.deepStrictEqual([result.replace, result.removed], [true, 80]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Imported ban list (ID: 93): 120 bans fetched, 0 new, 0 updated, 80 removed. That is a large part of its 200 stored bans, removed as complete reads of it at least 10 minutes apart did not have them. Its type or source was changed since it was last imported, so the bans of its old source are being replaced: 80 were removed.'
  ]
);
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 30, 200)]);
await run();
await twoLosses(5, [pairs('e', 60, 200)]);
battlemetricsLists.set('bm-5', [pairs('e', 90, 200)]);
env.IMPORTER_ALLOW_MASS_REMOVAL = '5';
[result] = await run();
assert.deepStrictEqual([result.removed, result.massRemoval], [90, true]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    "Imported ban list (ID: 5): 110 bans fetched, 0 new, 0 updated, 90 removed, as IMPORTER_ALLOW_MASS_REMOVAL names the list. Remove it from the setting once the removal is done. Of them, 60, a large part of its 200 stored bans, would have been removed without an admin's confirmation too, as complete reads of it at least 10 minutes apart did not have them."
  ]
);
delete env.IMPORTER_ALLOW_MASS_REMOVAL;
// So does the line of a hold that begins: here the two losses of 30 of a list of 200 are removed as
// it loses 40 others at once.
reset();
battlemetricsList(5, pairs('e', 0, 200), [pairs('e', 30, 200)]);
await run();
await twoLosses(5, [pairs('e', 60, 200)]);
battlemetricsLists.set('bm-5', [pairs('e', 100, 200)]);
[result] = await run();
assert.deepStrictEqual([result.hold, result.held, result.removed], ['large', 40, 60]);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 5\): 100 bans fetched, 0 new, 0 updated, 60 removed\. That is a large part of its 200 stored bans, removed as complete reads of it at least 10 minutes apart did not have them\. Kept the 40 of its 200 stored bans that it lost at once, /
);

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
    'Failed to import ban list (ID: 17) while fetching page 2, so none of its bans were removed. Error: Request failed with status code 502',
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
battlemetricsList(22, pairs('q', 0, 30), [pairs('q', 0, 10)]);
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
assert.strictEqual(
  logged(1, /^Failed to import ban list \(ID: 23\) while fetching page 1, so none/).length,
  1
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 4 ban lists: 21 bans fetched, 2 new, 1 updated, 1 removed, 23 held, 1 list failed.'
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
battlemetricsList(3, pairs('c', 0, 30), [pairs('c', 0, 10)]);
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
// Its next full read is due 27 minutes after its run planned its reads, 30 less a tenth, as a run
// that is not told how often runs start, as here, schedules it, as once mode's runs every 6 hours
// do, so the next run reads it in full again, however late in this run it was read; a run with a
// shorter cadence schedules it at the list's slot (see the checks of slots below). Read with head
// polls off, its first page is not its newest, so it keeps no newest bans.
const MINUTE = 60 * 1000;
const dueAfterPlan = (saved, plannedAt, minutes) =>
  saved.nextFullScanAt === plannedAt + 0.9 * minutes * MINUTE;
assert.ok(firstRun.plannedAt >= started && firstRun.plannedAt <= imported.lastAttemptAt);
assert.ok(
  dueAfterPlan(imported, firstRun.plannedAt, 30),
  `due ${imported.nextFullScanAt - firstRun.plannedAt}`
);
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
  plainReport(firstRun).banLists.map(({ id, state }) => [id, state]),
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
    'Failed to import ban list (ID: 40) while fetching page 1 of about 1',
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
let counts = plainReport(checked);
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
// second attempt, are posted as for any list, as they are not about its access. The runs tell the
// time by a clock of their own, which each request moves on a second, so the lists' last full reads
// are known: in the last run, list 51 is read first, as list 50 was last read in full after it, at
// its second attempt in the run before.
reset();
battlemetricsList(50, pairs('t', 0, 3), [pairs('t', 0, 1)]);
battlemetricsList(51, [], [pairs('u', 0, 1)]);
const UNLISTED_ERROR =
  'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.';
let unlistedNow = Date.parse('2026-10-23T15:20:00.000Z');
onBattlemetrics = () => {
  unlistedNow += 1000;
};
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
  await new BanImporter({ clock: () => unlistedNow }).importBans();
  const label = `run ${run}`;
  assert.deepStrictEqual(
    battlemetricsRequests,
    {
      1: ['bm-50', 'bm-51'],
      2: ['bm-50', 'bm-51'],
      3: ['bm-50', 'bm-51', 'bm-50'],
      4: ['bm-51', 'bm-50']
    }[run],
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

// Nor does the read of a list CBL cannot read hold any of its bans for an admin, or drop a record of
// one, though what a complete read holds is written before its bans are saved: here a list of 200
// that is not among the BattleMetrics lists CBL can see, whose complete read gives 120 of them, so
// it lost 80 at once, a large loss, and one whose record waits for a confirming read; and the same
// list as one CBL had lost access to, in a run whose access check fails, so it cannot tell whether
// CBL can read it again. Each keeps all of its bans and their records, holds none of them, and its
// entry in the run's record gives no hold.
for (const [label, visible, before] of [
  ['not visible', ['bm-other'], null],
  [
    'unconfirmed',
    new Error('BattleMetrics GET ban-lists failed after 3 attempts: HTTP 503'),
    {
      banList: 56,
      sourceKey: sha256('battlemetrics', 'bm-56'),
      state: 'access_lost',
      lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
      lastSuccessAt: new Date('2026-10-16T06:00:00.000Z'),
      consecutiveFailures: 0,
      lastError: UNLISTED_ERROR,
      storedCount: 200,
      headTotal: 200
    }
  ]
]) {
  reset();
  battlemetricsList(56, pairs('e', 0, 200), [pairs('e', 80, 200)]);
  pendingRows.set('56,56,e100', {
    banList: 56,
    banId: '56,e100',
    firstMissingAt: Date.now() - 60 * 60 * 1000,
    lastMissingAt: Date.now() - 60 * 60 * 1000,
    heldAt: null
  });
  if (before) syncRows.set(56, before);
  visibleBanLists = visible;
  const unreadable = new BanImporter();
  [result] = await unreadable.importBans();
  assert.deepStrictEqual(
    [
      Boolean(result.accessLost),
      result.hold,
      result.held,
      storedIDs(56).length,
      pendingIDs(56),
      heldIDs(56),
      holdRows.has(56)
    ],
    [true, undefined, 0, 200, ['56,e100'], [], false],
    label
  );
  assert.deepStrictEqual(
    plainReport(unreadable).banLists.map((list) => ({ ...holdFields(list), state: list.state })),
    [{ held: 0, state: 'access_lost' }],
    label
  );
}

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
      `^Failed to import ban list \\(ID: 15\\) while fetching page 1 of about 44, so none of its bans were removed\\. ${RegExp.escape(HIDDEN)}$`
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
  const failure =
    /^Failed to import ban list \(ID: 18\) while fetching page 1( of about 1)?, .*Unknown ban list\)$/;
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
  counts = plainReport(checked);
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
  const counts = plainReport(dryRun);
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
    [writing.dryRun, storedIDs(98).length, plainReport(writing).dryRun],
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
assert.deepStrictEqual([plainReport(removedMeanwhile).failedLists, syncRows.has(130)], [0, false]);
assert.match(summary(), /, 0 held, 0 lists failed\.$/);
// So is a list held as it lost a large part of its bans, whose read ended its hold, as 41 of the 80
// came back: its bans went with it, so its record says that none of them is kept, and neither that
// a hold ended nor that any came back.
reset();
battlemetricsList(133, pairs('j', 0, 200), [pairs('j', 80, 200)]);
await run();
battlemetricsLists.set('bm-133', [[...pairs('j', 0, 41), ...pairs('j', 80, 200)]]);
BanList.findByPk = async (id, options) => {
  const list = await readBeforeRemoval(id, options);
  if (options?.attributes?.includes('source')) {
    banLists.delete(id);
    for (const banID of storedIDs(id)) bans.delete(banID);
  }
  return list;
};
const heldRemovedMeanwhile = new BanImporter();
results = await heldRemovedMeanwhile.importBans();
BanList.findByPk = readBeforeRemoval;
assert.deepStrictEqual(
  [results[0].gone, results[0].error, results[0].held, results[0].pending],
  [true, undefined, 0, 0]
);
assert.deepStrictEqual(
  plainReport(heldRemovedMeanwhile).banLists.map(({ id, gone, ...rest }) => [
    id,
    gone,
    holdFields(rest)
  ]),
  [[133, true, { held: 0 }]]
);
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

// A list that fails on one of its pages says which, and of about how many pages a read of all of
// it takes, by BattleMetrics' count of its bans on its first page: here 950 bans, so about 10
// pages, of which the third fails at both attempts, as in production a page of a large list timed
// out at every attempt. Before its first page is read, the count at its last read, which its row
// keeps, says how many: here 9,217 bans, so about 93 pages. The run record keeps the page too. A
// list whose count is not known, or already passed, says only the page (see above), and a list that
// failed otherwise, e.g. while its bans were saved, only what it was doing, as before.
reset();
battlemetricsList(160, pairs('w', 0, 8), [
  pairs('w', 0, 2),
  pairs('w', 2, 4),
  httpError(504),
  pairs('w', 4, 8)
]);
battlemetricsTotals.set('bm-160', 950);
battlemetricsList(161, pairs('x', 0, 2), [httpError(504)]);
syncRows.set(161, {
  ...failedTwice(161, IMPORTED_AT),
  state: 'ok',
  consecutiveFailures: 0,
  lastError: null,
  lastFullScanAt: IMPORTED_AT,
  headTotal: 9217
});
battlemetricsList(162, pairs('y', 0, 2), [pairs('y', 0, 2)]);
const pageFailures = new BanImporter();
await pageFailures.importBans();
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Failed to import ban list (ID: 160) while fetching page 3 of about 10, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 161) while fetching page 1 of about 93, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 160) again while fetching page 3 of about 10, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 161) again while fetching page 1 of about 93, so none of its bans were removed. Error: Request failed with status code 504'
  ]
);
assert.deepStrictEqual(
  plainReport(pageFailures).banLists.map(({ id, stage, page }) => [
    id,
    stage ?? null,
    page ?? null
  ]),
  [
    [160, 'fetching it', 3],
    [162, null, null],
    [161, 'fetching it', 1]
  ]
);
// The rows keep the error alone, as before.
assert.deepStrictEqual(
  [row(160).lastError, row(161).lastError],
  ['Error: Request failed with status code 504', 'Error: Request failed with status code 504']
);
// A list whose type or source was changed since its row was saved says only the page, until its
// new source's first page gives BattleMetrics' count, as its row's counts are its old source's:
// here 11,780 bans, which would make about 118 pages. So does a list whose old source's bans are
// still being replaced, as the bans it has here are then still its old source's: here its row,
// saved for its new source, whose first read failed, counts only the 9,217 bans it has.
reset();
battlemetricsList(163, pairs('z', 0, 2), [httpError(504)], 'bm-163-new');
syncRows.set(163, {
  ...failedTwice(163, IMPORTED_AT),
  state: 'ok',
  consecutiveFailures: 0,
  lastError: null,
  lastFullScanAt: IMPORTED_AT,
  storedCount: 11780,
  headTotal: 11780
});
battlemetricsList(164, pairs('q', 0, 2), [httpError(504)]);
syncRows.set(164, {
  ...failedTwice(164, IMPORTED_AT),
  state: 'ok',
  consecutiveFailures: 0,
  lastError: null,
  replacePending: true,
  storedCount: 9217,
  headTotal: null
});
battlemetricsList(165, pairs('r', 0, 2), [pairs('r', 0, 2)]);
await run();
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Failed to import ban list (ID: 163) while fetching page 1, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 164) while fetching page 1, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 163) again while fetching page 1, so none of its bans were removed. Error: Request failed with status code 504',
    'Failed to import ban list (ID: 164) again while fetching page 1, so none of its bans were removed. Error: Request failed with status code 504'
  ]
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
// Whether every request a run made asked for the lists' expired bans too, as each must: the pages
// BattleMetrics' links led to, whose links here leave the filter out, as well as the first.
const askedForExpired = () =>
  battlemetricsParams.length > 0 &&
  battlemetricsParams.every((params) => params['filter[expired]'] === 'true');
// One run, with what it logged, did and asked for alone, its report for the run record, and when it
// planned its reads. A run that stops gives the error it stopped with (stopped) instead of its
// results. An importer loaded on its own (Importer, see loadImporter) runs with its own run control.
// settings are the run's, as the run gives its steps, e.g. how often runs start.
async function pollRun(options, Importer = BanImporter, settings = {}) {
  for (const list of [logs, events, battlemetricsRequests, battlemetricsParams, delays])
    list.length = 0;
  const importer = new Importer(options);
  const ran = await importer.importBans(settings).catch((err) => {
    if (err?.name !== 'RunStopped') throw err;
    return err;
  });
  return {
    results: Array.isArray(ran) ? ran : null,
    stopped: Array.isArray(ran) ? null : ran,
    report: plainReport(importer),
    plannedAt: importer.plannedAt
  };
}
const readsOf = (polled) =>
  polled.report.banLists.map(({ id, read, reason }) => [id, read, reason ?? null]);

// A new list is read in full, newest first, as a poll needs its newest page to start from. Its row
// keeps the IDs of the bans on that page, all of them, with or without a SteamID, and
// BattleMetrics' count, and the list is due its next full read 27 minutes after its run planned its
// reads, as the run is not told how often runs start.
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
  'filter[expired]': 'true',
  sort: '-timestamp',
  'page[size]': 100
});
assert.ok(askedForExpired());
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
assert.ok(dueAfterPlan(firstRead, polled.plannedAt, 30));

// The next run, within 30 minutes, is not due to read them in full, so it only polls them: one
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
// its newest page was read. List 91, read in full by its poll, is due again 27 minutes after the run
// planned its reads.
assert.deepStrictEqual(
  [row(90).lastFullScanAt, row(90).nextFullScanAt, row(90).headTotal],
  [firstRead.lastFullScanAt, firstRead.nextFullScanAt, 23]
);
assert.ok(row(90).lastHeadPollAt >= firstRead.lastHeadPollAt);
assert.strictEqual(row(90).lastHeadPollAt, row(90).lastAttemptAt);
assert.strictEqual(row(91).lastFullScanAt, row(91).lastAttemptAt);
assert.ok(dueAfterPlan(row(91), polled.plannedAt, 30));

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
assert.ok(askedForExpired());
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
assert.ok(dueAfterPlan(row(90), polled.plannedAt, 30));
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
assert.ok(askedForExpired());
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
// the last page the poll read. The poll saves none of the new bans: the read in full saves them all
// once it has read the rest of the list, and none of the list's bans are removed, as none are gone.
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
assert.deepStrictEqual(writtenAfter, [[60, 18]]);
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
// A poll removes none of them, so the bans it kept are still counted as held and pending, as the run
// found them at its start: on a run that only polls the list, its counts, and the run's, stay as
// the read that kept them gave them, rather than dropping to 0.
assert.deepStrictEqual(polled.report.banLists, [
  {
    id: 92,
    fetched: 5,
    new: 0,
    updated: 0,
    removed: 0,
    held: 12,
    read: 'head',
    pending: 12,
    state: 'held'
  }
]);
assert.deepStrictEqual([polled.report.held, polled.report.pending], [12, 12]);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 5 bans fetched, 0 new, 0 updated, 0 removed, 12 held, 0 lists failed.'
);
assert.strictEqual(
  logged(2, /^Polled ban list \(ID: 92\): 5 bans fetched, 0 new, 0 updated, 12 held\.$/).length,
  1
);
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
assert.ok(dueAfterPlan(row(92), polled.plannedAt, 5));
delete env.IMPORTER_FULL_SCAN_MINUTES;

// A poll that finds drift, when the list then cannot be read in full, leaves the list due a full
// read at once, for that reason, so the next run reads it in full. The poll's own new ban waits for
// that read, as a read in full saves the bans it finds, and the list's row keeps the newest page
// and count of its last read, which that read is measured against. The second attempt in the run
// reads the list in full from its first page, without polling it again.
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
assert.deepStrictEqual(JSON.parse(row(93).headUids), ['k0', 'k1', 'k2', 'k3', 'k4']);
assert.deepStrictEqual(
  [writes(), storedIDs(93).includes('93,kn1'), storedIDs(93).includes('93,k12')],
  [[], false, true]
);
serve(93, unreadable);
battlemetricsTotals.delete('bm-93');
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [94, 'head', null],
  [93, 'full', 'drift']
]);
assert.deepStrictEqual(
  [written(), removedIDs(), row(93).state, row(93).scanReason],
  [['93,kn1'], ['93,k12'], 'ok', 'periodic']
);
assert.deepStrictEqual(JSON.parse(row(93).headUids), ['kn1', 'k0', 'k1', 'k2', 'k3']);

// IMPORTER_HEAD_POLL=0 reads every list in full on every run, in the order BattleMetrics gives its
// bans, as before head polls, and their rows forget their newest pages, the one read in full longest
// ago first: list 94, which was only polled since, here a minute before list 93's last full read.
// Turned on again, each list is read in full once more, as it has no newest page to compare.
env.IMPORTER_HEAD_POLL = '0';
syncRows.get(94).lastFullScanAt = new Date(row(93).lastFullScanAt - MINUTE);
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [94, 'full', 'every_run'],
  [93, 'full', 'every_run']
]);
assert.deepStrictEqual(battlemetricsParams[0], {
  'filter[banList]': 'bm-94',
  'filter[expired]': 'true',
  'page[size]': 100
});
assert.ok(askedForExpired());
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
// The importer service imports with the same importer every cycle, which posts the warnings on its
// first import only, and prints them in the console on the later ones, rather than posting them
// every few minutes.
{
  env.IMPORTER_DRIFT = 'sometimes';
  const service = new BanImporter();
  delete env.IMPORTER_DRIFT;
  const warning =
    'Warning: IMPORTER_DRIFT must be 1 or 0, not "sometimes", so head polls still compare BattleMetrics\' counts.';
  const levels = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    logs.length = 0;
    await service.importBans();
    levels.push(...logs.filter((log) => log.message === warning).map(({ level }) => level));
  }
  assert.deepStrictEqual(levels, [1, 2, 2]);
}
// An import that fails before it imports any list, e.g. as the lists' rows cannot be read, reports
// nothing, rather than what the same importer's last import did: in loop mode the importer service
// imports with one importer every cycle, and a failed cycle's record would otherwise count the
// last cycle's bans again.
{
  reset();
  battlemetricsList(90, [], [pairs('r', 0, 3)]);
  const cycles = new BanImporter();
  await cycles.importBans();
  const last = plainReport(cycles);
  assert.deepStrictEqual(
    [last.lists, last.imported, last.new, last.banLists.length, last.requests.full],
    [1, 1, 3, 1, 1]
  );
  const findAll = BanListSync.findAll;
  BanListSync.findAll = async () => {
    throw new Error("Table 'cbl.BanListSyncs' doesn't exist");
  };
  await assert.rejects(cycles.importBans(), /BanListSyncs/);
  BanListSync.findAll = findAll;
  assert.deepStrictEqual(plainReport(cycles), {
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
// Its bans are still counted as held, as the run found them at its start, and none as pending, as
// they wait for an admin rather than for a read.
assert.deepStrictEqual(
  [polled.report.held, polled.report.pending, polled.report.banLists[0]],
  [
    12,
    0,
    { id: 95, fetched: 5, new: 0, updated: 0, removed: 0, held: 12, read: 'head', state: 'held' }
  ]
);

// A list whose source now gives none of its old bans, only more new ones than a poll follows, is
// read in full for overflow, and held for an admin, as any read in full of it would be: the poll
// saves none of the new bans, so what the list lost is measured against the bans it had before the
// run, which were all of them. None is removed, and the hold is posted. A dry run finds the same.
// Here the list's 30 bans are replaced by 60, of which a poll follows 50, 5 to a page.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(130, [], paged(pairs('o', 0, 30)));
await pollRun();
serve(130, pairs('w', 0, 60));
const replaced = {
  id: 130,
  fetched: 60,
  new: 60,
  updated: 0,
  removed: 0,
  held: 30,
  read: 'full',
  reason: 'overflow',
  stored: 30,
  hold: 'full',
  state: 'held'
};
env.IMPORTER_DRY_RUN = '1';
polled = await pollRun();
delete env.IMPORTER_DRY_RUN;
assert.deepStrictEqual([polled.report.banLists, writes()], [[replaced], []]);
polled = await pollRun();
assert.deepStrictEqual(polled.report.banLists, [replaced]);
assert.deepStrictEqual(polled.report.requests, { head: 1, follow: 9, full: 2 });
assert.deepStrictEqual(
  [removedIDs(), heldIDs(130).length, storedIDs(130).length, row(130).state],
  [[], 30, 90, 'held']
);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 130\): 60 bans fetched, 60 new, 0 updated\. Kept all 30 of its stored bans, as it no longer has any of them/
);

// So is such a list when the read in full that overflow calls for fails, here as BattleMetrics
// fails a page further down: the poll saved none of the new bans, so the list's next read in full,
// whether the run's second attempt at it (list 131) or the next run (list 132), still measures what
// the list lost against the bans it had before.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(131, [], paged(pairs('o', 0, 30)));
battlemetricsList(132, [], paged(pairs('p', 0, 30)));
// The other list keeps the second attempts going.
battlemetricsList(133, [], paged(pairs('l', 0, 3)));
await pollRun();
serve(131, pairs('v', 0, 60));
serve(132, pairs('u', 0, 60));
const lastPage = battlemetricsLists.get('bm-131')[11];
battlemetricsLists.get('bm-131')[11] = failsOnce(lastPage);
battlemetricsLists.get('bm-132')[11] = httpError(503);
battlemetricsTotals.set('bm-132', 60);
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [131, 'full', 'overflow'],
  [132, 'full', 'overflow'],
  [133, 'head', null]
]);
assert.deepStrictEqual(
  [
    polled.results[0].attempt,
    polled.results[0].stored,
    polled.results[0].hold,
    heldIDs(131).length
  ],
  [2, 30, 'full', 30]
);
assert.deepStrictEqual(
  [polled.results[1].error, storedIDs(132).length, row(132).scanReason, removedIDs()],
  ['Error: Request failed with status code 503', 30, 'overflow', []]
);
serve(132, pairs('u', 0, 60));
battlemetricsTotals.delete('bm-132');
polled = await pollRun();
assert.deepStrictEqual(
  polled.report.banLists.find(({ id }) => id === 132),
  { ...replaced, id: 132 }
);
assert.deepStrictEqual([removedIDs(), heldIDs(132).length], [[], 30]);

// What a list read in full for drift lost is measured against the bans it had before the run too:
// here 10 of its 200 bans, which wait for a confirming read, as they are not fewer than 10 and 5%
// of 200. Measured against 201, with the new ban on top the poll found, they would have been
// removed at once.
reset();
delete env.IMPORTER_HEAD_POLL;
let drifting = pairs('y', 0, 200);
battlemetricsList(134, [], paged(drifting));
await pollRun();
drifting = [['yn1', steamID(401)], ...drifting.filter((_, n) => n < 100 || n >= 110)];
serve(134, drifting);
polled = await pollRun();
assert.deepStrictEqual(polled.report.banLists, [
  {
    id: 134,
    fetched: 191,
    new: 1,
    updated: 0,
    removed: 0,
    held: 10,
    read: 'full',
    reason: 'drift',
    drift: { total: 191, expected: 201 },
    stored: 200,
    pending: 10,
    state: 'held'
  }
]);
assert.deepStrictEqual([written(), removedIDs(), pendingIDs(134).length], [['134,yn1'], [], 10]);

// A source that starts leaving out bans throughout the list, as BattleMetrics would its expired
// bans, here 2 of every 5, drops its count with them: a poll finds the drift, and the list is read
// in full, completely, as the count dropped too. The 80 of its 200 bans it lost at once are held for
// an admin, and the hold is posted. Polls after it remove nothing and post nothing, and count them
// as held. Named in IMPORTER_ALLOW_MASS_REMOVAL, the list is read in full on the next run, for the
// removal, which removes them, with their records and why they were held.
reset();
delete env.IMPORTER_HEAD_POLL;
let hiding = pairs('v', 0, 200);
battlemetricsList(136, [], paged(hiding));
await pollRun();
hiding = hiding.filter((_, n) => n % 5 >= 2);
serve(136, hiding);
polled = await pollRun();
assert.deepStrictEqual(polled.report.banLists, [
  {
    id: 136,
    fetched: 120,
    new: 0,
    updated: 0,
    removed: 0,
    held: 80,
    read: 'full',
    reason: 'drift',
    drift: { total: 120, expected: 200 },
    stored: 200,
    hold: 'large',
    state: 'held'
  }
]);
assert.deepStrictEqual(
  [removedIDs(), heldIDs(136).length, holdReason(136), row(136).state],
  [[], 80, 'large', 'held']
);
assert.match(
  warnings()[0]?.message ?? '',
  /^Imported ban list \(ID: 136\): 120 bans fetched, 0 new, 0 updated\. Kept the 80 of its 200 stored bans that it lost at once, /
);
polled = await pollRun();
assert.deepStrictEqual(
  [polled.report.banLists, removedIDs(), warnings()],
  [
    [
      { id: 136, fetched: 5, new: 0, updated: 0, removed: 0, held: 80, read: 'head', state: 'held' }
    ],
    [],
    []
  ]
);
env.IMPORTER_ALLOW_MASS_REMOVAL = '136';
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [[136, 'full', 'removal']]);
assert.deepStrictEqual(
  [removedIDs().length, polled.report.banLists[0].massRemoval, heldIDs(136), holdRows.has(136)],
  [80, true, [], false]
);
assert.deepStrictEqual([storedIDs(136).length, row(136).state], [120, 'ok']);

// With runs less than IMPORTER_FULL_SCAN_MINUTES apart, as the importer service's cycles every 10
// minutes, a list's next periodic read falls at its slot, wherever in its cycle it was read: a list
// read 8 minutes into the cycle that started at its slot is due when its slot comes round again, so
// the cycle 20 minutes after that one only polls it, and the cycle 30 minutes after it reads it in
// full, as it would a list read at the cycle's start. The list is the only one, so its slot is the
// middle of each 30 minutes, 15 minutes in. The runs here tell the time by a clock of their own.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(135, [], paged(pairs('t', 0, 12)));
const SLOT_135 = Date.parse('2026-10-23T13:45:00.000Z');
let lateNow = SLOT_135;
const lateClock = { clock: () => lateNow };
const everyTenMinutes = { cadenceSeconds: 600 };
const lateRun = new BanImporter(lateClock);
const newestPage = battlemetricsLists.get('bm-135')[0];
battlemetricsLists.get('bm-135')[0] = Object.assign(
  () => {
    lateNow += 8 * MINUTE;
    return newestPage;
  },
  { entries: newestPage }
);
await lateRun.importBans(everyTenMinutes);
serve(135, pairs('t', 0, 12));
assert.deepStrictEqual(
  [Object.fromEntries(lateRun.slots), lateRun.plannedAt, lateRun.cadenceSeconds],
  [{ 135: 15 * MINUTE }, SLOT_135, 600]
);
const lateRead = row(135);
assert.deepStrictEqual(
  [lateRead.lastFullScanAt, lateRead.nextFullScanAt, lateRead.scanReason],
  [SLOT_135 + 8 * MINUTE, SLOT_135 + 30 * MINUTE, 'periodic']
);
lateNow = SLOT_135 + 20 * MINUTE;
polled = await pollRun(lateClock, BanImporter, everyTenMinutes);
assert.deepStrictEqual(readsOf(polled), [[135, 'head', null]]);
lateNow = SLOT_135 + 30 * MINUTE;
polled = await pollRun(lateClock, BanImporter, everyTenMinutes);
assert.deepStrictEqual(readsOf(polled), [[135, 'full', 'periodic']]);
assert.strictEqual(row(135).nextFullScanAt, SLOT_135 + 60 * MINUTE);

// Each BattleMetrics list the run reads has a slot, from the lists' rows as the run finds them: in
// the order of their IDs, the lists share the 30 minutes by their pages, from BattleMetrics' count
// of each list's bans at its last read, and a list without a row takes one page. A remote list,
// whose file is asked about on every run, and a list that imports one of CBL's own export ban lists,
// which is never read, have none. With the run's cadence of 10 minutes, a list read in full is next
// due at its slot in the 30 minutes up to 35 minutes after its read. Here BattleMetrics counts
// 4,200 and 1,800 bans on the lists, which it gives a few of, with the count check off.
reset();
delete env.IMPORTER_HEAD_POLL;
env.IMPORTER_SCAN_COUNT_CHECK = '0';
let slotNow = Date.parse('2026-10-23T14:02:00.000Z');
const slotClock = { clock: () => slotNow };
battlemetricsList(150, [], paged(pairs('u', 0, 12)));
battlemetricsTotals.set('bm-150', 4200);
battlemetricsList(151, [], paged(pairs('v', 0, 12)));
battlemetricsTotals.set('bm-151', 1800);
remoteList(152, [1], `${steamID(1)}:0 //Cheating`);
battlemetricsList(153, [], paged(pairs('z', 0, 2)), 'c0ffee00-cb1e-4a00-b000-0000000000ff');
exportBanLists.push({ id: 7, battlemetricsID: 'c0ffee00-cb1e-4a00-b000-0000000000ff' });
const slotRun = async () => {
  const importer = new BanImporter(slotClock);
  await importer.importBans(everyTenMinutes);
  return importer;
};
let slotted = await slotRun();
// Neither list has a row yet, so they share the interval equally, and each new list is due at its
// slot: list 150 7.5 minutes into each half hour, and list 151 22.5 minutes in.
assert.deepStrictEqual(Object.fromEntries(slotted.slots), {
  150: 7.5 * MINUTE,
  151: 22.5 * MINUTE
});
assert.deepStrictEqual(
  [row(150).nextFullScanAt, row(151).nextFullScanAt, row(150).headTotal, row(151).headTotal],
  [Date.parse('2026-10-23T14:07:30.000Z'), Date.parse('2026-10-23T14:22:30.000Z'), 4200, 1800]
);
// The next cycle, 10 minutes later, gives them slots by their pages, 42 and 18, and reads list 150
// in full, as its slot has come, and polls list 151. List 150 is then due at its new slot, the one
// that comes at least 5 minutes after its read: 10.5 minutes into the half hour from 14:30.
slotNow = Date.parse('2026-10-23T14:12:00.000Z');
slotted = await slotRun();
assert.deepStrictEqual(Object.fromEntries(slotted.slots), {
  150: 10.5 * MINUTE,
  151: 25.5 * MINUTE
});
assert.deepStrictEqual(
  plainReport(slotted).banLists.map(({ id, read, reason }) => [id, read, reason ?? null]),
  [
    [151, 'head', null],
    [153, undefined, null],
    [150, 'full', 'periodic'],
    [152, 'full', 'remote']
  ]
);
assert.strictEqual(row(150).nextFullScanAt, Date.parse('2026-10-23T14:40:30.000Z'));
// A list whose last full read is 35 minutes old, as long as a list may wait for its slot at this
// cadence, is read in full whatever its row says, while one read 34 minutes ago is only polled.
for (const [minutes, read] of [
  [34, 'head'],
  [35, 'full']
]) {
  Object.assign(syncRows.get(151), {
    lastFullScanAt: new Date(slotNow - minutes * MINUTE),
    nextFullScanAt: new Date(slotNow + 60 * MINUTE)
  });
  slotted = await slotRun();
  assert.deepStrictEqual(
    plainReport(slotted)
      .banLists.filter(({ id }) => id === 151)
      .map((list) => list.read),
    [read],
    String(minutes)
  );
}
delete env.IMPORTER_SCAN_COUNT_CHECK;

// Cycles of the importer service, run with the same importer, as the service runs them: a cycle
// every 10 minutes, with a clock that each BattleMetrics request moves on 0.9 seconds and the
// cycle's other steps 45 seconds. Six lists, of 942 to 9,217 bans by BattleMetrics' counts, are all
// new, so the first cycle reads them all in full. Once an interval has passed after it, no cycle
// reads more than half of their pages, rather than every list in every third cycle and none in
// between, and once two have, each list is read in full once in each half hour, at its slot. No
// list waits more than 1.5 intervals for its next full read.
reset();
delete env.IMPORTER_HEAD_POLL;
env.IMPORTER_SCAN_COUNT_CHECK = '0';
const SIZES = [9217, 7647, 3795, 2352, 1234, 942];
const LISTS = SIZES.map((bans, index) => ({ id: 170 + index, bans, pages: Math.ceil(bans / 100) }));
for (const { id, bans } of LISTS) {
  battlemetricsList(id, [], paged(pairs(`c${id}x`, 0, 10)));
  battlemetricsTotals.set(`bm-${id}`, bans);
}
const ALL_PAGES = LISTS.reduce((sum, { pages }) => sum + pages, 0);
let cycleNow = Date.parse('2026-10-23T13:39:35.889Z');
onBattlemetrics = () => {
  cycleNow += 900;
};
const service = new BanImporter({ clock: () => cycleNow });
const serviceCycles = [];
for (let number = 1; number <= 18; number++) {
  const start = cycleNow;
  await service.importBans(everyTenMinutes);
  const reads = plainReport(service).banLists.filter(({ read }) => read === 'full');
  serviceCycles.push({
    number,
    start,
    end: cycleNow + 45 * 1000,
    reads: reads.map(({ id }) => id),
    pages: reads.reduce((sum, { id }) => sum + LISTS.find((list) => list.id === id).pages, 0)
  });
  // Each list read in full is next due at its slot, as the cycle gave it.
  for (const id of serviceCycles.at(-1).reads)
    assert.strictEqual(
      (((row(id).nextFullScanAt - service.slots.get(id)) % (30 * MINUTE)) + 30 * MINUTE) %
        (30 * MINUTE),
      0,
      `cycle ${number}, list ${id}`
    );
  cycleNow = Math.max(start + 10 * MINUTE, cycleNow + 45 * 1000);
}
assert.deepStrictEqual(
  [serviceCycles[0].reads.length, serviceCycles[0].pages],
  [LISTS.length, ALL_PAGES]
);
const settledCycles = (intervals) =>
  serviceCycles.filter(({ start }) => start >= serviceCycles[0].end + intervals * 30 * MINUTE);
assert.ok(settledCycles(1).length >= 12);
for (const cycle of settledCycles(1))
  assert.ok(cycle.pages <= ALL_PAGES / 2, JSON.stringify(cycle));
// Once two intervals have passed, the lists settle at their slots, which the counts of their bans
// gave them in the second cycle, so each three cycles in a row read every list once.
const steadyCycles = settledCycles(2);
for (const [index, cycle] of steadyCycles.slice(0, -2).entries()) {
  const interval = steadyCycles.slice(index, index + 3);
  assert.deepStrictEqual(
    interval.flatMap(({ reads }) => reads).sort((a, b) => a - b),
    LISTS.map(({ id }) => id),
    `the half hour from cycle ${cycle.number}`
  );
}
for (const { id } of LISTS) {
  const readIn = serviceCycles.filter(({ reads }) => reads.includes(id));
  for (const [index, cycle] of readIn.slice(1).entries())
    assert.ok(cycle.start - readIn[index].start <= 45 * MINUTE, `list ${id}`);
}
delete env.IMPORTER_SCAN_COUNT_CHECK;
onBattlemetrics = null;

// With runs an interval apart or more, as every 30 minutes with IMPORTER_FULL_SCAN_MINUTES=30, or
// every hour with 60, whether the run is told a cadence of an hour or of 6 hours, a list's next
// periodic read is counted from when its run planned its reads, less a tenth of the interval, not
// from its read, so a list read well into a run is due by the next run, which reads it in full,
// also when it plans its reads a few seconds sooner after its start than the run before. Counted
// from its read, it would only be polled then, and read in full every other run. A run started by
// hand two thirds of an interval after one only polls it.
for (const [cadenceSeconds, minutes] of [
  [1800, 30],
  [3600, 60],
  [21600, 60]
]) {
  reset();
  delete env.IMPORTER_HEAD_POLL;
  env.IMPORTER_FULL_SCAN_MINUTES = String(minutes);
  const label = `cadence ${cadenceSeconds}, ${minutes} minutes`;
  const interval = minutes * MINUTE;
  battlemetricsList(180, [], paged(pairs('o', 0, 12)));
  const START_180 = Date.parse('2026-10-23T13:00:02.000Z');
  let onTimeNow = START_180;
  const onTime = { clock: () => onTimeNow };
  const settings = { cadenceSeconds };
  const newest180 = battlemetricsLists.get('bm-180')[0];
  battlemetricsLists.get('bm-180')[0] = Object.assign(
    () => {
      onTimeNow += 0.45 * interval;
      return newest180;
    },
    { entries: newest180 }
  );
  await pollRun(onTime, BanImporter, settings);
  serve(180, pairs('o', 0, 12));
  assert.deepStrictEqual(
    [row(180).lastFullScanAt, row(180).nextFullScanAt, row(180).scanReason],
    [START_180 + 0.45 * interval, START_180 + 0.9 * interval, 'periodic'],
    label
  );
  onTimeNow = START_180 + (2 / 3) * interval;
  polled = await pollRun(onTime, BanImporter, settings);
  assert.deepStrictEqual(readsOf(polled), [[180, 'head', null]], label);
  onTimeNow = START_180 + interval - 2000;
  polled = await pollRun(onTime, BanImporter, settings);
  assert.deepStrictEqual(readsOf(polled), [[180, 'full', 'periodic']], label);
}

// In loop mode, the run's settings also say how often cycles start (cycleSeconds), which the import
// plans its full reads by, whatever IMPORTER_CADENCE_SECONDS gives the cadence: a cadence of an hour
// left over from the hourly script, with cycles every 10 minutes, still gives each list its slot.
// Here the only list's slot is the middle of each 30 minutes, 15 minutes in, so the list read in
// full at 13:46 is next due at 14:15, as it is with a cadence of 10 minutes, rather than 27 minutes
// after the cycle planned its reads.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(181, [], paged(pairs('q', 0, 12)));
let loopNow = Date.parse('2026-10-23T13:46:00.000Z');
const leftOver = new BanImporter({ clock: () => loopNow });
await leftOver.importBans({ cadenceSeconds: 3600, cycleSeconds: 600 });
assert.deepStrictEqual(
  [leftOver.cadenceSeconds, Object.fromEntries(leftOver.slots), row(181).nextFullScanAt],
  [600, { 181: 15 * MINUTE }, Date.parse('2026-10-23T14:15:00.000Z')]
);
loopNow = Date.parse('2026-10-23T13:46:00.000Z');
syncRows.delete(181);
await new BanImporter({ clock: () => loopNow }).importBans({ cadenceSeconds: 3600 });
assert.strictEqual(row(181).nextFullScanAt, Date.parse('2026-10-23T14:13:00.000Z'));

// The lists due a periodic full read are read the one read in full longest ago first, whatever
// their IDs, so when a cycle stops at its time limit before it has read them all, the next starts
// with the lists it left.
reset();
delete env.IMPORTER_HEAD_POLL;
for (const id of [182, 183, 184]) battlemetricsList(id, [], paged(pairs(`w${id}-`, 0, 3)));
await pollRun();
for (const [id, minutes] of [
  [182, 31],
  [183, 50],
  [184, 40]
])
  Object.assign(syncRows.get(id), {
    lastFullScanAt: new Date(Date.now() - minutes * MINUTE),
    nextFullScanAt: new Date(Date.now() - MINUTE)
  });
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [
  [183, 'full', 'periodic'],
  [184, 'full', 'periodic'],
  [182, 'full', 'periodic']
]);

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

// A list given a new type or source while a poll saves the new bans it found, with its bans deleted
// in the same transaction, as /banlist update does, has the bans the poll fetched removed once they
// are saved, with their players queued for an update, as a read in full removes them. The change
// is made here just before the poll writes, as when MySQL makes the poll's batch wait for the
// bot's transaction and then saves it. Nothing else of the list is swept, and its row keeps the old
// source's key and newest page, so the next run reads the new source in full, with none of the old
// source's bans left to hold, or to wait for a confirming read.
for (const change of [{ type: 'remote' }, { source: 'bm-138-new' }]) {
  reset();
  delete env.IMPORTER_HEAD_POLL;
  const label = JSON.stringify(change);
  battlemetricsList(138, [], paged(pairs('w', 0, 12)));
  await pollRun();
  const rowBefore = row(138);
  const newOnTop = [
    ['wn0', steamID(300)],
    ['wn1', steamID(301)]
  ];
  serve(138, [...newOnTop, ...pairs('w', 0, 12)]);
  for (const n of [0, 5, 300]) steamUsers.set(steamID(n), user(steamID(n)));
  onWrite = (ids) => {
    if (!ids.includes('138,wn0')) return;
    for (const banID of storedIDs(138)) bans.delete(banID);
    banLists.set(138, { ...banLists.get(138), ...change });
  };
  polled = await pollRun();
  onWrite = null;
  // The 2 new bans the poll saved after the change are removed, with the 3 others on its page,
  // which the change deleted.
  assert.deepStrictEqual(storedIDs(138), [], label);
  assert.deepStrictEqual(written(), ['138,wn0', '138,wn1'], label);
  assert.deepStrictEqual(removedIDs(), ['138,wn0', '138,wn1', '138,w0', '138,w1', '138,w2'], label);
  assert.deepStrictEqual(
    inTransaction(events.find(([type]) => type === 'remove')[2]),
    ['begin', 'flags', 'remove', 'clear pending', 'commit'],
    label
  );
  // The list is read again after the poll's bans are saved, and before any is removed.
  assert.deepStrictEqual(
    events
      .filter(([type]) => ['read list', 'write', 'remove'].includes(type))
      .map(([type]) => type),
    ['read list', 'write', 'read list', 'remove'],
    label
  );
  // The players of the bans fetched are queued, and no other: the player of an old ban below the
  // newest page, deleted with the change, is not.
  for (const n of [0, 300])
    assert.strictEqual(steamUsers.get(steamID(n)).lastRefreshedInfo, null, `${label}: ${n}`);
  assert.strictEqual(steamUsers.get(steamID(5)).lastRefreshedInfo, FRESH, label);
  assert.deepStrictEqual(
    polled.report.banLists,
    [
      {
        id: 138,
        fetched: 5,
        new: 2,
        updated: 0,
        removed: 2,
        held: 0,
        read: 'head',
        sourceChanged: true
      }
    ],
    label
  );
  assert.deepStrictEqual(
    warnings().map(({ message, important }) => [message, important]),
    [
      [
        'Removed the bans fetched for ban list (ID: 138), as its type or source was changed while it was imported (5 bans fetched, 2 new, 0 updated, 2 removed). Its new source is imported on the next run.',
        true
      ]
    ],
    label
  );
  // The row is saved as the poll found the list, under its old source.
  assert.deepStrictEqual(
    [row(138).sourceKey, row(138).headUids, row(138).headTotal, row(138).state],
    [rowBefore.sourceKey, rowBefore.headUids, rowBefore.headTotal, 'ok'],
    label
  );
}
// The next run reads the new source in full, as it is a new source, and has no bans of the old
// one to remove, hold or wait for.
battlemetricsLists.set('bm-138-new', paged(pairs('v', 0, 3)));
polled = await pollRun();
assert.deepStrictEqual(readsOf(polled), [[138, 'full', 'source']]);
assert.deepStrictEqual(
  [storedIDs(138), removedIDs(), pendingIDs(138)],
  [pairs('v', 0, 3).map(([uid]) => `138,${uid}`), [], []]
);
assert.deepStrictEqual(
  [row(138).sourceKey, Boolean(row(138).replacePending), row(138).state],
  [sha256('battlemetrics', 'bm-138-new'), false, 'ok']
);
assert.strictEqual(
  summary(),
  'Got 0 deleted bans. Imported 1 ban list: 3 bans fetched, 3 new, 0 updated, 0 removed, 0 held, 0 lists failed.'
);

// A change saved after the poll's bans, and before the poll reads the list again, deleted them with
// the list's other bans, so there is nothing left to remove, and the poll says so. A list removed
// then is skipped as removed during the run, and no row is saved for it.
for (const removedList of [false, true]) {
  reset();
  delete env.IMPORTER_HEAD_POLL;
  battlemetricsList(139, [], paged(pairs('z', 0, 12)));
  await pollRun();
  serve(139, [['zn0', steamID(310)], ...pairs('z', 0, 12)]);
  const findList = BanList.findByPk;
  BanList.findByPk = async (id, options) => {
    if (options?.attributes?.includes('source')) {
      for (const banID of storedIDs(id)) bans.delete(banID);
      if (removedList) banLists.delete(id);
      else banLists.set(id, { ...banLists.get(id), source: 'bm-139-new' });
    }
    return findList(id, options);
  };
  const saves = syncSaves.length;
  polled = await pollRun();
  BanList.findByPk = findList;
  assert.deepStrictEqual(storedIDs(139), [], `removed list: ${removedList}`);
  assert.deepStrictEqual(written(), ['139,zn0'], `removed list: ${removedList}`);
  if (removedList) {
    assert.deepStrictEqual(
      [polled.results[0].gone, removedIDs(), syncSaves.length],
      [true, [], saves]
    );
    assert.strictEqual(
      logged(2, /^Skipped ban list \(ID: 139\), as it was removed during the run\.$/).length,
      1
    );
  } else {
    assert.deepStrictEqual(
      [polled.results[0].sourceChanged, polled.results[0].removed, removedIDs()],
      [true, 0, ['139,zn0', '139,z0', '139,z1', '139,z2', '139,z3']]
    );
    assert.deepStrictEqual(
      warnings().map(({ message }) => message),
      [
        'Removed the bans fetched for ban list (ID: 139), as its type or source was changed while it was imported (5 bans fetched, 1 new, 0 updated). Its new source is imported on the next run.'
      ]
    );
  }
}

// Removing them needs the run lock, as removing any list's bans does: a run that has lost it stops
// there, and removes nothing.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(140, [], paged(pairs('y', 0, 12)));
await pollRun();
serve(140, [['yn0', steamID(320)], ...pairs('y', 0, 12)]);
const lockless = await loadImporter();
lockless.control.setRunLock({ isHeld: async () => false });
onWrite = (ids) => {
  if (ids.includes('140,yn0')) banLists.set(140, { ...banLists.get(140), source: 'bm-140-new' });
};
polled = await pollRun(undefined, lockless.BanImporter);
onWrite = null;
assert.strictEqual(polled.stopped?.reason, lockless.control.LOCK_LOST);
assert.deepStrictEqual([written(), removedIDs()], [['140,yn0'], []]);

// A run asked to stop while a poll's bans are saved, as when a batch waits for the bot's
// transaction and SIGTERM comes meanwhile, still reads the list again before it stops. A list whose
// type or source was changed has the bans the poll fetched removed, which ends its import, and the
// run stops at its next safe point, before the next list. Its row keeps the old source's key, so
// the next run reads the new source in full, with none of the old source's bans left to hold, or
// to wait for a confirming read. Here 12 new bans sit on top of the list, over 3 pages.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(141, [], paged(pairs('x', 0, 12)));
battlemetricsList(142, [], paged(pairs('q', 0, 3)));
await pollRun();
const rowBefore141 = row(141);
const newOnTop141 = pairs('xn', 100, 112);
serve(141, [...newOnTop141, ...pairs('x', 0, 12)]);
const signalled = await loadImporter();
onWrite = (ids) => {
  if (!ids.includes('141,xn100')) return;
  for (const banID of storedIDs(141)) bans.delete(banID);
  banLists.set(141, { ...banLists.get(141), source: 'bm-141-new' });
  signalled.control.requestStop('it received SIGTERM');
};
polled = await pollRun(undefined, signalled.BanImporter);
onWrite = null;
assert.strictEqual(polled.stopped?.reason, 'it received SIGTERM');
assert.deepStrictEqual(asked(), [
  ['bm-141', 'newest'],
  ['bm-141', '1'],
  ['bm-141', '2']
]);
// The 12 new bans the poll saved after the change are removed, with the 3 others on its last page,
// which the change deleted, after the list was read again.
assert.deepStrictEqual(
  written(),
  newOnTop141.map(([uid]) => `141,${uid}`)
);
assert.deepStrictEqual(
  [storedIDs(141), removedIDs()],
  [[], [...newOnTop141, ...pairs('x', 0, 3)].map(([uid]) => `141,${uid}`)]
);
assert.deepStrictEqual(
  events
    .filter(([type]) => ['read list', 'write', 'remove'].includes(type))
    .map(([type, id]) => [type, Array.isArray(id) ? id.length : id]),
  [
    ['read list', 141],
    ['write', 12],
    ['read list', 141],
    ['remove', 15]
  ]
);
assert.deepStrictEqual(polled.report.banLists, [
  {
    id: 141,
    fetched: 15,
    new: 12,
    updated: 0,
    removed: 12,
    held: 0,
    read: 'head',
    sourceChanged: true
  }
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Removed the bans fetched for ban list (ID: 141), as its type or source was changed while it was imported (15 bans fetched, 12 new, 0 updated, 12 removed). Its new source is imported on the next run.'
  ]
);
assert.deepStrictEqual(
  [row(141).sourceKey, row(141).headUids, row(141).headTotal, row(141).state],
  [rowBefore141.sourceKey, rowBefore141.headUids, rowBefore141.headTotal, 'ok']
);
battlemetricsLists.set('bm-141-new', paged(pairs('xv', 0, 3)));
polled = await pollRun(undefined, (await loadImporter()).BanImporter);
assert.deepStrictEqual(readsOf(polled), [
  [142, 'head', null],
  [141, 'full', 'source']
]);
assert.deepStrictEqual(
  [storedIDs(141), removedIDs(), pendingIDs(141)],
  [pairs('xv', 0, 3).map(([uid]) => `141,${uid}`), [], []]
);
assert.deepStrictEqual(
  [row(141).sourceKey, Boolean(row(141).replacePending), row(141).state],
  [sha256('battlemetrics', 'bm-141-new'), false, 'ok']
);

// So does a run asked to stop while a list read in full saves its bans: the 2 new bans it saved
// after the change are removed, with the others it fetched, which the change deleted, and the run
// stops before the next list. The next run has none of the old source's bans to wait for.
reset();
battlemetricsList(143, pairs('u', 0, 12), [[...pairs('un', 200, 202), ...pairs('u', 0, 12)]]);
battlemetricsList(144, pairs('p', 50, 52), [pairs('p', 50, 52)]);
const signalledInFull = await loadImporter();
onWrite = (ids) => {
  if (!ids.includes('143,un200')) return;
  for (const banID of storedIDs(143)) bans.delete(banID);
  banLists.set(143, { ...banLists.get(143), source: 'bm-143-new' });
  signalledInFull.control.requestStop('it received SIGTERM');
};
polled = await pollRun(undefined, signalledInFull.BanImporter);
onWrite = null;
assert.strictEqual(polled.stopped?.reason, 'it received SIGTERM');
assert.deepStrictEqual(battlemetricsRequests, ['bm-143']);
assert.deepStrictEqual(
  [written(), storedIDs(143), removedIDs()],
  [
    ['143,un200', '143,un201'],
    [],
    [...pairs('un', 200, 202), ...pairs('u', 0, 12)].map(([uid]) => `143,${uid}`)
  ]
);
assert.deepStrictEqual(
  [
    polled.results,
    polled.report.banLists.map(({ id, removed, sourceChanged }) => [id, removed, sourceChanged])
  ],
  [null, [[143, 2, true]]]
);
battlemetricsLists.set('bm-143-new', [pairs('uv', 0, 3)]);
polled = await pollRun(undefined, (await loadImporter()).BanImporter);
assert.deepStrictEqual(
  [storedIDs(143), pendingIDs(143), row(143).state, Boolean(row(143).replacePending)],
  [pairs('uv', 0, 3).map(([uid]) => `143,${uid}`), [], 'ok', false]
);

// A run asked to stop while a poll saves the new bans it found ends once the batch under way is
// saved, as for any list, and the list keeps its row as it was: its newest page and count are only
// saved with all the bans on the poll's pages. So its next poll still finds the bans that were not
// saved. Each run here has a run control of its own, as one asked to stop stays so. Here 7 new bans
// sit on top of a list, over two pages, and the stop comes while the poll reads the second, before
// any of them is saved: the next poll finds them all new again, follows them, and saves them.
reset();
delete env.IMPORTER_HEAD_POLL;
const oldBans = pairs('g', 0, 12);
const newBans = pairs('gn', 0, 7);
battlemetricsList(136, [], paged(oldBans));
await pollRun();
let beforeStop = row(136);
const stopping = await loadImporter();
const pages136 = paged([...newBans, ...oldBans]);
const secondPage = pages136[1];
pages136[1] = Object.assign(
  () => {
    stopping.control.requestStop('it received SIGTERM');
    return secondPage;
  },
  { entries: secondPage }
);
battlemetricsLists.set('bm-136', pages136);
// The run tells the time by a clock of its own, which each request moves on 1.5 seconds.
let stopNow = Date.parse('2026-10-23T15:20:00.000Z');
onBattlemetrics = () => {
  stopNow += 1500;
};
polled = await pollRun({ clock: () => stopNow }, stopping.BanImporter);
onBattlemetrics = null;
assert.strictEqual(polled.stopped?.reason, 'it received SIGTERM');
assert.deepStrictEqual(
  [asked(), writes(), polled.report.banLists],
  [
    [
      ['bm-136', 'newest'],
      ['bm-136', '1']
    ],
    [],
    []
  ]
);
assert.deepStrictEqual(row(136), beforeStop);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Stopped importing ban list (ID: 136) while saving its bans, after 3s, as the run is stopping, so none of its bans were removed (10 bans fetched, 0 new, 0 updated).'
  ]
);
serve(136, [...newBans, ...oldBans]);
polled = await pollRun(undefined, (await loadImporter()).BanImporter);
assert.deepStrictEqual(asked(), [
  ['bm-136', 'newest'],
  ['bm-136', '1']
]);
assert.deepStrictEqual(
  [...written()].sort(),
  newBans.map(([uid]) => `136,${uid}`)
);
assert.deepStrictEqual(
  [readsOf(polled), JSON.parse(row(136).headUids), row(136).headTotal],
  [[[136, 'head', null]], ['gn0', 'gn1', 'gn2', 'gn3', 'gn4'], 19]
);

// So does a stop that comes between two batches of the poll's bans: here, written 2 at a time, the
// first 2 of the 7 are saved. The next poll finds the 3 others on the list's newest page new, and
// BattleMetrics' count 4 more than its count at the last read and those 3 explain, for the 2 saved
// and the 2 below that page, so it reads the list in full, which saves the 5 not saved.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(137, [], paged(oldBans));
await pollRun();
beforeStop = row(137);
serve(137, [...newBans, ...oldBans]);
const halted = await loadImporter();
onWrite = (ids) => {
  if (ids.includes('137,gn0')) halted.control.requestStop('it took longer than 18000s');
};
polled = await pollRun({ batchSize: 2 }, halted.BanImporter);
onWrite = null;
assert.strictEqual(polled.stopped?.reason, 'it took longer than 18000s');
assert.deepStrictEqual(written(), ['137,gn0', '137,gn1']);
assert.deepStrictEqual(row(137), beforeStop);
polled = await pollRun(undefined, (await loadImporter()).BanImporter);
assert.deepStrictEqual(
  [readsOf(polled), polled.report.banLists[0].drift, removedIDs()],
  [[[137, 'full', 'drift']], { total: 19, expected: 15 }, []]
);
assert.deepStrictEqual(
  [...written()].sort(),
  newBans.slice(2).map(([uid]) => `137,${uid}`)
);
assert.strictEqual(storedIDs(137).length, 19);

// A run asked to stop while a list is read in full, between two of its pages, or between two
// attempts at one, as when the time limit comes while BattleMetrics is slow to answer it, stops the
// list there. Its line says which page it was on, and of about how many by BattleMetrics' count,
// and how long its import had taken, and the report, whose totals and banLists leave it out, gives
// it on its own (stopped), with where it stopped, so the list that held up an interrupted cycle
// shows in the cycle's JSON line. Here each request takes 20 seconds, and the list's third page
// asks the run to stop, so its fourth is not read.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(185, [], paged(pairs('s', 0, 20)));
battlemetricsTotals.set('bm-185', 1200);
const pages185 = battlemetricsLists.get('bm-185');
const halting = await loadImporter();
const third185 = pages185[2];
pages185[2] = Object.assign(
  () => {
    halting.control.requestStop('it took longer than 900s');
    return third185;
  },
  { entries: third185 }
);
let haltNow = Date.parse('2026-10-23T15:20:00.000Z');
onBattlemetrics = () => {
  haltNow += 20 * 1000;
};
polled = await pollRun({ clock: () => haltNow }, halting.BanImporter);
assert.strictEqual(polled.stopped?.reason, 'it took longer than 900s');
assert.deepStrictEqual(asked(), [
  ['bm-185', 'newest'],
  ['bm-185', '1'],
  ['bm-185', '2']
]);
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Stopped importing ban list (ID: 185) while fetching page 4 of about 12, after 60s, as the run is stopping, so none of its bans were removed.'
  ]
);
assert.deepStrictEqual(
  [polled.report.imported, polled.report.banLists, polled.report.stopped],
  [
    0,
    [],
    {
      id: 185,
      fetched: 0,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      seconds: 60,
      read: 'full',
      reason: 'new',
      page: 4,
      stage: 'fetching it'
    }
  ]
);
// A list stopped at its second attempt is given with the time of both attempts, and how its first
// one ended: here its first attempt fails on its second page, after 40 seconds, and its second is
// stopped before its fourth page, after 60 more. The list that did not fail is the only one in
// banLists, as in the totals.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(186, [], paged(pairs('u', 0, 20)));
battlemetricsTotals.set('bm-186', 1200);
battlemetricsList(187, [], paged(pairs('v', 0, 3)));
const pages186 = battlemetricsLists.get('bm-186');
pages186[1] = failsOnce(pages186[1]);
const retried = await loadImporter();
const third186 = pages186[2];
pages186[2] = Object.assign(
  () => {
    retried.control.requestStop('it took longer than 900s');
    return third186;
  },
  { entries: third186 }
);
onBattlemetrics = () => {
  haltNow += 20 * 1000;
};
polled = await pollRun({ clock: () => haltNow }, retried.BanImporter);
onBattlemetrics = null;
assert.strictEqual(polled.stopped?.reason, 'it took longer than 900s');
assert.deepStrictEqual(
  warnings().map(({ message }) => message),
  [
    'Failed to import ban list (ID: 186) while fetching page 2 of about 12, so none of its bans were removed. Error: Request failed with status code 502',
    'Stopped importing ban list (ID: 186) at the second attempt while fetching page 4 of about 12, after 60s, as the run is stopping, so none of its bans were removed.'
  ]
);
assert.deepStrictEqual(
  [polled.report.imported, polled.report.banLists.map(({ id }) => id), polled.report.stopped],
  [
    1,
    [187],
    {
      id: 186,
      fetched: 0,
      new: 0,
      updated: 0,
      removed: 0,
      held: 0,
      seconds: 100,
      read: 'full',
      reason: 'new',
      attempt: 2,
      page: 4,
      firstAttempt: {
        seconds: 40,
        error: 'Error: Request failed with status code 502',
        stage: 'fetching it',
        page: 2
      },
      stage: 'fetching it'
    }
  ]
);

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
let stoppedNow = Date.parse('2026-10-23T15:20:00.000Z');
onBattlemetrics = () => {
  stoppedNow += 2000;
};
const stoppedImporter = new BanImporter({ batchSize: 2, clock: () => stoppedNow });
const stopped = await stoppedImporter.importBans().catch((err) => err);
onBattlemetrics = null;
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
      'Stopped importing ban list (ID: 30) while saving its bans, after 2s, as the run is stopping, so none of its bans were removed (8 bans fetched, 4 new, 0 updated).',
      true
    ]
  ]
);
assert.strictEqual(
  summary(),
  'Got 1 deleted ban. Imported 1 of 3 ban lists before the run stopped: 1 ban fetched, 0 new, 0 updated, 1 removed, 0 held, 0 lists failed.'
);
// Its report for the run record counts the same lists as its summary, and every request it made,
// that of the list it stopped in the middle of too, which it gives on its own, with what it saved.
assert.deepStrictEqual(plainReport(stoppedImporter), {
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
  accessCheckSeconds: 0,
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
  ],
  stopped: {
    id: 30,
    fetched: 8,
    new: 4,
    updated: 0,
    removed: 0,
    held: 0,
    seconds: 2,
    read: 'full',
    reason: 'new',
    stored: 4,
    stage: 'saving its bans'
  }
});

// Paused ban lists (see paused-lists.js), with an importer of their own, as the checks above leave
// theirs asked to stop. A suspended list is not imported at all: not fetched, not counted among the
// run's lists and given no row, and the run says how many it left out.
// Each run is a minute after the one before, on a clock of their own, so a list resumed between two
// runs was resumed after the first read it.
const { BanImporter: PausedImporter } = await loadImporter();
let pausedNow = Date.parse('2026-10-29T12:00:00.000Z');
const pausedPoll = () => {
  pausedNow += 60 * 1000;
  return pollRun({ clock: () => pausedNow }, PausedImporter);
};
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(120, [], paged(pairs('s', 0, 4)));
battlemetricsList(121, pairs('t', 0, 2), paged(pairs('t', 0, 4)));
pausedRows = [{ banList: 121, resumedAt: null }];
let pausedRun = await pausedPoll();
assert.deepStrictEqual(readsOf(pausedRun), [[120, 'full', 'new']]);
assert.ok(asked().every(([list]) => list === 'bm-120'));
assert.deepStrictEqual(
  [pausedRun.report.lists, pausedRun.report.imported, pausedRun.report.suspended],
  [1, 1, 1]
);
assert.strictEqual(pausedRun.report.caughtUp, undefined);
assert.deepStrictEqual(storedIDs(121), ['121,t0', '121,t1']);
assert.strictEqual(syncRows.has(121), false);
assert.strictEqual(
  logged(2, /^Fetched 1 ban lists to import, leaving out 1 suspended ban list \(121\)\.$/).length,
  1
);
assert.deepStrictEqual(endedResumptions, []);

// Once resumed, it is imported again, read in full at once, newest first, as it has not been read
// in full since it was resumed, whether or not it is due a full read by its row. A read that leaves
// no bans waiting for a later read to confirm that they are gone ends its resumption, so it counts
// again from the next run: the run says so, and the import's line and report name it.
pausedRows = [];
await pausedPoll();
const resumedAt = new Date(new Date(row(121).lastFullScanAt).getTime() + 1);
pausedRows = [{ banList: 121, resumedAt }];
pausedRun = await pausedPoll();
assert.deepStrictEqual(readsOf(pausedRun), [
  [120, 'head', null],
  [121, 'full', 'resume']
]);
assert.deepStrictEqual(endedResumptions, [[121, resumedAt]]);
assert.deepStrictEqual(pausedRows, []);
assert.deepStrictEqual(pausedRun.report.caughtUp, [121]);
assert.strictEqual(pausedRun.report.banLists.find(({ id }) => id === 121).caughtUp, true);
assert.strictEqual(pausedRun.report.suspended, undefined);
assert.strictEqual(
  logged(1, /^Ban list \(ID: 121\) counts again: it was read in full since it was resumed, /)
    .length,
  1
);
assert.ok(logs.filter(({ level }) => level === 1).every(({ important }) => important));

// A resumed list whose read finds bans gone, which wait for a later complete read to confirm it,
// as its owner lifted them while it was suspended, stays resuming, so they never count again. The
// read that confirms they are gone, once it is due, removes them and ends the resumption.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(122, [], paged(pairs('u', 0, 30)));
await pausedPoll();
assert.strictEqual(storedIDs(122).length, 30);
serve(122, pairs('u', 0, 15));
const resumed122 = new Date(new Date(row(122).lastFullScanAt).getTime() + 1);
pausedRows = [{ banList: 122, resumedAt: resumed122 }];
pausedRun = await pausedPoll();
assert.deepStrictEqual(readsOf(pausedRun), [[122, 'full', 'resume']]);
assert.strictEqual(pendingIDs(122).length, 15);
assert.deepStrictEqual(endedResumptions, []);
assert.strictEqual(pausedRows.length, 1);
assert.strictEqual(pausedRun.report.caughtUp, undefined);
pausedNow += 11 * 60 * 1000;
pausedRun = await pausedPoll();
assert.deepStrictEqual(readsOf(pausedRun), [[122, 'full', 'removal']]);
assert.strictEqual(storedIDs(122).length, 15);
assert.deepStrictEqual(endedResumptions, [[122, resumed122]]);
assert.deepStrictEqual(pausedRun.report.caughtUp, [122]);

// A list that seems to have lost all its bans while it was suspended keeps them, held for an admin,
// and stays resuming, so it does not count again until an admin has confirmed or they come back.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(123, [], paged(pairs('v', 0, 12)));
await pausedPoll();
serve(123, []);
pausedRows = [
  { banList: 123, resumedAt: new Date(new Date(row(123).lastFullScanAt).getTime() + 1) }
];
pausedRun = await pausedPoll();
assert.deepStrictEqual(readsOf(pausedRun), [[123, 'full', 'resume']]);
assert.strictEqual(pausedRun.report.banLists[0].hold, 'empty');
assert.strictEqual(storedIDs(123).length, 12);
assert.deepStrictEqual(endedResumptions, []);

// A list resumed again, or suspended again, while the run imported it keeps its row: the run only
// deletes the row it saw. A dry run, which writes nothing, never ends a resumption, and a list that
// is only polled, or whose read failed, has not caught up.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(124, [], paged(pairs('w', 0, 4)));
await pausedPoll();
const later = new Date(new Date(row(124).lastFullScanAt).getTime() + 1);
pausedRows = [{ banList: 124, resumedAt: later }];
onBattlemetrics = () => {
  pausedRows = [{ banList: 124, resumedAt: new Date(later.getTime() + 1) }];
};
pausedRun = await pausedPoll();
onBattlemetrics = null;
assert.deepStrictEqual(endedResumptions, [[124, later]]);
assert.strictEqual(pausedRows.length, 1);
assert.strictEqual(pausedRun.report.caughtUp, undefined);

// The read under way when it was resumed again ended after then, so the next run need not read it
// in full: the list catches up at its next full read, in a run that saw it resumed.
assert.deepStrictEqual(readsOf(await pausedPoll()), [[124, 'head', null]]);
assert.strictEqual(pausedRows.length, 1);

endedResumptions.length = 0;
pausedRows = [{ banList: 124, resumedAt: new Date(pausedNow + 1) }];
env.IMPORTER_DRY_RUN = '1';
pausedRun = await pausedPoll();
delete env.IMPORTER_DRY_RUN;
assert.deepStrictEqual(readsOf(pausedRun), [[124, 'full', 'resume']]);
assert.deepStrictEqual(endedResumptions, []);

battlemetricsLists.set('bm-124', [new Error('Request failed with status code 500')]);
pausedRun = await pausedPoll();
assert.deepStrictEqual(endedResumptions, []);
assert.strictEqual(pausedRows.length, 1);

// A resuming list whose source is one of CBL's own export ban lists is never read, so there is
// nothing to catch up with: it is back as it was before it was suspended at once.
reset();
delete env.IMPORTER_HEAD_POLL;
battlemetricsList(125, [], paged(pairs('x', 0, 2)), 'cbl-export-125');
exportBanLists.push({ id: 9, battlemetricsID: 'cbl-export-125' });
pausedRows = [{ banList: 125, resumedAt: new Date(pausedNow) }];
pausedRun = await pausedPoll();
assert.deepStrictEqual(battlemetricsRequests, []);
assert.deepStrictEqual(
  endedResumptions.map(([id]) => id),
  [125]
);
assert.deepStrictEqual(pausedRun.report.caughtUp, [125]);
assert.strictEqual(
  logged(
    1,
    /^Ban list \(ID: 125\) counts again: its source is one of CBL's own export ban lists, so it is not read, /
  ).length,
  1
);

assert.strictEqual(verboseLevelOneLines, 0, 'Lines for the log channel are logged as important');

console.log(
  "Ban import checks passed: complete lists only, writes of what changed only, removals after a second read, holds over several runs until confirmed, of lists that lost all their bans, until one of the bans they began with comes back, those they saved since held with them, whatever the clock says, and as earlier importers left them, or a large part of them at once, until fewer than a large part of the bans the list had then are still missing, also as the list grows, with those that come back no longer held, and once it loses all of its bans, or another large part of them, measured against fewer bans as the list shrinks, holds of lists that lost all their bans that take in a large loss, holds ended, begun or taken in whole, or not at all, as a run is cut short, holds that keep bans written before the bans a read saves, with the records of the bans it found again dropped, also by a read that is not complete, so a cut or stop then keeps the hold it wrote, also without the run lock, as the drop fails or as the list is removed, and those that only end after them, and in the run record only once written, with the bans a hold's end lets wait counted from then, less those removed, confirmations said to end only the holds they ended, also as a large loss would begin another, large removals said in every line, the holds replaced sources ended, reasons that outlived their holds, also found by a poll's drift, without queueing their players, empty lists, the count check, counts that change too much, lists left out of it, repeated incomplete reads, replaced sources, remote files, dry runs and invalid ones, SteamID moves, second attempts, retries, sync state, the access check, lost access, also with no hold written or record dropped before the bans are saved, self-imports, lists removed before their missing bans are recorded, head polls that never remove, but for the bans they fetched of a source changed while they saved them, also as the run stops, drift, overflow, lists replaced under an overflow held, losses measured against the bans before the run, bursts followed, confirming reads, periodic full reads at each list's slot, by the lists' pages and the cycle, cycles whose full reads spread out after the first, held counts of polled lists, the switches, stops, also during a poll, and the list a stop came in, each list's seconds without the access check, the page a failed or stopped read was on, but no count of the old source's for a changed one, how a list's first attempt ended, the list under way and the access check while it is read, runs an interval apart, the loop's cycle, the oldest periodic reads first, and the run summary."
);
