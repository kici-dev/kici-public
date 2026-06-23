---
title: kici-admin CLI reference
description: Complete reference for the kici-admin orchestrator administration CLI
---

The `kici-admin` CLI manages the KiCI orchestrator: configuration, secrets, tokens, sources, database migrations, diagnostics, clustering, and service lifecycle. It communicates with the orchestrator's admin HTTP API using Bearer token authentication.

## Installation

The `kici-admin` binary is provided by the `kici-admin` npm package, which re-exports the CLI from `@kici-dev/orchestrator`:

```bash
npm install -g kici-admin
```

For standalone (single-executable) deployments, see [Packaging guide](../distribution/sea-binaries.md).

## Authentication

All API-backed commands require a Bearer token. Provide it via:

- **Environment variable** (recommended): `export KICI_ADMIN_TOKEN=<token>`
- **CLI flag**: `--token <token>` or `-t <token>`

The token is validated against the `admin_tokens` table in the orchestrator database. Tokens are stored as SHA-256 hashes and never persisted in plaintext.

### Bootstrap token

On first startup, the orchestrator generates a bootstrap token with `owner` role and prints it to the logs:

```
KICI Admin Token: <token-value>
```

Save this token immediately -- it is only shown once. To use a fixed token for automation, set `KICI_BOOTSTRAP_ADMIN_TOKEN` before starting the orchestrator:

```bash
export KICI_BOOTSTRAP_ADMIN_TOKEN=my-fixed-admin-token
```

The bootstrap token creation is idempotent: if one already exists, it is reused.

### Creating additional tokens

Use `kici-admin token create` to issue tokens with specific roles:

```bash
kici-admin token create ci-operator --role admin
kici-admin token create compliance-bot --role auditor
```

## Global options

| Option                  | Env var            | Default                 | Description            |
| ----------------------- | ------------------ | ----------------------- | ---------------------- |
| `--url <url>`, `-u`     | `KICI_ADMIN_URL`   | `http://localhost:8080` | Orchestrator HTTP URL  |
| `--token <token>`, `-t` | `KICI_ADMIN_TOKEN` | (required)              | Admin API Bearer token |
| `-V`, `--cli-version`   |                    |                         | Show CLI version       |

Running `--help` on any command works without a token.

## RBAC roles

Tokens are assigned one of three roles. The role determines which admin API operations are permitted:

| Permission             | owner | admin | auditor |
| ---------------------- | ----- | ----- | ------- |
| context.create         | yes   | yes   |         |
| context.read           | yes   | yes   | yes     |
| context.update         | yes   | yes   |         |
| context.delete         | yes   | yes   |         |
| secret.read            | yes   | yes   |         |
| secret.write           | yes   | yes   |         |
| secret.delete          | yes   | yes   |         |
| secret.reveal          | yes   | yes   |         |
| audit.read             | yes   | yes   | yes     |
| run.read               | yes   | yes   | yes     |
| run.cancel             | yes   | yes   |         |
| event_log.read         | yes   | yes   | yes     |
| event_log.read_payload | yes   | yes   |         |
| access_log.read        | yes   | yes   | yes     |
| scheduled_job.trigger  | yes   | yes   |         |
| event_dlq.read         | yes   | yes   | yes     |
| event_dlq.manage       | yes   | yes   |         |
| token.manage           | yes   |       |         |
| key.rotate             | yes   |       |         |

`secret.reveal` is the additional gate for `kici-admin runs secret-outputs --reveal`: decrypting stored secret-output values and returning plaintext is strictly narrower than generic "read a secret", so owner + admin roles carry it explicitly and auditor tokens are rejected with 403.

- **owner** -- full access. Use for bootstrap and token management.
- **admin** -- day-to-day operations (secrets, sources, config). Cannot manage tokens or rotate keys.
- **auditor** -- read-only access to contexts, audit logs, and run status. Cannot read secret values.

> **Note:** These roles govern the orchestrator admin API only. They are entirely separate from the SaaS dashboard RBAC system (org member roles, custom roles, permission matrices) which is managed through the dashboard UI and applies to OIDC-authenticated users.

## Command reference

### access-log -- read / admin-mutation attribution log

```bash
kici-admin access-log list [--org-id <orgId>] [--actor-type <t>] [--actor-id <id>] [--action <action>] [--source <s>] [--outcome <o>] [--target-type <t>] [--target-id <id>] [--from <ts>] [--to <ts>] [--q <text>] [--limit <n>] [--cursor <c>] [--json]
kici-admin access-log show <id> [--json]
```

Operator-facing read access to the orchestrator's `access_log` table — every read / admin-mutation attributed to an `ActorPrincipal` (user, api_key, service_account, platform_operator, system). Dogfood replacement for raw `psql` when an operator asks "who read this run's payload last Tuesday" or "show me everything a platform_operator actor did".

**access-log list:**

| Option          | Default | Description                                                                                    |
| --------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `--org-id`      |         | Filter by org/tenant ID                                                                        |
| `--actor-type`  |         | Filter by actor type (`user` / `api_key` / `service_account` / `platform_operator` / `system`) |
| `--actor-id`    |         | Filter by actor id (zsub, keyId, service_account id, ...)                                      |
| `--action`      |         | Filter by dotted action (e.g. `run.detail.read`, `run.cancel`)                                 |
| `--source`      |         | Filter by source (`platform_proxy` / `admin_http` / `admin_cli`)                               |
| `--outcome`     |         | Filter by outcome (`allowed` / `denied` / `error`)                                             |
| `--target-type` |         | Filter by target type (`run` / `step` / `event_log` / `secret_scope` / ...)                    |
| `--target-id`   |         | Filter by target id                                                                            |
| `--from`        |         | ISO timestamp lower bound (inclusive)                                                          |
| `--to`          |         | ISO timestamp upper bound (exclusive)                                                          |
| `--q`           |         | Filter by substring of `error_message` (trigram-indexed full-text search)                      |
| `--limit`       | `50`    | Max results (max 200)                                                                          |
| `--cursor`      |         | Opaque cursor from a previous `nextCursor`                                                     |
| `--json`        |         | Emit raw JSON instead of a table                                                               |

**access-log show:**

| Option   | Description                                   |
| -------- | --------------------------------------------- |
| `<id>`   | Access-log entry ID (required positional arg) |
| `--json` | Emit raw JSON instead of formatted output     |

Output includes actor (type + id + optional metadata), action, source, outcome, target (if any), request ID, and timestamps.

### agent -- agent token management and service lifecycle

**Token management:**

```bash
kici-admin agent register [--labels <labels>]
kici-admin agent list [--type static|ephemeral] [--include-pending] [--database-url <url>] [--json]
kici-admin agent revoke <id>
```

- `register` creates a static agent token. The token is shown once -- save it and set `KICI_AGENT_TOKEN` on the agent.
- `--labels` accepts comma-separated labels (e.g., `linux,x64,gpu`) for label-based routing.
- `list --include-pending` (HTTP mode only) additionally shows agents that have connected via WS but have not yet completed registration. Pending state is in-memory on the orchestrator, so direct-DB mode cannot surface it.
- `list --database-url` switches to offline direct-DB mode, reading `agent_tokens` directly (pending agents are not visible).

**Service lifecycle:**

```bash
kici-admin agent install [--wizard] [--platform systemd|launchd|windows|compose] [--env-file <path>] [--binary <path>] [--name <name>] [--instance-dir <path>] [--force] [--orchestrator-url <url>] [--token <token>] [--labels <labels>]
kici-admin agent uninstall [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent start [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent stop [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent restart [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin agent status [--platform <type>] [--instance-dir <path>] [--name <name>] [--json]
kici-admin agent logs [--platform <type>] [--instance-dir <path>] [--name <name>] [--since <duration>] [--level <level>] [--json] [--no-follow]
kici-admin agent upgrade [--from <path>] [--url <url>] [--version <version>] [--cleanup] [--rollback] [--yes] [--force] [--platform <type>] [--instance-dir <path>] [--name <name>]
```

These commands manage the agent as a native system service. The `install --wizard` flow walks through orchestrator URL, agent token, and labels configuration. Lifecycle targeting is folder-anchored — see [Service installation guide](../distribution/service-installation.md) for platform-specific details and the full description of the manifest, the instance index, and the name-scoped on-disk layout.

**Install options:**

| Option                     | Default            | Description                                                                           |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `--wizard`                 |                    | Interactive wizard for guided setup                                                   |
| `--platform <type>`        | auto-detected      | Service platform: `systemd`, `launchd`, `windows`, `compose`                          |
| `--env-file <path>`        |                    | Path to existing env/config file to use                                               |
| `--binary <path>`          | current executable | Path to agent binary                                                                  |
| `--name <name>`            | `kici-agent`       | Service name (also the per-instance directory segment under config/log/install roots) |
| `--instance-dir <path>`    | current directory  | Deploy folder where `.kici-agent.json` is written and resolved from                   |
| `--force`                  |                    | Overwrite a same-named instance already installed at a different `--instance-dir`     |
| `--orchestrator-url <url>` |                    | URL of the orchestrator to connect to                                                 |
| `--token <token>`          |                    | Agent authentication token                                                            |
| `--labels <labels>`        |                    | Comma-separated agent labels for routing                                              |

**Upgrade options (agent):**

