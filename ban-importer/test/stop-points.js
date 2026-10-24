import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isSameBattlemetricsID, {
  normaliseBattlemetricsID
} from '../../scbl-lib/utils/battlemetrics-id.js';
import describeError from '../../scbl-lib/utils/describe-error.js';
import logText from '../../scbl-lib/utils/log-text.js';

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
    // Long timeouts, such as the wait before a ban list is tried again, must not keep the test
    // running.
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
  let loadControl;
  await module.link(async (specifier, referencingModule) => {
    if (specifier === './run-control.js') {
      loadControl ??= readFile(new URL(specifier, referencingModule.identifier), 'utf8').then(
        (source) => new vm.SourceTextModule(source, { context })
      );
      control = await loadControl;
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
  return {
    exports: module.namespace.default,
    namespace: module.namespace,
    control: control.namespace
  };
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

// Load ban-importer.js, with the real apply-list.js, and stand-ins for the database and the
// fetcher. lists gives each ban list's stored bans and the bans the fetcher returns for it, as
// numbers, or a function that returns them or throws, and optionally its source, which a test can
// change. The fetcher calls onFetch(banList, control) before it returns. Each statement that writes
// bans calls hooks.onSave(id) for each of them and then waits for their gates in saves.gates, if
// they have any, and each batch of bans removed calls hooks.onRemove(). The waits the importer
// starts and clears are recorded in waits, and take no time once waits.instant is set. The lists'
// rows are read from syncs, and each row saved is recorded in syncSaves. The check of which
// BattleMetrics ban lists CBL can see is off, as import-bans.js tests it and the rows.
async function loadBanImporter(lists, { onFetch = () => {}, options, syncs = [] } = {}) {
  const events = [];
  const lines = [];
  const saves = { gates: {} };
  const hooks = { onSave() {}, onRemove() {} };
  const waits = { started: [], cleared: [], instant: false };
  const syncSaves = [];
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
      return { bans, rawCount: bans.length, firstMetaTotal: null, complete: true };
    }
  }
  // The statements apply-list.js sends, by their start.
  const query = async (sql, { replacements } = {}) => {
    if (sql.startsWith('SELECT id, steamUser,')) {
      const [id] = replacements;
      events.push(`read stored bans of ${id}`);
      return lists[id].stored.map((n) => ({
        id: `${id},${n}`,
        steamUser: steamID(n),
        expires: null,
        expired: 0,
        reason: null,
        rawReason: null,
        rawNote: null
      }));
    }
    if (sql.startsWith('SELECT banId,')) {
      events.push(`read missing bans of ${replacements[0]}`);
      return [];
    }
    // No list has bans waiting for a confirming read.
    if (sql.startsWith('SELECT banList, MIN(')) return [];
    if (sql.startsWith('INSERT IGNORE INTO SteamUsers')) {
      events.push('add Steam users');
      return [{}, {}];
    }
    if (sql.startsWith('INSERT INTO Bans')) {
      const ids = replacements.filter((value, i) => i % 11 === 0);
      for (const id of ids) {
        events.push(`save ${id}`);
        hooks.onSave(id);
      }
      await Promise.all(ids.map((id) => saves.gates[id]));
      for (const id of ids) events.push(`saved ${id}`);
      return [0, ids.length];
    }
    if (sql.startsWith('UPDATE SteamUsers')) {
      events.push('reset Steam users');
      return [{}, {}];
    }
    if (sql.startsWith('DELETE FROM Bans')) {
      const [, ids] = replacements;
      events.push(`remove ${ids.length} bans`);
      await hooks.onRemove();
      return [{ affectedRows: ids.length }, {}];
    }
    if (sql.startsWith('DELETE FROM BanListPendingRemovals')) return [{ affectedRows: 0 }, {}];
    if (sql.startsWith('INSERT INTO BanListPendingRemovals')) {
      events.push('save missing bans');
      return [0, 0];
    }
    throw new Error(`Unexpected statement: ${sql}`);
  };
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
          query,
          transaction: async (work) => {
            events.push('begin');
            const value = await work({});
            events.push('commit');
            return value;
          }
        }
      },
      'scbl-lib/db/importer-models': {
        BanListSync: {
          findAll: async () => syncs.map((row) => ({ ...row })),
          upsert: async (values) => {
            syncSaves.push({ ...values });
          }
        }
      },
      'scbl-lib/db/models': {
        ExportBanList: { findAll: async () => [] },
        BanList: {
          findAll: async () =>
            Object.keys(lists).map((id) => ({
              id: Number(id),
              type: 'battlemetrics',
              source: lists[id].source ?? `bm-${id}`
            })),
          findByPk: async (id) => {
            events.push(`read list ${id}`);
            return { id, type: 'battlemetrics', source: lists[id].source ?? `bm-${id}` };
          }
        },
        Ban: {
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
    waits,
    syncSaves
  };
}

