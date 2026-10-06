import banlist from './banlist.js';
import org from './org.js';

export default new Map([banlist, org].map((command) => [command.data.name, command]));
