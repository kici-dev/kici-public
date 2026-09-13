---
title: Orchestrator database backup and restore
description: Back up and restore the orchestrator's PostgreSQL state — run history, dispatch queue, and encrypted secrets — with kici-admin db backup / restore.
---

The orchestrator keeps its state in PostgreSQL: run history, the dispatch
queue, context bindings, and **encrypted** scoped secrets. Cluster _identity_
recovery is covered in
[cluster identity recovery](./cluster-identity-recovery.md); this page covers
the **state**.

## The master-key caveat (read first)

`kici-admin db backup` dumps the database, including the secret columns — but
those columns hold **ciphertext only**. They are encrypted with your
`KICI_SECRET_KEY`, which is **not** in the dump. A backup is therefore useless
on its own: to restore working secrets you must also have the same
`KICI_SECRET_KEY` that encrypted them.

**Back up `KICI_SECRET_KEY` separately** (in your secret manager / sealed env).
The dump records which key _generation_ it was taken under so `db restore` can
remind you which key is required.

## What is (and isn't) backed up

`db backup` dumps the orchestrator **PostgreSQL** database only — run history,
the dispatch queue, contexts, and encrypted secret ciphertext. Object storage
is **not** included and has its own durability lifecycle:

- **Cache** (compiled bundles, dependency cache) is regenerable — no backup
  needed.
- **Logs** (step output, webhook payloads) are best-effort.
- **Cold-store and provenance** rely on the object store's own
  durability/versioning, not this dump.

## Take a backup

```bash
kici-admin db backup --database-url "$KICI_DATABASE_URL"
# → writes ./kici-orchestrator-backup-<timestamp>.dump
#   and ./kici-orchestrator-backup-<timestamp>.dump.manifest.json
```

The `.dump` is a PostgreSQL custom-format archive (`pg_dump -Fc`); the sidecar
`.manifest.json` records the server version, key generation, and cluster id so
restore can pre-flight. Ship both files off-box with your existing backup
pipeline (object storage, rsync, …) — the command writes locally only.

`pg_dump` must be on `PATH` and its major version must be **>=** the server's.
Install the matching `postgresql-client` package if you see a version error.

## Schedule backups

`db backup` takes one dump. Install a timer so it runs every day:

```bash
kici-admin db backup --install-timer --name <instance>
# → installs kici-<instance>-db-backup and enables it
```

The scheduled run writes a timestamped dump into a retention directory and then
deletes the oldest dumps. It defaults to `<instance-dir>/backups` and keeps the
newest 7 dumps with their manifests.

| Flag                  | What it does                                        |
| --------------------- | --------------------------------------------------- |
| `--install-timer`     | Install and enable the scheduled backup, then exit. |
| `--uninstall-timer`   | Disable and remove the scheduled backup, then exit. |
| `--schedule <spec>`   | Calendar spec. Default `daily`.                     |
| `--output-dir <path>` | Directory for the timestamped dumps.                |
| `--keep <n>`          | Dumps to retain in that directory. Default 7.       |

The same `--output-dir` and `--keep` flags work on a plain `db backup` run, so
you can drive the retention directory from your own scheduler.

On **Linux with systemd**, KiCI writes a `.service` and a `.timer` unit.
`--schedule` accepts any systemd calendar expression, for example
`--schedule '*-*-* 02:30:00'`. The timer sets `Persistent=true`, so a backup
missed while the machine was off runs at the next boot.

On **macOS**, KiCI writes one launchd job with a calendar entry. launchd has no
calendar-expression parser, so `--schedule` accepts `daily` or a 24-hour
`HH:MM` time.

On **Windows** and on a **Compose** deployment, KiCI installs no timer and the
command exits with an error that names the alternative. Windows services carry
no timer concept — use Windows Task Scheduler:

```text
schtasks /Create /SC DAILY /TN kici-db-backup /TR "kici-admin db backup --output-dir <dir> --keep 7"
```

A Compose orchestrator runs in a container whose host scheduler KiCI does not
own — add a host cron entry that runs the same command.

## Backups taken by an upgrade

`kici-admin orchestrator upgrade` dumps the database before it changes
anything. The dump lands in the instance folder:

```text
<instance-dir>/backups/pre-upgrade-<from>-<to>-<ISO timestamp>.dump
```

Pass `--skip-backup` to opt out. The upgrade then prints a warning that it is
proceeding with no restore point.

The same master-key caveat applies: a pre-upgrade dump holds ciphertext only,
so keep `KICI_SECRET_KEY` outside it.

## Check backup freshness

```bash
kici-admin diagnose
# The "DB backup freshness" row is FAIL if no backup was ever recorded,
# WARN if the newest is older than the threshold (24h by default), PASS otherwise.
# FAIL and WARN both name `kici-admin db backup --install-timer` as the fix.
```

Tune the WARN threshold cluster-wide with the `KICI_BACKUP_STALENESS_WARN_HOURS`
environment variable, or per org at runtime:

```bash
kici-admin org-settings backup-freshness set --hours 12 --customer-id <org>
kici-admin org-settings backup-freshness reset --customer-id <org>   # back to the cluster default
```

The global check warns against the **strictest** per-org threshold, since a
stale whole-database backup affects every org.

## Restore "the box died"

The full sequence on a fresh box:

1. **Drain** the old orchestrator if it is still reachable:
   `kici-admin orchestrator drain` (or stop the service).
2. **Restore** the dump into the new box's database:

   ```bash
   kici-admin db restore --input ./kici-orchestrator-backup-<timestamp>.dump \
     --database-url "$KICI_DATABASE_URL"
   ```

   This is destructive (`pg_restore --clean`); it prompts for confirmation
   unless you pass `--yes`. It checks schema drift and reminds you about
   `KICI_SECRET_KEY`.

3. **Set `KICI_SECRET_KEY`** on the new box to the same value that encrypted the
   secrets, or the secret columns will not decrypt.
4. **Reconcile identity** so the restored `cluster_id` matches the durable
   sentinel in object storage:

   ```bash
   kici-admin cluster reconcile-identity
   ```

5. **Restart** the orchestrator and confirm it boots clean (`kici-admin diagnose`).
