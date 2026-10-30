import assert from 'assert';
import { readFile, rm } from 'fs/promises';
import path from 'path';
import vm from 'vm';

import Router from '@koa/router';

import { FILES, loadApp } from './helpers/load-app.js';

// Checks how the web server answers over HTTP in production: the client's pages and built files,
// paths that are not pages, the health check, request bodies it cannot read, and errors. The app
// is web-server/src/app.js, with stand-ins for its routes and the database.

const INDEX = FILES['client/build/index.html'];
const STEAM_ID = '76561198000000001';
// The content of files next to the build, which no request may reach.
const OUTSIDE = 'Not part of the client build';
const ORIGIN = { origin: 'https://example.com' };

// The paths of the client's pages, from its route list, with a Steam ID for each parameter, and a
// longer path as well for the routes that also match longer paths.
async function clientPagePaths() {
  const url = new URL('../../client/src/views/routes.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  // The pages themselves are not needed, so each is a stand-in.
  await module.link(
    () =>
      new vm.SyntheticModule(['default'], function () {
        this.setExport('default', () => null);
      })
  );
  await module.evaluate();
  return module.namespace.default.flatMap((route) => {
    const page = route.path.replace(/:\w+/g, STEAM_ID);
    return route.exact ? [page] : [page, `${page.replace(/\/$/, '')}/more`];
  });
}

// Helmet's headers, which every answer carries, errors included.
function assertHelmetHeaders(response, what) {
  for (const header of [
    'content-security-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options'
  ])
    assert.ok(response.headers[header], `${what} has ${header}`);
}

// Stand-ins for the sign-in routes, which fail in the ways a route can. One fails as the OpenID
// library does when Steam cannot be reached, and one with a message for the client and a header of
// its own.
const auth = new Router();
auth.get('/steam', () => {
  throw new Error('Failed to discover OP endpoint URL');
});
auth.get('/steam/return', (ctx) => {
  ctx.throw(429, 'Too many sign-ins at once.', { headers: { 'Retry-After': '60' } });
});
// One fails after setting up the answer it meant to give: a page to save as a file, kept for a
// year, compressed, and sending the browser elsewhere.
auth.get('/unfinished', (ctx) => {
  ctx.attachment('page.html');
  ctx.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Encoding': 'gzip',
    'Content-Language': 'en',
    ETag: '"v1"',
    Expires: 'Thu, 01 Jan 2032 00:00:00 GMT',
    'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT'
  });
  ctx.redirect('/');
  throw new Error('The answer could not be finished');
});
// And one fails as opening a file does, with Node's error for the code given, whose message has
// the file's path. Given a status, it passes the error on as one meant for the client, as @koa/send
// passes on a missing file with 404.
auth.get('/file/:code', (ctx) => {
  const { code } = ctx.params;
  const file = '/srv/client/build/missing';
  const err = Object.assign(new Error(`${code}: cannot open '${file}'`), {
    code,
    syscall: 'open',
    path: file
  });
  if (ctx.query.status) ctx.throw(Number(ctx.query.status), err);
  throw err;
});

// A stand-in for the export list route, which answers /export/:id.
const exportBanLists = new Router();
exportBanLists.get('/:id', (ctx) => {
  ctx.body = `${STEAM_ID}:0`;
});

// The API keeps the bodies it is given, and answers with a fixed result.
const bodies = [];
async function graphql(ctx, next) {
  if (ctx.path !== '/graphql') return next();
  bodies.push(ctx.request.body);
  ctx.body = { data: {} };
}

const database = { authenticate: async () => {} };

const server = await loadApp({
  files: { ...FILES, 'secret.txt': OUTSIDE, 'client/secret.txt': OUTSIDE },
  stubs: {
    './auth/index.js': { routes: auth },
    './graphql-api/index.js': { default: graphql },
    './export-ban-lists.js': { default: exportBanLists },
    'scbl-lib/db': { sequelize: { authenticate: () => database.authenticate() } }
  }
});
const logged = (text) => server.output.filter((line) => line.includes(text)).length;