// A list's row from an earlier run that failed it twice in a row.
const failedTwice = (id) => ({
  banList: id,
  sourceKey: createHash('sha256')
    .update(JSON.stringify(['battlemetrics', `bm-${id}`]))
    .digest('hex'),
  state: 'failing',
  lastAttemptAt: new Date('2026-10-16T06:00:00.000Z'),
  lastSuccessAt: new Date('2026-10-15T18:00:00.000Z'),
  consecutiveFailures: 2,
  lastError: 'Error: Request failed with status code 502',
  storedCount: 1,
  headTotal: null
});
// The state and count of failed runs of each row saved, as [list, state, failures].
const savedRows = (syncSaves) =>
  syncSaves.map(({ banList, state, consecutiveFailures }) => [banList, state, consecutiveFailures]);

// The import's summary line.
const summary = (lines) => lines.filter((line) => /^Got /.test(line.message));

// The import stops between ban lists. A stop requested while a list's missing bans are being
// removed lets the removal finish, batch by batch, and the next list is not started.
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
    [...Array(4).fill('remove 500 bans'), 'remove 499 bans']
  );
  assert.strictEqual(events.at(-1), 'commit');
  assert.ok(!events.includes('read list 2'));
}

// A run asked to stop while a list's bans are being saved finishes the batch under way, with its
// players' updates, in its transaction, and starts no other. The import ends only once that batch
// is saved, and none of the list's bans are removed, as the bans it did not save would look
// removed. The list is read again first, as one whose type or source was changed meanwhile has the
// bans it fetched removed (see below). The next list is not started.
{
  let open;
  const { importer, control, events, saves } = await loadBanImporter(
    {
      1: { stored: [7, 8], fetched: [0, 1, 2, 3, 4] },
      2: { stored: [], fetched: [0] }
    },
    { options: { batchSize: 2 } }
  );
  control.setRunLock(heldLock);
  saves.gates['1,0'] = new Promise((resolve) => {
    open = resolve;
  });
  const result = ended(
    importer.importBans().finally(() => events.push('ended')),
    'the import'
  );
  await until(() => events.includes('save 1,1'), 'the first batch');
  control.requestStop('it received SIGTERM');

  // The batch is still being saved, and the import waits for it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!events.includes('ended'));
  open();

  const error = await result;
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, [
    'read list 1',
    'fetch 1',
    'read stored bans of 1',
    'read missing bans of 1',
    'begin',
    'add Steam users',
    'save 1,0',
    'save 1,1',
    'saved 1,0',
    'saved 1,1',
    'reset Steam users',
    'commit',
    'read list 1',
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
// took it. The new bans fetched are still saved, but without the lock the next list is not started.
for (const [lock, sweeps] of [
  [heldLock, true],
  [lostLock, false],
  [null, false]
]) {
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0, 5] },
    2: { stored: [], fetched: [0] }
  });
  if (lock) control.setRunLock(lock);
  const outcome = await ended(importer.importBans(), 'the import');
  assert.ok(events.includes('saved 1,5'));
  assert.strictEqual(events.includes('remove 1 bans'), sweeps);
  assert.strictEqual(events.includes('read list 2'), sweeps);
  if (sweeps) assert.ok(Array.isArray(outcome));
  else {
    assert.strictEqual(outcome.reason, control.LOCK_LOST);
    assert.ok(!events.some((event) => event.startsWith('remove')));
  }
}

