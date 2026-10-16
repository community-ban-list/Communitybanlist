import passport from 'koa-passport';
import SteamStrategy from 'passport-steam';

import { HOST, STEAM_API_KEY } from 'scbl-lib/config';
import { SteamUser } from 'scbl-lib/db/models';

passport.use(
  new SteamStrategy(
    {
      returnURL: HOST + '/login',
      realm: HOST,
      apiKey: STEAM_API_KEY
    },
    // passport-steam does not wait for this function or catch what it throws, so failures, such as
    // the database being unreachable, go to done, and the sign-in is answered with an error.
    async (_, profile, done) => {
      let steamUsers;
      try {
        steamUsers = await SteamUser.bulkCreate(
          [
            {
              id: profile.id,
              name: profile.displayName,
              // A profile without avatars still signs in.
              avatar: profile.photos?.[0]?.value ?? null,
              avatarMedium: profile.photos?.[1]?.value ?? null,
              avatarFull: profile.photos?.[2]?.value ?? null,
              isSCBLUser: true
            }
          ],
          { updateOnDuplicate: ['isSCBLUser'] }
        );
      } catch (err) {
        return done(err);
      }

      // Outside the try, so done is only ever called once.
      return done(null, steamUsers[0]);
    }
  )
);

export default passport;
