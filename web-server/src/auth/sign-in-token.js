import jwt from 'jsonwebtoken';

import { JWT_AUTH, SIGN_IN_TOKEN_LIFETIME } from 'scbl-lib/config';

// Sign with the algorithm tokens are verified with, in case JWT_AUTH_ALGORITHM is changed. Tokens
// expire SIGN_IN_TOKEN_LIFETIME after they are issued.
export function createSignInToken(user) {
  return jwt.sign({ user }, JWT_AUTH.SECRET, {
    algorithm: JWT_AUTH.ALGORITHM,
    expiresIn: SIGN_IN_TOKEN_LIFETIME
  });
}

// The user a sign-in token signs in, or null without a valid token. Tokens signed before sign-ins
// expired have no expiry, so any token older than SIGN_IN_TOKEN_LIFETIME is refused as well.
// `rejected` says whether there was a token that is not accepted, e.g. as it has expired, rather
// than none: no header, or the "null" the client sends when signed out.
export function checkSignInToken(token) {
  try {
    const { user } = jwt.verify(token, JWT_AUTH.SECRET, {
      algorithms: [JWT_AUTH.ALGORITHM],
      maxAge: SIGN_IN_TOKEN_LIFETIME
    });
    return { user, rejected: false };
  } catch {
    return { user: null, rejected: isToken(token) };
  }
}

// Whether a value is a JSON web token at all, valid or not.
function isToken(value) {
  try {
    return jwt.decode(value) !== null;
  } catch {
    // A token whose header says it is a JWT but whose payload is not JSON.
    return false;
  }
}
