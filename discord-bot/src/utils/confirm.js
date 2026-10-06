import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

const CONFIRM_TIMEOUT = 60 * 1000;

// Ask the user to confirm a destructive change. Resolves to whether they confirmed it in time.
export default async function confirm(interaction, content, confirmLabel) {
  const message = await interaction.editReply({
    content,
    embeds: [],
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
      time: CONFIRM_TIMEOUT
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
