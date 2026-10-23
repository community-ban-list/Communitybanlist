import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check what the importer service makes of its cycles, without Discord: which cycles are worth an
// embed of their own, the totals it keeps from one hourly summary to the next, and how its status
// message and hourly summary are drawn, always within Discord's limits for an embed.

// Discord's limits for an embed, in characters.
const LIMITS = { title: 256, description: 4096, footer: 2048, total: 6000 };

function checkLimits(embed) {
  assert.ok(embed.title.length <= LIMITS.title, 'title');
  assert.ok(embed.description.length <= LIMITS.description, 'description');
  assert.ok(embed.footer.text.length <= LIMITS.footer, 'footer');
  const texts = [embed.title, embed.description, embed.footer.text];
  assert.ok(texts.join('').length <= LIMITS.total, 'total');
  for (const text of texts) assert.ok(text.isWellFormed(), `${text} is cut in half an emoji`);
  assert.ok(Number.isInteger(embed.color));
  assert.ok(!Number.isNaN(Date.parse(embed.timestamp)));
}

// The drawing imports only run-status.js, which has no imports, so both are loaded on their own.
const context = vm.createContext({});
const load = async (path) => {
  const url = new URL(path, import.meta.url);
  return new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
};
const runStatus = await load('../src/run-status.js');
const module = await load('../src/service-status.js');
await module.link((specifier) => {
  assert.strictEqual(specifier, './run-status.js');
  return runStatus;
});
await module.evaluate();
const {
  default: renderServiceStatus,
  addCycle,
  cycleNumbers,
  DISCORD_MODES,
  DEFAULT_DISCORD_MODE,
  isNoteworthy,
  newTotals,
  nextSummaryAt,
  renderHourlySummary,
  TITLES
} = module.namespace;
// What the drawing makes is copied into this context to compare it.
const copy = (value) => JSON.parse(JSON.stringify(value));
const render = (state) => {
  const embed = copy(renderServiceStatus(state));
  checkLimits(embed);
  return embed;
};
const lines = (embed) => embed.description.split('\n');

const START = Date.parse('2026-10-22T14:07:00.000Z');
const UNIX = START / 1000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

assert.deepStrictEqual(copy(DISCORD_MODES), ['changes', 'status', 'both']);
assert.strictEqual(DEFAULT_DISCORD_MODE, 'both');

// A cycle's record, as its JSON line gives it, with the counts given.
const record = ({ cycle = 1, exitCode = 0, seconds = 45, counts = {}, ...rest } = {}) => ({
  event: 'cbl-importer-run',
  outcome: { 0: 'finished', 1: 'failed', 3: 'interrupted' }[exitCode],
  exitCode,
  startedAt: new Date(START + (cycle - 1) * 10 * MINUTE).toISOString(),
  endedAt: new Date(START + (cycle - 1) * 10 * MINUTE + seconds * SECOND).toISOString(),
  seconds,
  gitSha: 'abc1234',
  cycle,
  phases: {},
  counts,
  ...rest
});
const imported = (counts = {}, banLists = []) => ({
  lists: 2,
  imported: 2,
  fetched: 200,
  new: 0,
  updated: 0,
  removed: 0,
  held: 0,
  pending: 0,
  moves: 0,
  failedLists: 0,
  headPolls: 2,
  fullReads: 0,
  requests: { head: 2, follow: 0, full: 0 },
  banLists,
  ...counts
});

