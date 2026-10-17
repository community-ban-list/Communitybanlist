// How many export ban lists each user can create and delete, together. Creating or deleting a
// BattleMetrics export ban list takes several requests to BattleMetrics, and the web server can
// only make a few of those a minute for all its users. The limits are for each user. All users'
// requests together stay within the web server's BattleMetrics budget, BATTLEMETRICS_API_RESERVOIR,
// which queues any beyond it.
export const CREATES_AND_DELETES_PER_MINUTE = 3;
export const CREATES_AND_DELETES_PER_HOUR = 10;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const CREATES_AND_DELETES = ['createExportBanList', 'deleteExportBanList'];

// The errors resolver.js gives when it refuses to create or delete a list before it saves anything
// or makes a request to BattleMetrics: the limit of 4 lists, a list that does not exist, and
// mistakes in a new list's settings, including a Discord webhook that fails its test or cannot be
// tested now. These do not count towards the limits, so a user who corrects a mistake can try
// again at once, and nor do errors marked as refusals (see refusal.js), such as settings outside
// the limits on export ban lists. Any other failure counts, as it may have come after requests to
// BattleMetrics.
const REFUSALS = [
  'You are limited to 4 export ban lists.',
  'Export ban list does not exist!',
  'Invalid export ban list type.',
  'Invalid Discord Webhook',
  'Only one Discord webhook can be tested per request. Please save one export ban list at a time.'
];
// How the errors start for a test message that could not be posted to a webhook, and for a user
// who has tested as many webhooks as they may for now. Each goes on to say why, or how long to wait.
const REFUSAL_STARTS = [
  'We could not post a test message to your Discord webhook.',
  'Discord webhooks can only be tested '
];

// Wrap the export ban list mutations, so that a change is only made for a signed-in user, after
// the same user's previous change has finished, and creating and deleting lists counts towards the
// limits above. `now` gives the time in milliseconds.
//
// The order of each user's changes and their limits are kept in memory, so the limits start afresh
// when the web server restarts. That works because production runs a single web server process.
// Locking the user's rows in the database instead would make changes wait whenever the importer
// runs, as it keeps players' rows locked for minutes.
export default function guardChanges(mutations, now = Date.now) {
  // The last change of each user with changes in progress, by Steam ID, which their next change
  // waits for. A user is forgotten once their changes have all finished.
  const lastChanges = new Map();

  // When each user created or deleted export ban lists in the last hour, oldest first, by Steam ID.
  const recentCreatesAndDeletes = new Map();

  // Count a creation or deletion for a user, or throw the error to show them if they cannot make
  // one now. Nothing here waits, so changes made at the same time cannot both take the last one
  // left, and changes the limits refuse do not count, so trying again when told works. Gives the
  // time it counted the change at.
  function countCreateOrDelete(user) {
    const time = now();

    // Forget changes from over an hour ago, and the users with none left, so the map stays small.
    for (const [id, times] of recentCreatesAndDeletes) {
      const recent = times.filter((changed) => time - changed < HOUR);
      if (recent.length > 0) recentCreatesAndDeletes.set(id, recent);
      else recentCreatesAndDeletes.delete(id);
    }

    const times = recentCreatesAndDeletes.get(user) || [];
    const lastMinute = times.filter((changed) => time - changed < MINUTE);
    const minuteWait = waitForChange(lastMinute, CREATES_AND_DELETES_PER_MINUTE, MINUTE, time);
    const hourWait = waitForChange(times, CREATES_AND_DELETES_PER_HOUR, HOUR, time);
    // When both limits have been reached, give the longer wait, so that trying again then works.
    if (hourWait > 0 && hourWait >= minuteWait)
      throw tooManyChanges(CREATES_AND_DELETES_PER_HOUR, 'an hour', hourWait);
    if (minuteWait > 0)
      throw tooManyChanges(CREATES_AND_DELETES_PER_MINUTE, 'a minute', minuteWait);

    recentCreatesAndDeletes.set(user, [...times, time]);
    return time;
  }

  // Take back a creation or deletion counted at a time, as it was refused before it changed
  // anything. It is gone already if it was counted over an hour ago.
  function uncountCreateOrDelete(user, time) {
    const times = recentCreatesAndDeletes.get(user) || [];
    const index = times.indexOf(time);
    if (index === -1) return;
    const rest = times.toSpliced(index, 1);
    if (rest.length > 0) recentCreatesAndDeletes.set(user, rest);
    else recentCreatesAndDeletes.delete(user);
  }

  // Make a change once the user's last change has finished, whether or not that succeeded.
  function afterLastChange(user, change) {
    const result = (lastChanges.get(user) || Promise.resolve()).then(change);
    const finished = result
      .catch(() => {})
      .then(() => {
        if (lastChanges.get(user) === finished) lastChanges.delete(user);
      });
    lastChanges.set(user, finished);
    return result;
  }

  function guard(name, mutation) {
    return async (parent, args, context, info) => {
      // Every change needs signing in, which is checked before anything is looked up.
      const user = context.user?.id;
      if (!user) throw new Error('Please sign in again to change your export ban lists.');

      const counted = CREATES_AND_DELETES.includes(name) ? countCreateOrDelete(user) : undefined;

      // Checks such as the limit of 4 export ban lists, or of one config for each ban list, look
      // up the user's rows and then change them, so two changes by the user at once could both
      // pass them. Other users' changes are still made alongside.
      try {
        return await afterLastChange(user, () => mutation(parent, args, context, info));
      } catch (error) {
        // A creation or deletion refused before it changed anything does not count.
        if (counted !== undefined && isRefusal(error)) uncountCreateOrDelete(user, counted);
        throw error;
      }
    };
  }

  return Object.fromEntries(
    Object.entries(mutations).map(([name, mutation]) => [name, guard(name, mutation)])
  );
}

// Whether a change failed with one of the refusals above, or an error marked as a refusal, so it
// changed nothing.
function isRefusal(error) {
  if (error?.refusal === true) return true;
  const message = error?.message;
  if (typeof message !== 'string') return false;
  return REFUSALS.includes(message) || REFUSAL_STARTS.some((start) => message.startsWith(start));
}

// How long until a limit of so many changes in a period allows another, given the times of the
// changes in the period, oldest first. It is 0 when the limit allows one now.
function waitForChange(times, limit, period, time) {
  return times.length < limit ? 0 : times[times.length - limit] + period - time;
}

// The error for a user who has reached a limit, saying when they can make the change.
function tooManyChanges(limit, period, wait) {
  return new Error(
    `Export ban lists can only be created or deleted ${limit} times ${period}. Please try again in ${describeWait(wait)}.`
  );
}

// A wait in words, rounded up to whole seconds under a minute and to whole minutes above.
function describeWait(milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
