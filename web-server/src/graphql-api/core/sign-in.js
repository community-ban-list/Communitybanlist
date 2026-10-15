import { checkSignInToken } from '../../auth/sign-in-token.js';

// Each request is answered for the user its sign-in token, in the JWT header, signs in, or as
// signed out without a valid token.
export async function signInContext({ ctx }) {
  const { user, rejected } = checkSignInToken(ctx.get('JWT'));
  return { user, signInTokenRejected: rejected };
}

// A request whose sign-in token is no longer accepted, e.g. as it has expired, is answered as
// signed out. Say so in the response, so the client shows the user as signed out instead of
// looking signed in while none of its requests are.
export const reportRejectedSignInTokens = {
  async requestDidStart({ contextValue }) {
    if (!contextValue.signInTokenRejected) return;
    return {
      async willSendResponse({ response }) {
        if (response.body.kind !== 'single') return;
        response.body.singleResult.extensions = {
          ...response.body.singleResult.extensions,
          signInTokenRejected: true
        };
      }
    };
  }
};
