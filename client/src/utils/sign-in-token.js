import { jwtDecode } from 'jwt-decode';

import { SIGN_IN_TOKEN_LIFETIME } from 'scbl-lib/config';

// The user a sign-in token signs in and when it stops working, in milliseconds, or null if it
// cannot be read. Only the web server can tell whether a token is genuine, so this only tells
// whether a stored token is still worth using.
export default function readSignInToken(token) {
  let claims;
  try {
    claims = jwtDecode(token);
  } catch {
    return null;
  }
  if (!claims?.user || typeof claims.iat !== 'number') return null;

  // The web server refuses a token once it has expired, and once it is older than the lifetime,
  // which also covers tokens signed before sign-ins expired.
  let expires = claims.iat + SIGN_IN_TOKEN_LIFETIME;
  if (claims.exp !== undefined) {
    if (typeof claims.exp !== 'number') return null;
    expires = Math.min(expires, claims.exp);
  }
  return { user: claims.user, expires: expires * 1000 };
}
