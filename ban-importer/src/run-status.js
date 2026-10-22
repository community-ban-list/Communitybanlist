// How a run looks in the log channel: one Discord embed, which the run posts once it holds the run
// lock, keeps up to date while it goes, and edits a last time to show how it ended. This draws that
// embed from what the run has done so far, and corrects the embed of a run whose last edit did not
// reach Discord. It only draws, so anything that shows a run's status can use it: in loop mode,
// the importer service posts the embed of a cycle once it has ended (see loop.js), and its own
// status message is drawn with the helpers exported here (see service-status.js).
//
// This file has no imports, so it can be loaded on its own.

export const COLORS = {
  running: 0x5865f2,
  finished: 0x57f287,
  failed: 0xed4245,
  stopped: 0xe67e22,
  lockLost: 0xed4245,
  unfinished: 0xed4245
};

export const TITLES = {
  running: 'CBL update run in progress',
  finished: 'CBL update run finished',
  failed: 'CBL update run failed',
  stopped: 'CBL update run stopped',
  lockLost: 'CBL update run lost its run lock',
  unfinished: 'CBL update run ended without finishing'
};

// The phases of a run, by the names the run record gives them, as the embed names them.
const LABELS = {
  waitForDatabase: 'Database wait',
  takeRunLock: 'Run lock',
  connect: 'Database connection',
  migrate: 'Migrations',
  importBans: 'Import',
  expireBans: 'Expired bans',
  updateSteamUserInfo: 'Steam profiles',
  clearOrphanedUsers: 'Orphaned players',
  updateReputationPoints: 'Reputation points',
  updateReputationRank: 'Reputation ranks',
  updateExportBans: 'Export recalculation',
  exportExportBans: 'Export push'
};

const MARKS = {
  done: '✅',
  current: '🔄',
  failed: '❌',
  stopped: '⏹️',
  waiting: '▫️',
  // The phase a run was in when it ended without saying how.
  unfinished: '⚠️'
};

// Discord allows an embed's description 4,096 characters, its footer 2,048, a field's name 256 and
// its value 1,024, 25 fields, and 6,000 characters in all. The description is drawn in at most
// 3,500, which leaves room to mark the embed of a run that ended without finishing, and never in
// more than Discord allows, whatever this is set to.
const DESCRIPTION_LENGTH = 3500;
const MAX_DESCRIPTION = 4096;
const MAX_FOOTER = 2048;
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_TOTAL = 6000;

// The longest reason, label, unit, step details and list of migrations shown, before Discord's
// formatting characters are escaped, which can double them.
const MAX_REASON = 300;
const MAX_LABEL = 60;
const MAX_UNIT = 40;
const MAX_DETAILS = 250;
const MAX_MIGRATIONS = 300;

// A progress bar has 20 cells.
const BAR_WIDTH = 20;

export const isCount = (value) => Number.isFinite(value) && value >= 0;

// A count written with thousands separators, e.g. 86,919.
export const formatCount = (count) => count.toLocaleString('en-US');

export function plural(count, noun) {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// A length of time, e.g. 0.4s, 14s, 8m 05s or 1h 05m.
export function formatDuration(seconds) {
  const time = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (time < 9.95) return `${time.toFixed(1)}s`;
  const whole = Math.round(time);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// A time as Discord shows it, in each viewer's own time zone: f is the date and time, t the time
// alone, and R how long ago, or how long until.
export const discordTime = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;

// Cut text to at most max characters, on a character boundary so no emoji is cut in half, ending
// it with … when it is cut.
export function cut(text, max) {
  const whole = String(text).toWellFormed();
  if (whole.length <= max) return whole;
  return max < 1 ? '' : `${whole.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

// Cut text of several lines to at most max characters, at the end of a line where it can be.
export function cutLines(text, max) {
  if (text.length <= max) return text;
  if (max < 2) return cut(text, max);
  const kept = cut(text, max - 1).slice(0, -1);
  const end = kept.lastIndexOf('\n');
  return `${end > 0 ? kept.slice(0, end + 1) : kept}…`;
}

// Show text as it is, rather than as Discord's formatting, such as bold, links or mentions.
export const plain = (text) => text.replace(/[\\`*_~|<>[\]]/g, '\\$&');

// Why a run ended, on one line, cut to fit and without any address, which could hold a key or a
// token. The run gives a reason described by describeError, so it never holds an error's request.
export function describeReason(reason) {
  const text = String(reason)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(address)');
  return plain(cut(text, MAX_REASON));
}

// The commit, as the first 7 characters of its SHA.
export function shortSha(gitSha) {
  const sha = String(gitSha ?? '');
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7);
  return cut(sha.replace(/[^\w.-]/g, ''), 40) || 'unknown';
}

