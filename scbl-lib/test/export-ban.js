import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise how an export ban claims, makes, finds and deletes its BattleMetrics ban, without a
// database or network requests. The ExportBans table is a Map that the stand-in for Sequelize's
// Model updates as MySQL would, and BattleMetrics is a stand-in that keeps each ban list's bans.

const MINUTE = 60 * 1000;
let clock = Date.UTC(2026, 9, 15, 12);

class FakeDate extends Date {
  constructor(...args) {
    super(...(args.length > 0 ? args : [clock]));
  }

  static now() {
    return clock;
  }
}

// The stand-ins for Sequelize's operators.
const Op = { lte: Symbol('lte'), not: Symbol('not') };

// The ExportBans table, by id, and the writes made to it.
const table = new Map();
let writes = [];

// Whether a row matches a where clause, as MySQL would match the statement Sequelize makes of it.
function matches(row, where) {
  return Object.entries(where).every(([column, condition]) => {
    const value = row[column];
    if (condition === null) return value === null;
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      if (Op.lte in condition) return value.getTime() <= condition[Op.lte].getTime();
      if (Op.not in condition) return condition[Op.not] === null && value !== null;
      throw new Error(`Unexpected condition on ${column}`);
    }
    return value === condition;
  });
}

// A write as it is recorded: the values set and the where clause, with operators named, so they
// can be compared.
function describe(object) {
  return Object.fromEntries(
    [...Object.keys(object), ...Object.getOwnPropertySymbols(object)].map((key) => {
      const value = object[key];
      const name = typeof key === 'symbol' ? key.description : key;
      if (value instanceof Date) return [name, value.getTime()];
      if (value && typeof value === 'object') return [name, describe(value)];
      return [name, value];
    })
  );
}

// A stand-in for Sequelize's Model, whose update and destroy change the rows in the table and say
// how many they changed, as MySQL does. update sets updatedAt to the time, unless it is silent.
class Model {
  static init() {}

  static async update(values, { where, silent }) {
    writes.push({ update: describe(values), where: describe(where) });
    let changed = 0;
    for (const row of table.values()) {
      if (!matches(row, where)) continue;
      Object.assign(row, values);
      if (!silent) row.updatedAt = new FakeDate(clock);
      changed++;
    }
    return [changed];
  }

  static async destroy({ where }) {
    writes.push({ destroy: describe(where) });
    let destroyed = 0;
    for (const [id, row] of table) {
      if (!matches(row, where)) continue;
      table.delete(id);
      destroyed++;
    }
    return destroyed;
  }
}
// Any data type, such as DataTypes.STRING or DataTypes.ENUM(...).
const dataType = () => dataType;

// BattleMetrics: the bans on each ban list, and every request made. onPost and onDelete decide how
// a POST or DELETE is answered, and the bans on a list are read 2 to a page.
const bmLists = new Map();
let requests = [];
let bmBanCount = 0;
let onPost;
let onDelete;
let onRead = () => {};
const PAGE_SIZE = 2;

// An error as the BattleMetrics client throws one.
function apiError(message, { status, ambiguous = false, auth = false } = {}) {
  const err = Object.assign(new Error(message), { name: 'ApiError', status, ambiguous, auth });
  if (status) err.response = { status, data: { errors: [] } };
  return err;
}

function addBan(list, attributes) {
  const id = String(++bmBanCount);
  if (!bmLists.has(list)) bmLists.set(list, []);
  bmLists.get(list).push({ type: 'ban', id, attributes: { note: null, ...attributes } });
  return id;
}

