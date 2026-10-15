import { isDiscordWebhookUrl, testDiscordWebhook } from 'scbl-lib/utils';

// How many test messages each user can have the web server post to Discord webhooks. Every test is
// a request to Discord from the address the web server shares with the bot and the importer, and
// Discord blocks an address for a while when it makes too many failed requests.
export const WEBHOOK_TESTS_PER_MINUTE = 5;
export const WEBHOOK_TESTS_PER_HOUR = 30;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// When each user's tests in the last hour started, oldest first, by Steam ID. They are only kept in
// memory, so the limits start afresh when the web server restarts.
const recentTests = new Map();

// The contexts of the requests that have already tested a webhook. GraphQL runs the mutations in a
// request one after another with the same context, so without this, one request repeating a
// mutation under many aliases would post a test message for each of them.
const testingRequests = new WeakSet();

// Post a test message to a Discord webhook a user entered for an export ban list. A request can
// test one webhook, and a user only a few each minute and hour. The errors are shown to the user.
export default async function testWebhook(context, webhook, now = Date.now()) {
  // Addresses that are not Discord webhooks are refused without contacting Discord, so they do not
  // count as tests.
  if (isDiscordWebhookUrl(webhook)) startTest(context, now);
  await testDiscordWebhook(webhook);
}

// Count a test for the request's user, or throw the error to show them if they cannot test a
// webhook now. Nothing here waits, so requests running at the same time cannot both take the last
// test left.
function startTest(context, now) {
  const user = context.user && context.user.id;
  if (!user) throw new Error('Please sign in again to test a Discord webhook.');

  if (testingRequests.has(context))
    throw new Error(
      'Only one Discord webhook can be tested per request. Please save one export ban list at a time.'
    );

  // Forget tests from over an hour ago, and the users with none left, so the map stays small.
  for (const [id, times] of recentTests) {
    const recent = times.filter((time) => now - time < HOUR);
    if (recent.length > 0) recentTests.set(id, recent);
    else recentTests.delete(id);
  }

  const times = recentTests.get(user) || [];
  const lastMinute = times.filter((time) => now - time < MINUTE);
  const minuteWait = waitForTest(lastMinute, WEBHOOK_TESTS_PER_MINUTE, MINUTE, now);
  const hourWait = waitForTest(times, WEBHOOK_TESTS_PER_HOUR, HOUR, now);
  // When both limits have been reached, give the longer wait, so that trying again then works.
  if (hourWait > 0 && hourWait >= minuteWait)
    throw tooManyTests(WEBHOOK_TESTS_PER_HOUR, 'an hour', hourWait);
  if (minuteWait > 0) throw tooManyTests(WEBHOOK_TESTS_PER_MINUTE, 'a minute', minuteWait);

  testingRequests.add(context);
  recentTests.set(user, [...times, now]);
}

// How long until a limit of so many tests in a period allows another, given the times of the tests
// in the period, oldest first. It is 0 when the limit allows one now.
function waitForTest(times, limit, period, now) {
  return times.length < limit ? 0 : times[times.length - limit] + period - now;
}

// The error for a user who has reached a limit, saying when they can test a webhook again.
function tooManyTests(limit, period, wait) {
  return new Error(
    `Discord webhooks can only be tested ${limit} times ${period}. Please try again in ${describeWait(wait)}.`
  );
}

// A wait in words, rounded up to whole seconds under a minute and to whole minutes above.
function describeWait(milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
