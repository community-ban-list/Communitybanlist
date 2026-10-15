import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise Core.updateReputationRank without a database, by recording the queries it makes.
const queries = [];
const logs = [];
let affectedRows = 0;
const stubs = {
  'scbl-lib/db': {
    sequelize: {
      QueryTypes: { BULKUPDATE: 'BULKUPDATE' },
      async query(sql, options) {
        queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), options });
        return affectedRows;
      }
    }
  },
  'scbl-lib/utils': { Logger: { verbose: (...args) => logs.push(args.slice(2).join('')) } }
};

const source = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');

// The rank step only uses the database and the logger, so core.js's other imports get empty
// stand-ins, named from its import statements. Changes elsewhere in core.js then leave this test
// alone.
const imports = {};
for (const [, names, specifier] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g))
  imports[specifier] = names
    .split(',')
    .map((name) => name.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);

const context = vm.createContext({});
const module = new vm.SourceTextModule(source, { context });
await module.link((specifier) => {
  assert.ok(imports[specifier], `Unexpected dependency: ${specifier}`);
  const exports = Object.fromEntries(imports[specifier].map((name) => [name, undefined]));
  Object.assign(exports, stubs[specifier]);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const Core = module.namespace.default;

// Ranks are set in one statement, so nothing depends on an earlier statement having run on the
// same pooled connection: no user variables, no temporary table, no second statement.
affectedRows = 1234;
await Core.updateReputationRank();
assert.strictEqual(queries.length, 1, 'The rank step should make exactly one query');
const [{ sql, options }] = queries;
assert.doesNotMatch(sql, /@|TEMPORARY|;/i, 'The rank step should keep nothing on the connection');
assert.deepStrictEqual({ ...options }, { type: 'BULKUPDATE' });

// Players are ranked with RANK(), so tied players share a rank and the next rank counts everyone
// above it.
assert.match(
  sql,
  /\bRANK\(\) OVER \(ORDER BY reputationPoints DESC\) AS reputationRank FROM SteamUsers/
);
assert.doesNotMatch(sql, /DENSE_RANK/i);
assert.match(sql, /^UPDATE SteamUsers su JOIN \(.*\) rr ON su\.id = rr\.id SET /);
assert.match(
  sql,
  /SET su\.reputationRank = rr\.reputationRank, su\.lastRefreshedReputationRank = NOW\(\) WHERE/
);

// Only players whose rank changed, or who are queued for a refresh, are written. Without the
// second condition, a queued player whose rank stayed the same would show "Queued for refresh."
// until their rank next changed.
assert.strictEqual(
  sql.slice(sql.indexOf(' WHERE ')),
  ' WHERE NOT (su.reputationRank <=> rr.reputationRank) OR su.lastRefreshedReputationRank IS NULL'
);

// The number of players written is reported.
assert.match(logs.at(-1), /Finished Updating reputation rank of 1234 Steam users/);

// The step can run again in the same process, as a long-running importer would run it, and a run
// with nothing to change reports 0.
affectedRows = 0;
await Core.updateReputationRank();
assert.strictEqual(queries.length, 2);
assert.deepStrictEqual(queries[1], queries[0]);
assert.match(logs.at(-1), /Finished Updating reputation rank of 0 Steam users/);

console.log('Reputation rank checks passed: one statement, changed and queued players only.');
