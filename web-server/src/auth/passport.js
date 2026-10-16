import passport from 'koa-passport';
import SteamStrategy from 'passport-steam';

import { HOST } from 'scbl-lib/config';
import { SteamUser } from 'scbl-lib/db/models';

import getSteamProfile from './steam-profile.js';

// The OpenID identifier of a player signing in with Steam, which the OpenID library has confirmed
// with Steam. It ends with the player's Steam ID.
const STEAM_IDENTIFIER = /^https:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/;

// The Steam profile fields saved for each player, which their sign-in token holds too.
const PROFILE_FIELDS = ['name', 'avatar', 'avatarMedium', 'avatarFull'];

// Steam sends players back to the site's /login page after they sign in, and shows them the
// site's address, so both come from HOST. Signing in cannot work without the right address, so the
// web server says so when it starts.
const { returnURL, realm, problem } = signInAddresses(HOST, process.env.NODE_ENV === 'production');
if (problem) console.warn(`Warning: ${problem}`);

passport.use(
  new SteamStrategy(
    {
      returnURL,
      realm,
      // The player's name and avatars are looked up below over HTTPS, so passport-steam's own
      // lookup is turned off and is not given the API key.
      profile: false
    },
    // passport-steam does not wait for this function or catch what it throws, so failures, such as
    // the database being unreachable, go to done, and the sign-in is answered with an error.
    async (identifier, _profile, done) => {
      // The player signed in is the one Steam's sign-in identifies.
      const id = typeof identifier === 'string' && STEAM_IDENTIFIER.exec(identifier)?.[1];
      if (!id) return done(null, false);

      // The name and avatars are only for show, so a player whose lookup fails is still signed in,
      // with the ones already saved.
      let profile = null;
      try {
        profile = await getSteamProfile(id);
      } catch (err) {
        console.warn(`Signing in ${id} with their saved Steam name and avatar: ${err.message}`);
      }

      let user;
      try {
        if (profile) {
          user = { id, ...profileFields(profile) };
          await SteamUser.bulkCreate([{ ...user, isSCBLUser: true }], {
            updateOnDuplicate: [...PROFILE_FIELDS, 'isSCBLUser']
          });
        } else {
          await SteamUser.bulkCreate([{ id, isSCBLUser: true }], {
            updateOnDuplicate: ['isSCBLUser']
          });
          const saved = await SteamUser.findByPk(id, { attributes: PROFILE_FIELDS, raw: true });
          user = { id, ...profileFields(saved) };
        }
      } catch (err) {
        return done(err);
      }

      // Outside the try, so done is only ever called once.
      return done(null, user);
    }
  )
);

function profileFields(source) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, source?.[field] ?? null]));
}

// The addresses Steam is given for signing in, built from the site's address, such as
// https://communitybanlist.com, and what is wrong with that address, if anything. A trailing slash
// makes no difference.
function signInAddresses(host, inProduction) {
  let site = null;
  try {
    site = new URL(host);
  } catch {
    // Not a full address, e.g. one without http:// or https://.
  }
  if (site?.protocol !== 'http:' && site?.protocol !== 'https:') {
    return {
      returnURL: `${host}/login`,
      realm: host,
      problem: `HOST is ${JSON.stringify(host)}, which is not a full http:// or https:// address such as https://communitybanlist.com, so signing in with Steam does not work.`
    };
  }

  const addresses = { returnURL: new URL('/login', site.origin).href, realm: site.origin };
  if (site.href !== `${site.origin}/`) {
    return {
      ...addresses,
      problem: `HOST has more than the site's address, such as a path, which is left out: Steam sends players back to ${addresses.returnURL} after they sign in. Set it to only the site's address, such as https://communitybanlist.com.`
    };
  }
  if (inProduction && site.origin === 'http://localhost') {
    return {
      ...addresses,
      problem: `HOST is http://localhost, the default, so Steam sends players back to http://localhost/login on their own computer after they sign in. Set it to the site's address, such as https://communitybanlist.com.`
    };
  }
  return addresses;
}

export default passport;