// A phase's name, as the embed shows it.
export const label = (name) => plain(cut(LABELS[name] ?? String(name), MAX_LABEL));

// How far a step has got, e.g. 7 / 20 ban lists, with a bar for the step under way.
export function describeProgress(progress, { bar = false } = {}) {
  if (!progress || !isCount(progress.done) || !isCount(progress.total)) return null;
  const { done, total, unit } = progress;
  const numbers = `${formatCount(done)} / ${formatCount(total)}${
    unit ? ` ${plain(cut(unit, MAX_UNIT))}` : ''
  }`;
  if (!bar) return numbers;
  const filled =
    total > 0
      ? Math.min(BAR_WIDTH, Math.floor((Math.min(done, total) / total) * BAR_WIDTH))
      : BAR_WIDTH;
  return `\`\`[${'█'.repeat(filled)}${' '.repeat(BAR_WIDTH - filled)}]\`\` ${numbers}`;
}

// What the counts of the steps that count what they do say, in a line, or null without them. Each
// is also given the step's latest progress.
const DETAILS = {
  // The import's totals, as in its summary line, and how many lists it only polled and read in
  // full, with the BattleMetrics requests that took, when it says. Those of a dry run say what it
  // would have done.
  importBans: (counts) => {
    const { lists, imported, fetched, updated, removed, held, failedLists } = counts;
    if (![imported, fetched, counts.new, updated, removed, held, failedLists].every(isCount))
      return null;
    const banLists =
      isCount(lists) && imported < lists
        ? `${formatCount(imported)} of ${plural(lists, 'ban list')}`
        : plural(imported, 'ban list');
    let reads = '';
    if (isCount(counts.headPolls) && isCount(counts.fullReads)) {
      reads = `; ${formatCount(counts.headPolls)} polled, ${formatCount(counts.fullReads)} read in full`;
      const requests =
        counts.requests && typeof counts.requests === 'object'
          ? Object.values(counts.requests)
          : [];
      if (requests.length > 0 && requests.every(isCount))
        reads += `, ${plural(
          requests.reduce((total, count) => total + count, 0),
          'BattleMetrics request'
        )}`;
    }
    const dryRun = counts.dryRun === true ? ', in a dry run that wrote nothing' : '';
    return `${banLists}: ${plural(fetched, 'ban')} fetched, ${formatCount(counts.new)} new, ${formatCount(updated)} updated, ${formatCount(removed)} removed, ${formatCount(held)} held, ${plural(failedLists, 'list')} failed${reads}${dryRun}`;
  },
  // The bans marked expired, of those found, and the players queued for a recalculation.
  expireBans: ({ due, expired, players }) => {
    if (![due, expired, players].every(isCount)) return null;
    if (due === 0) return 'none had expired';
    const bans =
      expired < due ? `${formatCount(expired)} of ${plural(due, 'ban')}` : plural(due, 'ban');
    return `${bans} marked expired, ${plural(players, 'player')} queued`;
  },
  // Of the profiles due, how many were updated, and how many Steam did not have, were skipped as
  // their IDs are not SteamIDs, could not be saved, or are left for later runs, when there were any.
  updateSteamUserInfo: ({ due, updated, missing, skipped, unsaved, left }) => {
    if (!isCount(due) || !isCount(updated)) return null;
    if (due === 0) return 'none were due';
    const others = [
      [missing, 'not found on Steam'],
      [skipped, 'skipped as not SteamIDs'],
      [unsaved, 'not saved'],
      [left, 'left for later runs']
    ]
      .filter(([count]) => isCount(count) && count > 0)
      .map(([count, what]) => `, ${formatCount(count)} ${what}`);
    return `${formatCount(updated)} of ${formatCount(due)} updated${others.join('')}`;
  },
  // A recalculation that stopped part-way says of how many.
  updateExportBans: ({ players }, progress) => {
    if (!isCount(players)) return null;
    return isCount(progress?.total) && progress.total > players
      ? `${formatCount(players)} of ${plural(progress.total, 'player')}`
      : plural(players, 'player');
  },
  exportExportBans: ({ queued, created, deleted, failed }) => {
    if (![queued, created, deleted].every(isCount)) return null;
    if (queued === 0) return 'nothing to export';
    const failures = isCount(failed) && failed > 0 ? `, ${formatCount(failed)} failed` : '';
    return `${formatCount(created)} created, ${formatCount(deleted)} deleted${failures} of ${plural(queued, 'export ban')}`;
  }
};

