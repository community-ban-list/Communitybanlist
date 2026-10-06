import { Logger } from 'scbl-lib/utils';

// Record a change, and who made it, in the CBL log channel.
export default function audit(interaction, change) {
  Logger.verbose('DiscordBot', 1, `${interaction.user.tag} (${interaction.user.id}) ${change}`);
}
