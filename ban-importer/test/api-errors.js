import assert from 'assert';
import { readFile } from 'fs/promises';
import { inspect } from 'util';
import vm from 'vm';

// Exercise how Core handles failed Steam and BattleMetrics requests, without a database or
// network requests.
const logs = [];
// How far the steps said they had got, for the run's status, as [done, total, unit].
const progress = [];
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
    // The steps no longer post progress bars, as the run's status shows how far they have got, so
    // the logger has none to give them.
    Logger: { verbose: (...args) => logs.push(args) },
    sendDiscordWebhook() {}
  },
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
  './run-control.js': {
    checkRunLock: async () => {},
    stopIfRequested() {},
    reportProgress: (...args) => progress.push(args)
  }
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
// Resolves with what the step counted.
async function updateSteamUsers(count, reply) {
  logs.length = 0;
  waits.length = 0;
  progress.length = 0;
  updatedUsers.length = 0;
  steamCalls = 0;
  steamReply = reply;
  users = Array.from({ length: count }, (_, i) => ({
    id: `7656119800000${String(i).padStart(4, '0')}`
  }));
  const counts = {};
  await Core.updateSteamUserInfo(counts);
  return { ...counts };
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
const someFailed = await updateSteamUsers(120, (call, params) =>
  call === 1 ? fail() : answer(params)
);
assert.strictEqual(steamCalls, 3);
assert.deepStrictEqual(errorLines(), [failedBatch(50) + unavailable]);
assert.strictEqual(logged('Failed')[3].name, 'ApiError');
assert.strictEqual(fiveSecondWaits(), 1);
assert.strictEqual(updatedUsers.length, 70);
// The step says how far it has got before each batch and once it is done, for the run's status,
// and counts how many users were due and how many it updated, for the run record.
assert.deepStrictEqual(progress, [
  [0, 120, 'Steam users'],
  [50, 120, 'Steam users'],
  [100, 120, 'Steam users'],
  [120, 120, 'Steam users']
]);
assert.deepStrictEqual(someFailed, { due: 120, updated: 70 });

// Once 3 batches in a row have failed, the step stops, as Steam is most likely down and the rest
// would fail too. Its progress and counts say how far it got.
const allFailed = await updateSteamUsers(250, fail);
assert.strictEqual(steamCalls, 3);
assert.deepStrictEqual(errorLines(), [
  failedBatch(50) + unavailable,
  failedBatch(50) + unavailable,
  `Stopped updating Steam users, as 3 batches in a row failed: ${unavailable}`
]);
assert.strictEqual(fiveSecondWaits(), 2);
assert.deepStrictEqual(progress.at(-1), [150, 250, 'Steam users']);
assert.deepStrictEqual(allFailed, { due: 250, updated: 0 });

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
// gives something else. An export ban an earlier run claimed has the battlemetricsID 'pending'.
const battlemetricsList = {
  id: 1,
  type: 'battlemetrics',
  battlemetricsID: 'bm-1',
  server: 'Server',
  name: 'List'
};
const remoteList = { id: 2, type: 'remote' };
let exportBanCount = 0;
const exportBan = (
  status,
  { list = battlemetricsList, request = () => {}, battlemetricsID = null } = {}
) => ({
  id: `${list.id},${++exportBanCount}`,
  status,
  battlemetricsID,
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
// Resolves with what the step counted.
async function exportExportBans(...bans) {
  logs.length = 0;
  progress.length = 0;
  exportBans = bans;
  const counts = {};
  await Core.exportExportBans(counts);
  return { ...counts };
}

// A BattleMetrics export ban that could not be created is logged with its error. When BattleMetrics
// did not answer, as the request timed out or was cut off, it is most likely not answering at all,
// so the list's other export bans wait for the next run, rather than each waiting as long.
const timedOut =
  'BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out';
const timeOut = () => {
  throw apiError(timedOut, { code: 'ECONNABORTED', ambiguous: true });
};
const unsure = exportBan('TO_BE_CREATED', { request: timeOut });
const waiting = exportBan('TO_BE_CREATED');
await exportExportBans(unsure, waiting);
assert.deepStrictEqual(errorLines(), [
  `Failed to create export ban (ID: ${unsure.id}): ${timedOut}`,
  `Stopped exporting bans to BattleMetrics for Server's List "List" (ID: 1) until the next run, as BattleMetrics did not answer a request, which it may have carried out.`
]);
assert.strictEqual(waiting.requests, 0);

// A request BattleMetrics answered with 5xx may have been carried out too, but its export ban stays
// claimed, so its ban is not made twice, and the list's other export bans carry on. So do they
// after a request that timed out for an export ban an earlier run claimed: its request failed
// before, so it may be the request that fails, and as claimed export bans go first, it would hold
// up its list on every run.
const badGateway = 'BattleMetrics POST bans failed: HTTP 502, so it may have been carried out';
for (const unanswered of [
  exportBan('TO_BE_CREATED', {
    request: () => {
      throw apiError(badGateway, { status: 502, ambiguous: true });
    }
  }),
  exportBan('TO_BE_CREATED', { request: timeOut, battlemetricsID: 'pending' })
]) {
  const others = [exportBan('TO_BE_CREATED'), exportBan('TO_BE_DELETED')];
  await exportExportBans(unanswered, ...others);
  assert.deepStrictEqual(
    others.map((ban) => ban.requests),
    [1, 1]
  );
  assert.deepStrictEqual(errorLines(), [
    `Failed to create export ban (ID: ${unanswered.id}): ${unanswered.battlemetricsID ? timedOut : badGateway}`
  ]);
}

// They still count towards the failures in a row, after which the list's other export bans wait.
const gatewayErrors = Array.from({ length: 3 }, () =>
  exportBan('TO_BE_CREATED', {
    request: () => {
      throw apiError(badGateway, { status: 502, ambiguous: true });
    }
  })
);
const afterThree = exportBan('TO_BE_CREATED');
await exportExportBans(...gatewayErrors, afterThree);
assert.strictEqual(afterThree.requests, 0);
assert.strictEqual(
  errorLines().at(-1),
  `Stopped exporting bans to BattleMetrics for Server's List "List" (ID: 1) until the next run, as 3 of its requests in a row failed.`
);

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
const refusedCounts = await exportExportBans(...bans);
// The step goes through every export ban, those left for the next run included, and says so for
// the run's status. It counts how many were queued, and how many were created, deleted and failed.
assert.deepStrictEqual(
  progress,
  [0, 1, 2, 3, 4].map((done) => [done, 4, 'export bans'])
);
assert.deepStrictEqual(refusedCounts, { queued: 4, created: 1, deleted: 0, failed: 1 });
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

// Once 3 BattleMetrics export ban lists in a row have stopped because BattleMetrics did not answer
// or answered with a server error, BattleMetrics is most likely down, so the BattleMetrics export
// bans left wait for the next run instead of each list waiting out its own timeouts. Remote lists'
// export bans are still updated.
const listNumbered = (id) => ({
  ...battlemetricsList,
  id,
  battlemetricsID: `bm-${id}`,
  name: `List ${id}`
});
const listStopped = (id, why) =>
  `Stopped exporting bans to BattleMetrics for Server's List "List ${id}" (ID: ${id}) until the next run, as ${why}.`;
const unanswered = 'BattleMetrics did not answer a request, which it may have carried out';
const down = [
  exportBan('TO_BE_CREATED', { list: listNumbered(11), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: listNumbered(12), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: remoteList }),
  exportBan('TO_BE_CREATED', { list: listNumbered(13), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: listNumbered(14) }),
  exportBan('TO_BE_DELETED', { list: listNumbered(15) }),
  exportBan('TO_BE_CREATED', { list: remoteList })
];
await exportExportBans(...down);
assert.deepStrictEqual(
  down.map((ban) => ban.requests),
  [1, 1, 0, 1, 0, 0, 0]
);
assert.deepStrictEqual(
  down.map((ban) => ban.status),
  [
    'TO_BE_CREATED',
    'TO_BE_CREATED',
    'CREATED',
    'TO_BE_CREATED',
    'TO_BE_CREATED',
    'TO_BE_DELETED',
    'CREATED'
  ]
);
assert.deepStrictEqual(errorLines(), [
  `Failed to create export ban (ID: ${down[0].id}): ${timedOut}`,
  listStopped(11, unanswered),
  `Failed to create export ban (ID: ${down[1].id}): ${timedOut}`,
  listStopped(12, unanswered),
  `Failed to create export ban (ID: ${down[3].id}): ${timedOut}`,
  listStopped(13, unanswered),
  'Stopped exporting bans to BattleMetrics until the next run, as it did not answer or failed for 3 export ban lists in a row, so it is most likely down.'
]);

// A list stopped by server errors counts too, but a change made on any BattleMetrics list starts
// the count again, and a list stopped because BattleMetrics refused its requests does not count, as
// BattleMetrics is answering. So these lists are each tried, and BattleMetrics is not taken to be
// down.
const serverError = 'BattleMetrics POST bans failed: HTTP 502 (Bad Gateway)';
const failWith502 = () => {
  throw apiError(serverError, { status: 502, ambiguous: true });
};
const refuseWith422 = () => {
  throw apiError(invalid, { status: 422 });
};
const counted = [
  exportBan('TO_BE_CREATED', { list: listNumbered(21), request: timeOut }),
  ...[1, 2, 3].map(() =>
    exportBan('TO_BE_CREATED', { list: listNumbered(22), request: failWith502 })
  ),
  exportBan('TO_BE_CREATED', { list: listNumbered(23) }),
  ...[1, 2, 3].map(() =>
    exportBan('TO_BE_CREATED', { list: listNumbered(24), request: refuseWith422 })
  ),
  exportBan('TO_BE_CREATED', { list: listNumbered(25), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: listNumbered(26), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: listNumbered(27) })
];
await exportExportBans(...counted);
assert.deepStrictEqual(
  counted.map((ban) => ban.requests),
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
);
assert.deepStrictEqual(
  errorLines().filter((line) => line.startsWith('Stopped')),
  [
    listStopped(21, unanswered),
    listStopped(22, '3 of its requests in a row failed'),
    listStopped(24, '3 of its requests in a row failed'),
    listStopped(25, unanswered),
    listStopped(26, unanswered)
  ]
);

// Lists stopped by server errors, BattleMetrics answering 5xx for each of their requests, count
// towards it being down just as lists whose requests went unanswered do.
const failingServer = [
  ...[31, 32].flatMap((id) =>
    [1, 2, 3].map(() =>
      exportBan('TO_BE_CREATED', { list: listNumbered(id), request: failWith502 })
    )
  ),
  exportBan('TO_BE_CREATED', { list: listNumbered(33), request: timeOut }),
  exportBan('TO_BE_CREATED', { list: listNumbered(34) })
];
await exportExportBans(...failingServer);
assert.deepStrictEqual(
  failingServer.map((ban) => ban.requests),
  [1, 1, 1, 1, 1, 1, 1, 0]
);
assert.deepStrictEqual(
  errorLines().filter((line) => line.startsWith('Stopped')),
  [
    listStopped(31, '3 of its requests in a row failed'),
    listStopped(32, '3 of its requests in a row failed'),
    listStopped(33, unanswered),
    'Stopped exporting bans to BattleMetrics until the next run, as it did not answer or failed for 3 export ban lists in a row, so it is most likely down.'
  ]
);

console.log(
  'API error checks passed: failures are logged with their errors, and the Steam step and BattleMetrics exports stop when retrying cannot help, or BattleMetrics is down.'
);