// What a cycle did, from its counts: the bans it added, updated, removed and marked expired, the
// export bans it created and deleted, the players the reputation check queued, the lists that
// failed, the bans held by the lists it read in full, and the Steam profiles it updated. Counts a
// step did not give, or that are not counts, are none.
{
  const numbers = copy(
    cycleNumbers(
      record({
        counts: {
          importBans: imported({ new: 3, updated: 2, removed: 1, failedLists: 1, moves: 4 }, [
            { id: 1, read: 'full', stored: 120, held: 15, pending: 15 },
            { id: 2, read: 'head', held: 40, pending: 0 },
            { id: 3, read: 'head', stored: 80, held: 2, pending: 2 }
          ]),
          expireBans: { due: 4, expired: 4, players: 3 },
          checkReputationPoints: { ran: true, checked: 145000, mismatched: 6, queued: 6 },
          updateSteamUserInfo: { due: 300, updated: 250 },
          exportExportBans: { queued: 7, created: 5, deleted: 2, failed: 0 }
        }
      }),
      { battlemetricsRequests: 23 }
    )
  );
  // A SteamID move that is only counted changed nothing, and an applied one is an updated ban. Of
  // the bans held, those of list 2, which was only polled, are those it kept from before.
  assert.deepStrictEqual(numbers, {
    added: 3,
    updated: 2,
    removed: 1,
    expired: 4,
    created: 5,
    deleted: 2,
    reputationQueued: 6,
    failedLists: 1,
    held: 17,
    steamUpdated: 250,
    battlemetricsRequests: 23,
    dryRun: false
  });
  assert.deepStrictEqual(
    copy(
      cycleNumbers(
        record({
          counts: {
            importBans: { new: -1, updated: 'x', dryRun: true },
            checkReputationPoints: { ran: false, dueAt: '2026-10-23T14:02:00.000Z' }
          }
        })
      )
    ),
    {
      added: 0,
      updated: 0,
      removed: 0,
      expired: 0,
      created: 0,
      deleted: 0,
      reputationQueued: 0,
      failedLists: 0,
      held: 0,
      steamUpdated: 0,
      battlemetricsRequests: 0,
      dryRun: true
    }
  );
  assert.strictEqual(cycleNumbers({}).added, 0);
}

// A cycle is worth an embed of its own when it changed something or had a problem: it failed or
// was stopped, a list failed, a list read in full held bans, or it logged a line for the log
// channel. Its reputation check queueing players whose points did not match their bans is a
// change. A quiet cycle, which only polled and found nothing, is not, nor is one that refreshed
// Steam profiles, recalculated every player, only counted SteamID moves, or checked every player's
// reputation points and found them all matching.
{
  const quiet = record({
    counts: {
      importBans: imported({ moves: 3 }, [{ id: 2, read: 'head', held: 40 }]),
      checkReputationPoints: { ran: true, checked: 145000, mismatched: 0, queued: 0 },
      updateSteamUserInfo: { due: 300, updated: 300 },
      updateExportBans: { players: 145000 }
    }
  });
  assert.strictEqual(isNoteworthy(quiet, cycleNumbers(quiet)), false);
  assert.strictEqual(isNoteworthy(quiet, cycleNumbers(quiet), { lines: 0 }), false);
  assert.strictEqual(isNoteworthy(quiet, cycleNumbers(quiet), { lines: 1 }), true);
  const notDue = record({
    counts: { checkReputationPoints: { ran: false, dueAt: '2026-10-23T14:02:00.000Z' } }
  });
  assert.strictEqual(isNoteworthy(notDue, cycleNumbers(notDue)), false);
  // Numbers from before the reputation check, without its count, are judged as before.
  const { reputationQueued, ...before } = copy(cycleNumbers(quiet));
  assert.strictEqual(reputationQueued, 0);
  assert.strictEqual(isNoteworthy(quiet, before), false);
  assert.strictEqual(isNoteworthy(quiet, { ...before, added: 1 }), true);
  for (const exitCode of [1, 3])
    assert.strictEqual(isNoteworthy(record({ exitCode }), cycleNumbers(record())), true);
  for (const counts of [
    { importBans: imported({ new: 1 }) },
    { importBans: imported({ updated: 1 }) },
    { importBans: imported({ removed: 1 }) },
    { importBans: imported({ failedLists: 1 }) },
    { importBans: imported({}, [{ id: 1, read: 'full', stored: 10, held: 1, pending: 1 }]) },
    { expireBans: { due: 1, expired: 1, players: 1 } },
    { exportExportBans: { queued: 1, created: 1, deleted: 0 } },
    { exportExportBans: { queued: 1, created: 0, deleted: 1 } },
    { checkReputationPoints: { ran: true, checked: 145000, mismatched: 2, queued: 2 } },
    // One that stopped part-way still queued some.
    { checkReputationPoints: { ran: true, checked: 145000, mismatched: 900, queued: 500 } }
  ]) {
    const cycle = record({ counts });
    assert.strictEqual(isNoteworthy(cycle, cycleNumbers(cycle)), true, JSON.stringify(counts));
  }
}

