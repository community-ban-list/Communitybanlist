import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// The pools of connections to the database (db/sequelize.js): the one the rest of a process
// shares, and those made with createPool for work that must neither wait for it nor take it up,
// such as the web server's counts of the players on export ban lists. Every pool is made from
// DATABASE_URI with the same options, so their connections work alike, e.g. with the time zone the
// days of bans' ages are counted in, and only the pool's own settings differ.

// A stand-in for Sequelize, which records each instance with what it was made with, copied out of
// the module's context to compare them.
const made = [];
class Sequelize {
  constructor(uri, options) {
    made.push({ uri, options: JSON.parse(JSON.stringify(options)) });
  }
}

const URI = 'mysql://test:test@db.test:3306/cbl';
const context = vm.createContext({ process: { env: { DATABASE_URI: URI } } });
const module = new vm.SourceTextModule(
  await readFile(new URL('../db/sequelize.js', import.meta.url), 'utf8'),
  { context }
);
await module.link((specifier) => {
  assert.strictEqual(specifier, 'sequelize');
  return new vm.SyntheticModule(
    ['default'],
    function () {
      this.setExport('default', { Sequelize });
    },
    { context }
  );
});
await module.evaluate();
const { default: shared, createPool } = module.namespace;

assert.ok(shared instanceof Sequelize);
assert.deepStrictEqual(made, [{ uri: URI, options: { logging: false } }]);

// A pool of its own has its settings, and otherwise what the shared one has.
const counts = createPool({ max: 1, min: 0, acquire: 2000 });
assert.ok(counts instanceof Sequelize);
assert.notStrictEqual(counts, shared);
assert.deepStrictEqual(made[1], {
  uri: URI,
  options: { logging: false, pool: { max: 1, min: 0, acquire: 2000 } }
});
// Each one is new, and none changes another's settings.
assert.notStrictEqual(createPool({ max: 2 }), counts);
assert.deepStrictEqual(
  made.map(({ options }) => options),
  [
    { logging: false },
    { logging: false, pool: { max: 1, min: 0, acquire: 2000 } },
    { logging: false, pool: { max: 2 } }
  ]
);

console.log(
  'Database pool checks passed: pools of their own made from the same address and options as the shared one, with their own settings.'
);
