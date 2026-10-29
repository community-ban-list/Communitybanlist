import assert from 'assert';
import http from 'http';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloServer from '@apollo/server';
import * as apolloServerErrors from '@apollo/server/errors';
import * as apolloServerDisabledPlugins from '@apollo/server/plugin/disabled';
import * as graphqlToolsSchema from '@graphql-tools/schema';
import graphql from 'graphql';
import jwt from 'jsonwebtoken';
import Koa from 'koa';

// The GraphQL API is loaded from the file the web server runs, with stubs for Koa, the schema and
// the database. @apollo/server is the real package, but ApolloServer is a subclass that records the
// options it is built with, so the checks can read them back.
const builds = [];
class RecordingApolloServer extends apolloServer.ApolloServer {
  constructor(options) {
    super(options);
    builds.push({ options, server: this });
  }
}

const packages = {
  '@apollo/server': { ...apolloServer, ApolloServer: RecordingApolloServer },
  '@apollo/server/errors': apolloServerErrors,
  '@apollo/server/plugin/disabled': apolloServerDisabledPlugins,
  '@graphql-tools/schema': graphqlToolsSchema,
  graphql: { default: graphql },
  jsonwebtoken: { default: jwt },
  // These are only read when signing a request in, which these checks do not do. Both the current
  // and the sign-in-token values are supplied, so the API loads whichever way it reads them.
  'scbl-lib/config': {
    JWT_AUTH: { ALGORITHM: 'HS256', SECRET: 'a-secret-only-these-checks-use' },
    SIGN_IN_TOKEN_LIFETIME: 30 * 24 * 60 * 60
  },
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

// Load a module with these stubs as well as the packages above, in a context with these globals.
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

// A small schema whose fields are cheap to resolve, so the checks are about how requests are read
// rather than what they return.
await load(
  '../src/graphql-api/index.js',
  {
    '@as-integrations/koa': { koaMiddleware: () => async () => {} },
    './typedefs.js': {
      default: 'type Query { hello: String greeting: Greeting } type Greeting { hello: String }'
    },
    './resolvers.js': {
      default: { Query: { hello: () => 'world', greeting: () => ({ hello: 'world' }) } }
    },
    './core/index.js': { directives: {} }
  },
  { process: { env: { NODE_ENV: undefined } }, console }
);
assert.strictEqual(builds.length, 1);
const { options, server } = builds[0];

// The server is built to handle each request on its own and to keep each request small.
assert.strictEqual(options.documentStore, null, 'documents are not cached between requests');
assert.strictEqual(options.persistedQueries, false, 'persisted queries are off');
assert.strictEqual(options.parseOptions.maxTokens, 2000, 'requests are parsed up to a token limit');

// Run an operation against the built server and return its single result.
async function run(request) {
  const response = await server.executeOperation(request, { contextValue: {} });
  assert.strictEqual(response.body.kind, 'single');
  return response.body.singleResult;
}
const codeOf = (result) => result.errors?.[0]?.extensions?.code;

// A request the size of the site's largest (here 39 fields, 119 tokens) is answered. Like the
// site's requests, it asks for one field at its top level, with the other 38 inside it.
const fields = (count) =>
  `{ greeting {\n${Array.from({ length: count }, (_, i) => `f${i}: hello`).join('\n')}\n} }`;
const small = await run({ query: fields(38) });
assert.strictEqual(small.errors, undefined, 'a client-sized request is answered');
assert.strictEqual(small.data.greeting.f0, 'world');

// A request far larger than any the client sends is refused while it is still being read, and the
// answer says why.
const huge = await run({ query: fields(3000) });
assert.strictEqual(codeOf(huge), 'GRAPHQL_PARSE_FAILED');
assert.match(huge.errors[0].message, /2000 tokens/);

// The client does not use persisted queries, so a request that asks for one is refused rather than
// looked up or stored.
const persisted = await run({
  extensions: { persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) } }
});
assert.strictEqual(codeOf(persisted), 'PERSISTED_QUERY_NOT_SUPPORTED');

await server.stop();

// The body parser reads only the JSON bodies the client sends: sent as-is, and within the size
// limit. Mount it on a small app that keeps the body it hands on for the checks below, and answers
// with a fixed word rather than sending the body back.
const { default: bodyParser } = await import('../src/body-parser.js');
const app = new Koa();
app.use(bodyParser);
let received;
app.use((ctx) => {
  received = ctx.request.body;
  ctx.body = 'read';
});
const httpServer = http.createServer(app.callback());
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const { port } = httpServer.address();
async function post(body, headers = {}) {
  received = undefined;
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  });
  return { status: response.status, text: await response.text() };
}

// A request the size of the client's is parsed and handed on.
const parsed = await post(JSON.stringify({ query: '{ hello }', padding: 'x'.repeat(2000) }));
assert.strictEqual(parsed.status, 200);
assert.strictEqual(received?.query, '{ hello }');

// A request far larger than the client's is refused. The parser answers any body it cannot read
// with 422 and logs it, as it does today, so quiet that one expected line to keep this check's
// output clean.
const log = console.log;
console.log = () => {};
const large = await post(JSON.stringify({ padding: 'x'.repeat(150 * 1024) }));
console.log = log;
assert.strictEqual(large.status, 422);

// A body sent as-is is read however "identity" is written, and one that is not sent as-is is
// refused before it is read.
for (const encoding of ['identity', 'IDENTITY']) {
  const plain = await post(JSON.stringify({ query: '{ hello }' }), {
    'content-encoding': encoding
  });
  assert.strictEqual(plain.status, 200, `a body sent with Content-Encoding ${encoding} is read`);
  assert.strictEqual(received?.query, '{ hello }');
}
const encoded = await post('{}', { 'content-encoding': 'gzip' });
assert.strictEqual(encoded.status, 415);

httpServer.close();

console.log(
  'GraphQL memory limit checks passed: per-request parsing, token and body-size limits, and encoding.'
);
