# CBL Discord Bot

Slash commands for managing partner organisations, their ban lists and users' export ban lists from the CBL Discord, instead of editing the database by hand.

## Commands

| Command | What it does |
| --- | --- |
| `/org add name banlist_name type source [discord] [skip_check]` | Add a partner organisation along with its first ban list. Nothing is saved if the ban list's source fails its check. |
| `/org update organisation [name] [discord]` | Rename an organisation or change its Discord link. Use `none` to remove the link. |
| `/org remove organisation` | Remove an organisation, its ban lists and their bans, after a confirmation. |
| `/org info organisation` | Show an organisation and its ban lists with their ban counts. |
| `/org list` | List all organisations. |
| `/banlist add organisation name type source [skip_check]` | Add another ban list to an organisation. |
| `/banlist update banlist [name] [type] [source] [skip_check]` | Rename a ban list or change where its bans come from. A new type or source deletes the list's bans, after a confirmation, as the new source's bans replace them. |
| `/banlist remove banlist` | Remove a ban list and its bans, after a confirmation. |
| `/exportbanlist remove id` | Remove a user's export ban list by its ID, after showing its name, type, owner, players, BattleMetrics ID, whether CBL's BattleMetrics key can see its ban list and whether it is within today's limits, and a confirmation. Its owner is not told. |
| `/exportbanlist remove_outside_limits` | Remove every export ban list outside today's limits, after a preview of each and one confirmation, which waits up to 5 minutes. The owners are not told. |
| `/exportbanlist transfer id owner` | Give a user's export ban list to another Steam user, given by their SteamID64, after showing the list, its owner, the new owner and how many export ban lists the new owner has, with a warning if the new owner has not signed in to the website yet, and a confirmation. Only its owner changes, and neither owner is told. |

Organisations and ban lists can be picked from autocomplete suggestions. Replies are only visible to the person running the command, and every change is posted to the log webhook (`DISCORD_LOG_WEBHOOK`) with who made it.

A ban list's `source` is either:

- **Remote:** a link to a text file with one ban per line in the format `steamID:expiry //reason`.
- **BattleMetrics:** the ID of a BattleMetrics ban list, or a link to it. The CBL BattleMetrics organisation must have accepted the list's invite first.

The bot test fetches the source before saving it. It rejects sources that are already used by another ban list, and BattleMetrics sources that are one of CBL's own export ban lists, since importing one would feed exported players back in as new bans. Use `skip_check` to save a source without fetching it, e.g. a list that is empty for now; it skips only the test fetch, so the other checks still apply.

Changes take effect on the next ban importer run. When a ban list is removed or given a new type or source, its bans are deleted straight away and the affected players are queued so the importer recalculates their reputation and export bans. A new type or source is refused while a ban importer run, or a cycle of the importer service, is under way: the importer removes the old source's bans that it saves while the change is being made, but an older importer image, e.g. one a rollback runs, does not when it only polls the list's newest bans. Try again once it has finished. The importer service holds the run lock only during its cycles, so between them the change works.

### Export ban lists

