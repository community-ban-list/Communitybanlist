import isDiscordWebhookUrl from './discord-webhook-url.js';
import sendDiscordWebhook from './discord-webhook.js';

// Check an export ban list's Discord webhook by posting a message to it. The errors are shown to
// the person who entered the webhook.
export default async function (url) {
  if (!isDiscordWebhookUrl(url)) throw new Error('Invalid Discord Webhook');

  try {
    await sendDiscordWebhook(url, { content: "Hello! We're just testing your Discord webhook!" });
  } catch (err) {
    throw new Error(`We could not post a test message to your Discord webhook. ${err.message}.`);
  }
}
