import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise which export bans Core.exportExportBans sends to BattleMetrics, how it reads each one
// again before sending it, and which changes it tells owners about, without a database or network
// requests. The export bans' BattleMetrics work is a stand-in that says what the model did.

const events = [];
const logs = [];
const alerts = [];
// The export bans' ids as they were read again, and the maps of BattleMetrics bans they were given.
const reads = [];
const bansByListMaps = new Set();
// What the run reads first, in the order it asks for, and what reading each export ban again
// finds, by id.
let queued = [];
let queuedOrder;
const current = new Map();

const ExportBanList = {};
const dependencies = {
  'scbl-lib/apis': { steam() {} },
  'scbl-lib/db': { sequelize: {} },
  'scbl-lib/db/models': {
    ExportBan: {
      findAll: async ({ order }) => {
        // The order comes from the module's context, so it is copied to compare it.
        queuedOrder = JSON.parse(JSON.stringify(order));
        return queued;
      },
      // As with Sequelize, an export ban read again has its list only when the read includes it.
      findOne: async ({ where, include = [] }) => {
        reads.push(where.id);
        const found = current.get(where.id);
        if (!found) return null;
        return include.includes(ExportBanList) ? found : { ...found, ExportBanList: undefined };
      }
    },
    ExportBanList,
    SteamUser: {}
  },
  'scbl-lib/db/sequelize': { Op: { in: 'in' } },
  'scbl-lib/utils': {
    createDiscordWebhookMessage: (webhook) => {
      const message = {
        setTitle(title) {
          this.title = title;
        },
        setDescription() {},
        setThumbnail() {},
        getJSON() {
          return { embeds: [this.title] };
        }
      };
      return [webhook, message];
    },
    DELETED_WEBHOOK_CODES: [10015, 50027],
    isDiscordWebhookUrl: () => true,
    Logger: { verbose: (module, level, message) => logs.push({ level, message }) },
    async sendDiscordWebhook(url, { embeds }) {
      alerts.push(`${url}: ${embeds[0]}`);
    }
  },
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
  // The reputation steps' retries are checked in lock-retries.js.
  './apply-list.js': { retryOperation: (operation) => operation() },
  // The reputation points statement is checked in reputation-points.js.
  './paused-lists.js': { default: async () => ({ rows: [], suspended: [], excluded: [] }) },
  './reputation-points.js': { recalculatePoints: () => '' },
  './run-control.js': { checkRunLock: async () => {}, stopIfRequested() {}, reportProgress() {} }
};

