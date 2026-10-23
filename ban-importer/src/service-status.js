// How the importer service looks in the log channel, in loop mode (see loop.js). It only works out
// and draws, from the records of its cycles, so it needs no database or Discord:
// - which cycles are worth an embed of their own, as they changed something or had a problem;
// - the service's totals, from its last hourly summary on;
// - the service's status message: one embed, edited as the service goes;
// - the hourly summary.
// The embed of a cycle is a run's embed, as run-status.js draws it.

import {
  cutLines,
  describeProgress,
  describeReason,
  discordTime,
  formatCount,
  formatDuration,
  isCount,
  label,
  plural,
  shortSha
} from './run-status.js';

// What IMPORTER_LOOP_DISCORD may say the service posts:
// - changes: the embed of each cycle that changed something or had a problem;
// - status: one status message, kept up to date, and an hourly summary;
// - both: all of these.
// Alerts, such as failures, held removals, lost access and staleness, are posted in every mode.
export const DISCORD_MODES = ['changes', 'status', 'both'];
export const DEFAULT_DISCORD_MODE = 'both';

export const COLORS = {
  running: 0x5865f2,
  stopped: 0xe67e22,
  failed: 0xed4245,
  quiet: 0x57f287
};

export const TITLES = {
  running: 'CBL importer service running',
  stopped: 'CBL importer service stopped',
  failed: 'CBL importer service failed',
  summary: 'CBL importer service: hourly summary'
};

const MARKS = {
  current: '🔄',
  waiting: '⏳',
  next: '💤',
  finished: '✅',
  failed: '❌',
  interrupted: '⏹️'
};

// The description is drawn in at most this many of Discord's 4,096 characters.
const DESCRIPTION_LENGTH = 3500;

// What a cycle did, from its record, that the service sums up and that says whether the cycle is
// worth an embed of its own:
// - added, updated, removed: the bans the import saved and removed. A SteamID move that is applied
//   updates its ban, so it is counted there; one that is only counted changed nothing;
// - expired: the bans marked expired;
// - created, deleted: the export bans pushed;
// - failedLists: the ban lists whose import failed;
// - held: the bans kept that lists read in full in the cycle no longer have, which wait for a
//   confirming read or for an admin, but not those a list that was only polled still keeps;
// - steamUpdated: the Steam profiles refreshed;
// - battlemetricsRequests: the requests sent to BattleMetrics, as the service counted them;
// - dryRun: whether the import was a dry run, whose counts say what it would have done.
export function cycleNumbers(record, { battlemetricsRequests = 0 } = {}) {
  const counts = record?.counts && typeof record.counts === 'object' ? record.counts : {};
  const imports =
    counts.importBans && typeof counts.importBans === 'object' ? counts.importBans : {};
  const count = (value) => (isCount(value) ? value : 0);
  const banLists = Array.isArray(imports.banLists) ? imports.banLists : [];
  return {
    added: count(imports.new),
    updated: count(imports.updated),
    removed: count(imports.removed),
    expired: count(counts.expireBans?.expired),
    created: count(counts.exportExportBans?.created),
    deleted: count(counts.exportExportBans?.deleted),
    failedLists: count(imports.failedLists),
    held: banLists
      .filter((list) => list && list.stored !== undefined)
      .reduce((total, list) => total + count(list.held), 0),
    steamUpdated: count(counts.updateSteamUserInfo?.updated),
    battlemetricsRequests: count(battlemetricsRequests),
    dryRun: imports.dryRun === true
  };
}

// Whether a cycle is worth an embed of its own: it changed something (bans added, updated, removed
// or expired, or export bans created or deleted) or had a problem (it failed or was stopped, a list
// failed, a list read in full held bans, or it posted a line to the log channel, such as a warning
// or an alert). lines is how many lines it logged for the log channel. A quiet cycle is not.
export function isNoteworthy(record, numbers, { lines = 0 } = {}) {
  if (record?.exitCode !== 0) return true;
  const { added, updated, removed, expired, created, deleted, failedLists, held } = numbers;
  return added + updated + removed + expired + created + deleted + failedLists + held + lines > 0;
}

// The service's totals from since on, which the status message shows and the hourly summary posts.
export function newTotals(since) {
  return {
    since,
    cycles: 0,
    failed: 0,
    stopped: 0,
    added: 0,
    updated: 0,
    removed: 0,
    expired: 0,
    created: 0,
    deleted: 0,
    failedLists: 0,
    battlemetricsRequests: 0,
    steamUpdated: 0,
    // The cycle that took longest, as { cycle, seconds, startedAt }.
    slowest: null
  };
}

