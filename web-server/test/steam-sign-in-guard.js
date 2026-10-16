import assert from 'assert';
import { readFile } from 'fs/promises';
import http from 'http';
import { createRequire } from 'module';
import vm from 'vm';

import Koa from 'koa';
import Router from '@koa/router';

import {
  checkSteamAnswer,
  signInDeadline,
  startSteamSignIn
} from '../src/auth/steam-sign-in-guard.js';

const require = createRequire(import.meta.url);
const app = new Koa();

// A context for one GET, without opening a socket, as the export endpoint test does.
function contextFor(url) {
  const req = new http.IncomingMessage(null);
  req.method = 'GET';
  req.url = url;
  return app.createContext(req, new http.ServerResponse(req));
}

// A fresh, in-window OpenID 2.0 response nonce, as Steam sends.
function freshNonce(unique = 'UNIQUE123') {
  return new Date().toISOString() + unique;
}

// A query shaped like a genuine positive Steam answer.
function steamAnswer(overrides = {}) {
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.return_to': 'http://cbl.test/login',
    'openid.response_nonce': freshNonce(),
    'openid.assoc_handle': 'handle',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce',
    'openid.sig': 'AAAAAAAAAAAAAAAAAAAAAAAA',
    ...overrides
  };
}

// A query string for these fields. A field set to undefined is left out.
function queryString(fields) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) search.append(key, one);
  }
  const string = search.toString();
  return string ? '?' + string : '';
}

// ---------------------------------------------------------------------------
// Part 1: the two middlewares on contexts made with app.createContext.
// ---------------------------------------------------------------------------

signInDeadline.milliseconds = 15000;

// The return guard answers 400 and does not run the rest of the chain for anything that is not a
// genuine Steam answer: a start-style identifier (in the query or a body), a mode that is not a
// positive answer, a provider or identity that is not Steam, an identity that does not match the
// claim, the wrong number of identity digits, a repeated parameter, too many parameters, an
// over-long nonce, or a missing or different namespace.
const rejectedAnswers = {
  'openid_identifier in the query': { openid_identifier: 'http://example.test/' },
  'a non-answer mode': steamAnswer({ 'openid.mode': 'checkid_setup' }),
  'a foreign op_endpoint': steamAnswer({ 'openid.op_endpoint': 'http://example.test/login' }),
  'an http claimed_id': steamAnswer({
    'openid.claimed_id': 'http://steamcommunity.com/openid/id/76561198000000001',
    'openid.identity': 'http://steamcommunity.com/openid/id/76561198000000001'
  }),
  'a non-Steam claimed_id': steamAnswer({
    'openid.claimed_id': 'https://example.test/openid/id/76561198000000001',
    'openid.identity': 'https://example.test/openid/id/76561198000000001'
  }),
  'identity different from the claim': steamAnswer({
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002'
  }),
  'a 16-digit identity': steamAnswer({
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/7656119800000000',
    'openid.identity': 'https://steamcommunity.com/openid/id/7656119800000000'
  }),
  'an 18-digit identity': steamAnswer({
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/765611980000000012',
    'openid.identity': 'https://steamcommunity.com/openid/id/765611980000000012'
  }),
  'a 300-character nonce': steamAnswer({ 'openid.response_nonce': freshNonce('u'.repeat(300)) }),
  'a missing namespace': steamAnswer({ 'openid.ns': undefined }),
  'a different namespace': steamAnswer({ 'openid.ns': 'http://openid.net/signon/1.1' })
};

for (const [name, fields] of Object.entries(rejectedAnswers)) {
  const ctx = contextFor('/steam/return' + queryString(fields));
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(ctx.status, 400, `Rejected: ${name}`);
  assert.strictEqual(ctx.body, 'Steam sign-in failed. Please try again.', `Message: ${name}`);
  assert.strictEqual(reached, false, `Did not continue: ${name}`);
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', `Cache-Control: ${name}`);
}

// A repeated parameter arrives as an array and is rejected as well, even in a Steam-shaped answer.
{
  const ctx = contextFor(
    '/steam/return' + queryString(steamAnswer({ 'openid.sig': ['AAAA', 'BBBB'] }))
  );
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(ctx.status, 400, 'A repeated parameter is rejected');
  assert.strictEqual(reached, false, 'A repeated parameter does not continue');
}

// More than twenty parameters is rejected, even with a Steam-shaped answer among them.
{
  const many = steamAnswer();
  for (let i = 0; i < 20; i++) many['extra' + i] = String(i);
  const ctx = contextFor('/steam/return' + queryString(many));
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(ctx.status, 400, 'Too many parameters is rejected');
  assert.strictEqual(reached, false, 'Too many parameters does not continue');
}