| Option                  | Default       | Description                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------- |
| `--from <path>`         |               | Path to package archive (`.tar.gz` or `.zip`)                     |
| `--url <url>`           |               | URL to download package archive from                              |
| `--version <version>`   |               | Target version string (e.g., `0.3.0`)                             |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`      |
| `--instance-dir <path>` |               | Deploy folder of the instance to upgrade                          |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest) |
| `--yes`                 |               | Skip confirmation prompt                                          |
| `--force`               |               | Overwrite existing versioned directory                            |
| `--cleanup`             |               | Remove old versions (keeps current and previous)                  |
| `--rollback`            |               | Roll back to the previous version                                 |

**Status options (agent):**

| Option                  | Default       | Description                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------- |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`      |
| `--instance-dir <path>` |               | Deploy folder of the instance                                     |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest) |
| `--json`                |               | Output as JSON                                                    |

**Logs options (agent):**

| Option                  | Default       | Description                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------- |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`      |
| `--instance-dir <path>` |               | Deploy folder of the instance                                     |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest) |
| `--since <duration>`    |               | Show logs since duration (e.g., `1h`, `30m`)                      |
| `--level <level>`       |               | Filter by log level: `error`, `warn`, `info`                      |
| `--json`                |               | Output as structured JSON                                         |
| `--no-follow`           |               | Snapshot mode (do not tail)                                       |

Every lifecycle command (`uninstall`, `upgrade`, `start`, `stop`, `restart`, `status`, `logs`) resolves its target through the priority chain `--instance-dir` > `--name` > manifest in the current working directory. A bare `kici-admin agent <cmd>` outside any deploy folder with no flags refuses non-zero and prints the candidate list of installed agent instances on the host.

### api-key -- API key management

```bash
kici-admin api-key create [--label <label>] [--routing-keys <keys>]
kici-admin api-key add-routing-key <id> <pattern>
```

- Creates API keys for orchestrator-to-Platform authentication.
- `--routing-keys` accepts comma-separated routing key patterns (e.g., `github:42,github:99`).
- The key is shown once on creation -- save it immediately.

### audit -- secrets audit log

```bash
kici-admin audit [--context <name>] [--action <action>] [--from <date>] [--to <date>] [--limit <n>] [--offset <n>]
```

Queries the secrets operation audit log. All date filters use ISO 8601 format. Default limit is 100.

### backend -- secret backend management

```bash
kici-admin backend add <name> --type <pg|vault> [options]
kici-admin backend remove <name> [--yes]
kici-admin backend list
kici-admin backend test [name] [--type <pg|vault> options]
kici-admin backend sync [name]
kici-admin backend purge-stale [--database-url <url>] [--json]
```

Manages external secret backends (PostgreSQL or Vault/OpenBao) for multi-source secret resolution.

- `add <name>` registers a new backend. `--type` is required (`pg` or `vault`).
- `remove <name>` deregisters a backend and makes its scopes unavailable. Prompts for confirmation unless `--yes` is passed.
- `list` shows all registered backends with health status, scope count, last sync time, and sync interval.
- `test [name]` tests connectivity of a named backend. Alternatively, pass `--type` with inline config options to test without registering.
- `sync [name]` triggers scope discovery. Omit the name to sync all backends.
- `purge-stale` (direct-DB only) deletes backends whose encrypted config can no longer be decrypted (e.g. after losing `KICI_SECRET_KEY`). Break-glass bootstrap verb that must run **before** the orchestrator starts, because `BackendRegistry.loadAllStores()` would otherwise crash on the stale row. Accepts `--database-url` (or `KICI_DATABASE_URL`) and `--json` for `{ deleted }` output.

**Vault options** (for `add` and `test`):

| Option             | Env var                  | Description                               |
| ------------------ | ------------------------ | ----------------------------------------- |
| `--vault-url`      | `KICI_BACKEND_VAULT_URL` | Vault/OpenBao URL (required)              |
| `--auth-method`    |                          | `approle` (default) or `token`            |
| `--role-id`        | `KICI_BACKEND_ROLE_ID`   | AppRole role ID (required for approle)    |
| `--secret-id`      | `KICI_BACKEND_SECRET_ID` | AppRole secret ID (required for approle)  |
| `--secret-id-file` |                          | Read secret ID from file (avoids history) |
| `--token`          | `KICI_BACKEND_TOKEN`     | Vault token (required for token auth)     |
| `--namespace`      |                          | Vault namespace                           |
| `--mount-path`     |                          | Vault mount path (default: `secret`)      |
| `--base-path`      |                          | Vault base path for secrets               |

**PostgreSQL options** (for `add` and `test`):

| Option                | Env var               | Description                     |
| --------------------- | --------------------- | ------------------------------- |
| `--connection-string` | `KICI_BACKEND_PG_URL` | PG connection string (required) |

**Common options** (for `add`):

| Option            | Default  | Description                        |
| ----------------- | -------- | ---------------------------------- |
| `--scope-filter`  | `**`     | Scope filter glob pattern          |
| `--sync-interval` | `300000` | Sync interval in milliseconds (5m) |

### cluster-name -- orchestrator cluster identity

```bash
kici-admin cluster-name get [--format json|table]
kici-admin cluster-name set <name> [--format json|table]
```

Manages this orchestrator's human-friendly cluster name — the identifier that surfaces on Platform's connection registry and in the dashboard's per-orch URL segment.

- `get` prints the current cluster name plus a `looksAutoGenerated` flag indicating whether it's still the default placeholder.
- `set <name>` renames the cluster. Mutating it requires admin access (RBAC `secret.write`). The response reports the prior value and a `reconnectRequired` flag — restart the orchestrator (or run `kici-admin orchestrator-service restart`) to publish the new name to Platform.

Talks to the orchestrator admin API directly (not the Platform dashboard proxy) so the CLI stays operable even when Platform is unavailable.

### cold-store -- cold-storage archive inspection (direct-DB break-glass)

```bash
kici-admin cold-store archive-now <table> [--database-url <url>]
kici-admin cold-store dry-run-archive <table> [--tenant <rk>] [--from <date>] [--to <date>] [--database-url <url>]
kici-admin cold-store list-chunks <table> [--tenant <rk>] [--missing-data] [--missing-manifest] [--from <date>] [--to <date>] [--database-url <url>]
kici-admin cold-store verify-chunk <chunkId> --table <table> --tenant <rk> --partition-date <YYYY-MM-DD> [--database-url <url>]
kici-admin cold-store replay-chunk <chunkId> --table <table> --tenant <rk> --partition-date <YYYY-MM-DD> [--database-url <url>]
kici-admin cold-store replay-into-pg <chunkId> --table <table> --tenant <rk> --partition-date <YYYY-MM-DD> [--database-url <url>]
kici-admin cold-store reconcile <table> [--tenant <rk>] [--confirm-cleanup] [--database-url <url>]
kici-admin cold-store list-purgeable [--table <table>] [--bucket <bucket>] [--limit <n>] [--database-url <url>]
kici-admin cold-store purge-now [--table <table>] [--bucket <bucket>] [--limit <n>] [--apply] [--database-url <url>]
kici-admin cold-store peek-chunk <chunkId> --table <table> --tenant <rk> --partition-date <YYYY-MM-DD> [--limit <n>] [--database-url <url>]
```

Inspects and operates the orchestrator-side cold-storage archival. Every subcommand talks **directly** to the orchestrator Postgres + the same S3 bucket the running process uses — there is no HTTP path because each verb is a break-glass inspection of bytes that don't belong to the running process. Pass `--database-url` or set `KICI_DATABASE_URL`.

- `archive-now <table>` runs one archive cycle synchronously for a single registered adapter.
- `dry-run-archive <table>` shows what would be archived without writing to S3 or PG. `--tenant` scopes to a single routing key; `--from` / `--to` bound the partition column.
- `list-chunks <table>` lists archived chunks (one JSON object per line). `--missing-data` / `--missing-manifest` filter to chunks whose data file or manifest is gone from object storage.
- `verify-chunk <chunkId>` recomputes the gzipped `contentHash` and compares to the manifest. Exit 1 on mismatch, 0 on match.
- `replay-chunk <chunkId>` re-runs the UPDATE+DELETE+audit step for a chunk that landed in S3 but not in PG (recovery for a crash mid-archive).
- `replay-into-pg <chunkId>` promotes every row in a chunk back into orchestrator PG, clearing `archived_at` and writing a replay audit entry. Used when an archived chunk needs to be brought back into hot storage for inspection or re-processing.
- `reconcile <table>` walks the S3 prefix and rebuilds missing manifests from data files. `--confirm-cleanup` additionally deletes `chunk_counts` rows whose S3 objects are gone.
- `list-purgeable` (read-only) lists chunks past their cold-retention horizon. `--table` filters to a single adapter, `--bucket` scopes to a single cold-bucket (`30d` / `180d` / `1y` / `2y`), `--limit` caps candidates inspected (default 1000).
- `purge-now` deletes expired chunks from S3 + PG bookkeeping. **Defaults to dry-run** — pass `--apply` to actually delete. Same `--table` / `--bucket` / `--limit` filters as `list-purgeable`.
- `peek-chunk <chunkId>` streams the first N rows of a chunk to stdout (default `--limit 10`) for debugging.

### config -- orchestrator configuration

```bash
kici-admin config init [--output <path>]           # Generate starter orchestrator.yaml
kici-admin config seed --file <path> [--description <desc>] [--format json|yaml|table]
kici-admin config get [path] [--format json|yaml|table]
kici-admin config set <path> <value> [--description <desc>] [--format json|yaml|table]
kici-admin config delete <path> [--description <desc>] [--format json|yaml|table]
kici-admin config export [--format json|yaml]
kici-admin config validate --file <path> [--type local|shared|full (default: shared)] [--offline] [--format json|yaml|table]
kici-admin config diff [--format json|yaml|table]
kici-admin config history [--limit <n> (default: 20)] [--format json|yaml|table]
kici-admin config rollback --to <version> [--format json|yaml|table]
kici-admin config reload [--drain] [--target <instance-id>] [--format json|yaml|table]
```

- `seed` imports a YAML file as the shared config. Sensitive values can be injected from environment variables (`KICI_PLATFORM_TOKEN`, `KICI_SECRET_KEY`, `KICI_BOOTSTRAP_ADMIN_TOKEN`, `KICI_CLUSTER_JOIN_TOKEN`).
- `get` returns the effective config (merged local YAML + shared DB + env vars). Pass a dotted path to get a single field.
- `validate --offline` works without a running orchestrator (validates against local schemas).
- `diff` compares local YAML config vs shared DB config.
- `reload` triggers a hot reload across the cluster. Use `--drain` to drain in-flight work first.
- `init` generates a commented `orchestrator.yaml` template.

For full configuration details, see [Configuration management](config-management.md).

### db -- database management

```bash
kici-admin db migrate            # Run pending migrations (HTTP — orchestrator must be up)
kici-admin db migrate --status   # Show migration status without applying

