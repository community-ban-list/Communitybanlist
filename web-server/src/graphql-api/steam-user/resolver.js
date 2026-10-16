import { Ban, ExportBanList } from 'scbl-lib/db/models';

import { calculateRiskRating } from 'scbl-lib/utils';

import isSignedInAs from '../core/is-signed-in-as.js';
import { PAGE_SIZE, pageArgs } from '../core/page-size.js';

export default {
  SteamUser: {
    riskRating: (parent) => {
      return calculateRiskRating(parent.reputationPoints);
    },
    bans: (parent, filter) => {
      return Ban.paginate({
        order: [[filter.orderBy || 'created', filter.orderDirection || 'DESC']],
        ...pageArgs(filter, PAGE_SIZE.playerBans),
        where: {
          steamUser: parent.id,
          ...(typeof filter.expired !== 'undefined' && { expired: filter.expired })
        }
      });
    },
    // A Steam user's export ban lists are only shown to that user, as they hold the lists' Discord
    // webhooks and BattleMetrics invites.
    exportBanList: (parent, filter, context) => {
      if (!isSignedInAs(context, parent.id)) return null;
      return ExportBanList.findOne({ where: { id: filter.id, owner: parent.id } });
    },
    exportBanLists: (parent, filter, context) => {
      if (!isSignedInAs(context, parent.id)) return [];
      return ExportBanList.findAll({ where: { owner: parent.id } });
    }
  }
};
