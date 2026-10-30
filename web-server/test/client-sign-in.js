import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { ApolloLink } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { OperationTypeNode, parse } from 'graphql';
import jwt from 'jsonwebtoken';
import { jwtDecode } from 'jwt-decode';
import * as rxjs from 'rxjs';

import * as config from 'scbl-lib/config';

// The web server builds and serves the client, so the client's sign-in checks run with its tests.
// The client's modules load with stand-ins for the browser's local storage, alerts and reload, and
// stubs for the modules that need a browser.
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};
// The alerts the page shows and its reloads, in order.
const events = [];
const context = vm.createContext({
  localStorage,
  window: {
    alert: (message) => events.push(`alert: ${message}`),
    location: { reload: () => events.push('reload') }
  }
});
const stubs = {
  '@apollo/client': { ApolloLink },
  '@apollo/client/link/context': { SetContextLink },
  graphql: { OperationTypeNode },
  rxjs,
  'jwt-decode': { jwtDecode },
  'scbl-lib/config': config,
  './http-client': { default: {} },
  './color-mode.js': { COLOR_MODE_KEY: 'colorMode' }
};

// Each module loads once a page, so every module that imports auth.js shares its state, as in the
// browser. Each is kept before its file is read, as linking asks for a module's imports at once.
const modules = new Map();
function moduleFor(specifier, url) {
  if (!modules.has(url)) {
    const exports = stubs[specifier];
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
        : readFile(new URL(url), 'utf8').then(
            (source) => new vm.SourceTextModule(source, { context, identifier: url })
          )
    );
  }
  return modules.get(url);
}
async function linker(specifier, referencingModule) {
  if (stubs[specifier]) return moduleFor(specifier, specifier);
  assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
  return moduleFor(specifier, new URL(specifier, referencingModule.identifier).href);
}
async function load(path) {
  const module = await moduleFor(path, new URL(path, import.meta.url).href);
  if (module.status === 'unlinked') await module.link(linker);
  if (module.status === 'linked') await module.evaluate();
  return module.namespace.default;
}

// Load the client's modules afresh, as the browser does when the page loads or reloads. Local
// storage is kept, as in the browser.
async function openPage() {
  modules.clear();
  events.length = 0;
  return {
    readSignInToken: await load('../../client/src/utils/sign-in-token.js'),
    Auth: await load('../../client/src/utils/auth.js'),
    // The links the client sends GraphQL requests through.
    createLink: await load('../../client/src/utils/apollo-link.js')
  };
}
let { readSignInToken, Auth, createLink } = await openPage();

const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const user = { id: '76561198000000001', name: 'Test User', avatar: 'https://example.com/a.jpg' };
// The client cannot check signatures, so any secret will do.
const sign = (claims, options) => jwt.sign(claims, 'client-checks', options);
const fresh = sign({ user }, { expiresIn: 30 * DAY });
const expired = sign({ user, iat: now() - 31 * DAY }, { expiresIn: 30 * DAY });
// Tokens signed before sign-ins expired have no expiry, only the time they were issued.
const oldToken = (age) => sign({ user, iat: now() - age });
// Tokens with claims the token library will not sign.
const base64url = (text) => Buffer.from(text).toString('base64url');
const craft = (payload) =>
  [base64url('{"alg":"HS256","typ":"JWT"}'), base64url(payload), 'signature'].join('.');

// A token stops working when it expires, or once it is as old as a token's lifetime, whichever is
// first, as on the web server. Objects from the client's context are copied before comparing.
const issued = now() - DAY;
const shortLived = readSignInToken(sign({ user, iat: issued }, { expiresIn: 60 }));
assert.deepStrictEqual({ ...shortLived }, { user, expires: (issued + 60) * 1000 });
const lifetimeEnds = (issued + config.SIGN_IN_TOKEN_LIFETIME) * 1000;
const noExpiry = sign({ user, iat: issued });
const longExpiry = sign({ user, iat: issued }, { expiresIn: 60 * DAY });
assert.strictEqual(readSignInToken(noExpiry).expires, lifetimeEnds);
assert.strictEqual(readSignInToken(longExpiry).expires, lifetimeEnds);

// Tokens that cannot be read, or that the web server would refuse whatever their age, cannot be
// used.
const unreadable = [
  '',
  'null',
  'not a token',
  'a.b.c',
  craft('null'),
  sign({ name: 'No user' }, { expiresIn: DAY }),
  sign({ user }, { noTimestamp: true }),
  craft(JSON.stringify({ user, iat: now(), exp: 'tomorrow' }))
];
for (const token of unreadable)
  assert.strictEqual(readSignInToken(token), null, `Reading ${JSON.stringify(token)}`);

// Restore the sign-in from local storage, as the client does when it loads.
function restore(token) {
  storage.clear();
  storage.set('LOCALSTORAGE_VERSION', config.LOCALSTORAGE_VERSION);
  if (token !== undefined) storage.set('JWT', token);
  Auth.flush();
  return Auth.restoreAuth();
}

// A token that still works signs the user in, and stays stored.
for (const token of [fresh, oldToken(0), oldToken(29 * DAY)]) {
  assert.strictEqual(restore(token), true);
  assert.strictEqual(Auth.isLoggedIn, true);
  assert.strictEqual(Auth.jwtToken, token);
  assert.deepStrictEqual(Auth.claim, user);
  assert.strictEqual(storage.get('JWT'), token);
}

