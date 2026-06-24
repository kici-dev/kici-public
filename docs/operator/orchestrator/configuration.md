---
title: Configuration reference
description: YAML config, env var overrides, shared DB config, multi-provider setup, and migration guide
---

> **See also:** [Environment variable reference](../env-reference.md) — shared env vars; orchestrator-specific vars are listed below. Regenerate the generated table with `pnpm docs:env`. Unknown `KICI_*` env vars cause the orchestrator to refuse to start (typo catcher); set `KICI_DEV=true` for warn-only behaviour during local development.

The KiCI orchestrator uses a layered configuration system: a local YAML file for per-instance settings, a shared PostgreSQL-backed config store for shared settings, and environment variable overrides for both. The scaler configuration (`scalers.yaml`) remains a separate file.

## Overview

The orchestrator resolves its configuration from four sources, in order of precedence:

1. **Environment variables** (KICI\_-prefixed) -- highest precedence
2. **Local YAML file** (`orchestrator.yaml`) -- per-instance settings
3. **Shared DB config** (PostgreSQL `config_versions` table) -- shared across all instances
4. **Built-in defaults** -- lowest precedence

This means an environment variable always overrides the same setting from YAML or DB. The YAML file overrides the shared DB config. And the shared DB config overrides built-in defaults.

The configuration source of truth is `packages/orchestrator/src/config/schema.ts`.

## Two-Phase Bootstrap

The orchestrator loads configuration in two phases to avoid a circular dependency (you need the database URL to connect to the DB, but the DB stores shared config):

1. **Phase 1 (local-only):** Load `orchestrator.yaml` + KICI\_ env vars to get `database.url`, `instance.id`, `server.port`, and `instance.mode`. This is enough to start the process and connect to PostgreSQL.
2. **Phase 2 (full merge):** Query the shared config from the `config_versions` table, merge all four layers (env > YAML > DB > defaults), and validate with the full `appConfigSchema`.

## Local Config File

The local config file contains per-orchestrator-instance settings that are never shared across orchestrators. By default, the orchestrator looks for the file at `/etc/kici/orchestrator.yaml`. Override this with:

- `--config /path/to/orchestrator.yaml` (CLI flag)
- `KICI_CONFIG=/path/to/orchestrator.yaml` (env var)

If no file is found and no explicit path was given, the orchestrator runs in env-only mode (YAML is optional).

### Full Annotated Example

