import assert from 'assert';
import { readFile } from 'fs/promises';
import { inspect } from 'util';
import vm from 'vm';

// Exercise how Core handles failed Steam and BattleMetrics requests, without a database or
// network requests.
const logs = [];
// How long each wait Core asked for was, in milliseconds.
const waits = [];
let steamCalls = 0;
let steamReply;
let users = [];
const updatedUsers = [];
let exportBans = [];
const dependencies = {
  'scbl-lib/apis': {
    async steam(method, path, params) {
      steamCalls++;
      return steamReply(steamCalls, params);
    }
  },
  'scbl-lib/db': { sequelize: {} },
  'scbl-lib/db/models': {
    ExportBan: {
      findAll: async () => exportBans,
      // Reading an export ban again finds it as it is.
      findOne: async ({ where }) => exportBans.find((exportBan) => exportBan.id === where.id)
    },
    ExportBanList: {},
    SteamUser: {
      // The step takes users off the list it gets as it goes, so it gets a copy.
      findAll: async () => [...users],
      update: async (values, { where }) => updatedUsers.push(where.id)
    }
  },
  'scbl-lib/db/sequelize': { Op: {} },
  'scbl-lib/utils': {
    createDiscordWebhookMessage() {},
    // core.js imports this from here once the change to Discord logging is merged.
    DELETED_WEBHOOK_CODES: [10015, 50027],
    isDiscordWebhookUrl: () => false,
    Logger: {
      verbose: (...args) => logs.push(args),
      discordProgressBar: () => null
    },
    sendDiscordWebhook() {}
  },
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
  // core.js imports these once the change that runs one importer at a time is merged.
  './run-control.js': { checkRunLock: async () => {}, stopIfRequested() {} }
};

// Waits are recorded and skipped, such as the 5 seconds after a failed batch of Steam users.
const context = vm.createContext({
  setTimeout: (callback, ms) => {
    waits.push(ms);
    setImmediate(callback);
  }
});
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

// An error as the API clients throw one: an ApiError, which never holds the request it was for, so
// the key is not in it. scbl-lib/test/battlemetrics.js and steam.js check that it is not.
function apiError(message, { status, ...details } = {}) {
  const err = Object.assign(new Error(message), { name: 'ApiError', status, ...details });
  if (status) err.response = { status, data: { errors: [] } };
  return err;
}

// The lines logged at level 1, which also go to Discord, as the logger shows them: an error passed
// after a message has its message added to it. Only errors are passed after a message, so the
// logger can describe them and print their stack traces. The lines each step starts or finishes
// with are left out.
function errorLines() {
  for (const [, , , ...extras] of logs)
    for (const extra of extras) assert.ok(extra instanceof Error, `Logged ${inspect(extra)}`);
  return logs
    .filter(([, level, message]) => level === 1 && !/^(Exporting|Finished)/.test(message))
    .map(([, , message, err]) => (err ? message + err.message : message));
}

// The arguments of the first line logged with the given start.
const logged = (start) => logs.find(([, , message]) => message.startsWith(start));

const fiveSecondWaits = () => waits.filter((ms) => ms === 5000).length;

// Update the given number of Steam users, 50 to a batch, with steam() answering with reply().
async function updateSteamUsers(count, reply) {
  logs.length = 0;
  waits.length = 0;
  updatedUsers.length = 0;
  steamCalls = 0;
  steamReply = reply;
  users = Array.from({ length: count }, (_, i) => ({
    id: `7656119800000${String(i).padStart(4, '0')}`
  }));
  await Core.updateSteamUserInfo();
}

const unavailable = 'Steam GET ISteamUser/GetPlayerSummaries/v2 failed after 3 attempts: HTTP 503';
const fail = () => {
  throw apiError(unavailable, { status: 503, auth: false });
};
const answer = (params) => ({
  data: {
    response: { players: params.steamids.split(',').map((steamid) => ({ steamid })) }
  }
});
const failedBatch = (size) => `Failed to update batch of ${size} Steam users due to Error: `;

// A failed batch of Steam users is logged with its error, and the next batch is still tried.
await updateSteamUsers(120, (call, params) => (call === 1 ? fail() : answer(params)));
assert.strictEqual(steamCalls, 3);
assert.deepStrictEqual(errorLines(), [failedBatch(50) + unavailable]);
assert.strictEqual(logged('Failed')[3].name, 'ApiError');
assert.strictEqual(fiveSecondWaits(), 1);
assert.strictEqual(updatedUsers.length, 70);