// The lock is checked before every list's sweep, not only the first: a lock found lost before the
// second list's sweep stops the run before any of that list's bans are removed.
{
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0] },
    2: { stored: [0, 8], fetched: [0, 5] }
  });
  let checks = 0;
  control.setRunLock({ isHeld: async () => ++checks === 1 });
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.strictEqual(error.reason, control.LOCK_LOST);
  assert.ok(events.includes('saved 2,5'));
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

// So does a list whose source was changed while the run was asked to stop, as when a batch of its
// bans waits for /banlist update's transaction and SIGTERM comes meanwhile: the list is read again
// once the batch is saved, and the bans fetched from its old source are removed, before the run
// stops at its next safe point, so the next list is not started. Without the run lock, none are.
for (const [lock, removes] of [
  [heldLock, true],
  [lostLock, false]
]) {
  const lists = { 1: { stored: [0, 9], fetched: [0, 1, 2] }, 2: { stored: [], fetched: [0] } };
  const { importer, control, events, hooks } = await loadBanImporter(lists);
  control.setRunLock(lock);
  hooks.onSave = (id) => {
    if (id !== '1,1') return;
    lists[1].source = 'bm-new';
    control.requestStop('it received SIGTERM');
  };
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.name, 'RunStopped');
  assert.strictEqual(error.reason, removes ? 'it received SIGTERM' : control.LOCK_LOST);
  assert.ok(events.includes('saved 1,2'));
  assert.deepStrictEqual(
    events.filter((event) => /^(read list|remove) /.test(event)),
    ['read list 1', 'read list 1', ...(removes ? ['remove 3 bans'] : [])]
  );
}

