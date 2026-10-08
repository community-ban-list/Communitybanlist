import React, { useState, useEffect } from 'react';

import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';
import { SetContextLink } from '@apollo/client/link/context';
import { ApolloProvider } from '@apollo/client/react';
import { relayStylePagination } from '@apollo/client/utilities';
import { BrowserRouter, Route, Routes } from 'react-router';

import Auth from './utils/auth';

import publicRoutes from './views';

const httpLink = new HttpLink({ uri: '/graphql' });

const authLink = new SetContextLink(({ headers }) => {
  return { headers: { ...headers, JWT: Auth.jwtToken } };
});

const client = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          bans: relayStylePagination(['orderBy', 'orderDirection']),
          steamUsers: relayStylePagination(['orderBy', 'orderDirection'])
        }
      }
    }
  }),
  defaultOptions: {
    watchQuery: {
      fetchPolicy: 'cache-and-network',
      errorPolicy: 'ignore',
      // Apollo Client 4 defaults this to true, which would show loading states while Load more runs.
      notifyOnNetworkStatusChange: false
    },
    query: {
      fetchPolicy: 'network-only',
      errorPolicy: 'all'
    },
    mutate: {
      errorPolicy: 'all'
    }
  }
});

export default function () {
  const [initialSetup, setInitialSetup] = useState(false);

  useEffect(() => {
    Auth.restoreAuth();
    setInitialSetup(true);
  }, []);

  return initialSetup ? (
    <ApolloProvider client={client}>
      <BrowserRouter>
        <Routes>
          {publicRoutes}
          {/* Unmatched paths render nothing, as with React Router 5, without a console warning. */}
          <Route path="*" element={null} />
        </Routes>
      </BrowserRouter>
    </ApolloProvider>
  ) : null;
}