# Infrastructure operations (direct DB — use --database-url or KICI_DATABASE_URL).
# These cannot go through HTTP because the target DB may not exist yet or is about to be dropped.
kici-admin db fresh --confirm [--yes]                          # DROP + CREATE + migrate + record content hash
kici-admin db ensure <name>                                    # CREATE DATABASE IF NOT EXISTS
kici-admin db create-role --user <name> --password <pw> [--createdb]
kici-admin db create-readonly-user --user <name> --password <pw>
kici-admin db check-schema [--json]                            # Exit 2 on migration drift
kici-admin db collation-check [--database-url <url>] [--json]   # Exit 2 on collation drift
kici-admin db reindex --confirm --reason <text> [--database-url <url>]
kici-admin db refresh-collation-version --reason <text> [--database-url <url>]
```

- `migrate` goes through the orchestrator HTTP admin API (orchestrator auto-migrates on startup by default; set `KICI_AUTO_MIGRATE=false` to disable and run manually). Every successful migration run records the bundled-migration content hash in `_migration_content_hash` — including warm runs that apply zero migrations — so `check-schema` reports the schema as current on a long-lived database whose migrations are already up to date.
- `fresh` / `ensure` / `create-role` / `create-readonly-user` / `check-schema` / `collation-check` / `reindex` / `refresh-collation-version` open their own pool and run SQL directly — needed for deploy / bootstrap / DR workflows.
- `fresh` prompts for the target database name as a confirmation. Pass `--yes` to skip the prompt (scripted use).
- `check-schema` compares the bundled migration manifest (names + body hash) against the live schema and the stored `_migration_content_hash` marker. Exit code 2 means drift — call `fresh` or run `migrate` depending on intent.
- `collation-check` compares `pg_database.datcollversion` against the running libc collation version. Exit code 2 means the stamped and actual collation versions differ — a libc upgrade changed sort order out from under existing indexes.
- `reindex` runs `REINDEX DATABASE CONCURRENTLY`, rebuilding every index under the current libc collation rules. Non-blocking but takes minutes and roughly 2× temporary disk. Requires `--confirm` and `--reason`.
- `refresh-collation-version` runs `ALTER DATABASE … REFRESH COLLATION VERSION` — a metadata-only bump that clears the drift warning. Pair it with `db reindex` after a libc-base image rebuild so the indexes match the new collation. Requires `--reason`.

### debug-bundle -- diagnostic bundle

```bash
kici-admin debug-bundle [-o <path>] [--log-dir <path>] [--log-window <hours>]
```

Generates a ZIP bundle containing sanitized diagnostics, config (redacted), system info, cluster health, Prometheus metrics, and recent log files. Default output filename: `kici-debug-<ISO-timestamp>.zip`.

- `--log-dir` defaults to `$KICI_LOG_DIR`. When set, every `*.log` file in that directory newer than the window is added under `logs/` in the ZIP along with a `logs/summary.json`. Run the command from the same environment as the orchestrator (same unit / container / env file) so `$KICI_LOG_DIR` resolves to the right path automatically.
- `--log-window` controls how many hours of rotated files to include (default 4). Total log payload is capped at 50 MB — excess files are dropped, most recent first.

Useful for sharing with support.

#### Fleet-wide collection

```bash
kici-admin debug-bundle --fleet [-o <path>] [--log-window <hours>]
                                [--pick [<selectors>]] [--fleet-timeout <seconds>]
kici-admin debug-bundle --fleet --list [--json]
```

Plain `debug-bundle` assembles a bundle for the single orchestrator the CLI talks to. Add `--fleet` to collect logs and diagnostics from **every node in the cluster** — the orchestrator you hit, every coordinator-mesh peer, every worker, and every connected agent — in one pass. The orchestrator drives the collection over the existing authenticated WebSocket channels and streams a single nested ZIP back; the CLI writes it to `-o`. No SSH into each host required, and it works on any topology (a single-node deployment collapses to just `local/` + `agents/`).

The bundle is a tree of self-contained ZIPs, one per node:

```
fleet-bundle.zip
├── local/bundle.zip            # the collector orchestrator's own bundle
├── agents/<agentId>.zip        # each connected agent's logs + system info + metrics
├── workers/<instanceId>.zip    # each worker's subtree (nested)
├── peers/<instanceId>.zip      # each coordinator-mesh peer's subtree (nested)
└── fleet-manifest.json         # per-node status: ok | timeout | error | unreachable
```

Each remote node redacts its own config before sending, so secrets never leave their source node — the same posture as the local bundle. Extract the outer ZIP and drill into whichever node's nested ZIP you need.

- `--list` enumerates the fleet (instance ids, roles, hostnames, connected agents) and exits without collecting anything. Add `--json` for machine-readable output to feed into scripts.
- `--pick <selectors>` restricts collection to specific nodes. Selectors are comma-separated and match by exact instance/agent id, a hostname glob (`host-*`), or an agent label (`label:env=prod`). Unselected branches are never contacted. On a terminal, a bare `--pick` (no value) opens an interactive checkbox over the enumerated topology. With no `--pick` at all, every node is collected.
- `--fleet-timeout <seconds>` sets the per-node deadline (default 60). A node that doesn't answer in time is recorded in `fleet-manifest.json` with status `timeout` and never blocks its siblings — a partial bundle is always returned.
- `--log-window` propagates to every node so each one includes the same window of log history.

Prefer running `--fleet` against a **coordinator** (single-node deployments are coordinators). A worker cannot see the coordinator mesh, so it forwards the request up to its coordinator and relays the assembled result back.

### diagnose -- health diagnostics

```bash
kici-admin diagnose [--json]
```

Runs health checks against the orchestrator and displays a colorized summary table. Exit codes:

- `0` -- all checks pass
- `1` -- one or more warnings
- `2` -- one or more failures

For each configured scaler backend, `diagnose` emits a `scaler:<name>` row reporting recent agent spawn failures over the last 5 minutes:

- **pass** -- no spawn failures in the window.
- **warn** -- only warm-pool (prewarm) spawns failed; no queued run was affected yet.
- **fail** -- at least one job-bound spawn failed, meaning a queued run could not get an agent. The row message shows the failure count, the bound/warm-pool split, and the most recent captured error (e.g. a missing container image or a bad bare-metal binary path).

These rows fold into the command's exit code (0 pass / 1 warn / 2 fail) like every other check. The window is in-process, so it resets when the orchestrator restarts.

### environment -- environment management (dual-mode)

```bash
kici-admin environment create --org <id> --name <name> [--type fixed|glob|template] [--glob-pattern <pattern>] [--enabled true|false] [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted] [--database-url <url>] [--json]
kici-admin environment bind --org <id> --env <name> --scope <pattern> [--database-url <url>] [--json]
kici-admin environment set-policy --org <id> --env <name> [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted|null] [--enabled true|false] [--database-url <url>] [--json]
kici-admin environment list --org <id> [--database-url <url>] [--json]
kici-admin environment show --org <id> --name <name> [--database-url <url>] [--json]
kici-admin environment delete --org <id> --name <name> [--database-url <url>] [--json]
kici-admin environment create-template --org <id> --template <name> [--type template] [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted] [--variables <json>] [--database-url <url>] [--json]
```

Seeds and mutates environment rows (plus their variables and scope bindings). Defaults to the orchestrator admin API; pass `--database-url` (or set `KICI_DATABASE_URL`) to run the SQL directly — used by E2E `globalSetup` helpers that need to seed envs before the orchestrator is up.

- `create` upserts an environment (idempotent by `org + name`). Omit a policy flag to leave it unset. `--glob-pattern` is required when `--type glob` and sets the match pattern that resolves run scopes to this environment; passing it with any other `--type` is an error.
- `bind` upserts an `environment_bindings` row mapping a scope pattern to an environment.
- `set-policy` updates only the provided policy fields on an existing environment. Pass `--minimum-trust null` to clear the tier gate.
- `list` / `show` read back the current state; `show` also returns variables and bindings.
- `delete` removes an environment and cascades its bindings, variables, and overrides. Reports `deleted=true` on success and exits non-zero if no matching environment exists. Pending held runs block the deletion with a clear error (HTTP mode returns 409) — approve or reject them first; resolved held-run history survives the deletion with its environment reference cleared.
- `create-template` creates/updates a template environment and seeds its variables in one call (`--variables '{"K":"V"}'`).

See [Environments](../environments.md) for the broader feature walkthrough.

### event -- internal event emission

```bash
kici-admin event emit <name> --payload-file <path> [--source-routing-key <k>] [--source-repo <r>] [--database-url <url>] [--json]
```

Inserts a row into `kici_events` and fires `pg_notify('kici_event_channel', <id>)` so the orchestrator's `EventRouter` picks it up immediately. Dogfooded landing pad for `e2e/helpers/internal-webhook.ts#emitInternalEvent()` — simulates what an agent's `ctx.emit()` does from within a step execution. Dual-mode: HTTP (`POST /api/v1/admin/events/emit`) or direct DB via `emitKiciEventDirect` from `@kici-dev/shared`.

