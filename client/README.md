The Community Ban List website, built with [Vite](https://vite.dev/).

## Available Scripts

In the project directory, you can run:

### `yarn start`

Runs the app in development mode on [http://localhost:3000](http://localhost:3000). The page reloads when you make edits.

Requests to `/graphql`, `/auth/` and `/export/` are proxied to the web server on [http://localhost:80](http://localhost:80). Run `yarn dev-web-server` from the repository root to start both together. The web server needs a MySQL database and the environment variables `DATABASE_URI`, `BATTLEMETRICS_API_KEY`, `STEAM_API_KEY` and `JWT_AUTH_SECRET`; it refuses to start without a JWT secret, so set one with e.g. `export JWT_AUTH_SECRET=$(openssl rand -base64 48)`. `STEAM_API_KEY` must be the Steamworks publisher key the importer uses: signing in looks up the player's name and avatars on `partner.steam-api.com`, which takes only publisher keys. With an ordinary Steam Web API key, players still sign in, but Steam refuses each lookup, which the web server logs, so their names and avatars are not updated, new players are saved without them, and Steam may limit the whole IP address after repeated refusals.

### `yarn build`

Builds the app for production into the `build` folder, which the web server serves when `NODE_ENV` is `production`.

### `yarn preview`

Serves the production build locally to check it before deploying.
