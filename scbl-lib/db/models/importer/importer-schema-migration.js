import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// The ban importer's migrations that have been applied to the database, by id. The importer makes
// this table, like its other tables, with its migrations (in ban-importer/src/schema), so the model
// is never synced.
export default sequelize.define(
  'ImporterSchemaMigration',
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true
    },
    appliedAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    }
  },
  { tableName: 'ImporterSchemaMigrations', timestamps: false }
);
