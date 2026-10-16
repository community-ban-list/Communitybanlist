import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isSameBattlemetricsID, {
  normaliseBattlemetricsID
} from '../../scbl-lib/utils/battlemetrics-id.js';
import describeError from '../../scbl-lib/utils/describe-error.js';

// Check where the importer's steps stop when the run is asked to, and that they check the run lock
// before deleting or exporting bans, without a database or network requests.

async function until(condition, what) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// Wait for a step to end, so a broken one fails the test rather than hanging it. Resolves with what
// the step returned, or the error it threw.
function ended(promise, what) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what} to end`)), 5000);
  });
  return Promise.race([promise.catch((err) => err), timeout]).finally(() => clearTimeout(timer));
}

// The steps post no progress bars, as the run's status shows how far they have got, so the logger
// has none to give them.
const Logger = { verbose() {}, important() {} };

// Load a module of the importer with stand-ins for its dependencies, the real run-control.js, the
// real version of any other module of the importer it imports without a stand-in, such as
// ban-list-sync.js, and any other globals it needs.
async function load(path, dependencies, globals = {}) {
  const context = vm.createContext({
    console: { log() {} },
    process: { env: {} },
    // Long timeouts, such as the Steam step's 50 seconds, must not keep the test running.
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      if (ms > 1000) timer.unref();
      return timer;
    },
    clearTimeout,
    ...globals
  });
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  let control;
  await module.link(async (specifier, referencingModule) => {
    if (specifier === './run-control.js') {
      control = new vm.SourceTextModule(
        await readFile(new URL(specifier, referencingModule.identifier), 'utf8'),
        { context }
      );
      return control;
    }
    const exports = dependencies[specifier];
    if (!exports && specifier.startsWith('./')) {
      const url = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(url, 'utf8'), {
        context,
        identifier: url.href
      });
    }
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
  return { exports: module.namespace.default, control: control.namespace };
}

const heldLock = { isHeld: async () => true };
const lostLock = { isHeld: async () => false };

const steamID = (n) => `7656119800${String(n).padStart(7, '0')}`;

// A fetch that fails the first time, as during a short BattleMetrics outage, and returns these
// bans after that.
function failsOnce(bans) {
  let failed = false;
  return () => {
    if (failed) return bans;
    failed = true;
    throw Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502 }
    });
  };
}

// Load ban-importer.js with stand-ins for the database and the fetcher. lists gives each ban
// list's stored bans and the bans the fetcher returns for it, as numbers, or a function that
// returns them or throws, and optionally its source, which a test can change. The fetcher calls
// onFetch(banList, control) before it returns, each ban's save calls hooks.onSave(id) and then
// waits for its gate in saves.gates, if it has one, and each chunk of bans removed calls
// hooks.onRemove(). The waits the importer starts and clears are recorded in waits, and take no
// time once waits.instant is set. The lists' sync state is saved to nowhere, and the check of
// which BattleMetrics ban lists CBL can see is off, as import-bans.js tests both.
async function loadBanImporter(lists, { onFetch = () => {}, options } = {}) {
  const events = [];
  const lines = [];
  const saves = { gates: {} };
  const hooks = { onSave() {}, onRemove() {} };
  const waits = { started: [], cleared: [], instant: false };
  class BanFetcher {
    async fetchBanList(banList) {
      events.push(`fetch ${banList.id}`);
      await onFetch(banList, imported.control);
      const { fetched } = lists[banList.id];
      const bans = (typeof fetched === 'function' ? fetched() : fetched).map((n) => ({
        id: `${banList.id},${n}`,
        steamUser: steamID(n),
        expired: false,
        banList
      }));
      return { bans, rawCount: bans.length, firstMetaTotal: null };
    }
  }
  const imported = await load(
    '../src/ban-importer.js',
    {
      crypto: { createHash },
      'scbl-lib/apis': {
        async readBattlemetricsPages() {
          throw new Error('The access check is off');
        }
      },
      'scbl-lib/db': {
        sequelize: {
          query: async (sql, { replacements: [id] }) => {
            events.push(`read stored bans of ${id}`);
            return lists[id].stored.map((n) => ({ id: `${id},${n}`, steamUser: steamID(n) }));
          },
          transaction: async (work) => {
            events.push('begin');
            const value = await work({});
            events.push('commit');
            return value;
          }
        }
      },
      'scbl-lib/db/importer-models': {
        BanListSync: { findAll: async () => [], upsert: async () => {} }
      },
      'scbl-lib/db/models': {
        ExportBanList: { findAll: async () => [] },
        BanList: {
          findAll: async () => Object.keys(lists).map((id) => ({ id: Number(id) })),
          findByPk: async (id) => {
            events.push(`read list ${id}`);
            return { id, type: 'battlemetrics', source: lists[id].source ?? `bm-${id}` };
          }
        },
        SteamUser: {
          bulkCreate: async () => events.push('add Steam users'),
          update: async () => events.push('reset Steam users')
        },
        Ban: {
          findOrCreate: async ({ where }) => {
            events.push(`save ${where.id}`);
            hooks.onSave(where.id);
            await saves.gates[where.id];
            events.push(`saved ${where.id}`);
            return [{}, true];
          },
          destroy: async ({ where }) => {
            events.push(`remove ${where.id.length} bans`);
            await hooks.onRemove();
            return where.id.length;
          },
          count: async ({ where }) => lists[where.banList].stored.length
        }
      },
      'scbl-lib/db/sequelize': {
        ForeignKeyConstraintError: class ForeignKeyConstraintError extends Error {},
        QueryTypes: { SELECT: 'SELECT' },
        ValidationError: class ValidationError extends Error {},
        isDatabaseUnavailable: () => false
      },
      'scbl-lib/utils': {
        describeError,
        isSameBattlemetricsID,
        Logger: {
          verbose: (module, level, message) => lines.push({ level, message }),
          important: (module, message) => lines.push({ level: 1, message, important: true })
        },
        normaliseBattlemetricsID
      },
      './ban-fetcher.js': { default: BanFetcher }
    },
    {
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, waits.instant ? 0 : ms);
        timer.unref();
        waits.started.push({ ms, timer });
        return timer;
      },
      clearTimeout: (timer) => {
        waits.cleared.push(timer);
        clearTimeout(timer);
      }
    }
  );
  const BanImporter = imported.exports;
  return {
    importer: new BanImporter({ accessCheck: false, ...options }),
    control: imported.control,
    events,
    lines,
    saves,
    hooks,
    waits
  };
}

// The import's summary line.
const summary = (lines) => lines.filter((line) => /^Got /.test(line.message));

// The import stops between ban lists. A stop requested while a list's missing bans are being
// removed lets the removal finish, chunk by chunk, and the next list is not started.
{
  const stored = Array.from({ length: 2500 }, (_, n) => n);
  const { importer, control, events, hooks } = await loadBanImporter(
    { 1: { stored, fetched: [0] }, 2: { stored: [], fetched: [0] } },
    { options: { allowMassRemoval: '1' } }
  );
  control.setRunLock(heldLock);
  hooks.onRemove = () => control.requestStop('it received SIGTERM');
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('remove')),
    ['remove 1000 bans', 'remove 1000 bans', 'remove 499 bans']
  );
  assert.strictEqual(events.at(-1), 'commit');
  assert.ok(!events.includes('read list 2'));
}

// A run asked to stop while a list's bans are being saved finishes the saves under way, each with
// its player's update, and starts no more. The import ends only once all of them have finished,
// and none of the list's bans are removed, as the bans it did not save would look removed. The
// next list is not started.
{
  const open = {};
  const { importer, control, events, saves } = await loadBanImporter({
    1: { stored: [7, 8], fetched: [0, 1, 2, 3, 4] },
    2: { stored: [], fetched: [0] }
  });
  control.setRunLock(heldLock);
  for (const id of ['1,0', '1,1'])
    saves.gates[id] = new Promise((resolve) => {
      open[id] = resolve;
    });
  const result = ended(
    importer.importBans().finally(() => events.push('ended')),
    'the import'
  );
  await until(() => events.includes('save 1,1'), 'the first saves');
  control.requestStop('it received SIGTERM');

  // One save finishes and no other starts, but the import waits for the second.
  open['1,0']();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(events.slice(4), [
    'save 1,0',
    'save 1,1',
    'saved 1,0',
    'reset Steam users'
  ]);
  open['1,1']();

  const error = await result;
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, [
    'read list 1',
    'fetch 1',
    'read stored bans of 1',
    'add Steam users',
    'save 1,0',
    'save 1,1',
    'saved 1,0',
    'reset Steam users',
    'saved 1,1',
    'reset Steam users',
    'ended'
  ]);
}

// A run asked to stop while a list is fetched stops once it is fetched, before saving any of it,
// even its players.
{
  const { importer, control, events } = await loadBanImporter(
    { 1: { stored: [5], fetched: [0, 1] }, 2: { stored: [], fetched: [0] } },
    { onFetch: (banList, control) => control.requestStop('it took longer than 18000s') }
  );
  control.setRunLock(heldLock);
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.strictEqual(error.reason, 'it took longer than 18000s');
  assert.deepStrictEqual(events, ['read list 1', 'fetch 1']);
}

// Bans are removed only while the run holds the run lock: not once it has lost it, nor if it never
// took it. The bans fetched are still saved, but without the lock the next list is not started.
for (const [lock, sweeps] of [
  [heldLock, true],
  [lostLock, false],
  [null, false]
]) {
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0] },
    2: { stored: [], fetched: [0] }
  });
  if (lock) control.setRunLock(lock);
  const outcome = await ended(importer.importBans(), 'the import');
  assert.ok(events.includes('saved 1,0'));
  assert.strictEqual(events.includes('remove 1 bans'), sweeps);
  assert.strictEqual(events.includes('read list 2'), sweeps);
  if (sweeps) assert.ok(Array.isArray(outcome));
  else {
    assert.strictEqual(outcome.reason, control.LOCK_LOST);
    assert.ok(!events.includes('begin'));
  }
}

// The lock is checked before every list's sweep, not only the first: a lock found lost before the
// second list's sweep stops the run before any of that list's bans are removed.
{
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0] },
    2: { stored: [0, 8], fetched: [0] }
  });
  let checks = 0;
  control.setRunLock({ isHeld: async () => ++checks === 1 });
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.strictEqual(error.reason, control.LOCK_LOST);
  assert.ok(events.includes('saved 2,0'));
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('remove')),
    ['remove 1 bans']
  );
  assert.strictEqual(checks, 2);
}

// A list whose source was changed while its bans were saved has the bans fetched from its old
// source removed instead of the bans it no longer has, and only while the run holds the run lock.
for (const [lock, removes] of [
  [heldLock, true],
  [lostLock, false]
]) {
  const lists = { 1: { stored: [0, 9], fetched: [0, 1, 2] }, 2: { stored: [], fetched: [0] } };
  const { importer, control, events, hooks } = await loadBanImporter(lists);
  control.setRunLock(lock);
  hooks.onSave = (id) => {
    if (id === '1,1') lists[1].source = 'bm-new';
  };
  const outcome = await ended(importer.importBans(), 'the import');
  assert.ok(events.includes('saved 1,2'));
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('remove')),
    removes ? ['remove 3 bans'] : []
  );
  if (removes) assert.ok(Array.isArray(outcome));
  else assert.strictEqual(outcome.reason, control.LOCK_LOST);
}

// A stop requested while the run checks its lock before removing bans is honoured before any are
// removed.
{
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0] },
    2: { stored: [], fetched: [0] }
  });
  control.setRunLock({
    isHeld: async () => {
      control.requestStop('it received SIGTERM');
      return true;
    }
  });
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.strictEqual(error.reason, 'it received SIGTERM');
  assert.ok(events.includes('saved 1,0'));
  assert.ok(!events.includes('begin'));
}

// A list that could not be fetched is tried again a minute after the others, but the wait ends as
// soon as the run is asked to stop, which it then does without trying the list again. The import's
// summary says the run stopped.
{
  const { importer, control, events, lines, waits } = await loadBanImporter({
    1: { stored: [0], fetched: failsOnce([0]) },
    2: { stored: [], fetched: [0] }
  });
  control.setRunLock(heldLock);
  const started = Date.now();
  const result = ended(importer.importBans(), 'the import');
  await until(() => waits.started.some(({ ms }) => ms === 60 * 1000), 'the wait');
  control.requestStop('it received SIGTERM');

  const error = await result;
  assert.strictEqual(error.name, 'RunStopped');
  assert.ok(Date.now() - started < 1000);
  const { timer } = waits.started.find(({ ms }) => ms === 60 * 1000);
  assert.ok(waits.cleared.includes(timer));
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('fetch')),
    ['fetch 1', 'fetch 2']
  );
  assert.deepStrictEqual(
    summary(lines).map(({ message, important }) => [message, important]),
    [
      [
        'Got 0 deleted bans. Imported 2 ban lists before the run stopped: 1 ban fetched, 1 new, 0 updated, 0 removed, 0 held, 1 list failed.',
        undefined
      ]
    ]
  );
}

// A run asked to stop while the last list of the first pass is imported does not wait to try the
// failed lists again.
{
  const { importer, control, events, hooks, waits } = await loadBanImporter({
    1: { stored: [0], fetched: failsOnce([0]) },
    2: { stored: [0, 9], fetched: [0] }
  });
  control.setRunLock(heldLock);
  hooks.onRemove = () => control.requestStop('it received SIGTERM');
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.ok(events.includes('remove 1 bans'));
  assert.deepStrictEqual(waits.started, []);
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('fetch')),
    ['fetch 1', 'fetch 2']
  );
}

// The second attempts stop between ban lists too: a stop requested during one list's second
// attempt lets it finish, and the next list is not tried again.
{
  const { importer, control, events, hooks, lines, waits } = await loadBanImporter({
    1: { stored: [0, 9], fetched: failsOnce([0]) },
    2: { stored: [], fetched: [0] },
    3: { stored: [0], fetched: failsOnce([0]) }
  });
  control.setRunLock(heldLock);
  waits.instant = true;
  hooks.onRemove = () => control.requestStop('it received SIGTERM');
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('fetch')),
    ['fetch 1', 'fetch 2', 'fetch 3', 'fetch 1']
  );
  assert.deepStrictEqual(
    summary(lines).map(({ message }) => message),
    [
      'Got 1 deleted ban. Imported 3 ban lists before the run stopped: 2 bans fetched, 2 new, 0 updated, 1 removed, 0 held, 1 list failed.'
    ]
  );
}

// A stop requested while a list is imported at its second attempt, whether during its fetch or its
// saves, leaves the list out of the import's summary, as a stop in the first pass does, and the
// list's own line says what the attempt saved. The saves under way are finished first, and the
// list is not swept.
for (const during of ['fetch', 'saves']) {
  let fetches = 0;
  const { importer, control, events, lines, saves, waits } = await loadBanImporter(
    {
      1: { stored: [0, 9], fetched: [0] },
      2: { stored: [7], fetched: failsOnce([0, 1, 2, 3]) }
    },
    {
      onFetch: (banList, control) => {
        if (banList.id === 2 && ++fetches === 2 && during === 'fetch')
          control.requestStop('it received SIGTERM');
      }
    }
  );
  control.setRunLock(heldLock);
  waits.instant = true;
  const open = {};
  for (const id of ['2,0', '2,1'])
    saves.gates[id] = new Promise((resolve) => {
      open[id] = resolve;
    });
  const result = ended(
    importer.importBans().finally(() => events.push('ended')),
    'the import'
  );
  if (during === 'saves') {
    await until(() => events.includes('save 2,1'), "the second attempt's saves");
    control.requestStop('it received SIGTERM');
    open['2,0']();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!events.includes('ended'));
    open['2,1']();
  }

  const error = await result;
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(
    events.filter((event) => event.startsWith('fetch')),
    ['fetch 1', 'fetch 2', 'fetch 2']
  );
  assert.deepStrictEqual(
    events.filter((event) => /^(save|remove) /.test(event)),
    during === 'saves'
      ? ['save 1,0', 'remove 1 bans', 'save 2,0', 'save 2,1']
      : ['save 1,0', 'remove 1 bans']
  );
  if (during === 'saves')
    assert.deepStrictEqual(events.slice(-3), ['saved 2,1', 'reset Steam users', 'ended']);
  assert.deepStrictEqual(
    lines.filter(({ important }) => important).map(({ message }) => message),
    [
      'Failed to import ban list (ID: 2) while fetching it, so none of its bans were removed. Error: Request failed with status code 502',
      during === 'saves'
        ? 'Stopped importing ban list (ID: 2) at the second attempt while saving its bans, as the run is stopping, so none of its bans were removed (4 bans fetched, 2 new, 0 updated).'
        : 'Stopped importing ban list (ID: 2) at the second attempt while fetching it, as the run is stopping, so none of its bans were removed (4 bans fetched, 0 new, 0 updated).'
    ]
  );
  // The summary line still sums up the lists imported before the stop, in the console only.
  assert.deepStrictEqual(
    summary(lines).map(({ message, important }) => [message, important]),
    [
      [
        'Got 1 deleted ban. Imported 1 of 2 ban lists before the run stopped: 1 ban fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed.',
        undefined
      ]
    ]
  );
}

// Load ban-fetcher.js with stand-ins for BattleMetrics and axios, which are given the run control
// with each request. The waits between attempts are skipped.
async function loadBanFetcher({ battlemetrics, get }) {
  const imported = await load(
    '../src/ban-fetcher.js',
    {
      axios: { default: { get: async (url) => get(url, imported.control) } },
      'scbl-lib/apis': {
        battlemetrics: async (method, endpoint, params) => battlemetrics(params, imported.control)
      },
      'scbl-lib/utils': { classifyBanReason: () => 'Cheating', Logger }
    },
    { URL, AbortSignal, setTimeout: (callback) => setImmediate(callback) }
  );
  const BanFetcher = imported.exports;
  return new BanFetcher();
}

// The fetcher stops between the pages of a BattleMetrics list, as the largest take over a minute
// to read. Nothing of the list is returned, so nothing of it is saved.
{
  const pages = [];
  const fetcher = await loadBanFetcher({
    battlemetrics: (params, control) => {
      const page = Number(params['page[key]'] || 1);
      pages.push(page);
      if (page === 2) control.requestStop('it received SIGTERM');
      const ban = {
        attributes: {
          uid: `u${page}`,
          timestamp: '2026-01-01T00:00:00.000Z',
          identifiers: [{ type: 'steamID', identifier: steamID(page) }]
        }
      };
      return {
        data: {
          data: [ban],
          links: {
            next: `https://api.battlemetrics.com/bans?filter[banList]=bm-1&page[key]=${page + 1}&page[size]=100`
          }
        }
      };
    }
  });
  const error = await ended(
    fetcher.fetchBanList({ id: 1, type: 'battlemetrics', source: 'bm-1' }),
    'the fetch'
  );
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(pages, [1, 2]);
}

