import { CombinedGraphQLErrors, LinkError } from '@apollo/client';

// What the user is told when a request got no answer from the web server, e.g. as the connection
// dropped or the server was restarting, in place of the browser's own message. A change may still
// have been made then, as only its answer may have been lost. Every change the site makes is to the
// user's export ban lists.
export const CHANGE_NOT_REACHED =
  'The server could not be reached, so this may not have worked. Check your export ban lists before trying again.';
export const LOAD_NOT_REACHED =
  'The server could not be reached. Check your connection and try again.';

// The errors to show for a failed change, like Apollo Client 3's error.graphQLErrors: the GraphQL
// errors the web server answered with, as they say what was wrong, or else one saying why, so the
// error box is never empty.
export default function graphQLErrors(error) {
  if (!error) return [];
  if (CombinedGraphQLErrors.is(error)) return error.errors;
  return [LinkError.is(error) ? { message: CHANGE_NOT_REACHED } : error];
}

// What to tell the user when something could not be loaded: the web server's messages, each once,
// as several parts of an answer can fail for the same reason.
export function loadErrorMessages(error) {
  if (LinkError.is(error)) return [LOAD_NOT_REACHED];
  const errors = CombinedGraphQLErrors.is(error) ? error.errors : [error];
  return [...new Set(errors.map(({ message }) => message))];
}
