import assert from 'assert';
import { existsSync } from 'fs';
import { readdir, readFile, utimes, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import Router from '@koa/router';

import { FILES, loadApp } from './helpers/load-app.js';

// Checks how long browsers may keep what the web server sends in production. The files Vite builds
// into /static are kept for a year. The files at the top of the build and the client's pages are
// checked on every visit, and get 304 while they have not changed. The app is
// web-server/src/app.js, with stand-ins for its routes and the database.

const STEAM_ID = '76561198000000001';
const A_YEAR = ['max-age=31536000', 'immutable'];
const EVERY_VISIT = ['max-age=0'];

// The directives of an answer's Cache-Control header.
const directives = (response) =>
  (response.headers['cache-control'] ?? '').split(',').map((directive) => directive.trim());

// Another bundle, a picture, and the colour mode script, which index.html loads from the top of the
// build.
const BUNDLE = 'console.log("A line of the client");\n'.repeat(1000);
const PICTURE = Buffer.alloc(4096, 1);
const COLOR_MODE = "document.documentElement.setAttribute('data-bs-theme', 'dark');\n";

// An export list and an API answer.
const EXPORT_LIST = Array.from(
  { length: 500 },
  (_, index) => `7656119800000${String(index).padStart(4, '0')}:0`
).join('\n');
const exportBanLists = new Router();
exportBanLists.get('/:id', (ctx) => {
  ctx.body = EXPORT_LIST;
});
const BAN_LISTS = Array.from({ length: 200 }, (_, index) => ({
  id: String(index + 1),
  name: `Ban list ${index + 1}`
}));
async function graphql(ctx, next) {
  if (ctx.path !== '/graphql') return next();
  ctx.body = { data: { banLists: BAN_LISTS } };
}

const server = await loadApp({
  files: {
    ...FILES,
    'client/build/color-mode.js': COLOR_MODE,
    'client/build/static/index-B1g2B3n4.js': BUNDLE,
    'client/build/static/logo-Pa5s6t7h.png': PICTURE
  },
  stubs: {
    './graphql-api/index.js': { default: graphql },
    './export-ban-lists.js': { default: exportBanLists }
  }
});
const builtFile = (name) => path.join(server.directory, 'client/build', name);

// Each file of the build was last changed when the client was built.
const BUILT = new Date('2026-10-01T12:00:00Z');
for (const name of ['index.html', 'favicon.ico', 'manifest.json', 'color-mode.js'])
  await utimes(builtFile(name), BUILT, BUILT);
for (const name of ['app-abc.js', 'index-B1g2B3n4.js', 'logo-Pa5s6t7h.png'])
  await utimes(builtFile(`static/${name}`), BUILT, BUILT);
const LAST_MODIFIED = BUILT.toUTCString();
const UNCHANGED_SINCE = { 'if-modified-since': LAST_MODIFIED };

// The files Vite builds into /static, which get a new name when their content changes, may be kept
// for a year without asking again.
for (const name of [
  '/static/app-abc.js',
  '/static/index-B1g2B3n4.js',
  '/static/logo-Pa5s6t7h.png'
]) {
  const response = await server.request(name);
  assert.strictEqual(response.status, 200, name);
  assert.deepStrictEqual(directives(response), A_YEAR, name);
}

// The files at the top of the build keep their names from one build to the next, as do the
// client's pages, which are all index.html, so browsers ask about them on every visit. A browser
// that says when its copy last changed gets 304, without the file, while the file is unchanged, and
// so does one asking about a file under /static.
for (const name of [
  '/',
  '/recent-bans',
  `/search/${STEAM_ID}`,
  '/index.html',
  '/color-mode.js',
  '/favicon.ico',
  '/manifest.json',
  '/static/app-abc.js',
  '/static/index-B1g2B3n4.js'
]) {
  const response = await server.request(name);
  assert.strictEqual(response.status, 200, name);
  assert.strictEqual(response.headers['last-modified'], LAST_MODIFIED, name);
  if (!name.startsWith('/static/')) assert.deepStrictEqual(directives(response), EVERY_VISIT, name);
  for (const method of ['GET', 'HEAD']) {
    const unchanged = await server.request(name, { method, headers: UNCHANGED_SINCE });
    assert.strictEqual(unchanged.status, 304, `${method} ${name} is unchanged`);
    assert.strictEqual(unchanged.bytes.length, 0, `${method} ${name} has no body`);
    assert.deepStrictEqual(directives(unchanged), directives(response), name);
  }
}

// A browser that asks for a file afresh, as on a reload that skips its cache, gets the file.
const reload = await server.request('/static/app-abc.js', {
  headers: { ...UNCHANGED_SINCE, 'cache-control': 'no-cache' }
});
assert.strictEqual(reload.status, 200);
assert.strictEqual(reload.text, FILES['client/build/static/app-abc.js']);

// Answers that are not files are never 304, whatever a browser says about its copy, such as the
// client's config, which browsers still ask for on every visit, nor are 404s. A file missing from
// /static, such as one from another build, is not kept.
const config = await server.request('/config.js');
assert.strictEqual(config.status, 200);
assert.deepStrictEqual(directives(config), ['no-cache']);
assert.match(config.text, /^window\.CBL_CONFIG = /);
const query = JSON.stringify({ query: '{ banLists { id name } }' });
const json = { 'content-type': 'application/json' };
const API_ANSWER = JSON.stringify({ data: { banLists: BAN_LISTS } });
for (const conditions of [UNCHANGED_SINCE, { 'if-none-match': '*' }]) {
  for (const [name, expected, options] of [
    ['/config.js', config.text, {}],
    ['/export/7', EXPORT_LIST, {}],
    ['/health-check', 'OK', {}],
    [`/graphql?query=${encodeURIComponent('{ banLists { id name } }')}`, API_ANSWER, {}],
    ['/graphql', API_ANSWER, { method: 'POST', headers: json, body: query }]
  ]) {
    const headers = { ...options.headers, ...conditions };
    const response = await server.request(name, { ...options, headers });
    const label = `${options.method ?? 'GET'} ${name} with ${Object.keys(conditions)}`;
    assert.strictEqual(response.status, 200, label);
    assert.strictEqual(response.text, expected, label);
  }
}
for (const missing of ['/static/index-0ld0ld00.js', '/nonexistent.png']) {
  const response = await server.request(missing, { headers: UNCHANGED_SINCE });
  assert.strictEqual(response.status, 404, missing);
  assert.ok(
    !directives(response).some((directive) => /^(immutable|max-age=[1-9])/.test(directive)),
    `${missing} is not kept`
  );
}

// A browser whose copy is older than the file, as after a new build, gets the new file, so a new
// client shows at once.
const REBUILT = new Date(BUILT.getTime() + 60 * 60 * 1000);
const NEW_INDEX = '<!DOCTYPE html>\n<title>Community Ban List</title>\n<main id="root"></main>\n';
await writeFile(builtFile('index.html'), NEW_INDEX);
await utimes(builtFile('index.html'), REBUILT, REBUILT);
for (const page of ['/', '/recent-bans', '/index.html']) {
  const response = await server.request(page, { headers: UNCHANGED_SINCE });
  assert.strictEqual(response.status, 200, page);
  assert.strictEqual(response.text, NEW_INDEX, page);
  assert.strictEqual(response.headers['last-modified'], REBUILT.toUTCString(), page);
  assert.deepStrictEqual(directives(response), EVERY_VISIT, page);
}

// A browser whose copy is newer than the file, as when the image of an earlier build is run again,
// gets the file too, so it runs the client the server has, rather than keeping the newer one, which
// loads files the earlier build does not have. Only a copy from the same time as the file counts as
// unchanged.
await writeFile(builtFile('index.html'), FILES['client/build/index.html']);
await utimes(builtFile('index.html'), BUILT, BUILT);
const NEWER_COPY = { 'if-modified-since': REBUILT.toUTCString() };
for (const [name, expected] of [
  ['/', FILES['client/build/index.html']],
  ['/recent-bans', FILES['client/build/index.html']],
  ['/index.html', FILES['client/build/index.html']],
  ['/color-mode.js', COLOR_MODE],
  ['/manifest.json', FILES['client/build/manifest.json']],
  ['/static/app-abc.js', FILES['client/build/static/app-abc.js']]
]) {
  const response = await server.request(name, { headers: NEWER_COPY });
  assert.strictEqual(response.status, 200, `${name} for a newer copy`);
  assert.strictEqual(response.text, expected, `${name} for a newer copy`);
  assert.strictEqual(response.headers['last-modified'], LAST_MODIFIED, name);
}

await server.close();

// Vite copies client/public into the build as it is, so a file in client/public/static would be
// served under /static with a name that stays the same when the file changes, and browsers would
// keep an old copy for a year. So client/public has nothing under static/, and every file
// index.html loads by its own name, rather than through Vite, is at the top of client/public.
const client = new URL('../../client/', import.meta.url);
const publicFolder = fileURLToPath(new URL('public/', client));
const underStatic = (await readdir(publicFolder, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(publicFolder, path.join(entry.parentPath, entry.name)))
  .filter((name) => name.split(path.sep)[0] === 'static');
assert.deepStrictEqual(underStatic, [], 'client/public has no files under static/');

const html = await readFile(new URL('index.html', client), 'utf8');
const loaded = [...html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="(\/[^"]*)"/g)].map(
  (match) => match[1]
);
// Vite builds the client's code, under /src, into /static, and the server makes /config.js.
const copied = loaded.filter((name) => !name.startsWith('/src/') && name !== '/config.js');
assert.ok(copied.includes('/color-mode.js'), 'index.html loads /color-mode.js');
for (const name of copied)
  assert.ok(
    /^\/[^/]+$/.test(name) && existsSync(new URL(`public${name}`, client)),
    `index.html loads ${name}, which is at the top of client/public`
  );

// Where the client has been built, as in the image and the pull request checks, each file Vite
// built into /static has a hash of its content in its name.
const builtStatic = new URL('build/static/', client);
const built = existsSync(builtStatic) ? await readdir(builtStatic, { recursive: true }) : [];
for (const name of built)
  assert.match(
    name,
    /-[\w-]{8}\.\w+$/,
    `client/build/static/${name} has no hash of its content in its name. If the build is older ` +
      'than this check, build the client again.'
  );

console.log(
  'Static file checks passed: files under /static are kept for a year, and other files and pages ' +
    'get 304 while unchanged' +
    (built.length > 0 ? `. The ${built.length} files built into /static have hashed names.` : '.')
);
