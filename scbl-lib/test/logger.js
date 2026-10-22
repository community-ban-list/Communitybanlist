import assert from 'assert';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { format } from 'util';
import vm from 'vm';

import describeError, { stackTrace } from '../utils/describe-error.js';

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
// spacing so the test runs quickly, and with a shorter queue when highWater is given.
async function loadLogger(env = { DISCORD_LOG_WEBHOOK: webhook }, { highWater } = {}) {
  const discord = { requests: [], reply: async () => ({ id: '1' }) };
  const output = [];
  const limiters = [];
  const timers = new Set();
  let now = 1000000;

  class FastLimiter extends Bottleneck {
    constructor(options) {
      limiters.push(options);
      super({ ...options, minTime: 0, highWater: highWater ?? options.highWater });
    }
  }

  // Requests are recorded as they are made, with how many were being made at once, and, for a
  // post, how long it gives Discord to answer, if not the usual time.
  const request = async (details) => {
    discord.requests.push(details);
    discord.inFlight++;
    discord.mostInFlight = Math.max(discord.mostInFlight, discord.inFlight);
    try {
      return await discord.reply(details);
    } finally {
      discord.inFlight--;
    }
  };
  Object.assign(discord, { inFlight: 0, mostInFlight: 0 });
  const dependencies = {
    chalk: { default: { white: (text) => text } },
    bottleneck: { default: FastLimiter },
    './discord-webhook.js': {
      DELETED_WEBHOOK_CODES: [10015, 50027],
      default: async (url, { content, embeds }, { timeout } = {}) =>
        request({ type: 'send', url, content, embeds, timeout }),
      editDiscordWebhookMessage: async (url, id, { content, embeds }) =>
        request({ type: 'edit', url, id, content, embeds }),
      getDiscordWebhookMessage: async (url, id) => request({ type: 'get', url, id })
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
    // Timers note whether they were told not to keep the process running.
    setTimeout: (callback, ms) => {
      const timer = { at: now + ms, ms, callback, unrefed: false };
      timer.unref = () => Object.assign(timer, { unrefed: true });
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

// The services' handlers for unhandled rejections, and the console, also print where an error was
// thrown: the lines of its stack trace, which hold only function and file names. The first line is
// left out, as it repeats the message, and anything without a stack gives nothing.
function whereThrown() {
  return new TypeError(`Cannot read properties of ${webhook}`);
}
const thrown = whereThrown();
const trace = stackTrace(thrown);
assert.match(trace, /^\n {4}at whereThrown \(.*test\/logger\.js:\d+:\d+\)\n {4}at /);
assert.strictEqual(
  trace,
  thrown.stack
    .split('\n')
    .slice(1)
    .map((line) => `\n${line}`)
    .join('')
);
assert.ok(!trace.includes('Cannot read') && !trace.includes('secret-token'));
for (const reason of [undefined, null, 'Something broke', 42, { code: 1 }, { stack: 42 }])
  assert.strictEqual(stackTrace(reason), '');

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

// Errors as the Discord sender throws them.
const discordError = (message, fields) =>
  Object.assign(new Error(message), { name: 'DiscordWebhookError', network: false, ...fields });
const networkError = (message) => discordError(message, { network: true });

// A failed send is reported in the console, without the webhook's address, and is not tried again
// unless Discord was rate limiting or failing, or could not be reached. An error without an HTTP
// status, such as for a webhook the sender refused, is only tried again when it is marked as a
// network error. Nothing is left unhandled.
discord.requests.length = 0;
output.length = 0;
discord.reply = async () => {
  throw discordError('Discord answered HTTP 400: Invalid Form Body (code 50035)', {
    status: 400,
    code: 50035
  });
};
logger.verbose('Test', 1, 'Lost');
await idle();
discord.reply = async () => {
  throw discordError('Invalid Discord webhook');
};
logger.verbose('Test', 1, 'Refused');
await idle();
assert.strictEqual(discord.requests.length, 2);
assert.deepStrictEqual(
  output.filter((line) => line.startsWith('Could not')),
  [
    'Could not send a message to the Discord log: DiscordWebhookError: Discord answered HTTP 400: Invalid Form Body (code 50035)',
    'Could not send a message to the Discord log: DiscordWebhookError: Invalid Discord webhook'
  ]
);
assert.ok(!output.join('\n').includes('secret-token'));
assert.strictEqual(logger.discordWebhook, webhook);

// A message Discord could not be reached for, or did not answer in time, is tried twice more,
// after 1 and then 3 seconds, so a network blip of a few seconds loses nothing.
for (const [message, failures, attempts] of [
  ['Could not reach Discord (ECONNRESET)', 2, 3],
  ['Discord did not answer in time', 1, 2],
  // It gives up after the third attempt.
  ['Could not reach Discord (EAI_AGAIN)', 3, 3]
]) {
  discord.requests.length = 0;
  output.length = 0;
  let left = failures;
  discord.reply = async () => {
    if (left-- > 0) throw networkError(message);
    return { id: '1' };
  };
  logger.verbose('Test', 1, 'Blip');
  for (const [tries, wait] of [
    [1, 1000],
    [2, 3000]
  ].slice(0, attempts - 1)) {
    await until(() => discord.requests.length === tries && timers.size === 1, 'the wait to retry');
    advance(wait - 1);
    await pause();
    assert.strictEqual(discord.requests.length, tries, `Retried too soon after ${message}`);
    advance(1);
  }
  await idle();
  assert.strictEqual(discord.requests.length, attempts);
  assert.deepStrictEqual(
    output.filter((line) => line.startsWith('Could not')),
    failures < attempts
      ? []
      : [`Could not send a message to the Discord log: DiscordWebhookError: ${message}`]
  );
}

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

// A progress bar is returned at once, rather than a promise of one, and posted in the background
// once it has existed for a minute without being finished. Until then nothing is sent, and it does
// not count as waiting to be sent, as its step may finish sooner.
discord.requests.length = 0;
discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '111' : id });
const steamUsers = (progressBar, current) =>
  logger.discordProgressBar('Core', 'Updating 100 Steam users...', progressBar, 0, 100, current);
const progressBar = steamUsers(null, 0);
assert.strictEqual(typeof progressBar.then, 'undefined');
advance(59999);
await pause();
assert.strictEqual(discord.requests.length, 0);
assert.deepStrictEqual({ ...logger.getLogQueue() }, emptyQueue);
advance(1);
await idle();
assert.deepStrictEqual(
  discord.requests.map(({ type, content }) => [type, content]),
  [['send', `[Core] Progress on Updating 100 Steam users...\n\`\`[█${' '.repeat(49)}] 0/100\`\``]]
);
// Unlike a status message's, its post has the usual time for Discord to answer.
assert.strictEqual(discord.requests[0].timeout, undefined);

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
advance(60000);
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
// A deleted message stops only its bar, and Discord logging stays on.
editError = discordError('Discord answered HTTP 404: Unknown Message (code 10008)', {
  status: 404,
  code: 10008
});
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
assert.strictEqual(logger.discordWebhook, webhook);
logger.verbose('Test', 1, 'Still logging');
await idle();
assert.strictEqual(discord.requests.length, 4);
assert.strictEqual(discord.requests[3].content, '[Test][1] Still logging');

// If a bar's first message could not be posted, updating it does nothing, rather than posting new
// messages. Unlike other messages, it is not tried again after a network error.
discord.requests.length = 0;
output.length = 0;
discord.reply = async () => {
  throw networkError('Discord did not answer in time');
};
const lostBar = exportProgress(null, 0);
advance(60000);
await idle();
assert.strictEqual(timers.size, 0);
discord.reply = async () => ({ id: '333' });
for (let current = 1; current <= 10; current++) exportProgress(lostBar, current);
logger.flush();
advance(60000);
await idle();
assert.strictEqual(discord.requests.length, 1);
assert.deepStrictEqual(output, [
  'Could not post a progress bar in the Discord log: DiscordWebhookError: Discord did not answer in time'
]);

// Bars are 1 to 50 cells long. A full bar of 182 used to round to 51 cells and throw. Each bar is
// posted unfinished, a minute after it is made, and its value sent when the logger is flushed.
const cellUpdates = [
  [182, 182],
  [0, 182],
  [50, 100],
  [500, 182]
].map(([current, max]) => {
  const bar = logger.discordProgressBar('Core', 'Exporting Bans...', null, 0, max, 0);
  return () => logger.discordProgressBar('Core', 'Exporting Bans...', bar, 0, max, current);
});
advance(60000);
await idle();
discord.requests.length = 0;
for (const update of cellUpdates) update();
logger.flush();
await idle();
assert.deepStrictEqual(
  bars(discord.requests).map((bar) => [bar.length, bar.replaceAll(' ', '').length]),
  [
    [50, 50],
    [50, 1],
    [50, 25],
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
slow.advance(60000);
for (let i = 1; i <= 250; i++) slow.logger.verbose('Test', 1, `Message ${i}`);
for (let i = 1; i <= 100; i++) slow.logger.verbose('Test', 1, `Error ${i}: `, new Error('Failed'));
await until(() => slow.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
assert.deepStrictEqual(
  { ...slow.logger.getLogQueue() },
  { ...emptyQueue, QUEUED: 200, EXECUTING: 1 }
);
assert.strictEqual(slow.output.filter((line) => line.includes('falling behind')).length, 1);

// The bar was due to be posted, a minute after it was made, but was dropped. It is never posted,
// and updating it does nothing.
assert.strictEqual(droppedBar.stopped, true);
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

// A run's own lines, such as its failure and summary, go ahead of every waiting message, and push
// out the oldest of the least important, so they still reach the log channel when per-item errors
// fill the queue, which still holds no more than its limit. These checks use a queue of 10 rather
// than 200, so they run quickly.
const busy = await loadLogger(undefined, { highWater: 10 });
let releaseBusy;
const busyBlocked = new Promise((resolve) => (releaseBusy = resolve));
busy.discord.reply = async () => {
  if (busy.discord.requests.length === 1) await busyBlocked;
  return { id: '1' };
};
busy.logger.verbose('Test', 1, 'First');
await until(() => busy.discord.requests.length === 1, 'the first message to be sent');
for (let i = 1; i <= 15; i++) busy.logger.verbose('Test', 1, `Error ${i}: `, new Error('Failed'));
assert.strictEqual(
  busy.logger.important('Test', 'The run failed: ', new Error('Broken')),
  undefined
);
busy.logger.important('Test', 'Finished');
await until(() => busy.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
assert.deepStrictEqual(
  { ...busy.logger.getLogQueue() },
  { ...emptyQueue, QUEUED: 10, EXECUTING: 1 }
);
releaseBusy();
await busy.idle();
assert.deepStrictEqual(
  busy.discord.requests.map(({ content }) => content),
  [
    '[Test][1] First',
    '[Test][1] The run failed: Error: Broken',
    '[Test][1] Finished',
    ...[3, 4, 5, 6, 7, 8, 9, 10].map((i) => `[Test][1] Error ${i}: Error: Failed`)
  ]
);
// In the console they are level 1 lines like any other, with the error's stack trace.
assert.match(
  busy.output.find((line) => line.includes('The run failed')),
  /^\[Test\]\[1\] The run failed: Error: Broken\n {4}at /
);

// A posted bar whose edit is dropped while the queue is full is not left stuck: its value waits
// again, and the latest value is sent when the next one is due.
const stuck = await loadLogger(undefined, { highWater: 10 });
let releaseStuck;
const stuckBlocked = new Promise((resolve) => (releaseStuck = resolve));
stuck.discord.reply = async ({ type, id, content }) => {
  if (content.includes('Blocker')) await stuckBlocked;
  return { id: type === 'send' ? '1' : id };
};
const stuckBar = stuck.logger.discordProgressBar('Test', 'Edit', null, 0, 10, 0);
stuck.advance(60000);
await stuck.idle();
stuck.logger.verbose('Test', 1, 'Blocker');
await until(() => stuck.discord.requests.length === 2, 'the blocker to be sent');
stuck.logger.discordProgressBar('Test', 'Edit', stuckBar, 0, 10, 5);
stuck.advance(15000);
await pause();
// The edit now waits behind the blocker, and is pushed out by the 10th message. The bar's value
// then waits again, beside the 10 messages.
for (let i = 1; i <= 15; i++) stuck.logger.verbose('Test', 1, `Message ${i}`);
await until(() => stuck.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
assert.strictEqual(stuckBar.sending, false);
assert.deepStrictEqual(
  { ...stuck.logger.getLogQueue() },
  { ...emptyQueue, QUEUED: 11, EXECUTING: 1 }
);
stuck.logger.discordProgressBar('Test', 'Edit', stuckBar, 0, 10, 7);
releaseStuck();
await stuck.settled();
stuck.advance(15000);
await stuck.idle();
const stuckEdits = stuck.discord.requests.filter(({ type }) => type === 'edit');
assert.strictEqual(stuckEdits.length, 1);
assert.match(stuckEdits[0].content, /] 7\/10``$/);
assert.deepStrictEqual({ ...stuck.logger.getLogQueue() }, emptyQueue);
assert.strictEqual(stuck.timers.size, 0);

// A bar flushed while its last value is still being sent sends the newer value as soon as that send
// finishes, without waiting 15 seconds.
const held = await loadLogger();
let releaseHeld;
const holding = new Promise((resolve) => (releaseHeld = resolve));
held.discord.reply = async ({ type, id }) => {
  if (held.discord.requests.length === 1) await holding;
  return { id: type === 'send' ? '444' : id };
};
const heldBar = held.logger.discordProgressBar('Test', 'Holding...', null, 0, 10, 0);
held.advance(60000);
await until(() => held.discord.requests.length === 1, 'the bar to be posted');
held.logger.discordProgressBar('Test', 'Holding...', heldBar, 0, 10, 10);
held.logger.flush();
releaseHeld();
await held.idle();
assert.deepStrictEqual(
  held.discord.requests.map(({ type, id }) => [type, id]),
  [
    ['send', undefined],
    ['edit', '444']
  ]
);
assert.match(held.discord.requests[1].content, / 10\/10``$/);
assert.strictEqual(held.timers.size, 0);

// A bar Discord posted without saying which message it is stops, rather than posting a new message
// for every update.
const noID = await loadLogger();
noID.discord.reply = async () => ({});
const noIDBar = noID.logger.discordProgressBar('Test', 'No ID...', null, 0, 10, 0);
noID.advance(60000);
await noID.idle();
for (let current = 1; current <= 10; current++)
  noID.logger.discordProgressBar('Test', 'No ID...', noIDBar, 0, 10, current);
noID.logger.flush();
noID.advance(60000);
await noID.idle();
assert.strictEqual(noID.discord.requests.length, 1);
assert.deepStrictEqual(noID.output, [
  'Could not post a progress bar in the Discord log: Error: Discord did not say which message it posted'
]);

// When Discord says the log webhook is gone, because it was deleted or its token was reset, Discord
// logging is turned off with one warning, as Discord asks that such a webhook is not used again.
// Nothing more is sent: not the messages and progress bars already waiting, nor new ones.
const warnings = (output) => output.filter((line) => /^(Warning|Could not)/.test(line));
const goneWarning = (reason) =>
  `Warning: Discord logging is off, as Discord says the DISCORD_LOG_WEBHOOK webhook no longer exists: DiscordWebhookError: ${reason}`;
const gone = await loadLogger();
gone.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '555' : id });
const goneBar = gone.logger.discordProgressBar('Test', 'Gone...', null, 0, 10, 0);
// A bar that has nothing waiting to be sent when the webhook is found to be gone.
const idleBar = gone.logger.discordProgressBar('Test', 'Idle...', null, 0, 10, 0);
gone.advance(60000);
await gone.idle();
gone.discord.requests.length = 0;
gone.discord.reply = async () => {
  throw discordError('Discord answered HTTP 404: Unknown Webhook (code 10015)', {
    status: 404,
    code: 10015
  });
};
gone.logger.discordProgressBar('Test', 'Gone...', goneBar, 0, 10, 5);
for (let i = 1; i <= 3; i++) gone.logger.verbose('Test', 1, `Line ${i}`);
const newBar = gone.logger.discordProgressBar('Test', 'New...', null, 0, 10, 0);
await gone.settled();
assert.strictEqual(gone.discord.requests.length, 1);
assert.strictEqual(gone.logger.discordWebhook, null);
assert.deepStrictEqual({ ...gone.logger.getLogQueue() }, emptyQueue);
assert.strictEqual(gone.timers.size, 0);
gone.logger.verbose('Test', 1, 'Later');
gone.logger.discordProgressBar('Test', 'Gone...', goneBar, 0, 10, 10);
gone.logger.discordProgressBar('Test', 'Idle...', idleBar, 0, 10, 10);
gone.logger.discordProgressBar('Test', 'New...', newBar, 0, 10, 10);
gone.logger.discordProgressBar('Test', 'Another...', null, 0, 10, 0);
// Updates stop the bars at once, rather than leaving values to wait, and the bar made just before
// the webhook was found to be gone is never posted.
assert.strictEqual(gone.timers.size, 0);
assert.strictEqual(gone.logger.waitingMessages.size, 0);
assert.strictEqual(gone.logger.unpostedMessages.size, 0);
gone.logger.flush();
gone.advance(60000);
await gone.settled();
assert.strictEqual(gone.discord.requests.length, 1);
assert.deepStrictEqual(warnings(gone.output), [
  goneWarning('Discord answered HTTP 404: Unknown Webhook (code 10015)')
]);
// Jobs still in the limiter make no requests, so they are not counted, and services that wait for
// the log queue before exiting do not wait for them.
let finishJob;
gone.logger.rl.schedule(() => new Promise((resolve) => (finishJob = resolve)));
await until(() => gone.logger.rl.counts().EXECUTING === 1, 'the job to start');
assert.deepStrictEqual({ ...gone.logger.getLogQueue() }, emptyQueue);
finishJob();
await gone.settled();

// The same happens when a progress bar's edit is the first to find a webhook whose token was reset.
const revoked = await loadLogger();
revoked.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '666' : id });
const revokedBar = revoked.logger.discordProgressBar('Test', 'Revoked...', null, 0, 10, 0);
revoked.advance(60000);
await revoked.idle();
revoked.discord.reply = async ({ type }) => {
  if (type === 'edit') {
    throw discordError('Discord answered HTTP 401: Invalid Webhook Token (code 50027)', {
      status: 401,
      code: 50027
    });
  }
  return { id: '667' };
};
revoked.logger.discordProgressBar('Test', 'Revoked...', revokedBar, 0, 10, 5);
revoked.logger.flush();
await revoked.settled();
revoked.logger.verbose('Test', 1, 'Later');
await revoked.settled();
assert.deepStrictEqual(
  revoked.discord.requests.map(({ type }) => type),
  ['send', 'edit']
);
assert.strictEqual(revoked.logger.discordWebhook, null);
assert.deepStrictEqual(warnings(revoked.output), [
  goneWarning('Discord answered HTTP 401: Invalid Webhook Token (code 50027)')
]);

// Progress bars are only posted for steps that take longer than a minute. A bar finished within its
// first minute posts nothing, whatever it was updated to before.
const quick = await loadLogger();
const quickBar = quick.logger.discordProgressBar(
  'Core',
  'Updating 10 Steam users...',
  null,
  0,
  10,
  0
);
// Its first minute does not keep the process running, so a service that is done can exit.
assert.deepStrictEqual(
  [...quick.timers].map(({ ms, unrefed }) => [ms, unrefed]),
  [[60000, true]]
);
quick.advance(20000);
quick.logger.discordProgressBar('Core', 'Updating 10 Steam users...', quickBar, 0, 10, 4);
quick.advance(39000);
quick.logger.discordProgressBar('Core', 'Updating 10 Steam users...', quickBar, 0, 10, 10);
quick.advance(120000);
await quick.idle();
assert.strictEqual(quick.discord.requests.length, 0);
assert.strictEqual(quick.timers.size, 0);
// Nor does a bar that is finished when it is made, such as one for a step with nothing to do.
quick.logger.discordProgressBar('Core', 'Exporting 0 Bans...', null, 0, 0, 0);
quick.logger.discordProgressBar('Core', 'Updating 5 ExportBans...', null, 0, 5, 5);
assert.strictEqual(quick.timers.size, 0);
quick.advance(120000);
await quick.idle();
assert.strictEqual(quick.discord.requests.length, 0);

// A bar that is not finished after a minute is posted then, with its latest value, and edited as
// usual after that, up to its final value.
const slowStep = await loadLogger();
slowStep.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '888' : id });
const slowBar = (current, bar = null) =>
  slowStep.logger.discordProgressBar('Core', 'Updating 10 ExportBans...', bar, 0, 10, current);
