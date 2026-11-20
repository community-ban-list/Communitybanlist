import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

import { listEmbed, truncate } from './format.js';

const LINES_PER_PAGE = 20;
const PAGINATION_TIMEOUT = 5 * 60 * 1000;
// The most characters an embed's description holds, which Discord refuses more than.
const MAX_PAGE_LENGTH = 4096;

// The lines in pages, each of at most LINES_PER_PAGE lines and MAX_PAGE_LENGTH characters with the
// line breaks between them, as an embed's description holds no more, so lines that are long, such
// as those of /banlist status for lists with long names whose bans are held, start a page sooner. A
// line too long for a page on its own is cut short.
export function pageLines(lines) {
  const pages = [];
  let page = [];
  let length = 0;
  for (const line of lines.map((text) => truncate(text, MAX_PAGE_LENGTH))) {
    if (
      page.length > 0 &&
      (page.length >= LINES_PER_PAGE || length + 1 + line.length > MAX_PAGE_LENGTH)
    ) {
      pages.push(page.join('\n'));
      page = [];
    }
    length = page.length === 0 ? line.length : length + 1 + line.length;
    page.push(line);
  }
  if (page.length > 0) pages.push(page.join('\n'));
  return pages;
}

// Show the lines in an embed, with buttons to page through them if they do not fit on one page.
export default async function paginate(interaction, title, lines) {
  const pages = pageLines(lines);
  if (pages.length === 0) pages.push('Nothing to show.');

  let page = 0;
  const render = () => ({
    embeds: [
      listEmbed(title, pages[page], pages.length > 1 ? `Page ${page + 1} of ${pages.length}` : null)
    ],
    components:
      pages.length > 1
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('previous')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === 0),
              new ButtonBuilder()
                .setCustomId('next')
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page === pages.length - 1)
            )
          ]
        : []
  });

  const message = await interaction.editReply(render());
  if (pages.length === 1) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (button) => button.user.id === interaction.user.id,
    idle: PAGINATION_TIMEOUT
  });

  collector.on('collect', (button) => {
    page = Math.min(Math.max(page + (button.customId === 'next' ? 1 : -1), 0), pages.length - 1);
    button.update(render()).catch((err) => console.error('Failed to change page:', err));
  });

  // Remove the buttons once they stop working. This fails if the reply has already expired.
  collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
}