async function battlemetrics(method, endpoint, params, data) {
  // What the model sends is copied out of its context, to compare it.
  requests.push({
    method,
    endpoint,
    params: describe(params || {}),
    data: JSON.parse(JSON.stringify(data || null))
  });
  if (method === 'get' && endpoint === 'bans') {
    onRead(params);
    let bans = bmLists.get(params['filter[banList]']) || [];
    if (params['filter[search]'])
      bans = bans.filter((ban) =>
        ban.attributes.identifiers.some(({ identifier }) => identifier === params['filter[search]'])
      );
    const start = Number(params['page[key]'] || 0);
    const next = start + PAGE_SIZE < bans.length;
    const query = new URLSearchParams({ ...params, 'page[key]': start + PAGE_SIZE });
    return {
      data: {
        data: bans.slice(start, start + PAGE_SIZE),
        links: { next: next ? `https://api.battlemetrics.com/bans?${query}` : null }
      }
    };
  }
  if (method === 'post' && endpoint === 'bans') return onPost(data);
  if (method === 'delete') return onDelete(endpoint.replace('bans/', ''));
  throw new Error(`Unexpected request: ${method} ${endpoint}`);
}

// The default answers: a POST makes the ban, and a DELETE deletes it, or answers 404 when it is
// not there.
function makeBan(data) {
  const id = addBan(data.data.relationships.banList.data.id, data.data.attributes);
  return { data: { data: { type: 'ban', id } } };
}
function deleteBan(id) {
  for (const bans of bmLists.values()) {
    const index = bans.findIndex((ban) => ban.id === id);
    if (index === -1) continue;
    bans.splice(index, 1);
    return { status: 204 };
  }
  throw apiError(`BattleMetrics DELETE bans/${id} failed: HTTP 404 (Not Found)`, { status: 404 });
}

const logs = [];

// Load export-ban.js with the stand-ins and the real page reader, and the given environment.
async function loadExportBan(env = {}) {
  const context = vm.createContext({ Date: FakeDate, URL, URLSearchParams, process: { env } });
  const dependencies = {
    sequelize: {
      default: { Model, DataTypes: new Proxy({}, { get: () => dataType }), Op }
    },
    '../sequelize.js': { default: {} },
    '../../apis/index.js': { battlemetrics },
    './battlemetrics.js': { default: battlemetrics },
    '../../config.js': { BATTLEMETRICS_ORGANIZATION: '42' },
    '../../utils/index.js': {
      Logger: { verbose: (module, level, message) => logs.push({ level, message }) }
    }
  };
  const url = new URL('../db/models/export-ban.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    // The page reader is the real one, which makes its requests through the stand-in.
    if (specifier === '../../apis/read-battlemetrics-pages.js') {
      const reader = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(reader, 'utf8'), {
        context,
        identifier: reader.href
      });
    }
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
  return module.namespace.default;
}

const ExportBan = await loadExportBan();

const list = { id: 7, type: 'battlemetrics', battlemetricsID: 'bm-7' };
const otherList = { id: 8, type: 'battlemetrics', battlemetricsID: 'bm-8' };
const steamUser = (n) => `7656119800000000${n}`;

// Add an export ban to the table, and return it as the importer reads it, with its list.
function exportBan(n, fields = {}, exportBanList = list) {
  const row = {
    id: `${steamUser(n)},${exportBanList.id}`,
    steamUser: steamUser(n),
    exportBanList: exportBanList.id,
    status: 'TO_BE_CREATED',
    battlemetricsID: null,
    updatedAt: new FakeDate(clock - 60 * MINUTE),
    ...fields
  };
  table.set(row.id, row);
  return read(row.id, exportBanList);
}

// The export ban as the importer reads it from the table, with its list.
function read(id, exportBanList = list) {
  return Object.assign(new ExportBan(), { ...table.get(id), ExportBanList: exportBanList });
}

const row = (id) =>
  table.get(id) && { ...table.get(id), updatedAt: table.get(id).updatedAt.getTime() };
const note = (id) => `CBL export ${id}`;
const posts = () => requests.filter(({ method }) => method === 'post');
const reads = () => requests.filter(({ method }) => method === 'get');

function reset() {
  table.clear();
  bmLists.clear();
  bmBanCount = 0;
  writes = [];
  requests = [];
  logs.length = 0;
  onPost = makeBan;
  onDelete = deleteBan;
  onRead = () => {};
}