// Add a cycle that ended to the totals, from its record and what it did (see cycleNumbers). The
// bans of a dry run were not written, so they are not counted.
export function addCycle(totals, record, numbers) {
  totals.cycles++;
  if (record.outcome === 'failed') totals.failed++;
  if (record.outcome === 'interrupted') totals.stopped++;
  const fields = ['expired', 'created', 'deleted', 'failedLists', 'battlemetricsRequests'];
  if (!numbers.dryRun) fields.push('added', 'updated', 'removed');
  for (const field of fields) totals[field] += numbers[field];
  totals.steamUpdated += numbers.steamUpdated;
  const seconds = isCount(record.seconds) ? record.seconds : 0;
  if (!totals.slowest || seconds > totals.slowest.seconds)
    totals.slowest = { cycle: record.cycle, seconds, startedAt: Date.parse(record.startedAt) };
  return totals;
}

// What a cycle changed, in a line, e.g. "3 bans added, 2 expired · 4 export bans created", or that
// it changed nothing.
function describeChanges(numbers) {
  const bans = [
    [numbers.added, 'added'],
    [numbers.updated, 'updated'],
    [numbers.removed, 'removed'],
    [numbers.expired, 'expired']
  ].filter(([value]) => value > 0);
  const exports = [
    [numbers.created, 'created'],
    [numbers.deleted, 'deleted']
  ].filter(([value]) => value > 0);
  const parts = [];
  if (bans.length > 0)
    parts.push(
      `${plural(bans[0][0], 'ban')} ${bans[0][1]}${bans
        .slice(1)
        .map(([value, what]) => `, ${formatCount(value)} ${what}`)
        .join('')}`
    );
  if (exports.length > 0)
    parts.push(
      `${plural(exports[0][0], 'export ban')} ${exports[0][1]}${exports
        .slice(1)
        .map(([value, what]) => `, ${formatCount(value)} ${what}`)
        .join('')}`
    );
  if (numbers.failedLists > 0) parts.push(`${plural(numbers.failedLists, 'list')} failed`);
  if (numbers.held > 0) parts.push(`${plural(numbers.held, 'ban')} held`);
  return parts.length > 0 ? parts.join(' · ') : 'no changes';
}

// The totals in a line, as the status message shows them.
function describeTotals(totals) {
  const failures = [
    totals.failed > 0 ? `${formatCount(totals.failed)} failed` : null,
    totals.stopped > 0 ? `${formatCount(totals.stopped)} stopped` : null
  ].filter(Boolean);
  const parts = [
    `${plural(totals.cycles, 'cycle')}${failures.length > 0 ? ` (${failures.join(', ')})` : ''}`,
    `bans ${formatCount(totals.added)} added, ${formatCount(totals.updated)} updated, ${formatCount(totals.removed)} removed, ${formatCount(totals.expired)} expired`,
    `export bans ${formatCount(totals.created)} created, ${formatCount(totals.deleted)} deleted`,
    plural(totals.battlemetricsRequests, 'BattleMetrics request'),
    `${plural(totals.steamUpdated, 'Steam profile')} updated`
  ];
  if (totals.slowest) parts.push(`slowest ${formatDuration(totals.slowest.seconds)}`);
  return parts.join(' · ');
}

// How a cycle that ended is shown: its mark, number, how it ended and how long it took, with what
// it changed on the line below.
function describeLast(last) {
  const mark = MARKS[last.outcome] ?? MARKS.failed;
  const how =
    last.outcome === 'finished'
      ? 'finished in'
      : last.outcome === 'interrupted'
        ? 'stopped after'
        : 'failed after';
  const reason = last.reason ? `: ${describeReason(last.reason)}` : '';
  return [
    `${mark} **Cycle ${formatCount(last.cycle ?? 0)}** ${how} **${formatDuration(last.seconds)}**, ${discordTime(last.endedAt, 'R')}${reason}`,
    `> ${describeChanges(last.numbers)}`
  ];
}

