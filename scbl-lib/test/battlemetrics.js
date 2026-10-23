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
  Date: FakeDate,
  // Math.random always gives 0.8, so each wait before a retry is a fifth longer than its base.
  Math: Object.assign(Object.create(Math), { random: () => 0.8 })
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

// axios records each request, and whether its signal had already aborted, and answers it with
// reply().
let requests;
let reply;
const axios = async (request) => {
  requests.push({ ...request, at: clock, abortedWhenSent: request.signal?.aborted });
  return reply(request, requests.length);
};

// Every attempt is cut off 30 s after it is sent, by a signal of its own: one shared with earlier
// attempts, or made while the attempt waited in the queue or for a pause, could already have
// aborted. A check that gives its attempts other time limits sets limits to each request's.
let limits = null;
function assertSignals() {
  for (const [i, request] of requests.entries()) {
    const which = `Request ${i + 1}, ${request.method} ${request.url}`;
    assert.ok(request.signal instanceof FakeAbortSignal, which);
    assert.strictEqual(request.signal.ms, limits?.[i] ?? 30000, which);
    assert.strictEqual(request.timeout, request.signal.ms, which);
    assert.strictEqual(request.signal.createdAt, request.at, which);
    assert.strictEqual(request.abortedWhenSent, false, which);
  }
  assert.strictEqual(new Set(requests.map((request) => request.signal)).size, requests.length);
}

// An answer that never comes. As with axios, the request fails once its signal aborts, or at once
// if it already has.
const hang = (request) =>
  new Promise((resolve, reject) => {
    const cancel = () => reject(axiosError(request, { code: 'ERR_CANCELED', message: 'canceled' }));
    if (request.signal.aborted) cancel();
    else request.signal.addEventListener('abort', cancel);
  });

const dependencies = {
  axios: { default: axios },
  bottleneck: { default: Bottleneck },
  '../config.js': {
    BATTLEMETRICS_API_KEY: TOKEN,
    BATTLEMETRICS_API_RESERVOIR: '10',
    BATTLEMETRICS_API_RESERVOIR_VARIABLE: 'BATTLEMETRICS_API_RESERVOIR'
  }
};

// Load a client of its own, with no pause and no jobs, and nothing logged yet. The last client's
// requests are checked for their signals first.
async function load() {
  if (requests) assertSignals();
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
  limits = null;
  logs.length = 0;
  reply = () => ({ status: 200, headers: {}, data: { data: [] } });
  client = module.namespace;
  return module.namespace.default;
}
// The client last loaded, with its other exports.
let client;

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
assert.ok(requests[0].signal instanceof FakeAbortSignal);
assert.strictEqual(requests[0].signal.ms, 30000);
assert.strictEqual(requests[0].abortedWhenSent, false);
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
assertSignals();
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

// The token is removed from the path too, should a caller ever put it there.
battlemetrics = await load();
reply = failWith({ status: 400 });
err = await failure(battlemetrics('get', `bans/${TOKEN}`));
assert.strictEqual(err.message, 'BattleMetrics GET bans/[redacted] failed: HTTP 400');

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
// own, so retries use the budget. Each wait gets up to a quarter more at random, here a fifth.
battlemetrics = await load();
reply = failWith({ status: 503, data: { errors: [{ title: 'Service Unavailable' }] } });
err = await failure(battlemetrics('get', 'bans'));
assert.strictEqual(requests.length, 3);
assert.strictEqual(limiter.jobs.length, 3);
assert.strictEqual(new Set(limiter.jobs.map((job) => job.id)).size, 3);
assert.deepStrictEqual(gaps(), [1200, 4800]);
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
// The client counts every attempt it made, each retry too, as each uses the budget, for the
// importer service's hourly summary.
assert.strictEqual(client.requestCount(), 3);
await battlemetrics('delete', 'bans/42').catch(() => {});
assert.strictEqual(client.requestCount(), 6);
reply = () => ({ status: 204, headers: {} });
await battlemetrics('delete', 'bans/43');
assert.strictEqual(client.requestCount(), 7);

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

// A GET whose answer never comes is cut off 30 s after it is sent, and tried again with a signal
// of its own, so the third attempt can still work.
battlemetrics = await load();
reply = (request, count) => (count < 3 ? hang(request) : { status: 200, headers: {}, data: {} });
assert.strictEqual((await battlemetrics('get', 'bans')).status, 200);
assert.strictEqual(requests.length, 3);
assert.deepStrictEqual(gaps(), [30000 + 1200, 30000 + 4800]);
assertSignals();

// An answer that comes after ms, unless the request is cut off first. Its timer goes once the
// request is cut off, so it moves the clock no further.
const answerAfter = (ms, answer) => (request) =>
  new Promise((resolve, reject) => {
    const timer = fakeTimeout(() => resolve(answer), ms);
    request.signal.addEventListener('abort', () => {
      timers = timers.filter((other) => other !== timer);
      reject(axiosError(request, { code: 'ERR_CANCELED', message: 'canceled' }));
    });
  });
