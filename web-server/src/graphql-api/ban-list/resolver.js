import { Organisation } from 'scbl-lib/db/models';

export default {
  BanList: {
    organisation: (parent, context) => {
      context.checkTimeOut();
      return Organisation.findByPk(parent.organisation);
    }
  }
};
