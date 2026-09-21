---
title: Configuration reference
description: The environment variables the orchestrator starts from, the YAML and shared DB stores and which surfaces read them, and multi-provider setup
---

> **See also:** [Environment variable reference](../env-reference.md) — shared env vars; orchestrator-specific vars are listed below. Regenerate the generated table with `pnpm docs:env`. Unknown `KICI_*` env vars cause the orchestrator to refuse to start (typo catcher); set `KICI_DEV=true` for warn-only behaviour during local development.

The orchestrator starts from environment variables. Two other configuration stores exist — a local YAML file (`orchestrator.yaml`) and a shared PostgreSQL config store (the `config_versions` table) — and each is read by specific surfaces rather than by the startup path. This page says which surface reads which store. The scaler configuration (`scalers.yaml`) is a separate file with its own loader.

## Overview

### The orchestrator starts from the environment

`server.js` and `standalone.js` build their startup configuration from `KICI_*` environment variables alone. No YAML file and no database row takes part. A setting that must be in effect when the process starts must be an environment variable.

The startup schema lives in `packages/orchestrator/src/config.ts`. The [env var reference](#environment-variable-reference-orchestrator-specific) below is generated from it, so it is the authoritative list of names and defaults.

### Which surface reads which store

| Store                          | Read by                                                                                                                                                                                                                               | Not read by                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `KICI_*` environment variables | orchestrator startup, every `kici-admin` command that loads the startup config, the reload path, and `kici-admin scaler`                                                                                                              | --                                    |
| Local YAML                     | the reload path, `kici-admin config diff`, and `kici-admin scaler`                                                                                                                                                                    | orchestrator startup                  |
| Shared DB                      | `kici-admin config seed`, `set`, `delete`, `export`, `diff`, `history` and `rollback`; `kici-admin rotate-key`; and `kici-admin join`, which copies `storage` and `secrets.key` into the env file the joining orchestrator boots from | orchestrator startup, the reload path |
| Built-in defaults              | every surface, each against its own schema                                                                                                                                                                                            | --                                    |

Environment variables win over YAML values on the reload path, and YAML values win over defaults. `kici-admin scaler` reverses the first rule: it prefers `scaler.configPath` / `scaler.configDir` from the YAML file and falls back to `KICI_SCALER_CONFIG_PATH` / `KICI_SCALER_CONFIG_DIR`.

Two source files define the configuration surface, and which one answers your question depends on the shape of the setting. `packages/orchestrator/src/config.ts` holds the flat startup schema behind `loadConfig()` — every setting the orchestrator can start with, including the `KICI_INGEST_*` admission controls, `KICI_DB_POOL_*`, and the reroute and global-eval timings. `packages/orchestrator/src/config/schema.ts` holds the YAML and shared-DB schemas and the merged schema the reload path validates — go there for anything written as a nested config path (`queue.maxDepth`, `cluster.role`, `storage.bucket`).

### What a reload changes

A reload re-reads the environment and the local YAML file, validates the merge, and swaps in the result. Trigger it with SIGHUP, with `POST /admin/config/reload`, or with `kici-admin config reload`.

A reload does not restart the process, so it reaches only what the running orchestrator re-reads afterwards:

- `queue.backpressureThreshold` — the queue-depth warning threshold, re-read on every measurement tick.
- The response of `kici-admin config get`.
- The config version each instance advertises to its cluster peers.
- The scaler configuration, re-read from the path the process started with.

`database.url`, `server.port`, `instance.id` and `storage` are held at their startup values and named in a warning. Every other setting keeps the value the process started with until you restart it.

## Local config file

The local config file holds per-instance settings for the surfaces that read it: the reload path, `kici-admin config diff`, and `kici-admin scaler`. The orchestrator does not read it at startup, so a value set only here has no effect until you trigger a reload — and only for the settings a reload reaches. Set anything else as an environment variable.

The surfaces that read the file look for it at `/etc/kici/orchestrator.yaml`. Set `KICI_CONFIG=/path/to/orchestrator.yaml` to point them somewhere else, or pass `--config /path/to/orchestrator.yaml` to `kici-admin scaler reap-orphans`. `KICI_CONFIG` selects the file; it does not make the orchestrator read it at startup.

If no file exists at that path, the surfaces that read it fall back to an empty local config. The file is optional.

### Full annotated example

```yaml
# /etc/kici/orchestrator.yaml
# Read by the reload path, `kici-admin config diff`, and `kici-admin scaler`.
# The orchestrator does not read this file at startup — see "Which surface
# reads which store" above.

# Database connection (required)
database:
  url: 'postgresql://kici:s3cur3pass@postgres:5432/kici'

# Instance settings
instance:
  # Unique identifier for this orchestrator instance.
  # Default: auto-generated random UUID.
  id: 'orch-west-1'

  # Operating mode: platform | hybrid | observed | independent
  # - platform (default): WS to Platform relay only; rejects direct webhooks.
  #     Requires platform.url + platform.token (or KICI_PLATFORM_URL + KICI_PLATFORM_TOKEN).
  # - hybrid: Platform relay + direct per-source webhook ingestion (deduplicated).
  #     Requires Platform credentials. Per-source webhook secrets live in the
  #     orchestrator DB (kici-admin source add ...) — there is no global
  #     webhook-secret env var.
  # - observed: direct per-source webhook ingestion only, but keeps the Platform
  #     connection for the hosted dashboard. No webhook ever transits KiCI.
  #     Requires Platform credentials AND KICI_WEBHOOK_PUBLIC_URL. GitHub-App
  #     sources are refused (they are relay-only) — use generic/local sources.
  # - independent: standalone, direct per-source webhook ingestion only.
  #     Different entry point (`standalone.js`). Per-source secrets in DB.
  # Mode is optional — defaults to "platform" — but the credentials the mode
  # requires must be present at startup or the orchestrator refuses to boot.
  # See operator/orchestrator/getting-started.md#four-deployment-modes for the
  # full picture.
  mode: 'hybrid'

# HTTP server settings
server:
  # Port to listen on (default: 4000)
  port: 4000

  # URL prefix for all routes (default: "/")
  basePath: '/'

  # Log level: debug | info | warn | error (default: info)
  logLevel: 'info'

  # Path to TLS certificate (PEM) for the expiry diagnostic check.
  # Optional — when set, /diagnostics reports cert validity and expiry.
  # tlsCertPath: '/etc/ssl/certs/kici.pem'

# Auto-scaler configuration file paths
scaler:
  # Path to the main scalers.yaml config file
  configPath: '/etc/kici/scalers.yaml'

  # Directory for scalers.d/ drop-in configs
  configDir: '/etc/kici/scalers.d/'
```

### Local config fields

| Field                | Type   | Default         | Description                                                     |
| -------------------- | ------ | --------------- | --------------------------------------------------------------- |
| `database.url`       | string | (required)      | PostgreSQL connection URL                                       |
| `instance.id`        | string | `<random-UUID>` | Unique orchestrator instance ID                                 |
| `instance.mode`      | enum   | `platform`      | Operating mode: `platform`, `hybrid`, `observed`, `independent` |
| `server.port`        | number | `4000`          | HTTP server listen port                                         |
| `server.basePath`    | string | `/`             | URL prefix for all routes                                       |
| `server.logLevel`    | enum   | `info`          | Log level: `debug`, `info`, `warn`, `error`                     |
| `server.tlsCertPath` | string | --              | Path to TLS cert (PEM) for expiry diagnostic                    |
| `scaler.configPath`  | string | --              | Path to `scalers.yaml`                                          |
| `scaler.configDir`   | string | --              | Path to `scalers.d/` directory                                  |

## Environment variables

Every config field has a `KICI_`-prefixed environment variable. The mapping uses underscore-separated uppercase paths:

### Database connection pool

The orchestrator holds a bounded PostgreSQL connection pool for its hot path
(dispatch, heartbeat persistence, job completion). Three env vars tune it:

| Env var                           | Default | Purpose                                                                                                                               |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_DB_POOL_MAX`                | 20      | Maximum concurrent Postgres connections. Size it to the peak concurrent hot-path operations per coordinator process.                  |
| `KICI_DB_POOL_ACQUIRE_TIMEOUT_MS` | 5000    | How long a caller waits for a free connection before failing fast. Prevents callers from queueing forever when the pool is saturated. |
| `KICI_DB_STATEMENT_TIMEOUT_MS`    | 30000   | Aborts a single query that runs longer than this, so one runaway statement can't hold a connection indefinitely.                      |

Raising `KICI_DB_POOL_MAX` lets more hot-path operations run concurrently at the
cost of more open connections against Postgres — keep the sum across all
coordinator processes comfortably under the database's `max_connections`.

### Environment variable reference (orchestrator-specific)

Variables shared across KiCI services and the logger live in the
[environment variable reference](../env-reference.md). The orchestrator-specific
variables, with type/default/required metadata generated from the config schema:

<!-- BEGIN GENERATED: orchestrator-env (do not edit; run the doc generator) -->

| Env var                                                | Required | Default                   | Type                                         | Aliases | Description                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------- | ------------------------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_AUTH`                                      | no       | "token"                   | enum:token\|none                             |         |                                                                                                                                                                                                                                             |
| `KICI_AGENT_BINARY_SOURCE`                             | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_AGENT_MAX_RECONNECT_DELAY_MS`                    | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_AGENT_TOKEN_TTL_MS`                              | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ARTIFACT_MAX_BYTES`                              | no       | 1073741824                | number                                       |         | Cluster-wide default max size (bytes) of a single user-facing artifact tarball (1 GiB). A per-org override in org_settings.artifact_max_bytes (set via `kici-admin org-settings artifacts set-max-bytes`) takes precedence when present.    |
| `KICI_ARTIFACT_MAX_PER_RUN`                            | no       | 50                        | number                                       |         | Cluster-wide default max number of user-facing artifacts a single run may upload (50). A per-org override in org_settings.artifact_max_per_run (set via `kici-admin org-settings artifacts set-max-per-run`) takes precedence when present. |
| `KICI_ARTIFACT_QUOTA_BYTES`                            | no       | 21474836480               | number                                       |         | Cluster-wide default per-org byte quota for user-facing artifacts (ctx.artifacts). A per-org override in org_settings.artifact_quota_bytes (set via `kici-admin org-settings artifacts set-quota`) takes precedence when present.           |
| `KICI_ARTIFACT_TTL_MS`                                 | no       | 2592000000                | number                                       |         | Cluster-wide default per-artifact TTL (ms) for user-facing artifacts. A per-org override in org_settings.artifact_ttl_ms (set via `kici-admin org-settings artifacts set-ttl`) takes precedence when present.                               |
| `KICI_AUDIT_RETENTION_DAYS`                            | no       | 365                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_AUTO_MIGRATE`                                    | no       | "true"                    | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_BACKUP_STALENESS_WARN_HOURS`                     | no       | 24                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_BASE_PATH`                                       | no       | "/"                       | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_BOOTSTRAP_ADMIN_TOKEN`                           | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CACHE_BUILD_TIMEOUT_MS`                          | no       | 600000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CACHE_MAX_TARBALL_BYTES`                         | no       | 524288000                 | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CACHE_TTL_DAYS`                                  | no       | 30                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CHECK_RUN_TRACKING_TTL_DAYS`                     | no       | 7                         | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_ADDRESS`                                 | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_COORDINATOR_URL`                         | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_COORDINATOR_URLS`                        | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_CREDENTIAL_FILE`                         | no       | "~/.kici/peer-credential" | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_ELECTION_GRACE_PERIOD_MS`                | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_INSTANCE_HEARTBEAT_MS`                   | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_INSTANCE_ID`                             | no       | "<computed>"              | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_JOIN_TOKEN`                              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_NAME`                                    | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS`              | no       | 30000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS`             | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`                   | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEERS`                                   | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS`            | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS`            | no       | 5000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_RAFT_HEARTBEAT_MS`                       | no       | 2000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_ROLE`                                    | no       | "coordinator"             | enum:coordinator\|worker                     |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_SETTINGS_CACHE_TTL_MS`                   | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_SINGLE_NODE`                             | no       | false                     | union                                        |         |                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_TRUSTED_PROXIES`                         | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CONTENT_CACHE_MAX`                               | no       | 500                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CONTENT_CACHE_MAX_BYTES`                         | no       | 67108864                  | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_CONTENT_CACHE_TTL_MS`                            | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DASHBOARD_URL`                                   | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DATA_DIR`                                        | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DATABASE_URL`                                    | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DB_POOL_ACQUIRE_TIMEOUT_MS`                      | no       | 5000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DB_POOL_MAX`                                     | no       | 20                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DB_STATEMENT_TIMEOUT_MS`                         | no       | 30000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DEV_IDENTITY_KEY_FILE`                           | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DISPATCH_ACK_TIMEOUT_MS`                         | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_DISPATCH_QUEUE_TTL_DAYS`                         | no       | 30                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES`                     | no       | 5242880                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS`                | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_EVENT_TTL_SECONDS`                  | no       | 604800                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_LEASE_DURATION_MS`                  | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH`                    | no       | 10                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_MAX_DISPATCH_ATTEMPTS`              | no       | 5                         | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` | no       | 100                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_RETRY_BASE_BACKOFF_MS`              | no       | 5000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_RETRY_MAX_BACKOFF_MS`               | no       | 300000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_RETRY_SCAN_INTERVAL_MS`             | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS`             | no       | 86400000                  | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GLOBAL_EVAL_CACHE_MAX`                           | no       | 500                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS`                | no       | 20000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GLOBAL_EVAL_ROUND_TIMEOUT_MS`                    | no       | 120000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GLOBAL_EVAL_WAIT_TIMEOUT_MS`                     | no       | 240000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_GLOBAL_WORKFLOWS_ENABLED`                        | no       | false                     | union                                        |         |                                                                                                                                                                                                                                             |
| `KICI_HELD_RUN_RETENTION_DAYS`                         | no       | 90                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_HOST`                                            | no       | "0.0.0.0"                 | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_HOST_REBOOT_DEADLINE_MS`                         | no       | 900000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INDEPENDENT_IDENTITY`                            | no       | "false"                   | enum:true\|false                             |         |                                                                                                                                                                                                                                             |
| `KICI_INDEPENDENT_SECRETS`                             | no       | "false"                   | enum:true\|false                             |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_CODEL_INTERVAL_MS`                        | no       | 100                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_CODEL_TARGET_MS`                          | no       | 50                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_LOOP_LAG_RESUME_MS`                       | no       | 150                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_LOOP_LAG_SAMPLE_MS`                       | no       | 100                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_LOOP_LAG_SHED_MS`                         | no       | 200                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_MAX_CONCURRENCY`                          | no       | 256                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_MAX_QUEUE_DEPTH`                          | no       | 1000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_ORG_MAX_CONCURRENCY`                      | no       | 32                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_CLAIM_TIMEOUT_MS`                | no       | 900000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_ENABLED`                         | no       | "true"                    | enum:true\|false                             |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_MAX`                             | no       | 5000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_MAX_AGE_MS`                      | no       | 900000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_MAX_ATTEMPTS`                    | no       | 10                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_REPLAY_BATCH`                    | no       | 50                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_OVERFLOW_REPLAY_INTERVAL_MS`              | no       | 2000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_INGEST_QUEUE_MAX_WAIT_MS`                        | no       | 3000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOCK_FILE_MAX_BYTES`                             | no       | 5242880                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOCKFILE_CACHE_MAX`                              | no       | 500                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOCKFILE_CACHE_MAX_BYTES`                        | no       | 67108864                  | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOCKFILE_CACHE_TTL_MS`                           | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES`                 | no       | 1048576                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_LOG_STORAGE_SEGMENT_FLUSH_MS`                    | no       | 2000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_MACHINE_LEDGER_DIR`                              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_MAX_FANOUT_HOSTS`                                | no       | 1024                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_MAX_GITHUB_PAYLOAD_BYTES`                        | no       | 26214400                  | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_MODE`                                            | no       | "platform"                | enum:platform\|hybrid\|independent\|observed |         |                                                                                                                                                                                                                                             |
| `KICI_ORCH_RECONNECT_REPLAY_WINDOW_HOURS`              | no       | 24                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_HOST_AGENT_ID`                      | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_KMS_ACCESS_KEY_ID`                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_KMS_KEY_ARN`                        | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_KMS_REGION`                         | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_KMS_SECRET_ACCESS_KEY`              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_PROVENANCE_ISSUER`                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_SIGNER_COMMAND`                     | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_SIGNER_KIND`                        | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ORCHESTRATOR_URL`                                | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_OWNERSHIP_DB_CHECK_TIMEOUT_MS`                   | no       | 5000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_PG_CUSTOMER_SECRETS`                             | no       | "true"                    | enum:true\|false                             |         |                                                                                                                                                                                                                                             |
| `KICI_PLATFORM_TOKEN`                                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_PLATFORM_URL`                                    | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_PORT`                                            | no       | 4000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_PROVENANCE_ISSUER`                               | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_PROVENANCE_RETENTION_DAYS`                       | no       | 365                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_QUEUE_BACKPRESSURE_THRESHOLD`                    | no       | 100                       | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_QUEUE_MAX_DEPTH`                                 | no       | 1000                      | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_QUEUE_TIMEOUT_MS`                                | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_REROUTE_ACK_TIMEOUT_MS`                          | no       | 15000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_REROUTE_FLAP_GRACE_MS`                           | no       | 120000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_REROUTE_MAX_HOPS`                                | no       | 3                         | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_REROUTE_SPAWN_WINDOW_MS`                         | no       | 90000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ROSTER_GRACE_MS`                                 | no       | 300000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_ROSTER_TTL_MS`                                   | no       | 1800000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_RUN_RETENTION_DAYS`                              | no       | 90                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_CLAIM_RETENTION_MS`                       | no       | 3600000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_CONFIG_DIR`                               | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_CONFIG_PATH`                              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_PENDING_SWEEP_INTERVAL_MS`                | no       | 10000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_PROVISION_BACKOFF_BASE_MS`                | no       | 30000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_PROVISION_BACKOFF_MAX_MS`                 | no       | 900000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_PROVISION_MAX_CONSECUTIVE_FAILURES`       | no       | 5                         | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_REAP_INTERVAL_MS`                         | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_REAP_REATTEMPT_INTERVAL_MS`               | no       | 600000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_REAP_STRANDED_TIMEOUT_MS`                 | no       | 1800000                   | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SCALER_SPAWN_TIMEOUT_MS`                         | no       | 300000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SECRET_KEY`                                      | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SECRET_KEY_FILE`                                 | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SECRET_KEY_FILE_OLD`                             | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SECRET_KEY_OLD`                                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_SERVER_TLS_CERT_PATH`                            | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STALE_DETECTOR_SCAN_INTERVAL_MS`                 | no       | 60000                     | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER`             | no       | 2                         | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STEP_LOG_TTL_DAYS`                               | no       | 90                        | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_BUCKET`                                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_ENDPOINT`                                | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_EXTERNAL_ENDPOINT`                       | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_FORCE_PATH_STYLE`                        | no       |                           | enum:true\|false                             |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_FS_BASE_URL`                             | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_FS_PATH`                                 | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_LOG_BUCKET`                              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_PATH`                                    | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_PREFIX`                                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_REGION`                                  | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_TYPE`                                    | no       |                           | enum:s3\|filesystem                          |         |                                                                                                                                                                                                                                             |
| `KICI_STORAGE_UPLOAD_ENDPOINT`                         | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_UNROUTABLE_GRACE_MS`                             | no       | 120000                    | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_USER_CACHE_QUOTA_BYTES`                          | no       | 5368709120                | number                                       |         | Cluster-wide default per-org byte quota for the user-facing cache (ctx.cache). A per-org override in org_settings.user_cache_quota_bytes (set via `kici-admin org-settings user-cache set-quota`) takes precedence when present.            |
| `KICI_USER_CACHE_TTL_MS`                               | no       | 604800000                 | number                                       |         | Cluster-wide default per-entry TTL (ms) for the user-facing cache. A per-org override in org_settings.user_cache_ttl_ms (set via `kici-admin org-settings user-cache set-ttl`) takes precedence when present.                               |
| `KICI_WEBHOOK_DEDUP_TTL_MS`                            | no       | 86400000                  | number                                       |         |                                                                                                                                                                                                                                             |
| `KICI_WEBHOOK_PAYLOAD_DIR`                             | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_WEBHOOK_PUBLIC_URL`                              | no       |                           | string                                       |         |                                                                                                                                                                                                                                             |
| `KICI_WORKER_CONCURRENCY`                              | no       | 5                         | number                                       |         |                                                                                                                                                                                                                                             |
| `NODE_ENV`                                             | no       | "development"             | enum:development\|production\|test           |         |                                                                                                                                                                                                                                             |

> **Not shown above:** the `KICI_COLD_STORE_*` family (consumed directly by `cold-store/orchestrator-cold-store.ts`, registered in `COLD_STORE_ENV_VARS` so the typo catcher allows them but not part of the Zod schema). For the full storage env-var inventory plus prefix layout, see [orchestrator storage layout](storage-layout.md).

<!-- END GENERATED: orchestrator-env -->

### Direct mappings

These are the names the reload path's overlay maps onto YAML config paths. Most of them are startup variables too, and the generated table above lists those. Seven are not, and setting one of them in the orchestrator's own environment stops the service from starting — the typo check rejects it and names the startup variable to set instead:

| Overlay-only name                      | Startup name               |
| -------------------------------------- | -------------------------- |
| `KICI_SERVER_PORT`                     | `KICI_PORT`                |
| `KICI_SERVER_BASE_PATH`                | `KICI_BASE_PATH`           |
| `KICI_SERVER_LOG_LEVEL`                | `KICI_LOG_LEVEL`           |
| `KICI_INSTANCE_ID`                     | `KICI_CLUSTER_INSTANCE_ID` |
| `KICI_INSTANCE_MODE`                   | `KICI_MODE`                |
| `KICI_NODE_ENV`                        | `NODE_ENV`                 |
| `KICI_CLUSTER_AUTO_ROTATE_CREDENTIALS` | none                       |

`cluster.autoRotateCredentials` has no startup variable and no reader, so it holds its default of `false` and setting it changes nothing.

The overlay also accepts the startup names for the three settings whose spelling differs: `KICI_PORT`, `KICI_BASE_PATH` and `KICI_MODE` map to `server.port`, `server.basePath` and `instance.mode`. That is what lets an orchestrator configured entirely from environment variables reload without reverting to the defaults for those settings. When both spellings are set, the startup name wins, so a reloaded value can never disagree with the one the process booted with.

The `KICI_STORAGE_*`, `KICI_ROSTER_*` and `KICI_CLUSTER_COORDINATOR_URLS` rows are startup-only: `loadConfig()` reads them and the overlay does not map them, so on a reload their config path takes the YAML value or the default. That changes nothing in practice — `storage` is held at its startup value, and the roster and coordinator settings keep the value the process started with until you restart it.

| Env Var                                                | Config Path                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_DATABASE_URL`                                    | `database.url`                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_SERVER_PORT`                                     | `server.port`                               | Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `KICI_SERVER_BASE_PATH`                                | `server.basePath`                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_SERVER_LOG_LEVEL`                                | `server.logLevel`                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_SERVER_TLS_CERT_PATH`                            | `server.tlsCertPath`                        | Path to TLS cert (PEM) for expiry diagnostic                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `KICI_INSTANCE_ID`                                     | `instance.id`                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_INSTANCE_MODE`                                   | `instance.mode`                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_SCALER_CONFIG_PATH`                              | `scaler.configPath`                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_SCALER_CONFIG_DIR`                               | `scaler.configDir`                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_PLATFORM_URL`                                    | `platform.url`                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_PLATFORM_TOKEN`                                  | `platform.token`                            | Sensitive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_AGENT_AUTH`                                      | `agentAuth`                                 | Default: `token`. `token` or `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `KICI_AGENT_TOKEN_TTL_MS`                              | `agentTokenTtlMs`                           | Default: `3600000` (1h). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KICI_ROSTER_GRACE_MS`                                 | `rosterGraceMs`                             | Default: `300000` (5m). Coerced to number. Host roster: static grace before a disconnected static host reads as unreachable. Cluster-wide default                                                                                                                                                                                                                                                                                                                                                   |
| `KICI_ROSTER_TTL_MS`                                   | `rosterTtlMs`                               | Default: `1800000` (30m). Coerced to number. Host roster: ephemeral GC TTL — past this a disconnected ephemeral host is reaped. Cluster-wide default                                                                                                                                                                                                                                                                                                                                                |
| `KICI_QUEUE_MAX_DEPTH`                                 | `queue.maxDepth`                            | Default: `1000`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KICI_QUEUE_TIMEOUT_MS`                                | `queue.timeoutMs`                           | Default: `3600000` (1h). Coerced to number. How long a job can wait in the dispatch queue before expiring. Set to `0` for indefinite. Also configurable via admin CLI: `kici-admin config set queue.timeoutMs <ms>`                                                                                                                                                                                                                                                                                 |
| `KICI_QUEUE_BACKPRESSURE_THRESHOLD`                    | `queue.backpressureThreshold`               | Default: `100`. Coerced to number. Pending-depth threshold that triggers the operator-facing `queue.backpressure.sustained` warn log after two consecutive refresher ticks (~10s). `0` disables the warner (Prometheus `kici_orch_dispatch_queue_depth` gauge and Grafana panel alert continue unaffected). Also configurable via admin CLI: `kici-admin config set queue.backpressureThreshold <n>`                                                                                                |
| `KICI_LOCKFILE_CACHE_MAX`                              | `lockfileCache.max`                         | Default: `500`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `KICI_LOCKFILE_CACHE_TTL_MS`                           | `lockfileCache.ttlMs`                       | Default: `3600000` (1h). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KICI_LOCKFILE_CACHE_MAX_BYTES`                        | `lockfileCache.maxBytes`                    | Default: `67108864` (64 MiB). Coerced to number. Bounds the lock-file cache by total bytes in addition to entry count; whichever limit trips first evicts. Cluster-wide (the cache is process-global, not per-tenant)                                                                                                                                                                                                                                                                               |
| `KICI_STALE_DETECTOR_SCAN_INTERVAL_MS`                 | `staleDetector.scanIntervalMs`              | Default: `60000` (1m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER`             | `staleDetector.thresholdMultiplier`         | Default: `2`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_JOB_HEARTBEAT_INTERVAL_MS`                       | `staleDetector.heartbeatIntervalMs`         | Default: `60000` (1m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_SECRET_KEY`                                      | `secrets.key`                               | Sensitive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_SECRET_KEY_FILE`                                 | `secrets.keyFile`                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_BOOTSTRAP_ADMIN_TOKEN`                           | `secrets.bootstrapAdminToken`               | Sensitive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_WEBHOOK_PAYLOAD_DIR`                             | `webhookPayloadDir`                         | Optional. Directory path where the orchestrator fire-and-forget writes every processed webhook payload to disk as `<dir>/<repoIdentifier>/<deliveryId>/payload.json`. Leave unset to disable the on-disk archive.                                                                                                                                                                                                                                                                                   |
| `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES`                     | `eventLog.maxPayloadBytes`                  | Default: `5242880` (5 MB). Soft cap for the inbound webhook delivery log (`event_log` table). Oversized payloads are recorded with `payload_omitted=true` rather than 413'd; the metadata + hash + size are still durable. Payloads below the cap are gzipped + uploaded to the existing `LogStorage` adapter at `event-log/<orgId>/<deliveryId>.json.gz`. Row retention is managed by the cold-store sweeper (see `KICI_COLD_STORE_EVENT_LOG_*` env vars) rather than a separate retention window. |
| `KICI_CACHE_TTL_DAYS`                                  | `cacheTtlDays`                              | Default: `30`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `KICI_CACHE_BUILD_TIMEOUT_MS`                          | `cacheBuildTimeoutMs`                       | Default: `600000` (10m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KICI_CACHE_MAX_TARBALL_BYTES`                         | `cacheMaxTarballBytes`                      | Default: `524288000` (500MB). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_USER_CACHE_QUOTA_BYTES`                          | `userCacheQuotaBytes`                       | Default: `5368709120` (5 GiB). Coerced to number. Cluster-wide default per-org byte quota for the user-facing cache (`ctx.cache`); a per-org override in `org_settings.user_cache_quota_bytes` takes precedence when present                                                                                                                                                                                                                                                                        |
| `KICI_USER_CACHE_TTL_MS`                               | `userCacheTtlMs`                            | Default: `604800000` (7d). Coerced to number. Cluster-wide default per-entry TTL for the user-facing cache; a per-org override in `org_settings.user_cache_ttl_ms` takes precedence when present                                                                                                                                                                                                                                                                                                    |
| `KICI_STORAGE_TYPE`                                    | `storage.type`                              | `s3` or `filesystem`. `s3` additionally requires `KICI_STORAGE_BUCKET`; `filesystem` requires an absolute `KICI_STORAGE_FS_PATH`                                                                                                                                                                                                                                                                                                                                                                    |
| `KICI_STORAGE_BUCKET`                                  | `storage.bucket`                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_STORAGE_PREFIX`                                  | `storage.prefix`                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_STORAGE_REGION`                                  | `storage.region`                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_STORAGE_ENDPOINT`                                | `storage.endpoint`                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_STORAGE_EXTERNAL_ENDPOINT`                       | `storage.externalEndpoint`                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_STORAGE_FORCE_PATH_STYLE`                        | `storage.forcePathStyle`                    | Coerced to boolean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KICI_STORAGE_LOG_BUCKET`                              | `storage.logBucket`                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_PG_CUSTOMER_SECRETS`                             | `pgCustomerSecrets`                         | Coerced to boolean. Default: `true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `KICI_CLUSTER_JOIN_TOKEN`                              | `cluster.joinToken`                         | Sensitive, one-time use for first join                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `KICI_CLUSTER_CREDENTIAL_FILE`                         | `cluster.credentialFile`                    | Default: `~/.kici/peer-credential`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_AUTO_ROTATE_CREDENTIALS`                 | `cluster.autoRotateCredentials`             | Coerced to boolean. Default: `false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `KICI_CLUSTER_ADDRESS`                                 | `cluster.address`                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_INSTANCE_ID`                             | `cluster.instanceId`                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_PEERS`                                   | `cluster.peers`                             | Comma-separated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS`            | `cluster.raftElectionTimeoutMinMs`          | Default: `5000`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS`            | `cluster.raftElectionTimeoutMaxMs`          | Default: `10000`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `KICI_CLUSTER_RAFT_HEARTBEAT_MS`                       | `cluster.raftHeartbeatMs`                   | Default: `2000`. Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS`              | `cluster.peerHeartbeatIntervalMs`           | Default: `30000` (30s). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS`             | `cluster.peerMaxReconnectDelayMs`           | Default: `60000` (1m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_CLUSTER_ROLE`                                    | `cluster.role`                              | Default: `coordinator`. `coordinator` or `worker`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `KICI_CLUSTER_COORDINATOR_URL`                         | `cluster.coordinatorUrl`                    | Workers require this or `KICI_CLUSTER_COORDINATOR_URLS`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_COORDINATOR_URLS`                        | `cluster.coordinatorUrls`                   | Comma-separated. Multi-coordinator worker: connects to every listed coordinator; takes precedence over `KICI_CLUSTER_COORDINATOR_URL` when both are set                                                                                                                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`                   | `cluster.peerStaleTimeoutMs`                | Default: `60000` (1m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH`                    | `eventRouter.maxChainDepth`                 | Default: `10`. Coerced to number. Maximum depth for chained event routing                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` | `eventRouter.rateLimitPerWorkflowPerMinute` | Default: `100`. Coerced to number. Rate limit per workflow per minute for event routing                                                                                                                                                                                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_EVENT_TTL_SECONDS`                  | `eventRouter.eventTtlSeconds`               | Default: `604800` (7d). Coerced to number. Time-to-live for routed events                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS`                | `eventRouter.cleanupIntervalMs`             | Default: `3600000` (1h). Coerced to number. Interval between expired event cleanup sweeps                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_LOG_LEVEL`                                       | `logLevel`                                  | Default: `info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_NODE_ENV`                                        | `nodeEnv`                                   | Default: `development`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### GitHub App credentials are not env vars

GitHub App credentials — app id, private key, webhook secret — are **not** orchestrator config fields. They live in the `sources` table, encrypted at rest, and you manage them with `kici-admin source add github` (see [multi-provider setup](#multi-provider-setup) below). Neither the local YAML schema nor the shared DB schema declares a `providers` section, so there is no config path for a `KICI_PROVIDERS_GITHUB_*` env var to reach.

Such a var left in an env file is not silently ignored. `KICI_PROVIDERS_GITHUB_<NAME>_APP_ID` (or `_PRIVATE_KEY` / `_WEBHOOK_SECRET`) is an unknown `KICI_*` var, so the typo catcher **refuses to start the orchestrator** and names it in the error. Set `KICI_DEV=true` to downgrade that to a warning. Move the credentials into a source with `kici-admin source add github`, then delete the env vars.

**Important:** Legacy provider-specific env vars without the `KICI_` prefix (e.g., `PROVIDERS_GITHUB_APP_ID`, `PROVIDERS_GITHUB_PRIVATE_KEY`, `GITHUB_APP_ID`) are **not recognized**. Only `NODE_ENV` is still honored as a low-priority unprefixed fallback; every other config field requires its `KICI_`-prefixed env var name.

## Worked example: where a value comes from

Suppose `queue.maxDepth` is set in three places: `KICI_QUEUE_MAX_DEPTH=2000` in the environment, `500` in the shared DB config, and nothing in the local YAML file. The built-in default is `1000`.

| Surface                                  | Resolved value | Why                                                                           |
| ---------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| The running orchestrator, at startup     | `2000`         | startup reads the environment                                                 |
| The running orchestrator, after a reload | `2000`         | the reload path reads the environment and the YAML file; the environment wins |
| `kici-admin config export`               | `500`          | it reports the stored shared document, not the running config                 |

Drop the environment variable and the answers change to `1000`, `1000`, and `500`. The shared DB value does not reach the running orchestrator on either path.

`kici-admin config get` reports what the orchestrator is running with; `kici-admin config export` reports what is stored in the database. They answer different questions, and they disagree whenever the two stores differ.

## Webhook ingest acknowledgement

A direct-ingress webhook is acknowledged as soon as the delivery is **durably queued**, and its match-and-dispatch pipeline runs afterwards. The `202` response therefore means _accepted and stored_; it does **not** mean any workflow matched, or that a run was created.

This is deliberate. A provider abandons a delivery attempt in seconds — GitHub's timeout is 10 — while a single matched workflow's build phase alone may legitimately take up to `KICI_CACHE_BUILD_TIMEOUT_MS` (default 600 s), multiplied by however many workflows one event matches. Waiting for the pipeline turned a slow build into a _failed delivery_ for work that usually succeeded.

What the response can and cannot tell you:

| Response                                | Meaning                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `202 {accepted, deliveryId}`            | Accepted and durably queued. The pipeline will run.                                              |
| `200 {accepted, deliveryId, duplicate}` | A delivery with this id is already known; nothing new was queued.                                |
| `429 {rejected}` + `Retry-After`        | Shed — either admission control or the queue at its cap. Redeliver.                              |
| `4xx`                                   | Rejected before queueing: unknown source, bad signature, oversized body, malformed headers.      |
| `5xx`                                   | The orchestrator failed **before** queueing the delivery. A pipeline failure never appears here. |

**Where a pipeline outcome shows up instead.** Everything the pipeline decides — no workflow matched, a workflow refused by policy, a dispatch error, an unhandled failure — lands in the places you would look anyway, and never in the HTTP response:

- **The event log** carries one row per delivery, keyed by delivery id, with a `failed` status and the error message when the pipeline throws. This is the per-delivery record the dashboard renders.
- **Structured logs** carry a `webhook pipeline failed after the delivery was acknowledged` error line naming the delivery id, routing key, event, and where to look next.
- **The queue row itself** goes back to pending on a failure and is retried by the drain pass; past `KICI_INGEST_OVERFLOW_MAX_ATTEMPTS` it is marked failed and kept with its `last_error` for inspection, and an `ingest-queue delivery abandoned past max attempts` error line is emitted. Only a genuine failure counts against that ceiling — a verify error, a pipeline throw, a claim that went stale. A delivery the drain could not start because the orchestrator was at capacity costs no attempt at all; it is bounded by age instead (`KICI_INGEST_OVERFLOW_MAX_AGE_MS`, see below).
- **`kici_orch_webhook_pipeline_failures_total{phase="post_ack"}`** counts pipelines that threw after acknowledgement.

Because the queue is what makes early acknowledgement safe, setting `KICI_INGEST_OVERFLOW_ENABLED=false` also opts back in to **synchronous** ingestion: with nowhere durable to record the delivery, the orchestrator will not acknowledge one it has not stored, so the response waits for the pipeline again.

**Recovery from a crash.** A worker killed mid-pipeline leaves its queue row claimed. The drain pass reclaims any claim older than `ingest_overflow_claim_timeout_ms` (cluster setting; `KICI_INGEST_OVERFLOW_CLAIM_TIMEOUT_MS` default 900000) and retries the delivery. That timeout must stay comfortably above the longest a single delivery's pipeline can legitimately run, or a reclaim would re-run work still in flight.

## Webhook ingest admission control

The orchestrator caps how many webhook-ingest pipelines run concurrently so a burst of inbound deliveries (a backlog replay, a noisy source, or a sudden fan-in) can never saturate the event loop, the provider-API budget, or the database pool. Admission runs before any pipeline work, on both ingress paths: the HTTP direct-ingress routes and the Platform-relayed deliveries.

Admission is evaluated in three layers:

1. **Event-loop-lag gate.** A background sampler tracks the event-loop delay p99. When it crosses the shed threshold the gate opens and new deliveries are shed until the delay recovers below the resume threshold (a hysteresis band prevents flapping). This is the adaptive signal — it measures the real symptom (loop starvation) and needs no database access, so it stays healthy exactly when the database is the bottleneck.
2. **Concurrency caps.** A global in-flight backstop plus a per-org fairness cap, so one noisy tenant cannot starve others. If resolving the org for a delivery is slow (a cold cache against a stressed database), admission degrades gracefully to a per-source key with the cluster default rather than waiting on the database.
3. **Controlled-delay queue** (HTTP direct-ingress only). A short bounded queue absorbs transient bursts; a sustained standing queue fails fast rather than adding latency to deliveries that will be rejected anyway. This queue bounds how long the **acknowledgement** waits, not the pipeline: an admitted delivery holds its slot for the whole pipeline, so in-flight pipeline concurrency stays capped even though the response no longer waits for it. Platform-relayed deliveries never queue — they are granted immediately or shed — because the relay awaits the response synchronously against a tight deadline.

### Overload contract: 429 + `Retry-After`

When admission sheds a delivery, the orchestrator answers **HTTP 429** with a **`Retry-After`** header. The 429 contract is unconditional — the caller can always redeliver:

- **GitHub App sources** redeliver failed webhook deliveries automatically within a bounded backoff window, so a shed delivery is retried without operator action.
- **Generic webhook senders** SHOULD implement their own retry (honoring `Retry-After`).

### Durable ingest queue (default-on)

The same PostgreSQL table backs both halves of ingest: every **accepted** delivery is stored there before it is acknowledged, and every **shed** delivery is additively persisted there too and replayed back through normal ingest once capacity recovers. This means a burst past the ingest limit is not dropped even if the sender never retries — the shed still returns 429, and the delivery is also captured for automatic replay. The two paths are safe together: the sender's own redelivery and the orchestrator's replay both flow through the delivery-id dedup, so they collapse to a single processed delivery.

Behavior:

- **Bounded, with a lossy fallback at the cap.** The queue holds at most `KICI_INGEST_OVERFLOW_MAX` rows (default 5000). At the cap a _shed_ delivery is dropped from the queue (never unbounded storage) — the 429 still stands, so a retrying sender is still covered. An _accepted_ delivery is never dropped that way: with nowhere to store it the orchestrator sheds it instead, answering 429 rather than acknowledging work it did not take.
- **Replays only once capacity recovers, and waits for it rather than spending retries.** A background replayer drains the oldest buffered deliveries first. For each one it takes an admission slot **before** it claims the row, and holds that slot for the whole re-injection. So a delivery the orchestrator has no capacity for is left in the queue — same position, same attempt count, no error recorded — and is tried again on the next pass. An overload of any length therefore costs a queued delivery no retries. A delivery that fails for a real reason (a signature that no longer verifies, a pipeline throw, a claim that went stale) does spend one, and past `KICI_INGEST_OVERFLOW_MAX_ATTEMPTS` attempts it is marked failed and kept for inspection.
- **Bounded by age, not only by attempts.** Because a capacity refusal is free, age is what stops a queued delivery from being held forever while the queue fills and fresh captures start being dropped instead. A delivery that has waited longer than `KICI_INGEST_OVERFLOW_MAX_AGE_MS` (default 900000 — 15 minutes) is marked failed with an `ingest-queue delivery abandoned past max age` error line and kept for inspection. Raise it if your orchestrator legitimately sits at its concurrency cap for longer than that.
- **Never an exempt lane.** The replayer's admission slot is taken from the same controller, on the same global and per-org caps, as a fresh delivery — it competes on equal terms and can always be refused. This is deliberate: replay is fed by shed and shed is caused by overload, so a replay lane that could not be refused would turn a load spike into a self-amplifying storm. A refused reservation is counted on `kici_orch_ingest_overflow_replay_refused_total{reason}` rather than on the sender-facing shed counter.
- **Idempotent by delivery id.** Replay re-injects through the same admission-gated pipeline, so the delivery-id dedup guarantees a replayed delivery is never double-dispatched.
- **Best-effort FIFO ordering.** Deliveries replay oldest-first by capture time. Strict cross-delivery ordering is not guaranteed when replayed traffic interleaves with live traffic — acceptable because webhook processing is already unordered across deliveries.

Set `KICI_INGEST_OVERFLOW_ENABLED=false` to disable the queue entirely: a shed then only returns 429, and — because there is no longer a durable point to acknowledge against — direct ingestion reverts to waiting for the pipeline before responding. The replay pacing is tuned by `KICI_INGEST_OVERFLOW_REPLAY_INTERVAL_MS` and `KICI_INGEST_OVERFLOW_REPLAY_BATCH`.

### Tunables

The cluster-wide defaults are generous, so admission is a no-op under normal traffic and only tightens under real pressure. The knobs are the `KICI_INGEST_*` environment variables in the [reference table above](#environment-variable-reference-orchestrator-specific): the global concurrency backstop, queue depth, controlled-delay target/interval, the queue wait ceiling, the loop-lag shed/resume thresholds, the sample interval, and the per-org concurrency cluster default.

### Per-org concurrency cap (cluster-configurable)

The per-org fairness cap is a cluster-configurable setting: `KICI_INGEST_ORG_MAX_CONCURRENCY` sets the cluster default, and an operator can override it per organization at runtime without redeploying:

```bash
# Show the current per-org cap (or "(cluster default)" when unset)
kici-admin org-settings ingest-concurrency show --org <customer-id>

# Set a per-org cap
kici-admin org-settings ingest-concurrency set 16 --org <customer-id>

# Clear the override (fall back to the cluster default)
kici-admin org-settings ingest-concurrency reset --org <customer-id>
```

### Observability

The orchestrator exposes admission-control state on its Prometheus `/metrics` endpoint: `kici_orch_ingest_inflight`, `kici_orch_ingest_queue_depth`, `kici_orch_ingest_event_loop_delay_p99_ms` / `_max_ms`, `kici_orch_ingest_shedding_active` (1 when the delay circuit breaker is engaged), the `kici_orch_ingest_admitted_total` and `kici_orch_ingest_shed_total{reason}` counters, and the config-sourced limit gauges (`kici_orch_ingest_max_concurrency`, `kici_orch_ingest_max_queue_depth`, `kici_orch_ingest_org_max_concurrency`, `kici_orch_ingest_loop_lag_shed_ms`, `kici_orch_ingest_loop_lag_resume_ms`) so a dashboard can plot current usage against the deployed caps.

The durable overflow buffer adds its own series:

- `kici_orch_ingest_overflow_buffered` — gauge, the current buffered-row depth awaiting replay.
- `kici_orch_ingest_overflow_max` — gauge, the configured row cap (`KICI_INGEST_OVERFLOW_MAX`), so a dashboard can plot buffered depth against the deployed cap.
- `kici_orch_ingest_overflow_captured_total` — deliveries captured into the buffer.
- `kici_orch_ingest_overflow_replayed_total` — deliveries successfully replayed.
- `kici_orch_ingest_overflow_dropped_total{reason}` — deliveries permanently dropped. `cap_full` means the buffer was at its cap, `max_attempts` means replay exhausted its retries, and `max_age` means the delivery waited past `KICI_INGEST_OVERFLOW_MAX_AGE_MS`.
- `kici_orch_ingest_overflow_replay_refused_total{reason}` — replay reservations the admission controller refused. The delivery stays queued and costs no attempt.

A drain that converges while that last counter rises is the shape to expect under load: the queue is draining and the caps are still holding it back.

## Multi-provider setup

The orchestrator supports multiple webhook sources simultaneously — GitHub App sources and generic webhook sources alike. Each is managed as a **webhook source** via the `kici-admin source` commands (not through config YAML or `config seed`).

### Adding GitHub App sources

```bash
# Add a GitHub App source
kici-admin source add github \
  --name main-org \
  --app-id 12345 \
  --private-key @main-org.pem \
  --webhook-secret whsec_main_secret

# Add another app
kici-admin source add github \
  --name partner-org \
  --app-id 67890 \
  --private-key @partner-org.pem \
  --webhook-secret whsec_partner_secret
```

See `docs/operator/orchestrator/kici-admin-cli.md` for the full `source` command reference.

Each app registers its own routing key (e.g., `github:12345`, `github:67890`) with the Platform relay via `source.register` messages. The `ProviderRegistry` maps each routing key to its own provider bundle (normalizer, lock file fetcher, clone token provider, etc.).

### One HTTP listener for every source (no per-source ports)

Every webhook source — GitHub Apps, generic webhooks, internal sources — is served from the **single HTTP listener** the orchestrator binds at startup. The listener address is controlled by `KICI_PORT` (one numeric value, no list, no per-source override) and the orchestrator routes inbound deliveries by **path**, not by port:

- `POST /webhook/:orgId/github/:sourceId` — one path per GitHub App source, distinguished by the `sourceId` segment. Served only in the own-ingress modes (`hybrid`, `independent`, `observed`); in `platform` mode GitHub deliveries arrive through the relay.
- `POST /webhook/:orgId/generic/:sourceId` — one path per generic source, distinguished by the `sourceId` segment

The `generic_webhook_sources` table has no `port` column, and `kici-admin source add ...` exposes no `--port` flag — there is intentionally no way to give one source its own listener while another stays on `KICI_PORT`. If you want different upstream URLs per source (different hostnames, different TLS certs, different ingress paths), terminate that distinction at your reverse proxy / load balancer and forward all of them to the orchestrator's single port. The same `KICI_BASE_PATH` reverse-proxy pattern documented in [getting-started](getting-started.md#reverse-proxy-setup) is the supported way to host the orchestrator behind a custom URL prefix.

### Source credentials are not env-configurable

`kici-admin source add` is the only mechanism for managing source credentials. There is no env-var override for a source's app id, private key, or webhook secret — see [GitHub App credentials are not env vars](#github-app-credentials-are-not-env-vars) above.

## Storage configuration

The orchestrator writes to three independent object-storage subsystems (cache, logs, cold-store). The full bucket-and-prefix map — including which env var names which bucket, what data lives under each prefix, and per-table cold-store tuning — lives in [storage layout](storage-layout.md). Two storage-specific quirks worth knowing up front:

**Cache storage env vars are `KICI_STORAGE_*`.** The orchestrator reads the `KICI_STORAGE_TYPE` / `KICI_STORAGE_BUCKET` / `KICI_STORAGE_PREFIX` / `KICI_STORAGE_REGION` / `KICI_STORAGE_ENDPOINT` / `KICI_STORAGE_EXTERNAL_ENDPOINT` / `KICI_STORAGE_FORCE_PATH_STYLE` / `KICI_STORAGE_LOG_BUCKET` family directly via `loadConfig()` in `packages/orchestrator/src/config.ts` and bridges them into the `storage.*` config field. The names follow the project-wide `KICI_`-prefix convention and benefit from the unknown-env-var typo catcher at boot.

**The log-storage prefix is hardcoded.** Step logs are written under `kici-logs/...` and webhook payloads under `event-log/{orgId}/{deliveryId}.json.gz` — neither is configurable via env var. If you need a different layout (e.g., to share the log bucket with another service that already owns one of these prefixes), use `KICI_STORAGE_LOG_BUCKET` to point logs at a dedicated bucket rather than trying to relocate the prefix.

## Deployment identity (`KICI_DEPLOY_*`)

The orchestrator reports how it was deployed and where its own config files live. The dashboard's infrastructure page uses this to show a copy-ready `kici-admin` invocation for each orchestrator, and to name the files an operator inspects. These env vars carry it:

| Variable                        | Values                                           | When set                              |
| ------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `KICI_DEPLOY_MODE`              | `systemd` \| `launchd` \| `windows` \| `compose` | always, for an installed orchestrator |
| `KICI_DEPLOY_CONFIG_FILE`       | absolute path to the env file                    | always, for an installed orchestrator |
| `KICI_DEPLOY_CONTAINER`         | the container name                               | container (compose) deployments only  |
| `KICI_DEPLOY_CONTAINER_RUNTIME` | `podman` \| `docker`                             | container (compose) deployments only  |
| `KICI_DEPLOY_COMPOSE_FILE`      | absolute path to the generated compose file      | container (compose) deployments only  |

**You normally don't set these by hand.** `kici-admin orchestrator install` writes them into the orchestrator's env file automatically based on the deployment shape it just created. A systemd / launchd / Windows-service install writes `KICI_DEPLOY_MODE` and `KICI_DEPLOY_CONFIG_FILE`. A container (compose) install also writes the container name and runtime, so the dashboard can render the `<runtime> exec <container> kici-admin …` form, plus the path of the compose file it generated. The installer stamps `KICI_DEPLOY_CONFIG_FILE` because a running orchestrator cannot derive it. A service manager hands the process the variables from the env file, not the name of the file, and a container never sees the host path at all. A hand-run orchestrator (no installer) reports an `unknown` shape, and the dashboard falls back to a bare `kici-admin` command plus a note to set `KICI_ADMIN_URL` / `KICI_ADMIN_TOKEN`. The values follow the project-wide `KICI_`-prefix convention; the orchestrator reads them directly at startup and they are exempt from the unknown-env-var typo catcher. Surrounding whitespace is ignored on every one of them, so a hand-edited env file that leaves a stray space or a trailing newline on a value still reports the right shape. Any other unrecognized `KICI_DEPLOY_MODE` value reports an `unknown` shape; an unrecognized container runtime is omitted, leaving the mode intact.

## Config file locations

An installed orchestrator owns an env file, a scaler config, and — for a compose install — a generated compose file. It reports each one, so you never have to guess where the installer put them:

| File          | Location                                                                       | Holds                                           |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Env file      | `<config-dir>/<service-name>.env`                                              | every `KICI_*` variable the service starts with |
| Scaler config | the `KICI_SCALER_CONFIG_PATH` / `KICI_SCALER_CONFIG_DIR` path in that env file | the auto-scaler backends and their limits       |
| Compose file  | `<config-dir>/<service-name>-compose.yaml`, compose installs only              | the generated container definition              |

`kici-admin orchestrator status` prints them under a **Config files** heading, and `--json` returns them as a `configPaths` object. The command reads the install manifest and the env file on disk, so it answers for a stopped service too. The dashboard's infrastructure page names the same env file and compose file in each orchestrator's info popover. Its scaler config row names the same scaler path. The two surfaces reach that one value by different routes and therefore agree: the command reads the env file text, and the orchestrator reports the environment it started with. A scaler path set only under `scaler.configPath` / `scaler.configDir` in the YAML config file appears in neither, because the orchestrator loads its startup config from the environment. That YAML value still reaches the `kici-admin scaler` commands and the `/admin/config` route.

The paths are reported, never checked for existence. A compose orchestrator names host paths that do not resolve inside its own container, so a check there would blank the answer for the shape that most needs it. Only the paths travel — no layer ever carries the contents of these files, which hold the database URL and the Platform token.

## Sensitive values

### Master key

Secrets stored in the shared DB config (private keys, tokens, webhook secrets) are encrypted at rest using AES-256-GCM. The encryption key is derived from a master key that must be available on every orchestrator instance.

Set the master key via:

- **Env var:** `KICI_SECRET_KEY` (64-character hex string or base64-encoded)
- **File:** `KICI_SECRET_KEY_FILE` -- path to a file containing the key. The orchestrator reads the file at startup.

The master key is the minimum bootstrap secret -- the only secret that must be distributed out-of-band to each orchestrator. All other secrets can then be stored encrypted in the database.

### How encryption works

When you seed config to the database (`kici-admin config seed`), the following fields are automatically encrypted before storage:

- `platform.token`
- `secrets.key`
- `secrets.bootstrapAdminToken`
- `cluster.joinToken`

Provider secrets (`privateKey`, `webhookSecret`) are not part of the config system. They are stored separately via the `PgSecretStore` in the `secrets` table, managed through the sources API.

Each encrypted field uses a path-specific AAD (Additional Authenticated Data) in the format `config-field:<path>`, binding the ciphertext to its specific location in the config tree. The `encrypted_paths` array is stored alongside each config version so the system knows exactly which fields to decrypt on read.

When you query config via the admin API or CLI (`kici-admin config get`), sensitive values in the response are redacted as `***REDACTED***`.

## Scaler config

The auto-scaler configuration (`scalers.yaml`) is a separate file, not part of the YAML or shared DB config. The orchestrator finds it at startup from `KICI_SCALER_CONFIG_PATH` and `KICI_SCALER_CONFIG_DIR`. `kici-admin scaler` prefers `scaler.configPath` / `scaler.configDir` in the local YAML file and falls back to those two variables.

When SIGHUP is sent to the orchestrator, both the orchestrator config and the scaler config are reloaded together (unified signal). See [Auto-scaler configuration](auto-scaler.md) for the scaler YAML schema and examples.

## Validation

### Startup validation

On startup, the orchestrator validates the environment against the startup schema in `packages/orchestrator/src/config.ts`. If validation fails, the service prints every error and exits:

```
Configuration validation failed:
  - platformUrl: KICI_PLATFORM_URL is required when KICI_MODE is platform, hybrid, or observed
  - platformToken: KICI_PLATFORM_TOKEN is required when KICI_MODE is platform, hybrid, or observed
```

The reload path runs a second, separate validation: it merges the environment over the YAML file and validates the result against `appConfigSchema` in `packages/orchestrator/src/config/schema.ts`. A reload that fails validation keeps the current config and logs the errors.

### Cross-field validation rules

- **Worker mode requires a coordinator URL:** If `cluster.role` is `worker`, either `cluster.coordinatorUrl` or the env-only multi-coordinator list `KICI_CLUSTER_COORDINATOR_URLS` (comma-separated; takes precedence over the singular form when both are set) must be present
- **Coordinator mode requires database:** `databaseUrl` is required when `cluster.role` is `coordinator` (the default). Workers do not need a database connection.
- **Platform-connected modes:** `platformUrl` and `platformToken` are required when the mode is `platform`, `hybrid`, or `observed` (skipped for workers). `independent` is the only mode that never holds a Platform connection.
- **Observed mode requires a public webhook URL:** If the mode is `observed`, `KICI_WEBHOOK_PUBLIC_URL` must be set — the orchestrator serves its own ingress, so it must advertise the base URL providers post to (skipped for workers)
- **Cluster peers require address:** If `cluster.peers` is set, `cluster.address` is required
- **S3 storage requires bucket:** If `storage.type` is `s3`, `storage.bucket` is required
- **Filesystem storage requires an absolute path:** If `KICI_STORAGE_TYPE` is `filesystem`, `KICI_STORAGE_FS_PATH` must be set to an absolute path (see [storage layout](storage-layout.md) for the filesystem backend)
- **Provision backoff ceiling must not sit below the base:** `KICI_SCALER_PROVISION_BACKOFF_MAX_MS` must be at least `KICI_SCALER_PROVISION_BACKOFF_BASE_MS`. The external-provision backoff is `min(base * 2^(n-1), ceiling)`, so a ceiling below the base collapses it to a constant from the first failure. The cluster-settings admin route rejects the same pair with a `400`, so the env path and the cluster-settings path cannot disagree about what is valid

### Packaging scope skips the runtime rules

`kici-admin agent package` builds an agent payload from the object-storage config alone, so it validates in **packaging scope**: only the S3-bucket rule, the filesystem-path rule, and the cluster address-when-peers rule apply. The coordinator database URL, the worker coordinator URL, the Platform connection, and the observed-mode public URL are not required. This is deliberate — the operator shell that produces a build artifact does not carry the running orchestrator's runtime env, and demanding it would block packaging for no benefit. The boot-time unknown-`KICI_*` typo check is skipped in this scope for the same reason: an arbitrary operator shell may carry unrelated `KICI_*` vars.

### Offline validation

Validate a YAML file without contacting the orchestrator:

```bash
kici-admin config validate --file orchestrator.yaml --type local --offline
kici-admin config validate --file shared-config.yaml --type shared --offline
```

## Instance identity

Each orchestrator instance derives an `instanceId` at startup from its hostname and a random UUID fragment (for example `orch-west-1-f47ac10b`). Override it with `KICI_CLUSTER_INSTANCE_ID`. The instance id is fixed for the life of the process: a reload holds it at its startup value.

## Example configurations

### Platform mode (single app)

```bash
KICI_MODE=platform
KICI_DATABASE_URL=postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici
KICI_PORT=4000
KICI_LOG_LEVEL=info
KICI_PLATFORM_URL=wss://api.kici.dev/ws
KICI_PLATFORM_TOKEN=kici_abc123def456
KICI_SECRET_KEY=<64-char-hex-master-key>
KICI_BOOTSTRAP_ADMIN_TOKEN=<admin-token>
```

Add the GitHub App with `kici-admin source add github` — its credentials are not config fields. See [GitHub App credentials are not env vars](#github-app-credentials-are-not-env-vars).

### Independent mode (no Platform)

```bash
KICI_MODE=independent
KICI_DATABASE_URL=postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici
KICI_PORT=4000
```

Start this mode from `standalone.js` — see [Entry points](#entry-points).

### Observed mode (own ingress, hosted observability)

Webhooks are posted straight to the orchestrator's own public URL and never
transit KiCI, but the orchestrator keeps its Platform connection so runs, jobs,
steps, logs, and events show up in the hosted dashboard. Its sources are recorded
as **observe-only**: dashboard-visible, never routed.

```bash
KICI_MODE=observed
KICI_DATABASE_URL=postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici
KICI_PORT=4000
KICI_PLATFORM_URL=wss://api.kici.dev/ws
KICI_PLATFORM_TOKEN=kici_ok_...
KICI_WEBHOOK_PUBLIC_URL=https://kici.example.com
```

`KICI_WEBHOOK_PUBLIC_URL` is mandatory in this mode — the orchestrator serves its
own ingress, so it must advertise the base URL providers post to. GitHub-App
sources are refused (both at startup and by `kici-admin source add`) because they
are ingested through the Platform relay; use a generic or local source, or switch
to `hybrid` if you want the relay.

### Multi-app hybrid mode

```bash
KICI_MODE=hybrid
KICI_DATABASE_URL=postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici
KICI_PORT=4000
KICI_PLATFORM_URL=wss://api.kici.dev/ws
KICI_PLATFORM_TOKEN=kici_abc123def456
KICI_STORAGE_TYPE=s3
KICI_STORAGE_BUCKET=kici-cache
```

Add each GitHub App as its own source with `kici-admin source add github`. Provider credentials are not config fields, in either store — see [Multi-provider setup](#multi-provider-setup).

## Entry points

| Mode / Role             | Entry Point           | CMD Override Needed                                  |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| `platform`              | `server.js` (default) | No                                                   |
| `hybrid`                | `server.js` (default) | No                                                   |
| `observed`              | `server.js` (default) | No                                                   |
| `independent`           | `standalone.js`       | Yes: `node packages/orchestrator/dist/standalone.js` |
| `cluster.role = worker` | `server.js` (default) | No (workers bypass mode check, work from any entry)  |

## See also

- [Config management guide](config-management.md) -- shared config lifecycle: seed, CLI, reload, rollback
- [Orchestrator getting started](getting-started.md) -- deployment guide
- [Auto-scaler configuration](auto-scaler.md) -- scaler YAML schema
- [Agent configuration](../agent/configuration.md) -- agent env vars
- [Configuration architecture](../../architecture/configuration.md) -- design deep-dive
