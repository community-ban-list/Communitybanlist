import assert from 'assert';
import async from 'async';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check where the importer's steps stop when the run is asked to, and that they check the run lock
// before deleting or exporting bans, without a database or network requests.

async function until(condition, what) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// Wait for a step to end, so a broken one fails the test rather than hanging it.
function ended(promise, what) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what} to end`)), 5000);
  });
  return Promise.race([promise.catch((err) => err), timeout]).finally(() => clearTimeout(timer));
}

const Logger = { verbose() {}, discordProgressBar: () => ({}) };

// Load a module of the importer with stand-ins for its dependencies, and the real run-control.js.
async function load(path, dependencies) {
  const context = vm.createContext({
    console: { log() {} },
    process: { env: {} },
    // Long timeouts, such as the Steam step's 50 seconds, must not keep the test running.
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      if (ms > 1000) timer.unref();
      return timer;
    }
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

// Load ban-importer.js with stand-ins for the database and the fetcher, which calls
// fetch(banList, storeBans, control) for each list.
async function loadBanImporter({ fetch }) {
  const events = [];
  const saves = { gate: null };
  const banLists = [{ id: 1 }, { id: 2 }];
  class BanFetcher {
    constructor(storeBans) {
      this.storeBans = storeBans;
    }

    async fetchBanList(banList) {
      events.push(`fetch ${banList.id}`);
      await fetch(banList, this.storeBans, imported.control);
    }
  }
  const imported = await load('../src/ban-importer.js', {
    async: { default: async },
    'scbl-lib/db/models': {
      BanList: { findAll: async () => banLists },
      SteamUser: {
        bulkCreate: async () => events.push('add Steam users'),
        update: async () => events.push('reset Steam users')
      },
      Ban: {
        findOrCreate: async ({ where }) => {
          events.push(`save ${where.id}`);
          await saves.gate;
          events.push(`saved ${where.id}`);
          return [{}, true];
        },
        findAll: async () => {
          events.push('find deleted bans');
          return [];
        },
        destroy: async () => events.push('delete bans')
      }
    },
    'scbl-lib/db/sequelize': { Op: { in: 'in', notIn: 'notIn' } },
    'scbl-lib/utils': { Logger },
    './ban-fetcher.js': { default: BanFetcher }
  });
  return { ...imported, events, saves };
}

const bans = (banList, count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${banList.id},${index}`,
    steamUser: `7656119800000000${index}`,
    banList
  }));

// The import stops between ban lists. The bans being saved are finished, those still waiting are
// dropped, and the sweep that deletes the bans not seen in the run never runs.
{
  let openGate;
  const {
    exports: BanImporter,
    control,
    events,
    saves
  } = await loadBanImporter({
    fetch: async (banList, storeBans, { requestStop }) => {
      // Two bans start saving and wait, and three more wait to be saved.
      saves.gate = new Promise((resolve) => {
        openGate = resolve;
      });
      await storeBans(bans(banList, 5));
      requestStop('it received SIGTERM');
    }
  });
  control.setRunLock(heldLock);
  const importer = new BanImporter();
  const result = ended(
    importer.importBans().finally(() => events.push('stopped')),
    'the import'
  );
  await until(() => events.includes('save 1,1'), 'the first saves');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!events.includes('stopped'));
  openGate();

  // The import ends once both saves have finished, including resetting their players.
  const error = await result;
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events.slice(0, 4), [
    'fetch 1',
    'add Steam users',
    'save 1,0',
    'save 1,1'
  ]);
  assert.deepStrictEqual(events.slice(4, -1).sort(), [
    'reset Steam users',
    'reset Steam users',
    'saved 1,0',
    'saved 1,1'
  ]);
  assert.strictEqual(events.at(-1), 'stopped');

  // Bans fetched as the run stops are not queued to be saved.
  await importer.queueBan(bans({ id: 1 }, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(events.filter((event) => event.startsWith('save ')).length, 2);
}

// A run asked to stop while the last list is fetched skips the sweep too.
{
  const {
    exports: BanImporter,
    control,
    events
  } = await loadBanImporter({
    fetch: async (banList, storeBans, { requestStop }) => {
      if (banList.id === 2) requestStop('it took longer than 18000s');
    }
  });
  control.setRunLock(heldLock);
  const error = await ended(new BanImporter().importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['fetch 1', 'fetch 2']);
}

// The sweep only runs while the run holds the run lock.
for (const [lock, sweeps] of [
  [heldLock, true],
  [lostLock, false]
]) {
  const {
    exports: BanImporter,
    control,
    events
  } = await loadBanImporter({ fetch: async () => {} });
  control.setRunLock(lock);
  const error = await ended(new BanImporter().importBans(), 'the import');
  assert.strictEqual(events.includes('find deleted bans'), sweeps);
  assert.strictEqual(events.includes('delete bans'), sweeps);
  if (sweeps) assert.strictEqual(error, undefined);
  else assert.strictEqual(error.reason, control.LOCK_LOST);
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
      isDiscordWebhookUrl: () => false,
      Logger,
      sendDiscordWebhook() {}
    },
    'scbl-lib/config': { HOST: 'https://communitybanlist.example' }
  });
}

