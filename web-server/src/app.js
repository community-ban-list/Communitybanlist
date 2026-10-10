import fs from 'fs';
import path from 'path';

import Koa from 'koa';
import Router from '@koa/router';
import Helmet from 'koa-helmet';
import Cors from '@koa/cors';
import BodyParser from 'koa-bodyparser';
import Logger from 'koa-logger';
import serve from 'koa-static';
import mount from 'koa-mount';
import { send } from '@koa/send';

import { passport, routes as routesAuth } from './auth/index.js';
import GraphQL from './graphql-api/index.js';
import ExportBanLists from './export-ban-lists.js';

import { sequelize } from 'scbl-lib/db';

const inProduction = process.env.NODE_ENV;

const app = new Koa();
const router = new Router();

// Koa 2 answered with 404 when a request failed because a file was missing. Koa 3 answers with 500,
// so keep the old behaviour for the routes that read files.
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
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
app.use(
  BodyParser({
    enableTypes: ['json'],
    jsonLimit: '5mb',
    strict: true,
    onerror: function (err, ctx) {
      if (err) console.log(err);
      ctx.throw(422, 'body parse error');
    }
  })
);

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
