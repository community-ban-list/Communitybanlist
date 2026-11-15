import { disconnect, flushLogMessages, stopRecordingLogMessages } from 'scbl-lib/db';
import { describeError, Logger } from 'scbl-lib/utils';

import { stopGraphQL } from './graphql-api/index.js';
import { flushViews } from './graphql-api/query/record-view.js';
import { setShuttingDown } from './shutting-down.js';

// The web server stops on SIGTERM, which docker stop sends, or SIGINT, e.g. Ctrl+C. It takes no new
// connections, its health check fails, and it answers the requests under way, for up to 8 seconds,
// closing each connection once its answer is sent. Then it stops Apollo Server, saves the profile
// views still waiting to be saved, sends the lines waiting for the log channel, e.g. one about a change a request just made, writes the newest
// message it posted there to the database and closes the database connections, as the importer
// service does as it stops, and sends any lines still waiting. It exits 0, or 1 when requests were
// still being answered after 8 seconds and were cut off, and always within 9 seconds of the signal,
// before docker stop, which waits 10 seconds by default, kills it. A signal that comes before the
// server is listening ends it at once.

// How long the requests under way have to be answered, how long saving the profile views still
// waiting may take, how long the lines waiting for the log
// channel may take to be sent before the newest message is written, and how long writing it may
// take, so a log channel or a database that does not answer cannot take the time the steps after
// it need, and how long after the signal the web server exits at the latest. Held on an object so
// the tests can shorten them.
export const stopTimes = {
  answering: 8 * 1000,
  views: 2 * 1000,
  lines: 2 * 1000,
  recording: 2 * 1000,
  exiting: 9 * 1000
};

// While lines wait for the log channel, how often to check whether they have been sent.
const LOG_CHECK_INTERVAL = 100;

const TIMED_OUT = Symbol('timed out');

const seconds = (ms) => Math.round(ms / 100) / 10;

// Run a step of the stop, but wait for it for no longer than ms, and only warn when it fails or
// takes too long, so no step keeps the web server from stopping, nor the steps after it from running.
async function step(what, work, ms) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    if ((await Promise.race([work(), timedOut])) === TIMED_OUT)
      console.warn(`Warning: could not ${what} within ${seconds(ms)}s as the web server stopped.`);
  } catch (err) {
    console.warn(`Warning: could not ${what} as the web server stopped: ${describeError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Close a response's connection once the response is sent. A response that has not started yet
// says so, so the client sends no other request on that connection, and Node closes it after the
// response. Node keeps the connection open after any other response, e.g. one that started before
// the stop, or one whose headers an error handler replaced, as Koa's does, so once a response is
// sent, the idle connections are closed too.
function closeOnceSent(server, res) {
  if (!res.headersSent) res.setHeader('Connection', 'close');
  res.once('close', () => server.closeIdleConnections());
}

// Stop taking connections, close the idle ones, and close each of the others once the request
// under way on it is answered, waiting at most ms. Resolves with how many requests were still being
// answered then, which are cut off, as every connection still open is closed.
function closeServer(server, responses, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const unanswered = responses.size;
      server.closeAllConnections();
      resolve(unanswered);
    }, ms);
    server.close(() => {
      clearTimeout(timer);
      resolve(0);
    });
    server.closeIdleConnections();
    for (const res of responses) closeOnceSent(server, res);
  });
}

// Send the lines still waiting for the log channel, e.g. one about a change a request just made,
// but wait no longer than until deadline.
async function sendLogLines(deadline) {
  Logger.flush();
  while (Date.now() < deadline && Object.values(Logger.getLogQueue()).some((count) => count > 0))
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(LOG_CHECK_INTERVAL, deadline - Date.now()))
    );
}

// Stop the web server, as above, on the first SIGTERM or SIGINT from now on. Its setServer(server)
// is given the HTTP server once it is listening.
export default function stopOnSignals() {
  let server = null;
  let stopping = false;
  // The responses not sent yet.
  const responses = new Set();

  // Resolves with the exit code.
  const stop = async (signal) => {
    const deadline = Date.now() + stopTimes.exiting;
    const left = () => Math.max(0, deadline - Date.now());
    const answering = Math.min(stopTimes.answering, left());
    console.log(
      `Received ${signal}, so the web server is stopping: it takes no new connections, and answers the requests under way for up to ${seconds(answering)}s.`
    );
    const unanswered = await closeServer(server, responses, answering);
    if (unanswered > 0)
      console.warn(
        `Warning: ${unanswered} request${unanswered === 1 ? ' was' : 's were'} still being answered ${seconds(answering)}s after ${signal}, so ${unanswered === 1 ? 'it was' : 'they were'} cut off.`
      );

    await step('stop the GraphQL API', stopGraphQL, left());
    // No more lookups come in now, so the profile views still waiting are saved before the database
    // closes (see graphql-api/query/record-view.js).
    await step('save which players were viewed', flushViews, Math.min(stopTimes.views, left()));
    // The lines waiting are sent before the newest message is written, so it is the newest the web
    // server posted, as the importer service does (see recordNewest in ban-importer/src/loop.js):
    // they get half of the time left, and at most stopTimes.lines.
    await sendLogLines(Date.now() + Math.min(left() / 2, stopTimes.lines));
    await step(
      'record the newest message in the Discord log in the database',
      flushLogMessages,
      Math.min(stopTimes.recording, left())
    );
    // Lines posted from now on, as the stop sends them, are not written to the database, which is
    // closing.
    stopRecordingLogMessages();
    await step('close the database connections', disconnect, left());
    await sendLogLines(deadline);

    console.log(`The web server stopped, as it received ${signal}.`);
    return unanswered > 0 ? 1 : 0;
  };

  // Later signals change nothing, as the stop ends in time by itself.
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    setShuttingDown();
    if (!server) {
      console.log(`Received ${signal} before the web server was listening, so it stopped at once.`);
      process.exit(0);
      return;
    }
    stop(signal).then(
      (code) => process.exit(code),
      (err) => {
        console.error(`The web server could not stop cleanly: ${describeError(err)}`);
        process.exit(1);
      }
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return {
    setServer(httpServer) {
      server = httpServer;
      server.on('request', (req, res) => {
        responses.add(res);
        res.once('close', () => responses.delete(res));
        // A request can still come on a connection that was open as the stop began. It is
        // answered too, and its connection closed.
        if (stopping) closeOnceSent(server, res);
      });
    }
  };
}