// A stop requested while the run checks its lock before removing bans is honoured before any are
// removed.
{
  const { importer, control, events } = await loadBanImporter({
    1: { stored: [0, 9], fetched: [0, 5] },
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
  assert.ok(events.includes('saved 1,5'));
  assert.ok(!events.some((event) => event.startsWith('remove')));
}

// A list that could not be fetched is tried again a minute after the others, but the wait ends as
// soon as the run is asked to stop, which it then does without trying the list again. The import's
// summary says the run stopped. The list's row, which waited for its second attempt, is saved as
// the run stops, as the run did fail it, and here, as its 3rd failed run in a row, is posted about.
{
  const { importer, control, events, lines, waits, syncSaves } = await loadBanImporter(
    {
      1: { stored: [0], fetched: failsOnce([0]) },
      2: { stored: [], fetched: [0] }
    },
    { syncs: [failedTwice(1)] }
  );
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
  assert.deepStrictEqual(savedRows(syncSaves), [
    [2, 'ok', 0],
    [1, 'failing', 3]
  ]);
  assert.deepStrictEqual(
    lines.filter(({ message }) => /^Ban list \(ID: 1\) has failed/.test(message)),
    [
      {
        level: 1,
        message:
          'Ban list (ID: 1) has failed to import 3 runs in a row, so its bans may be out of date: it was last imported at 2026-10-15T18:00:00.000Z. Its latest error: Error: Request failed with status code 502',
        important: true
      }
    ]
  );
}

// A run asked to stop while the last list of the first pass is imported does not wait to try the
// failed lists again, and saves the row of the list it would have tried again.
{
  const { importer, control, events, hooks, waits, syncSaves } = await loadBanImporter({
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
  assert.deepStrictEqual(savedRows(syncSaves), [
    [2, 'ok', 0],
    [1, 'failing', 1]
  ]);
}

// A run that loses its run lock saves no row that is still waiting, as another run may then be
// saving rows: here that of a list it would have tried again.
{
  const { importer, control, syncSaves } = await loadBanImporter(
    {
      1: { stored: [0], fetched: failsOnce([0]) },
      2: { stored: [0, 9], fetched: [0] }
    },
    { syncs: [failedTwice(1)] }
  );
  control.setRunLock(lostLock);
  const error = await ended(importer.importBans(), 'the import');
  assert.strictEqual(error.reason, control.LOCK_LOST);
  assert.deepStrictEqual(syncSaves, []);
}

// The second attempts stop between ban lists too: a stop requested during one list's second
// attempt lets it finish, and the next list is not tried again. The row of the list imported at
// its second attempt is saved by that attempt, and only then, and that of the list not tried again
// as the run stops.
{
  const { importer, control, events, hooks, lines, waits, syncSaves } = await loadBanImporter({
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
      'Got 1 deleted ban. Imported 3 ban lists before the run stopped: 2 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 1 list failed.'
    ]
  );
  assert.deepStrictEqual(savedRows(syncSaves), [
    [2, 'ok', 0],
    [1, 'ok', 0],
    [3, 'failing', 1]
  ]);
}

// A stop requested while a list is imported at its second attempt, whether during its fetch or its
// saves, leaves the list out of the import's summary, as a stop in the first pass does, and the
// list's own line says what the attempt saved, and how long it had taken, here by a clock that
// stands still. The batch under way is finished first, and the list is not swept. Its row is saved
// as its first attempt left it, as the run did fail it.
for (const during of ['fetch', 'saves']) {
  let fetches = 0;
  const { importer, control, events, lines, saves, waits, syncSaves } = await loadBanImporter(
    {
      1: { stored: [0, 9], fetched: [0] },
      2: { stored: [7], fetched: failsOnce([0, 1, 2, 3]) }
    },
    {
      onFetch: (banList, control) => {
        if (banList.id === 2 && ++fetches === 2 && during === 'fetch')
          control.requestStop('it received SIGTERM');
      },
      options: { clock: () => Date.parse('2026-10-23T15:20:00.000Z') }
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
      ? ['remove 1 bans', 'save 2,0', 'save 2,1', 'save 2,2', 'save 2,3']
      : ['remove 1 bans']
  );
  if (during === 'saves')
    assert.deepStrictEqual(events.slice(-5), [
      'saved 2,3',
      'reset Steam users',
      'commit',
      'read list 2',
      'ended'
    ]);
  assert.deepStrictEqual(
    lines.filter(({ important }) => important).map(({ message }) => message),
    [
      'Failed to import ban list (ID: 2) while fetching it, so none of its bans were removed. Error: Request failed with status code 502',
      during === 'saves'
        ? 'Stopped importing ban list (ID: 2) at the second attempt while saving its bans, after 0s, as the run is stopping, so none of its bans were removed (4 bans fetched, 4 new, 0 updated).'
        : 'Stopped importing ban list (ID: 2) at the second attempt while fetching it, after 0s, as the run is stopping, so none of its bans were removed (4 bans fetched, 0 new, 0 updated).'
    ]
  );
  // The summary line still sums up the lists imported before the stop, in the console only.
  assert.deepStrictEqual(
    summary(lines).map(({ message, important }) => [message, important]),
    [
      [
        'Got 1 deleted ban. Imported 1 of 2 ban lists before the run stopped: 1 ban fetched, 0 new, 0 updated, 1 removed, 0 held, 0 lists failed.',
        undefined
      ]
    ]
  );
  assert.deepStrictEqual(
    savedRows(syncSaves),
    [
      [1, 'ok', 0],
      [2, 'failing', 1]
    ],
    during
  );
}

// Load ban-fetcher.js with stand-ins for BattleMetrics and axios, which are given the run control
// with each request. The waits between attempts are skipped.
async function loadBanFetcher({ battlemetrics, get }) {
  const imported = await load(
    '../src/ban-fetcher.js',
    {
      axios: { default: { get: async (url) => get(url, imported.control) } },
      crypto: { createHash },
      'scbl-lib/apis': {
        battlemetrics: async (method, endpoint, params, data, priority, options) =>
          battlemetrics(params, imported.control, options)
      },
      'scbl-lib/utils': { classifyBanReason: () => 'Cheating', Logger }
    },
    { URL, AbortSignal, setTimeout: (callback) => setImmediate(callback) }
  );
  const BanFetcher = imported.exports;
  return new BanFetcher();
}

// The fetcher stops between the pages of a BattleMetrics list, as the largest take over a minute
// to read. Nothing of the list is returned, so nothing of it is saved. The stop says which page the
// read was to fetch next, for the list's line.
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
  assert.deepStrictEqual([error.page, error.pages], [3, null]);
}

// It stops before another attempt at a page too, as the BattleMetrics client calls the run
// control's stopIfRequested, which the fetcher gives it, before each attempt (see scbl-lib's
// battlemetrics.js): here the run's time limit comes while the first attempt at the second page
// waits for its answer, and the client asks before another, so the read stops there, rather than
// waiting out up to four more attempts (see page-attempts.js, which runs the real client).
{
  const attempts = [];
  const fetcher = await loadBanFetcher({
    battlemetrics: async (params, control, options) => {
      const page = Number(params['page[key]'] || 1);
      options.beforeAttempt();
      attempts.push(page);
      if (page === 2) {
        control.requestStop('it took longer than 900s');
        // The attempt times out, and the client asks whether to make another.
        options.beforeAttempt();
      }
      return {
        data: {
          data: [
            {
              attributes: {
                uid: `u${page}`,
                timestamp: '2026-01-01T00:00:00.000Z',
                identifiers: [{ type: 'steamID', identifier: steamID(page) }]
              }
            }
          ],
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
  assert.strictEqual(error.reason, 'it took longer than 900s');
  assert.deepStrictEqual(attempts, [1, 2]);
  assert.deepStrictEqual([error.page, error.pages], [2, null]);
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

// Load core.js with stand-ins for the models.
async function loadCore(models) {
  return load('../src/core.js', {
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
    'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
    './apply-list.js': { retryOperation: (operation) => operation() }
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

// The stand-ins for Sequelize and its errors that apply-list.js needs, with query() and
// transaction() given.
function database(query, transaction = async (work) => work({})) {
  class DatabaseError extends Error {}
  return {
    'scbl-lib/db': { sequelize: { query, transaction } },
    'scbl-lib/db/sequelize': {
      ForeignKeyConstraintError: DatabaseError,
      QueryTypes: { SELECT: 'SELECT' },
      ValidationError: DatabaseError,
      isDatabaseUnavailable: () => false
    }
  };
}

// The Steam step stops between calls of 100 players, once the profiles of the call under way are
// saved.
{
  const events = [];
  const players = Array.from({ length: 250 }, (_, index) => ({ id: steamID(index + 1) }));
  const profiles = await load('../src/steam-profiles.js', {
    ...database(async (sql) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [{ due: 250, new: 250 }];
      if (sql.startsWith('SELECT id FROM SteamUsers WHERE lastRefreshedInfo IS NULL'))
        return players;
      if (sql.startsWith('UPDATE SteamUsers su JOIN (VALUES')) events.push('save');
      return [{ affectedRows: 0 }, { affectedRows: 0 }];
    }),
    crypto: { createHash },
    'scbl-lib/apis': {
      async steam(method, path, { steamids }) {
        const ids = steamids.split(',');
        events.push(`request ${ids.length}`);
        profiles.control.requestStop('it received SIGTERM');
        return { data: { response: { players: ids.map((steamid) => ({ steamid })) } } };
      },
      readBattlemetricsPages: async () => []
    },
    'scbl-lib/db/importer-models': {
      ImporterState: { findByPk: async () => null, upsert: async () => {} }
    },
    'scbl-lib/utils': { describeError, Logger, normaliseBattlemetricsID }
  });
  const error = await ended(profiles.namespace.updateSteamUserInfo(), 'the Steam step');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['request 100', 'save']);
}

// The expiry step stops between transactions of 500 bans, each of which marks its bans and queues
// their players.
{
  const events = [];
  const bans = Array.from({ length: 700 }, (_, index) => ({
    id: `1,${index}`,
    steamUser: steamID(index + 1)
  }));
  const expiry = await load('../src/expiry.js', {
    ...database(
      async (sql, { replacements }) => {
        if (sql.startsWith('SELECT')) return bans;
        if (sql.startsWith('UPDATE Bans')) {
          events.push(`mark ${replacements[1].length}`);
          expiry.control.requestStop('it received SIGTERM');
        } else events.push(`queue ${replacements[0].length}`);
        return [{ affectedRows: 0 }, { affectedRows: 0 }];
      },
      async (work) => {
        events.push('begin');
        const value = await work({});
        events.push('commit');
        return value;
      }
    ),
    'scbl-lib/utils': { describeError, Logger }
  });
  const error = await ended(expiry.namespace.expireBans(), 'the expiry step');
  assert.strictEqual(error.name, 'RunStopped');
  assert.deepStrictEqual(events, ['begin', 'mark 500', 'queue 500', 'commit']);
}

// The reputation check queues the players whose points do not match their bans in batches of 500,
// each one statement, and stops between them. Asked to stop while it reads the players, it stops
// before it writes anything, also when it has nobody to queue. Either way it saves no row, so the
// next run checks again.
for (const [stopOn, found, expected, queued] of [
  ['queue', 700, ['find', 'queue 500'], 500],
  ['find', 700, ['find'], 0],
  ['find', 0, ['find'], 0]
]) {
  const events = [];
  const mismatched = Array.from({ length: found }, (_, index) => ({
    id: steamID(index + 1),
    reputationPoints: 3,
    points: '0'
  }));
  const check = await load('../src/reputation-check.js', {
    ...database(async (sql, { replacements } = {}) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [{ checked: 1000 }];
      if (sql.trim().startsWith('SELECT SU.id')) {
        events.push('find');
        if (stopOn === 'find') check.control.requestStop('it received SIGTERM');
        return mismatched;
      }
      if (sql.startsWith('UPDATE SteamUsers')) {
        events.push(`queue ${replacements[0].length}`);
        if (stopOn === 'queue') check.control.requestStop('it received SIGTERM');
        return [{ affectedRows: 0 }, { affectedRows: 0 }];
      }
      throw new Error(`Unexpected statement: ${sql}`);
    }),
    'scbl-lib/db/importer-models': {
      ImporterState: {
        findByPk: async () => null,
        upsert: async () => events.push('save the row')
      }
    },
    'scbl-lib/utils': { describeError, Logger, logText }
  });
  check.control.setRunLock(heldLock);
  const counts = {};
  const error = await ended(
    check.namespace.checkReputationPoints(counts, { startedAt: Date.now() }),
    'the reputation check'
  );
  assert.strictEqual(error.name, 'RunStopped', stopOn);
  assert.deepStrictEqual(events, expected, stopOn);
  assert.deepStrictEqual(
    { ...counts },
    { ran: true, checked: 1000, mismatched: found, queued, left: found - queued },
    stopOn
  );
}

// It writes only while the run holds the run lock, also when it has nobody to queue and would only
// save its row: not once it has lost the lock, nor if it never took it.
for (const [lock, mismatched, writes] of [
  [heldLock, 2, ['queue 2', 'save the row']],
  [heldLock, 0, ['save the row']],
  [lostLock, 2, []],
  [lostLock, 0, []],
  [null, 2, []]
]) {
  const events = [];
  const check = await load('../src/reputation-check.js', {
    ...database(async (sql, { replacements } = {}) => {
      if (sql.startsWith('SELECT COUNT(*)')) return [{ checked: 5 }];
      if (sql.trim().startsWith('SELECT SU.id'))
        return Array.from({ length: mismatched }, (_, index) => ({
          id: steamID(index + 1),
          reputationPoints: 3,
          points: '6'
        }));
      if (sql.startsWith('UPDATE SteamUsers')) events.push(`queue ${replacements[0].length}`);
      return [{ affectedRows: 0 }, { affectedRows: 0 }];
    }),
    'scbl-lib/db/importer-models': {
      ImporterState: {
        findByPk: async () => null,
        upsert: async () => events.push('save the row')
      }
    },
    'scbl-lib/utils': { describeError, Logger, logText }
  });
  if (lock) check.control.setRunLock(lock);
  const outcome = await ended(
    check.namespace.checkReputationPoints({}, { startedAt: Date.now() }),
    'the reputation check'
  );
  assert.deepStrictEqual(events, writes);
  if (writes.length === 0) {
    assert.strictEqual(outcome.name, 'RunStopped');
    assert.strictEqual(outcome.reason, check.control.LOCK_LOST);
  } else assert.strictEqual(outcome, undefined);
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
    'scbl-lib/utils': { Logger },
    './apply-list.js': { retryOperation: (operation) => operation() }
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
  'Importer safe point checks passed: ban lists, pages and their later attempts, saves, the sweep, export bans, the reputation check and the batched steps.'
);
