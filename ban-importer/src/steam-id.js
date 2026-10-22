// Which values are SteamIDs of players' Steam accounts. The fetcher takes players' SteamIDs from
// bans with it, and the Steam step sends Steam only the IDs it accepts.
//
// This file has no imports, so it can be loaded on its own.

// The SteamID64s of players' Steam accounts: account numbers 1 to 4,294,967,295 in Steam's public
// universe.
const MIN_STEAM_ID = 76561197960265729n;
const MAX_STEAM_ID = 76561202255233023n;

// The SteamID64 in a value, such as a SteamID on its own or in a profile's address, or null. It is a
// run of exactly 17 digits, not part of a longer number, that is a player's account. Anything else,
// e.g. a longer number or one outside that range, is not a SteamID Steam can know, and would only
// make a player that is never found. Spaces around the value, and the case of an address, make no
// difference.
export function findSteamIDIn(value) {
  const match = /(?<![0-9])[0-9]{17}(?![0-9])/.exec(String(value ?? ''));
  if (!match) return null;
  const steamID = BigInt(match[0]);
  return steamID >= MIN_STEAM_ID && steamID <= MAX_STEAM_ID ? match[0] : null;
}

// Whether a player's ID is a SteamID64 of a player's account and nothing else, as findSteamIDIn
// finds it, so that Steam can be asked for its profile. A player saved before SteamIDs were
// checked may have an ID that is not, such as a profile's address.
export function isSteamID(id) {
  return typeof id === 'string' && findSteamIDIn(id) === id;
}
