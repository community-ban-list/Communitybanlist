import assert from 'assert';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import { format } from 'util';
import vm from 'vm';

import describeError from '../../scbl-lib/utils/describe-error.js';

// The web server stops cleanly on SIGTERM, which docker stop sends, and on SIGINT: it takes no new
// connections, fails its health check, answers the requests under way and closes their
// connections, then stops Apollo Server, writes the newest message it posted to the log channel to
// the database, closes the database connections, sends the lines waiting for the log channel, and
// exits 0, all in time. Its idle connections stay open for longer than a proxy keeps its own.

async function until(condition, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const request = (path) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;

// A connection to a server that sends what it is told and keeps what it gets back, so the checks
// can read each response and see whether the server closed the connection.
function connectTo(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const connection = { socket, received: '', closed: false };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      connection.received += chunk;
    });
    socket.on('close', () => {
      connection.closed = true;
    });
    socket.on('error', () => {});
    socket.once('connect', () => resolve(connection));
    socket.once('error', reject);
  });
}

// The responses a connection received, each with its status, its headers, by their names in lower
// case, and its body, all that follows when it has no Content-Length.
function responsesOf({ received }) {
  const responses = [];
  let rest = received;
  for (let end = rest.indexOf('\r\n\r\n'); end !== -1; end = rest.indexOf('\r\n\r\n')) {
    const [statusLine, ...lines] = rest.slice(0, end).split('\r\n');
    const headers = Object.fromEntries(
      lines.map((line) => [
        line.slice(0, line.indexOf(':')).toLowerCase(),
        line.slice(line.indexOf(':') + 1).trim()
      ])
    );
    const length = Number(headers['content-length'] ?? Infinity);
    responses.push({
      status: Number(statusLine.split(' ')[1]),
      headers,
      body: rest.slice(end + 4, end + 4 + length)
    });
    rest = rest.slice(end + 4 + length);
  }
  return responses;
}

// Load the stop (src/shutdown.js) as the web server does, with stand-ins for Apollo Server, the
// database, the log channel and the process, which the checks send the signals to. Each stand-in
// notes what the stop does to it in events, and the process when it exits, and with which code.
// recordNewest and closeDatabase are how long writing the newest message and closing the database
// take, and logQueue how many lines wait for the log channel. The flag the health check reads is
// the real one.
async function loadStop({
  recordNewest = async () => {},
  closeDatabase = async () => {},
  logQueue = () => 0
} = {}) {
  const events = [];
  const output = [];
  const exits = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.exit = (code) => {
    events.push(`exit ${code}`);
    exits.push({ code, at: Date.now() });
  };
  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess,
    setTimeout,
    clearTimeout
  });
  const stubs = {
    'scbl-lib/db': {
      flushLogMessages: async () => {
        events.push('record the newest message');
        await recordNewest();
      },
      stopRecordingLogMessages: () => events.push('stop recording'),
      disconnect: async () => {
        events.push('close the database');
        await closeDatabase();
      }
    },
    'scbl-lib/utils': {
      describeError,
      Logger: {
        flush: () => events.push('send the log lines'),
        getLogQueue: () => ({ RECEIVED: 0, QUEUED: logQueue(), RUNNING: 0, EXECUTING: 0 })
      }
    },
    './graphql-api/index.js': { stopGraphQL: async () => events.push('stop GraphQL') }
  };
  const modules = new Map();
  async function moduleFor(specifier, referencingURL) {
    const exports = stubs[specifier];
    assert.ok(exports || specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    const url = exports ? specifier : new URL(specifier, referencingURL).href;
    if (!modules.has(url)) {
      modules.set(
        url,
        exports
          ? new vm.SyntheticModule(
              Object.keys(exports),
              function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
              },
              { context }
            )
          : new vm.SourceTextModule(await readFile(new URL(url), 'utf8'), {
              context,
              identifier: url
            })
      );
    }
    return modules.get(url);
  }
  const shutdown = await moduleFor('../src/shutdown.js', import.meta.url);
  await shutdown.link((specifier, referencingModule) =>
    moduleFor(specifier, referencingModule.identifier)
  );
  await shutdown.evaluate();
  const flag = modules.get(new URL('../src/shutting-down.js', import.meta.url).href);
  return {
    stopOnSignals: shutdown.namespace.default,
    stopTimes: shutdown.namespace.stopTimes,
    isShuttingDown: flag.namespace.isShuttingDown,
    process: fakeProcess,
    events,
    output,
    exits
  };
}

// A server that answers /quick at once, and keeps the other requests for the checks to answer, in
// waiting, by path, and that the stop is given once it listens, as the web server's is. It keeps
// idle connections open, as the web server does, so only the stop closes them.
async function startServer(shutdown) {
  const waiting = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === '/quick') res.end('quick');
    else waiting.set(req.url, res);
  });
  server.keepAliveTimeout = 60 * 1000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  shutdown.setServer(server);
  return { port: server.address().port, waiting };
}

