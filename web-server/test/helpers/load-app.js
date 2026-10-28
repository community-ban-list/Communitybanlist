import assert from 'assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import util from 'util';
import vm from 'vm';

import Router from '@koa/router';

// Runs the web server's app, web-server/src/app.js, as it runs in production, for checks that send
// it requests over HTTP. This file only exports, so running it on its own does nothing.

// The files the web server runs with, by their path from its working directory: a client build as
// Vite makes it, with index.html and the files copied from client/public at the top, and the
// bundles under static/.
export const FILES = {
  'client/build/index.html':
    '<!DOCTYPE html>\n<title>Community Ban List</title>\n<div id="root"></div>\n',
  'client/build/favicon.ico': 'An icon',
  'client/build/manifest.json': '{ "short_name": "CBL" }\n',
  'client/build/static/app-abc.js': 'console.log("The client");\n'
};

// Stand-ins for what app.js loads that would reach the database, Steam or the environment: sign-in
// and export list routers with no routes, an API that gives every request the same answer, and a
// database that always answers.
function standIns() {
  return {
    './auth/index.js': {
      passport: { initialize: () => (ctx, next) => next() },
      routes: new Router()
    },
    // Like the real API, it answers requests to /graphql only.
    './graphql-api/index.js': {
      default: async (ctx, next) => {
        if (ctx.path !== '/graphql') return next();
        ctx.body = { data: {} };
      }
    },
    './export-ban-lists.js': { default: new Router() },
    'scbl-lib/config': {
      DISCORD_INVITE: 'https://discord.gg/example',
      INTAKE_FORM: 'https://forms.example.com/apply',
      EXPORT_LIST_LIMITS: {},
      EXPORT_LIST_LIMIT_PROBLEMS: []
    },
    'scbl-lib/db': { sequelize: { authenticate: async () => {} } },
    'scbl-lib/db/sequelize': {
      DATABASE_UNAVAILABLE_MESSAGE: 'The database is unavailable.',
      // Sequelize's error when the database refuses the connection, as while it restarts.
      isDatabaseUnavailable: (err) => err?.name === 'SequelizeConnectionRefusedError'
    }
  };
}

// Load a module from its file with its imports: the stand-in where there is one, the real file for
// any other relative import, and the real package for any other package. Anything else from
// scbl-lib needs a stand-in, as it reads the environment and the database.
async function load(url, stubs) {
  const modules = new Map();
  async function create(key, stub, file) {
    if (file) {
      return new vm.SourceTextModule(await readFile(new URL(key), 'utf8'), {
        identifier: key,
        initializeImportMeta: (meta) => {
          meta.url = key;
        }
      });
    }
    const exports = stub || (await import(key));
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { identifier: key }
    );
  }
  function moduleFor(specifier, referencingURL) {
    const stub = stubs[specifier];
    const file = !stub && specifier.startsWith('.');
    assert.ok(stub || file || !specifier.startsWith('scbl-lib'), `No stand-in for ${specifier}`);
    const key = file ? new URL(specifier, referencingURL).href : specifier;
    if (!modules.has(key)) modules.set(key, create(key, stub, file));
    return modules.get(key);
  }

  const module = await create(url.href, null, true);
  await module.link((specifier, referencingModule) =>
    moduleFor(specifier, referencingModule.identifier)
  );
  await module.evaluate();
  return module.namespace.default;
}

function setEnvironment(variables) {
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Start app.js listening on 127.0.0.1, in a new working directory that holds these files, with
// NODE_ENV production unless env says otherwise. stubs replaces exports of the stand-ins above, or
// adds stand-ins, by the name a file imports them with. What is written to the console while it
// runs, by the app or by Node, such as its warning that vm modules are experimental, is kept in
// output rather than printed. The app reads its files from the working directory, so run one at a
// time, and close it to put everything back.
export async function loadApp({ files = FILES, env = {}, stubs = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cbl-web-server-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }

  const variables = { NODE_ENV: 'production', ...env };
  const workingDirectory = process.cwd();
  const environment = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]])
  );
  const consoleMethods = ['debug', 'error', 'info', 'log', 'warn'].map((name) => [
    name,
    console[name]
  ]);
  const output = [];
  async function restore() {
    for (const [name, method] of consoleMethods) console[name] = method;
    setEnvironment(environment);
    process.chdir(workingDirectory);
    await rm(directory, { recursive: true, force: true });
  }

  process.chdir(directory);
  setEnvironment(variables);
  for (const [name] of consoleMethods) {
    console[name] = (...args) => output.push(util.format(...args));
  }

  const modules = standIns();
  for (const [name, exports] of Object.entries(stubs))
    modules[name] = { ...modules[name], ...exports };
  let app, server;
  try {
    app = await load(new URL('../../src/app.js', import.meta.url), modules);
    server = http.createServer(app.callback());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  } catch (err) {
    await restore();
    throw err;
  }
  const { port } = server.address();
  // Each request has its own connection, so one the app answers before reading all of its body,
  // such as one said to be too large, cannot hold up the next.
  const agent = new http.Agent({ keepAlive: false });

  // Send a request with its path exactly as given, where fetch would first resolve any ../ in it.
  function request(requestPath, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const options = { host: '127.0.0.1', port, path: requestPath, method, headers, agent };
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString(), bytes });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  async function close() {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
    await restore();
  }

  return { app, directory, output, request, close };
}