// What a step's counts say: in its own words for the steps above, and otherwise the numbers it
// gave, e.g. "5 updated".
function describeCounts(name, counts, progress) {
  if (!counts || typeof counts !== 'object') return null;
  const details = Object.hasOwn(DETAILS, name)
    ? DETAILS[name](counts, progress)
    : Object.entries(counts)
        .filter(([, value]) => isCount(value))
        .map(([key, value]) => `${formatCount(value)} ${plain(cut(key, MAX_UNIT))}`)
        .join(', ');
  return details ? cut(details, MAX_DETAILS) : null;
}

// A phase's line, e.g. "✅ **Import** · 8m 20s", with its details on a quoted line below.
function line(name, kind, mark, text, details) {
  return { name, kind, text: details ? `${mark} ${text}\n> ${details}` : `${mark} ${text}` };
}

// The lines of the phases: the steps in order, each finished, under way, the one the run ended in,
// or not run yet, and before them a phase that is not a step, such as the migrations, while it is
// under way or when the run ended in it.
function phaseLines(state) {
  const { outcome, steps, phases, phase, completed, progress, counts } = state;
  const running = outcome === 'running';

  // The phase under way, or the one the run ended in, which has no time of its own yet if the run
  // ended while it was still under way, e.g. as it was left waiting.
  const current = (name) => {
    const seconds =
      !running && Object.hasOwn(phases, name)
        ? phases[name]
        : (state.at - state.phaseStartedAt) / 1000;
    const details = running
      ? describeProgress(progress[name], { bar: true })
      : (describeCounts(name, counts[name], progress[name]) ??
        (progress[name] ? `got to ${describeProgress(progress[name])}` : null));
    const mark = running ? MARKS.current : outcome === 'failed' ? MARKS.failed : MARKS.stopped;
    return line(
      name,
      running ? 'current' : 'ended',
      mark,
      `**${label(name)}** · ${formatDuration(seconds)}`,
      details
    );
  };
  const isCurrent = (name) => name === phase && !completed.includes(name);

  const lines = [];
  if (phase && !steps.includes(phase) && isCurrent(phase)) lines.push(current(phase));
  for (const name of steps) {
    if (completed.includes(name)) {
      const details =
        describeCounts(name, counts[name], progress[name]) ?? describeProgress(progress[name]);
      const text = `**${label(name)}** · ${formatDuration(phases[name])}`;
      lines.push(line(name, 'done', MARKS.done, text, details));
    } else if (isCurrent(name)) {
      lines.push(current(name));
    } else {
      const text = running ? label(name) : `${label(name)} · not run`;
      lines.push(line(name, 'waiting', MARKS.waiting, text));
    }
  }
  return lines;
}

