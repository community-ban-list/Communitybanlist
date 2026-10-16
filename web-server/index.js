import { JWT_AUTH } from 'scbl-lib/config';
import { connect } from 'scbl-lib/db';
import { describeError, stackTrace } from 'scbl-lib/utils';

import server from './src/app.js';
import limitOpenIDRequests from './src/auth/openid-request-timeout.js';
import checkJwtSecret from './src/jwt-secret.js';

const PORT = process.env.PORT || 80;

// Keep serving if a promise fails with nothing to handle it. Only the error's name, message and
// where it was thrown are printed, as errors from API clients also hold their keys.
process.on('unhandledRejection', (reason) =>
  console.error(`Unhandled promise rejection: ${describeError(reason)}${stackTrace(reason)}`)
);

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

connect()
  .then(() => {
    server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
  })
  .catch(console.log);
