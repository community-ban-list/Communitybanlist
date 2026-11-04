import BanListHold from './ban-list-hold.js';
import BanListPendingRemoval from './ban-list-pending-removal.js';
import BanListSuspension from './ban-list-suspension.js';
import BanListSync from './ban-list-sync.js';
import ImporterSchemaMigration from './importer-schema-migration.js';
import ImporterState from './importer-state.js';

// The models of the tables the ban importer makes and owns. Unlike the CBL's other models, they are
// never synced, and connect() leaves them alone. The importer makes them with its migrations, while
// it holds its run lock, and then checks that every column of these models is in the database.
//
// The web server and the bot never make or change these tables. They write only the rows listed
// here, and nothing else in them:
// - ImporterState: the row lastLogMessage, which the web server and the bot write (see
//   scbl-lib/db/log-channel.js).
// - BanListSuspensions: the bot adds rows, sets their resumedAt, and suspends a resuming list again
//   by setting its suspendedAt, suspendedBy and reason anew and clearing its resumedAt; the
//   importer deletes them (see scbl-lib/db/ban-list-suspensions.js). A list's row also goes with
//   the list, by its foreign key, when the bot removes the list.
// A write added later, e.g. by another game's or another ID's admin commands, is listed here too.
const IMPORTER_MODELS = [
  ImporterSchemaMigration,
  ImporterState,
  BanListSync,
  BanListPendingRemoval,
  BanListSuspension,
  BanListHold
];

export {
  BanListHold,
  BanListPendingRemoval,
  BanListSuspension,
  BanListSync,
  IMPORTER_MODELS,
  ImporterSchemaMigration,
  ImporterState
};
