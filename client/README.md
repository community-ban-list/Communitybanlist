The Community Ban List website, built with [Vite](https://vite.dev/).

## Available Scripts

In the project directory, you can run:

### `yarn start`

Runs the app in development mode on [http://localhost:3000](http://localhost:3000). The page reloads when you make edits.

Requests to `/graphql`, `/auth/` and `/export/` are proxied to the web server on [http://localhost:80](http://localhost:80). Run `yarn dev-web-server` from the repository root to start both together.

### `yarn build`

Builds the app for production into the `build` folder, which the web server serves when `NODE_ENV` is set.

### `yarn preview`

Serves the production build locally to check it before deploying.
