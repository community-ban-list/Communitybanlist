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

| Field                  | What it holds                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `outcome`, `exitCode`  | How the run ended: `finished` (0), `failed` (1), `interrupted` (3) or `skipped` (75).                                          |
| `startedAt`, `endedAt` | When the run started and ended, in UTC, and `seconds` how long it took.                                                        |
| `gitSha`               | The commit the image was built from, from `GIT_SHA`, or `unknown` when that is not set.                                        |
| `reason`               | Why a run did not finish: the error, or why it stopped or was skipped.                                                         |
| `phase`                | The phase a run that did not finish was in, or had just finished when it stopped between two.                                  |
| `migrations`           | The importer migrations the run applied, if any, also when a later one failed.                                                 |
| `phases`               | How long each phase took, in seconds: waiting for the database, taking the run lock, connecting, migrations and each step.     |
| `counts`               | What the steps counted. `importBans` has the totals of its summary line and, in `banLists`, each list's own counts and errors. |

A run that held the run lock also saves its record in the database, in the importer's `ImporterState` table:

| Row                | What it holds                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `lastRun`          | The latest run's record, as its JSON line shows it.                                                   |
| `lastSuccessAt`    | When the latest successful run started: one that exited 0 and imported at least one ban list, if any. |
| `recentRuns`       | The latest 100 runs' records, oldest first, without per-list counts.                                  |
| `lastStaleAlertAt` | When the run, or the skipped start, that last posted that the importer is stale started.              |

```sql
SELECT name, updatedAt, value FROM ImporterState;
```

A run that never held the lock, e.g. one that was skipped or could not reach the database, only prints its line, except that a skipped start that posts that the importer is stale saves when it started, in `lastStaleAlertAt`. A run left waiting for something that can never happen, e.g. an answer on a connection that is gone, is ended as failed, and prints and saves its record. One ended at once by a second signal or 60 seconds after its time limit prints its line but has no time to save it. A run that is killed, e.g. by `docker rm -f` or for running out of memory, prints neither, and then only its exit code tells how it ended.

### Staleness

The importer is stale when no run has succeeded for 3 times `IMPORTER_CADENCE_SECONDS`, which is 18 hours by default. A run succeeds when it exits 0 and imports at least one ban list, so runs during a BattleMetrics outage, when every list fails, do not count. The importer then posts that it is stale to the log channel, and again every `IMPORTER_CADENCE_SECONDS` while it stays stale. It compares when runs started, so with a run every `IMPORTER_CADENCE_SECONDS`, the alert comes with the 3rd run in a row that does not succeed, however quickly the runs fail, and it allows 5 minutes, or a tenth of the cadence if that is less, for runs that start a little early or late. Set `IMPORTER_CADENCE_SECONDS` to how often the script starts a run.

Only the importer checks: at the end of every run that did not succeed, and whenever a start is skipped, as another run holds the lock. So while no run starts at all, nothing is posted. Whichever run or skipped start posts saves when it started, so no other posts again within the cadence.

### The log channel

The importer posts to `DISCORD_LOG_WEBHOOK` only what may need looking at: failures, removals held for confirmation, staleness, and the import's one summary line a run (`Got N deleted bans. Imported 20 ban lists: …`). Steps that take longer than a minute also show a progress bar. Everything else is only printed in the console.

## Database tables

Besides the CBL's own tables, the importer owns `ImporterSchemaMigrations` and `ImporterState`. It makes them itself with its migrations (`src/schema/migrations.js`), which it applies once it holds the run lock, before its first step, and records in `ImporterSchemaMigrations`. The web server and the bot never make or change these tables, and the importer never changes the CBL's own tables' columns or indexes. A migration that fails makes the run fail with exit code 1, naming the migration. Going back to an older importer image leaves the tables in place, and the older importer ignores them.

## Settings

The importer reads the same `DATABASE_URI`, `BATTLEMETRICS_API_KEY`, `BATTLEMETRICS_ORGANIZATION`, `BATTLEMETRICS_API_RESERVOIR`, `STEAM_API_KEY`, `DISCORD_LOG_WEBHOOK` and `HOST` as the other services, and these of its own:

| Variable                      | Default | Description                                                                                                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMPORTER_MAX_RUN_SECONDS`    | `18000` | A run that takes longer stops at its next safe point, and exits at once 60 seconds later if it has not. Keep it shorter than the time between starts. |
| `IMPORTER_CADENCE_SECONDS`    | `21600` | How often the script starts a run, which sets when the importer is stale.                                                                             |
| `IMPORTER_ALLOW_MASS_REMOVAL` |         | Ban list IDs, separated by commas, that may lose any number of bans in the next run. Without it, a list that would lose many bans at once keeps them. |
| `GIT_SHA`                     |         | The commit the image was built from, shown when a run starts and in its JSON line.                                                                    |
