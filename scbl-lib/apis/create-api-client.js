// The BattleMetrics and Steam clients make their requests through createApiClient. Each attempt
// at a request is a job of its own on the client's limiter, so retries count against the budget
// like any other request, and each attempt is cut off when it takes too long.
//
// A failed request is only made again when that is safe and could help:
// - GET and DELETE requests are made up to 3 times when the connection failed or timed out, or
//   the API answered 408, 429 or 5xx. The waits are about 1 s and then 4 s, or as long as the API
//   asks in Retry-After. A caller can give a request other attempts (see below).
// - POST and PATCH requests are made again only after a 429, or when no connection could be made.
//   The API may have carried out one that timed out, was cut off or failed with 5xx, so its error
//   is marked ambiguous, for the caller to find out what happened. A caller can mark one that
//   does no harm when it is carried out twice as repeatable, so it is made again like a GET.
// - Any other answer fails at once. The error is marked auth when the API refused the credentials.
//
// Each attempt has the client's time limit, unless the caller gives its attempts others, which also
// gives the request as many attempts as it gives limits (options.timeouts), and the waits between
// them (options.retryDelays), e.g. more and shorter attempts, soon after each other, at a page that
// the API at times does not answer at all. A caller can also have a request end before an attempt
// is sent, e.g. as it is stopping (options.beforeAttempt), which the request then also checks at
// least every second while it waits: for a pause, for its turn in the limiter's queue, or before
// another attempt. None of them changes which failures are made again.
//
// After a 429, or when the API says few requests are left, nothing is sent until the time it
// gives in Retry-After, or for a minute.
//
// axios's errors hold the request, with its headers and address and so the API keys in them, so a
// failed request throws an ApiError instead, which describes it by its method and path.

// How many attempts a request has, unless its caller gives its attempts time limits of their own
// (see attemptsOf).
const ATTEMPTS = 3;

// The waits before the second and third attempts, unless the caller gives others (see delayOf).
// Each gets up to a quarter more at random, so requests that failed together are not made again
// together.
const RETRY_DELAYS = [1000, 4000];

// How long nothing is sent when the API does not say, and the longest wait honoured, so a wrong
// Retry-After cannot hold up the service for long.
const DEFAULT_PAUSE = 60 * 1000;
const MAX_WAIT = 5 * 60 * 1000;

// Error codes for a request that could not connect, so the API never received it.
const NOT_SENT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'];

// Error codes for a request that ran out of time: axios's timeout, the abort signal's and the
// system's.
const TIMEOUT_CODES = ['ECONNABORTED', 'ERR_CANCELED', 'ETIMEDOUT'];

// Requests that change nothing more when they are made again.
const REPEATABLE_METHODS = ['GET', 'DELETE'];

// At most this many of the API's error titles are given in a message.
const MAX_TITLES = 3;

// How often a request whose caller can stop it (options.beforeAttempt) checks whether it should
// while it waits: for a pause, for its turn in the limiter's queue, or before another attempt.
const STOP_CHECK_INTERVAL = 1000;

export class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ApiError';
    this.method = details.method;
    this.path = details.path;
    this.status = details.status;
    this.code = details.code;
    this.titles = details.titles;
    this.attempts = details.attempts;
    // The API may have carried out the request, as a POST or PATCH ran out of time, was cut off or
    // failed with 5xx.
    this.ambiguous = details.ambiguous;
    // The API refused the credentials, so other requests will fail too.
    this.auth = details.auth;
    // Callers read the status and BattleMetrics' errors here, as they did on axios's errors.
    if (details.status)
      this.response = { status: details.status, data: { errors: details.errors } };
  }
}

