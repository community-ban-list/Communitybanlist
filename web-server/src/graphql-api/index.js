import ApolloServerKoa from 'apollo-server-koa';
import jwt from 'jsonwebtoken';

import { JWT_AUTH } from 'scbl-lib/config';

import typeDefs from './typedefs.js';
import resolvers from './resolvers.js';
import { directives as schemaDirectives } from './core/index.js';

const { ApolloServer, makeExecutableSchema } = ApolloServerKoa;

const schema = makeExecutableSchema({ typeDefs, resolvers, schemaDirectives });

export default new ApolloServer({
  schema,
  context: async ({ ctx }) => {
    const startTime = Date.now();
    const checkTimeout = () => {
      const currentTime = Date.now();
      if (currentTime - startTime > 5000) {
        // 3 seconds
        throw new Error('Operation took too long!');
      }
    };
    try {
      return {
        user: jwt.verify(ctx.get('JWT'), JWT_AUTH.SECRET, { algorithms: [JWT_AUTH.ALGORITHM] })
          .user,
        checkTimeout
      };
    } catch (err) {
      return { user: null, checkTimeout };
    }
  }
});