// An expired or unreadable token shows the user as signed out and is forgotten, so the user does
// not look signed in while the web server answers every request as signed out.
for (const token of [expired, oldToken(31 * DAY), ...unreadable]) {
  assert.strictEqual(restore(token), false, `Restoring ${JSON.stringify(token)}`);
  assert.strictEqual(Auth.isLoggedIn, false);
  assert.strictEqual(Auth.jwtToken, null);
  assert.strictEqual(Auth.claim, null);
  assert.strictEqual(storage.has('JWT'), false);
}
assert.strictEqual(restore(), false);

// When the web server says it no longer accepts the token, the client forgets it and reports that
// the user was signed in, so the page reloads as signed out.
restore(fresh);
assert.strictEqual(Auth.forgetRejectedToken(), true);
assert.strictEqual(Auth.isLoggedIn, false);
assert.strictEqual(Auth.jwtToken, null);
assert.strictEqual(storage.has('JWT'), false);
// Further responses for the same token change nothing, and nothing reloads again.
assert.strictEqual(Auth.forgetRejectedToken(), false);
// A newer token another tab has stored since is kept.
restore(fresh);
const newer = sign({ user }, { expiresIn: 30 * DAY, jwtid: 'newer' });
storage.set('JWT', newer);
assert.strictEqual(Auth.forgetRejectedToken(), true);
assert.strictEqual(storage.get('JWT'), newer);

// Send a request through the client's links, as the page does, to a stand-in for the web server
// that answers with the given result. Record the token the web server was sent, and what reaches
// the page.
const query = parse('query { loggedInSteamUser { id } }');
const change = parse('mutation { deleteExportBanList(id: 7) { id } }');
async function send(document, answer) {
  const seen = { token: undefined, results: [], complete: false };
  const webServer = new ApolloLink((operation) => {
    seen.token = operation.getContext().headers?.JWT;
    return rxjs.of(answer);
  });
  ApolloLink.execute(createLink(webServer), { query: document }, {}).subscribe({
    next: (value) => seen.results.push(value),
    complete: () => (seen.complete = true)
  });
  // The link that adds the token passes requests on asynchronously, so let the request finish.
  await new Promise((resolve) => setImmediate(resolve));
  return seen;
}
const reached = (token, answer) => ({ token, results: [answer], complete: true });
const heldBack = (token) => ({ token, results: [], complete: false });
const signedInAnswer = { data: { loggedInSteamUser: { id: user.id } } };
const rejectedAnswer = {
  data: { loggedInSteamUser: null },
  extensions: { signInTokenRejected: true }
};
const refusedChange = {
  data: { deleteExportBanList: null },
  errors: [{ message: 'Please sign in again to delete an export ban list.' }],
  extensions: { signInTokenRejected: true }
};

// Requests carry the stored token, and answers for a token the web server accepts reach the page.
restore(fresh);
assert.deepStrictEqual(await send(query, signedInAnswer), reached(fresh, signedInAnswer));
assert.strictEqual(Auth.isLoggedIn, true);
// If the user is already signed out, there is nothing to forget, so nothing reloads, whether the
// answer is to a query or a change.
Auth.flush();
assert.deepStrictEqual(await send(query, rejectedAnswer), reached(null, rejectedAnswer));
assert.deepStrictEqual(await send(change, refusedChange), reached(null, refusedChange));
assert.deepStrictEqual(events, []);

// An answer saying the token is no longer accepted, e.g. as the sign-in expired while the page was
// open, signs the user out and reloads the page. It is held back meanwhile, so the page does not
// show it, and so are any answers after it. The page only reloads once, and as the answer was to a
// query, it reloads without an alert.
restore(fresh);
assert.deepStrictEqual(await send(query, rejectedAnswer), heldBack(fresh));
assert.deepStrictEqual(events, ['reload']);
assert.strictEqual(Auth.isLoggedIn, false);
assert.strictEqual(storage.has('JWT'), false);
assert.deepStrictEqual(await send(query, signedInAnswer), heldBack(null));
assert.deepStrictEqual(await send(query, rejectedAnswer), heldBack(null));
assert.deepStrictEqual(await send(change, refusedChange), heldBack(null));
assert.deepStrictEqual(events, ['reload']);

// The page reloads signed out.
({ Auth, createLink } = await openPage());
assert.strictEqual(Auth.restoreAuth(), false);
assert.strictEqual(Auth.isLoggedIn, false);

// When the answer is to a change the user made, e.g. deleting an export ban list, the page that
// reloads would not say the change failed, so an alert says nothing was changed first.
restore(fresh);
assert.deepStrictEqual(await send(change, refusedChange), heldBack(fresh));
assert.strictEqual(events.length, 2);
assert.match(events[0], /^alert: Your sign-in has expired, so nothing was changed\./);
assert.strictEqual(events[1], 'reload');
// Later answers are held back too, without another alert.
assert.deepStrictEqual(await send(change, refusedChange), heldBack(null));
assert.strictEqual(events.length, 2);

console.log(
  'Client sign-in checks passed: reading, restoring and forgetting tokens, and expiry mid-session.'
);
