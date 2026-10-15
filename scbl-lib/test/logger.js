import assert from 'assert';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { format } from 'util';
import vm from 'vm';

import describeError from '../utils/describe-error.js';

const Bottleneck = createRequire(import.meta.url)('bottleneck');

// A failed Discord send used to reject with nothing to catch it, which stopped the importer and the
// web server. Any rejection left unhandled fails this test.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const webhook = 'https://discord.com/api/webhooks/1/secret-token';
const emptyQueue = { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 };

// Wait for the limiter, which works through its queue in the background. This takes well under a
// second; the deadline only stops a broken logger from hanging the test.
async function until(condition, what) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

// Load the logger with a stand-in for the Discord sender, a console that records what is printed,
// and a clock that only moves when the test moves it. The real limiter is used, without its 400 ms
// spacing so the test runs quickly.
async function loadLogger(env = { DISCORD_LOG_WEBHOOK: webhook }) {
  const discord = { requests: [], reply: async () => ({ id: '1' }) };
  const output = [];
  const limiters = [];
  const timers = new Set();
  let now = 1000000;

  class FastLimiter extends Bottleneck {
    constructor(options) {
      limiters.push(options);
      super({ ...options, minTime: 0 });
    }
  }

  const dependencies = {
    chalk: { default: { white: (text) => text } },
    bottleneck: { default: FastLimiter },
    './discord-webhook.js': {
      default: async (url, { content }) => {
        const request = { type: 'send', url, content };
        discord.requests.push(request);
        return discord.reply(request);
      },
      editDiscordWebhookMessage: async (url, id, { content }) => {
        const request = { type: 'edit', url, id, content };
        discord.requests.push(request);
        return discord.reply(request);
      }
    }
  };
  const context = vm.createContext({
    URL,
    // Format what is printed as the console does, so an object logged whole would show in full.
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args))
    },
    process: { env },
    Date: { now: () => now },
    setTimeout: (callback, ms) => {
      const timer = { at: now + ms, callback, unref: () => timer };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer)
  });

  const url = new URL('../utils/logger.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    const exports = dependencies[specifier];
    if (exports) {
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
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
  const logger = module.namespace.default;

  return {
    logger,
    discord,
    output,
    limiters,
    timers,
    // Move the clock on, running the timers that fall due, in order.
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [next] = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = end;
    },
    // Wait until nothing is left to send.
    idle: () =>
      until(
        () => Object.values(logger.getLogQueue()).every((count) => count === 0),
        'the log queue to empty'
      ),
    // Wait until the limiter has nothing left, while progress bars may still have values waiting.
    settled: () =>
      until(
        () => Object.values(logger.rl.counts()).every((count) => count === 0),
        'the limiter to finish'
      )
  };
}

// The cells of the bars in progress bar messages.
const bars = (requests) => requests.map(({ content }) => content.split('[').pop().split(']')[0]);

