import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

import { listEmbed } from './format.js';

const LINES_PER_PAGE = 20;
const PAGINATION_TIMEOUT = 5 * 60 * 1000;

// Show the lines in an embed, with buttons to page through them if they do not fit on one page.
export default async function paginate(interaction, title, lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE)
    pages.push(lines.slice(i, i + LINES_PER_PAGE).join('\n'));
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
