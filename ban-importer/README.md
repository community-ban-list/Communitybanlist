# CBL Ban Importer

Copies the bans of the partner ban lists into the CBL database, then updates the Steam profiles, reputation points and ranks of the players, recalculates the export ban lists and sends their changes to BattleMetrics. One run does all of this and exits. The script that starts the importer runs it every 6 hours.

## Running it

The importer runs on Node.js 26, like the other services, as `yarn start-ban-importer` or with the `werewolfboy13/cblimporter` image. The script that starts it runs each run in a container of its own, with `--init`, so a `docker stop` lets the run stop cleanly, and `--stop-timeout 60`, so the run has time to: once it reaches a safe point, it ends within 45 seconds.

```bash
docker run -d --init --stop-timeout 60 --env-file .envimporter --name cblimporter \
  --network=cbl_backend --network=cbl_frontend werewolfboy13/cblimporter:sha-<commit>
docker wait cblimporter # Waits for the run to end, and prints its exit code.
```

Until the container is removed, `docker inspect -f '{{.State.ExitCode}}' cblimporter` gives the run's exit code and `docker logs cblimporter` its output. Before the next start, the script removes it with `docker rm cblimporter` once the run has ended, never with `docker rm -f`, which kills a run that is still going before it can save its record, and throws away its output with its JSON line.

Only one run works at a time. A run holds a MySQL lock while it works, and a run started meanwhile is skipped, with exit code 75. With the same container name for every run, though, a start while a run is still going fails in Docker, with exit code 125 as the name is in use, and never reaches the importer. A stuck run is then ended by its time limit, `IMPORTER_MAX_RUN_SECONDS`, or at the latest 60 seconds after it, so keep that shorter than the time between starts. For such a start to be skipped instead, and to check whether the importer is stale (see below), give each run a name of its own, e.g. `--name "cblimporter-$(date +%Y%m%d%H%M)" --label cbl-importer`. `docker ps -a --latest --quiet --filter label=cbl-importer` then finds the latest run, and `docker container prune --force --filter label=cbl-importer` removes the containers of the runs that have ended, never one that is still going.

### Exit codes

| Code | Meaning                                                                                                         | What to do                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `0`  | The run finished.                                                                                               | Nothing.                                                                                                    |
| `1`  | The run failed, e.g. it could not reach the database, a step or migration failed, or it lost its run lock.      | Read why in the run's JSON line or the log channel. The next run starts afresh.                             |
| `3`  | The run stopped part-way, as it received `SIGTERM` or `SIGINT`, or took longer than `IMPORTER_MAX_RUN_SECONDS`. | Nothing, unless it keeps happening. The next run picks up the work.                                         |
| `75` | The run was skipped, as another run holds the run lock, e.g. one started by hand or under another name.         | Nothing. If no run has succeeded for 3 cadences, e.g. as the other run is stuck, it posts that it is stale. |

### The JSON line

Every run ends by printing its record as one line of JSON, which starts with `{"event":"cbl-importer-run"`. To see the latest, while its container is still there:

```bash
docker logs cblimporter 2>&1 | grep -F '{"event":"cbl-importer-run"' | tail -n 1
docker logs cblimporter 2>&1 | grep -F '{"event":"cbl-importer-run"' | tail -n 1 | jq '{outcome, exitCode, seconds, reason, phase}'
```

To keep the lines of every run, the script can add each one to a file before it removes the container, e.g. `docker logs cblimporter 2>&1 | grep -F '{"event":"cbl-importer-run"' >> importer-runs.jsonl`. The database also keeps the latest 100 runs (see below).

For example, spread over several lines here and shortened:

