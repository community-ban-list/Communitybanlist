import { Organisation } from 'scbl-lib/db/models';

export default {
  BanList: {
    organisation: (parent, args, context) => {
      context.checkTimeout();
      return Organisation.findByPk(parent.organisation);
    }
  }
};
