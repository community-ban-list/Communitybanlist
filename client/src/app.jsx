import React, { useState, useEffect } from 'react';

import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { relayStylePagination } from '@apollo/client/utilities';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router';

import ErrorBoundary from './components/ErrorBoundary/index.jsx';
import createLink from './utils/apollo-link.js';
import Auth from './utils/auth';

import publicRoutes from './views';
import PageError from './views/pages/page-error.jsx';

const client = new ApolloClient({
  link: createLink(new HttpLink({ uri: '/graphql' })),
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
      // A query that fails gives the page its error, which the page shows with a way to try again.
      // So does one that fails only in part, rather than giving the part of the answer that
      // arrived: the parts that failed would come as nothing, which the pages would show as a
      // player not on record, a list with nothing in it, or bans missing.
      errorPolicy: 'none',
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

// A page that fails to render is replaced by a message, rather than the whole site going blank,
// until the user goes to another address.
function PageErrorBoundary(props) {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location} fallback={<PageError />}>
      {props.children}
    </ErrorBoundary>
  );
}

export default function () {
  const [initialSetup, setInitialSetup] = useState(false);

  useEffect(() => {
    Auth.restoreAuth();
    setInitialSetup(true);
  }, []);

  return initialSetup ? (
    <ApolloProvider client={client}>
      <BrowserRouter>
        <PageErrorBoundary>
          <Routes>
            {publicRoutes}
            {/* Unmatched paths render nothing, as with React Router 5, without a console warning. */}
            <Route path="*" element={null} />
          </Routes>
        </PageErrorBoundary>
      </BrowserRouter>
    </ApolloProvider>
  ) : null;
}