// A new export ban is claimed before its ban is made: its battlemetricsID becomes 'pending', if it
// is still to be created and nothing has claimed it. The ban carries the export ban's ID in its
// note, and its ID and the created status are then written together, while the claim holds.
{
  reset();
  const ban = exportBan(1);
  let duringPost;
  onPost = (data) => {
    duringPost = row(ban.id);
    return makeBan(data);
  };
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'created');
  assert.deepStrictEqual(writes, [
    {
      update: { battlemetricsID: 'pending' },
      where: { id: ban.id, status: 'TO_BE_CREATED', battlemetricsID: null }
    },
    {
      update: { battlemetricsID: '1', status: 'CREATED' },
      where: { id: ban.id, battlemetricsID: 'pending' }
    }
  ]);
  assert.strictEqual(duringPost.battlemetricsID, 'pending');
  assert.strictEqual(duringPost.updatedAt, clock);
  assert.deepStrictEqual(posts(), [
    {
      method: 'post',
      endpoint: 'bans',
      params: {},
      data: {
        data: {
          type: 'ban',
          attributes: {
            autoAddEnabled: true,
            expires: null,
            identifiers: [{ type: 'steamID', identifier: steamUser(1), manual: true }],
            nativeEnabled: null,
            note: `CBL export ${steamUser(1)},7`,
            reason: 'Kicked via communitybanlist.com/banned'
          },
          relationships: {
            organization: { data: { type: 'organization', id: '42' } },
            banList: { data: { type: 'banList', id: 'bm-7' } }
          }
        }
      }
    }
  ]);
  assert.deepStrictEqual([row(ban.id).status, row(ban.id).battlemetricsID], ['CREATED', '1']);
  assert.strictEqual(bmLists.get('bm-7')[0].attributes.note, note(ban.id));
}

// The claim must change exactly one row, so an export ban that another run claimed first, or that
// is no longer to be created, is skipped, and nothing is sent to BattleMetrics.
for (const change of [{ battlemetricsID: 'pending' }, { status: 'TO_BE_DELETED' }, null]) {
  reset();
  const ban = exportBan(1);
  if (change) Object.assign(table.get(ban.id), change);
  else table.delete(ban.id);
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'skipped');
  assert.strictEqual(requests.length, 0);
  assert.strictEqual(writes.length, 1);
}

// When BattleMetrics may have made the ban, as the POST timed out, was cut off or failed with 5xx,
// the claim is kept, so the ban is looked for before another is made, and the error is thrown.
{
  reset();
  const ban = exportBan(1);
  const timedOut = apiError(
    'BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out',
    { ambiguous: true }
  );
  onPost = () => {
    throw timedOut;
  };
  await assert.rejects(ban.createBattlemetricsBan(new Map()), (err) => err === timedOut);
  assert.strictEqual(row(ban.id).battlemetricsID, 'pending');
  assert.strictEqual(row(ban.id).status, 'TO_BE_CREATED');
  assert.strictEqual(writes.length, 1);
}

// When BattleMetrics did not make it, as it refused the request or could not be reached, the claim
// is released, so the next run makes the ban. Releasing it changes the export ban's time, which
// puts it at the back of the next run's queue.
for (const failure of [
  apiError('BattleMetrics POST bans failed: HTTP 422 (Invalid identifier)', { status: 422 }),
  apiError('BattleMetrics POST bans failed: HTTP 401 (Unauthorized)', { status: 401, auth: true }),
  apiError('BattleMetrics POST bans failed after 3 attempts: could not connect (ECONNREFUSED)')
]) {
  reset();
  const ban = exportBan(1);
  onPost = () => {
    clock += 1000;
    throw failure;
  };
  await assert.rejects(ban.createBattlemetricsBan(new Map()), (err) => err === failure);
  assert.strictEqual(row(ban.id).battlemetricsID, null);
  assert.strictEqual(row(ban.id).updatedAt, clock);
  assert.deepStrictEqual(writes.at(-1), {
    update: { battlemetricsID: null },
    where: { id: ban.id, battlemetricsID: 'pending' }
  });
  clock -= 1000;
}

