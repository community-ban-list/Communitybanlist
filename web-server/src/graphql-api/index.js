import { ApolloServer } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { koaMiddleware } from '@as-integrations/koa';
import { makeExecutableSchema } from '@graphql-tools/schema';

import { DATABASE_UNAVAILABLE_MESSAGE, isDatabaseUnavailable } from 'scbl-lib/db/sequelize';

import typeDefs from './typedefs.js';
import resolvers from './resolvers.js';
import { directives } from './core/index.js';
import { reportRejectedSignInTokens, signInContext } from './core/sign-in.js';

const schema = Object.values(directives).reduce(
  (schema, directive) => directive(schema),
  makeExecutableSchema({ typeDefs, resolvers })
);

const server = new ApolloServer({
  schema,
  // The client sends a small, fixed set of queries and never uses persisted queries. Handle each
  // request on its own rather than keeping a growing store of past documents, turn off the
  // persisted-query support the client does not use, and stop reading a request once it is far
  // larger than any the client sends (the client's largest is about 135 tokens).
  documentStore: null,
  persistedQueries: false,
  parseOptions: { maxTokens: 2000 },
  // While the database cannot be reached, e.g. as it restarts, show a general message rather than
  // the database's own error.
  formatError: (formattedError, error) =>
    isDatabaseUnavailable(unwrapResolverError(error))
      ? { ...formattedError, message: DATABASE_UNAVAILABLE_MESSAGE }
      : formattedError,
  plugins: [
    reportRejectedSignInTokens,
    // Apollo Server 2 had no landing page in production, so GET /graphql without a query is still
    // an error there rather than a page that loads Apollo's scripts.
    ...(process.env.NODE_ENV === 'production' ? [ApolloServerPluginLandingPageDisabled()] : [])
  ]
});

await server.start();

const middleware = koaMiddleware(server, { context: signInContext });

// Answer requests to /graphql and stop there, as Apollo Server 2 did, so later middleware such as
// the client's catch-all route cannot replace the response.
export default async function (ctx, next) {
  if (ctx.path !== '/graphql') return next();
  await middleware(ctx, async () => {});
}
