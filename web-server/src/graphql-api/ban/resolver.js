import { BanList, SteamUser } from 'scbl-lib/db/models';

export default {
  Ban: {
    steamUser: (parent, args, context) => {
      context.checkTimeout();
      return SteamUser.findByPk(parent.steamUser);
    },
    banList: (parent, args, context) => {
      context.checkTimeout();
      return BanList.findByPk(parent.banList);
    }
  }
};