- `<name>` is the event name (e.g. `deploy.completed`).
- `--payload-file` is required and must contain a JSON object (not an array).
- `--source-routing-key` / `--source-repo` are optional hints for cross-repo event matching.

### event-dlq -- event dead-letter queue triage

```bash
kici-admin event-dlq list [--limit <n>] [--before <iso>] [--json]
kici-admin event-dlq count
kici-admin event-dlq retry <id>
kici-admin event-dlq discard <id>
```

Operator triage surface for at-least-once event delivery. When an event lands in the DLQ it usually means a workflow handler is consistently failing and should be fixed at its root cause; this CLI is the path to inspect `last_error`, retry once a fix is deployed, or discard if the event is no longer relevant.

- `list` shows DLQ events most-recent-first with id, event name, reason, attempts, source repo / routing key, and a truncated `last_error`. `--before <iso>` paginates via the `dlq_at` cursor (echoed as `Next page: --before "<ts>"`); `--limit` caps rows (default 50, max 200).
- `count` prints the total number of events currently in the DLQ — handy for monitoring / alerting.
- `retry <id>` clears the DLQ flag, resets the attempts counter, and `pg_notify`s the `EventRouter` to schedule the event for immediate retry.
- `discard <id>` permanently deletes the row.

### event-log -- inbound webhook delivery log

```bash
kici-admin event-log list [--org <orgId>] [--routing-key <key>] [--event <type>] [--status <s>] [--from <ts>] [--to <ts>] [--delivery-id <substr>] [--limit <n>] [--offset <n>] [--include-archived] [--json]
kici-admin event-log show <deliveryId> --org <orgId> [--include-payload] [--routing-key <key>] [--json]
```

Operator-facing read access to the orchestrator's `event_log` table — every inbound webhook delivery (relay or direct) the orchestrator has seen, with metadata + a pointer to the gzipped payload in object storage.

**event-log list:**

| Option               | Default | Description                                                                                                     |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `--org`              |         | Filter by org/tenant ID                                                                                         |
| `--routing-key`      |         | Filter by routing key (e.g. `github:42`)                                                                        |
| `--event`            |         | Filter by event type (e.g. `push`, `pull_request`)                                                              |
| `--status`           |         | Filter by outcome (`received` / `processed` / `duplicate` / `lockfile_missing` / `failed`)                      |
| `--from`             |         | ISO timestamp lower bound (inclusive)                                                                           |
| `--to`               |         | ISO timestamp upper bound (exclusive)                                                                           |
| `--delivery-id`      |         | Substring filter on `delivery_id`                                                                               |
| `--limit`            | `50`    | Max results (max 200)                                                                                           |
| `--offset`           | `0`     | Skip first N results                                                                                            |
| `--include-archived` | off     | Merge cold-store archived rows into the result. Requires `--routing-key` so the cold scan can be tenant-scoped. |
| `--json`             |         | Emit raw JSON instead of a table                                                                                |

**event-log show:**

| Option              | Description                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `<deliveryId>`      | Delivery ID to inspect (required positional arg)                                                                        |
| `--org`             | Org/tenant ID for the delivery (required)                                                                               |
| `--include-payload` | Also fetch the payload body (requires `event_log.read_payload` on the token)                                            |
| `--routing-key`     | Routing key hint that scopes the cold-store fallback when the delivery is no longer in PG (archived past the warm TTL). |
| `--json`            | Emit raw JSON instead of formatted text                                                                                 |

Output includes routing key, event/action, source (relay/direct), provider, repo, ref, status, matched workflow count, first run spawned, error message (if failed), received-at, archived-at (when the row has been moved to cold-store), payload size + hash, and (with `--include-payload`) the JSON body.

**Retention model:** rows older than 30 days are archived to S3 instead of being hard-deleted, so the cold tail is effectively forever. Set `--include-archived` on `list` (and pass `--routing-key`) to fold the cold tail into a list query; `show` always tries cold on PG miss when `--routing-key` is supplied. The orch retains the per-row gzipped webhook payload at `event-log/<orgId>/<deliveryId>.json.gz` indefinitely, so `--include-payload` continues to work for archived deliveries.

**RBAC tokens for these commands:** the bearer token's role must include `event_log.read` (all roles get this by default — owner, admin, auditor) for `list` / `show`, and additionally `event_log.read_payload` (owner, admin only — NOT auditor) for `show --include-payload`.

### execution -- execution read + maintenance

```bash
kici-admin execution list [--routing-key <k>] [--status <s>] [--workflow-name <n>] [--limit <n>] [--database-url <url>] [--json]
kici-admin execution show <runId> [--database-url <url>] [--json]
kici-admin execution purge-stale --routing-key <key> --confirm
kici-admin execution purge-stale --routing-key <key> --confirm --database-url $URL
```

- `list` / `show` are read-only inspection verbs over `execution_runs` / `execution_jobs` (dual-mode).
- `purge-stale` deletes `execution_runs` + `execution_jobs` whose `routing_key` differs from the current cluster (or is NULL). Used by redeploy workflows that move a cluster to a new `routing_key` — leftover rows from the previous key would otherwise violate FK constraints on restart.

### firecracker -- host networking provisioning

```bash
kici-admin firecracker provision [--bridge <name>] [--cidr <cidr>] [--table <name>] [--host-iface <iface>] [--persist] [--sudo]
kici-admin firecracker verify [--bridge <name>] [--cidr <cidr>] [--table <name>] [--sudo]
kici-admin firecracker teardown [--bridge <name>] [--cidr <cidr>] [--table <name>] [--sudo]
```

Provisions and verifies the host-side bridge interface + NAT/egress-isolation rules a Firecracker scaler needs. These commands run on the Firecracker host (not against the orchestrator HTTP API) and typically require root — pass `--sudo` to wrap the privileged steps with `sudo -n` on a non-root host.

- `provision` creates or heals a host bridge with a gateway address, NAT egress, and an nftables table. `--cidr` sets the gateway IP + prefix (e.g. `10.0.0.1/24`); `--host-iface` names the NAT egress interface (auto-detected when omitted). Pass `--persist` to install a systemd oneshot so the bridge survives a reboot.
- `verify` checks that the named bridge is up with its address and nft table present. Use it after `provision` (or in a health check) to confirm host networking.
- `teardown` removes the bridge interface and its nft table. It deliberately leaves the NetworkManager unmanaged-interface conf file in place, because that file is host-scoped and protects every `kici-*` interface on the host — removing it would let NetworkManager adopt the other bridges and strip their gateway IPs.

| Option         | Default       | Description                                                                |
| -------------- | ------------- | -------------------------------------------------------------------------- |
| `--bridge`     |               | Bridge interface name (e.g. `kici-br0`)                                    |
| `--cidr`       |               | Gateway IP + prefix (e.g. `10.0.0.1/24`)                                   |
| `--table`      | `kici`        | nftables table name                                                        |
| `--host-iface` | auto-detected | NAT egress interface (`provision` only)                                    |
| `--persist`    |               | Install a systemd oneshot so the bridge survives reboot (`provision` only) |
| `--sudo`       |               | Wrap privileged commands with `sudo -n` (non-root host)                    |

See [Firecracker host setup](firecracker-host-setup.md) and the [Firecracker scaler backend](auto-scaler/firecracker.md) for the full host-networking walkthrough.

### host -- host roster (declared inventory)

```bash
kici-admin host list [--json]
kici-admin host get --agent-id <id> [--json]
kici-admin host declare --agent-id <id> [--labels <labels>] [--hostname <name>]
```

- `list` / `get` read the durable host roster and report each host's derived status (`ready` / `unreachable` / `stale`) from the shared last-seen + connected-instance columns.
- `declare` pre-declares a `static` host before its agent connects — until the agent dials in, the host reads `unreachable`, making "expected but not yet here" a visible state.

These commands read and write the orchestrator database directly (set `KICI_DATABASE_URL`). See [Host roster (declared inventory)](./host-roster.md) for the full model, derived-status table, and the `KICI_ROSTER_GRACE_MS` / `KICI_ROSTER_TTL_MS` timing knobs.

### inspect-bundle -- bundle analysis (offline)

```bash
kici-admin inspect-bundle <path>
```

Parses a previously created debug bundle and displays a structured, colorized summary. Works fully offline -- no running orchestrator needed.