```json
{
  "event": "cbl-importer-run",
  "outcome": "finished",
  "exitCode": 0,
  "startedAt": "2026-10-15T19:00:21.975Z",
  "endedAt": "2026-10-15T19:29:58.958Z",
  "seconds": 1776.98,
  "gitSha": "0e921bf",
  "phases": {
    "waitForDatabase": 0.02,
    "takeRunLock": 0.01,
    "connect": 0.84,
    "migrate": 0.05,
    "importBans": 521.3,
    "updateSteamUserInfo": 17.22,
    "clearOrphanedUsers": 0.13,
    "updateReputationPoints": 0.81,
    "updateReputationRank": 5.63,
    "updateExportBans": 767.25,
    "exportExportBans": 464.13
  },
  "counts": {
    "importBans": {
      "lists": 20,
      "imported": 20,
      "fetched": 86919,
      "new": 41,
      "updated": 12,
      "removed": 26,
      "held": 0,
      "failedLists": 0,
      "selfImports": 0,
      "accessLost": 0,
      "accessCheck": "ok",
      "banLists": [
        {
          "id": 46,
          "fetched": 11761,
          "new": 3,
          "updated": 1,
          "removed": 2,
          "held": 0,
          "stored": 11760
        }
      ]
    }
  }
}
```

| Field                  | What it holds                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `outcome`, `exitCode`  | How the run ended: `finished` (0), `failed` (1), `interrupted` (3) or `skipped` (75).                                      |
| `startedAt`, `endedAt` | When the run started and ended, in UTC, and `seconds` how long it took.                                                    |
| `gitSha`               | The commit the image was built from, from `GIT_SHA`, or `unknown` when that is not set.                                    |
| `reason`               | Why a run did not finish: the error, or why it stopped or was skipped.                                                     |
| `phase`                | The phase a run that did not finish was in, or had just finished when it stopped between two.                              |
| `migrations`           | The importer migrations the run applied, if any, also when a later one failed.                                             |
| `phases`               | How long each phase took, in seconds: waiting for the database, taking the run lock, connecting, migrations and each step. |
| `counts`               | What the steps counted (see below).                                                                                        |

The steps that count what they do keep their counts also when they fail or stop part-way:

| Step                  | Counts                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `importBans`          | The totals of its summary line, how many of its `lists` it `imported` and, in `banLists`, each list's own counts and errors. |
| `updateSteamUserInfo` | How many Steam users were `due` to be refreshed, and how many it `updated`.                                                  |
| `updateExportBans`    | How many `players` it recalculated.                                                                                          |
| `exportExportBans`    | How many export bans were `queued`, and of those, how many it `created` and `deleted`, and how many `failed`.                |

`importBans` also counts the lists that import one of CBL's own export ban lists (`selfImports`) and those CBL can no longer read on BattleMetrics (`accessLost`), and says how the access check went (`accessCheck`: `ok`, `failed`, `off`, or `unused` when no BattleMetrics list was imported). Each list in `banLists` has its `state` when it is not `ok` (see [Ban list states](#ban-list-states)).

A run that held the run lock also saves its record in the database, in the importer's `ImporterState` table:

| Row                | What it holds                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `lastRun`          | The latest run's record, as its JSON line shows it.                                                   |
| `lastSuccessAt`    | When the latest successful run started: one that exited 0 and imported at least one ban list, if any. |
| `recentRuns`       | The latest 100 runs' records, oldest first, without per-list counts.                                  |
| `lastStaleAlertAt` | When the run, or the skipped start, that last posted that the importer is stale started.              |
| `lastRunMessage`   | The ID of the latest run's status message in the log channel, and when that run started (see below).  |

```sql
SELECT name, updatedAt, value FROM ImporterState;
```

A run that never held the lock, e.g. one that was skipped or could not reach the database, only prints its line, except that a skipped start that posts that the importer is stale saves when it started, in `lastStaleAlertAt`. A run left waiting for something that can never happen, e.g. an answer on a connection that is gone, is ended as failed, and prints and saves its record. One ended at once by a second signal or 60 seconds after its time limit prints its line but has no time to save it. A run that is killed, e.g. by `docker rm -f` or for running out of memory, prints neither, and then only its exit code, and its status message in the log channel, tell how far it got.

### Staleness