// Once 3 batches in a row have failed, the step stops, as Steam is most likely down and the rest
// would fail too.
await updateSteamUsers(250, fail);
assert.strictEqual(steamCalls, 3);
assert.deepStrictEqual(errorLines(), [
  failedBatch(50) + unavailable,
  failedBatch(50) + unavailable,
  `Stopped updating Steam users, as 3 batches in a row failed: ${unavailable}`
]);
assert.strictEqual(fiveSecondWaits(), 2);

// Batches that fail between batches that work do not stop the step.
await updateSteamUsers(300, (call, params) => ([3, 6].includes(call) ? answer(params) : fail()));
assert.strictEqual(steamCalls, 6);
assert.deepStrictEqual(errorLines(), Array(4).fill(failedBatch(50) + unavailable));
assert.strictEqual(updatedUsers.length, 100);

// When Steam still answers 429 after the client's own retries and minute-long pauses, the step
// stops at once, as every other batch would wait out the same pauses.
const limited = 'Steam GET ISteamUser/GetPlayerSummaries/v2 failed after 3 attempts: HTTP 429';
await updateSteamUsers(120, () => {
  throw apiError(limited, { status: 429, auth: false });
});
assert.strictEqual(steamCalls, 1);
assert.deepStrictEqual(errorLines(), [
  `Stopped updating Steam users, as Steam is still limiting requests: ${limited}`
]);
assert.strictEqual(fiveSecondWaits(), 0);

// When Steam refuses the key, the step stops, as every other batch would be refused too.
const refused = 'Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 403';
await updateSteamUsers(120, () => {
  throw apiError(refused, { status: 403, auth: true });
});
assert.strictEqual(steamCalls, 1);
assert.deepStrictEqual(errorLines(), [
  `Stopped updating Steam users, as Steam refused the API key: ${refused}`
]);
assert.strictEqual(fiveSecondWaits(), 0);

// An export ban, on a BattleMetrics list unless another is given, whose BattleMetrics requests
// call request(). They resolve with what the model would: 'created' or 'deleted' unless request()
// gives something else.
const battlemetricsList = {
  id: 1,
  type: 'battlemetrics',
  battlemetricsID: 'bm-1',
  server: 'Server',
  name: 'List'
};
const remoteList = { id: 2, type: 'remote' };
let exportBanCount = 0;
const exportBan = (status, { list = battlemetricsList, request = () => {} } = {}) => ({
  id: `${list.id},${++exportBanCount}`,
  status,
  ExportBanList: list,
  SteamUser: { id: '76561198000000001' },
  requests: 0,
  async createBattlemetricsBan() {
    this.requests++;
    return (await request()) || 'created';
  },
  async deleteBattlemetricsBan() {
    this.requests++;
    return (await request()) || 'deleted';
  },
  async save() {
    this.saved = true;
  },
  async destroy() {
    this.destroyed = true;
  }
});
async function exportExportBans(...bans) {
  logs.length = 0;
  exportBans = bans;
  await Core.exportExportBans();
}

// A BattleMetrics export ban that could not be created is logged with its error. As BattleMetrics
// may have made its ban, the list's other export bans wait for the next run, which looks for it.
const timedOut =
  'BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out';
const unsure = exportBan('TO_BE_CREATED', {
  request: () => {
    throw apiError(timedOut, { code: 'ECONNABORTED', ambiguous: true });
  }
});
const waiting = exportBan('TO_BE_CREATED');
await exportExportBans(unsure, waiting);
assert.deepStrictEqual(errorLines(), [
  `Failed to create export ban (ID: ${unsure.id}): ${timedOut}`,
  `Stopped exporting bans to BattleMetrics for Server's List "List" (ID: 1) until the next run, as BattleMetrics may have carried out a request that failed.`
]);
assert.strictEqual(waiting.requests, 0);

// Any other error is passed to the logger too, so its stack trace is printed, such as one from
// the database once the BattleMetrics ban was made.
const saveError = new TypeError("Cannot read properties of undefined (reading 'update')");
const unsaved = exportBan('TO_BE_CREATED', {
  request: () => {
    throw saveError;
  }
});
await exportExportBans(unsaved);
const [, , failedExport, exportError] = logged('Failed');
assert.strictEqual(failedExport, `Failed to create export ban (ID: ${unsaved.id}): `);
assert.strictEqual(exportError, saveError);

