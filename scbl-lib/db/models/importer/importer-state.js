import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The ban importer's own state, as one JSON value per name, such as the record of its latest run.
// The importer makes this table with its migrations, so the model is never synced. The web server
// and the bot write one row of it too, lastLogMessage (see scbl-lib/db/log-channel.js).
export default sequelize.define(
  'ImporterState',
  {
    // Not "key", which is a reserved word in MySQL.
    name: {
      type: DataTypes.STRING(64),
      primaryKey: true
    },
    value: {
      type: DataTypes.JSON,
      allowNull: false
    },
    updatedAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    }
  },
  { tableName: 'ImporterState', createdAt: false }
);
