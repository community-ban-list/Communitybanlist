import { DISCORD_INVITE, EXPORT_LIST_LIMITS, INTAKE_FORM } from 'scbl-lib/config';

// The body of /config.js. The client is built before the web server runs, so it loads the settings
// that can be set with environment variables from here: the links it shows, and the limits on
// export ban lists, which its forms check changes against as the web server does. In the browser,
// scbl-lib/config.js reads them from window.CBL_CONFIG. Only add settings that are safe to make
// public.
export default `window.CBL_CONFIG = ${JSON.stringify({
  DISCORD_INVITE,
  INTAKE_FORM,
  EXPORT_LIST_LIMITS
})};\n`;
