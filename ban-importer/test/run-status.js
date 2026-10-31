import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check how a run's status is drawn as a Discord embed, without Discord: in every state of a run,
// always within Discord's limits for an embed, and how the embed of a run that ended without its
// last edit is marked by the next run.

// Discord's limits for an embed, in characters.
const LIMITS = {
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  total: 6000
};

// Check an embed against Discord's limits. Characters are counted as JavaScript counts them, which
// counts an emoji as one or two, never fewer than Discord does. No text is left with half an emoji
// after a cut.
function checkLimits(embed) {
  const fields = embed.fields ?? [];
  assert.ok(embed.title.length <= LIMITS.title, 'title');
  assert.ok(embed.description.length <= LIMITS.description, 'description');
  assert.ok(fields.length <= LIMITS.fields, 'fields');
  for (const { name, value } of fields) {
    assert.ok(name.length > 0 && name.length <= LIMITS.fieldName, 'field name');
    assert.ok(value.length > 0 && value.length <= LIMITS.fieldValue, 'field value');
  }
  assert.ok((embed.footer?.text ?? '').length <= LIMITS.footer, 'footer');
  const texts = [
    embed.title,
    embed.description,
    embed.footer?.text ?? '',
    ...fields.flatMap(({ name, value }) => [name, value])
  ];
  assert.ok(texts.join('').length <= LIMITS.total, 'total');
  for (const text of texts) assert.ok(text.isWellFormed(), `${text} is cut in half an emoji`);
  assert.ok(Number.isInteger(embed.color));
  assert.ok(!Number.isNaN(Date.parse(embed.timestamp)));
}

// The drawing has no imports, so it is loaded on its own, in a context of its own.
const url = new URL('../src/run-status.js', import.meta.url);
const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
  context: vm.createContext({}),
  identifier: url.href
});
await module.link(() => assert.fail('run-status.js has no imports'));
await module.evaluate();
const { default: draw, markEnded, markUnfinished, COLORS, TITLES } = module.namespace;
// Embeds are made in the drawing's own context, so they are copied into this one to compare them.
const copy = (value) => JSON.parse(JSON.stringify(value));
const render = (state) => {
  const embed = copy(draw(state));
  checkLimits(embed);
  return embed;
};
const lines = (embed) => embed.description.split('\n');

const START = Date.parse('2026-10-16T14:51:41.062Z');
const UNIX = Math.floor(START / 1000);
const SECOND = 1000;
const STEPS = [
  'importBans',
  'expireBans',
  'updateSteamUserInfo',
  'clearOrphanedUsers',
  'updateReputationPoints',
  'updateReputationRank',
  'updateExportBans',
  'exportExportBans'
];
const LABELS = [
  'Import',
  'Expired bans',
  'Steam profiles',
  'Orphaned players',
  'Reputation points',
  'Reputation ranks',
  'Export recalculation',
  'Export push'
];
const SETUP = ['waitForDatabase', 'takeRunLock', 'connect', 'migrate'];
// How long each phase took in a run like production's.
const PHASES = {
  waitForDatabase: 0.01,
  takeRunLock: 0,
  connect: 0.01,
  migrate: 0.02,
  importBans: 499.93,
  expireBans: 0.08,
  updateSteamUserInfo: 14.2,
  clearOrphanedUsers: 0.12,
  updateReputationPoints: 0.66,
  updateReputationRank: 5.32,
  updateExportBans: 52.4,
  exportExportBans: 1.48
};
const DURATIONS = ['8m 20s', '0.1s', '14s', '0.1s', '0.7s', '5.3s', '52s', '1.5s'];
// What the steps count, and how far they get, in such a run.
const COUNTS = {
  importBans: {
    lists: 20,
    imported: 20,
    fetched: 87026,
    new: 1,
    updated: 0,
    removed: 1,
    held: 0,
    failedLists: 0,
    banLists: [{ id: 3, fetched: 7641 }]
  },
  expireBans: { due: 12, expired: 12, players: 11 },
  updateSteamUserInfo: { due: 498, updated: 497 },
  updateExportBans: { players: 145155 },
  exportExportBans: { queued: 8, created: 5, deleted: 3, failed: 0 }
};
const DETAILS = {
  importBans:
    '> 20 ban lists: 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed',
  expireBans: '> 12 bans marked expired, 11 players queued',
  updateSteamUserInfo: '> 497 of 498 updated',
  updateExportBans: '> 145,155 players',
  exportExportBans: '> 5 created, 3 deleted of 8 export bans'
};
const PROGRESS = {
  importBans: { done: 7, total: 20, unit: 'ban lists' },
  expireBans: { done: 0, total: 12, unit: 'bans' },
  updateSteamUserInfo: { done: 250, total: 498, unit: 'Steam users' },
  updateExportBans: { done: 18250, total: 145155, unit: 'players' },
  exportExportBans: { done: 2, total: 8, unit: 'export bans' }
};
const BARS = {
  importBans: '> ``[███████             ]`` 7 / 20 ban lists',
  expireBans: '> ``[                    ]`` 0 / 12 bans',
  updateSteamUserInfo: '> ``[██████████          ]`` 250 / 498 Steam users',
  updateExportBans: '> ``[██                  ]`` 18,250 / 145,155 players',
  exportExportBans: '> ``[█████               ]`` 2 / 8 export bans'
};