The importer is stale when no run has succeeded for 3 times `IMPORTER_CADENCE_SECONDS`, which is 18 hours by default. A run succeeds when it exits 0 and imports at least one ban list, so runs during a BattleMetrics outage, when every list fails, do not count. The importer then posts that it is stale to the log channel, and again every `IMPORTER_CADENCE_SECONDS` while it stays stale. It compares when runs started, so with a run every `IMPORTER_CADENCE_SECONDS`, the alert comes with the 3rd run in a row that does not succeed, however quickly the runs fail, and it allows 5 minutes, or a tenth of the cadence if that is less, for runs that start a little early or late. Set `IMPORTER_CADENCE_SECONDS` to how often the script starts a run.

Only the importer checks: at the end of every run that did not succeed, and whenever a start is skipped, as another run holds the lock. So while no run starts at all, nothing is posted. Whichever run or skipped start posts saves when it started, so no other posts again within the cadence.

### The log channel

The importer posts to `DISCORD_LOG_WEBHOOK` one status message for each run, and otherwise only what may need looking at: failures, removals held for confirmation and staleness, each as a message of its own. The import's totals appear in the status message; its summary line (`Got N deleted bans. Imported 20 ban lists: …`) is only printed in the console, with everything else.

As soon as a run holds the run lock, it posts its status, an embed, and keeps it up to date while it goes, editing it at most every 15 seconds. The embed shows that the run is in progress, in blurple, when it started, in each viewer's own time, how long it has taken, the commit it runs and any importer migrations it applied. Below them are the run's steps: each finished one with a tick, its time and what it counted, the one under way with how long it has taken and a bar of how far it has got, e.g. `18,250 / 145,155 players` or `7 / 20 ban lists`, and those still to run.

When the run ends, it edits the embed a last time, before it releases the lock, to show how it ended: finished in green, failed in red, lost its run lock in red, or stopped in orange, as it received `SIGTERM` or `SIGINT` or took longer than `IMPORTER_MAX_RUN_SECONDS`. The embed then shows how long the run took, each step's time and counts (the import's totals as in its summary line, the Steam profiles updated, the players recalculated, and the export bans created and deleted), and for a run that did not finish, the phase it ended in and why. A run that is skipped, or fails before it holds the lock, posts no status, only its failure line, if it failed.

A run whose last edit does not reach Discord leaves its embed saying it is in progress: one that was killed, ran out of memory, or was ended at once by a second signal or 60 seconds after its time limit, and one that ended as usual while Discord was down or refused the edit. So each run saves which message is its status in `ImporterState` (`lastRunMessage`), and the next run that holds the lock reads that message back and, if it still says it is in progress, corrects it, once, in the background. A run that saved its record is shown as it ended, drawn from its record, with a footer that says so. One that saved none ended without saying how, so it is marked as having ended without finishing, in red, keeping how far it had got.

Nothing the importer does waits for Discord: its messages are sent in the background, one request at a time, and at the end of a run for at most what is left of its 45 seconds. The status goes ahead of the other messages, so it is not dropped when Discord falls behind. Discord has 30 seconds to answer the status's post, and if it rate limits or fails the post, or does not answer it, the status is posted again 15 seconds later, so the run still gets one. If Discord refuses to edit it, e.g. as someone deleted it, or to post it, the run stops trying. Without `DISCORD_LOG_WEBHOOK`, or with one that is not a Discord webhook, nothing is posted.

Two kinds of embed can still say a run is in progress for good, as no later run knows of them: one Discord posted without answering within those 30 seconds, as the importer never learns which message it is and posts the status again, and one whose post Discord answered only once its run was ending, which the run does not save, should its final edit then not reach Discord.

## Ban list states

After each list's import, the importer saves how it went in the list's row of `BanListSyncs`, so the next runs know it too. The row is saved once the run knows how the import ended: right after it, or, for a list the run tries again after the others, or one CBL cannot read, once every list has been tried. A list is in one of these states:

