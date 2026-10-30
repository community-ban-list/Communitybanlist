// The ban importer's migrations, which make and change the tables the importer owns, in the order
// they are applied. Each one is applied once to a database, while the importer holds its run lock,
// and recorded in ImporterSchemaMigrations by its id. New migrations are only ever added at the
// end, and a migration is never changed once it has been released.
//
// They follow these rules:
// - They never change an existing table's columns, ENUMs or indexes. Every service's connect()
//   syncs the CBL's own models, without altering their tables, so a column a model declared but its
//   table lacked would break every query on that table, and an index declared in a model would be
//   added by whichever service started first.
// - They make tables with explicit DDL, never by syncing a model. MySQL commits each DDL statement
//   at once, so a migration cut short is run again in full by the next run, and each statement must
//   be safe to run again.
// - New tables use the character set and collation of the CBL's existing tables.
// - Foreign keys only refer to INT keys, such as BanLists.id. A column that refers to a VARCHAR key,
//   such as a Steam user's ID, is a plain column with the character set and collation of the
//   column it refers to, and is compared in JavaScript, never joined on.
// - A rollback to an older importer leaves the tables in place, and the older importer ignores
//   them.
//
// up(query) runs a migration, with query(sql, values) running each statement on the migration
// connection, which resolves with mysql2's [rows, fields].

// Names read from information_schema go into DDL, which cannot take them as parameters, so they are
// checked first.
const NAME = /^[A-Za-z0-9_]+$/;

// The table options for a new table: InnoDB, with the character set and collation of the CBL's
// existing tables, read from the Bans table, or the database's defaults if there is no Bans table.
async function tableOptions(query) {
  let [rows] = await query(
    `SELECT C.CHARACTER_SET_NAME AS characterSet, C.COLLATION_NAME AS collationName
     FROM information_schema.TABLES T
     JOIN information_schema.COLLATIONS C ON C.COLLATION_NAME = T.TABLE_COLLATION
     WHERE T.TABLE_SCHEMA = DATABASE() AND T.TABLE_NAME = 'Bans'`
  );
  if (rows.length === 0)
    [rows] = await query(
      `SELECT DEFAULT_CHARACTER_SET_NAME AS characterSet, DEFAULT_COLLATION_NAME AS collationName
       FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME = DATABASE()`
    );

  const [{ characterSet, collationName } = {}] = rows;
  if (!NAME.test(characterSet) || !NAME.test(collationName))
    throw new Error('Could not read the character set and collation of the existing tables.');
  return `ENGINE=InnoDB DEFAULT CHARSET=${characterSet} COLLATE=${collationName}`;
}

// An integer column type as information_schema writes it, e.g. int or int unsigned.
const INTEGER_TYPE = /^(tiny|small|medium|big)?int(\(\d+\))?( unsigned)?$/i;

// The type of an existing table's INT key, which a foreign key to it must have too, as Sequelize
// made it: int for the CBL's own tables.
async function keyType(query, table) {
  const [[{ columnType } = {}]] = await query(
    `SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'`,
    [table]
  );
  if (!INTEGER_TYPE.test(columnType ?? ''))
    throw new Error(`Could not read the type of ${table}.id, which a foreign key refers to.`);
  return columnType;
}

// A VARCHAR column type as information_schema writes it, e.g. varchar(255).
const VARCHAR_TYPE = /^varchar\(\d+\)$/i;

