// Whether the web server runs in production mode, as it does for the live site: it serves the
// built site, with its Content Security Policy. That is only when NODE_ENV is exactly production,
// the value Apollo Server checks for too. The image sets it (web-server/Dockerfile).
//
// This file has no imports, so it can be loaded on its own.
export const inProduction = process.env.NODE_ENV === 'production';

// Whether the web server runs for development, as yarn dev-web-server runs it: NODE_ENV is
// development or test, or is not set. Only then does its GraphQL API show its schema, for Apollo
// Sandbox. With any other value it keeps the schema to itself, as in production, so a mistake in
// NODE_ENV cannot show it.
export const inDevelopment = [undefined, 'development', 'test'].includes(process.env.NODE_ENV);

// Any other value, such as prod or Production, is a mistake, which app.js warns about when it
// starts, as the site's pages are then not served.
export const nodeEnvProblem =
  inProduction || inDevelopment
    ? null
    : `NODE_ENV is ${JSON.stringify(process.env.NODE_ENV)}, not production, development or test, so the web server does not serve the site's pages. Set NODE_ENV to production for the live site.`;
