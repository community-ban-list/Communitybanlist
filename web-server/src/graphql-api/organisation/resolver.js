import { BanList } from 'scbl-lib/db/models';

import { pausedOf } from '../core/paused.js';

export default {
  Organisation: {
    // Paused ban lists are left out, as their bans count for nothing.
    banLists: async (parent, args, context) => {
      const paused = pausedOf(context);
      return (
        await BanList.findAll({
          where: { organisation: parent.id },
          order: [['name', 'ASC']]
        })
      ).filter((banList) => !paused.has(banList.id));
    }
  }
};
