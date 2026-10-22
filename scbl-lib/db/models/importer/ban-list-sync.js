import Sequelize from 'sequelize';

import sequelize from '../../sequelize.js';

const { DataTypes } = Sequelize;

// What the ban importer keeps about each ban list between runs: the state of its import, how its
// latest attempts went, and how many bans it has here and on BattleMetrics. The columns for reading
// only what changed on a list come with it, for later versions of the importer. A list's row is
// deleted with the list. The importer makes this table with its migrations, so the model is never
// synced.
export default sequelize.define(
  'BanListSync',
  {
    // The ban list, by BanLists.id.
    banList: {
      type: DataTypes.INTEGER,
      primaryKey: true
    },
    // A SHA-256 of the list's type and source, so a list whose source was changed starts afresh.
    sourceKey: {
      type: DataTypes.CHAR(64)
    },
    // ok, failing, access_lost (CBL cannot read the list on BattleMetrics, or BattleMetrics does not
    // list it among those CBL can see), self_import (the list's source is one of CBL's own export
    // ban lists) or held (some of the bans the list no longer has were kept until their removal is
    // confirmed).
    state: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'ok'
    },
    // When the list was last fetched, and when it was last fetched in full and its bans saved.
    lastAttemptAt: {
      type: DataTypes.DATE(3)
    },
    lastSuccessAt: {
      type: DataTypes.DATE(3)
    },
    // When the newest page of the list was last read, and when all of it was last read and is next
    // due to be, and why.
    lastHeadPollAt: {
      type: DataTypes.DATE(3)
    },
    lastFullScanAt: {
      type: DataTypes.DATE(3)
    },
    nextFullScanAt: {
      type: DataTypes.DATE(3)
    },
    scanReason: {
      type: DataTypes.STRING(32)
    },
    // How many runs in a row the list failed to import, and how many reads of all of it in a row
    // came back incomplete.
    consecutiveFailures: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    incompleteScans: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    // What went wrong with the list's latest import, or why CBL cannot read it, on one line, without
    // addresses or keys. It is for the CBL's admins, and is never shown on the website.
    lastError: {
      type: DataTypes.STRING(500)
    },
    // The bans the list has here, and BattleMetrics' count of its bans on the first page of the
    // latest fetch.
    storedCount: {
      type: DataTypes.INTEGER.UNSIGNED
    },
    headTotal: {
      type: DataTypes.INTEGER.UNSIGNED
    },
    // The IDs of the bans on the newest page of the list, at most 100.
    headUids: {
      type: DataTypes.TEXT
    },
    // Whether the list's bans are to be replaced by those of its new source.
    replacePending: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    // Until when the list may lose all of its bans, as an admin confirmed that it really did.
    allowFullRemovalUntil: {
      type: DataTypes.DATE(3)
    },
    // A remote list's ETag, Last-Modified and SHA-256 when it was last downloaded.
    remoteEtag: {
      type: DataTypes.STRING(255)
    },
    remoteLastModified: {
      type: DataTypes.STRING(64)
    },
    remoteBodyHash: {
      type: DataTypes.CHAR(64)
    },
    updatedAt: {
      type: DataTypes.DATE(3),
      allowNull: false
    }
  },
  { tableName: 'BanListSyncs', createdAt: false }
);
