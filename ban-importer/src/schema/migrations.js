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
  }
];