// Empty parts of the query count towards the twenty as well.
{
  const ctx = contextFor('/steam/return' + queryString(steamAnswer()) + '&'.repeat(20));
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(ctx.status, 400, 'Empty parts count towards the limit');
  assert.strictEqual(reached, false, 'Too many parts does not continue');
}

// A start-style identifier in a body, with no answer in the query, is rejected as well.
{
  const ctx = contextFor('/steam/return');
  ctx.request.body = { openid_identifier: 'http://example.test/' };
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(ctx.status, 400, 'An identifier in a body is rejected');
  assert.strictEqual(reached, false, 'An identifier in a body does not continue');
}

// A genuine Steam answer continues to the rest of the chain, with its query untouched, and the
// browser is told not to keep the answer in its cache.
{
  const answer = steamAnswer();
  const ctx = contextFor('/steam/return' + queryString(answer));
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(reached, true, 'A Steam answer continues');
  assert.strictEqual(
    ctx.query['openid.claimed_id'],
    answer['openid.claimed_id'],
    'Query untouched'
  );
  assert.strictEqual(
    ctx.query['openid.op_endpoint'],
    answer['openid.op_endpoint'],
    'Query untouched'
  );
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', 'Steam answer is no-store');
}

// A cancelled sign-in continues to the chain (Passport turns it into a failure), query untouched.
{
  const ctx = contextFor('/steam/return?openid.mode=cancel&openid.ns=something');
  let reached = false;
  await checkSteamAnswer(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(reached, true, 'A cancel continues');
  assert.strictEqual(ctx.query['openid.mode'], 'cancel', 'Cancel query untouched');
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', 'Cancel is no-store');
}

// The start guard always continues, with an empty query and body, whatever the request carried: a
// start-style identifier, or an answer-style mode and claim that must not drive a lookup here.
for (const start of [
  '/steam?openid_identifier=http://example.test/',
  '/steam?openid.mode=id_res&openid.claimed_id=https://example.test/',
  '/steam'
]) {
  const ctx = contextFor(start);
  ctx.request.body = { openid_identifier: 'http://example.test/' };
  let reached = false;
  await startSteamSignIn(ctx, async () => {
    reached = true;
  });
  assert.strictEqual(reached, true, `Start continues: ${start}`);
  assert.deepStrictEqual({ ...ctx.query }, {}, `Empty query: ${start}`);
  assert.deepStrictEqual(ctx.request.body, {}, `Empty body: ${start}`);
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', `Start is no-store: ${start}`);
}

// When the rest of the chain never settles, the guard answers 504 once the (shortened) deadline
// passes, and a failure that arrives afterwards is handled, not left dangling.
{
  signInDeadline.milliseconds = 50;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  const ctx = contextFor('/steam/return' + queryString(steamAnswer()));
  await checkSteamAnswer(
    ctx,
    () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 120))
  );
  assert.strictEqual(ctx.status, 504, 'A stalled sign-in answers 504');
  assert.strictEqual(ctx.body, 'Steam did not answer in time. Please try again.', '504 message');
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', '504 is no-store');

  await new Promise((resolve) => setTimeout(resolve, 200));
  process.off('unhandledRejection', onUnhandled);
  assert.deepStrictEqual(unhandled, [], 'A late failure is handled');
  signInDeadline.milliseconds = 15000;
}

// ---------------------------------------------------------------------------
// Part 2: routes.js mounted under /auth with the real router and a recording
// Passport, so the guards are shown to run first for the paths Steam uses, in
// their case and trailing-slash variants.
// ---------------------------------------------------------------------------

const passportCalls = [];
const recordingPassport = {
  authenticate(name) {
    return async (ctx) => {
      passportCalls.push({ name, path: ctx.path, query: { ...ctx.query } });
      ctx.status = 200;
      ctx.body = 'passport ran';
    };
  }
};

const routesUrl = new URL('../src/auth/routes.js', import.meta.url);
// Signing the token is stubbed whether routes.js does it itself or through ./sign-in-token.js.
const routesStubs = {
  '@koa/router': { default: Router },
  jsonwebtoken: { default: { sign: () => 'stub-token' } },
  'scbl-lib/config': { JWT_AUTH: { SECRET: 'secret', ALGORITHM: 'HS256' } },
  './sign-in-token.js': { createSignInToken: () => 'stub-token' },
  './passport.js': { default: recordingPassport }
};
const routesModule = new vm.SourceTextModule(await readFile(routesUrl, 'utf8'), {
  identifier: routesUrl.href
});
await routesModule.link(async (specifier, referencing) => {
  if (routesStubs[specifier]) {
    const exports = routesStubs[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    });
  }
  const url = new URL(specifier, referencing.identifier);
  return new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
});
await routesModule.evaluate();
const authRoutes = routesModule.namespace.default;

const outer = new Router();
outer.use('/auth', authRoutes.routes(), authRoutes.allowedMethods());
const dispatch = outer.routes();
async function send(path) {
  const ctx = contextFor(path);
  await dispatch(ctx, async () => {});
  return ctx;
}

