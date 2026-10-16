import assert from 'assert';
import http from 'http';
import { createRequire } from 'module';

import limitOpenIDRequests, {
  addTimeLimit,
  openIDAxios,
  openIDRequestTimeout
} from '../src/auth/openid-request-timeout.js';

// A request without a time limit gets one, and one that has its own keeps it.
const plain = addTimeLimit({ url: 'https://steamcommunity.com/openid/login' });
assert.strictEqual(plain.timeout, openIDRequestTimeout.milliseconds);
assert.ok(plain.signal instanceof AbortSignal);
const ownSignal = new AbortController().signal;
const own = addTimeLimit({ timeout: 2500, signal: ownSignal });
assert.strictEqual(own.timeout, 2500);
assert.strictEqual(own.signal, ownSignal);

// The OpenID library's own HTTP helper, loaded through the same packages the web server uses.
const fromWebServer = createRequire(import.meta.url);
const fromPassportSteam = createRequire(fromWebServer.resolve('passport-steam'));
const fromPassportOpenID = createRequire(
  fromPassportSteam.resolve('@passport-next/passport-openid')
);
const openIDHttp = createRequire(fromPassportOpenID.resolve('openid'))('./http.js');

// The axios the web server's own code imports is a different copy, which this leaves alone.
const { default: importedAxios } = await import('axios');
assert.notStrictEqual(openIDAxios(), importedAxios);
const importedInterceptors = importedAxios.interceptors.request.handlers.length;

// A server that takes requests and never answers them.
const requests = [];
const server = http.createServer((req) => requests.push(req.url));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

// Ask through the library's helper, as it asks Steam, and give up waiting after a while.
function ask(path, wait) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still waiting'), wait);
    openIDHttp.get(`${url}${path}`, {}, (result) => {
      clearTimeout(timer);
      resolve(result instanceof Error ? result : 'answered');
    });
  });
}

openIDRequestTimeout.milliseconds = 300;

// Without a time limit, the library waits for as long as the server does.
assert.strictEqual(await ask('/before', 1000), 'still waiting');
server.closeAllConnections();

// With one, its request ends with an error once the time is up.
limitOpenIDRequests();
const started = Date.now();
const result = await ask('/after', 5000);
assert.ok(result instanceof Error, `expected an error, got ${result}`);
assert.ok(Date.now() - started < 3000, 'the request should end soon after its time limit');
assert.deepStrictEqual(requests, ['/before', '/after']);

assert.strictEqual(importedAxios.interceptors.request.handlers.length, importedInterceptors);

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(
  'OpenID request time limit checks passed: limits, the library copy and a silent server.'
);
