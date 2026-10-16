import Router from '@koa/router';

import { checkSteamAnswer, startSteamSignIn } from './steam-sign-in-guard.js';
import passport from './passport.js';
import { createSignInToken } from './sign-in-token.js';

const router = new Router();

// Keep the sign-in routes pointed at Steam, and answer promptly, before Passport runs on them.
router.get('/steam', startSteamSignIn);
router.get('/steam/return', checkSteamAnswer);

router.get('/steam', passport.authenticate('steam'));

router.get('/steam/return', passport.authenticate('steam', { session: false }), (ctx) => {
  ctx.body = JSON.stringify({ token: createSignInToken(ctx.req.user) });
});

export default router;