// It also stops before another attempt at a remote list.
{
  const requests = [];
  const fetcher = await loadBanFetcher({
    get: (url, control) => {
      requests.push(url);
      control.requestStop('it received SIGTERM');
      throw Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503 }
      });
    }
  });
  const error = await ended(
    fetcher.fetchBanList({ id: 2, type: 'remote', source: 'https://bans.example/2.txt' }),
    'the fetch'
  );
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(requests, ['https://bans.example/2.txt']);
}

// Load core.js with stand-ins for the models and the Steam client.
async function loadCore(models, steam = () => {}) {
  return load('../src/core.js', {
    'scbl-lib/apis': { steam },
    'scbl-lib/db': { sequelize: {} },
    'scbl-lib/db/models': { ExportBan: {}, ExportBanList: {}, SteamUser: {}, ...models },
    'scbl-lib/db/sequelize': { Op: { in: 'in', or: 'or', lt: 'lt' } },
    'scbl-lib/utils': {
      createDiscordWebhookMessage() {},
      DELETED_WEBHOOK_CODES: [10015, 50027],
      isDiscordWebhookUrl: () => false,
      Logger,
      sendDiscordWebhook() {}
    },
    'scbl-lib/config': { HOST: 'https://communitybanlist.example' }
  });
}

// Export bans with the given statuses that record their BattleMetrics requests and the database
// writes that record them, which the model makes after each request, and call onRequest(id) during
// each request. Their ids start at 1.
function exportBans(
  events,
  onRequest = () => {},
  statuses = ['TO_BE_CREATED', 'TO_BE_CREATED', 'TO_BE_DELETED']
) {
  const list = {
    id: 1,
    type: 'battlemetrics',
    battlemetricsID: 'bm-1',
    name: 'List',
    discordWebhook: null
  };
  return statuses.map((status, index) => {
    const id = index + 1;
    return {
      id,
      status,
      ExportBanList: list,
      SteamUser: { id: `7656119800000000${id}`, name: 'Player' },
      async createBattlemetricsBan() {
        events.push(`create ${id} on BattleMetrics`);
        onRequest(id);
        events.push(`save ${id}`);
        return 'created';
      },
      async deleteBattlemetricsBan() {
        events.push(`delete ${id} on BattleMetrics`);
        onRequest(id);
        events.push(`destroy ${id}`);
        return 'deleted';
      }
    };
  });
}