const longBar = slowBar(0);
slowStep.advance(10000);
slowBar(3, longBar);
slowStep.advance(49999);
await pause();
assert.strictEqual(slowStep.discord.requests.length, 0);
slowStep.advance(1);
await slowStep.idle();
assert.deepStrictEqual(
  slowStep.discord.requests.map(({ type }) => type),
  ['send']
);
assert.match(slowStep.discord.requests[0].content, / 3\/10``$/);
slowBar(7, longBar);
slowStep.advance(15000);
await slowStep.idle();
slowBar(10, longBar);
slowStep.advance(15000);
await slowStep.idle();
assert.deepStrictEqual(
  slowStep.discord.requests.map(({ type, id, content }) => [type, id, content.split('] ').pop()]),
  [
    ['send', undefined, '3/10``'],
    ['edit', '888', '7/10``'],
    ['edit', '888', '10/10``']
  ]
);
assert.strictEqual(slowStep.timers.size, 0);

// Flushing the logger before a bar's first minute is up, as the importer does when it exits, drops
// the bar rather than posting it, so the importer does not wait for it either.
const ending = await loadLogger();
const endingBar = ending.logger.discordProgressBar('Core', 'Exporting 10 Bans...', null, 0, 10, 0);
ending.logger.discordProgressBar('Core', 'Exporting 10 Bans...', endingBar, 0, 10, 6);
ending.advance(30000);
ending.logger.flush();
assert.deepStrictEqual({ ...ending.logger.getLogQueue() }, emptyQueue);
assert.strictEqual(ending.timers.size, 0);
ending.advance(120000);
await ending.idle();
assert.strictEqual(ending.discord.requests.length, 0);