// The totals sum up the cycles that ended: how many, how many failed and were stopped, the bans
// and export bans, the lists that failed, the BattleMetrics requests and Steam profiles, and the
// slowest cycle. A dry run's bans were not written, so they are not counted.
{
  const totals = newTotals(START);
  const add = (cycle) =>
    addCycle(totals, cycle, cycleNumbers(cycle, { battlemetricsRequests: 20 }));
  add(
    record({
      cycle: 1,
      seconds: 545,
      counts: {
        importBans: imported({ new: 3, updated: 1, failedLists: 2 }),
        expireBans: { due: 2, expired: 2, players: 2 },
        updateSteamUserInfo: { updated: 250 },
        exportExportBans: { created: 4, deleted: 1 }
      }
    })
  );
  add(record({ cycle: 2, exitCode: 1, seconds: 12 }));
  add(record({ cycle: 3, exitCode: 3, seconds: 900 }));
  add(record({ cycle: 4, counts: { importBans: imported({ new: 9, dryRun: true }) } }));
  assert.deepStrictEqual(copy(totals), {
    since: START,
    cycles: 4,
    failed: 1,
    stopped: 1,
    added: 3,
    updated: 1,
    removed: 0,
    expired: 2,
    created: 4,
    deleted: 1,
    failedLists: 2,
    battlemetricsRequests: 80,
    steamUpdated: 250,
    slowest: { cycle: 3, seconds: 900, startedAt: START + 20 * MINUTE }
  });

  // The hourly summary posts them, in red when a cycle failed, orange when one was stopped and
  // green otherwise.
  const summary = copy(renderHourlySummary(totals, START + 53 * MINUTE));
  checkLimits(summary);
  assert.deepStrictEqual(
    [summary.title, summary.color, summary.footer.text, summary.timestamp],
    [TITLES.summary, 0xed4245, 'Hourly summary', '2026-10-22T15:00:00.000Z']
  );
  assert.deepStrictEqual(lines(summary), [
    `<t:${UNIX}:f> to <t:${UNIX + 53 * 60}:t>`,
    '**Cycles** 4 run · 1 failed · 1 stopped · 2 lists failed',
    '**Bans** 3 added · 1 updated · 0 removed · 2 expired',
    '**Export bans** 4 created · 1 deleted',
    '**BattleMetrics** 80 requests',
    '**Steam** 250 profiles updated',
    `**Slowest cycle** 15m 00s, cycle 3, started <t:${UNIX + 20 * 60}:t>`
  ]);
  totals.failed = 0;
  assert.strictEqual(renderHourlySummary(totals, START).color, 0xe67e22);
  const empty = copy(renderHourlySummary(newTotals(START), START + 60 * MINUTE));
  assert.strictEqual(empty.color, 0x57f287);
  assert.deepStrictEqual(lines(empty).slice(1), [
    '**Cycles** 0 run · 0 failed · 0 stopped',
    '**Bans** 0 added · 0 updated · 0 removed · 0 expired',
    '**Export bans** 0 created · 0 deleted',
    '**BattleMetrics** 0 requests',
    '**Steam** 0 profiles updated',
    '**Slowest cycle** none ended'
  ]);
}

// The first hourly summary is on the first whole hour at least half an hour after the service
// started, and each later one an hour after the last.
for (const [since, due] of [
  ['2026-10-22T14:07:00.000Z', '2026-10-22T15:00:00.000Z'],
  ['2026-10-22T14:29:59.999Z', '2026-10-22T15:00:00.000Z'],
  ['2026-10-22T14:30:00.000Z', '2026-10-22T15:00:00.000Z'],
  ['2026-10-22T14:30:00.001Z', '2026-10-22T16:00:00.000Z'],
  ['2026-10-22T14:59:00.000Z', '2026-10-22T16:00:00.000Z'],
  ['2026-10-22T15:00:00.000Z', '2026-10-22T16:00:00.000Z']
])
  assert.strictEqual(new Date(nextSummaryAt(Date.parse(since))).toISOString(), due, since);

