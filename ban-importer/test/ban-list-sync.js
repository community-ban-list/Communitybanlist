import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { normaliseBattlemetricsID } from '../../scbl-lib/utils/battlemetrics-id.js';

// Check how a ban list's sync state is worked out, without a database or network requests: every
// change of state and the alerts it calls for, the count of failed runs, lists whose source was
// changed, the access check's read of BattleMetrics' ban lists, which errors mean lost access, lists
// still taken to have lost access when a run cannot tell, and how errors are kept. import-bans.js
// checks the importer saving it.

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
  describeWidespreadLoss,
  FAILURE_ALERT_RUNS,
  isWidespread,
  nextSync,
  NOT_VISIBLE,
  readAccessCheck,
  readVisibleBanLists,
  sourceKey,
  stateOf,
  STATES,
  UNCONFIRMED
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
// A word that holds an address is replaced as a whole, and cleaning stays quick for long text that
// a server could send, such as a long run of letters with no address in it.
assert.strictEqual(cleanError('Bad source url=https://bans.example/x.txt'), 'Bad source [address]');
for (const long of ['a'.repeat(100000), 'a:'.repeat(50000), 'a:/'.repeat(30000)]) {
  const started = performance.now();
  assert.strictEqual(cleanError(long).length, 500);
  assert.ok(performance.now() - started < 200, 'Cleaning a long error stays quick');
}

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
  // A list that starts failing with its count already past 3, as it was not failing before, e.g.
  // as it imported a CBL export ban list meanwhile, is posted about at once, but only once.
  for (const from of ['self_import', 'access_lost']) {
    const entered = plain(nextSync(rowIn(from, 4), outcome('failing')));
    assert.deepStrictEqual(
      [entered.values.state, entered.values.consecutiveFailures, entered.alerts],
      ['failing', 5, ['failing']],
      from
    );
    assert.deepStrictEqual(plain(nextSync(entered.values, outcome('failing')).alerts), [], from);
  }
}

// A list CBL had lost access to stays so while a run cannot tell whether CBL can read it again: its
// access check could not be made, or its fetch failed for another reason, such as a 401 or a 500.
// The importer then gives it UNCONFIRMED. It is not posted about again, its row keeps why it lost
// access, and it is not said to be back to normal. A failed fetch still counts as a failed run. Only
// a run whose fetch works, while the check finds the list or is off, brings it back.
{
  const lostRow = {
    ...rowIn('access_lost', 1),
    lastError: 'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)'
  };
  const unchecked = plain(nextSync(lostRow, outcome('ok', { accessLost: UNCONFIRMED })));
  assert.deepStrictEqual(
    [
      unchecked.values.state,
      unchecked.values.consecutiveFailures,
      unchecked.values.lastError,
      unchecked.values.lastSuccessAt,
      unchecked.alerts,
      unchecked.recovered
    ],
    ['access_lost', 0, lostRow.lastError, NOW, [], null]
  );
  assert.deepStrictEqual(unchecked.fields, IMPORT_FIELDS);
  for (const error of [
    'ApiError: BattleMetrics GET bans failed after 3 attempts: HTTP 401 (Unauthorized)',
    'Error: Request failed with status code 500'
  ]) {
    const failed = plain(nextSync(lostRow, outcome('failing', { error, accessLost: UNCONFIRMED })));
    assert.deepStrictEqual(
      [
        failed.values.state,
        failed.values.consecutiveFailures,
        failed.values.lastError,
        failed.values.lastSuccessAt,
        failed.alerts,
        failed.recovered
      ],
      ['access_lost', 2, lostRow.lastError, EARLIER, [], null],
      error
    );
  }
  const back = plain(nextSync(lostRow, outcome('ok')));
  assert.deepStrictEqual(
    [back.values.state, back.values.lastError, back.alerts, back.recovered],
    ['ok', null, [], 'CBL can read it on BattleMetrics again']
  );
}

