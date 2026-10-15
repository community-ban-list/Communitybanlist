import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import isDiscordWebhookUrl from '../utils/discord-webhook-url.js';

// Discord webhook addresses, as Discord's apps give them out.
for (const url of [
  'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123',
  'https://discordapp.com/api/webhooks/1/token',
  'https://ptb.discord.com/api/webhooks/1/token',
  'https://canary.discord.com/api/v10/webhooks/1/token',
  'https://discord.com/api/webhooks/1/token/',
  'https://discord.com/api/webhooks/1/token?thread_id=42',
  'HTTPS://DISCORD.COM/api/webhooks/1/token',
  'https://discord.com:443/api/webhooks/1/token'
])
  assert.ok(isDiscordWebhookUrl(url), `Should accept ${url}`);

// Anything that could make the web server or importer call another host, or another endpoint.
for (const url of [
  undefined,
  null,
  42,
  '',
  'not a url',
  'http://discord.com/api/webhooks/1/token',
  'https://discord.com.evil.example/api/webhooks/1/token',
  'https://discordxcom/api/webhooks/1/token',
  'https://evil.example/api/webhooks/1/token',
  'https://evildiscord.com/api/webhooks/1/token',
  'https://notdiscordapp.com/api/webhooks/1/token',
  'https://media.discord.com/api/webhooks/1/token',
  'https://discord.com/x/api/webhooks/1/token',
  'https://127.0.0.1/api/webhooks/1/token',
  'https://discord.com:8443/api/webhooks/1/token',
  'https://user:pass@discord.com/api/webhooks/1/token',
  'https://evil.example@discord.com/api/webhooks/1/token',
  'https://discord.com/api/webhooks/1',
  'https://discord.com/api/webhooks/abc/token',
  'https://discord.com/api/webhooks/1/token/messages/2',
  'https://discord.com/api/webhooks/1/token/../../users/@me',
  'https://discord.com/api/webhooks/1/%2e%2e',
  'https://discord.com/api/webhooks/1/token?wait=true',
  'https://discord.com/api/webhooks/1/token?thread_id=1&x=2',
  'https://discord.com/api/webhooks/1/token#fragment',
  'https://discord.com/invite/abc'
])
  assert.ok(!isDiscordWebhookUrl(url), `Should reject ${url}`);

// Exercise the sender and the webhook test without network requests.
const requests = [];
let reply;
const axios = {
  async post(url, body, options) {
    requests.push({ method: 'post', url, body, options });
    return reply();
  },
  async patch(url, body, options) {
    requests.push({ method: 'patch', url, body, options });
    return reply();
  }
};
const context = vm.createContext({ URL, AbortSignal });

async function load(path) {
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    if (specifier === 'axios') {
      return new vm.SyntheticModule(
        ['default'],
        function () {
          this.setExport('default', axios);
        },
        { context }
      );
    }
    assert.ok(specifier.startsWith('./'), `Unexpected dependency: ${specifier}`);
    const dependency = new URL(specifier, referencingModule.identifier);
    return new vm.SourceTextModule(await readFile(dependency, 'utf8'), {
      context,
      identifier: dependency.href
    });
  });
  await module.evaluate();
  return module.namespace;
}

const { default: send, editDiscordWebhookMessage: edit } = await load(
  '../utils/discord-webhook.js'
);
const { default: testWebhook } = await load('../utils/test-discord-webhook.js');
const webhook = 'https://discord.com/api/webhooks/1/secret-token';

// A message is posted as CBL, to the webhook with wait=true, with a timeout and no redirects.
reply = () => ({ status: 200, data: { id: 'message' } });
assert.strictEqual((await send(webhook, { embeds: ['embed'] })).id, 'message');
const [request] = requests;
assert.strictEqual(request.method, 'post');
assert.strictEqual(request.url, `${webhook}?wait=true`);
assert.strictEqual(request.body.username, 'Community Ban List');
assert.strictEqual(request.body.content, null);
assert.deepStrictEqual([...request.body.embeds], ['embed']);
assert.deepStrictEqual([...request.body.allowed_mentions.parse], []);
assert.strictEqual(request.options.timeout, 10000);
assert.strictEqual(request.options.maxRedirects, 0);
assert.ok(request.options.signal instanceof AbortSignal);
assert.ok(request.options.validateStatus(500));

// A thread is kept, and a trailing slash dropped, when wait=true is added.
await send('https://discord.com/api/webhooks/1/token/?thread_id=42');
assert.strictEqual(
  requests[1].url,
  'https://discord.com/api/webhooks/1/token?thread_id=42&wait=true'
);

