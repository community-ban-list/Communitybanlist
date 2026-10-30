import { Organisation } from 'scbl-lib/db/models';

import { pausedOf } from '../core/paused.js';

export default {
  BanList: {
    // Whether the ban list is paused, so its bans count for nothing.
    paused: (parent, args, context) => pausedOf(context).has(parent.id),
    organisation: (parent) => {
      return Organisation.findByPk(parent.organisation);
    }
  }
};
