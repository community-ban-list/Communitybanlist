import Sequelize from 'sequelize';

import sequelize from '../sequelize.js';

const { DataTypes } = Sequelize;

export default sequelize.define('ExportBanListConfig', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  // A config always has both its points, so Sequelize refuses to save one without them. Tables
  // created before this keep their columns, as sync() does not alter existing tables.
  activePoints: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  expiredPoints: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
});
