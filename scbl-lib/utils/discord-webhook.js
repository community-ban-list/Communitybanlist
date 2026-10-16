import axios from 'axios';

import isDiscordWebhookUrl from './discord-webhook-url.js';

// How long a webhook has to answer, so one that never answers cannot hold up the importer or a
// request to the web server. A request still being answered is cut off a little later.
const DISCORD_WEBHOOK_TIMEOUT = 10 * 1000;
const DISCORD_WEBHOOK_DEADLINE = 15 * 1000;

// axios's error codes for a request that ran out of time.
const TIMEOUT_CODES = ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED'];

// Discord's error codes meaning a webhook is gone for good: it was deleted (Unknown Webhook) or its
// token no longer works (Invalid Webhook Token).
export const DELETED_WEBHOOK_CODES = [10015, 50027];

const USERNAME = 'Community Ban List';
const AVATAR_URL =
  'https://github.com/community-ban-list/Communitybanlist/blob/master/client/src/assets/img/brand/cbl-logo-square.png?raw=true';

// Why a message was not posted to a webhook, with Discord's HTTP status and error code when it
// answered, and, when it rate limited the request, how many seconds it asked to wait before trying
// again. network is true when Discord could not be reached or did not answer in time, so the
// message may or may not have been posted. The message never includes the webhook's address, as
// anyone with it can post to the channel.
export class DiscordWebhookError extends Error {
  constructor(message, { status, code, retryAfter, network = false } = {}) {
    super(message);
    this.name = 'DiscordWebhookError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.network = network;
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

// A webhook's address on version 10 of Discord's API, without a trailing slash and keeping its
// thread_id query. The addresses Discord gives out have no version, and Discord documents those as
// answered by its old default version, where retry_after and Retry-After may be in milliseconds.
// Version 10 gives them in seconds.
function webhookAddress(webhook) {
  const url = new URL(webhook);
  url.pathname = url.pathname.replace(/^\/api(?:\/v\d+)?\//, '/api/v10/').replace(/\/$/, '');
  return url;
}

// The address of a message a webhook posted, found under the webhook. A message in a thread also
// needs the webhook's thread_id query, which is kept.
function messageAddress(webhook, messageID) {
  if (!isDiscordWebhookUrl(webhook)) throw new DiscordWebhookError('Invalid Discord webhook');
  if (!/^\d+$/.test(messageID)) throw new DiscordWebhookError('Invalid Discord message');
  const url = webhookAddress(webhook);
  url.pathname += `/messages/${messageID}`;
  return url;
}

// Make a request to a webhook address. Redirects are not followed, and the request gives up when
// Discord does not answer in time. Returns Discord's answer, or throws a DiscordWebhookError.
async function request(method, url, body) {
  const options = {
    timeout: DISCORD_WEBHOOK_TIMEOUT,
    signal: AbortSignal.timeout(DISCORD_WEBHOOK_DEADLINE),
    maxRedirects: 0,
    validateStatus: () => true
  };
  let response;
  try {
    // A GET has no body.
    response = await (method === 'get'
      ? axios.get(url.href, options)
      : axios[method](url.href, body, options));
  } catch (err) {
    if (TIMEOUT_CODES.includes(err.code))
      throw new DiscordWebhookError('Discord did not answer in time', { network: true });
    throw new DiscordWebhookError(`Could not reach Discord (${err.code || err.message})`, {
      network: true
    });
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
  const url = webhookAddress(webhook);
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
  const url = messageAddress(webhook, messageID);
  return request('patch', url, { content, embeds, allowed_mentions: { parse: [] } });
}

// Read a message a webhook posted, e.g. to see whether an earlier run's status message still says
// it is running, with the same checks and time limits as sendDiscordWebhook. Returns the message,
// or throws a DiscordWebhookError.
export async function getDiscordWebhookMessage(webhook, messageID) {
  return request('get', messageAddress(webhook, messageID));
}
