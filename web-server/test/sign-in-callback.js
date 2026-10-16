import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// passport-steam calls the sign-in callback without waiting for it, so a failure the callback did
// not hand to passport would end up here.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const STEAM_API_KEY = 'steam-test-key';
const PLAYER = '76561198000144694';
const OTHER_PLAYER = '76561199999999999';

// The OpenID identifier Steam's sign-in gives a player.
const identifierOf = (steamID) => `https://steamcommunity.com/openid/id/${steamID}`;

// How Steam answers the profile lookup, set by each check: respond(url, options) is given fetch's
// arguments and gives its answer, and abortAfter, when set, makes the lookup's time limit run out
// after that many milliseconds.
let steam;

// The players the database holds, and copies of the records and options of each save and lookup.
// A failure, when set, is thrown instead of saving or looking up.
const database = {
  rows: new Map(),
  saves: [],
  lookups: [],
  saveFailure: null,
  lookupFailure: null
};
const SteamUser = {
  async bulkCreate(records, options) {
    database.saves.push(structuredClone({ records, options }));
    if (database.saveFailure) throw database.saveFailure;
    // As MySQL does: new players are added, and saved ones only get the fields to update.
    for (const record of records) {
      const row = database.rows.get(record.id);
      if (!row) database.rows.set(record.id, { ...record });
      else for (const field of options.updateOnDuplicate) row[field] = record[field];
    }
    return records;
  },
  async findByPk(id, options) {
    database.lookups.push(structuredClone({ id, options }));
    if (database.lookupFailure) throw database.lookupFailure;
    const row = database.rows.get(id);
    if (!row) return null;
    const fields = options?.attributes ?? Object.keys(row);
    return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
  }
};

class SteamStrategy {
  constructor(options, verify) {
    this.options = options;
    this.verify = verify;
  }
}

// Load the sign-in setup as the web server does with this HOST and NODE_ENV, in a context of its
// own, with stubs for passport, passport-steam, the config and the database. The Steam profile
// lookup is the real one, and its requests go to the fetch given to the context, which keeps them.
// Lines the setup logs are kept too.
async function load({ HOST = 'https://cbl.test', NODE_ENV } = {}) {
  const loaded = { strategies: [], logged: [], requests: [], timeouts: [] };
  const log = (...args) => loaded.logged.push(args.join(' '));
  const context = vm.createContext({
    URL,
    console: { log, warn: log, error: log },
    process: { env: { NODE_ENV } },
    AbortSignal: {
      timeout(milliseconds) {
        loaded.timeouts.push(milliseconds);
        return AbortSignal.timeout(steam?.abortAfter ?? milliseconds);
      }
    },
    async fetch(url, options) {
      loaded.requests.push({ url: new URL(url), options });
      return steam.respond(url, options);
    }
  });
  const stubs = {
    'koa-passport': { default: { use: (strategy) => loaded.strategies.push(strategy) } },
    'passport-steam': { default: SteamStrategy },
    'scbl-lib/config': { HOST, STEAM_API_KEY },
    'scbl-lib/db/models': { SteamUser }
  };
  const linker = async (specifier, referencingModule) => {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(url, 'utf8'), {
        context,
        identifier: url.href
      });
    }
    const exports = stubs[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  };
  const url = new URL('../src/auth/passport.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(linker);
  await module.evaluate();

  assert.strictEqual(loaded.strategies.length, 1);
  assert.ok(loaded.strategies[0] instanceof SteamStrategy);
  loaded.strategy = loaded.strategies[0];
  return loaded;
}