// Discord's error code reaches the caller, so deleted webhooks can be recognised, and the
// webhook's address never appears in the error.
reply = () => ({ status: 404, data: { message: 'Unknown Webhook', code: 10015 } });
await assert.rejects(send(webhook), (err) => {
  assert.strictEqual(err.name, 'DiscordWebhookError');
  assert.strictEqual(err.status, 404);
  assert.strictEqual(err.code, 10015);
  assert.strictEqual(err.message, 'Discord answered HTTP 404: Unknown Webhook (code 10015)');
  return true;
});
reply = () => ({ status: 502, data: '<html>Bad gateway</html>' });
await assert.rejects(send(webhook), /^DiscordWebhookError: Discord answered HTTP 502$/);
// A webhook that never answers is cut off by the abort signal, which axios reports as canceled.
for (const code of ['ERR_CANCELED', 'ECONNABORTED']) {
  reply = () => {
    throw Object.assign(new Error(`canceled ${webhook}`), { code });
  };
  await assert.rejects(send(webhook), /^DiscordWebhookError: Discord did not answer in time$/);
}
reply = () => {
  throw Object.assign(new Error(`connect ECONNREFUSED for ${webhook}`), { code: 'ECONNREFUSED' });
};
await assert.rejects(
  send(webhook),
  /^DiscordWebhookError: Could not reach Discord \(ECONNREFUSED\)$/
);

// When Discord rate limits a request, the error says how many seconds it asked to wait, from its
// answer or else from the Retry-After header.
reply = () => ({
  status: 429,
  data: { message: 'You are being rate limited.', retry_after: 1.5, global: false },
  headers: { 'retry-after': '2' }
});
await assert.rejects(send(webhook), (err) => {
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.retryAfter, 1.5);
  assert.strictEqual(err.message, 'Discord answered HTTP 429: You are being rate limited.');
  return true;
});
reply = () => ({
  status: 429,
  data: '<html>Too many requests</html>',
  headers: { 'retry-after': '3' }
});
await assert.rejects(send(webhook), (err) => err.retryAfter === 3);
reply = () => ({ status: 503, data: {}, headers: {} });
await assert.rejects(send(webhook), (err) => err.status === 503 && err.retryAfter === undefined);

// A message the webhook posted can be edited, e.g. to update a progress bar, with the same time
// limits and without following redirects.
requests.length = 0;
reply = () => ({ status: 200, data: { id: '123' } });
assert.strictEqual((await edit(webhook, '123', { content: 'Updated' })).id, '123');
assert.strictEqual(requests[0].method, 'patch');
assert.strictEqual(requests[0].url, `${webhook}/messages/123`);
assert.strictEqual(requests[0].body.content, 'Updated');
assert.deepStrictEqual([...requests[0].body.embeds], []);
assert.deepStrictEqual([...requests[0].body.allowed_mentions.parse], []);
assert.strictEqual(requests[0].options.timeout, 10000);
assert.strictEqual(requests[0].options.maxRedirects, 0);
assert.ok(requests[0].options.signal instanceof AbortSignal);
assert.ok(requests[0].options.validateStatus(500));

// The thread a message was posted in is kept.
await edit('https://discord.com/api/webhooks/1/token/?thread_id=42', '123', { content: 'x' });
assert.strictEqual(
  requests[1].url,
  'https://discord.com/api/webhooks/1/token/messages/123?thread_id=42'
);

// Edits fail like sends, with Discord's error and how long to wait.
reply = () => ({ status: 429, data: { message: 'Slow down', retry_after: 0.25 } });
await assert.rejects(edit(webhook, '123'), (err) => err.status === 429 && err.retryAfter === 0.25);
reply = () => ({ status: 404, data: { message: 'Unknown Message', code: 10008 } });
await assert.rejects(
  edit(webhook, '123'),
  /^DiscordWebhookError: Discord answered HTTP 404: Unknown Message \(code 10008\)$/
);

// Anything else is refused before a request is made, so an edit cannot reach another endpoint.
requests.length = 0;
await assert.rejects(send('https://evil.example/api/webhooks/1/token'), /Invalid Discord webhook/);
await assert.rejects(testWebhook('http://127.0.0.1/hook'), /^Error: Invalid Discord Webhook$/);
await assert.rejects(
  edit('https://evil.example/api/webhooks/1/token', '1'),
  /Invalid Discord webhook/
);
for (const id of [undefined, '', '12a', '1/../../2', '../messages', '1?wait=true'])
  await assert.rejects(edit(webhook, id), /^DiscordWebhookError: Invalid Discord message$/);
assert.strictEqual(requests.length, 0);

// The webhook test posts a message, and explains failures without the address.
reply = () => ({ status: 200, data: {} });
await testWebhook(webhook);
assert.match(requests[0].body.content, /testing your Discord webhook/);
reply = () => ({ status: 401, data: { message: 'Invalid Webhook Token', code: 50027 } });
await assert.rejects(testWebhook(webhook), (err) => {
  assert.strictEqual(
    err.message,
    'We could not post a test message to your Discord webhook. Discord answered HTTP 401: Invalid Webhook Token (code 50027).'
  );
  assert.ok(!err.message.includes('secret-token'));
  return true;
});

console.log('Discord webhook checks passed: address validation, sending, editing, and errors.');
