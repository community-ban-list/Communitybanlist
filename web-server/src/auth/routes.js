import Router from '@koa/router';
import jwt from 'jsonwebtoken';

import { JWT_AUTH } from 'scbl-lib/config';

import passport from './passport.js';

const router = new Router();

router.get('/steam', passport.authenticate('steam'));

router.get('/steam/return', passport.authenticate('steam', { session: false }), (ctx) => {
  ctx.body = JSON.stringify({
    // Sign with the algorithm the GraphQL API verifies with, in case JWT_AUTH_ALGORITHM is changed.
    token: jwt.sign({ user: ctx.req.user }, JWT_AUTH.SECRET, { algorithm: JWT_AUTH.ALGORITHM })
  });
});

export default router;