const PAGE_TIMEOUTS = [30000, 45000, 55000];

// A caller can give its attempts time limits of their own, as the importer does for its reads of
// pages of bans: each attempt is cut off after its own, by a signal of its own, and its error says
// how long it had. The attempts, the waits between them and what counts as a failure are as for
// any GET: 3 attempts, about 1 and 4 seconds apart, each a job of its own on the limiter, counted.
battlemetrics = await load();
limits = PAGE_TIMEOUTS;
reply = hang;
err = await failure(battlemetrics('get', 'bans', {}, undefined, 5, { timeouts: PAGE_TIMEOUTS }));
assert.strictEqual(requests.length, 3);
assert.strictEqual(limiter.jobs.length, 3);
assert.strictEqual(client.requestCount(), 3);
assert.deepStrictEqual(gaps(), [30000 + 1200, 45000 + 4800]);
assert.strictEqual(
  err.message,
  'BattleMetrics GET bans failed after 3 attempts: timed out after 55s'
);
assert.deepStrictEqual(
  logs.map(([line]) => line).filter((line) => line.includes('Trying again')),
  [
    'BattleMetrics GET bans failed: timed out after 30s. Trying again in 1.2s (attempt 2 of 3).',
    'BattleMetrics GET bans failed after 2 attempts: timed out after 45s. Trying again in 4.8s (attempt 3 of 3).'
  ]
);
// So a page that takes 50 seconds to answer is read at its third attempt, which it would not be
// without them.
battlemetrics = await load();
limits = PAGE_TIMEOUTS;
const page = { status: 200, headers: {}, data: { data: ['ban'] } };
reply = answerAfter(50000, page);
assert.strictEqual(
  await battlemetrics('get', 'bans', {}, undefined, 5, { timeouts: PAGE_TIMEOUTS }),
  page
);
assert.strictEqual(requests.length, 3);
battlemetrics = await load();
reply = answerAfter(50000, page);
err = await failure(battlemetrics('get', 'bans'));
assert.strictEqual(
  err.message,
  'BattleMetrics GET bans failed after 3 attempts: timed out after 30s'
);
// An attempt that a caller's list gives no limit to has the last it gives, and limits that are not
// a time are left out.
battlemetrics = await load();
limits = [45000, 45000, 45000];
reply = hang;
await failure(battlemetrics('get', 'bans', {}, undefined, 5, { timeouts: [45000] }));
battlemetrics = await load();
limits = [30000, 30000, 20000];
reply = hang;
await failure(battlemetrics('get', 'bans', {}, undefined, 5, { timeouts: [null, 'x', 20000] }));
// Requests made as the web server and the bot make them, without time limits of their own, have
// the client's 30 seconds for every attempt, whatever else they give, as do the requests above.
battlemetrics = await load();
reply = (request, count) => {
  if (count === 1) throw axiosError(request, { code: 'ECONNABORTED', message: 'timeout' });
  return { status: 201, headers: {}, data: {} };
};
await battlemetrics('post', 'ban-lists/1/relationships/invites', {}, {}, 5, { repeatable: true });
await battlemetrics('get', 'ban-lists/1', {}, undefined, 2, {});
assert.strictEqual(requests.length, 3);
assertSignals();

// A caller can have a request end before an attempt is sent, as the importer does once its run is
// asked to stop (beforeAttempt): before the wait for another attempt, and once an attempt's turn in
// the queue has come, just before it is sent. What it throws ends the request as it is, rather than
// as a failed attempt, and nothing more is sent. A request whose first attempt it stops sends
// nothing at all, though its job has used its place in the budget; the client counts only the
// attempts it sent.
class Stopped extends Error {}
const stopping = (from) => {
  const hook = () => {
    hook.calls++;
    if (hook.calls >= from) throw new Stopped('stopping');
  };
  hook.calls = 0;
  return hook;
};
battlemetrics = await load();
let beforeAttempt = stopping(1);
err = await battlemetrics('get', 'bans', {}, undefined, 5, { beforeAttempt }).catch((e) => e);
assert.ok(err instanceof Stopped, String(err));
assert.deepStrictEqual([requests.length, limiter.jobs.length, client.requestCount()], [0, 1, 0]);
// A stop that comes while an attempt waits for its answer makes no attempt after it, and the
// failed attempt is still logged.
battlemetrics = await load();
limits = PAGE_TIMEOUTS;
beforeAttempt = stopping(2);
reply = hang;
const options = { timeouts: PAGE_TIMEOUTS, beforeAttempt };
err = await battlemetrics('get', 'bans', {}, undefined, 5, options).catch((e) => e);
assert.ok(err instanceof Stopped, String(err));
assert.deepStrictEqual([requests.length, limiter.jobs.length, beforeAttempt.calls], [1, 1, 2]);
assert.deepStrictEqual(
  logs.map(([line]) => line).filter((line) => line.includes(' failed')),
  [
    'BattleMetrics GET bans failed: timed out after 30s. Not trying again, as the request was stopped.'
  ]
);
// A stop that comes during the wait before another attempt, or while it waits in the queue, ends
// the request once the attempt's turn has come, without sending it.
battlemetrics = await load();
limits = PAGE_TIMEOUTS;
beforeAttempt = stopping(3);
reply = hang;
err = await battlemetrics('get', 'bans', {}, undefined, 5, {
  timeouts: PAGE_TIMEOUTS,
  beforeAttempt
}).catch((e) => e);
assert.ok(err instanceof Stopped, String(err));
assert.deepStrictEqual(
  [requests.length, limiter.jobs.length, client.requestCount(), beforeAttempt.calls],
  [1, 2, 1, 3]
);
// Until it stops a request, it changes nothing: a request it never stops is made as any other, and
// it is not called for a failure that is not tried again.
battlemetrics = await load();
beforeAttempt = stopping(Infinity);
reply = failWith({ status: 503 });
err = await failure(battlemetrics('get', 'bans', {}, undefined, 5, { beforeAttempt }));
assert.deepStrictEqual([requests.length, beforeAttempt.calls], [3, 5]);
assert.strictEqual(err.message, 'BattleMetrics GET bans failed after 3 attempts: HTTP 503');
battlemetrics = await load();
beforeAttempt = stopping(Infinity);
reply = failWith({ status: 404 });
await failure(battlemetrics('get', 'bans', {}, undefined, 5, { beforeAttempt }));
assert.deepStrictEqual([requests.length, beforeAttempt.calls], [1, 1]);