// The ExportBan model for the given export bans, which reads each of them again as it is.
const exportBanModel = (rows) => ({
  findAll: async () => rows,
  findOne: async ({ where }) => rows.find((row) => row.id === where.id)
});

// Exports stop between export bans: one whose BattleMetrics request is under way when the run is
// asked to stop is still saved, and the next one is not started.
{
  const events = [];
  const rows = exportBans(events, (id) => {
    if (id === 1) core.control.requestStop('it received SIGTERM');
  });
  const core = await loadCore({ ExportBan: exportBanModel(rows) });
  core.control.setRunLock(heldLock);
  const error = await ended(core.exports.exportExportBans(), 'the export');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['create 1 on BattleMetrics', 'save 1']);
}

// The same goes for a ban being deleted on BattleMetrics: its export ban is still removed, and the
// next export ban is not started.
{
  const events = [];
  const rows = exportBans(
    events,
    (id) => {
      if (id === 3) core.control.requestStop('it received SIGTERM');
    },
    ['TO_BE_CREATED', 'TO_BE_CREATED', 'TO_BE_DELETED', 'TO_BE_CREATED']
  );
  const core = await loadCore({ ExportBan: exportBanModel(rows) });
  core.control.setRunLock(heldLock);
  const error = await ended(core.exports.exportExportBans(), 'the export');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, [
    'create 1 on BattleMetrics',
    'save 1',
    'create 2 on BattleMetrics',
    'save 2',
    'delete 3 on BattleMetrics',
    'destroy 3'
  ]);
}