// Fit the lines of the phases in room characters. When they do not fit, each run of finished
// steps, and of steps not run yet, is summed up in one line, so the phase under way, or the one the
// run ended in, is still shown.
function fitLines(lines, room, { running, phases }) {
  // The length of the lines, with a line break between each two.
  const size = (entries) => entries.reduce((total, { text }) => total + text.length + 1, -1);
  if (size(lines) <= room) return lines.map(({ text }) => text);

  const groups = [];
  for (const entry of lines) {
    const last = groups.at(-1);
    if ((entry.kind === 'done' || entry.kind === 'waiting') && last?.kind === entry.kind)
      last.entries.push(entry);
    else groups.push({ kind: entry.kind, entries: [entry] });
  }
  const texts = groups.map(({ kind, entries }) => {
    if (entries.length === 1) return entries[0].text;
    if (kind === 'waiting')
      return `${MARKS.waiting} ${entries.length} more steps${running ? '' : ' · not run'}`;
    const seconds = entries.reduce((total, { name }) => total + (phases[name] ?? 0), 0);
    return `${MARKS.done} **${entries.length} steps** · ${formatDuration(seconds)}`;
  });
  return cutLines(texts.join('\n'), room).split('\n');
}

// The lines above the phases: when the run started, how long it has taken, its commit, the
// migrations it applied and, for a run that did not finish, the phase it ended in and why.
function headerLines(state) {
  const { outcome, startedAt, migrations } = state;
  const commit = `commit \`${shortSha(state.gitSha)}\``;
  const lines =
    outcome === 'running'
      ? [
          `Started ${discordTime(startedAt, 'f')} (${discordTime(startedAt, 'R')}) · ${commit}`,
          `Elapsed **${formatDuration((state.at - startedAt) / 1000)}**`
        ]
      : [
          `Started ${discordTime(startedAt, 'f')} · took **${formatDuration(state.seconds)}** · ${commit}`
        ];
  if (migrations.length > 0)
    lines.push(`Applied migrations ${plain(cut(migrations.join(', '), MAX_MIGRATIONS))}`);
  if (outcome !== 'running' && outcome !== 'finished') {
    if (state.phase) lines.push(`**Phase** ${label(state.phase)}`);
    if (state.reason) lines.push(`**Reason** ${describeReason(state.reason)}`);
  }
  return lines;
}

// Draw a run's embed from its state:
// - outcome: 'running', or how it ended: 'finished', 'failed', 'stopped' or 'lockLost';
// - startedAt, and at, which is now while it runs and when it ended once it has, in milliseconds;
// - seconds: how long a run that ended took;
// - gitSha: the commit it runs;
// - steps: the names of its steps, in order;
// - phases: how long each phase that has ended took, in seconds, by name;
// - phase: the phase under way, or the one it ended in, and phaseStartedAt, when it started;
// - completed: the names of the phases that finished;
// - progress: each step's latest progress, as { done, total, unit }, by name;
// - counts: the counts each step gave, by name, as the run record keeps them;
// - migrations: the importer migrations it applied;
// - reason: why a run that did not finish ended;
// - cycle: in loop mode, the number of the importer service's cycle, which its title names.
// Whatever the state holds, every part is kept within Discord's limits.
export default function renderRunStatus(state) {
  const array = (value) => (Array.isArray(value) ? value.map(String) : []);
  const object = (value) => (value && typeof value === 'object' ? value : {});
  const outcome = Object.hasOwn(TITLES, state.outcome) ? state.outcome : 'failed';
  const startedAt = Number.isFinite(state.startedAt) ? state.startedAt : 0;
  const at = Number.isFinite(state.at) ? state.at : startedAt;
  const normal = {
    ...state,
    outcome,
    startedAt,
    at,
    phaseStartedAt: Number.isFinite(state.phaseStartedAt) ? state.phaseStartedAt : at,
    steps: array(state.steps),
    completed: array(state.completed),
    migrations: array(state.migrations),
    phases: object(state.phases),
    progress: object(state.progress),
    counts: object(state.counts)
  };

  const room = Math.min(DESCRIPTION_LENGTH, MAX_DESCRIPTION);
  const header = cutLines(headerLines(normal).join('\n'), Math.floor(room / 2));
  const lines = fitLines(phaseLines(normal), room - header.length - 2, {
    running: outcome === 'running',
    phases: normal.phases
  });
  // A cycle of the importer service is named as one, e.g. CBL update cycle 12 finished.
  const cycle = Number.isSafeInteger(state.cycle) && state.cycle > 0 ? state.cycle : null;
  return {
    title: cycle ? TITLES[outcome].replace('run', `cycle ${cycle}`) : TITLES[outcome],
    color: COLORS[outcome],
    description: [header, '', ...lines].join('\n'),
    footer: { text: outcome === 'running' ? 'Last updated' : 'Ended' },
    timestamp: new Date(at).toISOString()
  };
}