### join -- cluster bootstrap

```bash
kici-admin join --token <join-token> --platform <wss://...> --api-key <key>
kici-admin join --token <join-token> --peer <https://orch-1:8080>
```

Bootstraps a new orchestrator into an existing cluster. Connects via Platform relay or direct peer, receives an encrypted config bundle, and writes the local YAML config.

- `--config <path>` sets the output path for the generated config (default: `./kici-orchestrator.yaml`).

### orchestrator -- service lifecycle

```bash
kici-admin orchestrator install [--wizard] [--platform systemd|launchd|windows|compose] [--env-file <path>] [--binary <path>] [--dev] [--name <name>] [--instance-dir <path>] [--force]
kici-admin orchestrator uninstall [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin orchestrator start [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin orchestrator stop [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin orchestrator restart [--platform <type>] [--instance-dir <path>] [--name <name>]
kici-admin orchestrator status [--platform <type>] [--instance-dir <path>] [--name <name>] [--json]
kici-admin orchestrator logs [--platform <type>] [--instance-dir <path>] [--name <name>] [--since <duration>] [--level <level>] [--json] [--no-follow]
kici-admin orchestrator upgrade [--from <path>] [--url <url>] [--version <version>] [--cleanup] [--rollback] [--yes] [--force] [--platform <type>] [--instance-dir <path>] [--name <name>]
```

Manages the orchestrator as a native system service. The `install --wizard` flow handles database setup, encryption key generation, Platform credentials, and optionally adding your first source. Lifecycle targeting is folder-anchored — see [Service installation guide](../distribution/service-installation.md) for platform-specific details and the full description of the manifest, the instance index, and the name-scoped on-disk layout.

**Install options:**

| Option                  | Default             | Description                                                                           |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| `--wizard`              |                     | Interactive wizard for guided setup                                                   |
| `--platform <type>`     | auto-detected       | Service platform: `systemd`, `launchd`, `windows`, `compose`                          |
| `--env-file <path>`     |                     | Path to existing env/config file to use                                               |
| `--binary <path>`       | current executable  | Path to orchestrator binary                                                           |
| `--dev`                 |                     | Dev mode: spin up PostgreSQL container on port 15432                                  |
| `--name <name>`         | `kici-orchestrator` | Service name (also the per-instance directory segment under config/log/install roots) |
| `--instance-dir <path>` | current directory   | Deploy folder where `.kici-orchestrator.json` is written and resolved from            |
| `--force`               |                     | Overwrite a same-named instance already installed at a different `--instance-dir`     |

**Upgrade options (orchestrator):**

| Option                  | Default       | Description                                                               |
| ----------------------- | ------------- | ------------------------------------------------------------------------- |
| `--from <path>`         |               | Path to package archive (`.tar.gz` or `.zip`)                             |
| `--url <url>`           |               | URL to download package archive from                                      |
| `--version <version>`   |               | Target version string (e.g., `0.3.0`)                                     |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`              |
| `--instance-dir <path>` |               | Deploy folder of the instance to upgrade                                  |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest)         |
| `--yes`                 |               | Skip confirmation prompt                                                  |
| `--force`               |               | Overwrite existing versioned directory                                    |
| `--cleanup`             |               | Remove old versions of the resolved instance (keeps current and previous) |
| `--rollback`            |               | Roll back the resolved instance to its previous version                   |

The `upgrade` command uses a name-scoped versioned directory layout: new versions are extracted under the resolved instance's own `<installBase>/<name>/` tree alongside old ones, and a per-instance symlink is atomically switched. Other installed instances on the host are not touched. Use `--rollback` to revert to the previous version and `--cleanup` to remove old versions (keeping current and previous).

**Status options:**

| Option                  | Default       | Description                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------- |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`      |
| `--instance-dir <path>` |               | Deploy folder of the instance                                     |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest) |
| `--json`                |               | Output as JSON                                                    |

**Logs options:**

| Option                  | Default       | Description                                                       |
| ----------------------- | ------------- | ----------------------------------------------------------------- |
| `--platform <type>`     | auto-detected | Service platform: `systemd`, `launchd`, `windows`, `compose`      |
| `--instance-dir <path>` |               | Deploy folder of the instance                                     |
| `--name <name>`         |               | Service name (no default — must resolve via flag or CWD manifest) |
| `--since <duration>`    |               | Show logs since duration (e.g., `1h`, `30m`)                      |
| `--level <level>`       |               | Filter by log level: `error`, `warn`, `info`                      |
| `--json`                |               | Output as structured JSON                                         |
| `--no-follow`           |               | Snapshot mode (do not tail)                                       |

Every lifecycle command (`uninstall`, `upgrade`, `start`, `stop`, `restart`, `status`, `logs`) resolves its target through the priority chain `--instance-dir` > `--name` > manifest in the current working directory. A bare `kici-admin orchestrator <cmd>` outside any deploy folder with no flags refuses non-zero and prints the candidate list of installed orchestrator instances on the host.

### org-settings -- org-level security policy

```bash
kici-admin org-settings global-workflows show --customer-id <id> [--format json|table]
kici-admin org-settings global-workflows set-enabled true|false --customer-id <id> [--format json|table]
kici-admin org-settings global-workflows allow-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows allow-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows deny-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows deny-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows elevate-add <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings global-workflows elevate-remove <pattern> --customer-id <id> [--source <routingKey>] [--format json|table]
kici-admin org-settings allow-http-npm true|false --customer-id <id> [--format json|table]
kici-admin org-settings user-cache show --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-quota <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-ttl <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack show --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack reset --customer-id <id> [--format json|table]
kici-admin org-settings approval show --customer-id <id> [--format json|table]
kici-admin org-settings approval set-expiry <seconds> --customer-id <id> [--format json|table]
kici-admin org-settings approval set-self-approval true|false --customer-id <id> [--format json|table]
```

Manages per-org global-workflow policy (workflow-author allow-list, source-repo deny-list, elevated-access list). Settings are org-scoped — there is one row per `customer_id` regardless of how many webhook sources the org has. Each list entry can optionally pin to a specific source via `--source <routingKey>`. Calls the orchestrator admin API directly (not the Platform dashboard proxy) so it stays operable even when Platform is unavailable.

- `--customer-id <id>` (alias: `--org <id>`) selects the org row.
- `--source <routingKey>` on `*-add` stores the entry pinned to that single webhook source. Omit for "any source in the org".
- `--source <routingKey>` on `*-remove` matches a source-qualified entry. Omit to remove the unqualified entry.
- `show` prints the current settings row for the given org.
- `set-enabled` toggles the master enable switch.
- `allow-add` / `allow-remove` mutate the workflow-author allow-list.
- `deny-add` / `deny-remove` mutate the source-repo deny-list.
- `elevate-add` / `elevate-remove` mutate the elevated-access list.

#### `allow-http-npm` — permit non-https private npm registries

```bash
kici-admin org-settings allow-http-npm true --customer-id <id>
kici-admin org-settings allow-http-npm false --customer-id <id>
```

Toggles `org_settings.allow_http_npm_registries`. When `false` (the default), any workflow `registries:` entry whose URL is `http://<non-loopback-host>` is rejected at dispatch time. Loopback (`localhost` / `127.0.0.0/8` / `::1`) and `*.local` hostnames are **always** allowed regardless of this toggle, so a developer iterating against a local Verdaccio container does not need to flip it.

Flip to `true` only when the org genuinely needs auth against a non-loopback `http://` registry — most commonly an internal mirror reachable only inside a VPN where TLS termination happens at the network boundary. Flipping it widens the trust surface: an attacker on the network path between the agent and the registry can observe (and tamper with) both the install request and the auth header, since `http://` carries no integrity protection. Prefer terminating TLS at the registry instead.

The toggle has no effect on the `installEnv:` channel (Option C) — committed `.kici/.npmrc` files are not URL-validated at the orchestrator. If you commit an `http://` registry line in your `.npmrc`, that's between you and npm.

See [Private npm registries](/user/private-registries) for the workflow-side configuration.

#### `user-cache` — per-org cache quota + entry TTL

```bash
kici-admin org-settings user-cache show --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-quota <bytes> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache set-ttl <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings user-cache reset-quota --customer-id <id> [--format json|table]
kici-admin org-settings user-cache reset-ttl --customer-id <id> [--format json|table]
```

Reads and writes the per-org byte quota and per-entry TTL for the user-facing cache (`ctx.cache` / the declarative job-step `cache:`). These map to the NULLABLE columns `org_settings.user_cache_quota_bytes` and `org_settings.user_cache_ttl_ms`. When a column is NULL (the default), the orchestrator uses the cluster-wide default from `KICI_USER_CACHE_QUOTA_BYTES` (5 GiB) / `KICI_USER_CACHE_TTL_MS` (7 days); a positive-integer override takes precedence at cache-operation time.

- `show` prints the effective settings — a per-org override or `(cluster default)` when unset.
- `set-quota <bytes>` / `set-ttl <milliseconds>` set a per-org override (must be a positive integer).
- `reset-quota` / `reset-ttl` clear the override (write NULL) so the org falls back to the cluster default.

