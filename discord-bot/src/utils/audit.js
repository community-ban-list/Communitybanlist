import { Logger } from 'scbl-lib/utils';

// Record a change, and who made it, in the CBL log channel. An important line, such as the outcome
// of a change to many records, goes ahead of other lines there and is never dropped for them.
export default function audit(interaction, change, { important = false } = {}) {
  const line = `${interaction.user.tag} (${interaction.user.id}) ${change}`;
  if (important) Logger.important('DiscordBot', line);
  else Logger.verbose('DiscordBot', 1, line);
}
