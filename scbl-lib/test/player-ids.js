import assert from 'assert';
import { readFile } from 'fs/promises';

import {
  accountKind,
  eosIDSQL,
  findSteamIDIn,
  isSteamID,
  normaliseEosID,
  parsePlayerInput,
  parseRemoteLine,
  steamIDSQL
} from '../player-ids.js';

// Checks for the rule on what a player's ID is. It has no imports, so anything can load it, and the
// package exports it, so the services can.
const source = await readFile(new URL('../player-ids.js', import.meta.url), 'utf8');
assert.ok(!/^\s*import\b/m.test(source));
assert.strictEqual((await import('scbl-lib/player-ids')).accountKind, accountKind);

const FIRST = '76561197960265729';
const LAST = '76561202255233023';
const EOS = '0123456789abcdef0123456789abcdef';

// A SteamID64 is found on its own or in an address, with spaces around it. Only players' accounts
// count, so the numbers just outside the range do not, nor does a longer number or a shorter one.
assert.strictEqual(findSteamIDIn(FIRST), FIRST);
assert.strictEqual(findSteamIDIn(LAST), LAST);
assert.strictEqual(findSteamIDIn(` ${FIRST}\n`), FIRST);
assert.strictEqual(findSteamIDIn(`https://steamcommunity.com/profiles/${FIRST}/`), FIRST);
for (const value of [
  '76561197960265728',
  '76561202255233024',
  `${FIRST}0`,
  `0${FIRST}`,
  FIRST.slice(1),
  '',
  null,
  undefined
])
  assert.strictEqual(findSteamIDIn(value), null, String(value));

// An ID is a SteamID only when it is nothing else, and text.
assert.strictEqual(isSteamID(FIRST), true);
assert.strictEqual(isSteamID(LAST), true);
for (const id of [` ${FIRST}`, `${FIRST}\n`, `steam${FIRST}`, Number(FIRST), null, undefined, EOS])
  assert.strictEqual(isSteamID(id), false, String(id));

// An EOS ID is 32 hexadecimal characters, lowercased, with no spaces around it. A value that is
// masked, shortened, longer or not text is not one.
assert.strictEqual(normaliseEosID(EOS), EOS);
assert.strictEqual(normaliseEosID(EOS.toUpperCase()), EOS);
assert.strictEqual(normaliseEosID(` ${EOS}\n`), EOS);
for (const value of [
  EOS.slice(1),
  `${EOS}0`,
  `${EOS.slice(0, 8)}${'*'.repeat(24)}`,
  `eos:${EOS}`,
  `${EOS} ${EOS}`,
  FIRST,
  '',
  null,
  undefined,
  32,
  [EOS]
])
  assert.strictEqual(normaliseEosID(value), null, String(value));

// A row's kind goes by its ID exactly as CBL stores it.
const KINDS = [
  [FIRST, 'steam'],
  [LAST, 'steam'],
  [EOS, 'eos'],
  // All digits is still an EOS ID at 32 characters.
  ['0'.repeat(32), 'eos'],
  // Just outside a SteamID64's range.
  ['76561197960265728', null],
  ['76561202255233024', null],
  // Within the range as text, but not a number.
  ['7656119796026573a', null],
  // An EOS ID in capitals is not as CBL stores it.
  [EOS.toUpperCase(), null],
  [`${FIRST}\n`, null],
  [`${EOS}\n`, null],
  [` ${FIRST}`, null],
  ['https://steamcommunity.com/profiles/76561197960265729', null],
  ['', null]
];
for (const [id, kind] of KINDS) assert.strictEqual(accountKind(id), kind, JSON.stringify(id));
for (const id of [null, undefined, Number(FIRST)]) assert.strictEqual(accountKind(id), null);

// What someone types to look a player up: a SteamID64 or a Steam profile's address gives the
// SteamID64, and 32 hexadecimal characters an EOS ID as CBL stores it, with spaces around either.
const steam = (id) => ({ kind: 'steam', id });
const eos = (id) => ({ kind: 'eos', id });
for (const [text, player] of [
  [FIRST, steam(FIRST)],
  [` ${LAST}\n`, steam(LAST)],
  [`https://steamcommunity.com/profiles/${FIRST}`, steam(FIRST)],
  [`https://steamcommunity.com/profiles/${FIRST}/`, steam(FIRST)],
  [`HTTP://WWW.SteamCommunity.com/profiles/${FIRST}`, steam(FIRST)],
  [`steamcommunity.com/profiles/${FIRST}`, steam(FIRST)],
  [` https://www.steamcommunity.com/profiles/${LAST}/ `, steam(LAST)],
  [EOS, eos(EOS)],
  [EOS.toUpperCase(), eos(EOS)],
  [`\t${EOS} `, eos(EOS)],
  ['0'.repeat(32), eos('0'.repeat(32))]
])
  assert.deepStrictEqual(parsePlayerInput(text), player, JSON.stringify(text));
