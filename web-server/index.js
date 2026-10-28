import { JWT_AUTH } from 'scbl-lib/config';
import { connect, recordLogMessages } from 'scbl-lib/db';
import { describeError, stackTrace } from 'scbl-lib/utils';

import server from './src/app.js';
import limitOpenIDRequests from './src/auth/openid-request-timeout.js';
import checkJwtSecret from './src/jwt-secret.js';
import stopOnSignals from './src/shutdown.js';

const PORT = process.env.PORT || 80;

// A proxy in front of the web server can keep an idle connection to it open for a minute or more,
// and send a request on it at any time. A request sent on a connection just as the server closes it
// fails, so keep idle connections open for longer than the proxy does, rather than Node's default
// of about 6 seconds: Node closes one a second after keepAliveTimeout. It also closes a new
// connection that has sent no request within headersTimeout, so that is as long.
const KEEP_ALIVE_TIMEOUT = 65 * 1000;
const HEADERS_TIMEOUT = 66 * 1000;

// Keep serving if a promise fails with nothing to handle it. Only the error's name, message and
// where it was thrown are printed, as errors from API clients also hold their keys.
process.on('unhandledRejection', (reason) =>
  console.error(`Unhandled promise rejection: ${describeError(reason)}${stackTrace(reason)}`)
);

// The newest message the web server posts to the log channel is kept in the database, so the
// importer service can keep its status message below it. It never holds up or fails a request.
recordLogMessages('web');

// Anyone who knows the secret that signs sign-in tokens can sign in as anyone, so refuse to start
// without a private one.
const jwtSecretProblem = checkJwtSecret(JWT_AUTH.SECRET);
if (jwtSecretProblem?.fatal) {
  console.error(
    `The web server cannot start: ${jwtSecretProblem.message} Set it to a long random value, e.g. from \`openssl rand -base64 48\`.`
  );
  process.exit(1);
}
if (jwtSecretProblem) console.warn(`Warning: ${jwtSecretProblem.message}`);

// Steam sign-ins are checked with Steam by the OpenID library, which sets no time limit itself.
limitOpenIDRequests();

// On SIGTERM, which docker stop sends, or SIGINT, answer the requests under way and close the
// database before exiting (see src/shutdown.js).
const shutdown = stopOnSignals();

connect()
  .then(() => {
    // Say which port it really listens on, e.g. with PORT 0, or, for a PORT that is not a number,
    // the path of the socket it listens on.
    const httpServer = server.listen(PORT, () => {
      const address = httpServer.address();
      console.log(`Server started on port ${typeof address === 'string' ? address : address.port}`);
    });
    httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT;
    httpServer.headersTimeout = HEADERS_TIMEOUT;
    shutdown.setServer(httpServer);
  })
  .catch(console.log);