```yaml
# /etc/kici/orchestrator.yaml
# Local configuration for a single orchestrator instance.

# Database connection (required)
database:
  url: 'postgresql://kici:s3cur3pass@postgres:5432/kici'

# Instance settings
instance:
  # Unique identifier for this orchestrator instance.
  # Default: auto-generated random UUID.
  id: 'orch-west-1'

  # Operating mode: platform | hybrid | independent
  # - platform (default): WS to Platform relay only; rejects direct webhooks.
  #     Requires platform.url + platform.token (or KICI_PLATFORM_URL + KICI_PLATFORM_TOKEN).
  # - hybrid: Platform relay + direct per-source webhook ingestion (deduplicated).
  #     Requires Platform credentials. Per-source webhook secrets live in the
  #     orchestrator DB (kici-admin source add ...) — there is no global
  #     webhook-secret env var.
  # - independent: standalone, direct per-source webhook ingestion only.
  #     Different entry point (`standalone.js`). Per-source secrets in DB.
  # Mode is optional — defaults to "platform" — but the credentials the mode
  # requires must be present at startup or the orchestrator refuses to boot.
  # See operator/orchestrator/getting-started.md#three-deployment-modes for the
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

### Local Config Fields

| Field                | Type   | Default         | Description                                         |
| -------------------- | ------ | --------------- | --------------------------------------------------- |
| `database.url`       | string | (required)      | PostgreSQL connection URL                           |
| `instance.id`        | string | `<random-UUID>` | Unique orchestrator instance ID                     |
| `instance.mode`      | enum   | `platform`      | Operating mode: `platform`, `hybrid`, `independent` |
| `server.port`        | number | `4000`          | HTTP server listen port                             |
| `server.basePath`    | string | `/`             | URL prefix for all routes                           |
| `server.logLevel`    | enum   | `info`          | Log level: `debug`, `info`, `warn`, `error`         |
| `server.tlsCertPath` | string | --              | Path to TLS cert (PEM) for expiry diagnostic        |
| `scaler.configPath`  | string | --              | Path to `scalers.yaml`                              |
| `scaler.configDir`   | string | --              | Path to `scalers.d/` directory                      |

## Environment Variable Overrides

Every config field can be overridden by a `KICI_`-prefixed environment variable. The mapping uses underscore-separated uppercase paths:

### Environment variable reference (orchestrator-specific)

Variables shared across KiCI services and the logger live in the
[environment variable reference](../env-reference.md). The orchestrator-specific
variables, with type/default/required metadata generated from the config schema:

<!-- BEGIN GENERATED: orchestrator-env (do not edit; run pnpm docs:env) -->

| Env var                                                | Required | Default                   | Type                               | Aliases | Description                                                                                                                                                                                                                      |
| ------------------------------------------------------ | -------- | ------------------------- | ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KICI_AGENT_AUTH`                                      | no       | "token"                   | enum:token\|none                   |         |                                                                                                                                                                                                                                  |
| `KICI_AGENT_MAX_RECONNECT_DELAY_MS`                    | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_AGENT_TOKEN_TTL_MS`                              | no       | 3600000                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_AUTO_MIGRATE`                                    | no       | "true"                    | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_BASE_PATH`                                       | no       | "/"                       | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_BOOTSTRAP_ADMIN_TOKEN`                           | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CACHE_BUILD_TIMEOUT_MS`                          | no       | 600000                    | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CACHE_MAX_TARBALL_BYTES`                         | no       | 524288000                 | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CACHE_TTL_DAYS`                                  | no       | 30                        | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_ADDRESS`                                 | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_COORDINATOR_URL`                         | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_COORDINATOR_URLS`                        | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_CREDENTIAL_FILE`                         | no       | "~/.kici/peer-credential" | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_ELECTION_GRACE_PERIOD_MS`                | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_INSTANCE_ID`                             | no       | "<computed>"              | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_JOIN_TOKEN`                              | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_NAME`                                    | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS`              | no       | 30000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS`             | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`                   | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_PEERS`                                   | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS`            | no       | 10000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS`            | no       | 5000                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_RAFT_HEARTBEAT_MS`                       | no       | 2000                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_ROLE`                                    | no       | "coordinator"             | enum:coordinator\|worker           |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_SINGLE_NODE`                             | no       | false                     | union                              |         |                                                                                                                                                                                                                                  |
| `KICI_CLUSTER_TRUSTED_PROXIES`                         | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_DASHBOARD_URL`                                   | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_DATA_DIR`                                        | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_DATABASE_URL`                                    | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_DISPATCH_ACK_TIMEOUT_MS`                         | no       | 10000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES`                     | no       | 5242880                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS`                | no       | 3600000                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_EVENT_TTL_SECONDS`                  | no       | 604800                    | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_LEASE_DURATION_MS`                  | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH`                    | no       | 10                        | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_MAX_DISPATCH_ATTEMPTS`              | no       | 5                         | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` | no       | 100                       | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_RETRY_BASE_BACKOFF_MS`              | no       | 5000                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_RETRY_MAX_BACKOFF_MS`               | no       | 300000                    | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_EVENT_ROUTER_RETRY_SCAN_INTERVAL_MS`             | no       | 10000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS`             | no       | 86400000                  | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_HOST_REBOOT_DEADLINE_MS`                         | no       | 900000                    | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_LOCKFILE_CACHE_MAX`                              | no       | 500                       | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_LOCKFILE_CACHE_TTL_MS`                           | no       | 3600000                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_MACHINE_LEDGER_DIR`                              | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_MAX_FANOUT_HOSTS`                                | no       | 1024                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_MODE`                                            | no       | "platform"                | enum:platform\|hybrid\|independent |         |                                                                                                                                                                                                                                  |
| `KICI_ORCHESTRATOR_HOST_AGENT_ID`                      | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_PG_CUSTOMER_SECRETS`                             | no       | "true"                    | enum:true\|false                   |         |                                                                                                                                                                                                                                  |
| `KICI_PLATFORM_TOKEN`                                  | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_PLATFORM_URL`                                    | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_PORT`                                            | no       | 4000                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_QUEUE_BACKPRESSURE_THRESHOLD`                    | no       | 100                       | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_QUEUE_MAX_DEPTH`                                 | no       | 1000                      | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_QUEUE_TIMEOUT_MS`                                | no       | 3600000                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_ROSTER_GRACE_MS`                                 | no       | 300000                    | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_ROSTER_TTL_MS`                                   | no       | 1800000                   | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_SCALER_CONFIG_DIR`                               | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SCALER_CONFIG_PATH`                              | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SECRET_KEY`                                      | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SECRET_KEY_FILE`                                 | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SECRET_KEY_FILE_OLD`                             | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SECRET_KEY_OLD`                                  | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SERVER_TLS_CERT_PATH`                            | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_SKIP_S3_SENTINEL_VALIDATION`                     | no       | "false"                   | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STALE_DETECTOR_SCAN_INTERVAL_MS`                 | no       | 60000                     | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER`             | no       | 2                         | number                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_BUCKET`                                  | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_ENDPOINT`                                | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_EXTERNAL_ENDPOINT`                       | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_FORCE_PATH_STYLE`                        | no       |                           | enum:true\|false                   |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_FS_BASE_URL`                             | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_FS_PATH`                                 | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_LOG_BUCKET`                              | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_PATH`                                    | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_PREFIX`                                  | no       | "kici-cache/"             | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_REGION`                                  | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_TYPE`                                    | no       |                           | enum:s3\|filesystem                |         |                                                                                                                                                                                                                                  |
| `KICI_STORAGE_UPLOAD_ENDPOINT`                         | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_TEST_EVENT_FAIL_FIRST_N`                         | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_TEST_MODE`                                       | no       | "0"                       | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_USER_CACHE_QUOTA_BYTES`                          | no       | 5368709120                | number                             |         | Cluster-wide default per-org byte quota for the user-facing cache (ctx.cache). A per-org override in org_settings.user_cache_quota_bytes (set via `kici-admin org-settings user-cache set-quota`) takes precedence when present. |
| `KICI_USER_CACHE_TTL_MS`                               | no       | 604800000                 | number                             |         | Cluster-wide default per-entry TTL (ms) for the user-facing cache. A per-org override in org_settings.user_cache_ttl_ms (set via `kici-admin org-settings user-cache set-ttl`) takes precedence when present.                    |
| `KICI_WEBHOOK_PAYLOAD_DIR`                             | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_WEBHOOK_PUBLIC_URL`                              | no       |                           | string                             |         |                                                                                                                                                                                                                                  |
| `KICI_WORKER_CONCURRENCY`                              | no       | 5                         | number                             |         |                                                                                                                                                                                                                                  |
| `NODE_ENV`                                             | no       | "development"             | enum:development\|production\|test |         |                                                                                                                                                                                                                                  |

