import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The ban lists an admin has paused, one row each: suspended, so the importer does not import the
// list and its bans count for nothing, or resuming, so the importer imports it again while its bans
// still count for nothing, until it has caught up with the list. A list's row is deleted with the
// list. The importer makes this table with its migrations, so the model is never synced. The bot
// adds the rows, sets resumedAt, and suspends a resuming list again, and the importer deletes them
// (see scbl-lib/db/ban-list-suspensions.js).
export default sequelize.define(
  'BanListSuspension',
  {
    // The ban list, by BanLists.id.
    banList: {
      type: DataTypes.INTEGER,
      primaryKey: true
    },
    // When the list was suspended, by whom, as the bot's audit line names them, and why, if given.
    suspendedAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    },
    suspendedBy: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    reason: {
      type: DataTypes.STRING(500)
    },
    // When the list was resumed, or NULL while it is suspended.
    resumedAt: {
      type: DataTypes.DATE(3)
    }
  },
  { tableName: 'BanListSuspensions', timestamps: false }
);