// Nothing reaches BattleMetrics without the run lock: once the run has lost it, or if it never
// took it.
for (const lock of [lostLock, null]) {
  const events = [];
  const core = await loadCore({ ExportBan: exportBanModel(exportBans(events)) });
  if (lock) core.control.setRunLock(lock);
  const error = await ended(core.exports.exportExportBans(), 'the export');
  assert.strictEqual(error.reason, core.control.LOCK_LOST);
  assert.deepStrictEqual(events, []);
}

// With the lock, every export ban is pushed.
{
  const pushed = [];
  const core = await loadCore({ ExportBan: exportBanModel(exportBans(pushed)) });
  core.control.setRunLock(heldLock);
  assert.strictEqual(await ended(core.exports.exportExportBans(), 'the export'), undefined);
  assert.deepStrictEqual(pushed, [
    'create 1 on BattleMetrics',
    'save 1',
    'create 2 on BattleMetrics',
    'save 2',
    'delete 3 on BattleMetrics',
    'destroy 3'
  ]);
}

// The Steam step stops between batches of 50 players.
{
  const events = [];
  const core = await loadCore(
    {
      SteamUser: {
        findAll: async () => Array.from({ length: 120 }, (_, index) => ({ id: `${index}` })),
        update: async ({ name }) => events.push(`update ${name}`)
      }
    },
    async (method, path, { steamids }) => {
      events.push(`request ${steamids.split(',').length}`);
      core.control.requestStop('it received SIGTERM');
      return { data: { response: { players: [{ steamid: '0', personaname: 'Player' }] } } };
    }
  );
  const error = await ended(core.exports.updateSteamUserInfo(), 'the Steam step');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['request 50', 'update Player']);
}