// A run under way in the given step, 9 seconds into it, the steps before it finished, with the
// progress the step reported, if any.
function running(current, { progress = true, migrations = [] } = {}) {
  const index = STEPS.indexOf(current);
  const done = STEPS.slice(0, index);
  const at = START + 600 * SECOND;
  return {
    outcome: 'running',
    startedAt: START,
    at,
    gitSha: '28388bacfb5f3f467a9d4459770b747cd904a4f7',
    steps: STEPS,
    phases: Object.fromEntries([...SETUP, ...done].map((name) => [name, PHASES[name]])),
    phase: current,
    phaseStartedAt: at - 9 * SECOND,
    completed: [...SETUP, ...done],
    progress: progress && PROGRESS[current] ? { [current]: PROGRESS[current] } : {},
    counts: Object.fromEntries(done.filter((name) => COUNTS[name]).map((n) => [n, COUNTS[n]])),
    migrations
  };
}

// While a run goes, its embed says it is in progress, in blurple, when it started, in each viewer's
// own time and how long ago, how long it has taken, and its commit. Below are its steps: each
// finished one with a tick, its time and what it counted, the one under way with how long it has
// taken and, when it reports it, a bar and how far it has got, and the steps still to run.
{
  const embed = render(running('updateExportBans'));
  assert.deepStrictEqual(embed, {
    title: 'CBL update run in progress',
    color: 0x5865f2,
    description: [
      `Started <t:${UNIX}:f> (<t:${UNIX}:R>) · commit \`28388ba\``,
      'Elapsed **10m 00s**',
      '',
      '✅ **Import** · 8m 20s',
      DETAILS.importBans,
      '✅ **Expired bans** · 0.1s',
      DETAILS.expireBans,
      '✅ **Steam profiles** · 14s',
      DETAILS.updateSteamUserInfo,
      '✅ **Orphaned players** · 0.1s',
      '✅ **Reputation points** · 0.7s',
      '✅ **Reputation ranks** · 5.3s',
      '🔄 **Export recalculation** · 9.0s',
      BARS.updateExportBans,
      '▫️ Export push'
    ].join('\n'),
    footer: { text: 'Last updated' },
    timestamp: '2026-10-16T15:01:41.062Z'
  });
  assert.strictEqual(COLORS.running, 0x5865f2);
  assert.strictEqual(TITLES.running, embed.title);
}

// It is drawn so at every step, with and without the step's progress.
for (const [index, name] of STEPS.entries()) {
  for (const progress of [true, false]) {
    const embed = render(running(name, { progress }));
    assert.strictEqual(embed.title, 'CBL update run in progress');
    const expected = [
      `Started <t:${UNIX}:f> (<t:${UNIX}:R>) · commit \`28388ba\``,
      'Elapsed **10m 00s**',
      ''
    ];
    for (const [other, step] of STEPS.entries()) {
      if (other < index) {
        expected.push(`✅ **${LABELS[other]}** · ${DURATIONS[other]}`);
        if (DETAILS[step]) expected.push(DETAILS[step]);
      } else if (other === index) {
        expected.push(`🔄 **${LABELS[other]}** · 9.0s`);
        if (progress && BARS[step]) expected.push(BARS[step]);
      } else {
        expected.push(`▫️ ${LABELS[other]}`);
      }
    }
    assert.deepStrictEqual(lines(embed), expected, `${name}, progress ${progress}`);
  }
}

// Bars have 20 cells: none at the start, one for each twentieth done, and all once the step is
// done, or when it has nothing to do. The numbers have thousands separators.
for (const [done, total, cells] of [
  [0, 100, 0],
  [4, 100, 0],
  [5, 100, 1],
  [50, 100, 10],
  [99, 100, 19],
  [100, 100, 20],
  [0, 0, 20],
  [150, 100, 20]
]) {
  const state = running('exportExportBans');
  state.progress = { exportExportBans: { done, total, unit: 'export bans' } };
  const bar = lines(render(state)).at(-1);
  const [, filled, empty] = bar.match(/^> ``\[(█*)( *)\]`` /);
  assert.deepStrictEqual([filled.length, empty.length], [cells, 20 - cells], `${done} / ${total}`);
  assert.ok(bar.endsWith(` ${done.toLocaleString('en-US')} / ${total} export bans`));
}

// Before the steps, a phase that is not a step is shown while it is under way, such as connecting
// to the database or applying the migrations, and the migrations applied are listed below the
// time, also once the run has ended.
{
  const state = running('importBans', { migrations: ['001-importer-state'] });
  Object.assign(state, {
    phase: 'migrate',
    phases: { waitForDatabase: 0.01, takeRunLock: 0, connect: 0.5 },
    completed: ['waitForDatabase', 'takeRunLock', 'connect'],
    progress: {}
  });
  assert.deepStrictEqual(lines(render(state)).slice(1), [
    'Elapsed **10m 00s**',
    'Applied migrations 001-importer-state',
    '',
    '🔄 **Migrations** · 9.0s',
    ...LABELS.map((label) => `▫️ ${label}`)
  ]);
  // Once it has finished, it is not shown, as the run went on.
  state.completed.push('migrate');
  state.phases.migrate = 0.02;
  assert.deepStrictEqual(lines(render(state)).slice(3, 5), ['', '▫️ Import']);
}
{
  // Without migrations, there is no such line.
  const embed = render(running('importBans'));
  assert.ok(!embed.description.includes('migrations'));
}