// The type, character set and collation of an existing table's VARCHAR column, as a column that
// refers to it must have them, so that the two compare as equal.
async function textColumnType(query, table, column) {
  const [[{ columnType, characterSet, collationName } = {}]] = await query(
    `SELECT COLUMN_TYPE AS columnType, CHARACTER_SET_NAME AS characterSet,
       COLLATION_NAME AS collationName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (
    !VARCHAR_TYPE.test(columnType ?? '') ||
    !NAME.test(characterSet ?? '') ||
    !NAME.test(collationName ?? '')
  )
    throw new Error(`Could not read the type of ${table}.${column}, which a column refers to.`);
  return `${columnType} CHARACTER SET ${characterSet} COLLATE ${collationName}`;
}

export default [
  {
    // The table of applied migrations, and ImporterState, which holds the importer's own state,
    // such as the record of its runs.
    id: '001-importer-state',
    async up(query) {
      const options = await tableOptions(query);
      await query(
        `CREATE TABLE IF NOT EXISTS ImporterSchemaMigrations (
          id VARCHAR(64) NOT NULL,
          appliedAt DATETIME(3) NOT NULL,
          PRIMARY KEY (id)
        ) ${options}`
      );
      await query(
        `CREATE TABLE IF NOT EXISTS ImporterState (
          name VARCHAR(64) NOT NULL,
          value JSON NOT NULL,
          updatedAt DATETIME(3) NOT NULL,
          PRIMARY KEY (name)
        ) ${options}`
      );
    }
  },
  {
    // BanListSyncs, which keeps each ban list's sync state between runs: the state of its import,
    // how its latest attempts went and how many bans it has, with the columns later versions need
    // to read only what changed on a list. A list's row is deleted with the list, as the bot
    // deletes ban lists without knowing of this table, so banList has the type of BanLists.id,
    // which its foreign key needs. The state is a VARCHAR rather than an ENUM, so a new state needs
    // no change to the table.
    id: '002-ban-list-syncs',
    async up(query) {
      const options = await tableOptions(query);
      const banListType = await keyType(query, 'BanLists');
      await query(
        `CREATE TABLE IF NOT EXISTS BanListSyncs (
          banList ${banListType} NOT NULL,
          sourceKey CHAR(64) NULL,
          state VARCHAR(16) NOT NULL DEFAULT 'ok',
          lastAttemptAt DATETIME(3) NULL,
          lastSuccessAt DATETIME(3) NULL,
          lastHeadPollAt DATETIME(3) NULL,
          lastFullScanAt DATETIME(3) NULL,
          nextFullScanAt DATETIME(3) NULL,
          scanReason VARCHAR(32) NULL,
          consecutiveFailures INT UNSIGNED NOT NULL DEFAULT 0,
          incompleteScans INT UNSIGNED NOT NULL DEFAULT 0,
          lastError VARCHAR(500) NULL,
          storedCount INT UNSIGNED NULL,
          headTotal INT UNSIGNED NULL,
          headUids TEXT NULL,
          replacePending TINYINT(1) NOT NULL DEFAULT 0,
          allowFullRemovalUntil DATETIME(3) NULL,
          remoteEtag VARCHAR(255) NULL,
          remoteLastModified VARCHAR(64) NULL,
          remoteBodyHash CHAR(64) NULL,
          updatedAt DATETIME(3) NOT NULL,
          PRIMARY KEY (banList),
          CONSTRAINT BanListSyncs_banList FOREIGN KEY (banList) REFERENCES BanLists (id)
            ON DELETE CASCADE
        ) ${options}`
      );
    }
  },
  {
    // BanListPendingRemovals, which keeps the bans that a complete read of their ban list no longer
    // had, until a later complete read shows they are gone, and the bans held for an admin, as their
    // list seemed to have lost all of them, with when that began (heldAt). A list's rows are
    // deleted with the list, so banList has the type of BanLists.id, which its foreign key needs.
    // banId refers to Bans.id, which is a VARCHAR, so it is a plain column with the type, character
    // set and collation of Bans.id.
    id: '003-ban-list-pending-removals',
    async up(query) {
      const options = await tableOptions(query);
      const banListType = await keyType(query, 'BanLists');
      const banIdType = await textColumnType(query, 'Bans', 'id');
      await query(
        `CREATE TABLE IF NOT EXISTS BanListPendingRemovals (
          banList ${banListType} NOT NULL,
          banId ${banIdType} NOT NULL,
          firstMissingAt DATETIME(3) NOT NULL,
          lastMissingAt DATETIME(3) NOT NULL,
          heldAt DATETIME(3) NULL,
          PRIMARY KEY (banList, banId),
          CONSTRAINT BanListPendingRemovals_banList FOREIGN KEY (banList) REFERENCES BanLists (id)
            ON DELETE CASCADE
        ) ${options}`
      );
    }
  },
  {
    // BanListSuspensions, which keeps the ban lists an admin has paused, one row each: suspended,
    // as resumedAt is NULL, or resuming, once it is set, until the importer has caught up with the
    // list and deletes the row (see scbl-lib/db/ban-list-suspensions.js). The bot adds the rows and
    // sets or clears resumedAt. A list's row is deleted with the list, as the bot deletes ban lists
    // without knowing of this table, so banList has the type of BanLists.id, which its foreign key
    // needs.
    id: '004-ban-list-suspensions',
    async up(query) {
      const options = await tableOptions(query);
      const banListType = await keyType(query, 'BanLists');
      await query(
        `CREATE TABLE IF NOT EXISTS BanListSuspensions (
          banList ${banListType} NOT NULL,
          suspendedAt DATETIME(3) NOT NULL,
          suspendedBy VARCHAR(100) NOT NULL,
          reason VARCHAR(500) NULL,
          resumedAt DATETIME(3) NULL,
          PRIMARY KEY (banList),
          CONSTRAINT BanListSuspensions_banList FOREIGN KEY (banList) REFERENCES BanLists (id)
            ON DELETE CASCADE
        ) ${options}`
      );
    }
  },
  {
    // BanListHolds, which keeps why the importer holds a ban list's bans for an admin, one row a
    // list while it does: 'full', as a read found none of the list's bans, or 'large', as a read
    // lost a large part of them at once, with how many bans the list had before that read
    // (storedCount), which a 'large' hold's bans still missing are measured against, lowered as the
    // list shrinks while the hold lasts.
    // BanListPendingRemovals keeps the held bans themselves, but not which hold began, so the runs
    // after the one that began it read that here. A list's row is deleted with the list, so banList
    // has the type of BanLists.id, which its foreign key needs. The reason is a VARCHAR rather than
    // an ENUM, so a new reason needs no change to the table.
    id: '005-ban-list-holds',
    async up(query) {
      const options = await tableOptions(query);
      const banListType = await keyType(query, 'BanLists');
      await query(
        `CREATE TABLE IF NOT EXISTS BanListHolds (
          banList ${banListType} NOT NULL,
          reason VARCHAR(16) NOT NULL,
          storedCount INT UNSIGNED NOT NULL,
          PRIMARY KEY (banList),
          CONSTRAINT BanListHolds_banList FOREIGN KEY (banList) REFERENCES BanLists (id)
            ON DELETE CASCADE
        ) ${options}`
      );
    }
  }
];