// A claim that could not be released stays, for a later run to resolve, and the request's error
// is still the one thrown.
{
  reset();
  const ban = exportBan(1);
  const refused = apiError('BattleMetrics POST bans failed: HTTP 400', { status: 400 });
  onPost = () => {
    throw refused;
  };
  const update = Model.update;
  Model.update = async function (values, options) {
    if (values.battlemetricsID === null) throw new Error('Connection lost');
    return update.call(this, values, options);
  };
  await assert.rejects(ban.createBattlemetricsBan(new Map()), (err) => err === refused);
  Model.update = update;
  assert.strictEqual(row(ban.id).battlemetricsID, 'pending');
  assert.match(logs.at(-1).message, /Failed to release the claim on export ban/);
}

// A claimed export ban's ban is looked for on its list first, by its note, and recorded when it is
// there, however old the claim: nothing more is sent to BattleMetrics.
{
  reset();
  addBan('bm-7', { note: 'Someone else' });
  const ban = exportBan(1, { battlemetricsID: 'pending', updatedAt: new FakeDate(clock - MINUTE) });
  const banID = addBan('bm-7', { note: note(ban.id) });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'found');
  assert.deepStrictEqual([row(ban.id).status, row(ban.id).battlemetricsID], ['CREATED', banID]);
  assert.deepStrictEqual(writes, [
    {
      update: { battlemetricsID: banID, status: 'CREATED' },
      where: { id: ban.id, status: 'TO_BE_CREATED', battlemetricsID: 'pending' }
    }
  ]);
  assert.strictEqual(posts().length, 0);
  // The list was read, 2 bans to a page, with its BattleMetrics ID.
  assert.deepStrictEqual(
    reads().map(({ params }) => params['filter[banList]']),
    ['bm-7']
  );
  assert.deepStrictEqual(
    logs.map(({ level }) => level),
    [1]
  );
}

// More than one ban with its note is reported, as nothing records the others.
{
  reset();
  const ban = exportBan(1, { battlemetricsID: 'pending' });
  const first = addBan('bm-7', { note: note(ban.id) });
  const second = addBan('bm-7', { note: ` ${note(ban.id)} ` });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'found');
  assert.strictEqual(row(ban.id).battlemetricsID, first);
  assert.match(logs.at(-1).message, new RegExp(`more Battlemetrics bans.*: ${second}\\.$`));
}

// A claimed export ban whose ban is not there is made again only once the claim is over 10 minutes
// old. It is then claimed again, for the new attempt.
{
  reset();
  const ban = exportBan(1, {
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 11 * MINUTE)
  });
  addBan('bm-7', { note: note('someone-else') });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'created');
  assert.deepStrictEqual(writes[0], {
    update: { battlemetricsID: 'pending' },
    where: {
      id: ban.id,
      status: 'TO_BE_CREATED',
      battlemetricsID: 'pending',
      updatedAt: { lte: clock - 10 * MINUTE }
    }
  });
  assert.strictEqual(posts().length, 1);
  assert.strictEqual(row(ban.id).status, 'CREATED');
}

// A younger claim waits for a later run, as BattleMetrics may still be making its ban.
{
  reset();
  const ban = exportBan(1, {
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 9 * MINUTE)
  });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'waiting');
  assert.strictEqual(posts().length, 0);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(row(ban.id).battlemetricsID, 'pending');
}

