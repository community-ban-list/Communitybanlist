// Whether the web server is stopping (see shutdown.js), when its health check fails, though it
// still answers the requests it has. It imports nothing, so app.js can read it without loading what
// the stop needs.

let shuttingDown = false;

export function isShuttingDown() {
  return shuttingDown;
}

export function setShuttingDown() {
  shuttingDown = true;
}
