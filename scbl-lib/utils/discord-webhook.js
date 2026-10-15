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
// answered. The message never includes the webhook's address, as anyone with it can post to the
// channel.
export class DiscordWebhookError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'DiscordWebhookError';
    this.status = status;
    this.code = code;
  }
}

// Post a message to a Discord webhook as the Community Ban List. Only Discord webhook addresses
// are accepted, redirects are not followed, and the request gives up when Discord does not answer
// in time. Throws a DiscordWebhookError if the message was not posted.
export default async function sendDiscordWebhook(webhook, { content = null, embeds = [] } = {}) {
  if (!isDiscordWebhookUrl(webhook)) throw new DiscordWebhookError('Invalid Discord webhook');

  // Build the address rather than appending to it, as it may already have a thread_id query.
  const url = new URL(webhook);
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.set('wait', 'true');

  let response;
  try {
    response = await axios.post(
      url.href,
      {
        content,
        username: USERNAME,
        avatar_url: AVATAR_URL,
        embeds,
        allowed_mentions: { parse: [] }
      },
      {
        timeout: DISCORD_WEBHOOK_TIMEOUT,
        signal: AbortSignal.timeout(DISCORD_WEBHOOK_DEADLINE),
        maxRedirects: 0,
        validateStatus: () => true
      }
    );
  } catch (err) {
    if (TIMEOUT_CODES.includes(err.code))
      throw new DiscordWebhookError('Discord did not answer in time');
    throw new DiscordWebhookError(`Could not reach Discord (${err.code || err.message})`);
  }

  if (response.status >= 200 && response.status < 300) return response.data;

  // Discord explains errors as JSON, e.g. { message: 'Unknown Webhook', code: 10015 }.
  const { message, code } = response.data && typeof response.data === 'object' ? response.data : {};
  const reason = typeof message === 'string' ? `: ${message.slice(0, 200)}` : '';
  throw new DiscordWebhookError(
    `Discord answered HTTP ${response.status}${reason}${code ? ` (code ${code})` : ''}`,
    { status: response.status, code }
  );
}