// A run that ended gets a title and colour for how it ended: finished in green, failed in red,
// stopped in orange, and lost its locks in red. Its time is how long it took, and each step that
// finished shows its time and counts.
// completed lists the steps that finished, after the phases before them, or, for a run that ended
// in one of those, the phases that finished.
function ended(outcome, { phase = 'exportExportBans', completed = STEPS, reason, ...rest } = {}) {
  return {
    outcome,
    startedAt: START,
    at: START + 574 * SECOND,
    seconds: 574.13,
    gitSha: '28388ba',
    steps: STEPS,
    phases: PHASES,
    phase,
    completed: SETUP.includes(phase) ? completed : [...SETUP, ...completed],
    progress: { ...PROGRESS, exportExportBans: { done: 8, total: 8, unit: 'export bans' } },
    counts: COUNTS,
    migrations: [],
    reason,
    ...rest
  };
}
{
  const embed = render(ended('finished'));
  assert.deepStrictEqual(embed, {
    title: 'CBL update run finished',
    color: 0x57f287,
    description: [
      `Started <t:${UNIX}:f> · took **9m 34s** · commit \`28388ba\``,
      '',
      '✅ **Import** · 8m 20s',
      DETAILS.importBans,
      '✅ **Expired bans** · 0.1s',
      DETAILS.expireBans,
      '✅ **Steam profiles** · 14s',
      DETAILS.updateSteamUserInfo,
      '✅ **Orphaned players** · 0.1s',
      '✅ **Reputation points** · 0.7s',
      '✅ **Reputation ranks** · 5.3s',
      '✅ **Export recalculation** · 52s',
      DETAILS.updateExportBans,
      '✅ **Export push** · 1.5s',
      DETAILS.exportExportBans
    ].join('\n'),
    footer: { text: 'Ended' },
    timestamp: '2026-10-16T15:01:15.062Z'
  });
}

// One that did not finish names the phase it ended in and why. The step it ended in is marked with
// a cross when it failed, and with a stop when it was stopped or lost its lock, with what it got
// done, and the steps after it were not run.
const recalculation = {
  phase: 'updateExportBans',
  completed: STEPS.slice(0, 6),
  counts: { ...COUNTS, updateExportBans: { players: 18250 }, exportExportBans: undefined }
};
for (const [outcome, title, color, mark, reason] of [
  [
    'failed',
    'CBL update run failed',
    0xed4245,
    '❌',
    'SequelizeDatabaseError: Deadlock found when trying to get lock; try restarting transaction'
  ],
  ['stopped', 'CBL update run stopped', 0xe67e22, '⏹️', 'Stopped, as it received SIGTERM'],
  ['lockLost', 'CBL update run lost its locks', 0xed4245, '⏹️', 'Stopped, as it lost its locks']
]) {
  const embed = render(ended(outcome, { ...recalculation, reason }));
  assert.strictEqual(embed.title, title);
  assert.strictEqual(embed.color, color);
  assert.strictEqual(COLORS[outcome], color);
  assert.deepStrictEqual(lines(embed), [
    `Started <t:${UNIX}:f> · took **9m 34s** · commit \`28388ba\``,
    '**Phase** Export recalculation',
    `**Reason** ${reason}`,
    '',
    '✅ **Import** · 8m 20s',
    DETAILS.importBans,
    '✅ **Expired bans** · 0.1s',
    DETAILS.expireBans,
    '✅ **Steam profiles** · 14s',
    DETAILS.updateSteamUserInfo,
    '✅ **Orphaned players** · 0.1s',
    '✅ **Reputation points** · 0.7s',
    '✅ **Reputation ranks** · 5.3s',
    `${mark} **Export recalculation** · 52s`,
    // How far it got, of how many.
    '> 18,250 of 145,155 players',
    '▫️ Export push · not run'
  ]);
  assert.deepStrictEqual(embed.footer, { text: 'Ended' });
}
{
  // A step that counted nothing it can say shows how far it got. One that ended in a phase that is
  // not a step, such as the migrations, shows it before the steps, none of which were run.
  const steam = render(
    ended('failed', {
      phase: 'updateSteamUserInfo',
      completed: STEPS.slice(0, 2),
      counts: { importBans: COUNTS.importBans, expireBans: COUNTS.expireBans },
      reason: 'Error: Steam is down'
    })
  );
  assert.deepStrictEqual(lines(steam).slice(8, 11), [
    '❌ **Steam profiles** · 14s',
    '> got to 250 / 498 Steam users',
    '▫️ Orphaned players · not run'
  ]);
  const migrations = render(
    ended('failed', {
      phase: 'migrate',
      completed: ['waitForDatabase', 'takeRunLock', 'connect'],
      phases: { waitForDatabase: 0.01, takeRunLock: 0, connect: 0.01, migrate: 0.3 },
      progress: {},
      counts: {},
      migrations: ['001-importer-state'],
      reason:
        "MigrationError: Importer migration 002-ban-list-syncs failed: Error: CREATE command denied to user 'cbl'"
    })
  );
  assert.deepStrictEqual(lines(migrations), [
    `Started <t:${UNIX}:f> · took **9m 34s** · commit \`28388ba\``,
    'Applied migrations 001-importer-state',
    '**Phase** Migrations',
    "**Reason** MigrationError: Importer migration 002-ban-list-syncs failed: Error: CREATE command denied to user 'cbl'",
    '',
    '❌ **Migrations** · 0.3s',
    ...LABELS.map((label) => `▫️ ${label} · not run`)
  ]);
}
// A step that failed before it counted anything, e.g. as it could not read the database, keeps
// empty counts, which say nothing, rather than that none had expired or none were due.
for (const phase of ['expireBans', 'updateSteamUserInfo']) {
  const index = STEPS.indexOf(phase);
  const failed = render(
    ended('failed', {
      phase,
      completed: STEPS.slice(0, index),
      progress: {},
      counts: { importBans: COUNTS.importBans, [phase]: {} },
      reason: 'SequelizeConnectionRefusedError: connect ECONNREFUSED'
    })
  );
  const description = lines(failed);
  const at = description.indexOf(`❌ **${LABELS[index]}** · ${DURATIONS[index]}`);
  assert.ok(at > 0, phase);
  assert.strictEqual(description[at + 1], `▫️ ${LABELS[index + 1]} · not run`);
  assert.ok(description.every((line) => !/none had expired|none were due/.test(line)));
}
{
  // A run that stopped between two steps, after one finished, shows that step as finished.
  const between = render(
    ended('stopped', {
      phase: 'importBans',
      completed: STEPS.slice(0, 1),
      reason: 'Stopped, as it received SIGTERM'
    })
  );
  assert.deepStrictEqual(lines(between).slice(1, 8), [
    '**Phase** Import',
    '**Reason** Stopped, as it received SIGTERM',
    '',
    '✅ **Import** · 8m 20s',
    DETAILS.importBans,
    '▫️ Expired bans · not run',
    '▫️ Steam profiles · not run'
  ]);
}

