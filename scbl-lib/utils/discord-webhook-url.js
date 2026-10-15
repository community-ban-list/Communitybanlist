// Hosts Discord gives out webhook addresses on, including its test clients.
const DISCORD_HOSTS = [
  'discord.com',
  'ptb.discord.com',
  'canary.discord.com',
  'discordapp.com',
  'ptb.discordapp.com',
  'canary.discordapp.com'
];

// A webhook's ID and token, with or without an API version.
const WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

// Whether a value is a Discord webhook address. Export ban list webhooks are only saved and sent
// to when they pass, so they cannot make the web server or importer call any other host. The only
// query Discord's addresses use is the thread to post in.
//
// This file has no imports, so the client can use it to check the form too.
export default function isDiscordWebhookUrl(value) {
  if (typeof value !== 'string') return false;

  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    DISCORD_HOSTS.includes(url.hostname) &&
    WEBHOOK_PATH.test(url.pathname) &&
    /^(?:\?thread_id=\d+)?$/.test(url.search) &&
    url.hash === ''
  );
}