// A POST that its caller marks as repeatable, such as one creating an invite, is tried again like
// a GET after a 5xx or a timeout. The same POST is not, unless it is marked.
for (const failed of [{ status: 503 }, { code: 'ECONNABORTED', message: 'timeout exceeded' }]) {
  battlemetrics = await load();
  reply = (request, count) => {
    if (count === 1) throw axiosError(request, failed);
    return { status: 201, headers: {}, data: { data: { id: 'invite' } } };
  };
  const invite = await battlemetrics('post', 'ban-lists/1/relationships/invites', {}, {}, 5, {
    repeatable: true
  });
  assert.strictEqual(invite.status, 201);
  assert.strictEqual(requests.length, 2, JSON.stringify(failed));

  battlemetrics = await load();
  reply = failWith(failed);
  err = await failure(battlemetrics('post', 'ban-lists/1/relationships/invites', {}, {}));
  assert.strictEqual(requests.length, 1, JSON.stringify(failed));
  assert.strictEqual(err.ambiguous, true);
}

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
// A request queued before the 429 waits out the pause too, and is sent with a signal made then.
battlemetrics = await load();
reply = (request) => {
  if (request.url.endsWith('/bans')) throw axiosError(request, { status: 429 });
  return { status: 200, headers: {}, data: {} };
};
const pausedAt = clock;
const [limitedError] = await Promise.all([
  failure(battlemetrics('get', 'bans')),
  battlemetrics('get', 'bans/2')
]);
const sentAfter = (path) =>
  requests.filter((request) => request.url.endsWith(path)).map((request) => request.at - pausedAt);
assert.deepStrictEqual(sentAfter('/bans'), [0, 60000, 120000]);
assert.deepStrictEqual(sentAfter('/bans/2'), [60000]);
// Both joined the queue before the 429.
assert.deepStrictEqual(
  limiter.jobs.slice(0, 2).map((job) => job.at),
  [pausedAt, pausedAt]
);
assert.strictEqual(
  limitedError.message,
  'BattleMetrics GET bans failed after 3 attempts: HTTP 429'
);
// The wait logged before a retry is the pause's.
assert.ok(logs.some(([line]) => /Trying again in 60s \(attempt 2 of 3\)/.test(line)));
assertSignals();

// A Retry-After of a day, in seconds or as a date, is cut to 5 minutes, and so is the pause it
// starts, so a wrong header cannot hold up every request for long.
for (const retryAfter of [
  () => '86400',
  () => new Date(clock + 24 * 60 * 60 * 1000).toUTCString()
]) {
  battlemetrics = await load();
  reply = (request, count) => {
    if (count > 1) return { status: 200, headers: {}, data: {} };
    throw axiosError(request, { status: 429, headers: { 'retry-after': retryAfter() } });
  };
  const limitedAt = clock;
  await Promise.all([
    battlemetrics('get', 'bans'),
    wait(1000).then(() => battlemetrics('get', 'bans/2'))
  ]);
  assert.strictEqual(requests.length, 3);
  for (const request of requests.slice(1)) {
    const after = request.at - limitedAt;
    assert.ok(after >= 300000 && after <= 301500, `Sent ${after} ms after the 429`);
  }
  assert.ok(logs.some(([line]) => /so no requests are sent for 300s/.test(line)));
}

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
assertSignals();

// Logged lines never hold the token either.
assert.ok(!inspect(logs, { depth: null }).includes(TOKEN));

console.log(
  "BattleMetrics request checks passed: requests, time limits, callers' own time limits for each attempt and stops before an attempt, final and retried errors, ambiguous and repeatable writes, pauses and concurrent requests."
);
