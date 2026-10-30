import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check that a run reads the paused ban lists once, for all its steps, without a database: the
// first step that asks reads them, every later step of the same run, by when it started, gets the
// same lists, also when they changed meanwhile, and the next run reads them afresh. A read that
// fails is passed on, and the next step that asks reads them again. The table must be there.

let rows = [];
let reads = 0;
let failWith = null;
const stubs = {
  'scbl-lib/db/ban-list-suspensions': {
    async readPausedBanLists(options) {
      reads++;
      assert.deepStrictEqual({ ...options }, { missingTable: 'throw' });
      if (failWith) throw failWith;
      return rows.map((row) => ({ ...row }));
    },
    pausedSets: (given) => ({
      suspended: given.filter(({ resumedAt }) => resumedAt === null).map(({ banList }) => banList),
      excluded: given.map(({ banList }) => banList)
    })
  },
  // A read that fails in a way that could pass is run again by retryOperation, which apply-list.js
  // checks.
  './apply-list.js': { retryOperation: (operation) => operation() }
};

const context = vm.createContext({});
const module = new vm.SourceTextModule(
  await readFile(new URL('../src/paused-lists.js', import.meta.url), 'utf8'),
  { context }
);
await module.link((specifier) => {
  const exports = stubs[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const { default: pausedBanLists } = module.namespace;
const plain = (value) => JSON.parse(JSON.stringify(value));

const RESUMED = '2026-10-29T12:00:00.000Z';

// The first step of a run reads the lists, and the run's other steps get the same ones, though a
// list was resumed and another suspended since.
rows = [
  { banList: 7, resumedAt: null },
  { banList: 46, resumedAt: RESUMED }
];
const first = await pausedBanLists({ startedAt: 1000 });
assert.deepStrictEqual(plain(first), {
  rows: [
    { banList: 7, resumedAt: null },
    { banList: 46, resumedAt: RESUMED }
  ],
  suspended: [7],
  excluded: [7, 46]
});
rows = [
  { banList: 7, resumedAt: RESUMED },
  { banList: 9, resumedAt: null }
];
assert.strictEqual(await pausedBanLists({ startedAt: 1000 }), first);
assert.strictEqual(reads, 1);

// The next run reads them afresh, and so does a step run on its own, without a run's start, which
// leaves the run's read as it was for the run's later steps.
const second = await pausedBanLists({ startedAt: 2000 });
assert.deepStrictEqual(plain(second.excluded), [7, 9]);
assert.strictEqual(reads, 2);
rows = [];
assert.deepStrictEqual(plain((await pausedBanLists()).excluded), []);
assert.deepStrictEqual(plain((await pausedBanLists({})).excluded), []);
assert.strictEqual(reads, 4);
assert.strictEqual(await pausedBanLists({ startedAt: 2000 }), second);
assert.strictEqual(reads, 4);

// Steps that ask at the same time share one read.
reads = 0;
const [a, b] = await Promise.all([
  pausedBanLists({ startedAt: 3000 }),
  pausedBanLists({ startedAt: 3000 })
]);
assert.strictEqual(a, b);
assert.strictEqual(reads, 1);

// A read that fails is passed on, as the database gave it, e.g. a missing table, which means the
// run's migrations did not run, and the next step that asks reads them again.
reads = 0;
failWith = Object.assign(new Error("Table 'cbl.BanListSuspensions' doesn't exist"), {
  original: { errno: 1146 }
});
await assert.rejects(pausedBanLists({ startedAt: 4000 }), (err) => err === failWith);
failWith = null;
rows = [];
assert.deepStrictEqual(plain(await pausedBanLists({ startedAt: 4000 })), {
  rows: [],
  suspended: [],
  excluded: []
});
assert.strictEqual(reads, 2);

console.log(
  'Paused list checks passed: read once a run and shared by its steps, afresh for the next run and for a step on its own, and read again after a failed read.'
);
