import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

import { connect, disconnect } from 'scbl-lib/db';
import { Logger } from 'scbl-lib/utils';

import commands from './src/commands/index.js';
import startHealthCheckServer from './src/health-check-server.js';
import { DISCORD_ADMIN_ROLE_IDS, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } from './src/config.js';
import { UserError } from './src/utils/index.js';

const SHUTDOWN_LOG_TIMEOUT = 5000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let shuttingDown = false;

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only members of the CBL Discord with one of the admin roles may use the bot.
function isAdmin(interaction) {
  if (interaction.guildId !== DISCORD_GUILD_ID || !interaction.member) return false;

  const { roles } = interaction.member;
  const roleIDs = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return roleIDs.some((roleID) => DISCORD_ADMIN_ROLE_IDS.includes(roleID));
}

async function handleAutocomplete(interaction, command) {
  if (!isAdmin(interaction)) {
    await interaction.respond([]);
    return;
  }

  await command.autocomplete(interaction);
}

async function handleCommand(interaction, command) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await command.execute(interaction);
  } catch (err) {
    const name = `/${interaction.commandName} ${interaction.options.getSubcommand(false) || ''}`;
    if (!(err instanceof UserError))
      Logger.verbose('DiscordBot', 1, `Failed to run ${name.trim()}: `, err);

    await interaction.editReply({
      content:
        err instanceof UserError
          ? err.message
          : `Something went wrong running ${name.trim()}: ${err.message}`,
      embeds: [],
      components: []
    });
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await client.destroy();
    await disconnect();

    // Give queued log messages a chance to send.
    const deadline = Date.now() + SHUTDOWN_LOG_TIMEOUT;
    while (Date.now() < deadline && Object.values(Logger.getLogQueue()).some((count) => count > 0))
      await doSleep(500);
  } finally {
    process.exit(code);
  }
}

client.once(Events.ClientReady, async () => {
  try {
    await client.application.commands.set(
      [...commands.values()].map((command) => command.data.toJSON()),
      DISCORD_GUILD_ID
    );
  } catch (err) {
    console.error('Failed to register commands:', err);
    await shutdown(1);
    return;
  }

  Logger.verbose(
    'DiscordBot',
    1,
    `Logged in as ${client.user.tag} and registered ${commands.size} commands.`
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    if (interaction.isAutocomplete()) await handleAutocomplete(interaction, command);
    else await handleCommand(interaction, command);
  } catch (err) {
    console.error(`Failed to handle /${interaction.commandName}:`, err);
  }
});

client.on(Events.Error, (err) => console.error('Discord client error:', err));

// Keep running if something fails in the background, e.g. sending to the log webhook.
process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

async function main() {
  startHealthCheckServer(client);
  await connect();
  await client.login(DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
