import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

const CONFIRM_TIMEOUT = 60 * 1000;

// Ask the user to confirm a destructive change. extra can add embeds and files to the question,
// e.g. what the change would remove, and give a timeout in milliseconds other than a minute, e.g.
// for a question with a long list to read first. Resolves to whether they confirmed it in time.
export default async function confirm(interaction, content, confirmLabel, extra = {}) {
  const { timeout = CONFIRM_TIMEOUT, ...payload } = extra;
  const message = await interaction.editReply({
    embeds: [],
    ...payload,
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('confirm')
          .setLabel(confirmLabel)
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      )
    ]
  });

  let button;
  try {
    button = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (component) => component.user.id === interaction.user.id,
      time: timeout
    });
  } catch {
    await interaction.editReply({ content: 'Timed out. Nothing was changed.', components: [] });
    return false;
  }

  if (button.customId !== 'confirm') {
    await button.update({ content: 'Cancelled. Nothing was changed.', components: [] });
    return false;
  }

  await button.update({ content: 'Working on it...', components: [] });
  return true;
}
