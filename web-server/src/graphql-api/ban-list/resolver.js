import { Organisation } from 'scbl-lib/db/models';

export default {
  BanList: {
    organisation: (parent, context) => {
      context.checkTimeout();
      return Organisation.findByPk(parent.organisation);
    }
  }
};