`/exportbanlist remove` and `remove_outside_limits` remove export ban lists the way the website's Delete button does: a BattleMetrics list's ban list is deleted on BattleMetrics first (its invites and subscribers removed, then CBL's own organisation), and then the list itself, with its export bans and configs. Owners are not told. A list's players are its export bans waiting to be added or already added (status `TO_BE_CREATED` or `CREATED`), the players its `/export/ID` address serves. Removals are refused while a ban importer run, or a cycle of the importer service, is under way, which is checked before anything is shown, again once the removal is confirmed, and before each list of `remove_outside_limits`; a run or cycle that starts part-way stops the removal, which then says how many lists were removed and how many are left. Between the service's cycles, removals work.

`remove_outside_limits` finds the lists outside today's limits with the website's own rules and the `EXPORT_*` settings: those whose settings and configs break their type's points rules, and those with more players than their type's cap. The preview shows each list's type, owner, players and why, and the limits used, so they can be compared with the website's. Lists that do not fit in the message are in an attached text file, and the confirmation waits 5 minutes rather than the usual minute, so there is time to read it. Each list is read and checked again just before it is removed, so one its owner has brought within the limits, or deleted, meanwhile is left. A removal that fails is reported and the others carry on.

The deletion treats a ban list BattleMetrics does not know as already gone, and an API key from an account outside CBL's organisation would get that answer for every one of CBL's ban lists. So before it removes any BattleMetrics list, `remove_outside_limits` reads the ban lists the key can see from BattleMetrics. When the key can see none of the ban lists CBL's export ban lists record, or BattleMetrics cannot be asked, no list with a BattleMetrics ban list is removed, and a list whose own ban list the key cannot see is left, to be checked on BattleMetrics and removed with `/exportbanlist remove`. A ban list that the key could see but that is gone when its list is removed stops the removal there, as the key may have lost its access.

`/exportbanlist remove` reads the ban lists the key can see too, for a list with a BattleMetrics ban list, and its confirmation says so in bold when the key cannot see the list's ban list, can see none of CBL's, or BattleMetrics cannot be asked. The list can still be removed, as that is how a list whose ban list is really gone from BattleMetrics is removed. If BattleMetrics then does not know the ban list, the reply and the log say it may still be on BattleMetrics, to be checked there, rather than that it is gone.

Removing a BattleMetrics list takes several BattleMetrics requests within the bot's own budget, so removing many can take longer than the 15 minutes Discord lets the bot update its reply for. The reply then stops updating, and the removal carries on: each list removed, each failure and the summary are posted to the log webhook too, in the order they happened.

`/exportbanlist transfer` gives a list to another Steam user, e.g. when someone else now runs the community it was made for. Only the list's owner changes: its settings, configs, players, Discord webhook and BattleMetrics ban list stay as they are, so the servers and organisations using it carry on as before, and its alerts keep going to its webhook until the new owner changes it. The website reads a list's owner from the database on every request, so from then on the new owner sees the list on the website, with its webhook and BattleMetrics invite, and can change or delete it, and the old owner no longer can. Neither is told. CBL must already know the new owner's Steam ID, which signing in to the website once adds, and the new owner can have at most 4 export ban lists, as on the website; the transfer is refused otherwise. CBL also knows the Steam IDs of players who have been on its ban lists, so a list can be given to someone who has never signed in, who sees it once they do. The confirmation warns when the new owner has not signed in yet, so the Steam ID can be checked first. Once it is confirmed, the list and the new owner's lists are read again, and nothing is changed if the list has been deleted or given to someone else meanwhile, or the new owner has 4 lists by then. The bot makes one transfer at a time, so two confirmed together cannot both give a user their fourth list. Transfers are not refused while a ban importer run is under way, as nothing a run does depends on a list's owner. One made while a run recalculates every player's reputation, as after a big import, can wait for it for most of a minute, as the website's own changes can, and transfers confirmed meanwhile wait for it in turn. If MySQL gives up waiting, the transfer fails with nothing changed, to be tried again.

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
| `BATTLEMETRICS_API_KEY` | Used to check partners' BattleMetrics ban lists, and to delete the BattleMetrics ban lists of export ban lists. For that it must be able to manage CBL's organisation's ban lists, as the web server's key does, so use the same key. |
| `BATTLEMETRICS_ORGANIZATION` | ID of CBL's BattleMetrics organisation, as for the web server. Defaults to 56746. |
| `BATTLEMETRICS_API_RESERVOIR` | How many BattleMetrics requests a minute the bot may make, as for the other services. Defaults to 10, about one BattleMetrics list removed a minute. The web server's, the importer's and the bot's budgets together must stay within BattleMetrics' 300 requests a minute for the key. |
| `EXPORT_BM_MAX_PLAYERS`, `EXPORT_BM_MIN_THRESHOLD`, `EXPORT_BM_NEVER_ENOUGH`, `EXPORT_REMOTE_MAX_PLAYERS`, `EXPORT_REMOTE_MIN_THRESHOLD`, `EXPORT_REMOTE_NEVER_ENOUGH` | The limits on export ban lists. Set them exactly as for the web server: without them the bot uses the defaults, and `/exportbanlist remove_outside_limits` would then remove lists by limits other than the website's. The bot warns about values it cannot use when it starts. |
| `STEAM_API_KEY` | Required by `scbl-lib`, as for the other services. |
| `DISCORD_LOG_WEBHOOK` | Webhook the audit log is posted to, as for the other services. |

## Running

The bot runs on Node.js 26, like the other services.

```bash
yarn start-discord-bot
```

Or with Docker. CI pushes the image to the private `werewolfboy13/cbl-bot` repository, so the server needs a `docker login` with access to it, and it runs as the `bot` service in the CBL Docker stack. The image is based on [Docker Hardened Images](https://docs.docker.com/dhi/), so building it yourself needs a `docker login dhi.io` with a Docker Hub account first.

The bot only makes outgoing connections, to Discord, BattleMetrics and remote ban lists, so it needs internet access as well as the database but no published ports.

When updating to the version with `/exportbanlist`, give the bot service the web service's `EXPORT_*` settings and `BATTLEMETRICS_ORGANIZATION`, if the web service sets them, and a `BATTLEMETRICS_API_RESERVOIR` budget of its own. Its `BATTLEMETRICS_API_KEY` must be one that can delete CBL's ban lists, like the web service's.

### Health

The image has a Docker health check, so `docker ps` shows the bot as `healthy` once it is connected to both Discord and the database, and `unhealthy` if either connection is lost for about 90 seconds. To see which one failed:

```bash
docker inspect --format '{{json .State.Health}}' cbl-bot
```

Docker only reports the status. It does not restart unhealthy containers by itself.
