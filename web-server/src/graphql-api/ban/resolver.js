import { BanList, SteamUser } from 'scbl-lib/db/models';

export default {
  Ban: {
    steamUser: (parent, context) => {
      context.checkTimeOut();
      return SteamUser.findByPk(parent.steamUser);
    },
    banList: (parent, context) => {
      context.checkTimeOut();
      return BanList.findByPk(parent.banList);
    }
  }
};
