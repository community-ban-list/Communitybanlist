import http from 'http';

// The importer service, in loop mode, says whether it is healthy on this port, for the Docker
// health check (see ../healthcheck.js). It only listens inside the container. A run in once mode
// starts no server.
export const HEALTH_CHECK_PORT = 3001;

// While the service waits for the database or the run lock, it is healthy for this long.
export const WAIT_LIMIT = 10 * 60 * 1000;

const minutes = (ms) => {
  const count = Math.floor(ms / 60000);
  return `${count} minute${count === 1 ? '' : 's'}`;
};
const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Whether the importer service is healthy, from what it is doing, now:
// - while it holds the service lock, as long as a cycle ended within window milliseconds, or,
//   before its first cycle ends, it took the lock within window;
// - while it waits for the database, or for another run to end, as another run holds the service
//   lock or the run lock, for its first 10 minutes of waiting;
// - not once it is stopping.
// health is what loop.js keeps: { stopping, lockedAt, cycles, cycle, lastCycle, waitingFor,
// waitingSince, window }, with times in milliseconds, where lastCycle is
// { cycle, outcome, endedAt, seconds } and waitingFor is 'database' or 'lock'. Returns
// { healthy, reason } with what the health check prints.
export function checkHealth(health, now) {
  const { lockedAt, lastCycle, waitingFor, waitingSince, window } = health;
  const status = {
    holdsLock: Number.isFinite(lockedAt),
    cycles: health.cycles,
    cycle: health.cycle,
    lastCycle: lastCycle && { ...lastCycle, endedAt: isoTime(lastCycle.endedAt) },
    waitingFor: waitingFor ?? null,
    waitingSince: waitingFor ? isoTime(waitingSince) : null
  };

  const healthy = (reason) => ({ healthy: true, reason, ...status });
  const unhealthy = (reason) => ({ healthy: false, reason, ...status });
  if (health.stopping) return unhealthy('the importer service is stopping');

  const waited = waitingFor ? now - waitingSince : null;
  const waiting = waitingFor === 'database' ? 'the database' : 'another run to end';
  if (status.holdsLock) {
    const since = lastCycle ? lastCycle.endedAt : lockedAt;
    const ago = minutes(now - since);
    if (now - since < window)
      return healthy(
        lastCycle
          ? `cycle ${lastCycle.cycle} ended ${ago} ago`
          : `it took the service lock ${ago} ago, and its first cycle has not ended yet`
      );
    if (waitingFor && waited < WAIT_LIMIT)
      return healthy(`it has been waiting for ${waiting} for ${minutes(waited)}`);
    return unhealthy(
      `no cycle has ended for ${ago}, more than the ${minutes(window)} allowed${
        waitingFor ? `, and it has been waiting for ${waiting} for ${minutes(waited)}` : ''
      }`
    );
  }
  if (waitingFor && waited < WAIT_LIMIT)
    return healthy(`it has been waiting for ${waiting} for ${minutes(waited)}`);
  return unhealthy(
    waitingFor
      ? `it has been waiting for ${waiting} for ${minutes(waited)}, more than the ${minutes(WAIT_LIMIT)} allowed`
      : 'it does not hold the run lock'
  );
}

// Serve whether the importer service is healthy, for the Docker health check: report() returns
// { healthy, ...status }, and the answer is 200 when it is healthy and 503 when it is not, with the
// status as JSON. A status that cannot be had is unhealthy, and why only goes to the console. A
// server that cannot start is reported in the console, and the service runs on without it, so the
// health check then fails.
export default function startHealthCheckServer(report) {
  return http
    .createServer((req, res) => {
      let status;
      try {
        status = report();
      } catch (err) {
        console.error(
          `The health check could not tell whether the service is healthy: ${err?.message}`
        );
        status = { healthy: false, reason: 'it could not tell whether it is healthy' };
      }
      res.writeHead(status.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    })
    .on('error', (err) => console.error(`The health check server failed: ${err?.message}`))
    .listen(HEALTH_CHECK_PORT, '127.0.0.1');
}
