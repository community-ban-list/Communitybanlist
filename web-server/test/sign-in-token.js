import assert from 'assert';

import { ApolloServer } from '@apollo/server';
import jwt from 'jsonwebtoken';

// The secret is read from the environment when the modules load.
const SECRET = 'a-secret-only-these-checks-use-0123456789abcdef';
process.env.JWT_AUTH_SECRET = SECRET;
delete process.env.JWT_AUTH_ALGORITHM;

const { SIGN_IN_TOKEN_LIFETIME } = await import('scbl-lib/config');
const { checkSignInToken, createSignInToken } = await import('../src/auth/sign-in-token.js');
const { reportRejectedSignInTokens, signInContext } =
  await import('../src/graphql-api/core/sign-in.js');

const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const user = { id: '76561198000000001', name: 'Test User', avatar: 'https://example.com/a.jpg' };
const signedIn = { user, rejected: false };
const rejected = { user: null, rejected: true };
const signedOut = { user: null, rejected: false };

// Check a token as if this many seconds had passed. The token library reads Date.now().
function after(seconds, token) {
  const realNow = Date.now;
  Date.now = () => realNow() + seconds * 1000;
  try {
    return checkSignInToken(token);
  } finally {
    Date.now = realNow;
  }
}

// Sign-in tokens last 30 days.
assert.strictEqual(SIGN_IN_TOKEN_LIFETIME, 30 * DAY);

// A new token carries the user, is signed with the configured algorithm and expires 30 days after
// it was issued. It signs the user in until then, and not after.
const token = createSignInToken(user);
const { header, payload } = jwt.decode(token, { complete: true });
assert.strictEqual(header.alg, 'HS256');
assert.deepStrictEqual(payload.user, user);
assert.ok(Math.abs(payload.iat - now()) <= 5);
assert.strictEqual(payload.exp - payload.iat, SIGN_IN_TOKEN_LIFETIME);
assert.deepStrictEqual(checkSignInToken(token), signedIn);
assert.deepStrictEqual(after(30 * DAY - 60, token), signedIn);
assert.deepStrictEqual(after(30 * DAY, token), rejected);

// Tokens signed before sign-ins expired have no expiry, only the time they were issued. They keep
// working until they are 30 days old, and then stop.
const oldToken = (age) => jwt.sign({ user, iat: now() - age }, SECRET, { algorithm: 'HS256' });
assert.strictEqual(jwt.decode(oldToken(0)).exp, undefined);
assert.deepStrictEqual(checkSignInToken(oldToken(0)), signedIn);
assert.deepStrictEqual(checkSignInToken(oldToken(29 * DAY)), signedIn);
assert.deepStrictEqual(checkSignInToken(oldToken(30 * DAY + 60)), rejected);
assert.deepStrictEqual(after(30 * DAY, oldToken(0)), rejected);
// One without even that cannot be aged, so it is refused.
const undated = jwt.sign({ user }, SECRET, { algorithm: 'HS256', noTimestamp: true });
assert.deepStrictEqual(checkSignInToken(undated), rejected);

// The lifetime applies whatever expiry a token carries, and an earlier expiry applies too.
const longToken = jwt.sign({ user }, SECRET, { algorithm: 'HS256', expiresIn: 60 * DAY });
assert.deepStrictEqual(after(30 * DAY, longToken), rejected);
const shortToken = jwt.sign({ user }, SECRET, { algorithm: 'HS256', expiresIn: 60 });
assert.deepStrictEqual(checkSignInToken(shortToken), signedIn);
assert.deepStrictEqual(after(60, shortToken), rejected);

// Tokens signed with another secret or algorithm, or not signed at all, are refused.
for (const forged of [
  jwt.sign({ user }, 'another-secret-0123456789abcdef0123456789', { expiresIn: DAY }),
  jwt.sign({ user }, SECRET, { algorithm: 'HS512', expiresIn: DAY }),
  jwt.sign({ user }, null, { algorithm: 'none', expiresIn: DAY })
])
  assert.deepStrictEqual(checkSignInToken(forged), rejected);

// No token, or a value that is not a token at all, such as the "null" the client sends when signed
// out, is simply signed out.
const notJson = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from('not json').toString('base64url'),
  'signature'
].join('.');
for (const value of ['', 'null', 'undefined', 'not a token', 'a.b.c', notJson])
  assert.deepStrictEqual(checkSignInToken(value), signedOut, `Checking ${JSON.stringify(value)}`);

// GraphQL requests are answered for the token's user, and as signed out without a valid token.
// When there was a token that is not accepted, the response says so, so the client can show the
// user as signed out.
const server = new ApolloServer({
  typeDefs: 'type Query { signedInAs: String }',
  resolvers: { Query: { signedInAs: (parent, args, context) => context.user?.id ?? null } },
  plugins: [reportRejectedSignInTokens]
});
await server.start();
async function request(token) {
  const ctx = { get: (header) => (header === 'JWT' ? token : '') };
  const contextValue = await signInContext({ ctx });
  const response = await server.executeOperation({ query: '{ signedInAs }' }, { contextValue });
  assert.strictEqual(response.body.kind, 'single');
  const { data, errors, extensions } = response.body.singleResult;
  assert.strictEqual(errors, undefined);
  return { signedInAs: data.signedInAs, extensions };
}
const answeredFor = (id) => ({ signedInAs: id, extensions: undefined });
const toldSignedOut = { signedInAs: null, extensions: { signInTokenRejected: true } };
const expired = jwt.sign({ user, iat: now() - 31 * DAY }, SECRET, { expiresIn: 30 * DAY });
for (const valid of [token, oldToken(DAY)])
  assert.deepStrictEqual(await request(valid), answeredFor(user.id));
for (const refused of [expired, oldToken(31 * DAY), undated])
  assert.deepStrictEqual(await request(refused), toldSignedOut);
for (const value of ['', 'null']) assert.deepStrictEqual(await request(value), answeredFor(null));
await server.stop();

console.log(
  'Sign-in token checks passed: signing, fresh, expired and older tokens, and GraphQL requests.'
);
