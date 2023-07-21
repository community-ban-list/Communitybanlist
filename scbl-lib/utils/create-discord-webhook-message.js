import DiscordWebhookNode from 'discord-webhook-node';
import SimpleDiscordWebhooks from 'simple-discord-webhooks';

const { Webhook, Message } = SimpleDiscordWebhooks;
const { MessageBuilder } = DiscordWebhookNode;

export default function (url, options = {}) {
  return [
    new Webhook(
      url,
      'Community Ban List',
      'https://raw.githubusercontent.com/CommunityBanList/Communitybanlist/v3/client/src/assets/img/brand/cbl-logo-square.png'
    ),
    new MessageBuilder()
      .setColor(options.color || '#ffc40b')
      .setFooter('Powered by the Community Ban List.')
      .setTimestamp()
  ];
}