// The steps' counts are described in their own words: the import as in its summary line, also when
// it stopped part-way, the bans marked expired and the players queued for them, the Steam profiles
// updated, and those Steam did not have, that were skipped, not saved or left for later runs, the
// players recalculated and the export bans created and deleted, with how many were on each type of
// list. Other counts are listed as they are.
for (const [name, counts, expected, progress] of [
  [
    'importBans',
    { ...COUNTS.importBans, imported: 7, fetched: 1, removed: 0, failedLists: 1 },
    '7 of 20 ban lists: 1 ban fetched, 1 new, 0 updated, 0 removed, 0 held, 1 list failed'
  ],
  // A dry run's totals say it was one.
  [
    'importBans',
    { ...COUNTS.importBans, dryRun: true },
    '20 ban lists: 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed, in a dry run that wrote nothing'
  ],
  // An import that left suspended ban lists out says how many, and names the resuming lists it
  // caught up with, which count again.
  [
    'importBans',
    { ...COUNTS.importBans, lists: 19, imported: 19, suspended: 1, caughtUp: [46] },
    '19 ban lists (1 suspended left out): 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed; ban list 46 counts again'
  ],
  [
    'importBans',
    { ...COUNTS.importBans, suspended: 0, caughtUp: [7, 46, 'x'] },
    '20 ban lists: 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed; ban lists 7, 46 count again'
  ],
  ['expireBans', { due: 0, expired: 0, players: 0 }, 'none had expired'],
  ['expireBans', { due: 1, expired: 1, players: 1 }, '1 ban marked expired, 1 player queued'],
  // A step that stopped part-way says of how many.
  [
    'expireBans',
    { due: 1200, expired: 500, players: 480 },
    '500 of 1,200 bans marked expired, 480 players queued'
  ],
  ['expireBans', { due: 3 }, null],
  // An import that says how it read its lists gives how many it only polled and read in full, and
  // the BattleMetrics requests that took, when it gives them all.
  [
    'importBans',
    {
      ...COUNTS.importBans,
      fetched: 2003,
      headPolls: 18,
      fullReads: 2,
      requests: { head: 20, follow: 1, full: 85 }
    },
    '20 ban lists: 2,003 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed; 18 polled, 2 read in full, 106 BattleMetrics requests'
  ],
  [
    'importBans',
    {
      ...COUNTS.importBans,
      headPolls: 0,
      fullReads: 20,
      requests: { head: 0, follow: 0, full: 1 },
      dryRun: true
    },
    '20 ban lists: 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed; 0 polled, 20 read in full, 1 BattleMetrics request, in a dry run that wrote nothing'
  ],
  [
    'importBans',
    { ...COUNTS.importBans, headPolls: 19, fullReads: 1, requests: { head: 'x' } },
    '20 ban lists: 87,026 bans fetched, 1 new, 0 updated, 1 removed, 0 held, 0 lists failed; 19 polled, 1 read in full'
  ],
  ['updateSteamUserInfo', { due: 0, updated: 0 }, 'none were due'],
  ['updateSteamUserInfo', { due: 1, updated: 1 }, '1 of 1 updated'],
  [
    'updateSteamUserInfo',
    { due: 5243, new: 12, updated: 493, missing: 3, skipped: 4, unsaved: 0, left: 4743, calls: 5 },
    '493 of 5,243 updated, 3 not found on Steam, 4 skipped as not SteamIDs, 4,743 left for later runs'
  ],
  [
    'updateSteamUserInfo',
    { due: 300, updated: 0, missing: 0, skipped: 0, unsaved: 1, left: 299 },
    '0 of 300 updated, 1 not saved, 299 left for later runs'
  ],
  ['updateExportBans', { players: 1 }, '1 player'],
  [
    'exportExportBans',
    { queued: 1200, created: 1000, deleted: 150, failed: 2 },
    '1,000 created, 150 deleted, 2 failed of 1,200 export bans'
  ],
  // Each count that is not 0 says how many of its export bans were on BattleMetrics and remote
  // lists, naming only the types that had any. Counts from before these were kept, as above, and
  // any that are not counts, give the totals alone.
  [
    'exportExportBans',
    {
      queued: 5,
      created: 2,
      deleted: 3,
      failed: 0,
      remote: { created: 1, deleted: 3, failed: 0 },
      battlemetrics: { created: 1, deleted: 0, failed: 0 }
    },
    '2 created (1 BattleMetrics, 1 remote), 3 deleted (3 remote) of 5 export bans'
  ],
  [
    'exportExportBans',
    {
      queued: 1200,
      created: 1000,
      deleted: 0,
      failed: 2,
      remote: { created: 0, deleted: 0, failed: 0 },
      battlemetrics: { created: 1000, deleted: 0, failed: 2 }
    },
    '1,000 created (1,000 BattleMetrics), 0 deleted, 2 failed (2 BattleMetrics) of 1,200 export bans'
  ],
  [
    'exportExportBans',
    {
      queued: 4,
      created: 2,
      deleted: 1,
      failed: 1,
      remote: { created: 'x', deleted: -1, failed: 1 },
      battlemetrics: null
    },
    '2 created, 1 deleted, 1 failed (1 remote) of 4 export bans'
  ],
  ['exportExportBans', { queued: 0, created: 0, deleted: 0, failed: 0 }, 'nothing to export'],
  ['clearOrphanedUsers', { cleared: 12, note: 'x' }, '12 cleared'],
  // Counts it cannot describe leave the line out, and the step's progress is shown instead.
  [
    'exportExportBans',
    { queued: 'many' },
    '2 / 8 export bans',
    { done: 2, total: 8, unit: 'export bans' }
  ],
  ['updateSteamUserInfo', {}, null]
]) {
  const state = ended('finished', {
    counts: { [name]: counts },
    progress: progress ? { [name]: progress } : {}
  });
  const description = lines(render(state));
  const index = description.findIndex((line) =>
    line.includes(`**${LABELS[STEPS.indexOf(name)]}**`)
  );
  assert.strictEqual(
    description[index + 1]?.startsWith('> ') ? description[index + 1].slice(2) : null,
    expected,
    `${name} ${JSON.stringify(counts)}`
  );
}