// Sign in as passport-steam does, with this identifier and the profile it gives, ignoring what the
// callback returns. Give the calls to done once the callback has called it and has finished.
async function signIn(site, identifier, profile = {}) {
  site.logged.length = 0;
  site.requests.length = 0;
  site.timeouts.length = 0;
  database.saves.length = 0;
  database.lookups.length = 0;

  const calls = [];
  let called;
  const done = new Promise((resolve) => (called = resolve));
  site.strategy.verify(identifier, profile, (...args) => {
    calls.push(args);
    called();
  });
  let timer;
  await Promise.race([done, new Promise((resolve) => (timer = setTimeout(resolve, 2000)))]);
  clearTimeout(timer);
  // Let the callback run on, so a second call to done would show.
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

// Steam's answers to the profile lookup.
function playerSummary(steamid, personaname) {
  return {
    steamid,
    personaname,
    avatar: `https://avatars.example.test/${steamid}.jpg`,
    avatarmedium: `https://avatars.example.test/${steamid}_medium.jpg`,
    avatarfull: `https://avatars.example.test/${steamid}_full.jpg`
  };
}
function answerWith(...players) {
  return { respond: () => Response.json({ response: { players } }) };
}
const steamProfileOf = (steamid, name) => {
  const summary = playerSummary(steamid, name);
  return {
    id: steamid,
    name,
    avatar: summary.avatar,
    avatarMedium: summary.avatarmedium,
    avatarFull: summary.avatarfull
  };
};

// The profile passport-steam used to build from its own lookup, which the callback must not use.
const otherProfile = {
  provider: 'steam',
  id: OTHER_PLAYER,
  displayName: 'Other Player',
  photos: [{ value: 'https://avatars.example.test/other.jpg' }]
};

const site = await load();

// Steam sends players back to the site's sign-in page. The site looks up their name and avatars
// itself, so passport-steam's own lookup is off and is not given the API key.
assert.strictEqual(site.strategy.options.returnURL, 'https://cbl.test/login');
assert.strictEqual(site.strategy.options.realm, 'https://cbl.test');
assert.strictEqual(site.strategy.options.profile, false);
assert.ok(!('apiKey' in site.strategy.options));
assert.deepStrictEqual(site.logged, []);

// A player is signed in with the Steam ID from their sign-in, and with the name and avatars Steam
// gives for that Steam ID, which are saved too, so a renamed player's profile shows the new name.
database.rows.set(PLAYER, {
  id: PLAYER,
  name: 'Old Name',
  avatar: 'https://avatars.example.test/old.jpg',
  avatarMedium: 'https://avatars.example.test/old_medium.jpg',
  avatarFull: 'https://avatars.example.test/old_full.jpg',
  isSCBLUser: false
});
steam = answerWith(playerSummary(OTHER_PLAYER, 'Other Player'), playerSummary(PLAYER, 'New Name'));
let calls = await signIn(site, identifierOf(PLAYER), otherProfile);
const renamed = steamProfileOf(PLAYER, 'New Name');
assert.deepStrictEqual(structuredClone(calls), [[null, renamed]]);
assert.deepStrictEqual(database.rows.get(PLAYER), { ...renamed, isSCBLUser: true });
assert.ok(!database.rows.has(OTHER_PLAYER));
assert.deepStrictEqual(site.logged, []);

// Steam is asked once, over HTTPS, at the host the importer uses, about that player only, with a
// time limit.
assert.strictEqual(site.requests.length, 1);
const [{ url: lookup, options: lookupOptions }] = site.requests;
assert.strictEqual(
  `${lookup.origin}${lookup.pathname}`,
  'https://partner.steam-api.com/ISteamUser/GetPlayerSummaries/v2/'
);
assert.strictEqual(lookup.searchParams.get('steamids'), PLAYER);
assert.strictEqual(lookup.searchParams.get('key'), STEAM_API_KEY);
assert.ok(lookupOptions.signal instanceof AbortSignal);
assert.deepStrictEqual(site.timeouts, [5000]);

// A new player is saved with their Steam name and avatars.
const NEW_PLAYER = '76561198000000001';
steam = answerWith(playerSummary(NEW_PLAYER, 'Test Player'));
calls = await signIn(site, identifierOf(NEW_PLAYER));
assert.deepStrictEqual(structuredClone(calls), [[null, steamProfileOf(NEW_PLAYER, 'Test Player')]]);
assert.deepStrictEqual(database.rows.get(NEW_PLAYER), {
  ...steamProfileOf(NEW_PLAYER, 'Test Player'),
  isSCBLUser: true
});

// A player whose Steam profile has no avatars is signed in, and saved, with none.
steam = answerWith({ steamid: PLAYER, personaname: 'No Avatars' });
calls = await signIn(site, identifierOf(PLAYER));
const withoutAvatars = {
  id: PLAYER,
  name: 'No Avatars',
  avatar: null,
  avatarMedium: null,
  avatarFull: null
};
assert.deepStrictEqual(structuredClone(calls), [[null, withoutAvatars]]);
assert.deepStrictEqual(database.rows.get(PLAYER), { ...withoutAvatars, isSCBLUser: true });

// When the lookup fails, the player is still signed in, with the name and avatars already saved,
// which are left as they are. Steam is asked once, and one line is logged, which never includes the
// API key. This holds when Steam answers about other players only, so nothing of theirs is used.
const saved = {
  id: PLAYER,
  name: 'Saved Name',
  avatar: 'https://avatars.example.test/saved.jpg',
  avatarMedium: 'https://avatars.example.test/saved_medium.jpg',
  avatarFull: 'https://avatars.example.test/saved_full.jpg'
};
function connectionError(message, code) {
  return Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });
}
const unavailable = { respond: () => new Response('Service Unavailable', { status: 503 }) };
const notIncluded = "Steam's player summary did not include the player";
const requestFailed = (why) => `Steam's player summary request failed (${why})`;
// Each failed lookup, and why it failed, as the logged line gives it.
const failedLookups = [
  [answerWith(playerSummary(OTHER_PLAYER, 'Other Player')), notIncluded],
  [answerWith(), notIncluded],
  [answerWith({ steamid: PLAYER }), notIncluded],
  [{ respond: () => Response.json({}) }, notIncluded],
  [{ respond: () => new Response('<html></html>') }, requestFailed('the answer was not JSON')],
  [{ respond: () => new Response('Forbidden', { status: 403 }) }, requestFailed('HTTP 403')],
  [unavailable, requestFailed('HTTP 503')],
  [
    {
      respond: () => {
        throw connectionError('fetch failed', 'EAI_AGAIN');
      }
    },
    requestFailed('EAI_AGAIN')
  ],
  // fetch can give the whole address in its message.
  [
    {
      respond: (url) => {
        throw connectionError(`Failed to parse URL from ${url}`, 'ERR_INVALID_URL');
      }
    },
    requestFailed('ERR_INVALID_URL')
  ],
  // fetch fails with the signal's reason once the time limit runs out.
  [
    {
      abortAfter: 10,
      respond: (url, { signal }) =>
        new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    },
    requestFailed('no answer within 5s')
  ]
];
for (const [answer, reason] of failedLookups) {
  database.rows.set(PLAYER, { ...saved, isSCBLUser: false });
  steam = answer;
  calls = await signIn(site, identifierOf(PLAYER), otherProfile);
  assert.deepStrictEqual(structuredClone(calls), [[null, saved]], `Sign-in after: ${reason}`);
  assert.deepStrictEqual(database.saves, [
    { records: [{ id: PLAYER, isSCBLUser: true }], options: { updateOnDuplicate: ['isSCBLUser'] } }
  ]);
  assert.deepStrictEqual(database.rows.get(PLAYER), { ...saved, isSCBLUser: true });
  assert.ok(!database.rows.has(OTHER_PLAYER));
  assert.strictEqual(site.requests.length, 1, `Steam should be asked once after: ${reason}`);
  assert.deepStrictEqual(site.logged, [
    `Signing in ${PLAYER} with their saved Steam name and avatar: ${reason}`
  ]);
  assert.ok(!site.logged[0].includes(STEAM_API_KEY), `The key was logged after: ${reason}`);
}