This is the cluster-configurable knob for "this one tenant needs a bigger cache budget / longer retention" without editing the orchestrator unit file or redeploying. See [Storage layout: user cache](./storage-layout.md#user-cache) for the eviction + TTL mechanics.

#### `dispatch-ack` — per-org dispatch acknowledgment deadline

```bash
kici-admin org-settings dispatch-ack show --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack set <milliseconds> --customer-id <id> [--format json|table]
kici-admin org-settings dispatch-ack reset --customer-id <id> [--format json|table]
```

Reads and writes the per-org dispatch-acknowledgment deadline: how long the orchestrator waits for the agent to answer a dispatched job (with an accept acknowledgment, a refusal, or a `running` status) before treating the dispatch as lost. On expiry the orchestrator requeues the job and disconnects the unresponsive agent, so a dispatch dropped in an agent's socket teardown no longer strands the run until a timeout.

The value maps to the NULLABLE column `org_settings.dispatch_ack_timeout_ms`. When NULL (the default), the orchestrator uses the cluster-wide default from `KICI_DISPATCH_ACK_TIMEOUT_MS` (10 seconds); a per-org override of at least 1000 ms takes precedence at dispatch time.

- `show` prints the effective deadline — a per-org override or `(cluster default)` when unset.
- `set <milliseconds>` sets a per-org override (integer, minimum 1000).
- `reset` clears the override (writes NULL) so the org falls back to the cluster default.

Raise it for an org whose agents sit behind a high-latency network where the 10-second default is too tight; lower it to reclaim a stuck job faster when agents are local and fast.

#### `approval` — held-approval expiry and self-approval policy

```bash
kici-admin org-settings approval show --customer-id <id> [--format json|table]
kici-admin org-settings approval set-expiry <seconds> --customer-id <id> [--format json|table]
kici-admin org-settings approval set-self-approval true|false --customer-id <id> [--format json|table]
```

Controls how held approval elements (workflow / job / step gates) behave for the org. Both settings have non-null defaults, so there is no "reset to cluster default" — a `set` replaces the current value.

- `set-expiry <seconds>` writes `org_settings.approval_expiry_seconds` (integer, minimum 1; default 86400 — one day). A held element that is not fully approved within this window expires and its run/job/step is rejected. A workflow's own `requireApproval` `timeout` overrides this per element.
- `set-self-approval true|false` writes `org_settings.allow_self_approval` (default `true`). When `false`, the user who triggered a run may not approve its own held elements, enforcing four-eyes review.
- `show` prints the effective expiry (seconds) and self-approval flag.

#### `dashboard-writes` — dashboard write policy matrix

```bash
kici-admin org-settings dashboard-writes show --customer-id <id> [--category <name>] [--sensitivity <name>] [--format json|table]
kici-admin org-settings dashboard-writes set --customer-id <id> --op <name>=<true|false> [--op ...] [--category <name>] [--sensitivity <name>] [--enabled true|false] [--format json|table]
kici-admin org-settings dashboard-writes reset --customer-id <id> [--format json|table]
```

Manages the per-orch dashboard write policy — the matrix of `dashboard.*` write operations the orchestrator will accept when proxied through Platform. Empty policy = all operations enabled (permissive default).

- `show` prints the current policy. Filter to one category (`Secrets`, `Variables`, `Environments`, `Bindings`, `Held runs`, `DLQ`, `Registrations`, `Topology`) or one sensitivity bucket (`plaintext`, `authority`, `dispatch`).
- `set` flips one or more operations. Pass `--op <name>=<bool>` (repeatable) for individual operations, or combine `--category` / `--sensitivity` with `--enabled <bool>` to flip every operation in the matching group at once. The CLI prints the planned change before applying.
- `reset` returns every operation to the permissive default.
- `--customer-id <id>` (alias `--org`) selects the org row.

### peer -- cluster peer management

```bash
kici-admin peer create-token [--role coordinator|worker] [--expiry-hours <n>] [--org-id <id>] [--routing-key <key>] [--created-by <actor>] [--json]
kici-admin peer list
kici-admin peer revoke --instance-id <id>
kici-admin peer revoke-all --confirm
kici-admin peer prune-credentials --filter <pattern> --database-url <url> [--json]
kici-admin peer reset-raft-state --database-url <url> [--json]
```

Manages peer credentials for multi-orchestrator clusters. These commands access the database directly (not via the admin API).

- `create-token` generates a single-use join token (defaults: coordinator role, 1-hour expiry, org-id `default`, routing-key `default`, attribution `cli`).
  - `--created-by <actor>` sets the `join_tokens.created_by` audit attribution. Defaults to `cli`; deploy scripts pass e.g. `deploy-stg` so staging join-tokens are distinguishable from ad-hoc operator ones.
  - `--json` prints a single JSON object (`{ token, role, orgId, routingKey, expiresAt }`) on stdout instead of the human-readable multi-line output, so callers can pipe it through `JSON.parse` without stripping prose. Used by `packages/ci/src/deploy-stg/config.ts#createStgJoinToken` to bootstrap the HA staging cluster.
- `revoke` disconnects a peer on its next heartbeat.
- `revoke-all` requires `--confirm` as a safety guard.
- `prune-credentials` (direct-DB only, destructive) deletes every `peer_credentials` row whose `instance_id` does **not** match the `--filter` SQL `LIKE` pattern (e.g. `--filter 'e2e-%'` keeps e2e peers and removes everything else). HTTP mode is intentionally unsupported — the call site is a warm-redeploy preflight run while the orchestrator is stopped.
- `reset-raft-state` (direct-DB only, destructive) deletes every row from `raft_state` so a freshly-started orchestrator self-elects with a clean term. Same offline-only constraint as `prune-credentials`.

See [Clustering](clustering.md) for full setup details.

### queue -- dispatch queue read + maintenance

```bash
kici-admin queue list [--status <s>] [--status-not-in <csv>] [--job-name <name>] [--job-name-prefix <p>] [--job-name-not-like <pattern>] [--workflow-name <n>] [--created-after <iso>] [--limit <n>] [--database-url <url>] [--json]
kici-admin queue show <id> [--database-url <url>] [--json]
kici-admin queue clear --confirm [--yes]                       # TRUNCATE dispatch_queue
kici-admin queue clear --confirm --database-url $URL --yes     # Offline mode (orchestrator down)
```

- `list` / `show` are read-only inspection verbs (dual-mode: HTTP or direct DB via `--database-url`). Handy for investigating stuck dispatch state without `psql`.
- `clear` truncates `dispatch_queue` — stale pending jobs can linger after a crash or upgrade, and `clear` wipes the table so the next boot starts clean. HTTP mode is preferred when the orchestrator is up; direct-DB mode (via `--database-url`) is the legitimate path for warm-start cleanup before restart.

### registration -- workflow registration inspection

```bash
kici-admin registration list [--org <id>] [--routing-key <k>] [--repo <ident>] [--trigger-type <type>] [--limit <n>] [--database-url <url>] [--json]
kici-admin registration show <id> [--database-url <url>] [--json]
```

Reads rows from `workflow_registrations`. Distinct from `workflow list` (which inspects workflow-code) — `registration` is the registered-workflow-instance row. Dual-mode (HTTP via `/api/v1/admin/registrations` or direct DB).

- `list` returns `{ registrations, registryVersion }`; filter by customer, routing key, repo identifier, or trigger type.
- `show <id>` prints the single row plus its `registry_version`.

### rotate-key -- master key rotation

```bash
kici-admin rotate-key
```

Re-encrypts all PostgreSQL-stored secrets with the current master key. When `KICI_SECRET_KEY_OLD` is configured alongside `KICI_SECRET_KEY`, this performs a true key rotation. Without the old key, it re-encrypts at an incremented key version.

See [Secrets management > Key rotation](../security/secrets.md#key-rotation) for the full procedure.

### runs -- execution run inspection

```bash
kici-admin runs list [--status <csv>] [--workflow-name <name>] [--repo <ownerRepo>] [--since <iso>] [--count] [--limit <n>] [--offset <n>] [--json]
kici-admin runs show <runId> [--json]
kici-admin runs jobs <runId> [--include-steps] [--json]
kici-admin runs ephemeral-key <runId> [--json]
kici-admin runs secret-outputs <runId> [--output-key <k>] [--reveal] [--json]
```

Inspects execution runs, jobs, ephemeral keys, and secret outputs. Useful for investigating run status and failures — and, with `secret-outputs --reveal`, for recovering a job's output values during incident response — without direct database access.

**runs list:**

| Option            | Default | Description                                                                                          |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `--status`        |         | Filter by run status. Accepts a single value or a comma-separated list (e.g. `success,failed`)       |
| `--workflow-name` |         | Filter by workflow name                                                                              |
| `--repo`          |         | Filter by repo identifier (`owner/repo`)                                                             |
| `--since`         |         | Only include runs with `created_at` strictly later than this ISO-8601 timestamp                      |
| `--count`         |         | Return only the count of matching runs (skip the row listing; useful for monitoring / health checks) |
| `--limit`         | `20`    | Max results (max 100)                                                                                |
| `--offset`        | `0`     | Skip first N results                                                                                 |
| `--json`          |         | Output raw JSON instead of a table                                                                   |

**runs show:**

| Option    | Description                                 |
| --------- | ------------------------------------------- |
| `<runId>` | Run ID to inspect (required positional arg) |
| `--json`  | Output raw JSON instead of formatted text   |

Shows run header (status, repo, ref, SHA, provider, timing, environment, trust tier), jobs table, and steps per job. Internally composes two admin API calls: `GET /admin/runs/:runId` (run header) + `GET /admin/runs/:runId/jobs?includeSteps=true`.

**runs jobs:**

| Option            | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `<runId>`         | Run ID to inspect (required positional arg)                      |
| `--include-steps` | Embed the step list inside each job row (default: metadata only) |
| `--json`          | Output raw JSON instead of a table                               |

Lists the execution jobs for a single run. Cheaper than `runs show` when you only need job-level state (e.g., for polling). Each job row carries its resolved upstream dependency edges in `needs` (an array of `{ upstreamName, ifFailed }`, or `null` when the job has no upstreams) — the same dependency structure the dashboard run-detail graph view renders.

**runs ephemeral-key:**

| Option    | Description                                             |
| --------- | ------------------------------------------------------- |
| `<runId>` | Run ID to inspect (required positional arg)             |
| `--json`  | Output raw JSON instead of `exists: bool / created_at:` |

Answers the security-relevant question "did the per-run ephemeral key get scrubbed?" without `psql`. Returns `{ exists, createdAt }`; the key material itself is **never** exposed on the wire, regardless of role.

**runs secret-outputs:**

| Option         | Description                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<runId>`      | Run ID to inspect (required positional arg)                                                                                                                                                    |
| `--output-key` | Filter to a single `output_key`                                                                                                                                                                |
| `--reveal`     | Decrypt values inline. Requires the `secret.reveal` RBAC permission. Every reveal call writes a `secret-outputs.reveal` row to `secret_audit_log`. CLI warns on stderr before running the call |
| `--json`       | Output raw JSON instead of a table                                                                                                                                                             |

Lists the secret outputs produced by a run's jobs. Values are **masked** by default — the row set shows `jobId`, `outputKey`, `createdAt`, and nothing that could reconstruct the secret. `--reveal` is the break-glass path for incident response only: it is always audited, requires the stricter `secret.reveal` permission, and fails with HTTP 503 if the orchestrator was started without a master key (e.g., no `KICI_SECRET_KEY`).

**RBAC tokens for these commands:** `run.read` is enough for `list`, `show`, `jobs`, `ephemeral-key`, and masked `secret-outputs` (all three roles — owner, admin, auditor — carry it). `secret-outputs --reveal` additionally requires `secret.reveal`, which only owner + admin roles hold — auditor tokens get 403. Successful reveals land in `secret_audit_log` with `action = secret-outputs.reveal`, `run_id`, `user_id`, `role`, and a `metadata` JSON object summarising the revealed / failed output keys.

### scaler -- scaler maintenance (local, no orchestrator)

```bash
kici-admin scaler reap-orphans [--config <path>] [--force] [--json]
```

Frees leaked Firecracker / container resources (orphaned microVMs, TAP devices, containers) without a running orchestrator. Runs locally against the host using the orchestrator config, so it is the recovery path when the orchestrator crashed and left scaler-managed resources behind.

| Option     | Default                                        | Description                                                        |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `--config` | `KICI_CONFIG` or `/etc/kici/orchestrator.yaml` | Path to the orchestrator config                                    |
| `--force`  | `false`                                        | Reap even if the local orchestrator reports healthy                |
| `--json`   | `false`                                        | Emit machine-readable JSON counts instead of human-readable output |

By default the command refuses to reap when a local orchestrator reports healthy (so it never races a live process); pass `--force` to override.

### secret -- scoped secret management

```bash
kici-admin secret scopes <orgId>
kici-admin secret list <orgId> <scope>
kici-admin secret set [orgId] [scope] [key] [--value <v> | --prompt | --from-stdin | --from-file <p> | --from-env <var>] [--no-trim] [--confirm-fingerprint <sha256>] [--dry-run] [--database-url <url>]
kici-admin secret set --org <orgId> --environment <name> --key <k> [value-source flags as above]
kici-admin secret delete <orgId> <scope> <key> [--yes]
```

- Secret values are **write-only** -- there is no command to read a secret value.
- `set` accepts either the positional `<orgId> <scope> <key>` form or the environment-scope sugar form (`--org` + `--environment` + `--key`). The two forms are mutually exclusive.
- Value sources (mutually exclusive; first matching wins): `--prompt` (interactive no-echo, default on TTY), `--from-stdin` (read piped stdin until EOF; default when stdin is a pipe), `--from-file <path>` (file body, trailing newline trimmed unless `--no-trim`), `--from-env <var>` (named env var), `--value <plaintext>` (visible in shell history — discouraged).
- `--confirm-fingerprint <sha256hex>` refuses the write unless `SHA-256(value)` matches the supplied 64-hex string. Pair with a value source for unattended automation.
- `--dry-run` parses + validates the value, prints fingerprint + length, and skips the write.
- `--database-url` (on `set`) switches to direct-DB mode and writes the caller-supplied `encrypted_value` verbatim into `scoped_secrets` — used by E2E `globalSetup` helpers that need to seed secrets before the orchestrator is up.
- `delete` asks for confirmation unless `--yes` is passed.

For full details on encryption, backends, and key rotation, see [Secrets management](../security/secrets.md).

### secret -- scoped secret management (purge)

```bash
kici-admin secret purge --confirm                              # All orgs (nuclear — use rotate-key first)
kici-admin secret purge --confirm --org <orgId>                # One org
kici-admin secret purge --confirm --database-url $URL --yes    # Offline mode
```

`purge` bulk-deletes `scoped_secrets` rows. Recovery path for "the encryption key is lost and I can't decrypt". Prefer `kici-admin rotate-key` first — it re-encrypts rather than discards. `purge` is the path when the old key is gone or the ciphertext is corrupt.

### source -- webhook source management

```bash
# GitHub App sources
# One-click setup: create AND configure a brand-new GitHub App via the App Manifest flow
kici-admin source add github --name <name> --manifest [--github-org <slug>] [--no-browser] [--json]
# Manual: store credentials for a GitHub App you already created
kici-admin source add github --name <name> --app-id <id> --private-key <value|@file> [--webhook-secret <secret>] [--from-env <var>] [--stdin]
kici-admin source update <routingKey> [--name <name>] [--private-key <value|@file>] [--webhook-secret <secret>] [--from-env <var>] [--stdin]
kici-admin source get-webhook-secret <routingKey>
kici-admin source remove <routingKey> [--yes]

# Generic webhook sources
kici-admin source add generic --org <orgId> --name <name> [--from-env <var>] [--stdin] [options]
kici-admin source get <id>
kici-admin source update-generic <id> [--from-env <var>] [--stdin] [options]
kici-admin source remove <id> --generic [--hard] [--yes]
kici-admin source enable <id>
kici-admin source disable <id>

# Local filesystem (file://) sources — a git repo present on the agent
# filesystem (see the Local filesystem source guide). verification='none'.
kici-admin source add local --org <orgId> --path <abs-dir> [--name <name>] [--clone-url-base <url>]
kici-admin source update-local <id> [--path <abs-dir>] [--name <name>]
kici-admin source remove <routingKey> --local [--hard] [--yes]
kici-admin source trigger-local <id> [--event push|pull_request] [--ref <ref>] [--sha <sha>] [--repo-full-name <name>]
kici-admin source install-hook <id> [--repo <path>]

# List all sources (without --org, only GitHub sources are shown)
kici-admin source list [--org <orgId>] [--include-deleted]
```

**One-click manifest setup** (`--manifest`): the recommended path for a brand-new App. The CLI builds a pre-filled GitHub App manifest (permissions, events, webhook URL), opens GitHub for you to click **"Create GitHub App"** once, captures the returned credentials, stores them encrypted on the orchestrator, and walks you through installing the App on your repos. It always creates a **new** App on GitHub. Flags:

| Flag                  | Description                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--manifest`          | Enable one-click setup via GitHub's App Manifest flow (mutually exclusive with `--app-id` / `--private-key`) |
| `--github-org <slug>` | Create the App under a GitHub organization instead of your personal account                                  |
| `--no-browser`        | Headless mode: print a `kici.dev` URL to open, then read the short-lived setup code you paste back via stdin |
| `--json`              | Emit raw JSON (the API response) instead of formatted text                                                   |

See the [GitHub provider guide](../../user/providers/github.md) for the full one-click walkthrough. The manifest flow resolves the App's webhook URL from the orchestrator's Platform connection, so it requires a **platform** or **hybrid** orchestrator. **Independent-mode** orchestrators have no Platform connection (and therefore no GitHub-App ingress), so the pre-flight returns no webhook URL and the flow aborts — use a generic webhook source there instead.

**Secret input modes** (for private keys and webhook secrets — the manual path):

| Mode                 | Example                             |
| -------------------- | ----------------------------------- |
| Direct value         | `--private-key "-----BEGIN RSA..."` |
| File (@ prefix)      | `--private-key @/path/to/key.pem`   |
| Environment variable | `--from-env GITHUB_APP_KEY`         |
| Stdin                | `--stdin`                           |

**Generic source options:**

| Option                              | Description                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `--verification <method>`           | `hmac_sha256`, `bearer_token`, `ip_allowlist`, or `none`                               |
| `--secret <value>`                  | Verification secret (supports `@file` syntax)                                          |
| `--event-type-header <header>`      | Header for event type extraction                                                       |
| `--event-type-path <jsonpath>`      | JSONPath for event type from body                                                      |
| `--idempotency-key-header <header>` | Header for idempotency key                                                             |
| `--idempotency-key-path <jsonpath>` | JSONPath for idempotency key from body                                                 |
| `--dedup-window <seconds>`          | Dedup window (default: 300)                                                            |
| `--max-payload <bytes>`             | Max payload size (default: 1048576)                                                    |
| `--allowed-events <events>`         | Comma-separated allowed event types                                                    |
| `--strip-headers <headers>`         | Comma-separated headers to strip                                                       |
| `--rate-limit <rpm>`                | Rate limit in requests per minute (default: 600)                                       |
| `--provider-type <type>`            | `generic` (default) or `local` (file:// filesystem source — prefer `source add local`) |

**Universal-git options** (promote a generic source to clone + trigger-match for Forgejo / Gitea / Gogs / GitLab / plain GitHub — see [Universal-git provider](../../user/providers/universal-git.md)):

| Option                              | Description                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `--preset <name>`                   | `forgejo`, `gitea`, `gogs`, `gitlab-repo`, `github-repo`, or `custom`                 |
| `--git-url-template <url>`          | Clone URL template with `{owner}` / `{name}` / `{repo}` placeholders                  |
| `--credential-ref <key>`            | Secret key name under the source-scoped store (`__source__/<sourceId>`)               |
| `--credential-store <backend>`      | Secret backend name (default: `pg`)                                                   |
| `--credential-type <type>`          | `pat`, `basic`, or `ssh`                                                              |
| `--credential-user <user>`          | Username for PAT / basic auth (default: `x-access-token`; ignored for `ssh`)          |
| `--ssh-host-key-policy <policy>`    | `accept-new` (TOFU, default) or `pinned` (reject unknown host keys)                   |
| `--ssh-known-hosts-pem <pemOrFile>` | OpenSSH `known_hosts` content (prefix `@` reads from a file). Required when `pinned`. |
| `--clear-git-config`                | (`source update-generic` only) Revert to a payload-only generic webhook               |

List the canonical presets and their expanded `payloadPaths` + `eventMapping`:

```bash
kici-admin source list-presets
```

**Local filesystem (`file://`) source options** (a git repo present on the agent
filesystem — see the [Local filesystem source guide](../../user/providers/local-file.md)):

| Option                   | Description                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `--path <abs-dir>`       | Absolute base path of the repo on the agent filesystem (`<path>/.kici/kici.lock.json`)      |
| `--clone-url-base <url>` | Optional `git://` / `http://` base for agents that do not share the orchestrator filesystem |
| `--name <name>`          | Source name (default: `local`)                                                              |

`source add local` always registers verification `none` — there is no remote
forge to sign the payload, so only register repos you trust. Drive runs with
`source trigger-local <id>` (reads the repo HEAD and POSTs a synthetic push) or
install a `post-receive` hook with `source install-hook <id>` so every push
triggers a run. The orchestrator accepts a local source on any scaler backend
and logs a reachability warning (not a rejection) on container / Firecracker
scalers, where the repo must be baked into the image / rootfs or bind-mounted at
the registered path.

### source -- source maintenance (purge-stale)

```bash
kici-admin source purge-stale --routing-key <key> --dry-run
kici-admin source purge-stale --routing-key <key> --confirm
```

Counts (`--dry-run`) or deletes (`--confirm`) orphan `sources` rows, their scoped webhook/private-key secrets, and all `generic_webhook_sources` rows. `generic_webhook_sources` is single-tenant per deployment so it's cleared wholesale. Pair with `source add` / `source update` to re-seed the current deployment's sources afterward.

### remote-source -- remote-run org anchor inspection

```bash
kici-admin remote-source show <orgId>
```

Inspects the orchestrator's auto-provisioned **remote source** for an organization — the system-managed row (routing key `remote:<orgId>`) that anchors the org so `kici run remote` can dispatch to it without any manual webhook source. The orchestrator provisions one automatically for its bound org, so there is nothing to create or remove; this command is read-only.

Use it to debug org-anchor issues on an orchestrator that sits behind a private network: confirm the remote source exists and maps the expected routing key to the org. If a developer's `kici run remote` reports that the org is not routable, `remote-source show <orgId>` is the first check.

### token -- admin API token management

```bash
kici-admin token create <label> --role <role> [--routing-key <key>]
kici-admin token list
kici-admin token revoke <id>
```

- `create` returns the plaintext token once. Save it immediately.
- `--role` is required: `owner`, `admin`, or `auditor`.
- `--routing-key` optionally scopes the token to a specific routing key.

### variable -- org-level environment variable management

```bash
kici-admin variable list <orgId> <environment> [--values]
kici-admin variable get <orgId> <environment> <key>
kici-admin variable set <orgId> <environment> <key> [--value <v> | --prompt | --from-stdin | --from-file <p> | --from-env <var>] [--no-trim] [--locked] [--confirm-fingerprint <sha256>] [--dry-run]
kici-admin variable delete <orgId> <environment> <key> [--yes]
```

Manages org-level environment variables (plaintext-at-rest in the orchestrator DB). Variables are the non-secret sibling of scoped secrets — both write to the same per-environment trust cone, gated by the `variables.set` / `variables.delete` switches in the dashboard-write policy. This CLI is the always-available authority path when the dashboard is disabled for either switch.

- `list` prints keys + `[locked]` flag only; pass `--values` to include the inline values.
- `get` prints a single variable's value (exits non-zero if the key is missing).
- `set` accepts the same value-source flag set as `secret set` (`--prompt`, `--from-stdin`, `--from-file`, `--from-env`, `--value`, `--no-trim`, `--confirm-fingerprint`, `--dry-run`). Add `--locked` to mark the variable as locked so source-level overrides cannot replace it.
- `delete` asks for confirmation unless `--yes` is passed.

### workflow -- workflow registration inspection

```bash
kici-admin workflow list [--org <orgId>] [--routing-key <key>] [--repo <ownerRepo>] [--trigger-type <type>] [--event <eventName>] [--json]
kici-admin workflow register-manual --lock-file <path> --repo <ident> --routing-key <key> --customer <id> [--provider-context <json>] [--commit-sha <sha>] [--database-url <url>] [--json]
```

`list` inspects workflow registrations from the `workflow_registrations` table. All filters are optional and combinable.

| Option           | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| `--org`          | Filter by customer/organization ID (server param: `customerId`) |
| `--routing-key`  | Filter by routing key (e.g., `github:42`)                       |
| `--repo`         | Filter by repo identifier (`owner/repo`)                        |
| `--trigger-type` | Filter by trigger type (e.g., `webhook`, `push`, `schedule`)    |
| `--event`        | Filter by webhook event name (scans `lock_entry.triggers`)      |
| `--json`         | Output raw JSON instead of a table                              |

`register-manual` seeds `workflow_registrations` rows straight from a compiled lock file — used by local-only / non-Git deployments and E2E helpers that can't rely on a webhook-driven compile-and-register flow. Dual-mode (HTTP via admin API, or direct DB via `--database-url`).

| Option               | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `--lock-file`        | Path to a compiled `kici.lock.json` file (required)        |
| `--repo`             | `repo_identifier` value (e.g. `owner/repo`, required)      |
| `--routing-key`      | Routing key for the source (e.g. `github:42`, required)    |
| `--customer`         | `customer_id` (org) to attribute rows to (required)        |
| `--provider-context` | Provider-specific context as a JSON object (default: `{}`) |
| `--commit-sha`       | Optional commit SHA stamped on each row                    |
| `--database-url`     | Use direct DB access instead of HTTP (offline mode)        |
| `--json`             | Emit JSON output                                           |

## Environment variables summary

| Variable                     | Scope        | Description                                         |
| ---------------------------- | ------------ | --------------------------------------------------- |
| `KICI_ADMIN_URL`             | CLI          | Orchestrator URL (default: `http://localhost:8080`) |
| `KICI_ADMIN_TOKEN`           | CLI          | Admin API Bearer token (required)                   |
| `KICI_BOOTSTRAP_ADMIN_TOKEN` | Orchestrator | Fixed bootstrap token (idempotent)                  |
| `KICI_SECRET_KEY`            | Orchestrator | 64-char hex AES-256 master key                      |
| `KICI_SECRET_KEY_FILE`       | Orchestrator | Path to master key file                             |
| `KICI_SECRET_KEY_OLD`        | Orchestrator | Previous key for dual-key rotation                  |
| `KICI_AUTO_MIGRATE`          | Orchestrator | Set `false` to disable auto-migration               |
| `KICI_AGENT_TOKEN`           | Agent        | Agent authentication token                          |
| `KICI_BACKEND_VAULT_URL`     | CLI          | Vault/OpenBao URL for backend commands              |
| `KICI_BACKEND_ROLE_ID`       | CLI          | Vault AppRole role ID for backend commands          |
| `KICI_BACKEND_SECRET_ID`     | CLI          | Vault AppRole secret ID for backend commands        |
| `KICI_BACKEND_TOKEN`         | CLI          | Vault token for backend commands                    |
| `KICI_BACKEND_PG_URL`        | CLI          | PG connection string for backend commands           |

## See also

- [Orchestrator setup guide](orchestrator-setup.md) -- end-to-end setup walkthrough
- [Service installation guide](../distribution/service-installation.md) -- platform-specific service management
- [Secrets management](../security/secrets.md) -- encryption, RBAC, key rotation, Vault backend
- [Configuration management](config-management.md) -- config layers and precedence
- [Clustering](clustering.md) -- multi-orchestrator cluster setup
