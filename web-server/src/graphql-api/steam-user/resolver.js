import { Ban, ExportBanList } from 'scbl-lib/db/models';

import { calculateRiskRating } from 'scbl-lib/utils';

import isSignedInAs from '../core/is-signed-in-as.js';
import { listOrder } from '../core/list-order.js';
import { PAGE_SIZE, pageArgs } from '../core/page-size.js';
import { pausedOf } from '../core/paused.js';

export default {
  SteamUser: {
    riskRating: (parent) => {
      return calculateRiskRating(parent.reputationPoints);
    },
    // A player's bans include those of paused ban lists, each of which says it is paused (paused),
    // as the request read them, so the player sees why such a ban no longer counts. It is set on
    // each ban here, rather than by a resolver of its own, as the query cost counts a field with
    // one as one that may look rows up.
    // A request the list cannot answer is refused as it is asked, before any query is made.
    bans: (parent, filter, context) => {
      const { order, where } = listOrder('bans', filter);
      const paused = pausedOf(context);
      const page = Ban.paginate({
        order,
        ...pageArgs(filter, PAGE_SIZE.playerBans),
        where: {
          ...where,
          steamUser: parent.id,
          ...(typeof filter.expired !== 'undefined' && { expired: filter.expired })
        }
      });
      return Promise.resolve(page).then((found) => {
        for (const edge of found?.edges ?? [])
          if (edge?.node) edge.node.paused = paused.has(edge.node.banList);
        return found;
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