// A new player whose lookup fails is signed in, and saved, without a name or avatars.
const UNSAVED_PLAYER = '76561198000000002';
steam = unavailable;
calls = await signIn(site, identifierOf(UNSAVED_PLAYER));
const unnamed = {
  id: UNSAVED_PLAYER,
  name: null,
  avatar: null,
  avatarMedium: null,
  avatarFull: null
};
assert.deepStrictEqual(structuredClone(calls), [[null, unnamed]]);
assert.deepStrictEqual(database.rows.get(UNSAVED_PLAYER), { id: UNSAVED_PLAYER, isSCBLUser: true });

// Only a Steam identifier with a 17-digit Steam ID signs a player in. Anything else is refused,
// without asking Steam or the database.
for (const identifier of [
  identifierOf('7656119800014469'),
  identifierOf('765611980001446940'),
  identifierOf(`${PLAYER}/`),
  `${identifierOf(PLAYER)}\n`,
  `http://steamcommunity.com/openid/id/${PLAYER}`,
  `https://steamcommunity.com.example.test/openid/id/${PLAYER}`,
  `https://example.test/openid/id/${PLAYER}`,
  [identifierOf(PLAYER)],
  undefined
]) {
  steam = answerWith(playerSummary(PLAYER, 'New Name'));
  calls = await signIn(site, identifier, { ...otherProfile, id: PLAYER });
  assert.deepStrictEqual(calls, [[null, false]], `Should refuse ${JSON.stringify(identifier)}`);
  assert.strictEqual(site.requests.length, 0);
  assert.strictEqual(database.saves.length + database.lookups.length, 0);
}