| State         | What it means                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | Its latest import went as it should.                                                                                                                                                                                                                          |
| `failing`     | Its latest import failed, e.g. as its source was down. Its bans are kept as they are.                                                                                                                                                                         |
| `held`        | It was imported, but it would lose many bans at once, so removing them waits for `IMPORTER_ALLOW_MASS_REMOVAL`.                                                                                                                                               |
| `access_lost` | CBL cannot read it on BattleMetrics, or BattleMetrics does not list it among the ban lists the CBL organisation can see. It is still fetched, and any new bans it gives are saved, but none of its bans are removed, even with `IMPORTER_ALLOW_MASS_REMOVAL`. |
| `self_import` | Its source is one of CBL's own export ban lists. It is neither fetched nor swept.                                                                                                                                                                             |

**Failures.** A list that fails 3 runs in a row is posted about once, at the 3rd, or at once if it starts failing with more, e.g. after a while in which it imported a CBL export ban list. A run that tries a list again after the other lists counts as one run: the list's row waits for the second attempt, so a list that the second attempt imports is neither counted as failed nor posted about. Once the list imports again, it is back to `ok`, and is posted about again only after another 3 failed runs in a row. Each failed run still posts its own line, as before, except when it only shows again that CBL cannot read a list (see below).

**Lost access.** A list is taken to be one CBL can no longer read when:

- the access check, once a run, does not find its source among the ban lists BattleMetrics says the CBL organisation can see (`GET /ban-lists`, every page), comparing IDs ignoring case, hyphens and spaces;
- BattleMetrics answers its fetch with HTTP 404, Unknown ban list; or
- BattleMetrics answers with no bans on the first page but still counts some, as it does for a list CBL may see but not its bans. Such a list has not emptied, so its fetch fails.

A list that loses access is posted about once. A list that BattleMetrics does not list, but whose fetch still works, is posted about as such: its new bans are saved, but none are removed until BattleMetrics lists it again. For any other, the alert says what to do: if its owner has stopped sharing it with the CBL organisation, remove it with `/banlist remove`, which removes its bans too. When at least 3 lists, and at least half of the BattleMetrics lists a run tried, lose access in the same run, they are posted about together instead, as CBL's own BattleMetrics token, or its role in the CBL organisation, is then the likelier cause: check the token before removing any of them. A list whose fetch shows that CBL has lost access to it is not tried again later in the run. Once it has been posted about, a failed fetch that only shows this again goes to the console, while any other failure of it, e.g. during a BattleMetrics outage, is posted as for any list.

The list stays `access_lost` until a run shows that CBL can read it again: its fetch works, while the access check finds it, or is off. A run that cannot tell, as the check could not be made, or the fetch failed for another reason, e.g. during a BattleMetrics outage, leaves it as it was: it is not swept, posted about again or said to be back to normal, and its row keeps why it lost access. Once CBL can read it again, it is checked for removed bans again, and the console says it is back to normal.

A failed read of BattleMetrics' ban lists never holds up the import: that run goes without the check, and says so in the console and in `accessCheck`. As lists that lost access stay so meanwhile, a check that keeps failing keeps them from being swept. `IMPORTER_ACCESS_CHECK=0` turns the check off, after which such a list is back to normal once its fetch works; the other two signs of lost access still count. After the first run with the check on, any list that BattleMetrics does not list for CBL's token has been posted about, and is fetched but not swept until BattleMetrics lists it:

```sql
SELECT banList, lastError FROM BanListSyncs WHERE state = 'access_lost';
```

**CBL's own export ban lists.** Importing one of CBL's BattleMetrics export ban lists would feed the players CBL exports back in as new bans, which would keep them on the export ban lists. A list whose source is the BattleMetrics ID of any export ban list, compared as the bot compares them when a source is added, is never fetched or swept, and is posted about once. Its bans are kept as they are: the importer only removes a ban when the list's own complete fetch no longer has it, so removing these is left to an admin, with `/banlist remove`, which removes the list and its bans and queues their players for an update. The bot refuses such sources, but lists from before it, or changed by hand, may still have one; to list them:

```sql
SELECT banList, storedCount FROM BanListSyncs WHERE state = 'self_import';
```

A list whose type or source is changed, e.g. with `/banlist update`, starts afresh: what was known about its old source, such as its failures, is forgotten. A list's row is deleted with the list.

## Database tables