// The status message, while the service runs: when it took the service lock, in each viewer's own time
// and how long ago, its commit, how often cycles start and their time limit, the cycle under way
// with its step and how far it has got, the last cycle, and the totals since the last summary.
const totals = addCycle(
  newTotals(START),
  record({ cycle: 1, seconds: 45, counts: { importBans: imported({ new: 2 }) } }),
  cycleNumbers(record({ counts: { importBans: imported({ new: 2 }) } }), {
    battlemetricsRequests: 21
  })
);
const last = {
  cycle: 1,
  outcome: 'finished',
  seconds: 45,
  endedAt: START + 45 * SECOND,
  numbers: cycleNumbers(
    record({
      counts: {
        importBans: imported({ new: 2, removed: 1 }),
        expireBans: { expired: 3 },
        checkReputationPoints: { ran: true, checked: 145000, mismatched: 3, queued: 3 },
        exportExportBans: { created: 4, deleted: 0 }
      }
    })
  )
};
const running = {
  outcome: 'running',
  startedAt: START,
  at: START + 10 * MINUTE + 30 * SECOND,
  gitSha: 'abc1234def',
  cycleSeconds: 600,
  maxCycleSeconds: 900,
  current: {
    cycle: 2,
    startedAt: START + 10 * MINUTE,
    phase: 'importBans',
    progress: { done: 7, total: 20, unit: 'ban lists' }
  },
  last,
  nextAt: null,
  totals
};
{
  const embed = render(running);
  assert.deepStrictEqual(
    [embed.title, embed.color, embed.footer.text, embed.timestamp],
    ['CBL importer service running', 0x5865f2, 'Last updated', '2026-10-22T14:17:30.000Z']
  );
  assert.deepStrictEqual(lines(embed), [
    `Running since <t:${UNIX}:f> (<t:${UNIX}:R>) · commit \`abc1234\``,
    'A cycle every **10m 00s**, time limit **15m 00s**',
    '',
    `🔄 **Cycle 2** · started <t:${UNIX + 600}:R> · **Import** 7 / 20 ban lists`,
    `✅ **Cycle 1** finished in **45s**, <t:${UNIX + 45}:R>`,
    '> 2 bans added, 1 removed, 3 expired · 4 export bans created · 3 players queued by the reputation check',
    '',
    `**Since <t:${UNIX}:t>** · 1 cycle · bans 2 added, 0 updated, 0 removed, 0 expired · export bans 0 created, 0 deleted · 21 BattleMetrics requests · 0 Steam profiles updated · slowest 45s`
  ]);

  // A cycle that waits for the database, or for another run to end, as it holds the run lock, says
  // since when, and one in a phase that is not a step, or without progress, says only which.
  assert.strictEqual(
    lines(
      render({ ...running, current: { ...running.current, waitingSince: START + 11 * MINUTE } })
    )[3],
    `⏳ **Cycle 2** · started <t:${UNIX + 600}:R> · waiting for the database since <t:${UNIX + 660}:R>`
  );
  assert.strictEqual(
    lines(
      render({
        ...running,
        current: { ...running.current, waitingFor: 'lock', waitingSince: START + 11 * MINUTE }
      })
    )[3],
    `⏳ **Cycle 2** · started <t:${UNIX + 600}:R> · waiting for another run to end since <t:${UNIX + 660}:R>`
  );
  assert.strictEqual(
    lines(
      render({ ...running, current: { ...running.current, phase: 'migrate', progress: undefined } })
    )[3],
    `🔄 **Cycle 2** · started <t:${UNIX + 600}:R> · **Migrations**`
  );
  // Between cycles, it says when the next one starts, or that it starts now, after one that took
  // longer than a cycle.
  const between = { ...running, current: null, nextAt: START + 20 * MINUTE };
  assert.strictEqual(
    lines(render(between))[3],
    `💤 Next cycle <t:${UNIX + 1200}:t> (<t:${UNIX + 1200}:R>)`
  );
  assert.strictEqual(
    lines(render({ ...between, nextAt: START + 5 * MINUTE }))[3],
    '💤 Next cycle now'
  );
  // A cycle that failed or was stopped says why, on one line, without any address.
  const failed = render({
    ...between,
    last: {
      ...last,
      outcome: 'failed',
      reason: 'Error: connect ECONNREFUSED https://discord.com/api/webhooks/1/secret-token',
      numbers: cycleNumbers(record())
    }
  });
  assert.deepStrictEqual(lines(failed).slice(4, 6), [
    `❌ **Cycle 1** failed after **45s**, <t:${UNIX + 45}:R>: Error: connect ECONNREFUSED (address)`,
    '> no changes'
  ]);
  // A cycle whose only change was a player its reputation check queued says so.
  const queuedOnly = record({
    counts: { checkReputationPoints: { ran: true, checked: 145000, mismatched: 1, queued: 1 } }
  });
  assert.strictEqual(
    lines(render({ ...between, last: { ...last, numbers: cycleNumbers(queuedOnly) } }))[5],
    '> 1 player queued by the reputation check'
  );
  assert.ok(!JSON.stringify(failed).includes('secret-token'));
  assert.match(
    lines(
      render({
        ...between,
        last: { ...last, outcome: 'interrupted', reason: 'Stopped, as it took longer than 900s' }
      })
    )[4],
    /^⏹️ \*\*Cycle 1\*\* stopped after \*\*45s\*\*, <t:\d+:R>: Stopped, as it took longer than 900s$/
  );
  // Before its first cycle ends, it shows no last cycle.
  assert.deepStrictEqual(
    lines(render({ ...running, last: null, totals: newTotals(START) })).slice(3),
    [
      `🔄 **Cycle 2** · started <t:${UNIX + 600}:R> · **Import** 7 / 20 ban lists`,
      '',
      `**Since <t:${UNIX}:t>** · 0 cycles · bans 0 added, 0 updated, 0 removed, 0 expired · export bans 0 created, 0 deleted · 0 BattleMetrics requests · 0 Steam profiles updated`
    ]
  );
}