// A list's bans are read once a run, however many of its export bans are looked for, and a claim's
// age is measured from when they were read: one that was too young then still waits, as its ban
// could have been made after the list was read.
{
  reset();
  const bansByList = new Map();
  const young = exportBan(1, {
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 5 * MINUTE)
  });
  const old = exportBan(2, {
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 30 * MINUTE)
  });
  const elsewhere = exportBan(3, { battlemetricsID: 'pending' }, otherList);
  for (let i = 0; i < 5; i++) addBan('bm-7', { note: `note ${i}` });
  assert.strictEqual(await young.createBattlemetricsBan(bansByList), 'waiting');
  clock += 20 * MINUTE;
  assert.strictEqual(await read(young.id).createBattlemetricsBan(bansByList), 'waiting');
  assert.strictEqual(await old.createBattlemetricsBan(bansByList), 'created');
  assert.strictEqual(await elsewhere.createBattlemetricsBan(bansByList), 'created');
  // bm-7's 5 bans took 3 pages, read once, and bm-8 was read once on its own.
  assert.deepStrictEqual(
    reads().map(({ params }) => [params['filter[banList]'], params['page[key]'] || '0']),
    [
      ['bm-7', '0'],
      ['bm-7', '2'],
      ['bm-7', '4'],
      ['bm-8', '0']
    ]
  );
  assert.ok(reads().every(({ params }) => params['page[size]'] === '100'));
  clock -= 20 * MINUTE;
}

// A list whose bans cannot be read leaves its claimed export bans as they are, and is not read
// again in the run.
{
  reset();
  const bansByList = new Map();
  const unavailable = apiError('BattleMetrics GET bans failed after 3 attempts: HTTP 503', {
    status: 503
  });
  onRead = () => {
    throw unavailable;
  };
  const first = exportBan(1, { battlemetricsID: 'pending' });
  const second = exportBan(2, { battlemetricsID: 'pending' });
  await assert.rejects(first.createBattlemetricsBan(bansByList), (err) => err === unavailable);
  await assert.rejects(second.createBattlemetricsBan(bansByList), (err) => err === unavailable);
  assert.strictEqual(reads().length, 1);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(posts().length, 0);
}

// A list whose links never end is read for at most 2,000 pages.
{
  reset();
  const ban = exportBan(1, { battlemetricsID: 'pending' });
  for (let i = 0; i < 4002; i++) addBan('bm-7', { note: `note ${i}` });
  await assert.rejects(ban.createBattlemetricsBan(new Map()), /more than 2000 pages for bans/);
  assert.strictEqual(reads().length, 2000);
}

// An export ban that has a real BattleMetrics ID already, as an earlier run made its ban but could
// not mark it as created, is only marked as created.
{
  reset();
  const ban = exportBan(1, { battlemetricsID: '555' });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'found');
  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual([row(ban.id).status, row(ban.id).battlemetricsID], ['CREATED', '555']);
  assert.deepStrictEqual(writes, [
    {
      update: { status: 'CREATED' },
      where: { id: ban.id, status: 'TO_BE_CREATED', battlemetricsID: '555' }
    }
  ]);
}

// Nothing is made for a list with no BattleMetrics ban list.
{
  reset();
  const ban = exportBan(1, {}, { id: 9, type: 'battlemetrics', battlemetricsID: null });
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'skipped');
  assert.strictEqual(requests.length + writes.length, 0);
}

// An export ban deleted while its ban was being made, e.g. along with its list, would leave a ban
// nothing deletes, so the ban is deleted again.
{
  reset();
  const ban = exportBan(1);
  onPost = (data) => {
    table.delete(ban.id);
    return makeBan(data);
  };
  assert.strictEqual(await ban.createBattlemetricsBan(new Map()), 'skipped');
  assert.deepStrictEqual(
    requests.map(({ method, endpoint }) => `${method} ${endpoint}`),
    ['post bans', 'delete bans/1']
  );
  assert.strictEqual(bmLists.get('bm-7').length, 0);
}

// Deleting: an export ban with a ban has it deleted on BattleMetrics, and then is deleted, still
// queued to be deleted. One with no ban needs no request.
for (const [battlemetricsID, request] of [
  ['set', 'delete bans/1'],
  [null, null]
]) {
  reset();
  const id = battlemetricsID && addBan('bm-7', { note: 'x' });
  const ban = exportBan(1, { status: 'TO_BE_DELETED', battlemetricsID: id });
  assert.strictEqual(await ban.deleteBattlemetricsBan(new Map()), 'deleted');
  assert.deepStrictEqual(
    requests.map(({ method, endpoint }) => `${method} ${endpoint}`),
    request ? [request] : []
  );
  assert.deepStrictEqual(writes, [{ destroy: { id: ban.id, status: 'TO_BE_DELETED' } }]);
  assert.strictEqual(table.has(ban.id), false);
}

