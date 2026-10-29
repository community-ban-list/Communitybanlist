import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

// Check the importer service's health check without a network: when the service counts as
// healthy, how its health server answers, and the exit codes of healthcheck.js, which Docker runs.

const START = Date.parse('2026-10-22T14:07:00.000Z');
const MINUTE = 60 * 1000;

// A stand-in for http: the server records its handler and where it listens, and get() hands the
// test the request, to answer, fail or time out.
function fakeHttp() {
  const http = { servers: [], requests: [] };
  http.createServer = (handler) => {
    const server = new EventEmitter();
    Object.assign(server, {
      handler,
      listen(port, host) {
        server.address = { port, host };
        return server;
      }
    });
    http.servers.push(server);
    return server;
  };
  http.get = (options, callback) => {
    const request = new EventEmitter();
    Object.assign(request, {
      options,
      callback,
      destroy(err) {
        request.emit('error', err);
      }
    });
    http.requests.push(request);
    return request;
  };
  return http;
}

// Load a module with the stand-in for http, and the real health-check-server.js for healthcheck.js,
// with the console and process.exit recorded.
async function load(path) {
  const http = fakeHttp();
  const output = [];
  const exits = [];
  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: { exit: (code) => exits.push(code) },
    Date
  });
  // Each module is kept before its file is read, as linking asks for a module's imports at once.
  const modules = new Map();
  const loadModule = (url) => {
    if (!modules.has(url.href))
      modules.set(
        url.href,
        readFile(url, 'utf8').then(
          (source) => new vm.SourceTextModule(source, { context, identifier: url.href })
        )
      );
    return modules.get(url.href);
  };
  const module = await loadModule(new URL(path, import.meta.url));
  await module.link(async (specifier, referencing) => {
    if (specifier === 'http')
      return new vm.SyntheticModule(
        ['default'],
        function () {
          this.setExport('default', http);
        },
        { context }
      );
    assert.ok(specifier.startsWith('./'), `Unexpected dependency: ${specifier}`);
    return loadModule(new URL(specifier, referencing.identifier));
  });
  await module.evaluate();
  return { namespace: module.namespace, http, output, exits };
}

const { namespace, http, output } = await load('../src/health-check-server.js');
const { checkHealth, HEALTH_CHECK_PORT, WAIT_LIMIT, default: startHealthCheckServer } = namespace;
const copy = (value) => JSON.parse(JSON.stringify(value));
assert.strictEqual(HEALTH_CHECK_PORT, 3001);
assert.strictEqual(WAIT_LIMIT, 10 * MINUTE);

// The service's state, as loop.js keeps it, with what is given. Here a cycle every 10 minutes with
// a time limit of 15, so a cycle must have ended within 35 minutes.
const health = (given = {}) => ({
  stopping: false,
  lockedAt: START,
  cycles: 0,
  cycle: null,
  lastCycle: null,
  waitingFor: null,
  waitingSince: null,
  window: 35 * MINUTE,
  ...given
});
const check = (given, minutes) => copy(checkHealth(health(given), START + minutes * MINUTE));
const reasonAt = (given, minutes) => {
  const { healthy, reason } = check(given, minutes);
  return [healthy, reason];
};

// While it holds the service lock, it is healthy as long as a cycle ended within the window, or,
// before its first cycle has ended, it took the lock within it.
const ended = {
  cycles: 4,
  lastCycle: { cycle: 4, outcome: 'failed', endedAt: START + 40 * MINUTE, seconds: 12 }
};
assert.deepStrictEqual(reasonAt({}, 34.9), [
  true,
  'it took the service lock 34 minutes ago, and its first cycle has not ended yet'
]);
assert.deepStrictEqual(reasonAt({}, 35), [
  false,
  'no cycle has ended for 35 minutes, more than the 35 minutes allowed'
]);
assert.deepStrictEqual(reasonAt(ended, 41), [true, 'cycle 4 ended 1 minute ago']);
assert.deepStrictEqual(reasonAt(ended, 74.9), [true, 'cycle 4 ended 34 minutes ago']);
assert.deepStrictEqual(reasonAt(ended, 75), [
  false,
  'no cycle has ended for 35 minutes, more than the 35 minutes allowed'
]);
// A cycle that failed still ended: the service is running, and the stale alert says whether its
// cycles succeed.
assert.strictEqual(check(ended, 41).healthy, true);
assert.deepStrictEqual(check(ended, 41), {
  healthy: true,
  reason: 'cycle 4 ended 1 minute ago',
  holdsLock: true,
  cycles: 4,
  cycle: null,
  lastCycle: { cycle: 4, outcome: 'failed', endedAt: '2026-10-22T14:47:00.000Z', seconds: 12 },
  waitingFor: null,
  waitingSince: null
});