// Export bans that record their BattleMetrics requests and saves, and call onRequest(id) during
// each request.
function exportBans(events, onRequest = () => {}) {
  const list = { id: 1, type: 'battlemetrics', name: 'List', discordWebhook: null };
  return [1, 2, 3].map((id) => ({
    id,
    status: id === 3 ? 'TO_BE_DELETED' : 'TO_BE_CREATED',
    ExportBanList: list,
    SteamUser: { id: `7656119800000000${id}`, name: 'Player' },
    async createBattlemetricsBan() {
      events.push(`create ${id} on BattleMetrics`);
      onRequest(id);
    },
    async deleteBattlemetricsBan() {
      events.push(`delete ${id} on BattleMetrics`);
      onRequest(id);
    },
    async save() {
      events.push(`save ${id}`);
    },
    async destroy() {
      events.push(`destroy ${id}`);
    }
  }));
}

// Exports stop between export bans: one whose BattleMetrics request is under way when the run is
// asked to stop is still saved, and the next one is not started.
{
  const events = [];
  const rows = exportBans(events, (id) => {
    if (id === 1) core.control.requestStop('it received SIGTERM');
  });
  const core = await loadCore({ ExportBan: { findAll: async () => rows } });
  core.control.setRunLock(heldLock);
  const error = await ended(core.exports.exportExportBans(), 'the export');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['create 1 on BattleMetrics', 'save 1']);
}

// Nothing reaches BattleMetrics without the run lock: once the run has lost it, or if it never
// took it.
for (const lock of [lostLock, null]) {
  const events = [];
  const core = await loadCore({ ExportBan: { findAll: async () => exportBans(events) } });
  if (lock) core.control.setRunLock(lock);
  const error = await ended(core.exports.exportExportBans(), 'the export');
  assert.strictEqual(error.reason, core.control.LOCK_LOST);
  assert.deepStrictEqual(events, []);
}

// With the lock, every export ban is pushed.
{
  const pushed = [];
  const core = await loadCore({ ExportBan: { findAll: async () => exportBans(pushed) } });
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

// Updating export bans stops between batches of players, after a batch's last statement.
{
  const events = [];
  const manager = await load('../src/export-ban-manager.js', {
    'scbl-lib/db': {
      sequelize: {
        transaction: async (options, work) => work({}),
        query: async () => {
          events.push('generate');
          manager.control.requestStop('it received SIGTERM');
          return [];
        }
      }
    },
    'scbl-lib/db/models': {
      ExportBan: {
        bulkCreate: async () => events.push('create'),
        update: async () => events.push('update'),
        destroy: async () => events.push('destroy')
      },
      SteamUser: {
        findAll: async () => Array.from({ length: 600 }, (_, index) => ({ id: `${index}` })),
        update: async () => events.push('mark updated')
      }
    },
    'scbl-lib/db/sequelize': {
      Op: { in: 'in', notIn: 'notIn' },
      QueryTypes: { SELECT: 'SELECT' },
      Transaction: { ISOLATION_LEVELS: { SERIALIZABLE: 'SERIALIZABLE' } }
    },
    'scbl-lib/utils': { Logger }
  });
  const error = await ended(manager.exports.updateExportBans(), 'the export ban update');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, [
    'generate',
    'create',
    'update',
    'update',
    'destroy',
    'mark updated'
  ]);
}

console.log(
  'Importer safe point checks passed: ban lists, the sweep, export bans and the batched steps.'
);