// What a caller's beforeAttempt threw, which ends the request with it as it is, as no attempt was
// sent, rather than as a failed attempt.
class CallerStopped {
  constructor(error) {
    this.error = error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call a caller's stop check, if it gave one, and end the request with what it throws.
function checkStop(stopCheck) {
  if (!stopCheck) return;
  try {
    stopCheck();
  } catch (err) {
    throw new CallerStopped(err);
  }
}

// Wait ms milliseconds. With a stop check, the wait is checked at least every STOP_CHECK_INTERVAL,
// and ends with what the check throws, so a caller that is stopping waits no longer than that.
// Without one, it is a single wait, as it always was.
async function waitFor(ms, stopCheck = null) {
  if (!stopCheck) {
    await sleep(ms);
    return;
  }
  const until = Date.now() + ms;
  for (let left = ms; left > 0; left = until - Date.now()) {
    await sleep(Math.min(left, STOP_CHECK_INTERVAL));
    checkStop(stopCheck);
  }
}

function seconds(ms) {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

// How many attempts a request has: one for each time limit its caller gives its attempts
// (options.timeouts), or else ATTEMPTS.
function attemptsOf(timeouts) {
  return Array.isArray(timeouts) && timeouts.length > 0 ? timeouts.length : ATTEMPTS;
}

// The wait before the attempt after attempt number attempts, in milliseconds, before its quarter at
// random: the caller's for it (options.retryDelays), or else the last the caller gave, or else the
// client's own for it, or else the last of those.
function delayOf(retryDelays, attempts) {
  const given = Array.isArray(retryDelays) ? retryDelays.slice(0, attempts) : [];
  for (const delay of given.reverse()) if (Number.isFinite(delay) && delay >= 0) return delay;
  return RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length) - 1];
}

// A header of a response, or null when it has none.
function header(response, name) {
  const value = response?.headers?.[name];
  return value === undefined || value === null || String(value).trim() === '' ? null : value;
}

// How long the API asked to wait in Retry-After, in seconds or as a date, in milliseconds.
function retryAfter(response) {
  const value = header(response, 'retry-after');
  if (value === null) return null;
  const wait = Number.isFinite(Number(value))
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT) : null;
}

// What a failed attempt means: 'retry' when it can be made again, 'ambiguous' when the API may
// have carried out a request that must not be repeated, and 'final' otherwise.
function classify(err, repeatable) {
  const status = err.response?.status;
  if (status === 429) return 'retry';
  if (status >= 500) return repeatable ? 'retry' : 'ambiguous';
  if (status === 408 && repeatable) return 'retry';
  if (status) return 'final';
  if (NOT_SENT_CODES.includes(err.code)) return 'retry';
  return repeatable ? 'retry' : 'ambiguous';
}

