import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloServer from '@apollo/server';
import * as apolloServerErrors from '@apollo/server/errors';
import * as apolloServerDisabledPlugins from '@apollo/server/plugin/disabled';
import * as graphqlToolsSchema from '@graphql-tools/schema';
import graphql from 'graphql';
import jwt from 'jsonwebtoken';

// The secret is read from the environment when the config loads.
const SECRET = 'a-secret-only-these-checks-use-0123456789abcdef';
process.env.JWT_AUTH_SECRET = SECRET;
delete process.env.JWT_AUTH_ALGORITHM;
const config = await import('scbl-lib/config');

// The sign-in route and the GraphQL API load from the files the web server runs, with stubs for
// Steam, Koa, the database and the schema. The code that signs and checks tokens is the real code.
const packages = {
  '@apollo/server': apolloServer,
  '@apollo/server/errors': apolloServerErrors,
  '@apollo/server/plugin/disabled': apolloServerDisabledPlugins,
  '@graphql-tools/schema': graphqlToolsSchema,
  graphql: { default: graphql },
  jsonwebtoken: { default: jwt },
  'scbl-lib/config': config,
  // No ban list is paused.
  'scbl-lib/db/ban-list-suspensions': {
    readPausedBanLists: async () => [],
    pausedSets: () => ({ suspended: [], excluded: [] })
  },
  'scbl-lib/db/sequelize': {
    DATABASE_UNAVAILABLE_MESSAGE: 'The database is unavailable.',
    isDatabaseUnavailable: () => false
  }
};

// Load a module with these stubs, as well as the packages above, in a context with these globals.
// Other relative imports load the real files.
async function load(path, stubs, globals = {}) {
  const context = vm.createContext(globals);
  const modules = new Map();
  async function moduleFor(specifier, referencingURL) {
    const exports = stubs[specifier] || packages[specifier];
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
  const module = await moduleFor(path, import.meta.url);
  await module.link((specifier, referencingModule) =>
    moduleFor(specifier, referencingModule.identifier)
  );
  await module.evaluate();
  return module.namespace.default;
}

const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const user = { id: '76561198000000001', name: 'Test User', avatar: 'https://example.com/a.jpg' };

// Signing in with Steam answers with a token for the user, signed with the configured algorithm,
// that expires a token's lifetime after it was issued. Steam's part is stubbed, so the route's last
// handler is given the user as Steam's sign-in leaves it.
class Router {
  routes = new Map();
  get(path, ...handlers) {
    this.routes.set(path, handlers);
  }
}
const router = await load('../src/auth/routes.js', {
  '@koa/router': { default: Router },
  './passport.js': { default: { authenticate: () => async () => {} } }
});
const ctx = { req: { user } };
await router.routes.get('/steam/return').at(-1)(ctx);
const { token } = JSON.parse(ctx.body);
const { header, payload } = jwt.decode(token, { complete: true });
assert.strictEqual(header.alg, 'HS256');
assert.deepStrictEqual(payload.user, user);
assert.ok(Math.abs(payload.iat - now()) <= 5);
assert.strictEqual(payload.exp - payload.iat, config.SIGN_IN_TOKEN_LIFETIME);

// The GraphQL API answers each request for the user its token signs in, and as signed out without
// a valid token. When there was a token it no longer accepts, as it has expired or is older than a
// token's lifetime, the answer says so, so the client can show the user as signed out. This holds
// in production, where the API has another plugin, as well as in development.
const expired = jwt.sign({ user, iat: now() - 31 * DAY }, SECRET, { expiresIn: 30 * DAY });
// Tokens signed before sign-ins expired have no expiry, only the time they were issued.
const oldToken = (age) => jwt.sign({ user, iat: now() - age }, SECRET);
const answeredFor = (id) => ({ signedInAs: id, extensions: undefined });
const toldSignedOut = { signedInAs: null, extensions: { signInTokenRejected: true } };
for (const NODE_ENV of [undefined, 'production']) {
  const middleware = [];
  await load(
    '../src/graphql-api/index.js',
    {
      '@as-integrations/koa': {
        koaMiddleware: (server, options) => {
          middleware.push({ server, options });
          return async () => {};
        }
      },
      './typedefs.js': { default: 'type Query { signedInAs: String }' },
      './resolvers.js': {
        default: { Query: { signedInAs: (parent, args, context) => context.user?.id ?? null } }
      },
      './core/index.js': { directives: {} }
    },
    { process: { env: { NODE_ENV } } }
  );
  assert.strictEqual(middleware.length, 1);
  const [{ server, options }] = middleware;

  // Send a request with this JWT header as the Koa integration does, which gives the context
  // function Koa's context.
  async function request(token) {
    const ctx = { get: (header) => (header === 'JWT' ? token : '') };
    const contextValue = await options.context({ ctx });
    const response = await server.executeOperation({ query: '{ signedInAs }' }, { contextValue });
    assert.strictEqual(response.body.kind, 'single');
    const { data, errors, extensions } = response.body.singleResult;
    assert.strictEqual(errors, undefined);
    // The extensions come from the module's own context, so copy them before comparing.
    return { signedInAs: data.signedInAs, extensions: extensions && { ...extensions } };
  }
  const where = `with NODE_ENV ${NODE_ENV}`;
  for (const valid of [token, oldToken(DAY)])
    assert.deepStrictEqual(await request(valid), answeredFor(user.id), where);
  for (const refused of [expired, oldToken(31 * DAY)])
    assert.deepStrictEqual(await request(refused), toldSignedOut, where);
  // No token, or the "null" the client sends when signed out, is simply signed out.
  for (const value of ['', 'null'])
    assert.deepStrictEqual(await request(value), answeredFor(null), where);
  await server.stop();
}

console.log(
  'Sign-in wiring checks passed: tokens from the sign-in route, and the GraphQL API refusing old ones.'
);