> **Not shown above:** the `KICI_COLD_STORE_*` family (consumed directly by `cold-store/orchestrator-cold-store.ts`, registered in `COLD_STORE_ENV_VARS` so the typo catcher allows them but not part of the Zod schema). For the full storage env-var inventory plus prefix layout, see [orchestrator storage layout](storage-layout.md).

<!-- END GENERATED: orchestrator-env -->

### Direct Mappings

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
| `KICI_STORAGE_TYPE`                                    | `storage.type`                              | `s3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
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
| `KICI_CLUSTER_COORDINATOR_URL`                         | `cluster.coordinatorUrl`                    | Required when `cluster.role` = `worker`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `KICI_CLUSTER_PEER_STALE_TIMEOUT_MS`                   | `cluster.peerStaleTimeoutMs`                | Default: `60000` (1m). Coerced to number                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH`                    | `eventRouter.maxChainDepth`                 | Default: `10`. Coerced to number. Maximum depth for chained event routing                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE` | `eventRouter.rateLimitPerWorkflowPerMinute` | Default: `100`. Coerced to number. Rate limit per workflow per minute for event routing                                                                                                                                                                                                                                                                                                                                                                                                             |
| `KICI_EVENT_ROUTER_EVENT_TTL_SECONDS`                  | `eventRouter.eventTtlSeconds`               | Default: `604800` (7d). Coerced to number. Time-to-live for routed events                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS`                | `eventRouter.cleanupIntervalMs`             | Default: `3600000` (1h). Coerced to number. Interval between expired event cleanup sweeps                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_LOG_LEVEL`                                       | `logLevel`                                  | Default: `info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KICI_NODE_ENV`                                        | `nodeEnv`                                   | Default: `development`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Multi-App GitHub Provider Env Vars

For multi-provider setups, env vars use the app name from the config (hyphen to underscore, uppercased):

```
KICI_PROVIDERS_GITHUB_<APP_NAME>_<FIELD>
```

| Env Var Pattern                               | Config Path                            | Example                                                   |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `KICI_PROVIDERS_GITHUB_<NAME>_APP_ID`         | `providers.github[name].appId`         | `KICI_PROVIDERS_GITHUB_MAIN_ORG_APP_ID=12345`             |
| `KICI_PROVIDERS_GITHUB_<NAME>_PRIVATE_KEY`    | `providers.github[name].privateKey`    | `KICI_PROVIDERS_GITHUB_MAIN_ORG_PRIVATE_KEY=...`          |
| `KICI_PROVIDERS_GITHUB_<NAME>_WEBHOOK_SECRET` | `providers.github[name].webhookSecret` | `KICI_PROVIDERS_GITHUB_MAIN_ORG_WEBHOOK_SECRET=whsec_...` |

App name conversion: YAML `main-org` becomes env var segment `MAIN_ORG` (hyphen to underscore, uppercased).

If an env var references an app name that does not exist in the config, a stub app entry is created automatically.

**Important:** Legacy provider-specific env vars without the `KICI_` prefix (e.g., `PROVIDERS_GITHUB_APP_ID`, `PROVIDERS_GITHUB_PRIVATE_KEY`, `GITHUB_APP_ID`) are **not recognized**. Only `NODE_ENV` is still honored as a low-priority unprefixed fallback; every other config field requires its `KICI_`-prefixed env var name.

## Config Resolution Precedence

The full resolution chain is: **env var > local YAML > shared DB > defaults**.

**Example:** Suppose the queue max depth is set in three places:

Listed highest-priority first:

| Source                         | Value     |
| ------------------------------ | --------- |
| Env var `KICI_QUEUE_MAX_DEPTH` | `2000`    |
| Local YAML                     | (not set) |
| Shared DB config               | `500`     |
| Built-in default               | `1000`    |

The resolved value is `2000` (env var wins). If the env var were absent, it would be `500` (DB wins over default). If the DB config were also absent, it would be `1000` (default).

## Multi-Provider Setup

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

- `POST /webhook/:orgId/github` — every GitHub App source registered on this orchestrator
- `POST /webhook/:orgId/generic/:sourceId` — one path per generic source, distinguished by the `sourceId` segment

The `generic_webhook_sources` table has no `port` column, and `kici-admin source add ...` exposes no `--port` flag — there is intentionally no way to give one source its own listener while another stays on `KICI_PORT`. If you want different upstream URLs per source (different hostnames, different TLS certs, different ingress paths), terminate that distinction at your reverse proxy / load balancer and forward all of them to the orchestrator's single port. The same `KICI_BASE_PATH` reverse-proxy pattern documented in [getting-started](getting-started.md#reverse-proxy-setup) is the supported way to host the orchestrator behind a custom URL prefix.

### Runtime env var overrides

The `KICI_PROVIDERS_GITHUB_<NAME>_<FIELD>` env vars (documented in the env var table above) can still inject provider fields into the runtime config object, but the primary mechanism for managing sources is `kici-admin source add`.

## Storage configuration

The orchestrator writes to three independent object-storage subsystems (cache, logs, cold-store). The full bucket-and-prefix map — including which env var names which bucket, what data lives under each prefix, and per-table cold-store tuning — lives in [storage layout](storage-layout.md). Two storage-specific quirks worth knowing up front:

**Cache storage env vars are `KICI_STORAGE_*`.** The orchestrator reads the `KICI_STORAGE_TYPE` / `KICI_STORAGE_BUCKET` / `KICI_STORAGE_PREFIX` / `KICI_STORAGE_REGION` / `KICI_STORAGE_ENDPOINT` / `KICI_STORAGE_EXTERNAL_ENDPOINT` / `KICI_STORAGE_FORCE_PATH_STYLE` / `KICI_STORAGE_LOG_BUCKET` family directly via `loadConfig()` in `packages/orchestrator/src/config.ts` and bridges them into the `storage.*` config field. The names follow the project-wide `KICI_`-prefix convention and benefit from the unknown-env-var typo catcher at boot.

**The log-storage prefix is hardcoded.** Step logs are written under `kici-logs/...` and webhook payloads under `event-log/{orgId}/{deliveryId}.json.gz` — neither is configurable via env var. If you need a different layout (e.g., to share the log bucket with another service that already owns one of these prefixes), use `KICI_STORAGE_LOG_BUCKET` to point logs at a dedicated bucket rather than trying to relocate the prefix.

## Deployment identity (`KICI_DEPLOY_*`)

The orchestrator reports how it was deployed so the dashboard's diagnostics page can show the correct, copy-ready `kici-admin` invocation for each orchestrator. Three env vars carry this:

| Variable                        | Values                                           | When set                              |
| ------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `KICI_DEPLOY_MODE`              | `systemd` \| `launchd` \| `windows` \| `compose` | always, for an installed orchestrator |
| `KICI_DEPLOY_CONTAINER`         | the container name                               | container (compose) deployments only  |
| `KICI_DEPLOY_CONTAINER_RUNTIME` | `podman` \| `docker`                             | container (compose) deployments only  |

**You normally don't set these by hand.** `kici-admin orchestrator install` writes them into the orchestrator's env file automatically based on the deployment shape it just created — a systemd / launchd / Windows-service install writes `KICI_DEPLOY_MODE` alone; a container (compose) install also writes the container name and runtime so the dashboard can render the `<runtime> exec <container> kici-admin …` form. A hand-run orchestrator (no installer) reports an `unknown` shape, and the dashboard falls back to a bare `kici-admin` command plus a note to set `KICI_ADMIN_URL` / `KICI_ADMIN_TOKEN`. The values follow the project-wide `KICI_`-prefix convention; the orchestrator reads them directly at startup and they are exempt from the unknown-env-var typo catcher.

## Sensitive Values

### Master Key

Secrets stored in the shared DB config (private keys, tokens, webhook secrets) are encrypted at rest using AES-256-GCM. The encryption key is derived from a master key that must be available on every orchestrator instance.

Set the master key via:

- **Env var:** `KICI_SECRET_KEY` (64-character hex string or base64-encoded)
- **File:** Set `secrets.keyFile` in `orchestrator.yaml` pointing to a file containing the key

The master key is the minimum bootstrap secret -- the only secret that must be distributed out-of-band to each orchestrator. All other secrets can then be stored encrypted in the database.

### How Encryption Works

When you seed config to the database (`kici-admin config seed`), the following fields are automatically encrypted before storage:

- `platform.token`
- `secrets.key`
- `secrets.bootstrapAdminToken`
- `cluster.joinToken`

Provider secrets (`privateKey`, `webhookSecret`) are not part of the config system. They are stored separately via the `PgSecretStore` in the `secrets` table, managed through the sources API.

Each encrypted field uses a path-specific AAD (Additional Authenticated Data) in the format `config-field:<path>`, binding the ciphertext to its specific location in the config tree. The `encrypted_paths` array is stored alongside each config version so the system knows exactly which fields to decrypt on read.

When you query config via the admin API or CLI (`kici-admin config get`), sensitive values in the response are redacted as `***REDACTED***`.

## Scaler Config

The auto-scaler configuration (`scalers.yaml`) remains a separate file, not part of the YAML/DB config system. It is referenced from the local config via `scaler.configPath` and `scaler.configDir`.

When SIGHUP is sent to the orchestrator, both the orchestrator config and the scaler config are reloaded together (unified signal). See [Auto-scaler configuration](auto-scaler.md) for the scaler YAML schema and examples.

## Validation

### Startup Validation

On startup, the orchestrator validates the merged config against `appConfigSchema` (Zod). If validation fails, the service prints all errors and exits:

```
Configuration validation failed:
  - platformUrl: platformUrl is required when mode is platform or hybrid
  - platformToken: platformToken is required when mode is platform or hybrid
