import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import classifyBanReason from '../../scbl-lib/utils/classify-ban-reason.js';

// The importer's reads of pages of bans as they run: BanFetcher with the attempts it gives each
// page, the shared client's own retries and stop checks (scbl-lib/apis/create-api-client.js), and
// the run control, on a fake clock, with a BattleMetrics that does not answer a page at some or all
// of the attempts at it, as production's at times did not, without even its headers. Waits get a
// fifth more than their base here, of the quarter at random they may get.
let clock = Date.UTC(2026, 9, 23, 16);
let timers = [];
let timerCount = 0;
let ticking = false;

// Once nothing else is left to run, the next timer fires and moves the clock on.
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

// AbortSignal.timeout's signals abort on the fake clock, as an attempt's time limit cuts it off.
class FakeAbortSignal extends EventTarget {
  static timeout(ms) {
    return new FakeAbortSignal(ms);
  }

  constructor(ms) {
    super();
    this.ms = ms;
    this.aborted = false;
    fakeTimeout(() => {
      this.aborted = true;
      this.dispatchEvent(new Event('abort'));
    }, ms);
  }
}

const lines = [];
const context = vm.createContext({
  URL,
  console: {
    log: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' '))
  },
  setTimeout: fakeTimeout,
  clearTimeout: (timer) => {
    timers = timers.filter((other) => other !== timer);
  },
  AbortSignal: FakeAbortSignal,
  Date: FakeDate,
  Math: Object.assign(Object.create(Math), { random: () => 0.8 })
});

async function load(path, dependencies = {}) {
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    if (exports instanceof vm.Module) return exports;
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  return module;
}

// BattleMetrics: a list of three pages of 100 bans, whose count says so. answers(page, attempt)
// says whether it answers that attempt at that page, the first attempt at it 1; one it does not
// answer gets no answer at all, until the attempt is cut off. Each request is recorded.
let requests = [];
let answers = () => true;
const PAGES = { first: 'two', two: 'three', three: null };
const pageOf = (params) => params['page[key]'] ?? 'first';
const steamID = (n) => String(76561198000000000n + BigInt(n));
function send(method, endpoint, params, data, options) {
  const page = pageOf(params);
  const attempt = requests.filter((request) => request.page === page).length + 1;
  requests.push({ page, attempt, at: clock, timeout: options.timeout, ms: options.signal.ms });
  if (!answers(page, attempt))
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
      );
    });
  const next = PAGES[page];
  const n = Object.keys(PAGES).indexOf(page);
  return Promise.resolve({
    status: 200,
    headers: {},
    data: {
      data: Array.from({ length: 100 }, (_, k) => ({
        attributes: {
          uid: `ban-${n * 100 + k}`,
          timestamp: new Date(Date.UTC(2026, 9, 1) - (n * 100 + k) * 60000).toISOString(),
          identifiers: [{ type: 'steamID', identifier: steamID(n * 100 + k) }]
        }
      })),
      meta: { total: 300 },
      links: next
        ? {
            next: `https://api.battlemetrics.com/bans?filter[banList]=bm-1&sort=-timestamp&page[size]=100&page[key]=${next}`
          }
        : {}
    }
  });
}

// The shared client, as the BattleMetrics client makes it, with a limiter that starts each job at
// once, as it does while the minute's budget lasts.
const createApiClient = (await load('../../scbl-lib/apis/create-api-client.js')).namespace.default;
const jobs = [];
const request = createApiClient({
  name: 'BattleMetrics',
  limiter: {
    schedule: (options, task) => {
      jobs.push(options);
      return wait(0).then(() => task());
    }
  },
  jobPrefix: 'BM',
  timeout: 30000,
  minRemaining: 60,
  send
});

const control = await load('../src/run-control.js');
const { RunStopped, clearStop, requestStop } = control.namespace;
const fetcherModule = await load('../src/ban-fetcher.js', {
  axios: { default: {} },
  crypto: { createHash },
  'scbl-lib/apis': { battlemetrics: request },
  'scbl-lib/utils': { classifyBanReason, Logger: { verbose() {} } },
  './run-control.js': control,
  './steam-id.js': await load('../src/steam-id.js')
});
const BanFetcher = fetcherModule.namespace.default;
const banList = { id: 1, type: 'battlemetrics', source: 'bm-1' };

// Read the list in full, with BattleMetrics answering as answers says, and a stop requested at
// stopAt, if given. Returns how the read ended (list or error), when, and the attempts at page two,
// with when each was sent from when the first was.
async function read({ answer, stopAt = null, reason = 'it took longer than 1200s' }) {
  clearStop();
  requests = [];
  jobs.length = 0;
  lines.length = 0;
  answers = answer;
  const startedAt = clock;
  if (stopAt !== null) fakeTimeout(() => requestStop(reason), stopAt - clock);
  let list = null;
  let error = null;
  try {
    list = await new BanFetcher().fetchBanList(banList);
  } catch (err) {
    error = err;
  }
  const two = requests.filter((one) => one.page === 'two');
  return {
    list,
    error,
    endedAt: clock,
    startedAt,
    two,
    // When page two was first asked for, and when each of its attempts was sent, from then.
    twoAskedAt: two[0]?.at,
    twoSent: two.map((one) => one.at - two[0].at),
    retries: lines.filter((line) => line.includes('BattleMetrics GET bans failed'))
  };
}

// The attempts at a page: cut off after 15, 15, 20, 30 and 45 seconds, sent 0, 16.2, 33.6, 56 and
// 90.8 seconds after the first, with waits of 1, 2, 2 and 4 seconds, here each a fifth longer.
const TIMEOUTS = [15000, 15000, 20000, 30000, 45000];
const SENT = [0, 16200, 33600, 56000, 90800];
const CUT_OFF = SENT.map((at, i) => at + TIMEOUTS[i]);