// Anything else is no player: a number outside the range, or not 17 digits, a profile's address
// with a vanity name, anything after the SteamID, another site or a SteamID in other text, an EOS
// ID that is masked, shortened or in an address, and anything that is not text.
for (const text of [
  '76561197960265728',
  '76561202255233024',
  FIRST.slice(1),
  `${FIRST}0`,
  'https://steamcommunity.com/profiles/76561197960265728',
  'https://steamcommunity.com/id/someone',
  `https://steamcommunity.com/profiles/${FIRST}/friends`,
  `https://steamcommunity.com/profiles/${FIRST}?l=english`,
  `https://example.com/steamcommunity.com/profiles/${FIRST}`,
  `https://steamcommunity.com.example.com/profiles/${FIRST}`,
  `ftp://steamcommunity.com/profiles/${FIRST}`,
  `Banned ${FIRST}`,
  `${FIRST} ${FIRST}`,
  `${EOS.slice(0, 8)}${'*'.repeat(24)}`,
  EOS.slice(1),
  `${EOS}0`,
  `eos:${EOS}`,
  `https://communitybanlist.com/search/${EOS}`,
  '',
  '   ',
  null,
  undefined,
  Number(FIRST),
  [FIRST]
])
  assert.strictEqual(parsePlayerInput(text), null, JSON.stringify(text));

// The SQL conditions are pinned, as the tests have no database. Each was run against every ID in
// KINDS on MySQL 8.0 when it was written, and agreed with accountKind on all of them.
assert.strictEqual(
  steamIDSQL('B.steamUser'),
  `(CHAR_LENGTH(B.steamUser) = 17 AND B.steamUser BETWEEN '${FIRST}' AND '${LAST}' AND REGEXP_LIKE(B.steamUser, '^[0-9]{17}$', 'c'))`
);
assert.strictEqual(
  eosIDSQL('B.steamUser'),
  "(CHAR_LENGTH(B.steamUser) = 32 AND REGEXP_LIKE(B.steamUser, '^[0-9a-f]{32}$', 'c'))"
);

// The ban on a line of a remote ban list: a SteamID's, with or without a space before the reason or
// anything before the ID, and with the expiry as the line gives it.
const ban = (kind, value, expires, reason) => ({ kind, value, expires, reason });
assert.deepStrictEqual(
  parseRemoteLine(`${FIRST}:0 //Cheating`),
  ban('steam', FIRST, '0', 'Cheating')
);
assert.deepStrictEqual(
  parseRemoteLine(`${FIRST}:946684800//Old`),
  ban('steam', FIRST, '946684800', 'Old')
);
assert.deepStrictEqual(
  parseRemoteLine(`Admin [SteamID ${LAST}] Banned:${FIRST}:0 //Banned by an admin`),
  ban('steam', FIRST, '0', 'Banned by an admin')
);

// An EOS ID's, lowercased, in any case and with or without Squad's prefix.
assert.deepStrictEqual(parseRemoteLine(`${EOS}:0 //Cheating`), ban('eos', EOS, '0', 'Cheating'));
assert.deepStrictEqual(
  parseRemoteLine(`${EOS.toUpperCase()}:0 //Caps`),
  ban('eos', EOS, '0', 'Caps')
);
assert.deepStrictEqual(
  parseRemoteLine(`N/A Banned:${EOS}:0 //Banned`),
  ban('eos', EOS, '0', 'Banned')
);

// An EOS ID whose last 17 characters are a SteamID's digits stays an EOS ID.
const tail = `${'a'.repeat(15)}${FIRST}`;
assert.deepStrictEqual(parseRemoteLine(`${tail}:0 //Tail`), ban('eos', tail, '0', 'Tail'));

// A SteamID is a SteamID after anything but a digit, letters included, even when with them it is too
// long to be an EOS ID.
for (const before of ['Banned', 'f', 'ABC', 'a'.repeat(16)])
  assert.deepStrictEqual(
    parseRemoteLine(`${before}${FIRST}:0 //After letters`),
    ban('steam', FIRST, '0', 'After letters'),
    before
  );

// The first ban on a line is the one that counts, so a SteamID's in an EOS ID ban's reason is not.
assert.deepStrictEqual(
  parseRemoteLine(`${EOS}:0 //Alt of ${FIRST}:0 //Inner`),
  ban('eos', EOS, '0', `Alt of ${FIRST}:0 //Inner`)
);

// No ban: a line that is something else, or is missing a part, or a number that is not an account,
// or an ID that is part of something longer.
for (const line of [
  '',
  'Not a ban',
  `${FIRST}:0`,
  `${FIRST} //No expiry`,
  `${FIRST}:0 //`,
  `${EOS}:0`,
  '76561197960265728:0 //Below the range',
  '12345678901234567:0 //Not an account',
  `1${FIRST}:0 //A longer number`,
  `a${EOS}:0 //A longer value`,
  `A${EOS}:0 //A longer value in capitals`,
  `${EOS.slice(1)}:0 //A shorter value`,
  null,
  undefined
])
  assert.strictEqual(parseRemoteLine(line), null, String(line));

console.log(
  'Player ID checks passed: SteamIDs, EOS IDs, kinds, lookups, SQL and remote ban lines.'
);
