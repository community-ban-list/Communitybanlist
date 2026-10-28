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
    // The player is returned as soon as they are read, with this view's time as lastViewed. That
    // they were viewed is saved later, in the background.
    steamUser: async (parent, filter) => {
      const user = await SteamUser.findByPk(filter.id);
      if (user) user.lastViewed = recordView(user.id);
      return user;
    },
    loggedInSteamUser: async (parent, filter, context) => {
      return context.user ? SteamUser.findByPk(context.user.id) : null;
    }
  }
};
