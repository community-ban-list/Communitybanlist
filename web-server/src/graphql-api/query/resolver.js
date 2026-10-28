import { Ban, BanList, Organisation, SteamUser } from 'scbl-lib/db/models';

import { listOrder } from '../core/list-order.js';
import { PAGE_SIZE, pageArgs } from '../core/page-size.js';
import recordView from './record-view.js';

export default {
  Query: {
    organisations: () => {
      return Organisation.findAll({
        order: [['name', 'ASC']]
      });
    },
    banLists: () => {
      return BanList.findAll({
        order: [['name', 'ASC']]
      });
    },
    bans: (parent, filter) => {
      return Ban.paginate({
        ...listOrder('bans', filter),
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