// The steps after the requests are answered, in order.
const STEPS = [
  'stop GraphQL',
  'record the newest message',
  'stop recording',
  'close the database',
  'send the log lines'
];

// On SIGTERM, the server takes no new connections, its health check fails, and an idle connection
// is closed at once. A request under way is answered, saying its connection will close, which it
// then does. Only then does Apollo Server stop, the newest message get written, the database close
// and the log lines waiting get sent, in that order, and the process exits 0, once the lines are
// sent. A later SIGINT changes nothing.
{
  let linesSentAt = Infinity;
  const stop = await loadStop({ logQueue: () => (Date.now() < linesSentAt ? 1 : 0) });
  const shutdown = stop.stopOnSignals();
  const { port, waiting } = await startServer(shutdown);

  const idle = await connectTo(port);
  idle.socket.write(request('/quick'));
  await until(() => responsesOf(idle).length === 1, 'the quick answer');
  assert.strictEqual(responsesOf(idle)[0].headers.connection, 'keep-alive');
  const busy = await connectTo(port);
  busy.socket.write(request('/slow'));
  await until(() => waiting.has('/slow'), 'the slow request');

  assert.strictEqual(stop.isShuttingDown(), false);
  stop.process.emit('SIGTERM', 'SIGTERM');
  assert.strictEqual(stop.isShuttingDown(), true);
  await until(() => idle.closed, 'the idle connection to close');
  await assert.rejects(connectTo(port), { code: 'ECONNREFUSED' });
  assert.deepStrictEqual(stop.events, [], 'nothing else stops before the request is answered');

  linesSentAt = Date.now() + 300;
  waiting.get('/slow').end('slow');
  await until(() => busy.closed, 'the answered connection to close');
  const [answer] = responsesOf(busy);
  assert.strictEqual(answer.body, 'slow');
  assert.strictEqual(answer.headers.connection, 'close');

  await until(() => stop.exits.length === 1, 'the exit');
  assert.deepStrictEqual(stop.events, [...STEPS, 'exit 0']);
  assert.ok(stop.exits[0].at >= linesSentAt, 'it exits once the log lines are sent');
  stop.process.emit('SIGINT', 'SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(stop.output, [
    'Received SIGTERM, so the web server is stopping: it takes no new connections, and answers the requests under way for up to 8s.',
    'The web server stopped, as it received SIGTERM.'
  ]);
  assert.strictEqual(stop.exits.length, 1);
}

// A request still not answered when the time is up is cut off, and the rest of the stop goes on,
// but the process exits 1, saying so.
{
  const stop = await loadStop();
  stop.stopTimes.answering = 300;
  const shutdown = stop.stopOnSignals();
  const { port, waiting } = await startServer(shutdown);
  const stuck = await connectTo(port);
  stuck.socket.write(request('/stuck'));
  await until(() => waiting.has('/stuck'), 'the stuck request');

  stop.process.emit('SIGINT', 'SIGINT');
  await until(() => stop.exits.length === 1, 'the exit');
  await until(() => stuck.closed, 'its connection to close');
  assert.strictEqual(stuck.received, '');
  assert.deepStrictEqual(stop.events, [...STEPS, 'exit 1']);
  assert.deepStrictEqual(stop.output, [
    'Received SIGINT, so the web server is stopping: it takes no new connections, and answers the requests under way for up to 0.3s.',
    'Warning: 1 request was still being answered 0.3s after SIGINT, so it was cut off.',
    'The web server stopped, as it received SIGINT.'
  ]);
}

// A database that never answers, and log lines that are never sent, cannot keep the process from
// exiting in time: each step is given up when its time is up, with a warning.
{
  const never = () => new Promise(() => {});
  const stop = await loadStop({ recordNewest: never, closeDatabase: never, logQueue: () => 1 });
  Object.assign(stop.stopTimes, { answering: 200, recording: 200, exiting: 800 });
  const shutdown = stop.stopOnSignals();
  await startServer(shutdown);

  const signalledAt = Date.now();
  stop.process.emit('SIGTERM', 'SIGTERM');
  await until(() => stop.exits.length === 1, 'the exit');
  const took = stop.exits[0].at - signalledAt;
  assert.ok(took >= 750 && took < 3000, `it exits once its time is up, not after ${took}ms`);
  assert.deepStrictEqual(stop.events, [...STEPS, 'exit 0']);
  const warnings = stop.output.filter((line) => line.startsWith('Warning'));
  assert.strictEqual(warnings.length, 2);
  assert.strictEqual(
    warnings[0],
    'Warning: could not record the newest message in the Discord log in the database within 0.2s as the web server stopped.'
  );
  assert.match(
    warnings[1],
    /^Warning: could not close the database connections within [\d.]+s as the web server stopped\.$/
  );
}

// A signal that comes before the server is listening, e.g. while it connects to the database, ends
// the process at once.
{
  const stop = await loadStop();
  stop.stopOnSignals();
  stop.process.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(stop.events, ['exit 0']);
  assert.strictEqual(stop.isShuttingDown(), true);
  assert.deepStrictEqual(stop.output, [
    'Received SIGTERM before the web server was listening, so it stopped at once.'
  ]);
}

