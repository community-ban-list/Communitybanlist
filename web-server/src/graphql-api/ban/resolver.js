import { BanList, SteamUser } from 'scbl-lib/db/models';

export default {
  Ban: {
    steamUser: (parent, context) => {
      context.checkTimeout();
      return SteamUser.findByPk(parent.steamUser);
    },
    banList: (parent, context) => {
      context.checkTimeout();
      return BanList.findByPk(parent.banList);
    }
  }
};
