import Router from '@koa/router';

import passport from './passport.js';
import { createSignInToken } from './sign-in-token.js';

const router = new Router();

router.get('/steam', passport.authenticate('steam'));

router.get('/steam/return', passport.authenticate('steam', { session: false }), (ctx) => {
  ctx.body = JSON.stringify({ token: createSignInToken(ctx.req.user) });
});

export default router;
