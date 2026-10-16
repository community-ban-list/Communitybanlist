import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Every service's connect() syncs the CBL's own models, and only those: the ban importer's tables
// are made by the importer's migrations, so the web server and the bot must never make or change
// them. Check that without a database.

// Load a module with stand-ins for its dependencies, failing on any other dependency.
async function load(path, dependencies, globals = {}) {
  const context = vm.createContext(globals);
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { context });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency of ${path}: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  return module.namespace;
}

const CORE_MODELS = [
  'Organisation',
  'BanList',
  'SteamUser',
  'Ban',
  'ExportBanList',
  'ExportBanListConfig',
  'ExportBan'
];

// connect() syncs the seven core models, in an order where each table comes after those it refers
// to, and nothing else.
{
  const synced = [];
  const models = Object.fromEntries(
    CORE_MODELS.map((name) => [name, { sync: async () => synced.push(name) }])
  );
  const { default: connect } = await load(
    '../db/connect.js',
    {
      './sequelize.js': { default: { authenticate: async () => {} } },
      './models/index.js': models
    },
    { console: { log() {} } }
  );
  await connect();
  assert.deepStrictEqual(synced, CORE_MODELS);
}

// The core models' module, which the web server and the bot use, holds no model of the importer's
// tables, and does not load them.
{
  const files = {
    './ban.js': 'Ban',
    './ban-list.js': 'BanList',
    './export-ban.js': 'ExportBan',
    './export-ban-list.js': 'ExportBanList',
    './export-ban-list-configs.js': 'ExportBanListConfig',
    './organisation.js': 'Organisation',
    './steam-user.js': 'SteamUser'
  };
  const dependencies = Object.fromEntries(
    Object.entries(files).map(([file, name]) => [file, { default: { name, belongsTo() {} } }])
  );
  const exports = await load('../db/models/index.js', dependencies);
  assert.deepStrictEqual(Object.keys(exports).sort(), [...CORE_MODELS].sort());
}

console.log("Database connection checks passed: connect() syncs only the CBL's own models.");