// Draw the service's status message from its state:
// - outcome: 'running', or how the service ended: 'stopped' or 'failed';
// - startedAt: when it took the service lock; at: now, or when it ended;
// - gitSha: the commit it runs;
// - cycleSeconds, maxCycleSeconds: how often cycles start, and their time limit;
// - current: the cycle under way, as { cycle, startedAt, phase, progress }, where progress is the
//   phase's latest progress, with waitingSince while it waits for the database, or for the run
//   lock, which waitingFor says ('database' or 'lock'), or null between cycles;
// - last: the cycle that ended last, as { cycle, outcome, seconds, endedAt, reason, numbers }, the
//   outcome as its record names it, or null before the first;
// - nextAt: when the next cycle starts, between cycles;
// - totals: the totals from the last hourly summary on (see newTotals);
// - reason: why the service stopped or failed;
// - restarts: whether Docker starts a service that failed again, as it does unless a signal, e.g.
//   from docker stop, asked it to stop first. It does, unless this is false.
// Times are in milliseconds. Discord shows each time in each viewer's own time zone, and how long
// ago or until, so the message stays current between its edits.
export default function renderServiceStatus(state) {
  const outcome = ['running', 'stopped', 'failed'].includes(state.outcome)
    ? state.outcome
    : 'failed';
  const at = Number.isFinite(state.at) ? state.at : Date.now();
  const startedAt = Number.isFinite(state.startedAt) ? state.startedAt : at;
  const running = outcome === 'running';
  const lines = [
    running
      ? `Running since ${discordTime(startedAt, 'f')} (${discordTime(startedAt, 'R')}) · commit \`${shortSha(state.gitSha)}\``
      : `Ran from ${discordTime(startedAt, 'f')} to ${discordTime(at, 'f')} · commit \`${shortSha(state.gitSha)}\``,
    `A cycle every **${formatDuration(state.cycleSeconds)}**, time limit **${formatDuration(state.maxCycleSeconds)}**`,
    ''
  ];

  const { current } = state;
  if (running && current) {
    const cycle = `**Cycle ${formatCount(current.cycle ?? 0)}** · started ${discordTime(current.startedAt, 'R')}`;
    if (Number.isFinite(current.waitingSince))
      lines.push(
        `${MARKS.waiting} ${cycle} · waiting for ${current.waitingFor === 'lock' ? 'another run to end' : 'the database'} since ${discordTime(current.waitingSince, 'R')}`
      );
    else {
      const progress = describeProgress(current.progress);
      const phase = current.phase
        ? ` · **${label(current.phase)}**${progress ? ` ${progress}` : ''}`
        : '';
      lines.push(`${MARKS.current} ${cycle}${phase}`);
    }
  } else if (running && Number.isFinite(state.nextAt))
    lines.push(
      state.nextAt > at
        ? `${MARKS.next} Next cycle ${discordTime(state.nextAt, 't')} (${discordTime(state.nextAt, 'R')})`
        : `${MARKS.next} Next cycle now`
    );
  if (state.last) lines.push(...describeLast(state.last));

  if (state.totals) {
    lines.push(
      '',
      `**Since ${discordTime(state.totals.since, 't')}** · ${describeTotals(state.totals)}`
    );
  }
  if (!running) {
    const reason = state.reason ? `, as ${describeReason(state.reason)}` : '';
    lines.push(
      '',
      outcome === 'stopped'
        ? `**Stopped** ${discordTime(at, 'f')}${reason}.`
        : `**Failed** ${discordTime(at, 'f')}${reason}.${state.restarts === false ? '' : ' Docker restarts it.'}`
    );
  }

  return {
    title: TITLES[outcome],
    color: COLORS[outcome],
    description: cutLines(lines.join('\n'), DESCRIPTION_LENGTH),
    footer: { text: running ? 'Last updated' : 'Ended' },
    timestamp: new Date(at).toISOString()
  };
}

// Draw the hourly summary of the totals, which ran from totals.since to until.
export function renderHourlySummary(totals, until) {
  const lines = [
    `${discordTime(totals.since, 'f')} to ${discordTime(until, 't')}`,
    `**Cycles** ${formatCount(totals.cycles)} run · ${formatCount(totals.failed)} failed · ${formatCount(totals.stopped)} stopped${
      totals.failedLists > 0 ? ` · ${plural(totals.failedLists, 'list')} failed` : ''
    }`,
    `**Bans** ${formatCount(totals.added)} added · ${formatCount(totals.updated)} updated · ${formatCount(totals.removed)} removed · ${formatCount(totals.expired)} expired`,
    `**Export bans** ${formatCount(totals.created)} created · ${formatCount(totals.deleted)} deleted`,
    `**BattleMetrics** ${plural(totals.battlemetricsRequests, 'request')}`,
    `**Steam** ${plural(totals.steamUpdated, 'profile')} updated`,
    totals.slowest
      ? `**Slowest cycle** ${formatDuration(totals.slowest.seconds)}, cycle ${formatCount(totals.slowest.cycle ?? 0)}${
          Number.isFinite(totals.slowest.startedAt)
            ? `, started ${discordTime(totals.slowest.startedAt, 't')}`
            : ''
        }`
      : '**Slowest cycle** none ended'
  ];
  return {
    title: TITLES.summary,
    color: totals.failed > 0 ? COLORS.failed : totals.stopped > 0 ? COLORS.stopped : COLORS.quiet,
    description: cutLines(lines.join('\n'), DESCRIPTION_LENGTH),
    footer: { text: 'Hourly summary' },
    timestamp: new Date(until).toISOString()
  };
}

// When the next hourly summary of totals that began at since is due: on the first whole hour at
// least half an hour after since, so the first summary after the service starts covers at least
// half an hour, and each later one an hour.
export function nextSummaryAt(since) {
  const HOUR = 60 * 60 * 1000;
  return Math.ceil((since + HOUR / 2) / HOUR) * HOUR;
}
