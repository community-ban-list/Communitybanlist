import { createRequire } from 'module';

// The OpenID library checks each Steam sign-in with Steam over axios, and sets no time limit on
// those requests. The sign-in routes answer the visitor after their own deadline (see
// steam-sign-in-guard.js), but a request Steam never answers would stay open. This gives the
// library's requests a time limit of their own.

// How long one of the library's requests may take. When Steam answers, a sign-in makes one request
// to start and two on its return. When a request fails, the library tries two other ways of
// finding Steam's endpoint, so a route can make three in a row. The sign-in routes answer the
// visitor after 15 seconds whatever happens. Held on an object so the tests can shorten it.
export const openIDRequestTimeout = { milliseconds: 10 * 1000 };

// Give a request any part of a time limit it lacks: a signal that ends it once the time is up, and
// a timeout, which ends it if it brings a signal of its own.
export function addTimeLimit(config) {
  if (!config.timeout) config.timeout = openIDRequestTimeout.milliseconds;
  if (!config.signal) config.signal = AbortSignal.timeout(openIDRequestTimeout.milliseconds);
  return config;
}

// The axios the OpenID library loads. It loads axios with require, which gives a different copy
// from the one `import` gives, so find it the way the library does, through the packages that bring
// it in. Only packages that load axios with require share this copy, so the web server's own
// requests, to BattleMetrics and Discord, keep their own limits.
export function openIDAxios() {
  const fromWebServer = createRequire(import.meta.url);
  const fromPassportSteam = createRequire(fromWebServer.resolve('passport-steam'));
  const fromPassportOpenID = createRequire(
    fromPassportSteam.resolve('@passport-next/passport-openid')
  );
  const fromOpenID = createRequire(fromPassportOpenID.resolve('openid'));
  return fromOpenID('axios').default;
}

// Give the OpenID library's requests a time limit. Call it once, when the web server starts.
export default function limitOpenIDRequests() {
  openIDAxios().interceptors.request.use(addTimeLimit);
}