// What a status message's requests asked Discord for.
const shown = (requests) =>
  requests.map(({ type, id, content, embeds }) =>
    type === 'get' ? [type, id] : [type, id, content, embeds?.map(({ title }) => title)]
  );

// A status message, such as a run's, is returned at once and posted in the background straight
// away, ahead of the messages already waiting, as embeds without text. A payload that is a function
// is drawn when it is sent, and not before. Once the message is posted, it settles with its ID.
const live = await loadLogger();
let releaseLive;
const liveBlocked = new Promise((resolve) => (releaseLive = resolve));
live.discord.reply = async ({ type, id, content }) => {
  if (content === '[Test][1] First') await liveBlocked;
  return { id: type === 'send' ? (content ? '1' : '777') : id };
};
live.logger.verbose('Test', 1, 'First');
await until(() => live.discord.requests.length === 1, 'the first message to be sent');
for (let i = 1; i <= 3; i++) live.logger.verbose('Test', 1, `Waiting ${i}`);
let title = 'Starting';
let draws = 0;
const draw = () => {
  draws++;
  return { embeds: [{ title }] };
};
const status = live.logger.statusMessage(draw);
assert.strictEqual(typeof status.then, 'undefined');
assert.strictEqual(status.stopped, false);
await until(() => live.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
releaseLive();
assert.strictEqual(await status.posted, '777');
await live.idle();
assert.deepStrictEqual(shown(live.discord.requests), [
  ['send', undefined, '[Test][1] First', undefined],
  ['send', undefined, null, ['Starting']],
  ['send', undefined, '[Test][1] Waiting 1', undefined],
  ['send', undefined, '[Test][1] Waiting 2', undefined],
  ['send', undefined, '[Test][1] Waiting 3', undefined]
]);
assert.strictEqual(draws, 1);

// Updates are coalesced: the latest is drawn and sent 15 seconds after the last edit, however many
// there are, and until then it counts as queued, so the importer waits for it before it exits.
live.discord.requests.length = 0;
for (let i = 1; i <= 100; i++) {
  title = `Step ${i}`;
  status.update(draw);
}
assert.strictEqual(draws, 1);
assert.deepStrictEqual({ ...live.logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
live.advance(14999);
await pause();
assert.strictEqual(live.discord.requests.length, 0);
live.advance(1);
await live.idle();
assert.deepStrictEqual(shown(live.discord.requests), [['edit', '777', null, ['Step 100']]]);
assert.strictEqual(draws, 2);
// The next one waits another 15 seconds, from that edit.
title = 'Step 101';
status.update(draw);
live.advance(14999);
await pause();
assert.strictEqual(live.discord.requests.length, 1);
live.advance(1);
await live.idle();
assert.deepStrictEqual(shown(live.discord.requests).at(-1), ['edit', '777', null, ['Step 101']]);

// Its final payload is sent at once, rather than when it is due, in place of an update still
// waiting, and nothing after it is sent: not updates, another final payload or a flush.
live.discord.requests.length = 0;
live.advance(2000);
status.update(draw);
status.finish({ embeds: [{ title: 'Finished' }] });
await live.idle();
assert.deepStrictEqual(shown(live.discord.requests), [['edit', '777', null, ['Finished']]]);
status.update(draw);
status.finish({ embeds: [{ title: 'Again' }] });
live.logger.flush();
live.advance(60000);
await live.idle();
assert.strictEqual(live.discord.requests.length, 1);
assert.strictEqual(live.timers.size, 0);
// Requests were made one at a time throughout.
assert.strictEqual(live.discord.mostInFlight, 1);

// An update waiting to be due is sent at once when the logger is flushed, as the importer does
// before it exits.
const flushed = await loadLogger();
flushed.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '321' : id });
const flushedStatus = flushed.logger.statusMessage({
  content: 'Text',
  embeds: [{ title: 'Posted' }]
});
await flushed.idle();
flushedStatus.update({ embeds: [{ title: 'Latest' }] });
assert.deepStrictEqual({ ...flushed.logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
flushed.logger.flush();
await flushed.idle();
assert.deepStrictEqual(shown(flushed.discord.requests), [
  ['send', undefined, 'Text', ['Posted']],
  ['edit', '321', null, ['Latest']]
]);
assert.strictEqual(flushed.timers.size, 0);

// Once Discord refuses to edit the message, e.g. as it was deleted, it is not edited again for the
// rest of the run, and Discord logging stays on. A failure Discord may get over, such as a 502, is
// tried again with the next edit.
const refused = await loadLogger();
let refusal = discordError('Discord answered HTTP 502', { status: 502 });
refused.discord.reply = async ({ type }) => {
  if (type === 'edit') throw refusal;
  return { id: '888' };
};
const refusedStatus = refused.logger.statusMessage({ embeds: [{ title: 'Posted' }] });
await refused.idle();
refusedStatus.update({ embeds: [{ title: 'First edit' }] });
refused.advance(15000);
await until(() => refused.discord.requests.length === 2 && refused.timers.size === 1, 'a retry');
refused.advance(1000);
await refused.settled();
// The edit was tried twice, and waits to be sent with the next one.
assert.strictEqual(refused.discord.requests.length, 3);
assert.deepStrictEqual({ ...refused.logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
refusal = discordError('Discord answered HTTP 404: Unknown Message (code 10008)', {
  status: 404,
  code: 10008
});
refused.advance(15000);
await refused.idle();
assert.strictEqual(refused.discord.requests.length, 4);
assert.strictEqual(refusedStatus.stopped, true);
refusedStatus.update({ embeds: [{ title: 'Later' }] });
refusedStatus.finish({ embeds: [{ title: 'Final' }] });
refused.logger.flush();
refused.advance(60000);
await refused.idle();
assert.strictEqual(refused.discord.requests.length, 4);
assert.strictEqual(refused.logger.discordWebhook, webhook);
assert.deepStrictEqual(warnings(refused.output), [
  'Could not update a status message in the Discord log: DiscordWebhookError: Discord answered HTTP 502',
  'Could not update a status message in the Discord log: DiscordWebhookError: Discord answered HTTP 404: Unknown Message (code 10008)'
]);
refused.logger.verbose('Test', 1, 'Still logging');
await refused.idle();
assert.strictEqual(refused.discord.requests.at(-1).content, '[Test][1] Still logging');

// A status message Discord refused to post, with a 4xx other than 429, is not posted again, as it
// would be refused again, and settles with no ID, so nothing waits for one.
const unposted = await loadLogger();
unposted.discord.reply = async () => {
  throw discordError('Discord answered HTTP 400: Invalid Form Body (code 50035)', {
    status: 400,
    code: 50035
  });
};
const unpostedStatus = unposted.logger.statusMessage({ embeds: [{ title: 'Refused' }] });
assert.strictEqual(await unpostedStatus.posted, null);
unpostedStatus.update({ embeds: [{ title: 'Later' }] });
unpostedStatus.finish({ embeds: [{ title: 'Final' }] });
unposted.advance(60000);
await unposted.idle();
assert.strictEqual(unposted.discord.requests.length, 1);
assert.deepStrictEqual(warnings(unposted.output), [
  'Could not post a status message in the Discord log: DiscordWebhookError: Discord answered HTTP 400: Invalid Form Body (code 50035)'
]);

// A status message whose post Discord rate limited or failed, after the post was tried once more,
// as any message is, is posted again with its latest payload when the next one is due, 15 seconds
// later, rather than lost for the whole run. It settles with its ID once it is posted, and its
// final payload is then sent as an edit.
for (const error of [
  {
    status: 429,
    retryAfter: 1.2,
    message: 'Discord answered HTTP 429: You are being rate limited.'
  },
  { status: 503, message: 'Discord answered HTTP 503' }
]) {
  const limited = await loadLogger();
  let failures = 2;
  limited.discord.reply = async ({ type, id }) => {
    if (type === 'send' && failures-- > 0) throw discordError(error.message, error);
    return { id: type === 'send' ? '1001' : id };
  };
  let title = 'Posting';
  const draw = () => ({ embeds: [{ title }] });
  const limitedStatus = limited.logger.statusMessage(draw);
  let postedID;
  limitedStatus.posted.then((id) => (postedID = id));
  await until(() => limited.discord.requests.length === 1 && limited.timers.size === 1, 'a retry');
  limited.advance(error.retryAfter ? 1200 : 1000);
  await limited.settled();
  assert.strictEqual(limited.discord.requests.length, 2);
  assert.strictEqual(limitedStatus.stopped, false);
  assert.strictEqual(postedID, undefined);
  // It waits for its next payload's time, and counts as queued until then, so the importer waits
  // for it before it exits.
  assert.deepStrictEqual({ ...limited.logger.getLogQueue() }, { ...emptyQueue, QUEUED: 1 });
  title = 'Updated';
  limitedStatus.update(draw);
  limited.advance(14999);
  await pause();
  assert.strictEqual(limited.discord.requests.length, 2);
  limited.advance(1);
  assert.strictEqual(await limitedStatus.posted, '1001');
  await limited.idle();
  limitedStatus.finish({ embeds: [{ title: 'Final' }] });
  await limited.idle();
  assert.deepStrictEqual(shown(limited.discord.requests), [
    ['send', undefined, null, ['Posting']],
    ['send', undefined, null, ['Posting']],
    ['send', undefined, null, ['Updated']],
    ['edit', '1001', null, ['Final']]
  ]);
  assert.strictEqual(limited.timers.size, 0);
  assert.deepStrictEqual(warnings(limited.output), [
    `Could not post a status message in the Discord log: DiscordWebhookError: ${error.message}`
  ]);
}

// Discord has 30 seconds to answer a status message's post, rather than the usual 10, as nothing
// waits for it, which makes it rarer that Discord posts a message the logger never learns the ID
// of. One it still does not answer, or cannot be reached for, is not tried again at once, as
// Discord may have posted it, but nor is it given up: it is posted again when its next payload is
// due, here its final payload, which is sent at once. Other messages, such as the log's lines,
// have the usual time.
{
  const unanswered = await loadLogger();
  let answering = false;
  unanswered.discord.reply = async ({ type, id }) => {
    if (type === 'send' && !answering) throw networkError('Discord did not answer in time');
    return { id: type === 'send' ? '2002' : id };
  };
  const unansweredStatus = unanswered.logger.statusMessage({ embeds: [{ title: 'Posting' }] });
  await unanswered.settled();
  assert.strictEqual(unanswered.discord.requests.length, 1);
  assert.strictEqual(unansweredStatus.stopped, false);
  assert.deepStrictEqual(
    [...unanswered.timers].map(({ ms }) => ms),
    [15000]
  );
  answering = true;
  unansweredStatus.finish({ embeds: [{ title: 'Final' }] });
  assert.strictEqual(await unansweredStatus.posted, '2002');
  unanswered.logger.verbose('Test', 1, 'Line');
  await unanswered.idle();
  assert.deepStrictEqual(shown(unanswered.discord.requests), [
    ['send', undefined, null, ['Posting']],
    ['send', undefined, null, ['Final']],
    ['send', undefined, '[Test][1] Line', undefined]
  ]);
  assert.deepStrictEqual(
    unanswered.discord.requests.map(({ timeout }) => timeout),
    [30000, 30000, undefined]
  );
  assert.strictEqual(unanswered.timers.size, 0);
  assert.deepStrictEqual(warnings(unanswered.output), [
    'Could not post a status message in the Discord log: DiscordWebhookError: Discord did not answer in time'
  ]);
}

// Nor is a status message whose post was dropped from a full queue lost, which can only happen
// when the queue is full of status messages. It is posted when its next payload is due.
{
  const full = await loadLogger(undefined, { highWater: 2 });
  let releaseFull;
  const fullBlocked = new Promise((resolve) => (releaseFull = resolve));
  full.discord.reply = async ({ type, id, content, embeds }) => {
    if (content === '[Test][1] Blocker') await fullBlocked;
    return { id: type === 'send' ? (content ? '1' : embeds[0].title) : id };
  };
  full.logger.verbose('Test', 1, 'Blocker');
  await until(() => full.discord.requests.length === 1, 'the blocker to be sent');
  const statuses = [1, 2, 3].map((i) => full.logger.statusMessage({ embeds: [{ title: `${i}` }] }));
  await until(() => full.logger.getLogQueue().RECEIVED === 0, 'the posts to be queued');
  assert.ok(statuses.every((status) => !status.stopped));
  releaseFull();
  await full.settled();
  assert.deepStrictEqual(shown(full.discord.requests).slice(1), [
    ['send', undefined, null, ['1']],
    ['send', undefined, null, ['2']]
  ]);
  full.advance(15000);
  assert.deepStrictEqual(await Promise.all(statuses.map(({ posted }) => posted)), ['1', '2', '3']);
  await full.idle();
  assert.deepStrictEqual(shown(full.discord.requests).at(-1), ['send', undefined, null, ['3']]);
  assert.strictEqual(full.timers.size, 0);
}

// A payload that cannot be drawn stops the message, with a warning, rather than fail whatever
// updated it.
const broken = await loadLogger();
const brokenStatus = broken.logger.statusMessage({ embeds: [{ title: 'Posted' }] });
await broken.idle();
brokenStatus.update(() => {
  throw new TypeError("Cannot read properties of undefined (reading 'embeds')");
});
broken.logger.flush();
brokenStatus.update(() => null);
brokenStatus.finish({ embeds: [{ title: 'Final' }] });
await broken.idle();
assert.strictEqual(brokenStatus.stopped, true);
assert.strictEqual(broken.discord.requests.length, 1);
assert.deepStrictEqual(warnings(broken.output), [
  "Could not draw a status message for the Discord log: TypeError: Cannot read properties of undefined (reading 'embeds')"
]);

// Without Discord logging, a status message is never drawn or posted, settles with no ID, and
// nothing waits for it. Nor is any earlier message read or changed.
const off = await loadLogger({});
const offStatus = off.logger.statusMessage(() => assert.fail('Drawn without Discord logging'));
assert.strictEqual(offStatus.stopped, true);
assert.strictEqual(await offStatus.posted, null);
offStatus.update(() => assert.fail('Drawn without Discord logging'));
offStatus.finish({ embeds: [{ title: 'Final' }] });
off.logger.reviseMessage('555', () => assert.fail('Read without Discord logging'));
off.logger.flush();
off.advance(60000);
await pause();
assert.strictEqual(off.discord.requests.length, 0);
assert.deepStrictEqual({ ...off.logger.getLogQueue() }, emptyQueue);
assert.strictEqual(off.timers.size, 0);

// When Discord says the webhook is gone, a status message stops with everything else.
const goneStatusLog = await loadLogger();
goneStatusLog.discord.reply = async ({ type, id }) => {
  if (type === 'edit')
    throw discordError('Discord answered HTTP 404: Unknown Webhook (code 10015)', {
      status: 404,
      code: 10015
    });
  return { id: '444' };
};
const goneStatus = goneStatusLog.logger.statusMessage({ embeds: [{ title: 'Posted' }] });
await goneStatusLog.idle();
goneStatus.finish({ embeds: [{ title: 'Final' }] });
await goneStatusLog.settled();
assert.strictEqual(goneStatusLog.logger.discordWebhook, null);
assert.strictEqual(goneStatus.stopped, true);
assert.deepStrictEqual({ ...goneStatusLog.logger.getLogQueue() }, emptyQueue);
assert.strictEqual(goneStatusLog.discord.requests.length, 2);

// While Discord is slow and the queue is full, a status message goes ahead of every other message,
// and is not dropped for them: here its final edit, while errors and a run's own lines fill a
// queue of 10. The oldest of the least important messages are dropped instead. Requests are still
// made one at a time.
const crowded = await loadLogger(undefined, { highWater: 10 });
let releaseCrowded;
const crowdedBlocked = new Promise((resolve) => (releaseCrowded = resolve));
crowded.discord.reply = async ({ type, id, content }) => {
  if (content === '[Test][1] Blocker') await crowdedBlocked;
  return { id: type === 'send' ? '999' : id };
};
const crowdedStatus = crowded.logger.statusMessage({ embeds: [{ title: 'Posted' }] });
await crowded.idle();
crowded.logger.verbose('Test', 1, 'Blocker');
await until(() => crowded.discord.requests.length === 2, 'the blocker to be sent');
for (let i = 1; i <= 15; i++)
  crowded.logger.verbose('Test', 1, `Error ${i}: `, new Error('Failed'));
for (let i = 1; i <= 5; i++) crowded.logger.important('Test', `Run line ${i}`);
crowdedStatus.finish({ embeds: [{ title: 'Final' }] });
await until(() => crowded.logger.getLogQueue().RECEIVED === 0, 'the messages to be queued');
assert.deepStrictEqual(
  { ...crowded.logger.getLogQueue() },
  { ...emptyQueue, QUEUED: 10, EXECUTING: 1 }
);
releaseCrowded();
await crowded.idle();
assert.deepStrictEqual(shown(crowded.discord.requests).slice(1), [
  ['send', undefined, '[Test][1] Blocker', undefined],
  ['edit', '999', null, ['Final']],
  ...[1, 2, 3, 4, 5].map((i) => ['send', undefined, `[Test][1] Run line ${i}`, undefined]),
  ...[7, 8, 9, 10].map((i) => ['send', undefined, `[Test][1] Error ${i}: Error: Failed`, undefined])
]);
assert.strictEqual(crowded.discord.mostInFlight, 1);

// A message posted earlier, such as an earlier run's status, can be read back and changed: the
// function it is given gets the message as Discord has it, and says what to replace it with, or
// to leave it as it is. Both requests go ahead of other messages.
const revising = await loadLogger();
const earlier = { id: '555', content: null, embeds: [{ title: 'Running' }] };
let getError = null;
revising.discord.reply = async ({ type, id }) => {
  if (type !== 'get') return { id };
  if (getError) {
    const err = getError;
    getError = null;
    throw err;
  }
  return earlier;
};
const seen = [];
revising.logger.reviseMessage('555', (message) => {
  seen.push(message);
  return { embeds: [{ title: 'Ended' }] };
});
await revising.idle();
assert.deepStrictEqual(shown(revising.discord.requests), [
  ['get', '555'],
  ['edit', '555', null, ['Ended']]
]);
assert.deepStrictEqual(seen, [earlier]);
// Left as it is when the function says so.
revising.discord.requests.length = 0;
revising.logger.reviseMessage('555', () => null);
await revising.idle();
assert.deepStrictEqual(shown(revising.discord.requests), [['get', '555']]);
// Read again after a network error, as reading it twice does no harm.
revising.discord.requests.length = 0;
getError = networkError('Could not reach Discord (ECONNRESET)');
revising.logger.reviseMessage('555', () => ({ embeds: [{ title: 'Ended' }] }));
await until(() => revising.discord.requests.length === 1 && revising.timers.size === 1, 'a retry');
revising.advance(1000);
await revising.idle();
assert.deepStrictEqual(shown(revising.discord.requests), [
  ['get', '555'],
  ['get', '555'],
  ['edit', '555', null, ['Ended']]
]);
// A message that cannot be read, e.g. as it was deleted, or that the function fails on, is left as
// it is, with a warning, and Discord logging stays on.
revising.discord.requests.length = 0;
getError = discordError('Discord answered HTTP 404: Unknown Message (code 10008)', {
  status: 404,
  code: 10008
});
revising.logger.reviseMessage('555', () => assert.fail('Revised a message it could not read'));
revising.logger.reviseMessage('555', () => {
  throw new TypeError('Cannot read properties of null');
});
await revising.idle();
assert.deepStrictEqual(shown(revising.discord.requests), [
  ['get', '555'],
  ['get', '555']
]);
assert.deepStrictEqual(warnings(revising.output), [
  'Could not read a message in the Discord log: DiscordWebhookError: Discord answered HTTP 404: Unknown Message (code 10008)',
  'Could not change a message in the Discord log: TypeError: Cannot read properties of null'
]);
assert.strictEqual(revising.logger.discordWebhook, webhook);

// A status message given an earlier message's ID, such as the importer service's after a restart,
// edits that message from the start rather than posting another, and settles with its ID once the
// first edit worked. With editInterval, its updates are sent at most that often, here once a
// minute, however many there are, and its final payload at once.
const reused = await loadLogger();
reused.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '900' : id });
title = 'Running again';
const reusedStatus = reused.logger.statusMessage(draw, {
  messageID: '444',
  editInterval: 60000,
  repostIfDeleted: true
});
assert.strictEqual(await reusedStatus.posted, '444');
await reused.idle();
title = 'Cycle 1';
for (let i = 0; i < 50; i++) reusedStatus.update(draw);
reused.advance(59999);
await pause();
assert.deepStrictEqual(shown(reused.discord.requests), [['edit', '444', null, ['Running again']]]);
reused.advance(1);
await reused.idle();
title = 'Cycle 2';
reusedStatus.update(draw);
reused.advance(30000);
await pause();
assert.strictEqual(reused.discord.requests.length, 2);
reusedStatus.finish({ embeds: [{ title: 'Stopped' }] });
await reused.idle();
assert.deepStrictEqual(shown(reused.discord.requests), [
  ['edit', '444', null, ['Running again']],
  ['edit', '444', null, ['Cycle 1']],
  ['edit', '444', null, ['Stopped']]
]);
// An ID that is not one is not used: a new message is posted.
const fresh = await loadLogger();
fresh.discord.reply = async ({ type, id }) => ({ id: type === 'send' ? '901' : id });
const freshStatus = fresh.logger.statusMessage(
  { embeds: [{ title: 'Posted' }] },
  { messageID: '../x' }
);
assert.strictEqual(await freshStatus.posted, '901');
assert.deepStrictEqual(shown(fresh.discord.requests), [['send', undefined, null, ['Posted']]]);

// With repostIfDeleted, a message that Discord says no longer exists, as someone deleted it, is
// posted again, as a new message, with the payload that was to be shown, and onPosted is told its
// ID, as it is for every message posted, so the service keeps it for the next process. Later edits
// go to the new message. Without repostIfDeleted, such a message is no longer edited (see above),
// and a webhook that is gone turns Discord logging off rather than posting again.
const deleted = await loadLogger();
const unknownMessage = discordError('Discord answered HTTP 404: Unknown Message (code 10008)', {
  status: 404,
  code: 10008
});
let deletedIDs = ['902', '903'];
deleted.discord.reply = async ({ type, id }) => {
  if (type === 'edit' && id === '444') throw unknownMessage;
  return { id: type === 'send' ? deletedIDs.shift() : id };
};
const postedIDs = [];
const deletedStatus = deleted.logger.statusMessage(
  { embeds: [{ title: 'Running' }] },
  {
    messageID: '444',
    editInterval: 60000,
    repostIfDeleted: true,
    onPosted: async (id) => postedIDs.push(id)
  }
);
assert.strictEqual(await deletedStatus.posted, '902');
await deleted.idle();
assert.deepStrictEqual(postedIDs, ['902']);
deletedStatus.update({ embeds: [{ title: 'Later' }] });
deleted.advance(60000);
await deleted.idle();
assert.deepStrictEqual(shown(deleted.discord.requests), [
  ['edit', '444', null, ['Running']],
  ['send', undefined, null, ['Running']],
  ['edit', '902', null, ['Later']]
]);
assert.deepStrictEqual(warnings(deleted.output), []);
assert.deepStrictEqual(deleted.output, [
  'Discord says a status message in the log channel was deleted, so it is posted again.'
]);
// Whatever onPosted does, it never fails the message: a failure is only warned about.
deleted.discord.reply = async ({ type, id }) => {
  if (type === 'edit') throw unknownMessage;
  return { id: type === 'send' ? deletedIDs.shift() : id };
};
deletedIDs = ['904'];
const failingStatus = deleted.logger.statusMessage(
  { embeds: [{ title: 'Running' }] },
  {
    messageID: '445',
    repostIfDeleted: true,
    onPosted: async () => {
      throw new Error('Database unavailable');
    }
  }
);
assert.strictEqual(await failingStatus.posted, '904');
await deleted.idle();
await pause();
assert.ok(
  deleted.output.includes(
    'Could not keep the ID of a status message in the Discord log: Error: Database unavailable'
  )
);
assert.strictEqual(deleted.logger.discordWebhook, webhook);
// A message whose webhook is gone is not posted again: Discord logging turns off.
const goneAgain = await loadLogger();
goneAgain.discord.reply = async () => {
  throw discordError('Discord answered HTTP 404: Unknown Webhook (code 10015)', {
    status: 404,
    code: 10015
  });
};
const goneStatus2 = goneAgain.logger.statusMessage(
  { embeds: [{ title: 'Running' }] },
  { messageID: '446', repostIfDeleted: true }
);
assert.strictEqual(await goneStatus2.posted, null);
await goneAgain.idle();
assert.deepStrictEqual(shown(goneAgain.discord.requests), [['edit', '446', null, ['Running']]]);
assert.strictEqual(goneAgain.logger.discordWebhook, null);

// A message posted once, such as an embed of a cycle of the importer service or its hourly
// summary, is posted ahead of other messages, as a run's lines are, and tried again after a
// network error. A refusal is only warned about. Without Discord logging, nothing is posted.
const once = await loadLogger();
let onceFailures = 1;
once.discord.reply = async ({ type }) => {
  if (type === 'send' && onceFailures-- > 0)
    throw networkError('Could not reach Discord (ECONNRESET)');
  return { id: '950' };
};
once.logger.post({ embeds: [{ title: 'CBL update cycle 3 finished' }] });
await until(() => once.discord.requests.length === 1 && once.timers.size === 1, 'a retry');
once.advance(1000);
await once.idle();
assert.deepStrictEqual(shown(once.discord.requests), [
  ['send', undefined, null, ['CBL update cycle 3 finished']],
  ['send', undefined, null, ['CBL update cycle 3 finished']]
]);
once.discord.reply = async () => {
  throw discordError('Discord answered HTTP 400: Invalid Form Body (code 50035)', { status: 400 });
};
once.logger.post({ content: 'Text', embeds: [] });
await once.idle();
assert.deepStrictEqual(warnings(once.output), [
  'Could not post a message to the Discord log: DiscordWebhookError: Discord answered HTTP 400: Invalid Form Body (code 50035)'
]);
const silent = await loadLogger({});
silent.logger.post({ embeds: [{ title: 'Nothing' }] });
await silent.idle();
assert.strictEqual(silent.discord.requests.length, 0);

// The logger counts the lines logged for the log channel, level 1 and important ones, whether or
// not Discord logging is on, so the importer service can tell whether a cycle had anything to say.
for (const env of [{ DISCORD_LOG_WEBHOOK: webhook }, {}]) {
  const counting = await loadLogger(env);
  assert.strictEqual(counting.logger.channelLines, 0);
  counting.logger.verbose('Test', 2, 'Console only');
  counting.logger.verbose('Test', 1, 'A line');
  counting.logger.important('Test', 'An important line');
  counting.logger.post({ embeds: [{ title: 'An embed' }] });
  assert.strictEqual(counting.logger.channelLines, 2);
  await counting.idle();
}

await pause();
assert.deepStrictEqual(unhandled, []);

console.log(
  'Logger checks passed: Discord off, failed sends, retries, long messages, errors, stack traces, progress bars and their first minute, status messages and their posts made again, changing earlier messages, the queue limit, run lines and gone webhooks, status messages kept across processes and posted again once deleted, messages posted once, and the lines counted.'
);