// Runs in a row, each worked out from the row the one before saved. Each step gives the run's error,
// or null, and what it found about access: why CBL cannot read the list, undefined when the access
// check found the list or is off, or null when the check could not be made. As the importer does, a
// list whose row is access_lost, and whose run cannot tell, as its check could not be made or its
// fetch failed for another reason, is given UNCONFIRMED.
function runs(steps) {
  let row = null;
  return steps.map(([error, found]) => {
    const cannotTell = found === null || (error && found === undefined);
    const accessLost = found || (row?.state === 'access_lost' && cannotTell ? UNCONFIRMED : null);
    const sync = plain(
      nextSync(row, outcome(error ? 'failing' : 'ok', { error, accessLost, headTotal: undefined }))
    );
    row = sync.values;
    return [row.state, row.consecutiveFailures, sync.alerts, sync.recovered];
  });
}
const UNKNOWN_LIST =
  'BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list)';
const HTTP_404 = 'ApiError: BattleMetrics GET bans failed: HTTP 404 (Unknown ban list)';
const HTTP_503 = 'ApiError: BattleMetrics GET bans failed after 3 attempts: HTTP 503';
// A 404 Unknown ban list, a 503, then the 404 again: the list is access_lost throughout, posted
// about once, and its failures count 1, 2, 3.
assert.deepStrictEqual(
  runs([
    [HTTP_404, UNKNOWN_LIST],
    [HTTP_503, undefined],
    [HTTP_404, UNKNOWN_LIST]
  ]),
  [
    ['access_lost', 1, ['access_lost'], null],
    ['access_lost', 2, [], null],
    ['access_lost', 3, [], null]
  ]
);
// Not among the ban lists CBL can see, then a run whose check could not be made (null), then not
// among them again: posted about once, never said to be back to normal.
assert.deepStrictEqual(
  runs([
    [null, NOT_VISIBLE],
    [null, null],
    [null, NOT_VISIBLE]
  ]),
  [
    ['access_lost', 0, ['access_lost'], null],
    ['access_lost', 0, [], null],
    ['access_lost', 0, [], null]
  ]
);
// Three 404s, then three 503s: still access_lost, so it is not posted about as failing, as its loss
// of access was, until a run that can read it brings it back.
assert.deepStrictEqual(
  runs([
    [HTTP_404, UNKNOWN_LIST],
    [HTTP_404, UNKNOWN_LIST],
    [HTTP_404, UNKNOWN_LIST],
    [HTTP_503, undefined],
    [HTTP_503, undefined],
    [HTTP_503, undefined],
    [null, undefined]
  ]),
  [
    ['access_lost', 1, ['access_lost'], null],
    ['access_lost', 2, [], null],
    ['access_lost', 3, [], null],
    ['access_lost', 4, [], null],
    ['access_lost', 5, [], null],
    ['access_lost', 6, [], null],
    ['ok', 0, [], 'CBL can read it on BattleMetrics again']
  ]
);
// Two 503s, a 404 Unknown ban list at the 3rd failed run, then a 503: posted about as lost access
// only, and still access_lost.
assert.deepStrictEqual(
  runs([
    [HTTP_503, undefined],
    [HTTP_503, undefined],
    [HTTP_404, UNKNOWN_LIST],
    [HTTP_503, undefined]
  ]),
  [
    ['failing', 1, [], null],
    ['failing', 2, [], null],
    ['access_lost', 3, ['access_lost'], null],
    ['access_lost', 4, [], null]
  ]
);
// Five failed runs: posted about at the 3rd only.
assert.deepStrictEqual(
  runs(Array.from({ length: 5 }, () => [HTTP_503, undefined])).map(([, , alerts]) => alerts),
  [[], [], ['failing'], [], []]
);

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

