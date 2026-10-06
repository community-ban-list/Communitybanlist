# CBL Discord Bot

Slash commands for managing partner organisations and their ban lists from the CBL Discord, instead of editing the database by hand.

## Commands

| Command | What it does |
| --- | --- |
| `/org add name [discord]` | Add a partner organisation. |
| `/org update organisation [name] [discord]` | Rename an organisation or change its Discord link. Use `none` to remove the link. |
| `/org remove organisation` | Remove an organisation, its ban lists and their bans, after a confirmation. |
| `/org info organisation` | Show an organisation and its ban lists with their ban counts. |
| `/org list` | List all organisations. |
| `/banlist add organisation name type source [skip_check]` | Add a ban list to an organisation. |
| `/banlist update banlist [name] [type] [source] [skip_check]` | Rename a ban list or change where its bans come from. |
| `/banlist remove banlist` | Remove a ban list and its bans, after a confirmation. |

Organisations and ban lists can be picked from autocomplete suggestions. Replies are only visible to the person running the command, and every change is posted to the log webhook (`DISCORD_LOG_WEBHOOK`) with who made it.

A ban list's `source` is either:

- **Remote:** a link to a text file with one ban per line in the format `steamID:expiry //reason`.
- **BattleMetrics:** the ID of a BattleMetrics ban list, or a link to it. The CBL BattleMetrics organisation must have accepted the list's invite first.

The bot test fetches the source before saving it, and rejects sources that are already used by another ban list. Use `skip_check` to save a source without fetching it, e.g. a list that is empty for now.

Changes take effect on the next ban importer run. When a ban list is removed, its bans are deleted straight away and the affected players are queued so the importer recalculates their reputation and export bans.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), open **Bot** and reset the token to get `DISCORD_BOT_TOKEN`. The bot needs no privileged intents.
2. Invite the bot to the CBL Discord, replacing `APPLICATION_ID` with the application's ID:

   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot+applications.commands&permissions=0`

3. Set the environment variables below and start the bot. It registers its commands in the server when it starts.
4. The commands are hidden from everyone but administrators by default. To show them to your admin role, open **Server Settings → Integrations →** the bot and allow the role. The bot also checks `DISCORD_ADMIN_ROLE_IDS` itself, so members without one of those roles cannot use it even if they can see the commands.

### Environment variables

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The bot's token. |
| `DISCORD_GUILD_ID` | ID of the CBL Discord server. |
| `DISCORD_ADMIN_ROLE_IDS` | Comma separated IDs of the roles allowed to use the bot. |
| `DATABASE_URI` | The CBL database, as for the other services. |
| `BATTLEMETRICS_API_KEY` | Used to check BattleMetrics ban lists. |
| `STEAM_API_KEY` | Required by `scbl-lib`, as for the other services. |
| `DISCORD_LOG_WEBHOOK` | Webhook the audit log is posted to, as for the other services. |

## Running

The bot runs on Node.js 24, as discord.js needs a newer version than the other services use.

```bash
yarn start-discord-bot
```

Or with Docker. CI pushes the image to the private `werewolfboy13/cbl-bot` repository, so the server needs a `docker login` with access to it, and it runs as the `bot` service in the CBL Docker stack. The image is based on [Docker Hardened Images](https://docs.docker.com/dhi/), so building it yourself needs a `docker login dhi.io` with a Docker Hub account first.

The bot only makes outgoing connections, to Discord, BattleMetrics and remote ban lists, so it needs internet access as well as the database but no published ports.