```

### Cross-Field Validation Rules

- **Worker mode requires coordinator URL:** If `cluster.role` is `worker`, `cluster.coordinatorUrl` is required
- **Coordinator mode requires database:** `databaseUrl` is required when `cluster.role` is `coordinator` (the default). Workers do not need a database connection.
- **Platform/hybrid mode:** `platformUrl` and `platformToken` are required (skipped for workers)
- **Cluster peers require address:** If `cluster.peers` is set, `cluster.address` is required
- **S3 storage requires bucket:** If `storage.type` is `s3`, `storage.bucket` is required

### Offline Validation

Validate a YAML file without contacting the orchestrator:

```bash
kici-admin config validate --file orchestrator.yaml --type local --offline
kici-admin config validate --file shared-config.yaml --type shared --offline
```

## Instance Identity

Each orchestrator instance generates a unique `instanceId` at startup using a random UUID (e.g., `f47ac10b-58cc-4372-a567-0e02b2c3d479`). Override with `instance.id` in YAML or `KICI_INSTANCE_ID` env var.

## Example Configurations

### Platform Mode (Single App)

**orchestrator.yaml:**

```yaml
database:
  url: 'postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici'
instance:
  mode: 'platform'
server:
  port: 4000
  logLevel: 'info'
```

**Env vars:**

```bash
KICI_PROVIDERS_GITHUB_MAIN_ORG_APP_ID=123456
KICI_PROVIDERS_GITHUB_MAIN_ORG_PRIVATE_KEY="$(cat /keys/private-key.pem)"
KICI_PROVIDERS_GITHUB_MAIN_ORG_WEBHOOK_SECRET=whsec_github_secret
KICI_PLATFORM_URL=wss://platform.kici.dev/ws
KICI_PLATFORM_TOKEN=kici_abc123def456
KICI_SECRET_KEY=<64-char-hex-master-key>
KICI_BOOTSTRAP_ADMIN_TOKEN=<admin-token>
```

### Independent Mode (No Platform)

**orchestrator.yaml:**

```yaml
database:
  url: 'postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici'
