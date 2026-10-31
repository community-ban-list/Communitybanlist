import { Ban, BanList, Organisation, SteamUser } from 'scbl-lib/db/models';

import { listOrder } from '../core/list-order.js';
import { PAGE_SIZE, pageArgs } from '../core/page-size.js';
import { pausedOf, withoutPaused } from '../core/paused.js';
import recordView from './record-view.js';

export default {
  Query: {
    organisations: () => {
      return Organisation.findAll({
        order: [['name', 'ASC']]
      });
    },
    // Paused ban lists are left out, as their bans count for nothing.
    banLists: async (parent, args, context) => {
      const paused = pausedOf(context);
      return (await BanList.findAll({ order: [['name', 'ASC']] })).filter(
        (banList) => !paused.has(banList.id)
      );
    },
    // The bans of paused ban lists are left out.
    bans: (parent, filter, context) => {
      const { order, where } = listOrder('bans', filter);
      return Ban.paginate({
        order,
        where: withoutPaused(where, context),
        ...pageArgs(filter, PAGE_SIZE.list)
      });
    },
    steamUsers: (parent, filter) => {
      return SteamUser.paginate({
        ...listOrder('steamUsers', filter),
        ...pageArgs(filter, PAGE_SIZE.list)
      });
    },
    // The player is returned as soon as they are read. A view of a player with reputation points,
    // whom Recently Viewed Players can list, is answered with its own time as lastViewed, and saved
    // later, in the background.
    steamUser: async (parent, filter) => {
      const user = await SteamUser.findByPk(filter.id);
      if (user?.reputationPoints > 0) user.lastViewed = recordView(user.id);
      return user;
    },
    loggedInSteamUser: async (parent, filter, context) => {
      return context.user ? SteamUser.findByPk(context.user.id) : null;
    }
  }
};
