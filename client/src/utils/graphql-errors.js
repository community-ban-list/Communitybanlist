import { CombinedGraphQLErrors } from '@apollo/client/errors';

// The GraphQL errors in an Apollo Client error, or none for a network error, like Apollo Client 3's
// error.graphQLErrors.
export default function graphQLErrors(error) {
  return CombinedGraphQLErrors.is(error) ? error.errors : [];
}
