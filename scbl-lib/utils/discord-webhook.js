import axios from 'axios';

import isDiscordWebhookUrl from './discord-webhook-url.js';

// How long a webhook has to answer, so one that never answers cannot hold up the importer or a
// request to the web server. A request still being answered is cut off a little later.
const DISCORD_WEBHOOK_TIMEOUT = 10 * 1000;
const DISCORD_WEBHOOK_DEADLINE = 15 * 1000;

// axios's error codes for a request that ran out of time.
const TIMEOUT_CODES = ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'];

const USERNAME = 'Community Ban List';
const AVATAR_URL =
  'https://github.com/community-ban-list/Communitybanlist/blob/master/client/src/assets/img/brand/cbl-logo-square.png?raw=true';

// Why a message was not posted to a webhook, with Discord's HTTP status and error code when it
// answered, and, when it rate limited the request, how many seconds it asked to wait before trying
// again. The message never includes the webhook's address, as anyone with it can post to the
// channel.
export class DiscordWebhookError extends Error {
  constructor(message, { status, code, retryAfter } = {}) {
    super(message);
    this.name = 'DiscordWebhookError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// The wait Discord asks for when it rate limits a request, in seconds: retry_after in its answer,
// or the Retry-After header when the answer does not say, e.g. when Cloudflare sent it.
function getRetryAfter(data, headers) {
  for (const value of [data.retry_after, headers?.['retry-after']]) {
    const seconds = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
}

// Make a request to a webhook address. Redirects are not followed, and the request gives up when
// Discord does not answer in time. Returns Discord's answer, or throws a DiscordWebhookError.
async function request(method, url, body) {
  let response;
  try {
    response = await axios[method](url.href, body, {
      timeout: DISCORD_WEBHOOK_TIMEOUT,
      signal: AbortSignal.timeout(DISCORD_WEBHOOK_DEADLINE),
      maxRedirects: 0,
      validateStatus: () => true
    });
  } catch (err) {
    if (TIMEOUT_CODES.includes(err.code))
      throw new DiscordWebhookError('Discord did not answer in time');
    throw new DiscordWebhookError(`Could not reach Discord (${err.code || err.message})`);
  }

  if (response.status >= 200 && response.status < 300) return response.data;

  // Discord explains errors as JSON, e.g. { message: 'Unknown Webhook', code: 10015 }.
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  const { message, code } = data;
  const reason = typeof message === 'string' ? `: ${message.slice(0, 200)}` : '';
  throw new DiscordWebhookError(
    `Discord answered HTTP ${response.status}${reason}${code ? ` (code ${code})` : ''}`,
    { status: response.status, code, retryAfter: getRetryAfter(data, response.headers) }
  );
}

// Post a message to a Discord webhook as the Community Ban List. Only Discord webhook addresses
// are accepted, redirects are not followed, and the request gives up when Discord does not answer
// in time. Returns the message Discord posted, or throws a DiscordWebhookError.
export default async function sendDiscordWebhook(webhook, { content = null, embeds = [] } = {}) {
  if (!isDiscordWebhookUrl(webhook)) throw new DiscordWebhookError('Invalid Discord webhook');

  // Build the address rather than appending to it, as it may already have a thread_id query.
  const url = new URL(webhook);
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.set('wait', 'true');

  return request('post', url, {
    content,
    username: USERNAME,
    avatar_url: AVATAR_URL,
    embeds,
    allowed_mentions: { parse: [] }
  });
}

// Replace the content and embeds of a message a webhook posted, e.g. to update a progress bar,
// with the same checks and time limits as sendDiscordWebhook. Returns the edited message, or throws
// a DiscordWebhookError.
export async function editDiscordWebhookMessage(
  webhook,
  messageID,
  { content = null, embeds = [] } = {}
) {
  if (!isDiscordWebhookUrl(webhook)) throw new DiscordWebhookError('Invalid Discord webhook');
  if (!/^\d+$/.test(messageID)) throw new DiscordWebhookError('Invalid Discord message');

  // The message is found under the webhook. A message in a thread also needs the webhook's
  // thread_id query, which is kept.
  const url = new URL(webhook);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${messageID}`;

  return request('patch', url, { content, embeds, allowed_mentions: { parse: [] } });
}
