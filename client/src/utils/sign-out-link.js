import { ApolloLink } from '@apollo/client';
import { mergeMap, NEVER, of } from 'rxjs';

import Auth from './auth.js';

// The web server answers as signed out, and says so, once it no longer accepts the sign-in token,
// e.g. as it has expired. Forget the token and reload then, so every page shows the user as signed
// out and the pages that need signing in ask for it again. Answers are held back until the page
// has reloaded, so it does not show the signed-out answers or their errors in the meantime.
let reloading = false;

export default new ApolloLink((operation, forward) =>
  forward(operation).pipe(
    mergeMap((result) => {
      if (result.extensions?.signInTokenRejected && Auth.forgetRejectedToken()) {
        reloading = true;
        window.location.reload();
      }
      return reloading ? NEVER : of(result);
    })
  )
);