// The start route is guarded, in lower case and in upper case: Passport runs, but only after the
// guard has emptied the query, so the request cannot steer the lookup.
for (const path of ['/auth/steam', '/auth/STEAM']) {
  passportCalls.length = 0;
  const ctx = await send(path + '?openid.mode=id_res&openid.claimed_id=https://example.test/');
  assert.strictEqual(passportCalls.length, 1, `Passport runs for ${path}`);
  assert.strictEqual(passportCalls[0].name, 'steam', `Steam strategy for ${path}`);
  assert.deepStrictEqual(passportCalls[0].query, {}, `Guard emptied the query for ${path}`);
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', `no-store for ${path}`);
}

// The return route is guarded, including with a trailing slash: a request that is not a Steam answer
// is turned away before Passport runs.
{
  passportCalls.length = 0;
  const ctx = await send(
    '/auth/steam/return/?openid.mode=id_res&openid.op_endpoint=http://example.test/'
  );
  assert.strictEqual(ctx.status, 400, 'The trailing-slash return route is guarded');
  assert.strictEqual(passportCalls.length, 0, 'Passport does not run for a rejected answer');
  assert.strictEqual(ctx.response.get('Cache-Control'), 'no-store', 'Rejected answer is no-store');
}

// ---------------------------------------------------------------------------
// Part 3: end to end with the real passport-steam strategy behind koa-passport.
// The OpenID library's HTTP calls are replaced before it loads, so nothing is
// sent and every host the sign-in would contact can be seen.
// ---------------------------------------------------------------------------

const openidHttp = require('openid/http.js');
const contacted = [];
openidHttp.get = (url, _params, callback) => {
  contacted.push(url);
  callback(new Error('no network in this test'));
};
openidHttp.post = (url, _data, callback) => {
  contacted.push(url);
  callback(new Error('no network in this test'));
};

// Loading passport-steam loads the OpenID library, which copies the HTTP functions replaced above.
const SteamStrategy = require('passport-steam');
const KoaPassport = require('koa-passport').KoaPassport;

const passport = new KoaPassport();
passport.use(
  new SteamStrategy(
    {
      returnURL: 'http://cbl.test/login',
      realm: 'http://cbl.test',
      apiKey: 'dummy',
      // The profile fetch is a separate call Steam only answers after a real sign-in; it is off here
      // so the test turns only on where the OpenID lookup goes.
      profile: false
    },
    (identifier, profile, done) => done(null, { id: identifier })
  )
);

// The sign-in routes as routes.js registers them, with the guards first.
function buildStack() {
  const router = new Router();
  router.get('/steam', startSteamSignIn);
  router.get('/steam/return', checkSteamAnswer);
  router.get('/steam', passport.authenticate('steam'));
  router.get('/steam/return', passport.authenticate('steam', { session: false }), (ctx) => {
    ctx.body = 'signed in';
  });
  const routes = router.routes();
  return async (path) => {
    const ctx = contextFor(path);
    // Without a network the sign-in cannot finish; only the hosts it tried to reach matter here.
    try {
      await routes(ctx, async () => {});
    } catch {
      // Ignored on purpose.
    }
    return ctx;
  };
}

const guarded = buildStack();

const toHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const nonSteam = (url) => toHost(url) !== 'steamcommunity.com';

// A Steam-shaped answer goes on to Passport, and the OpenID library looks it up at Steam only.
contacted.length = 0;
await guarded('/steam/return' + queryString(steamAnswer()));
assert.ok(contacted.length > 0, 'A Steam answer is looked up');
assert.deepStrictEqual(contacted.filter(nonSteam), [], 'A Steam answer is looked up at Steam only');

// An answer whose provider and claimed identity are not Steam's is turned away before any lookup.
contacted.length = 0;
const turnedAway = await guarded(
  '/steam/return' +
    queryString(
      steamAnswer({
        'openid.op_endpoint': 'http://example.test/login',
        'openid.claimed_id': 'http://example.test/id',
        'openid.identity': 'http://example.test/id'
      })
    )
);
assert.strictEqual(turnedAway.status, 400, 'An answer not from Steam is turned away');
assert.deepStrictEqual(contacted, [], 'An answer not from Steam is not looked up');

// A start that names a provider of its own still looks up Steam, and only Steam.
contacted.length = 0;
await guarded('/steam?openid_identifier=http://example.test/');
assert.ok(contacted.length > 0, 'The guarded start still looks Steam up');
assert.deepStrictEqual(contacted.filter(nonSteam), [], 'Guarded start contacts only Steam');

console.log(
  'Steam sign-in guard checks passed: only Steam answers continue, the start is pinned to Steam, ' +
    'answers are not cached, slow sign-ins time out, and the lookup only ever reaches Steam.'
);