export default function createApiClient({
  // The API's name in messages, e.g. BattleMetrics.
  name,
  // The Bottleneck limiter for the API's budget, and the start of its jobs' IDs.
  limiter,
  jobPrefix,
  // How long, in milliseconds, the API has to answer an attempt.
  timeout,
  // Makes one attempt with axios: send(method, path, params, data, options) adds options, the
  // attempt's time limits, to its request.
  send,
  // The statuses with which the API refuses credentials.
  authStatuses = [401],
  // Nothing is sent for a while once the API's X-Rate-Limit-Remaining header falls below this.
  minRemaining = null,
  // Values, such as API keys, that must never appear in errors or logs.
  secrets = []
}) {
  const hidden = secrets.filter((secret) => typeof secret === 'string' && secret !== '');
  const redact = (text) =>
    hidden.reduce((result, secret) => result.split(secret).join('[redacted]'), String(text));
  // Text from a response, on one line, without the secrets.
  const clean = (text, length) => redact(text).replace(/\s+/g, ' ').trim().slice(0, length);

  // Each job gets an ID of its own, as Bottleneck rejects a job while another with its ID is
  // waiting or running. sent counts the attempts sent.
  let jobCount = 0;
  let sent = 0;

  // The time until which nothing is sent. A request waits for it to pass, checking its caller's
  // stop check meanwhile, if it gave one (see waitFor).
  let pausedUntil = 0;

  async function waitForPause(stopCheck = null) {
    for (let wait = pausedUntil - Date.now(); wait > 0; wait = pausedUntil - Date.now())
      await waitFor(wait, stopCheck);
  }

  // Send nothing for a while, or for longer than already planned, and say so when a pause starts.
  function pause(ms, reason) {
    const now = Date.now();
    if (ms <= 0 || now + ms <= pausedUntil) return;
    if (pausedUntil <= now)
      console.warn(redact(`${name} ${reason}, so no requests are sent for ${seconds(ms)}.`));
    pausedUntil = now + ms;
  }

  // Pause after a 429, or when few of the API's requests are left this minute. When the API gives
  // its limit, fewer than a fifth of it must be left, so a lower limit than expected does not
  // pause every request.
  function checkRateLimit(response) {
    if (!response) return;
    const wait = retryAfter(response) ?? DEFAULT_PAUSE;
    if (response.status === 429) {
      pause(wait, 'answered HTTP 429 Too Many Requests');
    } else if (minRemaining !== null) {
      const remaining = Number(header(response, 'x-rate-limit-remaining') ?? NaN);
      const limit = Number(header(response, 'x-rate-limit-limit') ?? NaN);
      const threshold = Number.isFinite(limit) ? Math.min(minRemaining, limit / 5) : minRemaining;
      if (Number.isFinite(remaining) && remaining < threshold)
        pause(wait, `has ${remaining} requests left for the API key this minute`);
    }
  }

  // The API's explanation of a failure, if it gave one as BattleMetrics does: a list of errors,
  // each with a title and a detail. Only these are kept.
  function apiErrors(response) {
    const errors = response?.data?.errors;
    if (!Array.isArray(errors)) return undefined;
    const text = (value) =>
      typeof value === 'string' || typeof value === 'number' ? clean(value, 300) : undefined;
    return errors.map((error) => ({
      status: text(error?.status),
      code: text(error?.code),
      title: text(error?.title),
      detail: text(error?.detail)
    }));
  }

  // An error for a failed request that names its method and path, why it failed and the API's
  // error titles, but never its address, headers or parameters. limit is the last attempt's time
  // limit.
  function toApiError(method, path, err, attempts, outcome, limit) {
    const status = err.response?.status;
    const code = typeof err.code === 'string' && err.code ? err.code : undefined;
    const errors = apiErrors(err.response);
    const titles = [
      ...new Set((errors || []).map((error) => error.title || error.detail).filter(Boolean))
    ]
      .slice(0, MAX_TITLES)
      .map((title) => title.slice(0, 100));

    let reason;
    if (status) reason = `HTTP ${status}`;
    else if (TIMEOUT_CODES.includes(code)) reason = `timed out after ${seconds(limit)}`;
    else if (NOT_SENT_CODES.includes(code)) reason = `could not connect (${code})`;
    else if (code) reason = `the request failed (${code})`;
    else reason = `the request failed (${err.message ? clean(err.message, 200) : 'no reason'})`;
    if (titles.length > 0) reason += ` (${titles.join('; ')})`;

    const after = attempts > 1 ? ` after ${attempts} attempts` : '';
    const ambiguous = outcome === 'ambiguous';
    const consequence = ambiguous ? ', so it may have been carried out' : '';
    return new ApiError(
      redact(`${name} ${method} ${path} failed${after}: ${reason}${consequence}`),
      {
        method,
        path: redact(path),
        status,
        code,
        titles,
        errors,
        attempts,
        ambiguous,
        auth: authStatuses.includes(status)
      }
    );
  }

  // One attempt: a job of its own on the limiter, cut off after limit milliseconds. A caller's stop
  // check (beforeAttempt), if it gives one, is called at least every STOP_CHECK_INTERVAL while the
  // attempt waits for its turn in the queue, and once its turn has come, after any pause, just
  // before it is sent. If it throws, the request ends with what it threw, and nothing is sent: an
  // attempt whose turn comes after its request ended does nothing. The job has still used its
  // place in the budget then. An attempt once sent is not cut short by a stop: it gets its answer,
  // or fails, within its time limit.
  function attempt(method, path, params, data, priority, limit, stopCheck) {
    jobCount++;
    // While the attempt waits for its turn, the timer of the next stop check (checking), and
    // whether a check has ended the request (ended).
    let checking = null;
    let ended = false;
    const stopChecking = () => {
      if (checking !== null) clearTimeout(checking);
      checking = null;
    };
    const job = limiter.schedule({ priority, id: `${jobPrefix}-${jobCount}` }, async () => {
      stopChecking();
      if (ended) return null;
      // A request queued before a pause began waits for it too.
      await waitForPause(stopCheck);
      checkStop(stopCheck);
      sent++;
      try {
        const response = await send(method, path, params, data, {
          timeout: limit,
          signal: AbortSignal.timeout(limit)
        });
        checkRateLimit(response);
        return response;
      } catch (err) {
        checkRateLimit(err?.response);
        throw err;
      }
    });
    if (!stopCheck) return job;
    return new Promise((resolve, reject) => {
      const check = () => {
        checking = null;
        try {
          stopCheck();
        } catch (err) {
          ended = true;
          reject(new CallerStopped(err));
          return;
        }
        checking = setTimeout(check, STOP_CHECK_INTERVAL);
      };
      checking = setTimeout(check, STOP_CHECK_INTERVAL);
      job.then(
        (response) => {
          stopChecking();
          resolve(response);
        },
        (err) => {
          stopChecking();
          reject(err);
        }
      );
    });
  }

  // The time limit of attempt number attempts, in milliseconds: the caller's for it, or else the
  // last the caller gave before it, or else the client's own.
  function limitOf(timeouts, attempts) {
    const given = Array.isArray(timeouts) ? timeouts.slice(0, attempts) : [];
    for (const limit of given.reverse()) if (Number.isFinite(limit) && limit > 0) return limit;
    return timeout;
  }

  // options.repeatable marks a POST or PATCH as safe to make again, as making it twice does no
  // harm, e.g. one that creates an invite. options.timeouts gives the request an attempt for each
  // time limit in it, in milliseconds, the first attempt's first, rather than ATTEMPTS of the
  // client's, for a request the API at times does not answer, e.g. the importer's reads of pages of
  // bans: one that is not a time gives its attempt the last before it, or the client's.
  // options.retryDelays gives the waits before the second and later attempts, in milliseconds, each
  // still with up to a quarter more at random, rather than RETRY_DELAYS; an attempt it gives none
  // to waits the last it gives. A Retry-After or a pause that is longer still wins, and what is
  // made again is as for any request. options.beforeAttempt is a stop check: it is called before
  // each attempt, again once the attempt's turn in the queue has come, just before it is sent, and
  // at least every second while the request waits, for a pause, for its turn, or before another
  // attempt. One that throws, e.g. as the caller has been asked to stop, ends the request with what
  // it threw, within a second while it waits, and nothing more is sent; an attempt already sent
  // still has its time limit. Without them, as for the web server's and the bot's requests, a
  // request has ATTEMPTS attempts, each with the client's time limit, about 1 and 4 seconds apart,
  // and waits as long as it must.
  async function request(method, path, params, data, priority = 5, options = {}) {
    const verb = String(method).toUpperCase();
    const repeatable = options.repeatable === true || REPEATABLE_METHODS.includes(verb);
    const stopCheck = typeof options.beforeAttempt === 'function' ? options.beforeAttempt : null;
    const most = attemptsOf(options.timeouts);
    for (let attempts = 1; ; attempts++) {
      const limit = limitOf(options.timeouts, attempts);
      let error;
      let wait;
      try {
        // A caller that is stopping makes no attempt. A pause is waited out before the attempt
        // joins the limiter's queue, so waiting uses none of the budget.
        if (attempts === 1) checkStop(stopCheck);
        await waitForPause(stopCheck);
        return await attempt(method, path, params, data, priority, limit, stopCheck);
      } catch (thrown) {
        if (thrown instanceof CallerStopped) throw thrown.error;
        const err = thrown ?? {};
        const outcome = classify(err, repeatable);
        error = toApiError(verb, path, err, attempts, outcome, limit);
        if (outcome !== 'retry' || attempts >= most) throw error;
        const delay = delayOf(options.retryDelays, attempts) * (1 + Math.random() / 4);
        wait = Math.max(delay, retryAfter(err.response) ?? 0, pausedUntil - Date.now());
      }
      // A caller that is stopping makes no more attempts, and does not wait for one: the request
      // ends before the wait, or within a second of the stop during it.
      try {
        checkStop(stopCheck);
        console.warn(
          `${error.message}. Trying again in ${seconds(wait)} (attempt ${attempts + 1} of ${most}).`
        );
        await waitFor(wait, stopCheck);
      } catch (thrown) {
        if (!(thrown instanceof CallerStopped)) throw thrown;
        console.warn(`${error.message}. Not trying again, as the request was stopped.`);
        throw thrown.error;
      }
    }
  }

  // How many attempts the client has sent since the service started, each retry counted, as each
  // uses the budget, e.g. for the importer service's hourly summary.
  request.attempts = () => sent;
  return request;
}