// While it waits for the database between cycles, or for the run lock or the database before it
// holds the lock, it is healthy for its first 10 minutes of waiting, or while the window lasts.
const waiting = { ...ended, cycle: 5, waitingFor: 'database', waitingSince: START + 50 * MINUTE };
assert.deepStrictEqual(reasonAt(waiting, 74), [true, 'cycle 4 ended 34 minutes ago']);
assert.deepStrictEqual(reasonAt({ ...waiting, waitingSince: START + 70 * MINUTE }, 79.9), [
  true,
  'it has been waiting for the database for 9 minutes'
]);
assert.deepStrictEqual(reasonAt({ ...waiting, waitingSince: START + 70 * MINUTE }, 80), [
  false,
  'no cycle has ended for 40 minutes, more than the 35 minutes allowed, and it has been waiting for the database for 10 minutes'
]);
const standingBy = { lockedAt: null, waitingFor: 'lock', waitingSince: START };
assert.deepStrictEqual(reasonAt(standingBy, 9.9), [
  true,
  'it has been waiting for another run to end for 9 minutes'
]);
assert.deepStrictEqual(reasonAt(standingBy, 10), [
  false,
  'it has been waiting for another run to end for 10 minutes, more than the 10 minutes allowed'
]);
assert.deepStrictEqual(reasonAt({ ...standingBy, waitingFor: 'database' }, 1), [
  true,
  'it has been waiting for the database for 1 minute'
]);
assert.deepStrictEqual(check(standingBy, 1).holdsLock, false);
assert.deepStrictEqual(reasonAt({ lockedAt: null }, 1), [
  false,
  'it does not hold the service lock'
]);
// Once it is stopping, it is not.
assert.deepStrictEqual(reasonAt({ ...ended, stopping: true }, 41), [
  false,
  'the importer service is stopping'
]);

// The server listens on 127.0.0.1:3001 only, and answers 200 when the service is healthy and 503
// when it is not, with the status as JSON. A status it cannot tell is a 503. A server that fails,
// e.g. as the port is taken, is reported in the console, and the service runs on without it.
{
  let report = () => ({
    healthy: true,
    reason: 'cycle 4 ended 1 minute ago',
    memory: { rssMB: 150 }
  });
  const server = startHealthCheckServer(() => report());
  assert.deepStrictEqual(server.address, { port: 3001, host: '127.0.0.1' });
  const ask = () => {
    const res = {
      writeHead(status, headers) {
        Object.assign(res, { status, headers });
      },
      end(body) {
        res.body = body;
      }
    };
    server.handler({}, res);
    return [res.status, res.headers['Content-Type'], JSON.parse(res.body)];
  };
  assert.deepStrictEqual(ask(), [
    200,
    'application/json',
    { healthy: true, reason: 'cycle 4 ended 1 minute ago', memory: { rssMB: 150 } }
  ]);
  report = () => ({ healthy: false, reason: 'the importer service is stopping' });
  assert.deepStrictEqual(ask(), [
    503,
    'application/json',
    { healthy: false, reason: 'the importer service is stopping' }
  ]);
  report = () => {
    throw new TypeError('Cannot read properties of null');
  };
  assert.deepStrictEqual(ask(), [
    503,
    'application/json',
    { healthy: false, reason: 'it could not tell whether it is healthy' }
  ]);
  assert.strictEqual(
    output.pop(),
    'The health check could not tell whether the service is healthy: Cannot read properties of null'
  );
  server.emit(
    'error',
    Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:3001'), {
      code: 'EADDRINUSE'
    })
  );
  assert.deepStrictEqual(output, [
    'The health check server failed: listen EADDRINUSE: address already in use 127.0.0.1:3001'
  ]);
  assert.strictEqual(http.servers.length, 1);
}

// healthcheck.js asks the server, with an 8-second timeout, prints the status, which docker
// inspect shows, and exits 0 only when the service says it is healthy. It exits 1 when the service
// says it is not, when nothing answers, as in once mode, which has no server, and when the answer
// takes too long.
for (const [status, code] of [
  [200, 0],
  [503, 1]
]) {
  const check = await load('../healthcheck.js');
  const [request] = check.http.requests;
  assert.deepStrictEqual(copy(request.options), { host: '127.0.0.1', port: 3001, timeout: 8000 });
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  request.callback(res);
  res.emit('data', '{"healthy":');
  res.emit('data', `${status === 200}}`);
  res.emit('end');
  assert.deepStrictEqual(check.output, [`{"healthy":${status === 200}}`]);
  assert.deepStrictEqual(check.exits, [code]);
}
{
  const check = await load('../healthcheck.js');
  check.http.requests[0].emit(
    'error',
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' })
  );
  assert.deepStrictEqual(check.output, [
    'Could not reach the importer service: connect ECONNREFUSED 127.0.0.1:3001'
  ]);
  assert.deepStrictEqual(check.exits, [1]);
}
{
  const check = await load('../healthcheck.js');
  check.http.requests[0].emit('timeout');
  assert.deepStrictEqual(check.output, ['Could not reach the importer service: timed out']);
  assert.deepStrictEqual(check.exits, [1]);
}

console.log(
  'Importer health check checks passed: when the service is healthy, the health server, and the exit codes of healthcheck.js.'
);