// Times are given to the tenth of a second under 10 seconds, then in seconds, minutes and hours.
for (const [seconds, shown] of [
  [0, '0.0s'],
  [0.04, '0.0s'],
  [0.66, '0.7s'],
  [9.94, '9.9s'],
  [9.96, '10s'],
  [59.4, '59s'],
  [59.6, '1m 00s'],
  [499.93, '8m 20s'],
  [3599.4, '59m 59s'],
  [3725, '1h 02m'],
  [-5, '0.0s'],
  [NaN, '0.0s']
]) {
  const embed = render(ended('finished', { seconds }));
  assert.strictEqual(
    lines(embed)[0],
    `Started <t:${UNIX}:f> · took **${shown}** · commit \`28388ba\``
  );
}

// The commit is its short SHA. Without one it is unknown, and anything else that is not a SHA is
// cut to its letters, digits, dots and dashes, so it cannot break the line's formatting.
for (const [gitSha, shown] of [
  ['28388bacfb5f3f467a9d4459770b747cd904a4f7', '28388ba'],
  ['ABCDEF1', 'ABCDEF1'],
  ['unknown', 'unknown'],
  [undefined, 'unknown'],
  ['', 'unknown'],
  ['v1.2-rc`**bold**', 'v1.2-rcbold']
])
  assert.ok(lines(render(ended('finished', { gitSha })))[0].endsWith(` · commit \`${shown}\``));

// A reason is shown on one line, as text rather than Discord's formatting, without any address,
// which could hold a key or a token, and cut cleanly, never in half an emoji, to 300 characters.
{
  const reason =
    'Error: **Bold** _x_ `code` ~~gone~~ ||spoiler|| <@123> [link](https://evil.example/x?key=secret)\n  at https://discord.com/api/webhooks/1/token and sftp://user:pass@host/x';
  const shown = lines(render(ended('failed', { reason }))).find((line) =>
    line.startsWith('**Reason**')
  );
  assert.strictEqual(
    shown,
    '**Reason** Error: \\*\\*Bold\\*\\* \\_x\\_ \\`code\\` \\~\\~gone\\~\\~ \\|\\|spoiler\\|\\| \\<@123\\> \\[link\\]((address) at (address) and (address)'
  );
  assert.ok(!shown.includes('secret') && !shown.includes('token') && !shown.includes('pass'));
}
// A reason of 10,000 characters keeps its first 299 and ends with …, wherever that cut falls: just
// after an emoji, which is two characters long, inside one, which leaves the emoji out rather than
// keep half of it, or just before one.
for (const [ys, filler, kept] of [
  [290, 'x', 'xx'],
  [290, '😀', '😀'],
  [291, 'x', 'x'],
  [291, '😀', ''],
  [292, 'x', ''],
  [292, '😀', '']
]) {
  const reason = `Error: ${'y'.repeat(ys)}${filler.repeat(5000)}`;
  const embed = render(ended('failed', { reason }));
  const shown = lines(embed).find((line) => line.startsWith('**Reason** '));
  const text = shown.slice('**Reason** '.length);
  assert.strictEqual(text, `Error: ${'y'.repeat(ys)}${kept}…`, `${ys} y and ${filler}`);
  assert.ok(text.length <= 300 && text.isWellFormed());
}

