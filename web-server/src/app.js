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
import { STATUS_CODES } from 'http';

import bodyParser from './body-parser.js';
import { passport, routes as routesAuth } from './auth/index.js';
import clientConfig from './client-config.js';
import { inProduction, nodeEnvProblem } from './production.js';
import GraphQL from './graphql-api/index.js';
import ExportBanLists from './export-ban-lists.js';

import { DISCORD_INVITE, EXPORT_LIST_LIMIT_PROBLEMS, INTAKE_FORM } from 'scbl-lib/config';
import { sequelize } from 'scbl-lib/db';
import { DATABASE_UNAVAILABLE_MESSAGE, isDatabaseUnavailable } from 'scbl-lib/db/sequelize';

// The site is served only when NODE_ENV is exactly production (production.js), so a value the web
// server does not expect, such as prod, is warned about.
if (nodeEnvProblem) console.warn(`Warning: ${nodeEnvProblem}`);

const app = new Koa();
const router = new Router();

// Headers that describe the answer a route meant to give, such as a file name to save it under or
// when it last changed, which an error answered in its place must not carry.
const ANSWER_HEADERS = [
  'Content-Disposition',
  'Content-Encoding',
  'Content-Language',
  'ETag',
  'Expires',
  'Last-Modified',
  'Location'
];

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

    // Once the answer has started, it can no longer be changed, so leave the error to Koa.
    if (ctx.headerSent || !ctx.writable) throw err;

    // Answer the error here rather than passing it on: Koa first removes every header set so far,
    // so its answers lacked Helmet's headers. Keep those and the CORS headers, remove the ones about
    // the answer the route meant to give, and tell browsers and caches not to keep the error.
    for (const header of ANSWER_HEADERS) ctx.remove(header);
    ctx.set('Cache-Control', 'no-store');
    ctx.set(err.headers);
    // Koa 2 answered with 404 when a request failed because a file was missing, which @koa/send
    // tells by these codes. Koa 3 answers with 500, so keep the old behaviour for the routes that
    // read files.
    const missingFile = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR'].includes(err.code);
    const status = missingFile ? 404 : err.status || err.statusCode;
    ctx.status = Number.isInteger(status) && status >= 400 && STATUS_CODES[status] ? status : 500;
    ctx.type = 'text';
    // Show only messages meant for the client. A system error's is not, as it has a file's path or
    // an address, even when @koa/send passes a missing file on as meant for the client.
    ctx.body = err.expose && !err.syscall ? err.message : ctx.message;
    // Koa logs the errors it answers, apart from those meant for the client, so log server errors.
    if (ctx.status >= 500) ctx.app.emit('error', err, ctx);
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
  // to index.html. Serve those files by their exact path and answer the client's pages with
  // index.html, so the client can route them.
  const buildFiles = new Set(
    fs
      .readdirSync(buildPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `/${entry.name}`)
  );

  // The client has no pages under the paths the server answers itself, and each of its pages
  // starts with a name without a dot, such as /search. A request that gets this far for a path
  // under one the server answers, such as a missing file under /static, an unknown sign-in path or
  // an export list URL without its id, or for a path whose first part has a dot, as a file name
  // has, is left unanswered, so Koa answers it with 404 rather than a page. The rest of a page's
  // path can hold what a visitor typed, such as a search for a name, so dots there are allowed.
  const serverPath = /^\/(static|auth|graphql|export)(\/|$)/i;
  const fileName = /^\/[^/]*\./;

  router.get('{/*path}', async (ctx) => {
    if (buildFiles.has(ctx.path)) await send(ctx, ctx.path, { root: buildPath });
    else if (!serverPath.test(ctx.path) && !fileName.test(ctx.path))
      await send(ctx, 'index.html', { root: buildPath });
  });
}

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
