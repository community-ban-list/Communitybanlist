import { EmbedBuilder, escapeMarkdown, time, TimestampStyles } from 'discord.js';

// The CBL brand colour used in its Discord webhook messages.
const COLOR = 0xffc40b;

const BAN_LIST_TYPES = {
  remote: 'Remote',
  battlemetrics: 'BattleMetrics'
};

export function bold(text) {
  return `**${escapeMarkdown(text)}**`;
}

export function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function plural(count, noun) {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatBanListName(banList, organisation) {
  return `${bold(organisation.name)} / ${bold(banList.name)}`;
}

// Describe the organisation for the audit log.
export function describeOrganisation(organisation) {
  return `organisation "${organisation.name}" (ID: ${organisation.id})`;
}

// Describe the ban list for the audit log.
export function describeBanList(banList, organisation) {
  return `ban list "${banList.name}" (ID: ${banList.id}) of ${describeOrganisation(organisation)}`;
}

export function formatBanListType(type) {
  return BAN_LIST_TYPES[type] || type;
}

// How a paused ban list's row (see scbl-lib/db/ban-list-suspensions.js) is shown: suspended, as
// its import is stopped and its bans count for nothing, or resuming, as it is imported again while
// its bans still count for nothing, until the ban importer has caught up with it.
export function pauseState(paused) {
  if (!paused) return null;
  return paused.resumedAt === null || paused.resumedAt === undefined ? 'suspended' : 'resuming';
}

// What a paused ban list's row says, on a few lines: since when it is suspended or resuming, by
// whom, and why. Who and why are as the admin gave them, so they are escaped.
export function describePause(paused) {
  const state = pauseState(paused);
  if (!state) return 'Not paused: it is imported, and its bans count.';
  const since = time(paused.suspendedAt, TimestampStyles.ShortDateTime);
  const lines = [
    state === 'suspended'
      ? `Suspended since ${since} by ${escapeMarkdown(paused.suspendedBy)}: it is not imported, and its bans count for nothing.`
      : `Resuming since ${time(paused.resumedAt, TimestampStyles.ShortDateTime)}, after being suspended since ${since} by ${escapeMarkdown(paused.suspendedBy)}: it is imported again, and its bans count again once the ban importer has read it in full and confirmed the bans it no longer has.`
  ];
  if (paused.reason) lines.push(`Reason: ${escapeMarkdown(paused.reason)}`);
  return lines.join('\n');
}

export function formatBanListSource(banList) {
  if (banList.type === 'battlemetrics')
    return `[${banList.source}](https://www.battlemetrics.com/rcon/ban-lists/${banList.source})`;
  return banList.source;
}

// The organisation and its ban lists, each with its number of bans, and marked when it is paused,
// by the paused lists' rows, by ban list ID (paused).
export function organisationEmbed(organisation, banLists, banCounts, paused = new Map()) {
  const description = banLists
    .map((banList) => {
      const state = pauseState(paused.get(banList.id));
      return `${bold(banList.name)} (#${banList.id}) · ${formatBanListType(banList.type)} · ${plural(
        banCounts[banList.id] || 0,
        'ban'
      )}${state ? ` · ${state}` : ''}\n${formatBanListSource(banList)}`;
    })
    .join('\n\n');

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(organisation.name, 256))
    .setDescription(truncate(description || 'No ban lists yet. Add one with `/banlist add`.', 4096))
    .addFields(
      { name: 'ID', value: String(organisation.id), inline: true },
      { name: 'Discord', value: truncate(organisation.discord || 'None', 1024), inline: true },
      {
        name: 'Added',
        value: time(organisation.createdAt, TimestampStyles.ShortDate),
        inline: true
      }
    );
}

// The ban list, with what its paused row says, when it is given and the list is paused.
export function banListEmbed(banList, organisation, paused = null) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(`${organisation.name} / ${banList.name}`, 256))
    .addFields(
      { name: 'ID', value: String(banList.id), inline: true },
      { name: 'Type', value: formatBanListType(banList.type), inline: true },
      { name: 'Source', value: truncate(formatBanListSource(banList), 1024) }
    );
  if (pauseState(paused))
    embed.addFields({ name: 'Paused', value: truncate(describePause(paused), 1024) });
  return embed;
}

// The states of a list's import, as the ban importer keeps them in its BanListSyncs row.
const IMPORT_STATES = {
  ok: 'OK',
  failing: 'Failing',
  held: 'Imported, with removals held until they are confirmed',
  access_lost: 'CBL cannot read it on BattleMetrics',
  self_import: "Not imported, as its source is one of CBL's own export ban lists"
};

// A time, as Discord shows it in each reader's own time zone, relative to now, or never.
const when = (value) => (value ? time(new Date(value), TimestampStyles.RelativeTime) : 'never');
const count = (value) =>
  value === null || value === undefined ? 'unknown' : plural(Number(value), 'ban');

// How the ban importer last imported a list, on a few lines, from its BanListSyncs row (sync), or
// that it has not imported it yet, and the bans it holds back from removing (removals: waiting for a
// confirming read, and held for an admin).
export function describeImport(sync, removals = { waiting: 0, held: 0 }) {
  if (!sync) return 'Not imported yet.';
  const lines = [
    `${IMPORT_STATES[sync.state] ?? escapeMarkdown(String(sync.state))} · last imported ${when(sync.lastSuccessAt)} · last read in full ${when(sync.lastFullScanAt)}`,
    `${count(sync.storedCount)} stored${sync.headTotal === null || sync.headTotal === undefined ? '' : ` · ${count(sync.headTotal)} on BattleMetrics`}`
  ];
  if (removals.waiting > 0 || removals.held > 0)
    lines.push(
      `Removals: ${plural(removals.waiting, 'ban')} waiting for a confirming read, ${plural(removals.held, 'ban')} held for an admin`
    );
  if (sync.lastError) lines.push(`Last error: ${escapeMarkdown(sync.lastError)}`);
  return lines.join('\n');
}

// How the ban importer last imported a list, on one line: its state and when, for a list of lists.
export function summariseImport(sync) {
  if (!sync) return 'not imported yet';
  return `${IMPORT_STATES[sync.state] ?? escapeMarkdown(String(sync.state))} · last imported ${when(sync.lastSuccessAt)}`;
}

// A ban list's status: whether it is paused, and how the ban importer last imported it.
export function banListStatusEmbed(
  banList,
  organisation,
  { paused = null, sync = null, removals } = {}
) {
  return banListEmbed(banList, organisation).addFields(
    { name: 'Paused', value: truncate(describePause(paused), 1024) },
    { name: 'Import', value: truncate(describeImport(sync, removals), 1024) }
  );
}

export function listEmbed(title, description, footer) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter(footer ? { text: footer } : null);
}
