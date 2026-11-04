import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// Why the ban importer holds a ban list's bans for an admin, one row a list while it does, which
// the runs after the one that began the hold read to say which hold it is, and how long it lasts.
// The held bans themselves are in BanListPendingRemovals. A list's row is deleted with the list.
// The importer makes this table with its migrations, so the model is never synced, and is the only
// one that writes it.
export default sequelize.define(
  'BanListHold',
  {
    // The ban list, by BanLists.id.
    banList: {
      type: DataTypes.INTEGER,
      primaryKey: true
    },
    // 'full', as a complete read of the list found none of its bans, or 'large', as one found a
    // large part of them missing at once.
    reason: {
      type: DataTypes.STRING(16),
      allowNull: false
    },
    // The bans the list had before the read that began the hold. A 'large' hold lasts while its
    // bans still missing are a large part of them, so the list's growth since never ends it, and
    // the importer lowers it as the list shrinks while the hold lasts. A 'large' hold that took in
    // a 'full' one has the bans that hold held.
    storedCount: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false
    }
  },
  { tableName: 'BanListHolds', timestamps: false }
);
