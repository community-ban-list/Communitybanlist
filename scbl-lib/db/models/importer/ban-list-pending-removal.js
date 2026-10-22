import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The bans a complete read of their ban list no longer had, which the ban importer removes only once
// a later complete read, at least 10 minutes on, still does not have them. A ban that comes back
// loses its row. A list's rows are deleted with the list. The importer makes this table with its
// migrations, so the model is never synced.
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
    }
  },
  { tableName: 'BanListPendingRemovals', timestamps: false }
);
