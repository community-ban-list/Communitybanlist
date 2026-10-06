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
import views from 'koa-views';

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

app.use(Helmet());
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

if (inProduction) app.use(views(path.join(clientPath, '/build')));

router.use('/auth', routesAuth.routes(), routesAuth.allowedMethods());
app.use(GraphQL);
router.use('/export', ExportBanLists.routes(), ExportBanLists.allowedMethods());

router.get('/health-check', async (ctx) => {
  await sequelize.authenticate();
  ctx.status = 200;
});

if (inProduction) {
  router.get('/manifest.json', async (ctx) => {
    ctx.body = fs.readFileSync(path.join(clientPath, '/build/manifest.json'));
  });

  router.get('/favicon.png', async (ctx) => {
    ctx.body = fs.readFileSync(path.resolve('./assets/cbl-logo-square.png'));
  });

  router.get('{/*path}', async (ctx) => {
    await ctx.render('index.html', {});
  });
}

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
