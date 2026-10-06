const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// The Discord server the bot's commands are registered in.
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

// Comma separated IDs of the roles allowed to use the bot.
const DISCORD_ADMIN_ROLE_IDS = (process.env.DISCORD_ADMIN_ROLE_IDS || '')
  .split(',')
  .map((roleID) => roleID.trim())
  .filter((roleID) => roleID);

// Port the bot reports its status on for the Docker health check. It only listens inside the
// container.
const HEALTH_CHECK_PORT = 3000;

if (!DISCORD_BOT_TOKEN)
  throw new Error('Environmental variable DISCORD_BOT_TOKEN must be provided.');
if (!DISCORD_GUILD_ID) throw new Error('Environmental variable DISCORD_GUILD_ID must be provided.');
if (DISCORD_ADMIN_ROLE_IDS.length === 0)
  throw new Error('Environmental variable DISCORD_ADMIN_ROLE_IDS must be provided.');

export { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ADMIN_ROLE_IDS, HEALTH_CHECK_PORT };
