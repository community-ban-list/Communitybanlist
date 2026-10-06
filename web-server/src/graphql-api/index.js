import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { koaMiddleware } from '@as-integrations/koa';
import { makeExecutableSchema } from '@graphql-tools/schema';
import jwt from 'jsonwebtoken';

import { JWT_AUTH } from 'scbl-lib/config';

import typeDefs from './typedefs.js';
import resolvers from './resolvers.js';
import { directives } from './core/index.js';

const schema = Object.values(directives).reduce(
  (schema, directive) => directive(schema),
  makeExecutableSchema({ typeDefs, resolvers })
);

const server = new ApolloServer({
  schema,
  // Apollo Server 2 had no landing page in production, so GET /graphql without a query is still an
  // error there rather than a page that loads Apollo's scripts.
  plugins: process.env.NODE_ENV === 'production' ? [ApolloServerPluginLandingPageDisabled()] : []
});

await server.start();

const middleware = koaMiddleware(server, {
  context: async ({ ctx }) => {
    try {
      return {
        user: jwt.verify(ctx.get('JWT'), JWT_AUTH.SECRET, { algorithms: [JWT_AUTH.ALGORITHM] }).user
      };
    } catch (err) {
      return { user: null };
    }
  }
});

// Answer requests to /graphql and stop there, as Apollo Server 2 did, so later middleware such as
// the client's catch-all route cannot replace the response.
export default async function (ctx, next) {
  if (ctx.path !== '/graphql') return next();
  await middleware(ctx, async () => {});
}