// The client's pages get index.html, for the client to route, with Helmet's headers. Dots in a
// page's query string, as Steam's sign-in answer has, do not count, nor do dots after a page's
// first part, which can hold what a visitor typed, as a search does.
const pages = [
  ...(await clientPagePaths()),
  '/recent-bans',
  `/search/${STEAM_ID}`,
  '/search/john.doe',
  `/search/${STEAM_ID}.`,
  '/search/https:%2F%2Fsteamcommunity.com%2Fid%2Ffoo',
  '/search/https://steamcommunity.com/id/foo.bar',
  '/banned/john.doe',
  '/export-ban-lists/new',
  '/export-ban-lists/1.5',
  '/login?openid.mode=cancel&openid.ns=http://specs.openid.net/auth/2.0'
];
assert.ok(pages.includes('/faq/more') && pages.length > 20, "The client's route list was read");
for (const page of pages) {
  const response = await server.request(page);
  assert.strictEqual(response.status, 200, `${page} is a page`);
  assert.strictEqual(response.headers['content-type'], 'text/html; charset=utf-8', page);
  assert.strictEqual(response.text, INDEX, page);
  assertHelmetHeaders(response, page);
}

// The files at the top of the build, and the bundles under /static, are served as they are.
for (const file of ['/favicon.ico', '/manifest.json', '/index.html', '/static/app-abc.js']) {
  const response = await server.request(file);
  assert.strictEqual(response.status, 200, file);
  assert.strictEqual(response.text, FILES[`client/build${file}`], file);
}

// So is the client's config, whose name looks like a file's but which the server makes, and an
// export list, with or without what looks like a file name.
const config = await server.request('/config.js');
assert.strictEqual(config.status, 200);
assert.strictEqual(config.headers['content-type'], 'application/javascript; charset=utf-8');
assert.strictEqual(config.headers['cache-control'], 'no-cache');
assert.match(config.text, /^window\.CBL_CONFIG = /);
for (const list of ['/export/7', '/export/7.txt']) {
  const response = await server.request(list);
  assert.strictEqual(response.status, 200, list);
  assert.strictEqual(response.text, `${STEAM_ID}:0`, list);
}

// Any other path the client has no page for gets 404 rather than index.html, with Helmet's headers:
// a missing file, under /static or not, a path under one the server answers itself, such as an
// unknown sign-in path or an export list URL without its id, and a path whose first part has a
// dot, as a file name has.
for (const notFound of [
  '/static/missing.js',
  '/static/index-0ld.css',
  '/static/',
  '/static',
  '/static/.hidden',
  '/export',
  '/export/',
  '/export/7/more',
  '/graphql/',
  '/graphql/more',
  '/auth',
  '/auth/nope',
  '/AUTH/nope',
  '/nonexistent.png',
  '/apple-touch-icon.png',
  '/.env',
  '/.well-known/security.txt'
]) {
  const response = await server.request(notFound);
  assert.strictEqual(response.status, 404, `${notFound} is not found`);
  assert.strictEqual(response.headers['content-type'], 'text/plain; charset=utf-8', notFound);
  assert.strictEqual(response.text, 'Not Found', notFound);
  assertHelmetHeaders(response, notFound);
}

// No request reaches a file outside the build, however its path is written: it is refused, or
// gets index.html.
for (const outside of [
  '/../secret.txt',
  '/static/../../secret.txt',
  '/static/../../../secret.txt',
  '/..%2fsecret.txt',
  '/%2e%2e/secret.txt',
  '/%2e%2e%2f%2e%2e%2fsecret.txt',
  '/static/..%2f..%2fsecret.txt',
  '/static/..%2f..%2f..%2fsecret.txt',
  '/static/%2e%2e/%2e%2e/secret.txt',
  '/static/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt',
  '/static/..%5c..%5c..%5csecret.txt',
  '/static/%252e%252e/%252e%252e/secret.txt'
]) {
  const response = await server.request(outside);
  assert.ok(!response.text.includes(OUTSIDE), `${outside} stays in the build`);
  assert.ok(
    [400, 403, 404].includes(response.status) || response.text === INDEX,
    `${outside} is refused: ${response.status}`
  );
}

