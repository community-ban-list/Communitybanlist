import banlist from './banlist.js';
import exportbanlist from './exportbanlist.js';
import org from './org.js';

export default new Map(
  [banlist, exportbanlist, org].map((command) => [command.data.name, command])
);
