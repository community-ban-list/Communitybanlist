import DiscordWebhookNode from 'discord-webhook-node';

const { MessageBuilder } = DiscordWebhookNode;

// A Discord message in the Community Ban List's style. It is sent with sendDiscordWebhook, which
// checks the webhook's address and gives Discord a time limit.
export default function (options = {}) {
  return new MessageBuilder()
    .setColor(options.color || '#ffc40b')
    .setFooter('Powered by the Community Ban List.')
    .setTimestamp();
}
