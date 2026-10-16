import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// passport-steam calls the sign-in callback without waiting for it, so a failure the callback did
// not hand to passport would end up here.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// Load the sign-in setup with stubs for passport, passport-steam, the config and the database, and
// keep the Steam strategy it registers. It is evaluated in this context, so what it saves can be
// compared as it is.
class SteamStrategy {
  constructor(options, verify) {
    this.options = options;
    this.verify = verify;
  }
}
const strategies = [];
let bulkCreate;
const dependencies = {
  'koa-passport': { default: { use: (strategy) => strategies.push(strategy) } },
  'passport-steam': { default: SteamStrategy },
  'scbl-lib/config': { HOST: 'https://cbl.test', STEAM_API_KEY: 'steam-test-key' },
  'scbl-lib/db/models': { SteamUser: { bulkCreate: (...args) => bulkCreate(...args) } }
};
const url = new URL('../src/auth/passport.js', import.meta.url);
const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
await module.link((specifier) => {
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
});
await module.evaluate();

// Steam sends players back to the site's sign-in page.
assert.strictEqual(strategies.length, 1);
const [strategy] = strategies;
assert.ok(strategy instanceof SteamStrategy);
assert.strictEqual(strategy.options.returnURL, 'https://cbl.test/login');
assert.strictEqual(strategy.options.realm, 'https://cbl.test');

// Sign in with this profile as passport-steam does, which ignores what the callback returns, and
// give the calls to done once the work the callback started has finished.
async function signIn(profile) {
  const calls = [];
  strategy.verify(`https://steamcommunity.com/openid/id/${profile.id}`, profile, (...args) => {
    calls.push(args);
  });
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

// A profile as passport-steam builds it from Steam's player summary.
const profile = {
  provider: 'steam',
  id: '76561198000000001',
  displayName: 'Test Player',
  photos: [
    { value: 'https://avatars.example.test/player.jpg' },
    { value: 'https://avatars.example.test/player_medium.jpg' },
    { value: 'https://avatars.example.test/player_full.jpg' }
  ]
};

// Players are saved before they are signed in. When saving fails, as when MySQL stops waiting for
// a player's row that the importer is updating, or the database cannot be reached, the sign-in
// fails with that error, once.
function databaseError(name, message, code) {
  const original = Object.assign(new Error(message), { code });
  return Object.assign(new Error(message), { name, original, parent: original });
}
for (const error of [
  databaseError(
    'SequelizeDatabaseError',
    'Lock wait timeout exceeded; try restarting transaction',
    'ER_LOCK_WAIT_TIMEOUT'
  ),
  databaseError('SequelizeConnectionRefusedError', 'connect ECONNREFUSED', 'ECONNREFUSED')
]) {
  bulkCreate = async () => {
    throw error;
  };
  const calls = await signIn(profile);
  assert.strictEqual(calls.length, 1, `done should be called once after a ${error.name}`);
  assert.strictEqual(calls[0].length, 1);
  assert.strictEqual(calls[0][0], error);
  assert.deepStrictEqual(unhandled, []);
}

// When saving works, the player is signed in as saved, with their Steam name and avatars, and is
// marked as a user of the site.
const saved = [];
bulkCreate = async (records, options) => {
  saved.push({ records, options });
  return records;
};
let calls = await signIn(profile);
assert.strictEqual(saved.length, 1);
assert.deepStrictEqual(saved[0].records, [
  {
    id: '76561198000000001',
    name: 'Test Player',
    avatar: 'https://avatars.example.test/player.jpg',
    avatarMedium: 'https://avatars.example.test/player_medium.jpg',
    avatarFull: 'https://avatars.example.test/player_full.jpg',
    isSCBLUser: true
  }
]);
assert.ok(saved[0].options.updateOnDuplicate.includes('isSCBLUser'));
assert.deepStrictEqual(calls, [[null, saved[0].records[0]]]);

// A profile without avatars still signs in, with none saved.
const withoutPhotos = { ...profile, id: '76561198000000002' };
delete withoutPhotos.photos;
for (const player of [withoutPhotos, { ...withoutPhotos, photos: [] }]) {
  saved.length = 0;
  calls = await signIn(player);
  assert.strictEqual(saved.length, 1);
  assert.deepStrictEqual(saved[0].records, [
    {
      id: '76561198000000002',
      name: 'Test Player',
      avatar: null,
      avatarMedium: null,
      avatarFull: null,
      isSCBLUser: true
    }
  ]);
  assert.deepStrictEqual(calls, [[null, saved[0].records[0]]]);
}

assert.deepStrictEqual(unhandled, []);

console.log(
  'Sign-in callback checks passed: saving the player, failed saves, and profiles without avatars.'
);