// Errors are described in one line, by name, message and HTTP status, and other values by their
// kind only, as an object's text could be an address with a token in it.
assert.strictEqual(
  describeError(new TypeError('x is not a function')),
  'TypeError: x is not a function'
);
assert.strictEqual(
  describeError(Object.assign(new Error('socket hang up'), { response: { status: 502 } })),
  'Error: socket hang up (HTTP 502)'
);
assert.strictEqual(
  describeError({ name: 'DiscordWebhookError', message: 'Discord answered HTTP 404', status: 404 }),
  'DiscordWebhookError: Discord answered HTTP 404'
);
assert.strictEqual(
  describeError(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
  'Error: ECONNREFUSED'
);
assert.strictEqual(describeError(new Error('one\n  two')), 'Error: one two');
assert.strictEqual(describeError('Something broke'), 'Something broke');
assert.strictEqual(describeError(undefined), 'undefined');
assert.strictEqual(describeError(Symbol('reason')), 'Symbol(reason)');
assert.strictEqual(describeError(new URL(webhook)), '[object URL]');
assert.strictEqual(describeError({ config: { url: webhook } }), '[object Object]');

// Without a webhook, or with one that is not a Discord webhook, Discord logging is off, with one
// warning that never shows the address. Messages still go to the console, and progress bars do
// nothing.
for (const [env, reason] of [
  [{}, 'is not set'],
  [{ DISCORD_LOG_WEBHOOK: '' }, 'is not set'],
  [
    { DISCORD_LOG_WEBHOOK: 'https://evil.example/api/webhooks/1/secret-token' },
    'is not a Discord webhook address'
  ]
]) {
  const { logger, discord, output } = await loadLogger(env);
  assert.deepStrictEqual(output, [
    `Warning: Discord logging is off, as DISCORD_LOG_WEBHOOK ${reason}.`
  ]);

  logger.verbose('Test', 1, 'Hello');
  const progressBar = logger.discordProgressBar('Test', 'Nothing', null, 0, 2, 0);
  assert.ok(progressBar);
  assert.strictEqual(
    logger.discordProgressBar('Test', 'Nothing', progressBar, 0, 2, 2),
    progressBar
  );
  logger.flush();
  await pause();

  assert.strictEqual(discord.requests.length, 0);
  assert.deepStrictEqual({ ...logger.getLogQueue() }, emptyQueue);
  assert.deepStrictEqual(output.slice(1), ['[Test][1] Hello']);
  assert.ok(!output.join('\n').includes('secret-token'));
}

// With a webhook, messages are sent one at a time, at most one every 400 ms, and at most 200 wait.
const { logger, discord, output, limiters, timers, advance, idle, settled } = await loadLogger();
assert.strictEqual(output.length, 0);
assert.strictEqual(limiters.length, 1);
assert.strictEqual(limiters[0].maxConcurrent, 1);
assert.strictEqual(limiters[0].minTime, 400);
assert.strictEqual(limiters[0].highWater, 200);
assert.strictEqual(limiters[0].strategy, Bottleneck.strategy.OVERFLOW_PRIORITY);
assert.deepStrictEqual({ ...logger.getLogQueue() }, emptyQueue);

// Level 1 messages are sent in the background, so logging returns at once.
assert.strictEqual(logger.verbose('Test', 1, 'Hello'), undefined);
logger.verbose('Test', 2, 'Only in the console');
logger.verbose('Test', 1, 'x'.repeat(5000));
await idle();
assert.deepStrictEqual(
  discord.requests.map(({ type, url }) => [type, url]),
  [
    ['send', webhook],
    ['send', webhook]
  ]
);
assert.strictEqual(discord.requests[0].content, '[Test][1] Hello');
assert.ok(output.includes('[Test][2] Only in the console'));

// Long messages are cut to 1,900 characters, within Discord's 2,000. The console keeps all of it.
const long = discord.requests[1].content;
assert.strictEqual(long.length, 1900);
assert.ok(long.startsWith('[Test][1] xxx'));
assert.ok(long.endsWith('x…'));
assert.ok(output.includes(`[Test][1] ${'x'.repeat(5000)}`));

// Errors are reduced to their name, message and HTTP status. Nothing from the request they were
// for is logged, as it holds API keys and tokens. The console also gets the stack trace.
discord.requests.length = 0;
output.length = 0;
const axiosError = Object.assign(new Error('Request failed with status code 401'), {
  name: 'AxiosError',
  code: 'ERR_BAD_REQUEST',
  config: {
    url: 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2?key=steam-api-key',
    headers: { Authorization: 'Bearer battlemetrics-token' }
  },
  request: { path: '/v2?key=steam-api-key', _header: 'Authorization: Bearer battlemetrics-token' },
  response: { status: 401, config: { headers: { Authorization: 'Bearer battlemetrics-token' } } }
});
logger.verbose('BanFetcher', 1, 'Failed to fetch ban list (ID: 3): ', axiosError);
// A message that does not end with a space is still kept apart from the error.
logger.verbose(
  'Core',
  1,
  'Failed to update Steam users',
  Object.assign(new Error('socket hang up'), { response: { status: 502 } })
);
await idle();
assert.deepStrictEqual(
  discord.requests.map(({ content }) => content),
  [
    '[BanFetcher][1] Failed to fetch ban list (ID: 3): AxiosError: Request failed with status code 401',
    '[Core][1] Failed to update Steam users Error: socket hang up (HTTP 502)'
  ]
);
assert.match(
  output[0],
  /^\[BanFetcher\]\[1\] Failed to fetch ban list \(ID: 3\): AxiosError: Request failed with status code 401\n {4}at /
);
const logged = [...output, ...discord.requests.map(({ content }) => content)].join('\n');
for (const secret of ['steam-api-key', 'battlemetrics-token', 'Authorization', 'steampowered'])
  assert.ok(!logged.includes(secret), `Logged ${secret}`);

// A failed send is reported in the console, without the webhook's address, and is not tried again
// unless Discord was rate limiting or failing. Nothing is left unhandled.
discord.requests.length = 0;
output.length = 0;
discord.reply = async () => {
  throw Object.assign(new Error('Discord answered HTTP 404: Unknown Webhook (code 10015)'), {
    name: 'DiscordWebhookError',
    status: 404,
    code: 10015
  });
};
logger.verbose('Test', 1, 'Lost');
await idle();
discord.reply = async () => {
  throw Object.assign(new Error('Discord did not answer in time'), { name: 'DiscordWebhookError' });
};
logger.verbose('Test', 1, 'Slow');
await idle();
assert.strictEqual(discord.requests.length, 2);
assert.deepStrictEqual(
  output.filter((line) => line.startsWith('Could not')),
  [
    'Could not send a message to the Discord log: DiscordWebhookError: Discord answered HTTP 404: Unknown Webhook (code 10015)',
    'Could not send a message to the Discord log: DiscordWebhookError: Discord did not answer in time'
  ]
);
assert.ok(!output.join('\n').includes('secret-token'));

// A message Discord rate limited is sent once more, after the wait Discord asked for, which is
// capped at 10 seconds, or after 1 second when Discord failed without saying.
for (const [error, wait] of [
  [{ status: 429, retryAfter: 2.5 }, 2500],
  [{ status: 429, retryAfter: 60 }, 10000],
  [{ status: 503 }, 1000]
]) {
  discord.requests.length = 0;
  let failures = 1;
  discord.reply = async () => {
    if (failures-- > 0) throw Object.assign(new Error('Discord answered'), error);
    return { id: '1' };
  };
  logger.verbose('Test', 1, 'Busy');
  await until(() => discord.requests.length === 1 && timers.size === 1, 'the wait to retry');
  advance(wait - 1);
  await pause();
  assert.strictEqual(discord.requests.length, 1, `Retried too soon after ${JSON.stringify(error)}`);
  advance(1);
  await idle();
  assert.strictEqual(discord.requests.length, 2);
}

// It is only tried once more.
discord.requests.length = 0;
output.length = 0;
discord.reply = async () => {
  throw Object.assign(new Error('Discord answered HTTP 503'), { status: 503 });
};
logger.verbose('Test', 1, 'Down');
await until(() => timers.size === 1, 'the wait to retry');
advance(1000);
await idle();
assert.strictEqual(discord.requests.length, 2);
assert.deepStrictEqual(output.slice(1), [
  'Could not send a message to the Discord log: Error: Discord answered HTTP 503'
]);

// A progress bar is returned at once, rather than a promise of one, and posted in the background.
discord.requests.length = 0;
discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '111' : id });
const steamUsers = (progressBar, current) =>
  logger.discordProgressBar('Core', 'Updating 100 Steam users...', progressBar, 0, 100, current);
