import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { koaMiddleware } from '@as-integrations/koa';
import { makeExecutableSchema } from '@graphql-tools/schema';

import { inDevelopment } from '../production.js';
import typeDefs from './typedefs.js';
import resolvers from './resolvers.js';
import { queryCostRule } from './core/query-cost.js';
import { directives } from './core/index.js';
import formatError from './core/format-error.js';
import { reportRejectedSignInTokens, signInContext } from './core/sign-in.js';
import pausedBanLists from '../paused-ban-lists.js';

const schema = Object.values(directives).reduce(
  (schema, directive) => directive(schema),
  makeExecutableSchema({ typeDefs, resolvers })
);

const server = new ApolloServer({
  schema,
  // The web server stops Apollo Server itself, once it has answered the requests under way (see
  // shutdown.js). Apollo Server's own handling of SIGTERM and SIGINT would stop it at once, and then
  // send the signal again to end the process, which does not end a container's first process, as
  // the web server's is, so every GraphQL request would fail until Docker killed it.
  stopOnTerminationSignals: false,
  // The client sends a small, fixed set of queries and never uses persisted queries. Handle each
  // request on its own rather than keeping a growing store of past documents, turn off the
  // persisted-query support the client does not use, and stop reading a request once it is far
  // larger than any the client sends (the client's largest is about 135 tokens).
  documentStore: null,
  persistedQueries: false,
  parseOptions: { maxTokens: 2000 },
  // Refuse a request that asks for far more at once than any of the site's pages, before any of it
  // runs: one with more than 1,000 selections, counting a fragment's selections each time it is
  // spread, or one that queryCostRule finds too costly. Apollo Server counts the selections first,
  // so the cost is only worked out for requests of a sensible size.
  maxRecursiveSelections: 1000,
  validationRules: [queryCostRule(schema)],
  // Outside development the API keeps its schema to itself, as the site's own queries need nothing
  // more: it answers no introspection queries, and its errors for fields and arguments that do not
  // exist suggest none that do (core/format-error.js does the same for variables). That includes a
  // NODE_ENV the web server does not expect (production.js). Its errors never say where in the code
  // they came from.
  introspection: inDevelopment,
  hideSchemaDetailsFromClientErrors: !inDevelopment,
  includeStacktraceInErrorResponses: false,
  // The client is told what was wrong with a request the API refuses on purpose, and only that the
  // server had an error when anything else fails, such as a database query (core/format-error.js).
  formatError,
  plugins: [
    reportRejectedSignInTokens,
    // Apollo Server 2 had no landing page in production, so GET /graphql without a query is still
    // an error there rather than a page that loads Apollo's scripts.
    ...(inDevelopment ? [] : [ApolloServerPluginLandingPageDisabled()])
  ]
});

await server.start();

// Each request is answered for the user its sign-in token signs in, and with the ban lists paused
// as read at most seconds before (see paused-ban-lists.js).
async function context(args) {
  return { ...(await signInContext(args)), paused: await pausedBanLists() };
}

const middleware = koaMiddleware(server, { context });

// Answer requests to /graphql and stop there, as Apollo Server 2 did, so later middleware such as
// the client's catch-all route cannot replace the response.
export default async function (ctx, next) {
  if (ctx.path !== '/graphql') return next();
  await middleware(ctx, async () => {});
}

// Stop Apollo Server, as the web server stops, once it has answered the requests under way (see
// shutdown.js).
export function stopGraphQL() {
  return server.stop();
}
