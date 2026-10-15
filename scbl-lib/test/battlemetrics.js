import assert from 'assert';
import { readFile } from 'fs/promises';
import { inspect } from 'util';
import vm from 'vm';

// Exercise the API client without credentials, network requests, or real waits. Its waits run on
// a fake clock: once nothing else is left to run, the next timer fires and moves the clock on.
const TOKEN = 'test-token-0123456789';
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
  AbortSignal,
  Date: FakeDate
});

// A stand-in for Bottleneck that records each job and starts jobs at least 250 ms apart.
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
    this.nextStart = start + 250;
    return wait(start - clock).then(() => task());
  }
}

// axios records each request and answers it with reply().
let requests;
let reply;
const axios = async (request) => {
  requests.push({ ...request, at: clock });
  return reply(request, requests.length);
};

const dependencies = {
  axios: { default: axios },
  bottleneck: { default: Bottleneck },
  '../config.js': {
    BATTLEMETRICS_API_KEY: TOKEN,
    BATTLEMETRICS_API_RESERVOIR: '10',
    BATTLEMETRICS_API_RESERVOIR_VARIABLE: 'BATTLEMETRICS_API_RESERVOIR'
  }
};

// Load a client of its own, with no pause and no jobs, and nothing logged yet.
async function load() {
  const url = new URL('../apis/battlemetrics.js', import.meta.url);
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
  reply = () => ({ status: 200, headers: {}, data: { data: [] } });
  return module.namespace.default;
}

// An error as axios gives one, holding the request with its headers, and so the token.
function axiosError(request, { status, code, message, data, headers = {} } = {}) {
  const err = new Error(message || `Request failed with status code ${status}`);
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.code = code || (status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST');
  err.config = request;
  err.request = { _header: `${request.method} / HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}` };
  if (status) err.response = { status, headers, data, config: request, request: err.request };
  return err;
}

const failWith = (details) => (request) => {
  throw axiosError(request, details);
};

// Neither an error nor anything logged may hold the token, or the request it came from.
function assertNoSecrets(err) {
  for (const text of [
    inspect(err, { depth: null, showHidden: true }),
    JSON.stringify(err),
    String(err.stack),
    inspect(logs, { depth: null })
  ])
    assert.ok(!text.includes(TOKEN), `Secret found in: ${text}`);
  for (const key of ['config', 'request', 'cause']) assert.strictEqual(err[key], undefined, key);
  if (err.response) assert.deepStrictEqual(Object.keys(err.response), ['status', 'data']);
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assertNoSecrets(err);
    return err;
  }
  assert.fail('The request should have failed');
}

const gaps = () => requests.slice(1).map((request, i) => request.at - requests[i].at);

// Requests go to BattleMetrics with the token and the caller's priority, and time limits.
let battlemetrics = await load();
const endpoint = 'ban-lists/01234567-89ab-cdef-0123-456789abcdef/relationships/organizations/42';
const response = { status: 204, headers: {} };
reply = () => response;
assert.strictEqual(await battlemetrics('delete', endpoint), response);
assert.strictEqual(requests[0].method, 'delete');
assert.strictEqual(requests[0].url, `https://api.battlemetrics.com/${endpoint}`);
assert.strictEqual(requests[0].data, undefined, 'Unsubscribe must not send an empty JSON body');
assert.strictEqual(requests[0].headers.Authorization, `Bearer ${TOKEN}`);
assert.strictEqual(requests[0].timeout, 30000);
assert.ok(requests[0].signal instanceof AbortSignal);
assert.strictEqual(requests[0].signal.aborted, false);
assert.strictEqual(limiter.jobs[0].priority, 5);

await battlemetrics('delete', 'bans/42');
assert.strictEqual(requests[1].data, undefined);

const params = { 'page[size]': 10 };
await battlemetrics('get', 'ban-lists', params);
assert.strictEqual(requests[2].params, params);
assert.strictEqual(requests[2].data, undefined);

for (const method of ['post', 'patch']) {
  const payload = { data: { type: 'banList', attributes: { name: 'Test list' } } };
  await battlemetrics(method, 'ban-lists', params, payload, 2);
  assert.strictEqual(requests[requests.length - 1].data, payload);
  assert.strictEqual(limiter.jobs[limiter.jobs.length - 1].priority, 2);
}

// Every attempt has a signal of its own, and every job an ID of its own.
assert.strictEqual(new Set(requests.map((request) => request.signal)).size, requests.length);
assert.strictEqual(new Set(limiter.jobs.map((job) => job.id)).size, limiter.jobs.length);
assert.ok(limiter.jobs.every((job) => /^BM-\d+$/.test(job.id)));

