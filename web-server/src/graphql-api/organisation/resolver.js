import { BanList } from 'scbl-lib/db/models';

export default {
  Organisation: {
    banLists: (parent, args, context) => {
      context.checkTimeout();
      return BanList.findAll({
        where: { organisation: parent.id },
        order: [['name', 'ASC']]
      });
    }
  }
};