// Node would keep a connection open after a response that started before the stop, which cannot
// say the connection will close, and after one whose headers an error handler replaced, as Koa's
// does. Each is closed once its response ends, so the process exits then, not when the time is up.
{
  const stop = await loadStop();
  const shutdown = stop.stopOnSignals();
  const { port, waiting } = await startServer(shutdown);
  const started = await connectTo(port);
  started.socket.write(request('/started'));
  const replaced = await connectTo(port);
  replaced.socket.write(request('/replaced'));
  await until(() => waiting.has('/started') && waiting.has('/replaced'), 'the requests');
  waiting.get('/started').write('the first part, ');

  stop.process.emit('SIGTERM', 'SIGTERM');
  const failed = waiting.get('/replaced');
  for (const name of failed.getHeaderNames()) failed.removeHeader(name);
  failed.end('an error');
  waiting.get('/started').end('and the rest');
  const endedAt = Date.now();

  await until(() => started.closed && replaced.closed, 'both connections to close', 3000);
  assert.match(started.received, /the first part, .*and the rest/s);
  assert.strictEqual(responsesOf(replaced)[0].body, 'an error');
  await until(() => stop.exits.length === 1, 'the exit', 3000);
  assert.strictEqual(stop.exits[0].code, 0);
  assert.ok(stop.exits[0].at - endedAt < 3000, 'it exits once the responses end');
}

// The web server itself, started as its image starts it, with a database it cannot reach, which it
// starts without: on SIGTERM, and again on SIGINT, it answers a GraphQL request whose body is still
// being sent as the signal comes, and its health check fails, for a request whose headers are, and
// it exits 0. It tells clients it keeps idle connections open for 65 seconds.
const env = {
  ...process.env,
  DATABASE_URI: 'mysql://test:test@127.0.0.1:1/test',
  JWT_AUTH_SECRET: 'a-secret-only-these-checks-use-0123456789abcdef',
  BATTLEMETRICS_API_KEY: 'test',
  STEAM_API_KEY: 'test',
  PORT: '0'
};
delete env.NODE_ENV;
delete env.DISCORD_LOG_WEBHOOK;
const index = fileURLToPath(new URL('../index.js', import.meta.url));
for (const signal of ['SIGTERM', 'SIGINT']) {
  const server = spawn(process.execPath, [index], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) =>
    server.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal, at: Date.now() }))
  );
  try {
    await until(
      () => /Server started on port \d+/.test(output) || server.exitCode !== null,
      'the web server to start',
      30000
    );
    const port = Number(output.match(/Server started on port (\d+)/)?.[1]);
    assert.ok(port > 0, `The web server should say which port it listens on:\n${output}`);

    const idle = await connectTo(port);
    idle.socket.write(request('/health-check'));
    await until(() => responsesOf(idle).length === 1, 'the health check');
    assert.strictEqual(responsesOf(idle)[0].headers['keep-alive'], 'timeout=65');

    const body = JSON.stringify({ query: '{ __typename }' });
    const graphql = await connectTo(port);
    graphql.socket.write(
      `POST /graphql HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`
    );
    const health = await connectTo(port);
    health.socket.write('GET /health-check HTTP/1.1\r\nHost: localhost\r\n');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const signalledAt = Date.now();
    server.kill(signal);
    await until(() => output.includes(`Received ${signal}`), `the web server to receive ${signal}`);
    await until(() => idle.closed, 'the idle connection to close');
    await assert.rejects(connectTo(port), { code: 'ECONNREFUSED' });

    graphql.socket.write(body.slice(5));
    health.socket.write('\r\n');
    await until(() => graphql.closed && health.closed, 'the answers');
    const [answer] = responsesOf(graphql);
    assert.strictEqual(answer?.status, 200, `GraphQL answered:\n${graphql.received}`);
    assert.deepStrictEqual(JSON.parse(answer.body), { data: { __typename: 'Query' } });
    assert.strictEqual(answer.headers.connection, 'close');
    const [check] = responsesOf(health);
    assert.strictEqual(check?.status, 503, `The health check answered:\n${health.received}`);
    assert.strictEqual(check.body, 'The web server is stopping.');
    assert.strictEqual(check.headers.connection, 'close');

    const exit = await exited;
    assert.deepStrictEqual(
      { code: exit.code, signal: exit.signal },
      { code: 0, signal: null },
      `The web server should exit 0 after ${signal}:\n${output}`
    );
    assert.ok(exit.at - signalledAt < 5000, `it took ${exit.at - signalledAt}ms to stop`);
    assert.match(output, new RegExp(`The web server stopped, as it received ${signal}\\.`));
  } finally {
    server.kill('SIGKILL');
  }
}

console.log(
  'Shutdown checks passed: requests under way answered and connections closed, the steps after them in order and in time, a signal before listening, and the web server on SIGTERM and SIGINT.'
);