// A 404 is final, so it is tried once, and its error keeps BattleMetrics' explanation where
// callers read it.
battlemetrics = await load();
reply = failWith({
  status: 404,
  data: { errors: [{ status: '404', title: 'Not Found', detail: 'Unknown ban list.' }] }
});
let err = await failure(battlemetrics('get', 'bans', { 'filter[banList]': 'list' }));
assert.strictEqual(requests.length, 1);
assert.strictEqual(limiter.jobs.length, 1);
assert.strictEqual(err.name, 'ApiError');
assert.strictEqual(err.message, 'BattleMetrics GET bans failed: HTTP 404 (Not Found)');
assert.deepStrictEqual(
  [err.method, err.path, err.status, err.code, err.attempts],
  ['GET', 'bans', 404, 'ERR_BAD_REQUEST', 1]
);
assert.deepStrictEqual([...err.titles], ['Not Found']);
assert.strictEqual(err.response.status, 404);
assert.strictEqual(err.response.data.errors[0].detail, 'Unknown ban list.');
assert.strictEqual(err.ambiguous, false);
assert.strictEqual(err.auth, false);
assert.ok(!err.message.includes('filter'), 'Parameters are not described');

// Other answers that would only fail again are tried once too, whatever the method.
for (const [method, status] of [
  ['delete', 404],
  ['post', 400],
  ['post', 408],
  ['patch', 422],
  ['get', 403]
]) {
  battlemetrics = await load();
  reply = failWith({ status });
  err = await failure(battlemetrics(method, 'bans/42', {}, method === 'get' ? undefined : {}));
  assert.strictEqual(requests.length, 1, `${method} ${status}`);
  assert.strictEqual(err.status, status);
  assert.strictEqual(err.ambiguous, false);
}

// A 401 means the token was refused, which the caller is told, so it can stop.
battlemetrics = await load();
reply = failWith({
  status: 401,
  data: { errors: [{ title: 'Unauthorized', detail: `The token ${TOKEN} is not valid.` }] }
});
err = await failure(battlemetrics('get', 'bans'));
assert.strictEqual(requests.length, 1);
assert.strictEqual(err.auth, true);
assert.strictEqual(err.response.data.errors[0].detail, 'The token [redacted] is not valid.');

// A 503 on a GET is tried three times, about 1 s and then 4 s apart, each time as a job of its
// own, so retries use the budget.
battlemetrics = await load();
reply = failWith({ status: 503, data: { errors: [{ title: 'Service Unavailable' }] } });
err = await failure(battlemetrics('get', 'bans'));
assert.strictEqual(requests.length, 3);
assert.strictEqual(limiter.jobs.length, 3);
assert.strictEqual(new Set(limiter.jobs.map((job) => job.id)).size, 3);
const [first, second] = gaps();
assert.ok(first >= 1000 && first <= 1250, `First wait was ${first} ms`);
assert.ok(second >= 4000 && second <= 5000, `Second wait was ${second} ms`);
assert.strictEqual(
  err.message,
  'BattleMetrics GET bans failed after 3 attempts: HTTP 503 (Service Unavailable)'
);
assert.strictEqual(err.attempts, 3);
assert.strictEqual(err.ambiguous, false);
assert.strictEqual(
  logs.filter(([line]) => /Trying again in [\d.]+s \(attempt \d of 3\)/.test(line)).length,
  2
);

// A request that works when tried again returns its answer, and a Retry-After is honoured.
battlemetrics = await load();
reply = (request, count) => {
  if (count === 1) throw axiosError(request, { status: 502, headers: { 'retry-after': '7' } });
  return { status: 200, headers: {}, data: { data: ['ban'] } };
};
assert.deepStrictEqual((await battlemetrics('get', 'bans')).data, { data: ['ban'] });
assert.strictEqual(requests.length, 2);
assert.ok(gaps()[0] >= 7000, `Waited ${gaps()[0]} ms`);

// GET and DELETE requests are also tried again when no answer came, or the connection failed.
for (const [method, code] of [
  ['get', 'ECONNABORTED'],
  ['get', 'ERR_CANCELED'],
  ['delete', 'ECONNRESET'],
  ['delete', 'ENOTFOUND']
]) {
  battlemetrics = await load();
  reply = failWith({ code, message: 'socket trouble' });
  err = await failure(battlemetrics(method, 'bans/42'));
  assert.strictEqual(requests.length, 3, `${method} ${code}`);
  assert.strictEqual(err.code, code);
  assert.strictEqual(err.response, undefined);
  assert.strictEqual(err.ambiguous, false);
}
assert.match(err.message, /^BattleMetrics DELETE bans\/42 failed after 3 attempts: could not/);

