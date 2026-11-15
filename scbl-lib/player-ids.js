// What a player's ID is: the rule the importer goes by as it reads ban lists and refreshes Steam
// profiles, the bot as it checks a ban list or a new owner, the export ban lists as they decide who
// can be on them, and the website as it looks a player up. There are two kinds of ID:
// - steam: a SteamID64, the 17 digits of a Steam account.
// - eos: an EOS ID, the 32 lowercase hexadecimal characters of an Epic Online Services account.
//
// This file has no imports, so it can be loaded on its own. The website loads it too, so its regular
// expressions have no lookbehind, which Safari before 16.4 cannot read: where an ID must not follow a
// certain character, the character before it, if any, is matched instead.

// The SteamID64s of players' Steam accounts: account numbers 1 to 4,294,967,295 in Steam's public
// universe. All of them have 17 digits, so comparing them as text compares them as numbers.
const MIN_STEAM_ID = '76561197960265729';
const MAX_STEAM_ID = '76561202255233023';

// An EOS ID as CBL stores it. MySQL compares player IDs without regard to case and JavaScript does
// not, so an EOS ID is lowercased wherever it comes in, and one in capitals is not yet a stored one.
const STORED_EOS_ID = /^[0-9a-f]{32}$/;

// A ban in a remote ban list: an ID, its expiry and its reason, as `ID:expiry //reason`, with or
// without anything before it on the line, such as `Admin [SteamID 76561197960265729] Banned:`. An
// EOS ID is not part of a longer hexadecimal value, and a SteamID not part of a longer number. The
// first ban on the line counts, so the last 17 characters of an EOS ID that end in digits are never
// taken for a SteamID, as the EOS ID starts first. Each kind has its own expression, and the ban
// whose ID starts first is the one on the line.
const REMOTE_EOS_BAN = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32}):([0-9]+) ?\/\/(.+)/;
const REMOTE_STEAM_BAN = /(?:^|[^0-9])([0-9]{17}):([0-9]+) ?\/\/(.+)/;

// The SteamID64 in a value, such as a SteamID on its own or in a profile's address, or null. It is a
// run of exactly 17 digits, not part of a longer number, that is a player's account. Anything else,
// e.g. a longer number or one outside that range, is not a SteamID Steam can know, and would only
// make a player that is never found. Spaces around the value, and the case of an address, make no
// difference.
export function findSteamIDIn(value) {
  const match = /(?:^|[^0-9])([0-9]{17})(?![0-9])/.exec(String(value ?? ''));
  if (!match) return null;
  const [, id] = match;
  return id >= MIN_STEAM_ID && id <= MAX_STEAM_ID ? id : null;
}

// Whether a player's ID is a SteamID64 of a player's account and nothing else, as findSteamIDIn
// finds it, so that Steam can be asked for its profile. A player saved before SteamIDs were
// checked may have an ID that is not, such as a profile's address.
export function isSteamID(id) {
  return typeof id === 'string' && findSteamIDIn(id) === id;
}

// The EOS ID a value holds, as CBL stores it, or null. Spaces around it and its case make no
// difference. The whole value must be the ID, so a masked or shortened one is not an EOS ID.
export function normaliseEosID(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return STORED_EOS_ID.test(id) ? id : null;
}

// The kind of ID a player's row has, 'steam' or 'eos', or null for anything else. An ID must be
// exactly as CBL stores it, unlike the values normaliseEosID takes.
export function accountKind(id) {
  if (isSteamID(id)) return 'steam';
  return typeof id === 'string' && STORED_EOS_ID.test(id) ? 'eos' : null;
}

// A Steam profile's address by its SteamID64, with or without https:// and www., and a final slash.
const STEAM_PROFILE = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/profiles\/([0-9]{17})\/?$/i;

// The player someone means by what they typed to look one up, as { kind, id } with the ID as CBL
// stores it, or null when it is neither kind of ID. Spaces around it make no difference. A Steam
// profile's address gives its SteamID64. 32 hexadecimal characters give an EOS ID, lowercased,
// although an Epic account ID looks the same: only the lookup can tell them apart.
export function parsePlayerInput(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const steamID = STEAM_PROFILE.exec(value)?.[1] ?? value;
  if (isSteamID(steamID)) return { kind: 'steam', id: steamID };
  const eosID = normaliseEosID(value);
  return eosID ? { kind: 'eos', id: eosID } : null;
}

// The SQL conditions that hold when a column has an ID of each kind, exactly when accountKind says
// so. The column is the name of a column, written by the code that calls these, and never a value.
// - The length is checked as well, as a regular expression's $ also matches before a final line
//   break.
// - The digits are checked as well as the range of a SteamID64, as MySQL compares text, and so
//   7656119796026573a is within the range.
// - The 'c' makes the expression case-sensitive, as the columns are not.
export function steamIDSQL(column) {
  return `(CHAR_LENGTH(${column}) = 17 AND ${column} BETWEEN '${MIN_STEAM_ID}' AND '${MAX_STEAM_ID}' AND REGEXP_LIKE(${column}, '^[0-9]{17}$', 'c'))`;
}
export function eosIDSQL(column) {
  return `(CHAR_LENGTH(${column}) = 32 AND REGEXP_LIKE(${column}, '^[0-9a-f]{32}$', 'c'))`;
}

// The ban on a line of a remote ban list, as { kind, value, expires, reason }, or null when the line
// has none. The kind is 'steam' or 'eos' and the value is the ID, as accountKind takes it. The
// expiry is its digits as the line gives them, 0 for a ban that never expires. A line with a number
// of 17 digits that is not a player's account has no ban.
export function parseRemoteLine(line) {
  const text = String(line ?? '');
  const eos = REMOTE_EOS_BAN.exec(text);
  const steam = REMOTE_STEAM_BAN.exec(text);
  const match = eos && (!steam || idStart(eos) < idStart(steam)) ? eos : steam;
  if (!match) return null;
  const kind = match === eos ? 'eos' : 'steam';
  const [, id, expires, reason] = match;
  const value = kind === 'eos' ? normaliseEosID(id) : findSteamIDIn(id);
  return value ? { kind, value, expires, reason } : null;
}

// Where the ID of a remote ban list's match starts: after the character matched before it, if any.
// That character is never the ID's first, as it cannot be part of the ID.
function idStart(match) {
  return match.index + (match[0].startsWith(match[1]) ? 0 : 1);
}
