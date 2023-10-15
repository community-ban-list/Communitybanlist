import DiscordWebhookNode from 'discord-webhook-node';
import SimpleDiscordWebhooks from 'simple-discord-webhooks';

const { Webhook } = SimpleDiscordWebhooks;
const { MessageBuilder } = DiscordWebhookNode;

export default function (url, options = {}) {
  return [
    new Webhook(
      url,
      'Community Ban List',
      'https://github.com/community-ban-list/Communitybanlist/blob/master/client/src/assets/img/brand/cbl-logo-square.png?raw=true'
    ),
    new MessageBuilder()
      .setColor(options.color || '#ffc40b')
      .setFooter('Powered by the Community Ban List.')
      .setTimestamp()
  ];
}