// A page that is not answered at its first three attempts is read at its fourth, 56 seconds after
// it was first asked for, and the list is read in full: its 300 bans, as many as BattleMetrics
// counts. Each attempt had its own time limit, and each was a job of its own on the limiter.
let result = await read({ answer: (page, attempt) => page !== 'two' || attempt >= 4 });
assert.strictEqual(result.error, null, String(result.error));
assert.strictEqual(new Set(Array.from(result.list.bans, (ban) => ban.id)).size, 300);
assert.deepStrictEqual(
  [result.list.bans[0].id, result.list.bans[299].id],
  ['1,ban-0', '1,ban-299']
);
assert.strictEqual(result.list.complete, true);
assert.deepStrictEqual(result.twoSent, SENT.slice(0, 4));
assert.deepStrictEqual(
  result.two.map((one) => [one.timeout, one.ms]),
  TIMEOUTS.slice(0, 4).map((ms) => [ms, ms])
);
assert.deepStrictEqual(
  requests.map((one) => one.page),
  ['first', 'two', 'two', 'two', 'two', 'three']
);
assert.strictEqual(jobs.length, 6);
assert.deepStrictEqual(result.retries, [
  'BattleMetrics GET bans failed: timed out after 15s. Trying again in 1.2s (attempt 2 of 5).',
  'BattleMetrics GET bans failed after 2 attempts: timed out after 15s. Trying again in 2.4s (attempt 3 of 5).',
  'BattleMetrics GET bans failed after 3 attempts: timed out after 20s. Trying again in 2.4s (attempt 4 of 5).'
]);
// One answered at its second attempt is read 16.2 seconds after it was first asked for.
result = await read({ answer: (page, attempt) => page !== 'two' || attempt >= 2 });
assert.strictEqual(result.list.bans.length, 300);
assert.deepStrictEqual(result.twoSent, SENT.slice(0, 2));
assert.strictEqual(result.endedAt - result.twoAskedAt, 16200);

// A page that is never answered fails the read after its fifth attempt, 135.8 seconds after it was
// first asked for: 125 seconds of attempts and 10.8 of waits, at most 136.25 with the waits a
// quarter longer. The error says which page, of about how many, and the page after it is never
// asked for, so nothing of the list is returned, and so nothing of it is saved.
result = await read({ answer: (page) => page !== 'two' });
assert.strictEqual(result.list, null);
assert.strictEqual(result.error.name, 'ApiError');
assert.strictEqual(
  result.error.message,
  'BattleMetrics GET bans failed after 5 attempts: timed out after 45s'
);
assert.deepStrictEqual([result.error.page, result.error.pages], [2, 3]);
assert.deepStrictEqual(result.twoSent, SENT);
assert.strictEqual(result.endedAt - result.twoAskedAt, 135800);
assert.ok(!requests.some((one) => one.page === 'three'));
assert.strictEqual(result.retries.length, 4);

// A stop, at the run's time limit or after SIGTERM, holds the read up by at most the attempt under
// way: a stop a second after any attempt at the page is sent ends the read with RunStopped, marked
// with the page, once that attempt is cut off, with no attempt after it. So the run stops at most
// 45 seconds after the stop, at the last attempt, and at most 30 at any other, within the 60
// seconds after its time limit before a run is ended at once, which leaves once mode 15 seconds to
// end the run in, and, but at the last attempt, before the 45 seconds after SIGTERM at which the
// importer service ends a cycle that has not stopped. A stop during the last attempt ends with the
// page's failure, as the attempt is cut off, as before.
for (const [i, sent] of SENT.entries()) {
  const last = i === SENT.length - 1;
  for (const reason of ['it took longer than 1200s', 'it received SIGTERM']) {
    // The first page is read at once, so page two is first asked for when the read starts.
    result = await read({ answer: (page) => page !== 'two', stopAt: clock + sent + 1000, reason });
    const held = result.endedAt - (result.twoAskedAt + sent + 1000);
    assert.strictEqual(
      result.endedAt - result.twoAskedAt,
      CUT_OFF[i],
      `attempt ${i + 1}, ${reason}`
    );
    assert.strictEqual(held, TIMEOUTS[i] - 1000);
    assert.ok(held < (last ? 45000 : 30000));
    assert.strictEqual(result.two.length, i + 1);
    assert.strictEqual(result.list, null);
    if (last) {
      assert.match(result.error.message, /failed after 5 attempts: timed out after 45s$/);
    } else {
      assert.ok(result.error instanceof RunStopped, String(result.error));
      assert.strictEqual(result.error.reason, reason);
      assert.deepStrictEqual([result.error.page, result.error.pages], [2, 3]);
      assert.match(result.retries.at(-1), /Not trying again, as the request was stopped\.$/);
    }
  }
}
// A stop during any of the waits between the attempts ends the read within a second, without the
// next attempt.
for (const [i, cutOff] of CUT_OFF.slice(0, -1).entries()) {
  result = await read({ answer: (page) => page !== 'two', stopAt: clock + cutOff + 500 });
  assert.ok(result.error instanceof RunStopped, String(result.error));
  assert.strictEqual(result.endedAt - result.twoAskedAt, cutOff + 1000);
  assert.strictEqual(result.two.length, i + 1);
}

console.log(
  'Page attempt checks passed: a page that hangs at its first attempts is read at a later one, soon after, one that never answers fails the read after 5 attempts in 135.8 s, and a stop holds a read up by at most the attempt under way, 45 s at the last, and less than a second during the waits.'
);