// The embed of a message that shows a run in progress, or null for any other message, such as one
// whose run ended as usual, or one marked already.
function runningEmbed(message) {
  const embed = Array.isArray(message?.embeds) ? message.embeds[0] : null;
  return embed?.title === TITLES.running ? embed : null;
}

// Mark the embed of a run that ended without its last edit, e.g. as it was killed, as having ended
// without finishing, keeping how far it had got. Returns the message to replace it with, or null
// when its embed does not show a run in progress, as the run ended as usual or its embed was marked
// already. foundAt is when the run that found it started.
export function markUnfinished(message, { foundAt }) {
  const embed = runningEmbed(message);
  if (!embed) return null;

  // Discord refuses a field without a name or a value, so an empty one gets a zero-width space.
  const fields = (Array.isArray(embed.fields) ? embed.fields : [])
    .slice(0, MAX_FIELDS)
    .map(({ name, value, inline }) => ({
      name: cut(name ?? '', MAX_FIELD_NAME) || '\u200b',
      value: cut(value ?? '', MAX_FIELD_VALUE) || '\u200b',
      inline: Boolean(inline)
    }));
  const footer = typeof embed.footer?.text === 'string' ? cut(embed.footer.text, MAX_FOOTER) : '';
  const note = `**It stopped without saying how it ended**, e.g. as it was killed, ran out of memory, or was ended at once after a second signal or its time limit. This is how far it had got. The next run started ${discordTime(foundAt, 'f')}.`;
  const shown =
    typeof embed.description === 'string'
      ? embed.description.replaceAll(MARKS.current, MARKS.unfinished)
      : '';
  // The fields are kept, as many as leave room for the note, and the description gets what is left.
  const used = () =>
    TITLES.unfinished.length +
    footer.length +
    fields.reduce((total, { name, value }) => total + name.length + value.length, 0);
  while (fields.length > 0 && used() + note.length > MAX_TOTAL) fields.pop();
  const room = Math.min(MAX_DESCRIPTION, MAX_TOTAL - used());

  const revised = {
    title: TITLES.unfinished,
    color: COLORS.unfinished,
    description: cutLines(shown ? `${note}\n\n${shown}` : note, room)
  };
  if (fields.length > 0) revised.fields = fields;
  if (footer) revised.footer = { text: footer };
  if (typeof embed.timestamp === 'string') revised.timestamp = embed.timestamp;
  return {
    content: typeof message.content === 'string' && message.content ? message.content : null,
    embeds: [revised]
  };
}

// Show how a run ended on its embed when its last edit did not reach Discord, e.g. as Discord was
// down while the run ended, but the run saved its record, so the embed still shows it in progress.
// state is drawn as by renderRunStatus, from the run's record, and the footer says so. Returns the
// message to replace it with, or null when its embed does not show a run in progress, as its last
// edit reached Discord after all or it was marked already.
export function markEnded(message, state) {
  if (!runningEmbed(message)) return null;
  const embed = renderRunStatus(state);
  embed.footer = {
    text: `${embed.footer.text} · shown by the next run, from its record, as its last update did not reach Discord`
  };
  return { content: null, embeds: [embed] };
}