// Updating export bans stops between batches of players, after a batch's last statement. The first
// player's export bans make the batch write each kind of change.
{
  const events = [];
  const generated = (list) => ({
    id: `0,${list}`,
    status: 'TO_BE_CREATED',
    steamUser: '0',
    exportBanList: list
  });
  const manager = await load('../src/export-ban-manager.js', {
    'scbl-lib/db': {
      sequelize: {
        transaction: async (options, work) => work({})
      }
    },
    'scbl-lib/db/export-membership': {
      membershipForPlayers: async () => {
        events.push('generate');
        manager.control.requestStop('it received SIGTERM');
        return [1, 2, 3, 4].map(generated);
      }
    },
    'scbl-lib/db/models': {
      ExportBan: {
        findAll: async () => {
          events.push('read');
          return [
            [2, 'TO_BE_DELETED', null],
            [3, 'TO_BE_DELETED', '333'],
            [4, 'TO_BE_DELETED', null],
            [5, 'CREATED', '555'],
            [6, 'TO_BE_CREATED', 'pending'],
            [7, 'TO_BE_CREATED', null]
          ].map(([list, status, battlemetricsID]) => ({
            id: `0,${list}`,
            exportBanList: list,
            status,
            battlemetricsID
          }));
        },
        bulkCreate: async () => events.push('create'),
        update: async () => events.push('update'),
        destroy: async () => events.push('destroy')
      },
      ExportBanList: {
        findAll: async () =>
          [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, type: id === 4 ? 'remote' : 'battlemetrics' }))
      },
      SteamUser: {
        findAll: async () => Array.from({ length: 600 }, (_, index) => ({ id: `${index}` })),
        update: async () => events.push('mark updated')
      }
    },
    'scbl-lib/db/sequelize': {
      Op: { in: 'in', notIn: 'notIn', not: 'not', ne: 'ne', or: 'or' },
      Transaction: { ISOLATION_LEVELS: { SERIALIZABLE: 'SERIALIZABLE' } }
    },
    'scbl-lib/utils': { Logger }
  });
  const error = await ended(manager.exports.updateExportBans(), 'the export ban update');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, [
    'generate',
    'read',
    'create',
    'update',
    'update',
    'update',
    'update',
    'update',
    'destroy',
    'mark updated'
  ]);
}

console.log(
  'Importer safe point checks passed: ban lists, pages, saves, the sweep, export bans and the batched steps.'
);
