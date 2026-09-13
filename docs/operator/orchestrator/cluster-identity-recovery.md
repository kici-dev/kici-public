---
title: Cluster identity recovery
description: Recover an orchestrator that refuses to start with a cluster identity mismatch by reconciling the database and the S3 sentinel.
---

> This page covers cluster **identity**. For backing up and restoring the
> orchestrator's **state** (run history, queue, encrypted secrets), see
> [orchestrator database backup and restore](./db-backup-restore.md).

An orchestrator that uses object storage for its cache stores a **cluster
identity sentinel** — a small file at `<prefix>/.kici-cluster-id` in the cache
bucket whose contents are the orchestrator's `cluster_id` (the `cluster_id` row
in the `cluster_meta` table of the orchestrator database). At startup the
orchestrator reads both and refuses to boot if they disagree:

```
Cluster identity mismatch: this orchestrator's database does not match the
target pool. DB cluster_id=<new>, S3 sentinel=<old>
(s3://<bucket>/<prefix>/.kici-cluster-id).
```

This split-brain guard exists so two orchestrators that accidentally share one
cache bucket but point at different databases cannot silently corrupt each
other's cache. The sentinel is the durable, cross-restart anchor: it is meant to
survive a database rebuild.

## When the two diverge

The mismatch surfaces when the database's `cluster_id` is regenerated while the
sentinel keeps the original value — most commonly when the orchestrator database
is recreated (a fresh database generates a new `cluster_id`) without the sentinel
being updated to match. The orchestrator then crash-loops on every restart and
cannot serve traffic.

## Recovering with `kici-admin cluster reconcile-identity`

`kici-admin cluster reconcile-identity` reconciles the two values. It talks to
the database and object storage **directly** — never through the orchestrator's
HTTP API — so it works while the orchestrator is down, which is exactly when it
is needed.

The default direction restores the **database from the durable sentinel** (the
sentinel is the cross-restart anchor a peer pool agrees on):

```bash
kici-admin cluster reconcile-identity \
  --database-url postgres://… \
  --bucket my-cache-bucket \
  --region eu-central-1
```

Pass `--prefix <prefix>` only if the orchestrator boots with a non-empty
`KICI_STORAGE_PREFIX`; when omitted the sentinel is read from the bucket root,
matching the orchestrator's default.

Flags and their environment fallbacks:

| Flag                   | Environment fallback                                | Meaning                                                 |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `--database-url <url>` | `KICI_DATABASE_URL`                                 | Orchestrator database connection string.                |
| `--bucket <bucket>`    | `KICI_STORAGE_BUCKET`                               | Cache bucket holding the sentinel.                      |
| `--prefix <prefix>`    | `KICI_STORAGE_PREFIX` (default empty = bucket root) | Storage prefix the orchestrator boots with. Must match. |
| `--region <region>`    | `KICI_STORAGE_REGION`                               | Object storage region.                                  |
| `--endpoint <url>`     | `KICI_STORAGE_ENDPOINT`                             | Custom object-storage endpoint.                         |
| `--force-path-style`   | `KICI_STORAGE_FORCE_PATH_STYLE`                     | Use path-style addressing.                              |

Object-storage credentials come from the standard `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` environment variables.

The command is safe to run repeatedly: it first **checks** whether the two
values already agree and exits without changing anything if they do. When they
differ it prints the change it would make and asks for confirmation before
writing. Two flags adjust that flow:

- `--dry-run` — print the drift and exit without changing anything.
- `--yes` — skip the confirmation prompt and apply on drift (for scripted
  recovery).

After it applies, restart the orchestrator and confirm it boots without the
mismatch error.

### Adopting the database value instead

If the divergence is intentional — you deliberately moved the orchestrator to a
new cluster or bucket and the **database** holds the value you want to keep —
pass `--adopt-db` to reverse the direction and rewrite the **sentinel from the
database**:

```bash
kici-admin cluster reconcile-identity --adopt-db --bucket my-cache-bucket
```

## Automatic reconciliation during staging deploys

KiCI's own staging deploy runs this reconciliation automatically before the
orchestrator starts: a fresh-database deploy pushes the sentinel to follow the
database (the database is authoritative), while a warm deploy whose database has
diverged from the durable sentinel restores the database from the sentinel — so
a pre-existing mismatch self-heals instead of crash-looping the deploy.
