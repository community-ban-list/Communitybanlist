import assert from 'assert';
import { readFile } from 'fs/promises';
import { inspect } from 'util';
import vm from 'vm';

// Exercise how Core handles failed Steam and BattleMetrics requests, without a database or
// network requests.
const KEY = 'secret-steam-key';
const logs = [];
let steamCalls = 0;
let steamError;
let users = [];
let exportBans = [];
const dependencies = {
  'scbl-lib/apis': {
    async steam() {
      steamCalls++;
      throw steamError;
    }
  },
  'scbl-lib/db': { sequelize: {} },
  'scbl-lib/db/models': {
    ExportBan: { findAll: async () => exportBans },
    ExportBanList: {},
    // The step takes users off the list it gets as it goes, so it gets a copy.
    SteamUser: { findAll: async () => [...users] }
  },
  'scbl-lib/db/sequelize': { Op: {} },
  'scbl-lib/utils': {
    createDiscordWebhookMessage() {},
    isDiscordWebhookUrl: () => false,
    Logger: {
      verbose: (...args) => logs.push(args),
      discordProgressBar: () => null
    },
    sendDiscordWebhook() {}
  },
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' }
};

// The 5 second wait after a failed batch of Steam users is skipped.
const context = vm.createContext({ setTimeout: (callback) => setImmediate(callback) });
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

// An error from a request, which could still hold the request and so the key.
function requestError(message, details) {
  return Object.assign(new Error(message), details, {
    config: { params: { key: KEY } },
    request: { path: `/ISteamUser/GetPlayerSummaries/v2?key=${KEY}` }
  });
}

// Lines logged at level 1, which also go to Discord. Each must be a message alone, with no error
// object for the console to print.
function errorLines() {
  assert.ok(!inspect(logs, { depth: null }).includes(KEY));
  for (const args of logs)
    assert.strictEqual(args.length, 3, `Logged more than a message: ${args}`);
  return logs.filter(([, level]) => level === 1).map(([, , message]) => message);
}

// A failed batch of Steam users is logged by its message, and the next batch is still tried.
users = Array.from({ length: 120 }, (_, i) => ({
  id: `7656119800000${String(i).padStart(4, '0')}`
}));
steamError = requestError('Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 503', {
  status: 503,
  auth: false
});
await Core.updateSteamUserInfo();
assert.strictEqual(steamCalls, 3);
assert.deepStrictEqual(
  errorLines().filter((line) => line.startsWith('Failed')),
  [50, 50, 20].map(
    (size) =>
      `Failed to update batch of ${size} Steam users due to Error: Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 503`
  )
);

// When Steam refuses the key, the step stops, as every other batch would be refused too.
logs.length = 0;
steamCalls = 0;
steamError = requestError('Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 403', {
  status: 403,
  auth: true
});
await Core.updateSteamUserInfo();
assert.strictEqual(steamCalls, 1);
assert.deepStrictEqual(
  errorLines().filter((line) => line.startsWith('Stopped') || line.startsWith('Failed')),
  [
    'Stopped updating Steam users, as Steam refused the API key: Steam GET ISteamUser/GetPlayerSummaries/v2 failed: HTTP 403'
  ]
);

// A BattleMetrics export ban that could not be created is logged by its message.
const exportBan = (status, request) => ({
  id: `1,${status}`,
  status,
  ExportBanList: { id: 1, type: 'battlemetrics' },
  SteamUser: { id: '76561198000000001' },
  createBattlemetricsBan: request,
  deleteBattlemetricsBan: request,
  async destroy() {
    this.destroyed = true;
  }
});
logs.length = 0;
exportBans = [
  exportBan('TO_BE_CREATED', async () => {
    throw requestError(
      'BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out',
      { code: 'ECONNABORTED', ambiguous: true }
    );
  })
];
await Core.exportExportBans();
assert.ok(
  errorLines().includes(
    'Failed to create export ban (ID: 1,TO_BE_CREATED): BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out'
  )
);

// A BattleMetrics ban that is already gone when it is deleted still counts as deleted, as the
// error keeps its status where it was.
logs.length = 0;
exportBans = [
  exportBan('TO_BE_DELETED', async () => {
    throw requestError('BattleMetrics DELETE bans/42 failed: HTTP 404 (Not Found)', {
      response: { status: 404, data: { errors: [{ title: 'Not Found' }] } }
    });
  })
];
await Core.exportExportBans();
assert.strictEqual(exportBans[0].destroyed, true);
assert.ok(
  errorLines().includes(
    'Removed export ban (ID: 1,TO_BE_DELETED) from Lists due to error 404 during deletion.'
  )
);

console.log(
  'API error checks passed: Steam and BattleMetrics failures are logged by message, and a refused Steam key stops the step.'
);
