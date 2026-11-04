import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The bans a complete read of their ban list no longer had, which the ban importer removes only once
// a later complete read, at least 10 minutes on, still does not have them, and the bans it holds
// for an admin, as their list seemed to have lost all of them, or a large part of them at once
// (see BanListHolds). A ban that comes back loses its row. A list's rows are deleted with the
// list. The importer makes this table with its migrations, so the model is never synced.
export default sequelize.define(
  'BanListPendingRemoval',
  {
    // The ban list, by BanLists.id.
    banList: {
      type: DataTypes.INTEGER,
      primaryKey: true
    },
    // The ban, by Bans.id. It is not a foreign key, as Bans.id is not an INT.
    banId: {
      type: DataTypes.STRING(255),
      primaryKey: true
    },
    // When a complete read of the list first, and last, did not have the ban.
    firstMissingAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    },
    lastMissingAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    },
    // When the importer began holding the ban for an admin, as a complete read of its list had none
    // of the list's bans, or lost a large part of them at once, or NULL for a ban that only waits
    // for a later complete read.
    heldAt: {
      type: DataTypes.DATE(3),
      allowNull: true
    }
  },
  { tableName: 'BanListPendingRemovals', timestamps: false }
);