Besides the CBL's own tables, the importer owns `ImporterSchemaMigrations`, `ImporterState` and `BanListSyncs`. It makes them itself with its migrations (`src/schema/migrations.js`), which it applies once it holds the run lock, before its first step, and records in `ImporterSchemaMigrations`. The web server and the bot never make or change these tables, and the importer never changes the CBL's own tables' columns or indexes. A migration that fails makes the run fail with exit code 1, naming the migration. Going back to an older importer image leaves the tables in place, and the older importer ignores them.

| Migration            | What it makes                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `001-importer-state` | `ImporterSchemaMigrations` and `ImporterState`.                                             |
| `002-ban-list-syncs` | `BanListSyncs`, with a foreign key to `BanLists`, so a list's row is deleted with the list. |

A migration waits at most 3 seconds for a table that another connection is using, e.g. in a transaction left open, and while it waits, other queries on that table wait behind it: for `002`, the website's and the bot's queries on `BanLists`. If the wait runs out, the run fails, saying what to look for, and the next run tries again. Before deploying a version with a new migration, check that `SELECT * FROM information_schema.innodb_trx;` shows no long-running transactions.

`BanListSyncs` has one row for each ban list the importer has imported, or tried to:

| Column                           | What it holds                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banList`                        | The list, by `BanLists.id`.                                                                                                                                                                                   |
| `state`                          | `ok`, `failing`, `held`, `access_lost` or `self_import` (see [Ban list states](#ban-list-states)).                                                                                                            |
| `lastAttemptAt`, `lastSuccessAt` | When the list was last fetched, and when it was last fetched in full and its bans saved, in UTC.                                                                                                              |
| `consecutiveFailures`            | How many runs in a row the list failed to import.                                                                                                                                                             |
| `lastError`                      | Why its latest import failed, or why CBL cannot read it, which is kept while later runs cannot tell whether it can again: on one line, at most 500 characters, without addresses. Never shown on the website. |
| `storedCount`, `headTotal`       | The bans the list has here, and BattleMetrics' count of its bans when it was last fetched, or `NULL` for a remote list.                                                                                       |
| `sourceKey`                      | A SHA-256 of the list's type and source, by which the importer tells that its source was changed.                                                                                                             |
| `updatedAt`                      | When the row was last saved.                                                                                                                                                                                  |

Its other columns are not used yet. They are for later versions of the importer, which read only what changed on a list: `lastHeadPollAt`, `lastFullScanAt`, `nextFullScanAt`, `scanReason`, `incompleteScans`, `headUids`, `replacePending`, `allowFullRemovalUntil`, `remoteEtag`, `remoteLastModified` and `remoteBodyHash`.

```sql
SELECT banList, state, lastSuccessAt, consecutiveFailures, storedCount, headTotal, lastError FROM BanListSyncs ORDER BY banList;
```

## Settings

The importer reads the same `DATABASE_URI`, `BATTLEMETRICS_API_KEY`, `BATTLEMETRICS_ORGANIZATION`, `BATTLEMETRICS_API_RESERVOIR`, `STEAM_API_KEY`, `DISCORD_LOG_WEBHOOK` and `HOST` as the other services, and these of its own:

| Variable                      | Default | Description                                                                                                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMPORTER_MAX_RUN_SECONDS`    | `18000` | A run that takes longer stops at its next safe point, and exits at once 60 seconds later if it has not. Keep it shorter than the time between starts. |
| `IMPORTER_CADENCE_SECONDS`    | `21600` | How often the script starts a run, which sets when the importer is stale.                                                                             |
| `IMPORTER_ALLOW_MASS_REMOVAL` |         | Ban list IDs, separated by commas, that may lose any number of bans in the next run. Without it, a list that would lose many bans at once keeps them. |
| `IMPORTER_ACCESS_CHECK`       | `1`     | `0` turns off the check, once a run, of which BattleMetrics ban lists the CBL organisation can see (see [Ban list states](#ban-list-states)).         |
| `GIT_SHA`                     |         | The commit the image was built from, shown when a run starts and in its JSON line.                                                                    |
