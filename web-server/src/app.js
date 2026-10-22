import fs from 'fs';
import path from 'path';

import Koa from 'koa';
import Router from '@koa/router';
import Helmet from 'koa-helmet';
import Cors from '@koa/cors';
import Logger from 'koa-logger';
import serve from 'koa-static';
import mount from 'koa-mount';
import { send } from '@koa/send';

import bodyParser from './body-parser.js';
import { passport, routes as routesAuth } from './auth/index.js';
import clientConfig from './client-config.js';
import GraphQL from './graphql-api/index.js';
import ExportBanLists from './export-ban-lists.js';

import { DISCORD_INVITE, EXPORT_LIST_LIMIT_PROBLEMS, INTAKE_FORM } from 'scbl-lib/config';
import { sequelize } from 'scbl-lib/db';
import { DATABASE_UNAVAILABLE_MESSAGE, isDatabaseUnavailable } from 'scbl-lib/db/sequelize';

const inProduction = process.env.NODE_ENV;

const app = new Koa();
const router = new Router();

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // While the database cannot be reached, e.g. as it restarts, log one line rather than letting
    // Koa log the stack trace for every request, such as each Docker health check.
    if (isDatabaseUnavailable(err)) {
      console.log(`Database unavailable for ${ctx.method} ${ctx.path}: ${err.message}`);
      ctx.status = 503;
      ctx.body = DATABASE_UNAVAILABLE_MESSAGE;
      return;
    }

    // Koa 2 answered with 404 when a request failed because a file was missing. Koa 3 answers with
    // 500, so keep the old behaviour for the routes that read files.
    if (err.code === 'ENOENT') err.status = 404;
    throw err;
  }
});

app.use(
  Helmet({
    // The policy protects the client's pages, which are only served in production. In development
    // Vite serves them, and the only page here is Apollo Sandbox, which loads from Apollo's CDN.
    contentSecurityPolicy: inProduction
      ? {
          directives: {
            // Steam avatars come from several Steam image hosts, which have changed over time.
            imgSrc: ["'self'", 'data:', 'https:'],
            // HSTS already keeps browsers on HTTPS, and upgrading would break plain HTTP access.
            upgradeInsecureRequests: null
          }
        }
      : false
  })
);
app.use(Cors());
app.use(bodyParser);

if (!inProduction) app.use(Logger());

app.use(passport.initialize());

const clientPath = './client';

if (inProduction) app.use(mount('/static', serve(path.join(clientPath, '/build/static'))));
else app.use(serve(path.join(clientPath, '/main-site')));

router.use('/auth', routesAuth.routes(), routesAuth.allowedMethods());
app.use(GraphQL);
router.use('/export', ExportBanLists.routes(), ExportBanLists.allowedMethods());

router.get('/health-check', async (ctx) => {
  await sequelize.authenticate();
  ctx.status = 200;
});

if (!DISCORD_INVITE)
  console.warn('Warning: DISCORD_INVITE is not set, so the Discord links on the site do nothing.');
if (!INTAKE_FORM)
  console.warn(
    'Warning: INTAKE_FORM is not set, so the partner organisation form link on the site does nothing.'
  );
// Limits on export ban lists set to values that cannot be used, which have their defaults instead.
for (const problem of EXPORT_LIST_LIMIT_PROBLEMS) console.warn(`Warning: ${problem}`);

// The client is built before the server runs, so it loads the settings that can be set with
// environment variables from here (client-config.js).
router.get('/config.js', (ctx) => {
  ctx.type = 'application/javascript';
  ctx.set('Cache-Control', 'no-cache');
  ctx.body = clientConfig;
});

if (inProduction) {
  const buildPath = path.join(clientPath, '/build');

  // Vite copies client/public (favicon, logos, manifest, robots.txt) to the root of the build, next
  // to index.html. Serve those files by their exact path and answer every other path with
  // index.html, so the client can route it.
  const buildFiles = new Set(
    fs
      .readdirSync(buildPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `/${entry.name}`)
  );

  router.get('{/*path}', async (ctx) => {
    await send(ctx, buildFiles.has(ctx.path) ? ctx.path : 'index.html', { root: buildPath });
  });
}

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
