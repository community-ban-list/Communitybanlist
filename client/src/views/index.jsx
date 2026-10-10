import React from 'react';
import { Navigate, Route } from 'react-router';

import routes from './routes.js';

import Auth from '../utils/auth';

// Checked on each render, after the stored login has been restored.
function RouteElement({ component: Component, login }) {
  return login && !Auth.isLoggedIn ? <Navigate to="/login" replace /> : <Component />;
}

// Routes without exact: true matched as prefixes in React Router 5, so they keep matching deeper
// paths.
export default routes.map(({ component, ...route }, key) => (
  <Route
    path={route.exact ? route.path : `${route.path}/*`}
    element={<RouteElement component={component} login={route.login} />}
    key={key}
  />
));