// Once the service has ended, its message says how: stopped, in orange, as it was asked to, or
// failed, in red, e.g. as it lost its locks, which Docker restarts it after, unless a signal, e.g.
// from docker stop, had asked it to stop. It no longer shows a cycle under way or the next cycle.
{
  const stopped = render({
    ...running,
    outcome: 'stopped',
    at: START + 30 * MINUTE,
    reason: 'it received SIGTERM'
  });
  assert.deepStrictEqual(
    [stopped.title, stopped.color, stopped.footer.text],
    ['CBL importer service stopped', 0xe67e22, 'Ended']
  );
  assert.deepStrictEqual(lines(stopped).slice(0, 4), [
    `Ran from <t:${UNIX}:f> to <t:${UNIX + 1800}:f> · commit \`abc1234\``,
    'A cycle every **10m 00s**, time limit **15m 00s**',
    '',
    `✅ **Cycle 1** finished in **45s**, <t:${UNIX + 45}:R>`
  ]);
  assert.strictEqual(
    lines(stopped).at(-1),
    `**Stopped** <t:${UNIX + 1800}:f>, as it received SIGTERM.`
  );
  const failed = render({ ...running, outcome: 'failed', reason: 'it lost its locks' });
  assert.deepStrictEqual([failed.title, failed.color], ['CBL importer service failed', 0xed4245]);
  assert.match(
    lines(failed).at(-1),
    /^\*\*Failed\*\* <t:\d+:f>, as it lost its locks\. Docker restarts it\.$/
  );
  const signalled = render({
    ...running,
    outcome: 'failed',
    reason: 'cycle 1 did not stop at its time limit',
    restarts: false
  });
  assert.match(
    lines(signalled).at(-1),
    /^\*\*Failed\*\* <t:\d+:f>, as cycle 1 did not stop at its time limit\.$/
  );
  // Anything else is drawn as failed.
  assert.strictEqual(
    render({ ...running, outcome: 'summary' }).title,
    'CBL importer service failed'
  );
}

// However long the reason and the phase's name, and however large the numbers, the message stays
// within Discord's limits, and an emoji is never cut in half.
{
  const long = render({
    ...running,
    outcome: 'failed',
    gitSha: '😀'.repeat(500),
    current: {
      ...running.current,
      phase: '🛑'.repeat(1000),
      progress: { done: 1e15, total: 1e15, unit: '😀'.repeat(500) }
    },
    last: { ...last, cycle: Number.MAX_SAFE_INTEGER, reason: '😀'.repeat(5000) },
    reason: `${'x'.repeat(4999)}😀`
  });
  assert.ok(long.description.length <= 3500);
  const huge = copy(
    renderHourlySummary(
      {
        ...newTotals(START),
        cycles: 1e15,
        added: 1e15,
        battlemetricsRequests: 1e15,
        slowest: { cycle: 1e15, seconds: 1e9, startedAt: NaN }
      },
      START
    )
  );
  checkLimits(huge);
  assert.ok(!huge.description.includes('NaN'));
}

console.log(
  "Importer service status checks passed: what a cycle did, which cycles are posted, the totals and hourly summary, when it is due, and the status message, within Discord's limits."
);