// Players are saved before they are signed in. When saving fails, as when MySQL stops waiting for
// a player's row that the importer is updating, or the database cannot be reached, the sign-in
// fails with that error, once, whether or not the lookup worked.
function databaseError(name, message, code) {
  const original = Object.assign(new Error(message), { code });
  return Object.assign(new Error(message), { name, original, parent: original });
}
const lockWait = databaseError(
  'SequelizeDatabaseError',
  'Lock wait timeout exceeded; try restarting transaction',
  'ER_LOCK_WAIT_TIMEOUT'
);
const refused = databaseError(
  'SequelizeConnectionRefusedError',
  'connect ECONNREFUSED',
  'ECONNREFUSED'
);
for (const failure of [lockWait, refused]) {
  for (const answer of [answerWith(playerSummary(PLAYER, 'New Name')), unavailable]) {
    database.saveFailure = failure;
    steam = answer;
    calls = await signIn(site, identifierOf(PLAYER));
    database.saveFailure = null;
    assert.strictEqual(calls.length, 1, `done should be called once after a ${failure.name}`);
    assert.strictEqual(calls[0].length, 1);
    assert.strictEqual(calls[0][0], failure);
  }
}
// Reading the saved player, after a failed lookup, fails the same way.
database.lookupFailure = refused;
steam = unavailable;
calls = await signIn(site, identifierOf(PLAYER));
database.lookupFailure = null;
assert.strictEqual(calls.length, 1);
assert.strictEqual(calls[0].length, 1);
assert.strictEqual(calls[0][0], refused);

// Steam is given the site's address and its sign-in page from HOST, with or without a trailing
// slash. Anything after the address is left out, with a warning, and an address Steam cannot use
// is warned about, as signing in cannot work.
for (const HOST of ['https://x.test', 'https://x.test/', 'HTTPS://X.test']) {
  const { strategy, logged } = await load({ HOST, NODE_ENV: 'production' });
  assert.strictEqual(strategy.options.returnURL, 'https://x.test/login', `returnURL for ${HOST}`);
  assert.strictEqual(strategy.options.realm, 'https://x.test', `realm for ${HOST}`);
  assert.deepStrictEqual(logged, [], `No warning for ${HOST}`);
}
for (const HOST of ['https://x.test/cbl', 'https://x.test/login', 'https://x.test/?page=1']) {
  const { strategy, logged } = await load({ HOST });
  assert.strictEqual(strategy.options.returnURL, 'https://x.test/login', `returnURL for ${HOST}`);
  assert.strictEqual(strategy.options.realm, 'https://x.test', `realm for ${HOST}`);
  assert.strictEqual(logged.length, 1, `One warning for ${HOST}`);
  assert.match(logged[0], /^Warning: HOST has more than the site's address/);
}
for (const HOST of ['communitybanlist.com', 'x.test:8080', 'ftp://x.test']) {
  const { logged } = await load({ HOST, NODE_ENV: 'production' });
  assert.strictEqual(logged.length, 1, `One warning for ${HOST}`);
  assert.ok(logged[0].startsWith(`Warning: HOST is ${JSON.stringify(HOST)}, which is not a full`));
}

// http://localhost, the default, is fine in development, but is warned about in production.
let localhost = await load({ HOST: 'http://localhost' });
assert.strictEqual(localhost.strategy.options.returnURL, 'http://localhost/login');
assert.strictEqual(localhost.strategy.options.realm, 'http://localhost');
assert.deepStrictEqual(localhost.logged, []);
localhost = await load({ HOST: 'http://localhost', NODE_ENV: 'production' });
assert.strictEqual(localhost.logged.length, 1);
assert.match(localhost.logged[0], /^Warning: HOST is http:\/\/localhost, the default/);

assert.deepStrictEqual(unhandled, []);

console.log(
  "Sign-in callback checks passed: the signed-in Steam ID, Steam's names and avatars, failed lookups and saves, and the sign-in addresses."
);
