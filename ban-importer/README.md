# CBL Ban Importer

Copies the bans of the partner ban lists into the CBL database and marks the bans whose expiry has passed as expired, then updates the Steam profiles, reputation points and ranks of the players, recalculates the export ban lists and sends their changes to BattleMetrics. One run does all of this and exits. The script that starts the importer runs it every 6 hours, and can run it as often as every 15 minutes (see [Running more often](#running-more-often)). Of each list's bans, only those that are new or changed are written (see [Importing a ban list](#importing-a-ban-list)), and a BattleMetrics list is read in full only every 30 minutes, or when it needs to be: otherwise only its newest page is read (see [Head polls and full reads](#head-polls-and-full-reads)).

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
  "endedAt": "2026-10-15T19:31:15.645Z",
  "seconds": 1853.67,
  "gitSha": "0e921bf",
  "phases": {
    "waitForDatabase": 0.02,
    "takeRunLock": 0.01,
    "connect": 0.84,
    "migrate": 0.05,
    "importBans": 521.3,
    "expireBans": 0.05,
    "updateSteamUserInfo": 81.4,
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
      "pending": 0,
      "moves": 0,
      "failedLists": 0,
      "selfImports": 0,
      "accessLost": 0,
      "headPolls": 19,
      "fullReads": 1,
      "accessCheck": "ok",
      "requests": { "head": 20, "follow": 0, "full": 117 },
      "banLists": [
        {
          "id": 46,
          "fetched": 11761,
          "new": 3,
          "updated": 1,
          "removed": 2,
          "held": 0,
          "read": "full",
          "reason": "drift",
          "drift": { "total": 11761, "expected": 11763 },
          "stored": 11760
        }
      ]
    },
    "expireBans": { "due": 4, "expired": 4, "players": 4 },
    "updateSteamUserInfo": {
      "due": 5243,
      "new": 31,
      "updated": 5238,
      "missing": 3,
      "skipped": 2,
      "unsaved": 0,
      "left": 0,
      "calls": 53
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

The steps that count what they do keep their counts also when they fail or stop part-way. The expiry and Steam steps start counting once their first read has worked, so one that fails before, e.g. as the database is unavailable, has no counts, rather than counts that say nothing was due:

| Step                  | Counts                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `importBans`          | The totals of its summary line, how many of its `lists` it `imported` and, in `banLists`, each list's own counts and errors.                                                                                                                                                                                                                                              |
| `expireBans`          | How many bans whose expiry has passed it found (`due`) and marked `expired`, and how many different `players` it queued for a recalculation.                                                                                                                                                                                                                              |
| `updateSteamUserInfo` | How many Steam users were `due` a refresh and, of those, how many were `new` (never refreshed, or queued for a refresh), how many it `updated`, how many Steam did not have (`missing`), how many it `skipped` as their IDs are not SteamIDs, how many profiles it could not save (`unsaved`), how many are `left` for later runs, and how many `calls` it made to Steam. |
| `updateExportBans`    | How many `players` it recalculated.                                                                                                                                                                                                                                                                                                                                       |
| `exportExportBans`    | How many export bans were `queued`, and of those, how many it `created` and `deleted`, and how many `failed`.                                                                                                                                                                                                                                                             |

`importBans` also counts the lists that import one of CBL's own export ban lists (`selfImports`) and those CBL can no longer read on BattleMetrics (`accessLost`), and says how the access check went (`accessCheck`: `ok`, `failed`, `off`, or `unused` when no BattleMetrics list was imported). Its `held` counts the bans the lists no longer have that were kept for now, of which `pending` wait for a later complete read of their list, and `moves` counts the bans whose player is no longer one of their SteamIDs (see [Importing a ban list](#importing-a-ban-list)). `headPolls` counts the lists of which only the newest bans were read and `fullReads` those read in full, and `requests` the BattleMetrics requests for pages of bans: for lists' newest pages (`head`), for the pages a poll followed after a list's newest page (`follow`), and for the other pages of lists read in full (`full`). A request the BattleMetrics client tried again counts once, and the access check's few requests are not counted (see [Head polls and full reads](#head-polls-and-full-reads)). A dry run's counts say what the import would have done, and it has `"dryRun": true`.

Each list in `banLists` says how it was read (`read`: `head` or `full`), and for a list read in full, why (`reason`, see [Head polls and full reads](#head-polls-and-full-reads)), with, for drift, BattleMetrics' count and the count expected (`drift`). It has its `state` when it is not `ok` (see [Ban list states](#ban-list-states)), and, when they apply: `pending`, `moves`, `hold` (`empty` or `full`, for removals that wait for an admin), `incomplete` (it was not read in full), `unchanged` (a remote list whose file has not changed), `replace` (its old source's bans are being replaced), `failedToSave`, `attempt`, `gone`, `sourceChanged`, `massRemoval`, and the `error` and the `stage` it failed at.

A run that held the run lock also saves its record in the database, in the importer's `ImporterState` table:

| Row                  | What it holds                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastRun`            | The latest run's record, as its JSON line shows it.                                                                                                 |
| `lastSuccessAt`      | When the latest successful run started: one that exited 0 and imported at least one ban list, if any.                                               |
| `recentRuns`         | The latest 100 runs' records, oldest first, without per-list counts.                                                                                |
| `lastStaleAlertAt`   | When the run, or the skipped start, that last posted that the importer is stale started.                                                            |
| `lastRunMessage`     | The ID of the latest run's status message in the log channel, and when that run started (see below).                                                |
| `steamRefreshCursor` | The ID of the last player due a Steam profile refresh that a run took, after which the next run carries on (see [Steam profiles](#steam-profiles)). |

```sql
SELECT name, updatedAt, value FROM ImporterState;
```

A run that never held the lock, e.g. one that was skipped or could not reach the database, only prints its line, except that a skipped start that posts that the importer is stale saves when it started, in `lastStaleAlertAt`. A run left waiting for something that can never happen, e.g. an answer on a connection that is gone, is ended as failed, and prints and saves its record. One ended at once by a second signal or 60 seconds after its time limit prints its line but has no time to save it. A run that is killed, e.g. by `docker rm -f` or for running out of memory, prints neither, and then only its exit code, and its status message in the log channel, tell how far it got.

### Staleness

The importer is stale when no run has succeeded for 3 times `IMPORTER_CADENCE_SECONDS`, which is 18 hours by default. A run succeeds when it exits 0 and imports at least one ban list, so runs during a BattleMetrics outage, when every list fails, do not count. The importer then posts that it is stale to the log channel, and again every `IMPORTER_CADENCE_SECONDS` while it stays stale. It compares when runs started, so with a run every `IMPORTER_CADENCE_SECONDS`, the alert comes with the 3rd run in a row that does not succeed, however quickly the runs fail, and it allows 5 minutes, or a tenth of the cadence if that is less, for runs that start a little early or late. Set `IMPORTER_CADENCE_SECONDS` to how often the script starts a run, as it also sets how many Steam profiles a run refreshes (see [Steam profiles](#steam-profiles)).

Only the importer checks: at the end of every run that did not succeed, and whenever a start is skipped, as another run holds the lock. So while no run starts at all, nothing is posted. Whichever run or skipped start posts saves when it started, so no other posts again within the cadence.

### The log channel

The importer posts to `DISCORD_LOG_WEBHOOK` one status message for each run, and otherwise only what may need looking at: failures, removals held for confirmation, invalid settings, dry runs and staleness, each as a message of its own. The import's totals appear in the status message; its summary line (`Got N deleted bans. Imported 20 ban lists: …`) is only printed in the console, with everything else.

As soon as a run holds the run lock, it posts its status, an embed, and keeps it up to date while it goes, editing it at most every 15 seconds. The embed shows that the run is in progress, in blurple, when it started, in each viewer's own time, how long it has taken, the commit it runs and any importer migrations it applied. Below them are the run's steps: each finished one with a tick, its time and what it counted, the one under way with how long it has taken and a bar of how far it has got, e.g. `18,250 / 145,155 players` or `7 / 20 ban lists`, and those still to run.

When the run ends, it edits the embed a last time, before it releases the lock, to show how it ended: finished in green, failed in red, lost its run lock in red, or stopped in orange, as it received `SIGTERM` or `SIGINT` or took longer than `IMPORTER_MAX_RUN_SECONDS`. The embed then shows how long the run took, each step's time and counts (the import's totals as in its summary line, with how many lists it only polled and read in full and the BattleMetrics requests that took, e.g. `20 ban lists: 2,061 bans fetched, 150 new, 0 updated, 0 removed, 0 held, 0 lists failed; 20 polled, 0 read in full, 21 BattleMetrics requests`, the bans marked expired, the Steam profiles updated and those left for later runs, the players recalculated, and the export bans created and deleted), and for a run that did not finish, the phase it ended in and why. A run that is skipped, or fails before it holds the lock, posts no status, only its failure line, if it failed.

Of the import's lines about each list, only those that need looking at are posted: a list that failed, or was not read in full, one whose bans are held for an admin, on every read of all of it while they are, one whose old source's bans are being replaced, one that lost bans as an admin allowed it, and one whose bans could not all be saved. A list whose missing bans wait for a later read, which needs nothing doing, only goes to the console, as do each new, changed or moved ban, each list that was only polled (`Polled ban list (ID: 46): …`), why a poll read a list in full after all, the BattleMetrics requests of the run, after its summary line, and a list that is not read in full again, after it was not in its last run either, as its first one was posted. In a dry run, every line about a list goes to the console.

A run whose last edit does not reach Discord leaves its embed saying it is in progress: one that was killed, ran out of memory, or was ended at once by a second signal or 60 seconds after its time limit, and one that ended as usual while Discord was down or refused the edit. So each run saves which message is its status in `ImporterState` (`lastRunMessage`), and the next run that holds the lock reads that message back and, if it still says it is in progress, corrects it, once, in the background. A run that saved its record is shown as it ended, drawn from its record, with a footer that says so. One that saved none ended without saying how, so it is marked as having ended without finishing, in red, keeping how far it had got.

Nothing the importer does waits for Discord: its messages are sent in the background, one request at a time, and at the end of a run for at most what is left of its 45 seconds. The status goes ahead of the other messages, so it is not dropped when Discord falls behind. Discord has 30 seconds to answer the status's post, and if it rate limits or fails the post, or does not answer it, the status is posted again 15 seconds later, so the run still gets one. If Discord refuses to edit it, e.g. as someone deleted it, or to post it, the run stops trying. Without `DISCORD_LOG_WEBHOOK`, or with one that is not a Discord webhook, nothing is posted.

Two kinds of embed can still say a run is in progress for good, as no later run knows of them: one Discord posted without answering within those 30 seconds, as the importer never learns which message it is and posts the status again, and one whose post Discord answered only once its run was ending, which the run does not save, should its final edit then not reach Discord.

## Ban list states

After each list's import, the importer saves how it went in the list's row of `BanListSyncs`, so the next runs know it too. The row is saved once the run knows how the import ended: right after it, or, for a list the run tries again after the others, or one CBL cannot read, once every list has been tried. A list is in one of these states:

| State         | What it means                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | Its latest import went as it should.                                                                                                                                                                                                                                                                                                                            |
| `failing`     | Its latest import failed, e.g. as its source was down, or it was not read in full. Its bans are kept as they are, but for any new or changed bans a read that was not complete found.                                                                                                                                                                           |
| `held`        | It was imported, but some of the bans it no longer has were kept for now: until a later complete read of it confirms they are gone, or, if it seems to have lost all its bans, until an admin confirms it or one of them comes back (see [Removing bans](#removing-bans)). A poll of its newest bans leaves it `held`, as a poll never checks for removed bans. |
| `access_lost` | CBL cannot read it on BattleMetrics, or BattleMetrics does not list it among the ban lists the CBL organisation can see. It is still fetched, and any new bans it gives are saved, but none of its bans are removed, even with `IMPORTER_ALLOW_MASS_REMOVAL`.                                                                                                   |
| `self_import` | Its source is one of CBL's own export ban lists. It is neither fetched nor swept.                                                                                                                                                                                                                                                                               |

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

A list whose type or source is changed, e.g. with `/banlist update`, starts afresh: what was known about its old source, such as its failures, is forgotten, and the bans of its old source are replaced by those of its new one (see [Removing bans](#removing-bans)). A list's row is deleted with the list.

## Importing a ban list

A list read in full is fetched in full, or not at all. Its stored bans are then read with one query and compared with the bans fetched, and only the bans that are new or changed are written: a ban's player, expiry, whether it has expired, its reason, raw reason and note are compared, a time by its milliseconds, `1` and `0` as true and false, and a missing note as `NULL`. So a run in which nothing changed writes no ban at all. The bans are written 500 at a time, each batch in one transaction, which adds the players that are new and queues the players of the new and changed bans for an update of their Steam profile, reputation and export bans. A batch that ends in a deadlock or a lock wait timeout is run again as a whole, after 5 seconds, for up to 5 attempts in all, as is one that finds the database unavailable. A batch that fails for another reason is written again one ban at a time, so only the bans that cannot be saved, e.g. one with a reason too long for its column, are left out: they are counted, and fetched again by the next run.

**SteamIDs.** A BattleMetrics ban's SteamIDs are its `steamID` identifiers that hold a SteamID64 of a player's account: exactly 17 digits, not part of a longer number, in the range of players' accounts, on their own or in a profile's address, with spaces around them or in any case, or else in the profile's details. A ban without one is skipped. A new ban is for the first SteamID an admin added to it by hand, or else its first. A ban that is stored keeps its player while that is still one of its SteamIDs, whatever their order. Once its player is no longer one of them, e.g. as its partner corrected the SteamID, the ban would move to the SteamID a new ban would be for. Such moves are only counted and logged, in the console and the run record's `moves`, until `IMPORTER_APPLY_STEAMID_MOVES=1` applies them, queueing both the old and the new player for an update. Meanwhile the ban's other changes are still saved.

**Read in full.** A BattleMetrics list is read by following its links to its last page, newest bans first (with head polls off, in BattleMetrics' own order, as before head polls), for at most as many pages as BattleMetrics' count of its bans needs, and 50 more. With the count check on (`IMPORTER_SCAN_COUNT_CHECK`, the default), the read is complete only if the number of different bans it read, with or without a SteamID, is no more than 2 short of BattleMetrics' count on its first page, plus however much that count changed by its last page. A read that found more bans than the count may be over it by that, and by 5 more, or 0.5% of the count if that is more: bans that were read cannot be missing, and one production list gives 3 more bans than its count on every read. Bans added or removed while a list is read change its count by little, so BattleMetrics' counts on the pages of one read may differ by at most 10, or 1% of the first page's count if that is more: a read whose counts differ by more, e.g. as a page counts no bans, is not complete either, as its count cannot be trusted. A read that is not complete still saves its new and changed bans, but removes none, and the list fails, so it is tried again after the other lists, and its row counts the incomplete read in `incompleteScans`. A list whose last run did not read it in full either is not tried again in the run, and its failure only goes to the console, as the first was posted and the alert for 3 failed runs in a row says if it lasts. A list that gives no bans on its first page but counts some has not emptied, whether the check is on or not: BattleMetrics answers so when CBL may see a list but not its bans (see [Ban list states](#ban-list-states)).

If BattleMetrics' count of one list stays off, `IMPORTER_SCAN_COUNT_CHECK_SKIP` can name it, to leave it out of the check: a list it names that is read to its last page counts as complete, and is read for up to 2,000 pages, whatever its count. A list that only gives a few more bans than its count needs no such setting. If BattleMetrics' counts stop matching its bans for every list, every list fails until `IMPORTER_SCAN_COUNT_CHECK=0` turns the check off for all of them.

**Remote lists.** A remote list's file is downloaded whole, with time and size limits. Once the list has been imported from a file in full, with nothing kept back, its row keeps the file's `ETag` and `Last-Modified`, if its host gives them, and its SHA-256. The next run asks the host whether the file has changed, with `If-None-Match` and `If-Modified-Since`, and an answer of `304 Not Modified`, or a file with the same SHA-256, means it has not: its bans are not written again, but whether each has expired is brought up to date. A list whose import failed, or kept any of its bans back, forgets its file, so the next run reads it in full, as does a list whose bans are being replaced.

### Head polls and full reads

A BattleMetrics list is read in full only when it needs to be. Otherwise only its newest page is read, 100 bans, newest first, with one request: a head poll. The poll saves the new and changed bans on the page, as a read in full does, but removes none, as only a read of every page can show that a ban is gone. A list's row keeps the IDs of the bans on its newest page, with or without a SteamID, and BattleMetrics' count of the list's bans, from its last read (`headUids`, `headTotal`), which its next poll compares its own with. A run that only polls makes one request a list, 20 for 20 lists, and takes seconds.

A list is read in full, rather than polled, for the first of these reasons that applies, which its `reason` in the run record gives, and lists are read in this order: those only polled first, so their new bans are saved within seconds of the start, then those read in full, by the order of their reasons.

| Reason      | When                                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new`       | It has not been read in full from its current source yet, or its row has no newest page to poll against, e.g. as it was last read with head polls off.                                                                                                                                                |
| `source`    | Its type or source was changed, so its old source's bans are being replaced.                                                                                                                                                                                                                          |
| `removal`   | Bans it no longer had wait for a confirming read, and the first of them is due, 10 minutes after the read that first missed it, or an admin allowed it to lose bans: `IMPORTER_ALLOW_MASS_REMOVAL` names it, or its row's `allowFullRemovalUntil` has not passed while it has bans held for an admin. |
| `drift`     | A poll found that BattleMetrics' count of its bans is not its count at its last read plus the new bans on the pages the poll read.                                                                                                                                                                    |
| `overflow`  | A poll found only new bans on 10 pages.                                                                                                                                                                                                                                                               |
| `periodic`  | Its next full read is due (`nextFullScanAt`), or its last one (`lastFullScanAt`) is older than `IMPORTER_FULL_SCAN_MINUTES`.                                                                                                                                                                          |
| `every_run` | Head polls are off (`IMPORTER_HEAD_POLL=0`), so every list is read in full on every run.                                                                                                                                                                                                              |
| `remote`    | It is a remote list, whose file is asked about on every run.                                                                                                                                                                                                                                          |

**Drift.** Bans added on top of a list add as much to BattleMetrics' count as to the new bans on its newest page, so a count that differs from the one at the list's last read plus the new bans means that something else happened: a ban was removed, from the newest page or below it, or added or moved below it, e.g. as it was backdated. The list is then read in full in the same run, on from the newest page, which is not read again, and the bans the poll found new are saved first. A ban counts as new when it is neither stored nor among the newest page's IDs at the last read, and the IDs and counts are BattleMetrics' own, with or without a SteamID, so bans without one, which are never stored, make no false drift. An edit to a ban below the newest page, and a removal that a backdated addition cancels out between two runs, wait for the list's next periodic full read. `IMPORTER_DRIFT=0` keeps the polls but stops comparing the counts, for a time when BattleMetrics' counts cannot be trusted: removed bans are then found only by the periodic full reads, so make those more frequent, e.g. with `IMPORTER_FULL_SCAN_MINUTES=15`.

**Bursts and overflow.** A poll whose newest page holds only bans it has not seen follows the list's pages, newest first, until a page holds one it has, so a burst of new bans, e.g. 150, is saved with a request a page and nothing else. After 10 pages of new bans, the list is read in full instead, on from the pages the poll read (overflow), as so many new bans can mean the list was replaced. A list whose newest page, or the pages a poll followed, reach its last page has been read in full by its poll, so a list of 100 bans or fewer is read in full on every run, with one request.

**Schedule.** A list read in full is next due `IMPORTER_FULL_SCAN_MINUTES` later, 30 minutes by default, less up to a fifth of that at random, so lists read in full together come due spread over 6 minutes: its row keeps when in `nextFullScanAt`, with `scanReason` `periodic`. When bans it no longer had wait for a confirming read, it is due when the first of them can be confirmed, 10 minutes after the read, with `scanReason` `removal`. A list whose read in full fails stays due one. A poll that found drift or overflow, when the list then cannot be read in full, leaves the list due at once, with that reason, so the next run reads it in full, and so does the run's own second attempt at it. A list whose last full read is older than `IMPORTER_FULL_SCAN_MINUTES` is read in full however its row was scheduled, so runs further apart than that, such as every 6 hours, read every list in full on every run, as before head polls; polls only save requests when runs are closer together (see [Running more often](#running-more-often)).

`IMPORTER_HEAD_POLL=0` turns polls off: every list is read in full on every run, in BattleMetrics' own order, as before head polls, and its row forgets its newest page, so once polls are on again each list is read in full once more first. With both `IMPORTER_HEAD_POLL` and `IMPORTER_DRIFT` off, the importer reads every list as it did before head polls.

### Removing bans

Bans are removed only after a complete read of their list, never after a poll of its newest bans, while the run holds its run lock, and never from a list CBL cannot read, or one that imports a CBL export ban list. The bans the list had before the read that the read did not find are missing, and then:

- With `IMPORTER_ALLOW_MASS_REMOVAL` naming the list, or while an admin allows it to lose all its bans (its row's `allowFullRemovalUntil` is a time that has not passed), every missing ban is removed at once.
- A read that found no bans at all, while the list has some, keeps them all, as the list may be broken, and so does a read that found none of the bans of a list of at least 10. The list is `held`, and its line, posted on every run while it is, says to confirm with `IMPORTER_ALLOW_MASS_REMOVAL`. An admin can also allow it in the database, here for two hours: `UPDATE BanListSyncs SET allowFullRemovalUntil = UTC_TIMESTAMP(3) + INTERVAL 2 HOUR WHERE banList = <id>;`
- A list held as its read found none of its bans, though it found others, has its bans recorded in `BanListPendingRemovals` as held, from when that began (`heldAt`). The bans the read found are still saved, so the list then has other bans too, but it stays held, and its line says since when, until an admin confirms it, which removes the held bans, or until a complete read finds one of them again. The held bans still missing then wait for a later complete read, as if first missing then, by the rule below, as they do when the list's source is replaced. Of the bans the list saved meanwhile, those it no longer has are removed by the rule below.
- Otherwise, fewer than 10 missing bans, and 5% of the list's bans, are removed at once. More are recorded in `BanListPendingRemovals`, and kept, until a complete read at least 10 minutes after the first one that did not have them still does not, when they are removed. The list is due that read 10 minutes after the first, so with runs 10 minutes or more apart, that is the next run, and until then it is only polled. A recorded ban that a read finds again loses its record, and when fewer than 10, and 5% of the list, would still wait, they are removed at once.

Each batch of at most 500 bans is removed in one transaction, which also queues their players for an update and drops their records in `BanListPendingRemovals`. Bans that are new or changed are never kept back.

**Replaced sources.** A list whose type or source was changed since it was last imported, e.g. by hand in phpMyAdmin, may still have its old source's bans. Its new source's bans replace them: they are removed by the rules above, but never held for an admin, though the list seems to have lost them all. Its row's `replacePending` says that the replace is under way, until none of the old bans is left. `/banlist update` deletes the old bans itself, so its lists have none to replace. A list whose type or source is changed while it is being imported has the bans fetched from its old source removed, and its new source is imported on the next run.

**Dry runs.** With `IMPORTER_DRY_RUN=1`, a run reads what any run would, polling the lists that are not due a full read, and writes nothing: no ban, player, record of a missing ban or `BanListSyncs` row, and it runs none of the other steps, as they all write. As it saves no row, the next run reads and polls the lists as if it had not run. Its counts, in its summary line, status and record, say what the import would have done, and the console has a line for each ban it would add, change, move or remove, up to 100 of each for each list. It posts that it is a dry run, so one left on by mistake is seen, but nothing about the lists. It still takes the run lock, applies the importer's migrations and saves its run record, but never counts as a success for the stale alert. An invalid value, e.g. `0 # done` (`docker run --env-file` keeps a comment after the value), fails the run, with exit code 1, before it imports anything, as it cannot tell whether it may write.

## Expired bans

Whether a ban has expired is stored with it, in `Bans.expired`, which the export ban lists and the website's active and expired bans read. The import sets it for the bans it fetches, but the bans of a list it does not fetch, e.g. as its source is failing or it imports a CBL export ban list, would otherwise stay active for as long as that lasts, and a ban that expires after its list was fetched stays active until the next run fetches it. So after the import, the run marks as expired every ban whose expiry has passed but that is not marked expired (`0` or `NULL`), whatever its list. One read, which locks nothing, finds them, and each batch of 500 is marked in one transaction, which also queues the bans' players for a recalculation of their reputation points and rank and their export bans, by setting their `lastRefreshedReputationPoints`, `lastRefreshedReputationRank` and `lastRefreshedExport` to `NULL`, but not for a refresh of their Steam profile, as their bans did not change. A ban changed since the read is left as it is. A batch that ends in a deadlock or a lock wait timeout, or finds the database unavailable, is run again as a whole, after 5 seconds, as the import's batches are. A dry run does not mark any, as it writes nothing.

The expiries are compared with the time the step starts, given in UTC, as the importer writes every time in UTC, so the comparison is right whatever the time zone of the database or of the connection. In a session in the server's own zone, e.g. `SYSTEM` on a host in Chicago, `NOW()` would be 5 or 6 hours behind, and the bans that expired in that time would not count as expired yet; Sequelize sets the importer's own connections to UTC. To count the bans the next run will mark:

```sql
SELECT COUNT(*) FROM Bans WHERE (expired = 0 OR expired IS NULL) AND expires <= UTC_TIMESTAMP();
```

## Steam profiles

Each run refreshes the Steam profiles, the names, profile addresses and avatars, of the players who were never refreshed, or were queued for a refresh as their bans changed, the newest first, as the export ban lists' alerts name the players they add. After them, it refreshes players whose profile is due a refresh, in the order of their IDs, carrying on after the last one the run before took, which `ImporterState` keeps as `steamRefreshCursor`, and from the first again once it has reached the last. A profile is due a refresh 7 days after its last one, give or take a day: each player has their own interval, from 6 days up to 8, which comes from their ID (`6 days + CRC32(id) % 172800 seconds`), so the players refreshed in the same run fall due over two days, rather than all in one run week after week.

A run refreshes at most `IMPORTER_STEAM_REFRESH_PER_RUN` players due a refresh, and 300 new players besides. When there are more new players, e.g. after a ban list was added, they also take the slots of the players due a refresh, so a run refreshes up to 300 plus `IMPORTER_STEAM_REFRESH_PER_RUN` new players; the slots new players leave unused are not given to players due a refresh. Unless it is set, `IMPORTER_STEAM_REFRESH_PER_RUN` is worked out each run from the number of players and `IMPORTER_CADENCE_SECONDS`: enough to refresh every player within the shortest interval, 6 days, with a run every `IMPORTER_CADENCE_SECONDS`. That is about 15% more than intervals of 6 to 8 days need, so the players Steam leaves out, and those a run could not take, e.g. as Steam was down, are caught up on. For about 145,000 players it is about 6,050 a run every 6 hours (61 calls, about a minute and a half), 1,010 every hour and 250 every 15 minutes. It is at least 200, so that runs a minute or two apart still catch up quickly, and at most 10,000. So keep `IMPORTER_CADENCE_SECONDS` at how often runs really start. The console says how many a run takes (`taking at most 6046 due a refresh a run`), and once runs have caught up, the Steam profiles in the run's status show few or none `left for later runs`.

Steam is asked for 100 players a call, and each call's profiles are saved with one statement, which updates the players' rows and marks them refreshed, and never adds a row for a player removed in the meantime. A player Steam leaves out of its answer, e.g. as the account no longer exists, is tried again a day later rather than on every run: it is marked refreshed a day less than its interval ago, e.g. 6 days ago for a player refreshed every 7 days, and keeps its name. A player whose ID is not a SteamID64 of a player's account, e.g. one saved before SteamIDs were checked, is never sent to Steam: it is skipped and marked as looked at, so it comes up again only once its interval has passed. A profile that cannot be saved, e.g. as its name holds a character the table's character set cannot store, is left out, as the call's other profiles are saved again one at a time; it is tried again a day later, and the run posts how many profiles could not be saved, with the first error.

A call that fails, or is answered without a list of players, is posted with its error, and its players stay as they were, so they are taken again: the new ones as new, and the next run carries on from before the first of those due a refresh. Once 2 calls in a row have failed, the step stops, as Steam is then most likely down, and it stops at once when Steam refuses the API key, or still answers HTTP 429 after the Steam client's own retries and pauses. Nothing waits between calls but the Steam client's limit of one request every 1.5 seconds, and each request has 15 seconds to be answered.

## Database tables

Besides the CBL's own tables, the importer owns `ImporterSchemaMigrations`, `ImporterState`, `BanListSyncs` and `BanListPendingRemovals`. It makes them itself with its migrations (`src/schema/migrations.js`), which it applies once it holds the run lock, before its first step, and records in `ImporterSchemaMigrations`. The web server and the bot never make or change these tables, and the importer never changes the CBL's own tables' columns or indexes. A migration that fails makes the run fail with exit code 1, naming the migration. Going back to an older importer image leaves the tables in place, and the older importer ignores them.

| Migration                       | What it makes                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001-importer-state`            | `ImporterSchemaMigrations` and `ImporterState`.                                                                                                                               |
| `002-ban-list-syncs`            | `BanListSyncs`, with a foreign key to `BanLists`, so a list's row is deleted with the list.                                                                                   |
| `003-ban-list-pending-removals` | `BanListPendingRemovals`, with a foreign key to `BanLists`, and a ban's ID with the type, character set and collation of `Bans.id`, which it refers to without a foreign key. |

A migration waits at most 3 seconds for a table that another connection is using, e.g. in a transaction left open, and while it waits, other queries on that table wait behind it: for `002` and `003`, the website's and the bot's queries on `BanLists`. If the wait runs out, the run fails, saying what to look for, and the next run tries again. Before deploying a version with a new migration, check that `SELECT * FROM information_schema.innodb_trx;` shows no long-running transactions.

`BanListSyncs` has one row for each ban list the importer has imported, or tried to:

| Column                                               | What it holds                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banList`                                            | The list, by `BanLists.id`.                                                                                                                                                                                   |
| `state`                                              | `ok`, `failing`, `held`, `access_lost` or `self_import` (see [Ban list states](#ban-list-states)).                                                                                                            |
| `lastAttemptAt`, `lastSuccessAt`                     | When the list was last fetched, and when it was last fetched in full and its bans saved, in UTC.                                                                                                              |
| `consecutiveFailures`                                | How many runs in a row the list failed to import.                                                                                                                                                             |
| `lastError`                                          | Why its latest import failed, or why CBL cannot read it, which is kept while later runs cannot tell whether it can again: on one line, at most 500 characters, without addresses. Never shown on the website. |
| `storedCount`, `headTotal`                           | The bans the list has here, and BattleMetrics' count of its bans when it was last fetched, or `NULL` for a remote list. A poll's count is saved once the bans on the list's newest page are.                  |
| `lastHeadPollAt`, `headUids`                         | When the list's newest page was last read, by a poll or a read in full, and its bans saved, in UTC, and the IDs of the bans on it, with or without a SteamID, as JSON, which the next poll compares with.     |
| `lastFullScanAt`                                     | When the list was last read in full, in UTC.                                                                                                                                                                  |
| `nextFullScanAt`, `scanReason`                       | When the list is next due to be read in full, in UTC, and why: `periodic`, `removal`, `drift` or `overflow` (see [Head polls and full reads](#head-polls-and-full-reads)).                                    |
| `incompleteScans`                                    | How many reads of all of the list in a row were not complete.                                                                                                                                                 |
| `sourceKey`                                          | A SHA-256 of the list's type and source, by which the importer tells that its source was changed.                                                                                                             |
| `replacePending`                                     | Whether the bans of the list's old source are still being replaced by those of its new source.                                                                                                                |
| `allowFullRemovalUntil`                              | Until when the list may lose all of its bans at once, as an admin confirmed, in UTC. The importer only reads it.                                                                                              |
| `remoteEtag`, `remoteLastModified`, `remoteBodyHash` | For a remote list, the `ETag`, `Last-Modified` and SHA-256 of the file it was last imported from in full, with nothing kept back.                                                                             |
| `updatedAt`                                          | When the row was last saved.                                                                                                                                                                                  |

To have a list read in full on the next run, e.g. after fixing something by hand: `UPDATE BanListSyncs SET nextFullScanAt = UTC_TIMESTAMP(3) WHERE banList = <id>;`

`BanListPendingRemovals` has a row for each ban that a complete read of its list no longer had, which waits for a later complete read to confirm that it is gone, or for an admin, as its list seemed to have lost all its bans (see [Removing bans](#removing-bans)): its list (`banList`), its ID (`banId`), when a complete read first and last did not have it (`firstMissingAt`, `lastMissingAt`), and, for a ban held for an admin, when that began (`heldAt`), in UTC. A list's rows are deleted with the list.

```sql
SELECT banList, COUNT(*), MIN(firstMissingAt), COUNT(heldAt), MIN(heldAt) FROM BanListPendingRemovals GROUP BY banList;
```

```sql
SELECT banList, state, lastSuccessAt, consecutiveFailures, storedCount, headTotal, lastError FROM BanListSyncs ORDER BY banList;
SELECT banList, lastHeadPollAt, lastFullScanAt, nextFullScanAt, scanReason FROM BanListSyncs ORDER BY nextFullScanAt;
```

## Settings

The importer reads the same `DATABASE_URI`, `BATTLEMETRICS_API_KEY`, `BATTLEMETRICS_ORGANIZATION`, `BATTLEMETRICS_API_RESERVOIR`, `STEAM_API_KEY`, `DISCORD_LOG_WEBHOOK` and `HOST` as the other services, and these of its own:

| Variable                         | Default | Description                                                                                                                                                                                                    |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMPORTER_MAX_RUN_SECONDS`       | `18000` | A run that takes longer stops at its next safe point, and exits at once 60 seconds later if it has not. Keep it shorter than the time between starts.                                                          |
| `IMPORTER_CADENCE_SECONDS`       | `21600` | How often the script starts a run, which sets when the importer is stale and how many Steam profiles a run refreshes (see [Steam profiles](#steam-profiles)).                                                                                                |
| `IMPORTER_ALLOW_MASS_REMOVAL`    |         | Ban list IDs, separated by commas, that may lose any number of bans at once in the next run, once they are read in full (see [Removing bans](#removing-bans)). Remove a list from it once its removal is done. |
| `IMPORTER_ACCESS_CHECK`          | `1`     | `0` turns off the check, once a run, of which BattleMetrics ban lists the CBL organisation can see (see [Ban list states](#ban-list-states)).                                                                  |
| `IMPORTER_SCAN_COUNT_CHECK`      | `1`     | `0` turns off the check that a read of a BattleMetrics list found as many bans as BattleMetrics counts on it (see [Importing a ban list](#importing-a-ban-list)).                                              |
| `IMPORTER_SCAN_COUNT_CHECK_SKIP` |         | Ban list IDs, separated by commas, that the count check leaves out, for a list whose count BattleMetrics keeps getting wrong. Remove a list from it once its count is right again.                             |
| `IMPORTER_APPLY_STEAMID_MOVES`   | `0`     | `1` moves a ban whose player is no longer one of its SteamIDs to another of them. Until then such moves are only counted and logged.                                                                           |
| `IMPORTER_HEAD_POLL`             | `1`     | `0` turns head polls off, so every list is read in full on every run, in BattleMetrics' own order, as before head polls (see [Head polls and full reads](#head-polls-and-full-reads)).                         |
| `IMPORTER_DRIFT`                 | `1`     | `0` stops polls comparing BattleMetrics' count of a list's bans with its count at its last read and the new bans, so removed bans are only found by the periodic full reads.                                   |
| `IMPORTER_FULL_SCAN_MINUTES`     | `30`    | How often each BattleMetrics list is read in full, in minutes, less up to a fifth at random: a whole number from 1 to 10080 (a week).                                                                          |
| `IMPORTER_STEAM_REFRESH_PER_RUN` |         | How many players due a Steam profile refresh a run refreshes, at most: `0` to `10000`. Not set, or invalid, with a warning, it is enough to refresh all within 6 days at `IMPORTER_CADENCE_SECONDS`, at least `200` (see [Steam profiles](#steam-profiles)). |
| `IMPORTER_DRY_RUN`               | `0`     | `1` makes the run read what it would, write nothing and say what the import would change. It runs no other step.                                                                                               |
| `GIT_SHA`                        |         | The commit the image was built from, shown when a run starts and in its JSON line.                                                                                                                             |

The switches are on with `1`, `true`, `on` or `yes`, and off with `0`, `false`, `off` or `no`, in any case, with spaces or one pair of quotes around them, which `docker run --env-file` keeps. An invalid value of `IMPORTER_ACCESS_CHECK`, `IMPORTER_SCAN_COUNT_CHECK`, `IMPORTER_APPLY_STEAMID_MOVES`, `IMPORTER_HEAD_POLL` or `IMPORTER_DRIFT` is taken as the safer choice, with a warning posted to the log channel: the checks stay on, no ban is moved, polls still compare BattleMetrics' counts, and head polls are off, so every list is read in full. An invalid `IMPORTER_FULL_SCAN_MINUTES` is taken as 30, with a warning too. An invalid `IMPORTER_DRY_RUN` fails the run before it imports anything (see the dry runs in [Removing bans](#removing-bans)), as either choice could be the wrong one.

### Deploying the version that writes only what changed

Its first run applies migration `003`. Then:

1. Run once with `IMPORTER_DRY_RUN=1`. The new and updated bans should be near zero, as the import compares what its old versions wrote. Its removals are the bans the lists really lost since the last run, and the moves, in the console and `moves`, are bans whose player is no longer one of their SteamIDs. `SELECT COUNT(*) FROM SteamUsers WHERE id NOT REGEXP '^[0-9]{17}$';` counts the players with malformed IDs from before SteamIDs were checked. Check its summary line for failed lists, and the console for lists that were not read in full (`while checking that it was read in full`), which a dry run does not post: a list whose BattleMetrics count stays off would fail every run, so leave it out of the count check with `IMPORTER_SCAN_COUNT_CHECK_SKIP`, rather than turning the check off for every list.
2. Set `IMPORTER_DRY_RUN=0`, or remove it, and run as usual, with writes on and `IMPORTER_APPLY_STEAMID_MOVES=0`.
3. Once the moves have been reviewed, set `IMPORTER_APPLY_STEAMID_MOVES=1`.

A list that the previous version held, as it would have lost at least 25 bans and 10% of them at once, is no longer waiting for `IMPORTER_ALLOW_MASS_REMOVAL`: its missing bans are recorded on the first run, and removed by the next one that still does not find them, unless it seems to have lost all of its bans. The dry run counts them as held.

Going back to the previous image returns to its rules: a list's missing bans are removed at once, unless they reach 25 bans and 10% of the list, which wait for `IMPORTER_ALLOW_MASS_REMOVAL`. The new table stays, and the older importer ignores it.

### Deploying the version that marks expired bans and budgets Steam profiles

Nothing needs to be set: each run works out how many Steam profiles to refresh from `IMPORTER_CADENCE_SECONDS`, so keep that at how often runs start, e.g. `3600` once they start every hour. The first run may mark many bans expired, those of lists that were not fetched for a while, and queue their players. Within a day, the Steam profiles in the run's status should show few or none `left for later runs`. If `IMPORTER_STEAM_REFRESH_PER_RUN` is set instead, e.g. to keep the Steam step short, about `6100` keeps about 145,000 players refreshed weekly with a run every 6 hours, and about `1000` with a run every hour.

Going back to the previous image brings back its Steam step, which refreshes in one run every player not refreshed for 7 days: a few thousand after runs of this version, which adds a few minutes to that run, and more, for longer, if `IMPORTER_STEAM_REFRESH_PER_RUN` was set lower than the schedule needs. The bans this version marked expired stay marked.

### Deploying head polls

The version with head polls needs no migration. Its first run reads every list in full, newest first, as no list has a newest page to poll against yet, and takes as long as a run did before. On the 6-hour schedule, every run then still reads every list in full, as each list's last full read is older than `IMPORTER_FULL_SCAN_MINUTES`; polls start to save requests once runs are closer together (see below). A list that gives a few more bans than BattleMetrics counts, as list 80 does, now passes the count check, so it can be removed from `IMPORTER_SCAN_COUNT_CHECK_SKIP`.

Going back to the previous image reads every list in full on every run again. It leaves the columns this version fills as they are, and ignores them.

### Running more often

Runs can start every 15 minutes, as every run that holds the run lock reads in full only the lists that are due:

1. Set `IMPORTER_CADENCE_SECONDS=900`, so the importer is stale after 45 minutes without a successful run.
2. Set `IMPORTER_MAX_RUN_SECONDS=840`, so a run that is slow stops before the next one starts. A start while a run still holds the lock is skipped anyway (see [Running it](#running-it)).
3. Have the script start a run every 15 minutes.

Each list is then read in full about every other run, as its next full read is due 24 to 30 minutes after its last, and polled in between. Runs 15 minutes apart are too far apart for that random fifth to spread the lists' full reads over different runs, so a run that reads them in full takes about as long as a run every 6 hours does, while one that only polls takes seconds, with 20 requests: about 1,800 BattleMetrics requests an hour, 30 a minute on average. A new ban on top of a list reaches CBL within one run, a ban removed from a list within one run too, by drift, or two when many are removed at once and wait for a confirming read, and an edit to a ban below a list's newest page within 30 minutes. So does a ban's expiry, as a ban is marked expired when it is read, which for a ban below its list's newest page is the list's next full read. Runs an hour apart still read every list in full on every run, as each list is due a full read each time, unless `IMPORTER_FULL_SCAN_MINUTES` is longer than an hour.