const context = vm.createContext({});
const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source, { context });
await module.link((specifier) => {
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
const Core = module.namespace.default;

const webhook = (id) => `https://discord.com/api/webhooks/${id}/token`;
const battlemetricsList = (id, fields = {}) => ({
  id,
  type: 'battlemetrics',
  battlemetricsID: `bm-${id}`,
  server: 'Server',
  name: `List ${id}`,
  discordWebhook: webhook(id),
  ...fields
});
const remoteList = {
  id: 99,
  type: 'remote',
  server: 'Server',
  name: 'Remote',
  discordWebhook: webhook(99)
};
const added = (list) => `${webhook(list)}: Player has been added to your export ban list.`;
const removed = (list) => `${webhook(list)}: Player has been removed from your export ban list.`;

// An export ban as the run first reads it, with the given battlemetricsID. Reading it again finds
// it the same, or with the fields in again, or not at all when again is null, and its BattleMetrics
// work resolves with result.
let exportBanCount = 0;
function exportBan(status, list, { result, again = {}, battlemetricsID = null } = {}) {
  const id = `7656119800000${String(++exportBanCount).padStart(4, '0')},${list.id}`;
  const fields = {
    id,
    status,
    battlemetricsID,
    ExportBanList: list,
    SteamUser: { id, name: 'Player' }
  };
  if (again !== null)
    current.set(id, {
      ...fields,
      ...again,
      async createBattlemetricsBan(bansByList) {
        events.push(`create ${id} on ${this.ExportBanList.battlemetricsID}`);
        bansByListMaps.add(bansByList);
        return result || 'created';
      },
      async deleteBattlemetricsBan(bansByList) {
        events.push(`delete ${id} on ${this.ExportBanList.battlemetricsID}`);
        bansByListMaps.add(bansByList);
        return result || 'deleted';
      }
    });
  return {
    ...fields,
    async save() {
      events.push(`save ${id}`);
    },
    async destroy() {
      events.push(`destroy ${id}`);
    }
  };
}

async function exportExportBans(exportBans) {
  for (const list of [events, logs, alerts, reads]) list.length = 0;
  bansByListMaps.clear();
  queued = exportBans;
  await Core.exportExportBans();
}

const reported = () =>
  logs
    .filter(({ level, message }) => level === 1 && !/^(Exporting|Finished)/.test(message))
    .map(({ message }) => message);

// A BattleMetrics export ban list whose BattleMetrics ban list was never made has its bans to be
// created left alone, rather than sent to BattleMetrics to fail on every run, and reported once
// for each such list. Its bans to be deleted are still deleted, and the alert cap counts only the
// bans that are sent, so the one deletion of 61 queued changes gets an alert of its own.
{
  const halfMade = battlemetricsList(1, { battlemetricsID: null });
  const otherHalfMade = battlemetricsList(2, { battlemetricsID: null });
  const deletion = exportBan('TO_BE_DELETED', halfMade);
  await exportExportBans([
    ...Array.from({ length: 30 }, () => exportBan('TO_BE_CREATED', halfMade)),
    deletion,
    ...Array.from({ length: 30 }, () => exportBan('TO_BE_CREATED', halfMade)),
    exportBan('TO_BE_CREATED', otherHalfMade),
    exportBan('TO_BE_CREATED', otherHalfMade)
  ]);
  assert.deepStrictEqual(events, [`delete ${deletion.id} on null`]);
  assert.deepStrictEqual(reads, [deletion.id]);
  assert.deepStrictEqual(reported(), [
    `Skipped 60 bans to add to Server's List "List 1" (ID: 1), as it has no BattleMetrics ban list to add them to.`,
    `Skipped 2 bans to add to Server's List "List 2" (ID: 2), as it has no BattleMetrics ban list to add them to.`
  ]);
  assert.deepStrictEqual(alerts, [removed(1)]);

  // The export bans are read the longest waiting first, so one BattleMetrics refused, which
  // releasing its claim changed, goes to the back of the queue.
  assert.deepStrictEqual(queuedOrder, [['updatedAt', 'ASC']]);
}

// Each export ban and its list are read again just before the export ban is sent, as the run may
// have started hours before: one deleted since, or no longer to be created or deleted as first
// read, is skipped. The others are sent as they are now, to their list's BattleMetrics ban list
// as it is now, and their alerts go to the list's webhook as it is now.
{
  const list = battlemetricsList(3);
  const changedList = { ...list, battlemetricsID: 'bm-3-new', discordWebhook: webhook(33) };
  const deleted = exportBan('TO_BE_CREATED', list, { again: null });
  const created = exportBan('TO_BE_CREATED', list, { again: { status: 'CREATED' } });
  const cancelled = exportBan('TO_BE_DELETED', list, { again: { status: 'TO_BE_CREATED' } });
  const sent = exportBan('TO_BE_CREATED', list, { again: { ExportBanList: changedList } });
  await exportExportBans([deleted, created, cancelled, sent]);
  assert.deepStrictEqual(reads, [deleted.id, created.id, cancelled.id, sent.id]);
  assert.deepStrictEqual(events, [`create ${sent.id} on bm-3-new`]);
  assert.deepStrictEqual(alerts, [added(33)]);
}

// Only export bans that were created or deleted get alerts: not one whose ban may still be being
// made, nor one that another run or a change dealt with. One whose ban an earlier run made is
// created now, and one whose ban was already gone from BattleMetrics is deleted and reported.
{
  const list = battlemetricsList(4);
  const found = exportBan('TO_BE_CREATED', list, { result: 'found' });
  const gone = exportBan('TO_BE_DELETED', list, { result: 'gone' });
  await exportExportBans([
    exportBan('TO_BE_CREATED', list, { result: 'waiting' }),
    exportBan('TO_BE_CREATED', list, { result: 'skipped' }),
    found,
    exportBan('TO_BE_DELETED', list, { result: 'waiting' }),
    exportBan('TO_BE_DELETED', list, { result: 'skipped' }),
    gone
  ]);
  assert.strictEqual(events.length, 6);
  assert.deepStrictEqual(alerts, [added(4), removed(4)]);
  assert.deepStrictEqual(reported(), [
    `Removed export ban (ID: ${gone.id}) from Lists due to error 404 during deletion.`
  ]);
}

// A list with 50 or more changes gets one alert for them all instead, but only if at least one of
// them was made.
{
  const waiting = battlemetricsList(5);
  const oneMade = battlemetricsList(6);
  await exportExportBans([
    ...Array.from({ length: 50 }, () => exportBan('TO_BE_CREATED', waiting, { result: 'waiting' })),
    ...Array.from({ length: 49 }, () => exportBan('TO_BE_CREATED', oneMade, { result: 'waiting' })),
    exportBan('TO_BE_DELETED', oneMade)
  ]);
  assert.strictEqual(events.length, 100);
  assert.deepStrictEqual(alerts, [`${webhook(6)}: We've updated your export ban list.`]);
}

// The BattleMetrics bans read to look for claimed export bans' bans are kept for the whole run, and
// read again by the next run. Remote lists' export bans are not read again, and need no request.
{
  const list = battlemetricsList(7);
  const otherList = battlemetricsList(8);
  const create = exportBan('TO_BE_CREATED', remoteList);
  const remove = exportBan('TO_BE_DELETED', remoteList);
  await exportExportBans([
    exportBan('TO_BE_CREATED', list),
    exportBan('TO_BE_DELETED', otherList),
    create,
    remove
  ]);
  assert.strictEqual(bansByListMaps.size, 1);
  const [firstRun] = bansByListMaps;
  assert.strictEqual(reads.length, 2);
  assert.deepStrictEqual(events.slice(2), [`save ${create.id}`, `destroy ${remove.id}`]);
  assert.strictEqual(create.status, 'CREATED');
  assert.deepStrictEqual(alerts.slice(2), [added(99), removed(99)]);

  await exportExportBans([exportBan('TO_BE_CREATED', list)]);
  assert.strictEqual(bansByListMaps.size, 1);
  assert.notStrictEqual([...bansByListMaps][0], firstRun);
}

// Export bans an earlier run claimed go first, so the bans BattleMetrics may have made for them are
// looked for early in the run, although claiming them made them the most recently changed. The
// others keep the order they were read in, the longest waiting first.
{
  const list = battlemetricsList(9);
  const otherList = battlemetricsList(10);
  const unclaimed = [
    exportBan('TO_BE_CREATED', list),
    exportBan('TO_BE_DELETED', otherList, { battlemetricsID: '555' }),
    exportBan('TO_BE_CREATED', otherList)
  ];
  const claimed = [
    exportBan('TO_BE_CREATED', list, { battlemetricsID: 'pending' }),
    exportBan('TO_BE_DELETED', otherList, { battlemetricsID: 'pending' })
  ];
  await exportExportBans([unclaimed[0], claimed[0], unclaimed[1], unclaimed[2], claimed[1]]);
  assert.deepStrictEqual(
    reads,
    [...claimed, ...unclaimed].map(({ id }) => id)
  );
  assert.strictEqual(events.length, 5);
}

// An export ban that had no BattleMetrics ban is deleted without telling its owner, as nothing was
// removed from the list. Nor does it count as a change made for a list's summary alert.
{
  const list = battlemetricsList(11);
  const cleared = exportBan('TO_BE_DELETED', list, { result: 'cleared' });
  await exportExportBans([cleared]);
  assert.deepStrictEqual(events, [`delete ${cleared.id} on bm-11`]);
  assert.deepStrictEqual(alerts, []);
  assert.deepStrictEqual(reported(), []);
  assert.ok(
    logs.some(
      ({ level, message }) =>
        level === 2 &&
        message === `Deleted export ban (ID: ${cleared.id}), which had no Battlemetrics ban.`
    )
  );

  const manyCleared = battlemetricsList(12);
  await exportExportBans(
    Array.from({ length: 50 }, () => exportBan('TO_BE_DELETED', manyCleared, { result: 'cleared' }))
  );
  assert.strictEqual(events.length, 50);
  assert.deepStrictEqual(alerts, []);
}

console.log(
  'Export checks passed: lists with no BattleMetrics ban list, export bans read again with their lists, claimed export bans first, and alerts for changes made.'
);
