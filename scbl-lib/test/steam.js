import assert from 'assert';
import { readFile } from 'fs/promises';
import { inspect } from 'util';
import vm from 'vm';

// Exercise the Steam client without a key, network requests, or real waits. Its waits run on a
// fake clock: once nothing else is left to run, the next timer fires and moves the clock on.
const KEY = '0123456789ABCDEF0123456789ABCDEF';
let clock = Date.UTC(2026, 9, 15);
let timers = [];
let timerCount = 0;
let ticking = false;

function runTimers() {
  if (ticking) return;
  ticking = true;
  setImmediate(() => {
    ticking = false;
    if (timers.length === 0) return;
    timers.sort((a, b) => a.due - b.due || a.id - b.id);
    const timer = timers.shift();
    clock = Math.max(clock, timer.due);
    timer.callback();
    runTimers();
  });
}

function fakeTimeout(callback, ms = 0) {
  const timer = { id: ++timerCount, due: clock + Math.max(0, ms), callback };
  timers.push(timer);
  runTimers();
  return timer;
}

const wait = (ms) => new Promise((resolve) => fakeTimeout(resolve, ms));

class FakeDate extends Date {
  static now() {
    return clock;
  }
}

// AbortSignal.timeout's signals abort on the fake clock too. Each records how long it was for and
// when it was made, to check that every attempt gets one of its own when it is sent.
class FakeAbortSignal extends EventTarget {
  static timeout(ms) {
    return new FakeAbortSignal(ms);
  }

  constructor(ms) {
    super();
    this.ms = ms;
    this.createdAt = clock;
    this.aborted = false;
    fakeTimeout(() => {
      this.aborted = true;
      this.reason = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      this.dispatchEvent(new Event('abort'));
    }, ms);
  }
}

const logs = [];
const context = vm.createContext({
  console: {
    log: (...args) => logs.push(args),
    warn: (...args) => logs.push(args)
  },
  setTimeout: fakeTimeout,
  clearTimeout: (timer) => {
    timers = timers.filter((other) => other !== timer);
  },
  AbortSignal: FakeAbortSignal,
  Date: FakeDate
});

// A stand-in for Bottleneck that records each job and starts jobs at least 1.5 s apart.
let limiter;
class Bottleneck {
  constructor(options) {
    this.options = options;
    this.jobs = [];
    this.nextStart = 0;
    limiter = this;
  }

  on() {}

  schedule(options, task) {
    this.jobs.push({ ...options, at: clock });
    const start = Math.max(clock, this.nextStart);
    this.nextStart = start + 1500;
    return wait(start - clock).then(() => task());
  }
}

// axios records each request, and whether its signal had already aborted, and answers it with
// reply().
let requests;
let reply;
const dependencies = {
  axios: {
    default: async (request) => {
      requests.push({ ...request, at: clock, abortedWhenSent: request.signal?.aborted });
      return reply(request, requests.length);
    }
  },
  bottleneck: { default: Bottleneck },
  '../config.js': { STEAM_API_KEY: KEY }
};

// Every attempt is cut off 15 s after it is sent, by a signal of its own: one shared with earlier
// attempts, or made while the attempt waited in the queue or for a pause, could already have
// aborted.
function assertSignals() {
  for (const [i, request] of requests.entries()) {
    const which = `Request ${i + 1}, ${request.method} ${request.url}`;
    assert.ok(request.signal instanceof FakeAbortSignal, which);
    assert.strictEqual(request.signal.ms, 15000, which);
    assert.strictEqual(request.signal.createdAt, request.at, which);
    assert.strictEqual(request.abortedWhenSent, false, which);
  }
  assert.strictEqual(new Set(requests.map((request) => request.signal)).size, requests.length);
}

// Load a client of its own, with no pause and no jobs, and nothing logged yet. The last client's
// requests are checked for their signals first.
async function load() {
  if (requests) assertSignals();
  const url = new URL('../apis/steam.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    if (specifier.startsWith('./')) {
      const dependency = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(dependency, 'utf8'), {
        context,
        identifier: dependency.href
      });
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
  requests = [];
  logs.length = 0;
  reply = () => ({ status: 200, headers: {}, data: { response: { players: [] } } });
  return module.namespace.default;
}

// An error as axios gives one, holding the request, whose address has the key in it, and the
// answer, which can repeat it.
function axiosError(request, { status, code, message, headers = {} } = {}) {
  const path = `/${request.url.split('/').slice(3).join('/')}?key=${KEY}&steamids=1`;
  const err = new Error(message || `Request failed with status code ${status}`);
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.code = code || (status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST');
  err.config = request;
  err.request = { path, res: { responseUrl: `https://partner.steam-api.com${path}` } };
  if (status)
    err.response = {
      status,
      headers,
      data: `<html><body>Please verify your key=${KEY} parameter.</body></html>`,
      config: request,
      request: err.request
    };
  return err;
}

const failWith = (details) => (request) => {
  throw axiosError(request, details);
};

// Neither an error nor anything logged may hold the key, or the request it came from.
async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    for (const text of [
      inspect(err, { depth: null, showHidden: true }),
      JSON.stringify(err),
      String(err.stack),
      inspect(logs, { depth: null })
    ])
      assert.ok(!text.includes(KEY), `Key found in: ${text}`);
    for (const key of ['config', 'request', 'cause']) assert.strictEqual(err[key], undefined, key);
    return err;
  }
  assert.fail('The request should have failed');
}