// The alerts, as they are posted to the log channel. Each is described from what nextSync gave.
{
  const alert = (kind, before, result) => describeAlert(kind, nextSync(before, result), result);
  assert.strictEqual(
    alert('failing', rowIn('failing', 2), outcome('failing')),
    'Ban list (ID: 7) has failed to import 3 runs in a row, so its bans may be out of date: it was last imported at 2026-10-16T05:59:59.000Z. Its latest error: Error: Request failed with status code 503'
  );
  // It gives the list's count of failed runs, which can be past 3.
  assert.match(
    alert('failing', rowIn('self_import', 4), outcome('failing')),
    /^Ban list \(ID: 7\) has failed to import 5 runs in a row, so /
  );
  // A list with no time it was imported, as its row is new, e.g. the first after this version is
  // deployed, or as its source was changed, is not said never to have been imported.
  assert.match(
    alert('failing', { ...rowIn('failing', 2), lastSuccessAt: null }, outcome('failing')),
    /so its bans may be out of date: the importer has no record of importing it from its current source\. Its latest error: /
  );

  // A list CBL lost access to is said to be one it can no longer read if it was imported before,
  // and one it cannot read otherwise, as when its row is new.
  const unknown = outcome('access_lost', {
    accessLost: UNKNOWN_LIST,
    error: HTTP_404,
    headTotal: undefined
  });
  assert.strictEqual(
    alert('access_lost', rowIn('ok'), unknown),
    "CBL can no longer read ban list (ID: 7) on BattleMetrics, as BattleMetrics answers that it does not know the list (HTTP 404, Unknown ban list), so none of its 43 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
  );
  for (const before of [null, { ...rowIn('failing', 1), lastSuccessAt: null }])
    assert.match(
      alert('access_lost', before, unknown),
      /^CBL cannot read ban list \(ID: 7\) on BattleMetrics, as BattleMetrics answers/
    );
  for (const [storedCount, kept] of [
    [0, 'none of its bans are'],
    [1, 'its 1 stored ban is not'],
    [2, 'none of its 2 stored bans are']
  ]) {
    const few = { ...unknown, storedCount };
    assert.ok(
      alert('access_lost', rowIn('ok'), few).includes(
        `Unknown ban list), so ${kept} removed from it while it cannot. `
      ),
      String(storedCount)
    );
  }
  // A list BattleMetrics does not list, but whose fetch worked, is said to be so, without the
  // advice to remove it, as its owner has not taken it from CBL. One whose fetch failed too is
  // said to be one CBL cannot read.
  const unlisted = outcome('access_lost');
  assert.strictEqual(
    alert('access_lost', rowIn('ok'), unlisted),
    'Ban list (ID: 7) is not among the BattleMetrics ban lists the CBL organisation can see, although CBL could still read it. Its new bans are saved, but none of its 43 stored bans are removed from it until BattleMetrics lists it again.'
  );
  assert.strictEqual(
    alert('access_lost', rowIn('ok'), { ...unlisted, error: HTTP_503 }),
    "CBL can no longer read ban list (ID: 7) on BattleMetrics, as its source is not among the BattleMetrics ban lists the CBL organisation can see, so none of its 43 stored bans are removed from it while it cannot. If the list's owner has stopped sharing it with the CBL organisation, remove the list with /banlist remove, which removes its bans too."
  );

  const many = outcome('self_import', { storedCount: 1234 });
  assert.strictEqual(
    alert('self_import', null, many),
    "Ban list (ID: 7) is not imported, as its source is CBL's own export ban list (#12), and importing it would feed the players CBL exports back in as new bans. Its 1,234 stored bans are kept until the list is removed with /banlist remove, which removes them too."
  );
  assert.match(
    alert('self_import', null, outcome('self_import', { storedCount: 1 })),
    /new bans\. Its 1 stored ban is kept until the list is removed with \/banlist remove, which removes the ban too\.$/
  );
  assert.match(
    alert('self_import', null, outcome('self_import', { storedCount: 0 })),
    /new bans\. Remove the list with \/banlist remove\.$/
  );
  assert.throws(() => alert('held', null, outcome('held')));
}

// Lists that lose access in the same run are posted about together when there are at least 3 of
// them and they are at least half of the BattleMetrics lists the run tried, as CBL's own token is
// then the likelier cause.
for (const [lost, tried, together] of [
  [2, 2, false],
  [3, 3, true],
  [3, 6, true],
  [3, 7, false],
  [10, 20, true],
  [9, 20, false],
  [20, 20, true]
])
  assert.strictEqual(isWidespread(lost, tried), together, `${lost} of ${tried}`);
assert.strictEqual(
  describeWidespreadLoss([1, 2, 46], 20),
  "CBL lost access to 3 of the 20 BattleMetrics ban lists it tried in this run (IDs: 1, 2, 46): it cannot read them, or BattleMetrics does not list them among the ban lists the CBL organisation can see. So many at once points at CBL's BattleMetrics token, or its role in the CBL organisation, rather than at the lists' owners, so check the token before removing any of these lists. None of their bans are removed while this lasts."
);

console.log(
  'Ban list sync state checks passed: every change of state, failed runs and their alert, changed sources, the access check, lost access, runs that cannot tell, widespread losses and kept errors.'
);
