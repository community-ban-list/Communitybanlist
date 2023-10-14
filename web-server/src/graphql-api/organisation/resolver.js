import { BanList } from 'scbl-lib/db/models';

export default {
  Organisation: {
    banLists: (parent, context) => {
      context.checkTimeOut();
      return BanList.findAll({
        where: { organisation: parent.id },
        order: [['name', 'ASC']]
      });
    }
  }
};