// A BattleMetrics ban that was already gone when it was deleted still counts as deleted, and is
// reported.
const gone = exportBan('TO_BE_DELETED', { request: () => 'gone' });
await exportExportBans(gone);
assert.strictEqual(gone.requests, 1);
assert.deepStrictEqual(errorLines(), [
  `Removed export ban (ID: ${gone.id}) from Lists due to error 404 during deletion.`
]);

// Once 3 of a list's requests in a row have failed, creations or deletions, its other export bans
// wait for the next run, as BattleMetrics would most likely refuse them too. Other lists carry on.
const invalid = 'BattleMetrics POST bans failed: HTTP 422 (Invalid ban list)';
const deleteFailed = 'BattleMetrics DELETE bans/42 failed after 3 attempts: HTTP 503';
const rejected = (status = 'TO_BE_CREATED') =>
  exportBan(status, {
    request: () => {
      throw status === 'TO_BE_CREATED'
        ? apiError(invalid, { status: 422 })
        : apiError(deleteFailed, { status: 503 });
    }
  });
const otherList = { ...battlemetricsList, id: 3, battlemetricsID: 'bm-3', name: 'Other' };
const failing = [
  rejected(),
  rejected('TO_BE_DELETED'),
  rejected(),
  exportBan('TO_BE_CREATED'),
  exportBan('TO_BE_DELETED')
];
const other = exportBan('TO_BE_CREATED', { list: otherList });
await exportExportBans(failing[0], failing[1], other, ...failing.slice(2));
assert.deepStrictEqual(
  failing.map((ban) => ban.requests),
  [1, 1, 1, 0, 0]
);
assert.strictEqual(other.requests, 1);
assert.deepStrictEqual(errorLines(), [
  `Failed to create export ban (ID: ${failing[0].id}): ${invalid}`,
  `Failed to delete export ban (ID: ${failing[1].id}): ${deleteFailed}`,
  `Failed to create export ban (ID: ${failing[2].id}): ${invalid}`,
  `Stopped exporting bans to BattleMetrics for Server's List "List" (ID: 1) until the next run, as 3 of its requests in a row failed.`
]);

// Failures with changes made in between do not stop the list, so a few export bans BattleMetrics
// refuses cannot hold up the rest of their list.
const mixed = [
  rejected(),
  rejected(),
  exportBan('TO_BE_CREATED'),
  rejected(),
  rejected(),
  exportBan('TO_BE_DELETED'),
  rejected(),
  exportBan('TO_BE_CREATED')
];
await exportExportBans(...mixed);
assert.deepStrictEqual(
  mixed.map((ban) => ban.requests),
  [1, 1, 1, 1, 1, 1, 1, 1]
);
assert.ok(!errorLines().some((line) => line.startsWith('Stopped')));

// Once BattleMetrics refuses the key, the BattleMetrics export bans left wait for the next run, as
// it would refuse them too. Remote lists' export bans are still updated.
const unauthorized = 'BattleMetrics POST bans failed: HTTP 401 (Unauthorized)';
const refuse = () => {
  throw apiError(unauthorized, { status: 401, auth: true });
};
const bans = [
  exportBan('TO_BE_CREATED', { request: refuse }),
  exportBan('TO_BE_CREATED', { request: refuse }),
  exportBan('TO_BE_CREATED', { list: remoteList }),
  exportBan('TO_BE_DELETED', { request: refuse })
];
await exportExportBans(...bans);
assert.deepStrictEqual(
  bans.map((ban) => ban.requests),
  [1, 0, 0, 0]
);
assert.deepStrictEqual(
  bans.map((ban) => [ban.status, Boolean(ban.saved), Boolean(ban.destroyed)]),
  [
    ['TO_BE_CREATED', false, false],
    ['TO_BE_CREATED', false, false],
    ['CREATED', true, false],
    ['TO_BE_DELETED', false, false]
  ]
);
assert.deepStrictEqual(errorLines(), [
  `Stopped exporting bans to BattleMetrics until the next run, as BattleMetrics refused the API key: ${unauthorized}`
]);

console.log(
  'API error checks passed: failures are logged with their errors, and the Steam step and BattleMetrics exports stop when retrying cannot help.'
);
