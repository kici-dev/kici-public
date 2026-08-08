---
title: Upgrade and rollback
description: Safe upgrade order for orchestrators and agents, version-skew behavior, database migration semantics, and how to roll back each deployment shape
---

Every KiCI package ships at a single shared version, so "upgrading KiCI" means
moving the orchestrator and agents to the same new release. This page is the
upgrade runbook for both deployment shapes — the container image and the native
service install.

## Before you upgrade

- Read the release notes for the target version so you know what changed.
- Snapshot your PostgreSQL database with your standard tooling first. Migrations
  are forward-only, so the snapshot is your only path back to an older version
  after a migration has applied.

## Safe order: orchestrator first, then agents

Upgrade the orchestrator first, then the agents.

- **Ephemeral scaler-spawned agents** update themselves on the next spawn once
  you update the image reference in the scaler label-set config and reload — each
  new agent pulls the new image.
- **Long-lived installed agents** are upgraded with `kici-admin agent upgrade`.

On version skew: the orchestrator enforces a protocol-version floor during the
agent handshake and rejects any agent below it. The agent also reports its
application version, but that is display metadata only — nothing warns or rejects
on an application-version mismatch. Running the orchestrator and agents on the
same release is the supported configuration; transient skew while a rolling
upgrade is in flight is expected and tolerated.

## Drain before upgrading

Restarting an orchestrator to upgrade it severs the WebSocket connection to any
agent currently running a job. To avoid that, **drain the orchestrator first**:
draining stops it from dispatching any new job while letting the jobs already
running on agents finish. When no jobs are running the orchestrator is quiesced
and safe to restart.

```bash
# Stop new dispatches and block until in-flight jobs finish, then upgrade.
kici-admin orchestrator drain --wait && \
  kici-admin orchestrator upgrade
```

- `kici-admin orchestrator drain` flips the orchestrator into draining and prints
  `draining=true jobsRunning=<n>`. New webhooks still ingest and match — the
  resulting jobs are held as Pending in the durable queue rather than sent to an
  agent.
- `--wait` polls until `jobsRunning` reaches 0 (quiesced), then exits `0`. It
  exits `2` if the wait times out with jobs still running (default timeout 300s,
  tune with `--timeout <seconds>`), and `1` on error — so the `&&` chain above
  only proceeds to the upgrade once the orchestrator is genuinely idle.
- A run that is mid-flight **pauses across the upgrade**: its next jobs stay
  Pending until the fresh orchestrator comes back up, which automatically
  re-dispatches the held backlog through its normal startup recovery. No work is
  lost.
- Draining is in-memory only. A restart (the upgrade) comes back accepting new
  jobs and immediately drains the Pending backlog — there is no drain flag to
  clear afterwards.
- To abort a drain without restarting (resume dispatching), run
  `kici-admin orchestrator resume`. Check the current state any time with
  `kici-admin orchestrator drain --status`.

Draining requires the same orchestrator-admin authentication as the other
`kici-admin` orchestrator-plane commands (an admin API key of the `owner` or
`admin` role).

## Database migrations run at startup

On boot the orchestrator applies any pending schema migrations automatically.
Disable this with `KICI_AUTO_MIGRATE=false` if you prefer to run migrations
out of band. In a multi-orchestrator cluster a PostgreSQL advisory lock ensures
exactly one instance migrates while the others wait, so a rolling restart never
races the schema.

Migrations are forward-only — there is no down-migration. Inspect applied
migrations with `kici-admin db migrate --status` and detect schema drift with
`kici-admin db check-schema`.

## Upgrading each deployment shape

### Container / compose

Bump the pinned `quay.io/kici-dev/kici-orchestrator` tag or digest and redeploy.
Published version tags are immutable, so a given tag never changes underneath
you. Do the same for the agent image referenced in the scaler config.

### Native service install

Use `kici-admin orchestrator upgrade` and `kici-admin agent upgrade`. Both use a
versioned directory layout with an atomic symlink flip, and previous versions
are preserved on disk. See
[Service installation](./distribution/service-installation.md) for the full
command reference.

## Rolling back

- **Native service install** — `kici-admin orchestrator upgrade --rollback`
  returns to the previous installed version (it requires at least two installed
  versions). `--pick` selects any installed version interactively, and
  `--cleanup` keeps the current and previous versions while pruning older ones.
- **Container / compose** — re-pin the previous immutable image tag or digest
  and redeploy. There is no rollback subcommand for image deployments.

Rolling the software back does not roll the database schema back. Migrations are
forward-only, so an older orchestrator running against a newer schema is
unsupported. To return to a pre-migration state, restore the database snapshot
you took before the upgrade.

## Software rollback is not config rollback

`kici-admin config rollback --to N` rewinds the shared orchestrator configuration
history and is unrelated to the software version. See
[Config management](./orchestrator/config-management.md) for that workflow.

## See also

- [Service installation](./distribution/service-installation.md) — native service upgrade command reference.
- [Config management](./orchestrator/config-management.md) — configuration history and rollback.
- [Network requirements](./network-requirements.md) — outbound allowlist and inbound surface.
- [kici-admin CLI reference](./orchestrator/kici-admin-cli.md) — full admin command reference.