// However many steps a run has, and however long their names, the embed stays within Discord's
// limits. Runs of finished steps, and of steps still to run, are then summed up in a line each, so
// the step under way is still shown.
{
  const steps = Array.from({ length: 60 }, (_, i) => `step${i}${'n'.repeat(80)}`);
  const state = {
    outcome: 'running',
    startedAt: START,
    at: START + 3600 * SECOND,
    gitSha: '28388ba',
    steps,
    phases: Object.fromEntries(steps.slice(0, 30).map((name) => [name, 60])),
    phase: steps[30],
    phaseStartedAt: START + 3590 * SECOND,
    completed: steps.slice(0, 30),
    progress: { [steps[30]]: { done: 1, total: 4, unit: 'u'.repeat(500) } },
    counts: Object.fromEntries(
      steps.slice(0, 30).map((name) => [name, { [`k${'k'.repeat(300)}`]: 123456789 }])
    ),
    migrations: Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}-migration`)
  };
  const embed = render(state);
  const description = lines(embed);
  assert.ok(description.includes('✅ **30 steps** · 30m 00s'));
  assert.ok(description.some((line) => line.startsWith(`🔄 **step30nnn`)));
  assert.ok(description.some((line) => line.startsWith('> ``[█████               ]`` 1 / 4 uuu')));
  assert.ok(description.includes('▫️ 29 more steps'));
  assert.ok(description[2].startsWith('Applied migrations 000-migration, 001-migration'));
  assert.ok(description[2].endsWith('…'));
  assert.ok(description[2].length < 320);

  // And once it has ended.
  const stopped = render({ ...state, outcome: 'stopped', seconds: 3600, reason: 'x'.repeat(5000) });
  assert.ok(lines(stopped).includes('▫️ 29 more steps · not run'));
  assert.ok(lines(stopped).some((line) => line.startsWith('⏹️ **step30nnn')));
}

// The description is drawn in at most 3,500 of Discord's 4,096 characters, which leaves room for
// the next run to mark it: up to that, each step has a line of its own, and past it, the steps are
// summed up. Here a run's 43 steps, which have finished, have long names, and the list of its
// migrations grows a character at a time.
{
  const steps = Array.from({ length: 43 }, (_, i) => `step${i}`.padEnd(60, 'n'));
  const drawn = Array.from({ length: 300 }, (_, i) =>
    render({
      outcome: 'running',
      startedAt: START,
      at: START + 3600 * SECOND,
      gitSha: '28388ba',
      steps,
      phases: Object.fromEntries(steps.map((name) => [name, 60])),
      phase: steps.at(-1),
      completed: steps,
      migrations: ['m'.repeat(i + 1)]
    })
  );
  const summed = (embed) => lines(embed).includes('✅ **43 steps** · 43m 00s');
  const first = drawn.findIndex(summed);
  assert.ok(first > 0, 'Some descriptions are drawn whole, and some summed up');
  assert.ok(drawn.slice(first).every(summed));
  for (const [i, embed] of drawn.slice(0, first).entries()) {
    assert.ok(!summed(embed));
    assert.strictEqual(lines(embed).length, 3 + 1 + 43);
    assert.strictEqual(embed.description.length, drawn[0].description.length + i);
  }
  const longest = drawn[first - 1];
  assert.strictEqual(longest.description.length, 3500);
  // The next run's mark fits in what is left, so it keeps all of the longest.
  const [marked] = copy(markUnfinished({ embeds: [longest] }, { foundAt: START })).embeds;
  checkLimits(marked);
  assert.ok(marked.description.endsWith(`\n\n${longest.description}`));
}

// Whatever the state holds, the drawing gives an embed within Discord's limits rather than fail:
// an outcome it does not know is drawn as a failure.
for (const state of [
  {},
  { outcome: 'unknown', startedAt: 'yesterday', at: null, steps: 'all', completed: 7 },
  { outcome: 'running', steps: [null, 42, {}], phases: null, progress: [], counts: 'many' },
  { outcome: 'failed', reason: '\uD800'.repeat(400), phase: 'p'.repeat(1000) }
]) {
  const embed = render(state);
  assert.ok([TITLES.running, TITLES.failed].includes(embed.title));
}

// The next run marks the embed of a run that ended without its last edit, e.g. as it was killed:
// it says the run ended without finishing, in red, and why that may be, and keeps how far the run
// had got, with the phase it was in marked, and when it was last updated.
{
  const embed = render(running('updateExportBans'));
  const foundAt = START + 6 * 60 * 60 * SECOND;
  const message = { id: '900', content: null, embeds: [{ type: 'rich', ...embed }] };
  const marked = copy(markUnfinished(message, { foundAt }));
  assert.deepStrictEqual(marked, {
    content: null,
    embeds: [
      {
        title: 'CBL update run ended without finishing',
        color: 0xed4245,
        description: [
          `**It stopped without saying how it ended**, e.g. as it was killed, ran out of memory, or was ended at once after a second signal or its time limit. This is how far it had got. The next run started <t:${Math.floor(foundAt / 1000)}:f>.`,
          '',
          ...lines(embed).map((line) => (line.startsWith('🔄') ? line.replace('🔄', '⚠️') : line))
        ].join('\n'),
        footer: { text: 'Last updated' },
        timestamp: embed.timestamp
      }
    ]
  });
  checkLimits(marked.embeds[0]);
  assert.strictEqual(TITLES.unfinished, marked.embeds[0].title);
  assert.strictEqual(COLORS.unfinished, marked.embeds[0].color);

  // A message whose run ended as usual is left as it is, as is one marked already, and anything
  // that is not a run's status.
  for (const other of [
    ...['finished', 'failed', 'stopped', 'lockLost'].map((outcome) => ({
      embeds: [render(ended(outcome, { reason: 'Error: x' }))]
    })),
    marked,
    { content: 'Hello', embeds: [] },
    { content: 'Hello' },
    { embeds: [{ description: 'No title' }] },
    null
  ])
    assert.strictEqual(markUnfinished(other, { foundAt }), null);
}
{
  // An embed as long as Discord allows, with fields, is marked within the limits too, cut at the
  // end of a line.
  const embed = {
    title: TITLES.running,
    description: Array.from({ length: 200 }, (_, i) => `line ${i} ${'d'.repeat(20)}`)
      .join('\n')
      .slice(0, 4096),
    fields: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: 'v'.repeat(1100) })),
    footer: { text: 'f'.repeat(2048) },
    timestamp: '2026-10-16T15:00:00.000+00:00'
  };
  const [marked] = copy(
    markUnfinished({ content: 'Note', embeds: [embed] }, { foundAt: START })
  ).embeds;
  checkLimits(marked);
  assert.ok(marked.description.endsWith('\n…'));
  assert.strictEqual(marked.timestamp, embed.timestamp);
  assert.ok(marked.fields.length > 0 && marked.fields.length <= 25);
  // A run's own embed has no fields, so its description is kept whole.
  const own = render(running('importBans'));
  const [ownMarked] = copy(markUnfinished({ embeds: [own] }, { foundAt: START })).embeds;
  assert.ok(ownMarked.description.endsWith(lines(own).at(-1)));
}

// A run whose last edit did not reach Discord, e.g. as Discord was down while it ended, but which
// saved its record, is shown by the next run as it ended, drawn from its record as its own last
// edit would have drawn it, and the footer says so. It is drawn once: a message that does not show
// a run in progress is left as it is.
{
  const message = {
    id: '900',
    content: null,
    embeds: [{ type: 'rich', ...render(running('updateExportBans')) }]
  };
  const footer =
    'Ended · shown by the next run, from its record, as its last update did not reach Discord';
  const shown = [];
  for (const [outcome, options] of [
    ['finished', {}],
    ['failed', { ...recalculation, reason: 'Error: Deadlock found' }],
    ['stopped', { ...recalculation, reason: 'Stopped, as it received SIGTERM' }],
    ['lockLost', { ...recalculation, reason: 'Stopped, as it lost its locks' }]
  ]) {
    const state = ended(outcome, options);
    const revised = copy(markEnded(message, state));
    assert.deepStrictEqual(revised, {
      content: null,
      embeds: [{ ...render(state), footer: { text: footer } }]
    });
    checkLimits(revised.embeds[0]);
    assert.strictEqual(revised.embeds[0].title, TITLES[outcome]);
    shown.push(revised);
  }
  for (const other of [
    ...shown,
    markUnfinished(message, { foundAt: START }),
    { content: 'Hello', embeds: [] },
    { embeds: [{ description: 'No title' }] },
    null
  ])
    assert.strictEqual(markEnded(other, ended('finished')), null);
}

// The reputation check, which comes after the expired bans, is shown only when it ran: with the
// players it checked, and how many of them did not match their bans and were queued, or that all
// matched, and when it queued as many as it may a run, or stopped part-way, how many of those it
// had queued and left for later runs. When it did not run, as it was not due or is off, it is left
// out, and the embed is as it would be without it, unless the run ended in it. While it is still to
// run, or under way, it is shown as any step is, and a run that ended in it shows it with what it
// got done.
{
  const steps = [...STEPS.slice(0, 2), 'checkReputationPoints', ...STEPS.slice(2)];
  const withCheck = (outcome, counts, extra = {}) =>
    ended(outcome, {
      steps,
      completed: steps,
      phases: { ...PHASES, checkReputationPoints: 0.52 },
      counts: counts ? { ...COUNTS, checkReputationPoints: counts } : COUNTS,
      ...extra
    });
  const without = lines(render(ended('finished')));
  const shown = (counts) => {
    const description = lines(render(withCheck('finished', counts)));
    const at = description.indexOf('✅ **Reputation check** · 0.5s');
    assert.strictEqual(description[at - 2], '✅ **Expired bans** · 0.1s');
    assert.strictEqual(description[at + 2], '✅ **Steam profiles** · 14s');
    // Apart from the check's lines, the embed is as it is without the check.
    assert.deepStrictEqual([...description.slice(0, at), ...description.slice(at + 2)], without);
    return description[at + 1];
  };
  assert.strictEqual(
    shown({ ran: true, checked: 145094, mismatched: 0, queued: 0 }),
    '> 145,094 players checked, all matched their bans'
  );
  assert.strictEqual(
    shown({ ran: true, checked: 145094, mismatched: 3, queued: 3 }),
    '> 145,094 players checked, 3 did not match their bans and were queued'
  );
  assert.strictEqual(
    shown({ ran: true, checked: 1, mismatched: 1, queued: 1 }),
    '> 1 player checked, 1 did not match their bans and was queued'
  );
  assert.strictEqual(
    shown({ ran: true, checked: 145094, mismatched: 1200, queued: 500, left: 700 }),
    '> 145,094 players checked, 1,200 did not match their bans, of which 500 were queued, 700 left for later runs'
  );
  assert.strictEqual(
    shown({ ran: true, checked: 145094, mismatched: 1200, queued: 1, left: 1199 }),
    '> 145,094 players checked, 1,200 did not match their bans, of which 1 was queued, 1,199 left for later runs'
  );
  assert.strictEqual(
    shown({ ran: true, checked: 145094, mismatched: 19335, queued: 1000, left: 18335 }),
    '> 145,094 players checked, 19,335 did not match their bans, of which 1,000 were queued, 18,335 left for later runs'
  );

  // Not run, as it was not due or is off: left out, also from a run that was still going.
  for (const counts of [
    { ran: false, dueAt: '2026-10-17T14:46:41.062Z' },
    { ran: false, off: true }
  ]) {
    assert.deepStrictEqual(lines(render(withCheck('finished', counts))), without);
    const going = running('updateSteamUserInfo');
    Object.assign(going, {
      steps,
      completed: [...going.completed, 'checkReputationPoints'],
      phases: { ...going.phases, checkReputationPoints: 0.01 },
      counts: { ...going.counts, checkReputationPoints: counts }
    });
    assert.deepStrictEqual(lines(render(going)), lines(render(running('updateSteamUserInfo'))));
  }

  // Still to run, and under way, with how far its queueing has got.
  const before = running('expireBans');
  before.steps = steps;
  assert.deepStrictEqual(lines(render(before)).slice(5, 9), [
    '🔄 **Expired bans** · 9.0s',
    BARS.expireBans,
    '▫️ Reputation check',
    '▫️ Steam profiles'
  ]);
  const under = running('expireBans');
  Object.assign(under, {
    steps,
    phase: 'checkReputationPoints',
    completed: [...under.completed, 'expireBans'],
    phases: { ...under.phases, expireBans: PHASES.expireBans },
    counts: { ...under.counts, expireBans: COUNTS.expireBans },
    progress: { checkReputationPoints: { done: 500, total: 1200, unit: 'players' } }
  });
  assert.deepStrictEqual(lines(render(under)).slice(5, 10), [
    '✅ **Expired bans** · 0.1s',
    DETAILS.expireBans,
    '🔄 **Reputation check** · 9.0s',
    '> ``[████████            ]`` 500 / 1,200 players',
    '▫️ Steam profiles'
  ]);

  // A run stopped in it shows what it got done, and one that failed before it counted anything,
  // e.g. as it could not read the database, shows it without counts.
  const stopped = lines(
    render(
      withCheck(
        'stopped',
        { ran: true, checked: 145094, mismatched: 1200, queued: 500 },
        {
          phase: 'checkReputationPoints',
          completed: steps.slice(0, 2),
          reason: 'Stopped, as it received SIGTERM'
        }
      )
    )
  );
  assert.deepStrictEqual(stopped.slice(8, 12), [
    '⏹️ **Reputation check** · 0.5s',
    '> 145,094 players checked, 1,200 did not match their bans, of which 500 were queued, 700 left for later runs',
    '▫️ Steam profiles · not run',
    '▫️ Orphaned players · not run'
  ]);
  const failed = lines(
    render(
      withCheck(
        'failed',
        {},
        {
          phase: 'checkReputationPoints',
          completed: steps.slice(0, 2),
          progress: {},
          reason: 'SequelizeConnectionRefusedError: connect ECONNREFUSED'
        }
      )
    )
  );
  assert.deepStrictEqual(failed.slice(8, 10), [
    '❌ **Reputation check** · 0.5s',
    '▫️ Steam profiles · not run'
  ]);

  // A run asked to stop while a check that was not due, or is off, read its setting or its row,
  // stops right after it, so it ends in it: the header names it as the phase the run ended in, so
  // it is shown, with why it did not run, rather than left out. So it is when the next run draws
  // the run from its saved record, which does not say whether that phase finished.
  const DUE = '2026-10-17T14:46:41.062Z';
  for (const [counts, details] of [
    [{ ran: false, dueAt: DUE }, `> not due until <t:${Math.floor(Date.parse(DUE) / 1000)}:f>`],
    [{ ran: false, off: true }, '> off, as `IMPORTER_REPUTATION_CHECK_HOURS` is 0']
  ]) {
    for (const [outcome, completed, mark] of [
      ['stopped', steps.slice(0, 3), '✅'],
      ['stopped', steps.slice(0, 2), '⏹️'],
      ['lockLost', steps.slice(0, 3), '✅'],
      ['failed', steps.slice(0, 3), '✅']
    ]) {
      const description = lines(
        render(
          withCheck(outcome, counts, {
            phase: 'checkReputationPoints',
            completed,
            reason: 'Stopped, as it received SIGTERM'
          })
        )
      );
      assert.strictEqual(description[1], '**Phase** Reputation check', outcome);
      assert.deepStrictEqual(
        description.slice(6, 11),
        [
          '✅ **Expired bans** · 0.1s',
          DETAILS.expireBans,
          `${mark} **Reputation check** · 0.5s`,
          details,
          '▫️ Steam profiles · not run'
        ],
        `${outcome}, ${JSON.stringify(counts)}`
      );
    }
    // A run that ended in a later step, or finished, leaves it out.
    const later = lines(
      render(
        withCheck('stopped', counts, {
          phase: 'updateSteamUserInfo',
          completed: steps.slice(0, 3),
          reason: 'Stopped, as it received SIGTERM'
        })
      )
    );
    assert.strictEqual(later[1], '**Phase** Steam profiles');
    assert.deepStrictEqual(later.slice(6, 9), [
      '✅ **Expired bans** · 0.1s',
      DETAILS.expireBans,
      '⏹️ **Steam profiles** · 14s'
    ]);
    assert.deepStrictEqual(lines(render(withCheck('finished', counts))), without);
  }
  // A due time that cannot be read is not shown.
  const unreadable = lines(
    render(
      withCheck(
        'stopped',
        { ran: false, dueAt: 'soon' },
        { phase: 'checkReputationPoints', completed: steps.slice(0, 3), reason: 'Stopped' }
      )
    )
  );
  assert.deepStrictEqual(unreadable.slice(8, 10), [
    '✅ **Reputation check** · 0.5s',
    '▫️ Steam profiles · not run'
  ]);
}

// A cycle of the importer service, which posts its embed once it has ended, is named as one in its
// title, with its number, and is otherwise drawn as a run is. A cycle number that is not one is
// left out.
for (const [outcome, title] of [
  ['finished', 'CBL update cycle 12 finished'],
  ['failed', 'CBL update cycle 12 failed'],
  ['stopped', 'CBL update cycle 12 stopped'],
  ['lockLost', 'CBL update cycle 12 lost its locks']
]) {
  const embed = render({ ...ended(outcome), cycle: 12 });
  assert.strictEqual(embed.title, title);
  assert.deepStrictEqual(
    { ...embed, title: TITLES[outcome] },
    render(ended(outcome)),
    `${outcome} is drawn as a run's`
  );
}
for (const cycle of [0, -1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 2])
  assert.strictEqual(render({ ...ended('finished'), cycle }).title, TITLES.finished, `${cycle}`);
assert.strictEqual(
  render({ ...ended('finished'), cycle: Number.MAX_SAFE_INTEGER }).title,
  `CBL update cycle ${Number.MAX_SAFE_INTEGER} finished`
);

console.log(
  'Run status checks passed: every step and outcome, progress bars, counts, times, commits, migrations, reasons, Discord limits, runs that ended without finishing or whose last edit was lost, and cycles of the importer service.'
);
