import { ApolloLink } from '@apollo/client';
import { OperationTypeNode } from 'graphql';
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
        // A change the user made, e.g. saving an export ban list, was refused, as every change
        // needs signing in. Its answer is held back too, and the page that reloads would not say
        // the change failed, so say so first.
        if (operation.operationType === OperationTypeNode.MUTATION)
          window.alert(
            'Your sign-in has expired, so nothing was changed. Please sign in and try again.'
          );
        window.location.reload();
      }
      return reloading ? NEVER : of(result);
    })
  )
);