instance:
  mode: 'independent'
server:
  port: 4000
```

### Multi-App Hybrid Mode

**orchestrator.yaml:**

```yaml
database:
  url: 'postgresql://kici:s3cur3pa55w0rd@postgres:5432/kici'
instance:
  mode: 'hybrid'
server:
  port: 4000
```

**Shared config (seeded to DB):**

```yaml
platform:
  url: 'wss://relay.kici.dev'
storage:
  type: 's3'
  bucket: 'kici-cache'
```

Provider credentials (GitHub App private keys, webhook secrets) are not part of the shared config schema. Manage them with `kici-admin source add` instead — see [Multi-Provider Setup](#multi-provider-setup).

## Entry Points

| Mode / Role             | Entry Point           | CMD Override Needed                                  |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| `platform`              | `server.js` (default) | No                                                   |
| `hybrid`                | `server.js` (default) | No                                                   |
| `independent`           | `standalone.js`       | Yes: `node packages/orchestrator/dist/standalone.js` |
| `cluster.role = worker` | `server.js` (default) | No (workers bypass mode check, work from any entry)  |

## See Also

- [Config Management Guide](config-management.md) -- shared config lifecycle: seed, CLI, reload, rollback
- [Orchestrator Getting Started](getting-started.md) -- deployment guide
- [Auto-scaler configuration](auto-scaler.md) -- scaler YAML schema
- [Agent Configuration](../agent/configuration.md) -- agent env vars
- [Configuration Architecture](../../architecture/configuration.md) -- design deep-dive
