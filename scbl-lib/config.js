// Web
const HOST = process.env.HOST || 'http://localhost';
const LOCALSTORAGE_VERSION = 'v1.3.4'; // Change this to wipe clients local storage

// Signs the web server's sign-in tokens. There is no default, as anyone who knows the secret can
// sign in as anyone; the web server refuses to start without one.
const JWT_AUTH = {
  ALGORITHM: process.env.JWT_AUTH_ALGORITHM || 'HS256',
  SECRET: process.env.JWT_AUTH_SECRET
};

// APIs
const BATTLEMETRICS_API_KEY = process.env.BATTLEMETRICS_API_KEY;
const BATTLEMETRICS_API_RESERVIOR = process.env.BATTLEMETRICS_API_RESERVIOR || 10;

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
  BATTLEMETRICS_API_RESERVIOR,
  BATTLEMETRICS_ORGANIZATION,
  STEAM_API_KEY,
  LOCALSTORAGE_VERSION,
  JWT_AUTH,
  DISCORD_INVITE,
  INTAKE_FORM
};
