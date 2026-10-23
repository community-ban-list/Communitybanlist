// Docker health check of the importer service: exits successfully only if the service reports it
// is healthy. The status it prints is shown by `docker inspect`. Only the importer in loop mode
// answers, so the compose service defines the check, and runs in once mode have none.
import http from 'http';

import { HEALTH_CHECK_PORT } from './src/health-check-server.js';

const REQUEST_TIMEOUT = 8000;

const request = http.get(
  { host: '127.0.0.1', port: HEALTH_CHECK_PORT, timeout: REQUEST_TIMEOUT },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log(body);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  }
);

request.on('timeout', () => request.destroy(new Error('timed out')));
request.on('error', (err) => {
  console.log(`Could not reach the importer service: ${err.message}`);
  process.exit(1);
});
