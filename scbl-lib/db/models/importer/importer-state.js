import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The ban importer's own state, as one JSON value per name, such as the record of its latest run.
// The importer makes this table with its migrations, so the model is never synced. The web server
// and the bot write two rows of it too, lastLogMessage (see scbl-lib/db/log-channel.js) and floors
// (see scbl-lib/db/floors.js). The row features:importer, in the same file, is the importer's own.
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