const summaries = 'ISteamUser/GetPlayerSummaries/v2';
const gaps = () => requests.slice(1).map((request, i) => request.at - requests[i].at);

// Requests go to Steam's partner API with the key, and time limits.
let steam = await load();
await steam('get', summaries, { steamids: '1,2' });
assert.strictEqual(requests[0].url, `https://partner.steam-api.com/${summaries}`);
assert.deepStrictEqual({ ...requests[0].params }, { steamids: '1,2', key: KEY });
assert.strictEqual(requests[0].timeout, 15000);
assert.ok(requests[0].signal instanceof FakeAbortSignal);
assert.strictEqual(requests[0].signal.ms, 15000);
assert.deepStrictEqual(
  limiter.jobs.map((job) => [job.id, job.priority]),
  [['STEAM-1', 5]]
);

// Steam refuses a key with 401 or 403, which is never tried again, as partner.steam-api.com
// limits the whole IP address after repeated refusals. The error says the key was refused.
for (const status of [401, 403]) {
  steam = await load();
  reply = failWith({ status });
  const err = await failure(steam('get', summaries, { steamids: '1' }));
  assert.strictEqual(requests.length, 1, `HTTP ${status}`);
  assert.strictEqual(err.auth, true);
  assert.strictEqual(err.message, `Steam GET ${summaries} failed: HTTP ${status}`);
  assert.strictEqual(err.response.status, status);
}

// Other answers that would only fail again are tried once, and do not mean the key was refused.
for (const status of [400, 404]) {
  steam = await load();
  reply = failWith({ status });
  const err = await failure(steam('get', summaries, { steamids: '1' }));
  assert.strictEqual(requests.length, 1, `HTTP ${status}`);
  assert.strictEqual(err.auth, false);
}

// A 5xx, or a request that timed out, is tried three times, each time as a job of its own. The
// waits are about 1 s, which the limiter's 1.5 s between requests makes longer, and then 4 s.
for (const details of [{ status: 503 }, { code: 'ECONNABORTED', message: 'timeout exceeded' }]) {
  steam = await load();
  reply = failWith(details);
  const err = await failure(steam('get', summaries, { steamids: '1' }));
  assert.strictEqual(requests.length, 3, JSON.stringify(details));
  assert.strictEqual(new Set(limiter.jobs.map((job) => job.id)).size, 3);
  const [first, second] = gaps();
  assert.strictEqual(first, 1500);
  assert.ok(second >= 4000 && second <= 5000, `Second wait was ${second} ms`);
  assert.strictEqual(err.attempts, 3);
}
assert.strictEqual(
  (await failure(steam('get', summaries, {}))).message,
  `Steam GET ${summaries} failed after 3 attempts: timed out after 15s`
);

// A 429 pauses every Steam request until the time in Retry-After, or for a minute. The request
// queued before the 429 waits out the pause too, and is sent with a signal made then.
for (const [headers, pause] of [
  [{ 'retry-after': '20' }, 20000],
  [{}, 60000]
]) {
  steam = await load();
  reply = (request, count) => {
    if (count === 1) throw axiosError(request, { status: 429, headers });
    return { status: 200, headers: {}, data: { response: { players: [] } } };
  };
  const start = clock;
  await Promise.all([steam('get', summaries, { steamids: '1' }), steam('get', summaries, {})]);
  assert.strictEqual(requests.length, 3);
  assert.deepStrictEqual(
    limiter.jobs.slice(0, 2).map((job) => job.at),
    [start, start]
  );
  for (const request of requests.slice(1))
    assert.ok(request.at >= start + pause, `Sent ${request.at - start} ms after the 429`);
  assertSignals();
}

// Steam gives no count of requests left, so a header that looks like one is ignored.
steam = await load();
reply = () => ({ status: 200, headers: { 'x-rate-limit-remaining': '1' }, data: {} });
await steam('get', summaries, {});
await steam('get', summaries, {});
assert.deepStrictEqual(gaps(), [1500]);

// An error without a code is described by its message, with the key removed if it repeats it.
steam = await load();
reply = () => {
  throw new Error(`Bad request to /?key=${KEY}`);
};
const err = await failure(steam('get', summaries, {}));
assert.strictEqual(
  err.message,
  `Steam GET ${summaries} failed after 3 attempts: the request failed (Bad request to /?key=[redacted])`
);
assert.strictEqual(requests.length, 3);
assertSignals();

console.log(
  'Steam request checks passed: requests, time limits, refused keys, retries, pauses and keys kept out of errors.'
);
