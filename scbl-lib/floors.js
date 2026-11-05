// What the importer image built from this commit can do, which it says in its heartbeat, and every
// feature the data may ever need of an importer (see db/floors.js). Later versions add to these
// lists as they add features.
//
// This file has no imports, so it can be loaded on its own.

// The features this commit's importer has:
// - native-false: it posts new BattleMetrics export bans with native bans off.
export const IMPORTER_FEATURES = ['native-false'];

// The games whose bans this commit's importer counts.
export const IMPORTER_GAMES = ['squad'];

// Every name that can be raised as a floor. A name not listed here is refused when it is raised, as
// an importer that does not know a name in its floor stops every step:
// - game-rule: a rule, which a later version adds, for counting bans by game;
// - native-false, as above.
export const KNOWN_FEATURES = ['game-rule', 'native-false'];
