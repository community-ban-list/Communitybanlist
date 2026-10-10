// Docker health check: exits successfully only if the running server can reach the database.
import http from 'http';

const PORT = process.env.PORT || 80;
const REQUEST_TIMEOUT = 8000;

const request = http.get(
  { host: '127.0.0.1', port: PORT, path: '/health-check', timeout: REQUEST_TIMEOUT },
  (res) => {
    res.resume();
    res.on('end', () => {
      console.log(`Health check returned ${res.statusCode}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  }
);

request.on('timeout', () => request.destroy(new Error('timed out')));
request.on('error', (err) => {
  console.log(`Could not reach the web server: ${err.message}`);
  process.exit(1);
});
