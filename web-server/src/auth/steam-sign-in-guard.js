// Steam is the only sign-in provider, so these guards run before Passport on the two sign-in routes
// and keep the OpenID library pointed at Steam. The start route ignores anything the request says
// about which provider to use, and the return route is only accepted when it looks like a genuine
// Steam answer. Anything else is answered here, without asking Steam about it. This module imports
// nothing so the routes can register its middlewares directly.

// The sign-in answer carries a bearer token, so this keeps it out of any shared HTTP cache.
const NO_STORE = 'no-store';

// Steam's fixed OpenID values. A genuine positive answer always carries exactly these: the login
// endpoint, and a claimed identity that is a 17-digit Steam ID served over HTTPS.
const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_IDENTITY = /^https:\/\/steamcommunity\.com\/openid\/id\/[0-9]{17}$/;
const OPENID_2_NAMESPACE = 'http://specs.openid.net/auth/2.0';

// A Steam answer carries about ten OpenID fields. Capping the count keeps Koa and the OpenID library
// reading the same values and keeps each in-progress sign-in holding only a little state.
const MAX_ANSWER_FIELDS = 20;

// How long to wait for Steam before answering the visitor anyway, so a slow Steam never leaves a
// sign-in hanging. Held on an object so the tests can shorten it.
export const signInDeadline = { milliseconds: 15000 };

const SIGN_IN_FAILED_MESSAGE = 'Steam sign-in failed. Please try again.';
const SIGN_IN_TIMEOUT_MESSAGE = 'Steam did not answer in time. Please try again.';

const TIMED_OUT = Symbol('steam sign-in deadline');

// Start signing in with Steam. Drop anything the request tries to say about which provider to look
// up, so discovery can only reach Steam, then hand over to Passport.
export function startSteamSignIn(ctx, next) {
  ctx.set('Cache-Control', NO_STORE);
  ctx.querystring = '';
  ctx.request.body = {};
  return runWithinDeadline(ctx, next);
}

// Handle Steam's answer. A genuine answer, or the visitor cancelling at Steam, is passed to Passport;
// anything else is answered here without contacting Steam.
export function checkSteamAnswer(ctx, next) {
  ctx.set('Cache-Control', NO_STORE);

  // A cancelled sign-in has no answer to check; Passport turns it into a plain sign-in failure.
  if (ctx.query['openid.mode'] === 'cancel') return runWithinDeadline(ctx, next);

  if (looksLikeSteamAnswer(ctx.query)) return runWithinDeadline(ctx, next);

  ctx.status = 400;
  ctx.body = SIGN_IN_FAILED_MESSAGE;
}

// Whether the query is shaped like a genuine positive Steam answer. These are the same values
// Passport confirms after the fact, checked up front so the lookup Passport does can only go to Steam.
function looksLikeSteamAnswer(query) {
  const fields = Object.keys(query);
  if (fields.length > MAX_ANSWER_FIELDS) return false;
  // A repeated parameter arrives as an array, which Koa and the OpenID library would read differently.
  if (fields.some((field) => typeof query[field] !== 'string')) return false;

  if (query['openid.mode'] !== 'id_res') return false;
  if (query['openid.ns'] !== OPENID_2_NAMESPACE) return false;
  if (query['openid.op_endpoint'] !== STEAM_OP_ENDPOINT) return false;

  const claimedId = query['openid.claimed_id'];
  if (claimedId !== query['openid.identity']) return false;
  if (!STEAM_IDENTITY.test(claimedId)) return false;

  return isOpenID2Nonce(query['openid.response_nonce']);
}

// An OpenID 2.0 response nonce is a UTC timestamp followed by a short unique string. Requiring that
// shape, and keeping the unique part short, bounds what each sign-in holds while Steam is contacted.
function isOpenID2Nonce(nonce) {
  if (typeof nonce !== 'string') return false;
  const timestampEnd = nonce.indexOf('Z');
  if (timestampEnd === -1) return false;

  const timestamp = nonce.slice(0, timestampEnd + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(timestamp)) return false;
  if (Number.isNaN(Date.parse(timestamp))) return false;

  const unique = nonce.slice(timestampEnd + 1);
  return unique.length <= 255 && /^[\x20-\x7e]*$/.test(unique);
}

// Run the rest of the sign-in, but not for longer than the deadline: if Steam has not answered by
// then, answer the visitor now. The sign-in may still finish in the background, so its outcome is
// handled here too rather than being left to surface on its own.
function runWithinDeadline(ctx, next) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), signInDeadline.milliseconds);
  });

  const chain = next();
  // A late failure, after the deadline has already answered, is handled rather than left dangling.
  chain.catch(() => {});

  return Promise.race([chain, deadline]).then(
    (result) => {
      clearTimeout(timer);
      if (result === TIMED_OUT) {
        ctx.status = 504;
        ctx.body = SIGN_IN_TIMEOUT_MESSAGE;
      }
    },
    (error) => {
      clearTimeout(timer);
      throw error;
    }
  );
}
