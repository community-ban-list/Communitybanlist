import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { normaliseBattlemetricsID } from '../../scbl-lib/utils/battlemetrics-id.js';

// Check how a ban list's sync state is worked out, without a database or network requests: every
// change of state and the alerts it calls for, the count of failed runs, lists whose source was
// changed, the access check's read of BattleMetrics' ban lists, which errors mean lost access, and
// how errors are kept. import-bans.js checks the importer saving it.

// BattleMetrics' list of ban lists, as readBattlemetricsPages gives it, or an error.
let banListPages = [];
const reads = [];
const dependencies = {
  crypto: { createHash },
  'scbl-lib/apis': {
    async readBattlemetricsPages(endpoint, params) {
      reads.push([endpoint, params]);
      if (banListPages instanceof Error) throw banListPages;
      return banListPages;
    }
  },
  'scbl-lib/utils': { normaliseBattlemetricsID }
};
const context = vm.createContext({});
const url = new URL('../src/ban-list-sync.js', import.meta.url);
const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
  context,
  identifier: url.href
});
await module.link((specifier) => {
  const exports = dependencies[specifier];
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
const {
  accessProblem,
  cleanError,
  describeAlert,
  FAILURE_ALERT_RUNS,
  nextSync,
  NOT_VISIBLE,
  readAccessCheck,
  readVisibleBanLists,
  sourceKey,
  stateOf,
  STATES
} = module.namespace;

// Copy a value made in the module's context into one of this test's own, to compare it.
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.deepStrictEqual(plain(STATES), {
  OK: 'ok',
  FAILING: 'failing',
  ACCESS_LOST: 'access_lost',
  SELF_IMPORT: 'self_import',
  HELD: 'held'
});
assert.strictEqual(FAILURE_ALERT_RUNS, 3);

// IMPORTER_ACCESS_CHECK is on unless it is 0, false, off or no, in any case and with spaces around
// it. An invalid value leaves it on, with a warning.
for (const value of [undefined, null, '', '  ', '1', 'true', 'ON', ' yes ', true])
  assert.deepStrictEqual(plain(readAccessCheck(value)), { on: true }, String(value));
for (const value of ['0', 'false', 'Off', ' no ', false])
  assert.deepStrictEqual(plain(readAccessCheck(value)), { on: false }, String(value));
assert.deepStrictEqual(plain(readAccessCheck('2')), {
  on: true,
  warning: 'Warning: IMPORTER_ACCESS_CHECK must be 1 or 0, not "2", so the access check stays on.'
});

// The access check reads every page of BattleMetrics' ban lists, and gives their IDs as the bot
// and the importer compare them. A ban list without an ID, or a page that cannot be read, fails
// it.
banListPages = [
  { type: 'banList', id: 'C0FFEE00-CB1E-4A00-B000-0000000000AA' },
  { type: 'banList', id: 'facade00-ba5e-4b00-a000-0000000000cc', attributes: { name: 'Partner' } }
];
assert.deepStrictEqual(
  [...(await readVisibleBanLists())],
  ['c0ffee00cb1e4a00b0000000000000aa', 'facade00ba5e4b00a0000000000000cc']
);
assert.deepStrictEqual(reads, [['ban-lists', undefined]]);
for (const pages of [[{ type: 'banList' }], [{ id: ' - ' }], [null], [{ id: 12 }]]) {
  banListPages = pages;
  await assert.rejects(
    readVisibleBanLists(),
    /^Error: BattleMetrics returned a ban list without an ID\.$/
  );
}
banListPages = new Error('BattleMetrics GET ban-lists failed: HTTP 503');
await assert.rejects(readVisibleBanLists(), /HTTP 503/);

// A list's source key is a SHA-256 of its type and source, so any change to either changes it.
const key = sourceKey({ type: 'battlemetrics', source: 'bm-1' });
assert.match(key, /^[0-9a-f]{64}$/);
assert.strictEqual(key, sourceKey({ id: 9, type: 'battlemetrics', source: 'bm-1', name: 'Other' }));
for (const other of [
  { type: 'remote', source: 'bm-1' },
  { type: 'battlemetrics', source: 'BM-1' },
  { type: 'battlemetrics', source: 'bm-1 ' },
  { type: 'battlemetrics,bm', source: '1' },
  { type: 'battlemetrics', source: null }
])
  assert.notStrictEqual(sourceKey(other), key, JSON.stringify(other));

// A list's error is kept on one line, without any address, as a remote list's address may hold a
// key, and in printable ASCII, cut to 500 characters.
assert.strictEqual(
  cleanError(
    'Error: could not fetch https://bans.example/list.txt?key=s3cret and\n\tHTTP://other.example:8080/x?token=abc,\r\n then gave up'
  ),
  'Error: could not fetch [address] and [address] then gave up'
);
// Each character it cannot keep, even one written with two UTF-16 code units, becomes one ?.
assert.strictEqual(
  cleanError('A ban list called “Ünïcødé” 🎉 failed'),
  'A ban list called ??n?c?d?? ? failed'
);
assert.strictEqual(cleanError(new Error('An error')), 'Error: An error');
assert.strictEqual(cleanError('x'.repeat(500)), 'x'.repeat(500));
assert.strictEqual(cleanError('x'.repeat(501)), `${'x'.repeat(497)}...`);
assert.strictEqual(cleanError(`  ${'y '.repeat(400)}`).length, 500);

// Only BattleMetrics' 404 with its Unknown ban list title, and a list that gives no bans but counts
// some, mean that CBL can no longer read a list. Any other error is a failure.
assert.strictEqual(
  accessProblem({ status: 404, titles: ['Unknown ban list'] }),
  'BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list)'
);
assert.ok(accessProblem({ response: { status: 404 }, titles: ['Other', 'unknown banlist'] }));
assert.strictEqual(
  accessProblem({ bansHidden: true, metaTotal: 11768 }),
  'BattleMetrics counts 11,768 bans on it but gave none of them'
);
assert.strictEqual(
  accessProblem({ bansHidden: true, metaTotal: 1 }),
  'BattleMetrics counts 1 ban on it but gave none of them'
);
for (const err of [
  { status: 404 },
  { status: 404, titles: ['Not found'] },
  { status: 403, titles: ['Unknown ban list'] },
  { status: 500, titles: ['Unknown ban list'] },
  new Error('Unknown ban list'),
  null,
  undefined
])
  assert.strictEqual(accessProblem(err), null, JSON.stringify(err));

// A list's state is what its attempt found, the most important first.
assert.strictEqual(stateOf({ held: 0 }), 'ok');
assert.strictEqual(stateOf({ held: 3 }), 'held');
assert.strictEqual(stateOf({ error: 'Error: x', held: 3 }), 'failing');
assert.strictEqual(stateOf({ accessLost: NOT_VISIBLE, error: 'Error: x' }), 'access_lost');
assert.strictEqual(stateOf({ selfImport: 12, accessLost: NOT_VISIBLE, error: 'x' }), 'self_import');

// nextSync from every state, and from no row, to every state. Times are numbers here, as the
// module takes them as they come.
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const EARLIER = Date.parse('2026-10-16T06:00:00.000Z');
const KEY = sourceKey({ type: 'battlemetrics', source: 'bm-7' });
const rowIn = (state, consecutiveFailures = state === 'failing' ? 1 : 0) => ({
  banList: 7,
  sourceKey: KEY,
  state,
  lastAttemptAt: EARLIER,
  lastSuccessAt: state === 'failing' ? EARLIER - 1000 : EARLIER,
  consecutiveFailures,
  lastError: state === 'failing' ? 'Error: earlier' : null,
  storedCount: 40,
  headTotal: 41,
  nextFullScanAt: EARLIER
});
const OUTCOMES = {
  ok: { held: 0, storedCount: 42, headTotal: 42 },
  failing: { error: 'Error: Request failed with status code 503', held: 0, storedCount: 40 },
  access_lost: { accessLost: NOT_VISIBLE, held: 0, storedCount: 43, headTotal: 43 },
  self_import: { selfImport: 12, held: 0, storedCount: 40 },
  held: { held: 30, storedCount: 40, headTotal: 10 }
};
const outcome = (state, extra = {}) => ({
  banList: 7,
  sourceKey: KEY,
  now: NOW,
  selfImport: null,
  accessLost: null,
  error: null,
  ...OUTCOMES[state],
  ...extra
});
const IMPORT_FIELDS = [
  'banList',
  'sourceKey',
  'state',
  'lastAttemptAt',
  'lastSuccessAt',
  'consecutiveFailures',
  'lastError',
  'storedCount',
  'headTotal'
];
// Every column of BanListSyncs but updatedAt, which Sequelize sets on every save.
const ALL_FIELDS = [
  ...IMPORT_FIELDS,
  'lastHeadPollAt',
  'lastFullScanAt',
  'nextFullScanAt',
  'scanReason',
  'incompleteScans',
  'headUids',
  'replacePending',
  'allowFullRemovalUntil',
  'remoteEtag',
  'remoteLastModified',
  'remoteBodyHash'
];

for (const from of [null, 'ok', 'failing', 'access_lost', 'self_import', 'held']) {
  for (const to of ['ok', 'failing', 'access_lost', 'self_import', 'held']) {
    const label = `${from} to ${to}`;
    const before = from ? rowIn(from) : null;
    const previous = before ?? {
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      headTotal: null
    };
    const sync = plain(nextSync(before, outcome(to)));
    assert.strictEqual(sync.values.state, to, label);

    // A list importing a CBL export ban list is never tried, so its times and failures stay.
    // Any other list was tried now, and imported now unless it failed.
    const tried = to !== 'self_import';
    assert.strictEqual(sync.values.lastAttemptAt, tried ? NOW : previous.lastAttemptAt, label);
    assert.strictEqual(
      sync.values.lastSuccessAt,
      tried && to !== 'failing' ? NOW : previous.lastSuccessAt,
      label
    );
    const failures = {
      failing: previous.consecutiveFailures + 1,
      self_import: previous.consecutiveFailures
    };
    assert.strictEqual(sync.values.consecutiveFailures, failures[to] ?? 0, label);
    assert.strictEqual(
      sync.values.lastError,
      {
        failing: 'Error: Request failed with status code 503',
        access_lost:
          'Its source is not among the BattleMetrics ban lists the CBL organisation can see, so its bans are not checked for removal.'
      }[to] ?? null,
      label
    );
    assert.strictEqual(sync.values.storedCount, OUTCOMES[to].storedCount, label);
    // BattleMetrics' count is kept when the attempt got none.
    assert.strictEqual(sync.values.headTotal, OUTCOMES[to].headTotal ?? previous.headTotal, label);

    // Entering self_import or access_lost is posted, staying in it is not. Failing is posted at
    // the 3rd failed run in a row only.
    const alerts = [];
    if ((to === 'self_import' || to === 'access_lost') && from !== to) alerts.push(to);
    assert.deepStrictEqual(sync.alerts, alerts, label);
    assert.strictEqual(
      sync.recovered,
      from === 'access_lost' && (to === 'ok' || to === 'held')
        ? 'CBL can read it on BattleMetrics again'
        : null,
      label
    );

    // A list with a row saves only the import's columns, so values others set are kept, and a new
    // list's row starts with every column.
    if (before) assert.deepStrictEqual(sync.fields, IMPORT_FIELDS, label);
    else {
      assert.deepStrictEqual([...sync.fields].sort(), [...ALL_FIELDS].sort(), label);
      assert.strictEqual(sync.values.nextFullScanAt, null, label);
      assert.strictEqual(sync.values.replacePending, false, label);
      assert.strictEqual(sync.values.incompleteScans, 0, label);
    }
  }
}

// Failed runs in a row are counted, and the 3rd is posted once: not the 1st, 2nd, 4th or 5th. A run
// whose list CBL cannot read counts as failed if its attempt failed, but is not posted as failing,
// as its loss of access was. Once it imports, the count starts again, and the console is told.
{
  let row = null;
  const posted = [];
  for (let run = 1; run <= 5; run++) {
    const sync = nextSync(row, outcome('failing'));
    row = sync.values;
    posted.push([...sync.alerts]);
  }
  assert.deepStrictEqual(posted, [[], [], ['failing'], [], []]);
  assert.strictEqual(row.consecutiveFailures, 5);
  const imported = nextSync(row, outcome('ok'));
  assert.strictEqual(imported.values.consecutiveFailures, 0);
  assert.strictEqual(imported.recovered, 'it was imported again, after failing 5 runs in a row');
  assert.strictEqual(nextSync(rowIn('failing', 2), outcome('ok')).recovered, null);
  assert.strictEqual(
    nextSync(rowIn('failing', 3), outcome('held')).recovered,
    'it was imported again, after failing 3 runs in a row'
  );

  const lost = outcome('access_lost', {
    accessLost: 'BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list)',
    error: 'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)',
    headTotal: undefined
  });
  const third = plain(nextSync(rowIn('access_lost', 2), lost));
  assert.deepStrictEqual(
    [third.values.state, third.values.consecutiveFailures, third.alerts],
    ['access_lost', 3, []]
  );
  assert.strictEqual(third.values.lastError, lost.error);
  assert.strictEqual(third.values.lastSuccessAt, EARLIER);
  // A list that fails for the 3rd time in a row just after it could not be read is posted.
  assert.deepStrictEqual(plain(nextSync(rowIn('access_lost', 2), outcome('failing')).alerts), [
    'failing'
  ]);
  // A list importing a CBL export ban list keeps its count, as it is not tried.
  assert.strictEqual(
    nextSync(rowIn('failing', 2), outcome('self_import')).values.consecutiveFailures,
    2
  );
}

// A list whose type or source was changed starts afresh: its failures and BattleMetrics' count are
// forgotten, every column is saved, other columns are reset, and its state is posted about as for
// a new list.
{
  const before = {
    ...rowIn('access_lost', 2),
    sourceKey: sourceKey({ type: 'battlemetrics', source: 'bm-old' })
  };
  const failed = plain(nextSync(before, outcome('failing', { storedCount: 0 })));
  assert.deepStrictEqual(
    [failed.values.consecutiveFailures, failed.values.lastSuccessAt, failed.values.headTotal],
    [1, null, null]
  );
  assert.strictEqual(failed.values.nextFullScanAt, null);
  assert.strictEqual(failed.values.sourceKey, KEY);
  assert.strictEqual(failed.fields.length, 20);
  assert.deepStrictEqual(failed.alerts, []);
  assert.deepStrictEqual(plain(nextSync(before, outcome('access_lost')).alerts), ['access_lost']);
  assert.deepStrictEqual(
    plain(nextSync({ ...rowIn('self_import'), sourceKey: 'other' }, outcome('self_import')).alerts),
    ['self_import']
  );
  assert.strictEqual(
    nextSync({ ...rowIn('failing', 5), sourceKey: 'other' }, outcome('ok')).recovered,
    null
  );
}

// The alerts, as they are posted to the log channel.
{
  const failing = nextSync(rowIn('failing', 2), outcome('failing'));
  assert.strictEqual(
    describeAlert('failing', failing.values, outcome('failing')),
    'Ban list (ID: 7) has failed to import 3 runs in a row, so its bans may be out of date: it was last imported at 2026-10-16T05:59:59.000Z. Its latest error: Error: Request failed with status code 503'
  );
  const never = nextSync({ ...rowIn('failing', 2), lastSuccessAt: null }, outcome('failing'));
  assert.match(
    describeAlert('failing', never.values, outcome('failing')),
    /so its bans may be out of date: it has not been imported from its current source yet\. Its latest error: /
  );
  const lost = outcome('access_lost');
  assert.strictEqual(
    describeAlert('access_lost', nextSync(rowIn('ok'), lost).values, lost),
    "CBL can no longer read ban list (ID: 7) on BattleMetrics, as its source is not among the BattleMetrics ban lists the CBL organisation can see, so none of its 43 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
  );
  for (const [storedCount, kept] of [
    [0, 'none of its bans are'],
    [1, 'its 1 stored ban is not'],
    [2, 'none of its 2 stored bans are']
  ]) {
    const few = outcome('access_lost', { storedCount });
    assert.ok(
      describeAlert('access_lost', nextSync(rowIn('ok'), few).values, few).includes(
        `can see, so ${kept} removed from it while it cannot. `
      ),
      String(storedCount)
    );
  }
  const many = outcome('self_import', { storedCount: 1234 });
  assert.strictEqual(
    describeAlert('self_import', nextSync(null, many).values, many),
    "Ban list (ID: 7) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 1,234 stored bans are kept until the list is removed with /banlist remove, which removes them too."
  );
  const one = outcome('self_import', { storedCount: 1 });
  assert.match(
    describeAlert('self_import', nextSync(null, one).values, one),
    /new bans\. Its 1 stored ban is kept until the list is removed with \/banlist remove, which removes the ban too\.$/
  );
  const none = outcome('self_import', { storedCount: 0 });
  assert.match(
    describeAlert('self_import', nextSync(null, none).values, none),
    /new bans\. Remove the list with \/banlist remove\.$/
  );
  assert.throws(() => describeAlert('held', nextSync(null, outcome('held')).values, {}));
}

console.log(
  'Ban list sync state checks passed: every change of state, failed runs and their alert, changed sources, the access check, lost access and kept errors.'
);
