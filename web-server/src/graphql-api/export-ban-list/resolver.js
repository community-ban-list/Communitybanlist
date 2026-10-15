import { ExportBanListConfig } from 'scbl-lib/db/models';

import isSignedInAs from '../core/is-signed-in-as.js';

export default {
  ExportBanList: {
    exportBanListConfigs: (parent) => {
      return ExportBanListConfig.findAll({ where: { exportBanList: parent.id } });
    },
    // Anyone with the webhook can post to the owner's Discord channel, and anyone with the invite
    // can use the BattleMetrics ban list, so only the owner may see them.
    discordWebhook: (parent, args, context) => {
      return isSignedInAs(context, parent.owner) ? parent.discordWebhook : null;
    },
    battlemetricsInvite: (parent, args, context) => {
      return isSignedInAs(context, parent.owner) ? parent.battlemetricsInvite : null;
    }
  }
};