// A request /static cannot serve is refused with the reason, as plain text with Helmet's headers,
// and the CORS header, which errors also keep.
for (const [refused, status, reason] of [
  ['/static/%E0%A4%A', 400, 'failed to decode'],
  ['/static/..%2f..%2fsecret.txt', 403, 'Forbidden']
]) {
  const response = await server.request(refused, { headers: ORIGIN });
  assert.strictEqual(response.status, status, refused);
  assert.strictEqual(response.text, reason, refused);
  assert.strictEqual(response.headers['content-type'], 'text/plain; charset=utf-8', refused);
  assert.strictEqual(response.headers['access-control-allow-origin'], '*', refused);
  assertHelmetHeaders(response, refused);
}

// A route that fails gets 500 and a general message, without the error's own, and with Helmet's
// and the CORS headers. The error is logged once.
const failed = await server.request('/auth/steam', { headers: ORIGIN });
assert.strictEqual(failed.status, 500);
assert.strictEqual(failed.text, 'Internal Server Error');
assert.strictEqual(failed.headers['content-type'], 'text/plain; charset=utf-8');
assert.strictEqual(failed.headers['access-control-allow-origin'], '*');
assertHelmetHeaders(failed, 'A failed route');
assert.strictEqual(logged('Failed to discover OP endpoint URL'), 1);

// An error meant for the client keeps its status, its message and its own headers, and is not
// logged.
const busy = await server.request('/auth/steam/return');
assert.strictEqual(busy.status, 429);
assert.strictEqual(busy.text, 'Too many sign-ins at once.');
assert.strictEqual(busy.headers['retry-after'], '60');
assertHelmetHeaders(busy, 'An error for the client');
assert.strictEqual(logged('Too many sign-ins'), 0);

// A route that fails after setting up the answer it meant to give gets the same as any other, as
// plain text, without the headers about that answer, and with none that let it be kept.
const unfinished = await server.request('/auth/unfinished', { headers: ORIGIN });
assert.strictEqual(unfinished.status, 500);
assert.strictEqual(unfinished.text, 'Internal Server Error');
assert.strictEqual(unfinished.headers['content-type'], 'text/plain; charset=utf-8');
assert.strictEqual(unfinished.headers['cache-control'], 'no-store');
for (const header of [
  'content-disposition',
  'content-encoding',
  'content-language',
  'etag',
  'expires',
  'last-modified',
  'location'
])
  assert.strictEqual(unfinished.headers[header], undefined, `The failed answer has no ${header}`);
assert.strictEqual(unfinished.headers['access-control-allow-origin'], '*');
assertHelmetHeaders(unfinished, 'A route that failed late');
assert.strictEqual(logged('The answer could not be finished'), 1);

// A file that cannot be opened gets 404 when it is missing, which Node says in three ways, and
// otherwise 500, or the status it was passed on with. Its message, which has the file's path, is
// never shown, even when the error was passed on as meant for the client. Only the 500 is logged.
for (const [file, status, text] of [
  ['/auth/file/ENOENT', 404, 'Not Found'],
  ['/auth/file/ENOTDIR', 404, 'Not Found'],
  ['/auth/file/ENAMETOOLONG', 404, 'Not Found'],
  ['/auth/file/ENOENT?status=404', 404, 'Not Found'],
  ['/auth/file/ENOTDIR?status=404', 404, 'Not Found'],
  ['/auth/file/EACCES', 500, 'Internal Server Error'],
  ['/auth/file/EACCES?status=403', 403, 'Forbidden']
]) {
  const response = await server.request(file);
  assert.strictEqual(response.status, status, file);
  assert.strictEqual(response.text, text, file);
  assertHelmetHeaders(response, file);
}
assert.strictEqual(logged('cannot open'), 1);