// A POST that timed out may have been carried out, so it is not tried again, and the error says
// so. The same goes for one that was cut off or failed with 5xx, and for a PATCH.
battlemetrics = await load();
reply = failWith({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' });
err = await failure(battlemetrics('post', 'bans', {}, { data: {} }));
assert.strictEqual(requests.length, 1);
assert.strictEqual(err.ambiguous, true);
assert.strictEqual(
  err.message,
  'BattleMetrics POST bans failed: timed out after 30s, so it may have been carried out'
);
for (const [method, details] of [
  ['post', { code: 'ERR_CANCELED', message: 'canceled' }],
  ['post', { code: 'ECONNRESET', message: 'socket hang up' }],
  ['post', { status: 500 }],
  ['patch', { status: 503 }],
  ['patch', { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }]
]) {
  battlemetrics = await load();
  reply = failWith(details);
  err = await failure(battlemetrics(method, 'ban-lists/1', {}, { data: {} }));
  assert.strictEqual(requests.length, 1, `${method} ${JSON.stringify(details)}`);
  assert.strictEqual(err.ambiguous, true);
}

// A POST is tried again when no connection could be made, as BattleMetrics never received it.
for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
  battlemetrics = await load();
  reply = (request, count) => {
    if (count === 1) throw axiosError(request, { code, message: `connect ${code}` });
    return { status: 201, headers: {}, data: { data: { id: 'ban' } } };
  };
  assert.strictEqual((await battlemetrics('post', 'bans', {}, {})).status, 201);
  assert.strictEqual(requests.length, 2, code);
}

// A 429 pauses every request until the time in Retry-After, including one already queued and
// one made during the pause, which waits before it joins the queue. A POST is tried again after
// it too, as BattleMetrics did not carry it out.
battlemetrics = await load();
reply = (request, count) => {
  if (count === 1) throw axiosError(request, { status: 429, headers: { 'retry-after': '30' } });
  return { status: 201, headers: {}, data: {} };
};
const start = clock;
const limited = battlemetrics('post', 'bans', {}, {});
const queued = battlemetrics('get', 'bans/2');
const later = wait(1000).then(() => battlemetrics('get', 'bans/3'));
await Promise.all([limited, queued, later]);
assert.strictEqual(requests.length, 4);
assert.strictEqual(requests[0].at, start);
for (const request of requests.slice(1))
  assert.ok(request.at >= start + 30000, `Sent ${request.at - start} ms after the 429`);
// Only the two requests made before the 429 joined the queue before the pause ended.
assert.strictEqual(limiter.jobs.length, 4);
assert.deepStrictEqual(
  limiter.jobs.map((job) => job.at >= start + 30000),
  [false, false, true, true]
);
assert.strictEqual(
  logs.filter(([line]) =>
    /answered HTTP 429 Too Many Requests, so no requests are sent for 30s/.test(line)
  ).length,
  1
);

// Without a Retry-After, a 429 pauses requests for a minute, and a GET still gets its 3 attempts.
battlemetrics = await load();
reply = failWith({ status: 429 });
const pausedAt = clock;
err = await failure(battlemetrics('get', 'bans'));
assert.strictEqual(requests.length, 3);
assert.ok(requests[1].at >= pausedAt + 60000 && requests[2].at >= requests[1].at + 60000);
assert.strictEqual(err.message, 'BattleMetrics GET bans failed after 3 attempts: HTTP 429');

// Fewer than 60 requests left for the key this minute pauses requests for a minute too.
battlemetrics = await load();
reply = () => ({ status: 200, headers: { 'x-rate-limit-remaining': '59' }, data: {} });
await battlemetrics('get', 'bans');
reply = () => ({ status: 200, headers: { 'x-rate-limit-remaining': '60' }, data: {} });
await battlemetrics('get', 'bans');
await battlemetrics('get', 'bans');
assert.deepStrictEqual(gaps(), [60000, 250]);
assert.ok(logs.some(([line]) => /has 59 requests left for the API key this minute/.test(line)));

// When BattleMetrics gives a lower limit than 300 a minute, the pause starts below a fifth of it.
battlemetrics = await load();
const lowLimit = (remaining) => () => ({
  status: 200,
  headers: { 'x-rate-limit-limit': '60', 'x-rate-limit-remaining': String(remaining) },
  data: {}
});
reply = lowLimit(12);
await battlemetrics('get', 'bans');
reply = lowLimit(11);
await battlemetrics('get', 'bans');
await battlemetrics('get', 'bans');
assert.deepStrictEqual(gaps(), [250, 60000]);

// Requests made at the same time each get a job of their own, and one that is retried does not
// hold up the others.
battlemetrics = await load();
reply = (request, count) => {
  if (count === 2) throw axiosError(request, { status: 503 });
  return { status: 200, headers: {}, data: { url: request.url } };
};
const results = await Promise.all([1, 2, 3, 4, 5].map((id) => battlemetrics('get', `bans/${id}`)));
assert.deepStrictEqual(
  results.map((result) => result.data.url),
  [1, 2, 3, 4, 5].map((id) => `https://api.battlemetrics.com/bans/${id}`)
);
assert.strictEqual(requests.length, 6);
assert.strictEqual(limiter.jobs.length, 6);
assert.strictEqual(new Set(limiter.jobs.map((job) => job.id)).size, 6);
assert.strictEqual(requests[5].url, 'https://api.battlemetrics.com/bans/2');

// Logged lines never hold the token either.
assert.ok(!inspect(logs, { depth: null }).includes(TOKEN));

console.log(
  'BattleMetrics request checks passed: requests, final and retried errors, ambiguous writes, pauses and concurrent requests.'
);