// A ban already gone from BattleMetrics, which answers 404, counts as deleted.
{
  reset();
  const ban = exportBan(1, { status: 'TO_BE_DELETED', battlemetricsID: '999' });
  assert.strictEqual(await ban.deleteBattlemetricsBan(new Map()), 'gone');
  assert.strictEqual(table.has(ban.id), false);
}

// Any other failure leaves the export ban for a later run to delete.
{
  reset();
  const ban = exportBan(1, { status: 'TO_BE_DELETED', battlemetricsID: '999' });
  const unavailable = apiError('BattleMetrics DELETE bans/999 failed after 3 attempts: HTTP 503', {
    status: 503
  });
  onDelete = () => {
    throw unavailable;
  };
  await assert.rejects(ban.deleteBattlemetricsBan(new Map()), (err) => err === unavailable);
  assert.strictEqual(row(ban.id).status, 'TO_BE_DELETED');
  assert.strictEqual(writes.length, 0);
}

// A claimed export ban to be deleted has its ban looked for: one that is found is deleted, and when
// none is, the export ban is deleted once its claim is over 10 minutes old, as no ban was made.
// With a younger claim it waits.
{
  reset();
  const found = exportBan(1, { status: 'TO_BE_DELETED', battlemetricsID: 'pending' });
  const banID = addBan('bm-7', { note: note(found.id) });
  const old = exportBan(2, {
    status: 'TO_BE_DELETED',
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 11 * MINUTE)
  });
  const young = exportBan(3, {
    status: 'TO_BE_DELETED',
    battlemetricsID: 'pending',
    updatedAt: new FakeDate(clock - 2 * MINUTE)
  });
  const bansByList = new Map();
  assert.strictEqual(await found.deleteBattlemetricsBan(bansByList), 'deleted');
  assert.strictEqual(await old.deleteBattlemetricsBan(bansByList), 'deleted');
  assert.strictEqual(await young.deleteBattlemetricsBan(bansByList), 'waiting');
  assert.deepStrictEqual(
    requests.map(({ method, endpoint }) => `${method} ${endpoint}`),
    ['get bans', `delete bans/${banID}`]
  );
  assert.deepStrictEqual(
    [found.id, old.id, young.id].map((id) => table.has(id)),
    [false, false, true]
  );
}

// With IMPORTER_BM_SEARCH_LOOKUP=1, each claimed export ban's ban is looked for by searching its
// list for the player, rather than by reading the whole list once.
{
  const SearchingExportBan = await loadExportBan({ IMPORTER_BM_SEARCH_LOOKUP: '1' });
  reset();
  const bansByList = new Map();
  const first = Object.assign(
    new SearchingExportBan(),
    exportBan(1, { battlemetricsID: 'pending' })
  );
  const second = Object.assign(
    new SearchingExportBan(),
    exportBan(2, { battlemetricsID: 'pending', updatedAt: new FakeDate(clock - 20 * MINUTE) })
  );
  const banID = addBan('bm-7', {
    note: note(first.id),
    identifiers: [{ type: 'steamID', identifier: steamUser(1) }]
  });
  addBan('bm-7', { note: 'x', identifiers: [{ type: 'steamID', identifier: steamUser(3) }] });
  assert.strictEqual(await first.createBattlemetricsBan(bansByList), 'found');
  assert.strictEqual(row(first.id).battlemetricsID, banID);
  assert.strictEqual(await second.createBattlemetricsBan(bansByList), 'created');
  assert.deepStrictEqual(
    reads().map(({ params }) => [params['filter[banList]'], params['filter[search]']]),
    [
      ['bm-7', steamUser(1)],
      ['bm-7', steamUser(2)]
    ]
  );
}

console.log(
  'Export ban checks passed: claims, notes, lookups of claimed bans, retries after 10 minutes, and deletions.'
);
