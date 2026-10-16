import { ApolloLink } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';

import Auth from './auth.js';
import signOutLink from './sign-out-link.js';

// Send the sign-in token with every request, in the JWT header.
const authLink = new SetContextLink(({ headers }) => {
  return { headers: { ...headers, JWT: Auth.jwtToken } };
});

// The links every GraphQL request goes through, ending with the one that sends it to the web
// server. The sign-out link comes first, so each answer reaches it after the other links, just
// before the page.
export default function createLink(terminatingLink) {
  return ApolloLink.from([signOutLink, authLink, terminatingLink]);
}
