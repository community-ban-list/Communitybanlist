import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';

// Exercise Core.sendExportBanListAlert without a database or network requests.
const logs = [];
const sent = [];
const updates = [];
let sendError;
const dependencies = {
  'scbl-lib/apis': { steam() {} },
  'scbl-lib/db': { sequelize: {} },
  'scbl-lib/db/models': {
    ExportBan: {},
    SteamUser: {},
    ExportBanList: {
      async update(values, options) {
        updates.push({ values, where: options.where });
        return [1];
      }
    }
  },
  'scbl-lib/db/sequelize': { Op: {} },
  'scbl-lib/utils': {
    createDiscordWebhookMessage() {},
    DELETED_WEBHOOK_CODES: [10015, 50027],
    isDiscordWebhookUrl,
    Logger: { verbose: (...args) => logs.push(args.slice(2).join('')) },
    async sendDiscordWebhook(url, message) {
      sent.push({ url, message });
      if (sendError) throw sendError;
    }
  },
  'scbl-lib/config': { HOST: 'https://communitybanlist.example' },
  './run-control.js': { checkRunLock: async () => {}, stopIfRequested() {} }
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

const message = { getJSON: () => ({ embeds: ['embed'] }) };
const list = (id, discordWebhook) => ({ id, name: 'List', server: 'Server', discordWebhook });
const webhook = 'https://discord.com/api/webhooks/1/secret-token';

// Alerts go to Discord webhooks through the checked sender.
await Core.sendExportBanListAlert(list(1, webhook), message);
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].url, webhook);
assert.deepStrictEqual([...sent[0].message.embeds], ['embed']);
assert.strictEqual(logs.length, 0);

// A stored webhook that is not a Discord webhook is never called, and is reported once per run.
const internal = list(2, 'http://10.0.0.5:8080/hook');
await Core.sendExportBanListAlert(internal, message);
await Core.sendExportBanListAlert(internal, message);
assert.strictEqual(sent.length, 1);
assert.strictEqual(logs.length, 1);
assert.match(logs[0], /Skipped the Discord Webhook for Server's List "List" \(ID: 2\)/);
assert.ok(!logs[0].includes('10.0.0.5'));

// Other failures are logged without the webhook's address, and the webhook is kept.
sendError = Object.assign(new Error('Discord answered HTTP 429: You are being rate limited.'), {
  code: 0
});
await Core.sendExportBanListAlert(list(3, webhook), message);
assert.strictEqual(updates.length, 0);
assert.match(logs[1], /Failed to send Discord Webhook for .*rate limited/);

// A deleted webhook is removed from every list using it, and not tried again this run.
sendError = Object.assign(new Error('Discord answered HTTP 404: Unknown Webhook (code 10015)'), {
  code: 10015
});
await Core.sendExportBanListAlert(list(4, webhook), message);
assert.strictEqual(updates.length, 1);
assert.strictEqual(updates[0].values.discordWebhook, null);
assert.strictEqual(updates[0].where.discordWebhook, webhook);
assert.match(logs[2], /Removed the Discord Webhook from .*Unknown Webhook/);
const attempts = sent.length;
await Core.sendExportBanListAlert(list(5, webhook), message);
assert.strictEqual(sent.length, attempts);
assert.ok(!logs.some((line) => line.includes('secret-token')));

console.log('Export ban list alert checks passed: sending, invalid and deleted webhooks.');
