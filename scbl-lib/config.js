// Web
const HOST = process.env.HOST || 'http://localhost';
const LOCALSTORAGE_VERSION = 'v1.3.4'; // Change this to wipe clients local storage

// Signs the web server's sign-in tokens. There is no default, as anyone who knows the secret can
// sign in as anyone; the web server refuses to start without one.
const JWT_AUTH = {
  ALGORITHM: process.env.JWT_AUTH_ALGORITHM || 'HS256',
  SECRET: process.env.JWT_AUTH_SECRET
};

// How long a sign-in token works for, in seconds: 30 days. The web server stops accepting a token
// this long after it was issued, and the client then shows the user as signed out.
const SIGN_IN_TOKEN_LIFETIME = 30 * 24 * 60 * 60;

// APIs
const BATTLEMETRICS_API_KEY = process.env.BATTLEMETRICS_API_KEY;
// How many BattleMetrics requests a minute this service may make, and the variable it came from.
// scbl-lib/apis/battlemetrics.js checks it and uses a default when it is unset.
// BATTLEMETRICS_API_RESERVIOR is the old, misspelt name, still read so existing setups keep their
// budget.
const BATTLEMETRICS_API_RESERVOIR_VARIABLE = process.env.BATTLEMETRICS_API_RESERVOIR
  ? 'BATTLEMETRICS_API_RESERVOIR'
  : process.env.BATTLEMETRICS_API_RESERVIOR
    ? 'BATTLEMETRICS_API_RESERVIOR'
    : undefined;
const BATTLEMETRICS_API_RESERVOIR =
  BATTLEMETRICS_API_RESERVOIR_VARIABLE && process.env[BATTLEMETRICS_API_RESERVOIR_VARIABLE];

const BATTLEMETRICS_ORGANIZATION = process.env.BATTLEMETRICS_ORGANIZATION || '56746';

const STEAM_API_KEY = process.env.STEAM_API_KEY;

// Links shown by the client. It is built before the web server runs, so in the browser they come from
// /config.js, which the web server fills in from these environment variables. If one is not set,
// its links do nothing when clicked, and the web server warns about it when it starts.
const CLIENT_CONFIG = globalThis.CBL_CONFIG || {};

const DISCORD_INVITE = CLIENT_CONFIG.DISCORD_INVITE || process.env.DISCORD_INVITE;

// Form for communities applying to become partner organisations.
const INTAKE_FORM = CLIENT_CONFIG.INTAKE_FORM || process.env.INTAKE_FORM;

export {
  HOST,
  BATTLEMETRICS_API_KEY,
  BATTLEMETRICS_API_RESERVOIR,
  BATTLEMETRICS_API_RESERVOIR_VARIABLE,
  BATTLEMETRICS_ORGANIZATION,
  STEAM_API_KEY,
  LOCALSTORAGE_VERSION,
  JWT_AUTH,
  SIGN_IN_TOKEN_LIFETIME,
  DISCORD_INVITE,
  INTAKE_FORM
};