const progressBar = steamUsers(null, 0);
assert.strictEqual(typeof progressBar.then, 'undefined');
await idle();
assert.deepStrictEqual(
  discord.requests.map(({ type, content }) => [type, content]),
  [['send', `[Core] Progress on Updating 100 Steam users...\n\`\`[█${' '.repeat(49)}] 0/100\`\``]]
);

// Updates are coalesced: only the latest value is sent, 15 seconds after the last one was. Until
// then it counts as queued, so services that wait for the log queue wait for it too.
for (let current = 1; current <= 60; current++)
  assert.strictEqual(steamUsers(progressBar, current), progressBar);
assert.deepStrictEqual({ ...logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
advance(14999);
await pause();
assert.strictEqual(discord.requests.length, 1);
advance(1);
await idle();
assert.deepStrictEqual(
  discord.requests.map(({ type, id }) => [type, id]),
  [
    ['send', undefined],
    ['edit', '111']
  ]
);
assert.match(discord.requests[1].content, / 60\/100``$/);

// The final value is always sent: when it falls due, or at once when the logger is flushed, as the
// importer does before it exits.
for (let current = 61; current <= 100; current++) steamUsers(progressBar, current);
advance(5000);
await pause();
assert.strictEqual(discord.requests.length, 2);
logger.flush();
await idle();
assert.strictEqual(discord.requests.length, 3);
assert.match(discord.requests[2].content, / 100\/100``$/);
assert.strictEqual(timers.size, 0);

// A bar Discord can no longer edit, e.g. because its message was deleted, stops. One that failed
// for a moment is sent again with the next value that falls due.
let editError = Object.assign(new Error('Discord answered HTTP 502'), { status: 502 });
discord.reply = async ({ type, id }) => {
  if (type === 'edit') throw editError;
  return { id: '222' };
};
const exportProgress = (bar, current) =>
  logger.discordProgressBar('Core', 'Exporting 10 Bans...', bar, 0, 10, current);
const exportBar = exportProgress(null, 0);
await idle();
discord.requests.length = 0;
exportProgress(exportBar, 5);
advance(15000);
await until(() => discord.requests.length === 1 && timers.size === 1, 'the edit to be retried');
advance(1000);
await settled();
// The edit was tried twice, and its value waits to be sent with the next one.
assert.strictEqual(discord.requests.length, 2);
assert.deepStrictEqual({ ...logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
editError = Object.assign(new Error('Discord answered HTTP 404: Unknown Message'), { status: 404 });
advance(15000);
await idle();
assert.strictEqual(discord.requests.length, 3);
assert.match(discord.requests[2].content, / 5\/10``$/);
exportProgress(exportBar, 10);
logger.flush();
advance(60000);
await idle();
assert.strictEqual(discord.requests.length, 3);
assert.deepStrictEqual({ ...logger.getLogQueue() }, emptyQueue);

// If a bar's first message could not be posted, updating it does nothing, rather than posting new
// messages.
discord.requests.length = 0;
output.length = 0;
discord.reply = async () => {
  throw Object.assign(new Error('Discord did not answer in time'), { name: 'DiscordWebhookError' });
};
const lostBar = exportProgress(null, 0);
await idle();
discord.reply = async () => ({ id: '333' });
for (let current = 1; current <= 10; current++) exportProgress(lostBar, current);
logger.flush();
advance(60000);
await idle();
assert.strictEqual(discord.requests.length, 1);
assert.deepStrictEqual(output, [
  'Could not post a progress bar in the Discord log: DiscordWebhookError: Discord did not answer in time'
]);

// Bars are 1 to 50 cells long. A full bar of 182 used to round to 51 cells and throw.
discord.requests.length = 0;
for (const [current, max] of [
  [182, 182],
  [0, 182],
  [50, 100],
  [500, 182],
  [0, 0]
])
  logger.discordProgressBar('Core', 'Exporting Bans...', null, 0, max, current);
await idle();
assert.deepStrictEqual(
  bars(discord.requests).map((bar) => [bar.length, bar.replaceAll(' ', '').length]),
  [
    [50, 50],
    [50, 1],
    [50, 25],
    [50, 50],
    [50, 50]
  ]
);
assert.match(discord.requests[0].content, /] 182\/182``$/);

// While Discord is slow, at most 200 messages wait. When more arrive, progress bars are dropped
// first and errors are kept over other messages. Logging still returns at once, the drops are
// reported once, and nothing is left unhandled.
const slow = await loadLogger();
let release;
const blocked = new Promise((resolve) => (release = resolve));
slow.discord.reply = async () => {
  if (slow.discord.requests.length === 1) await blocked;
  return { id: '1' };
};
slow.logger.verbose('Test', 1, 'First');
await until(() => slow.discord.requests.length === 1, 'the first message to be sent');
const droppedBar = slow.logger.discordProgressBar('Test', 'Waiting...', null, 0, 1, 0);
for (let i = 1; i <= 250; i++) slow.logger.verbose('Test', 1, `Message ${i}`);
for (let i = 1; i <= 100; i++) slow.logger.verbose('Test', 1, `Error ${i}: `, new Error('Failed'));
await until(() => slow.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
assert.deepStrictEqual(
  { ...slow.logger.getLogQueue() },
  { ...emptyQueue, QUEUED: 200, EXECUTING: 1 }
);
assert.strictEqual(slow.output.filter((line) => line.includes('falling behind')).length, 1);

// The dropped bar is never posted, and updating it does nothing.
slow.logger.discordProgressBar('Test', 'Waiting...', droppedBar, 0, 1, 1);
release();
await slow.idle();
const sent = slow.discord.requests.map(({ content }) => content);
assert.strictEqual(sent.length, 201);
assert.strictEqual(sent[0], '[Test][1] First');
assert.strictEqual(sent[1], '[Test][1] Error 1: Error: Failed');
assert.strictEqual(sent[100], '[Test][1] Error 100: Error: Failed');
assert.strictEqual(sent[101], '[Test][1] Message 101');
assert.strictEqual(sent[200], '[Test][1] Message 200');
assert.ok(!sent.some((content) => content.includes('Waiting')));

await pause();
assert.deepStrictEqual(unhandled, []);

console.log(
  'Logger checks passed: Discord off, failed sends, retries, long messages, errors, progress bars and the queue limit.'
);
