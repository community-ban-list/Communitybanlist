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

export function formatBanListType(type) {
  return BAN_LIST_TYPES[type] || type;
}

export function formatBanListSource(banList) {
  if (banList.type === 'battlemetrics')
    return `[${banList.source}](https://www.battlemetrics.com/rcon/ban-lists/${banList.source})`;
  return banList.source;
}

export function organisationEmbed(organisation, banLists, banCounts) {
  const description = banLists
    .map(
      (banList) =>
        `${bold(banList.name)} (#${banList.id}) · ${formatBanListType(banList.type)} · ${plural(
          banCounts[banList.id] || 0,
          'ban'
        )}\n${formatBanListSource(banList)}`
    )
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

export function banListEmbed(banList, organisation) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(`${organisation.name} / ${banList.name}`, 256))
    .addFields(
      { name: 'ID', value: String(banList.id), inline: true },
      { name: 'Type', value: formatBanListType(banList.type), inline: true },
      { name: 'Source', value: truncate(formatBanListSource(banList), 1024) }
    );
}

export function listEmbed(title, description, footer) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter(footer ? { text: footer } : null);
}