// The health check answers 200 while the database answers, 503 with a general message while it
// cannot be reached, logging one line, and 500 for any other failure, which is logged.
assert.strictEqual((await server.request('/health-check')).status, 200);
database.authenticate = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), {
    name: 'SequelizeConnectionRefusedError'
  });
};
const unavailable = await server.request('/health-check');
assert.strictEqual(unavailable.status, 503);
assert.strictEqual(unavailable.text, 'The database is unavailable.');
assertHelmetHeaders(unavailable, 'The health check without a database');
assert.ok(
  server.output.includes(
    'Database unavailable for GET /health-check: connect ECONNREFUSED 10.0.0.5:3306'
  )
);
database.authenticate = async () => {
  throw new Error('The database answered with something unexpected');
};
const unhealthy = await server.request('/health-check');
assert.strictEqual(unhealthy.status, 500);
assert.strictEqual(unhealthy.text, 'Internal Server Error');
assertHelmetHeaders(unhealthy, 'The failed health check');
assert.strictEqual(logged('The database answered with something unexpected'), 1);

// A request body like the client's is read and handed on.
const json = { 'content-type': 'application/json' };
const query = await server.request('/graphql', {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ query: '{ banLists { id } }' })
});
assert.strictEqual(query.status, 200);
assert.deepStrictEqual(bodies, [{ query: '{ banLists { id } }' }]);

// A body that cannot be read gets the parser's status with a fixed message, and Helmet's headers:
// 413 for one over the size limit, 400 for one that is not JSON, and 415 for one sent compressed.
// Only the kind of error is logged, never anything of the body.
const MARK = 'A-BODY-THE-LOG-NEVER-SHOWS';
for (const [body, headers, status, text, line] of [
  [
    JSON.stringify({ query: MARK.repeat(6000) }),
    json,
    413,
    'Request body too large.',
    'Could not read a request body: entity.too.large (413)'
  ],
  [
    `{"query": "${MARK}`,
    json,
    400,
    'Request body could not be read.',
    'Could not read a request body: SyntaxError (400)'
  ],
  [
    `"${MARK}"`,
    json,
    400,
    'Request body could not be read.',
    'Could not read a request body: SyntaxError (400)'
  ],
  [
    `{"query": "${MARK}"}`,
    { ...json, 'content-encoding': 'gzip' },
    415,
    'Unsupported Content-Encoding.'
  ]
]) {
  const before = server.output.length;
  const response = await server.request('/graphql', { method: 'POST', headers, body });
  assert.strictEqual(response.status, status, text);
  assert.strictEqual(response.text, text);
  assertHelmetHeaders(response, text);
  assert.deepStrictEqual(server.output.slice(before), line ? [line] : [], `Logged for ${status}`);
}
assert.strictEqual(bodies.length, 1, 'no unread body reaches the API');
assert.ok(!server.output.join('\n').includes(MARK), 'no body is logged');

// A body said to be larger than the limit is refused before any of it is read, and what was sent
// of it is not taken for the next request.
const declared = await server.request('/graphql', {
  method: 'POST',
  headers: { ...json, 'content-length': String(200 * 1024) },
  body: '{}'
});
assert.strictEqual(declared.status, 413);
assert.strictEqual(declared.text, 'Request body too large.');
assert.strictEqual((await server.request('/recent-bans')).status, 200);

// Were index.html missing from the build, a page would get 404 and a general message, without the
// path of the file that is missing.
await rm(path.join(server.directory, 'client/build/index.html'));
const missing = await server.request('/recent-bans');
assert.strictEqual(missing.status, 404);
assert.strictEqual(missing.text, 'Not Found');
assertHelmetHeaders(missing, 'A page without index.html');

await server.close();

console.log(
  'HTTP route checks passed: pages, built files, 404s, files outside the build, the health check, unreadable bodies, and errors with their headers.'
);
