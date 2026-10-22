import BanListPendingRemoval from './ban-list-pending-removal.js';
import BanListSync from './ban-list-sync.js';
import ImporterSchemaMigration from './importer-schema-migration.js';
import ImporterState from './importer-state.js';

// The models of the tables the ban importer makes and owns. Unlike the CBL's other models, they are
// never synced, and connect() leaves them alone, so the web server and the bot never make or change
// these tables. The importer makes them with its migrations, while it holds its run lock, and then
// checks that every column of these models is in the database.
const IMPORTER_MODELS = [
  ImporterSchemaMigration,
  ImporterState,
  BanListSync,
  BanListPendingRemoval
];

export {
  BanListPendingRemoval,
  BanListSync,
  IMPORTER_MODELS,
  ImporterSchemaMigration,
  ImporterState
};
