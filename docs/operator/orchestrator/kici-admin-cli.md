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

The exhaustive, always-current list of every `kici-admin` command with its arguments and options, generated from the CLI's command tree so it never drifts from the shipped binary. The [command guide](#command-guide) below adds per-namespace concepts and worked examples; the reference here is the authoritative signature list.

<!-- BEGIN GENERATED: kici-admin-commands (do not edit; run the doc generator) -->

### `kici-admin access-log`

Inspect the read / admin-mutation access log

Synopsis: `kici-admin access-log`

### `kici-admin access-log list`

List access-log rows (dogfooded via /api/v1/admin/access-log)

Synopsis: `kici-admin access-log list [options]`

**Options**

| Option                  | Default | Description                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `--org-id <orgId>`      |         | Filter by org/tenant ID                                                          |
| `--actor-type <t>`      |         | Filter by actor type (user\|api_key\|service_account\|platform_operator\|system) |
| `--actor-id <id>`       |         | Filter by actor id (zsub, keyId, service_account id, ...)                        |
| `--action <action>`     |         | Filter by dotted action (e.g. run.detail.read, run.cancel)                       |
| `--source <s>`          |         | Filter by source (platform_proxy\|admin_http\|admin_cli)                         |
| `--outcome <o>`         |         | Filter by outcome (allowed\|denied\|error)                                       |
| `--target-type <t>`     |         | Filter by target type (run\|step\|event_log\|secret_scope\|...)                  |
| `--target-id <id>`      |         | Filter by target id                                                              |
| `--from <ts>`           |         | ISO timestamp lower bound (inclusive)                                            |
| `--to <ts>`             |         | ISO timestamp upper bound (exclusive)                                            |
| `--q <text>`            |         | Filter by substring of error_message (trigram-indexed full-text search)          |
| `--agent-label <label>` |         | Filter by exact agent label                                                      |
| `--agent-only`          |         | Only agent-attributed rows                                                       |
| `--limit <n>`           | `50`    | Max results (default 50, max 200)                                                |
| `--cursor <c>`          |         | Opaque cursor from a previous nextCursor                                         |
| `--json`                |         | Emit raw JSON instead of a table                                                 |

### `kici-admin access-log show`

Show a single access-log entry by id

Synopsis: `kici-admin access-log show <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option             | Default | Description                                                                                                                                                                                                                                                                                |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--org-id <orgId>` |         | Tenant scope for cold-store fallback when the row is archived (>30d old). Without this hint, only the synthetic **orchestrator** tenant is scanned, so a row whose org_id is set won't be found. Single-tenant cold scans typically take seconds-to-minutes for one-shot operator queries. |
| `--json`           |         | Emit raw JSON instead of formatted output                                                                                                                                                                                                                                                  |

### `kici-admin agent`

Manage agent authentication tokens

Synopsis: `kici-admin agent`

### `kici-admin agent install`

Install the agent as a system service

Synopsis: `kici-admin agent install [options]`

**Options**

| Option                     | Default      | Description                                                                               |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `--platform <type>`        |              | Service platform (systemd, launchd, windows, compose)                                     |
| `--env-file <path>`        |              | Path to existing env/config file to use                                                   |
| `--binary <path>`          |              | Path to agent binary (default: current executable)                                        |
| `--name <name>`            | `kici-agent` | Service name                                                                              |
| `--orchestrator-url <url>` |              | URL of the orchestrator to connect to                                                     |
| `--token <token>`          |              | Agent authentication token                                                                |
| `--labels <labels>`        |              | Comma-separated agent labels for routing                                                  |
| `--wizard`                 |              | Interactive wizard for guided setup                                                       |
| `--system`                 |              | Install as system-level service (requires root)                                           |
| `--user-level`             |              | Install as user-level service (no root required)                                          |
| `--instance-dir <path>`    |              | Deploy folder; the instance manifest is written here (default: current working directory) |
| `--force`                  |              | Overwrite an existing same-named foreign instance                                         |

### `kici-admin agent list`

List agent tokens

Synopsis: `kici-admin agent list [options]`

**Options**

| Option                 | Default | Description                                                                                                                          |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--type <type>`        |         | Filter by type: static or ephemeral                                                                                                  |
| `--include-pending`    |         | Include agents that have connected via WS but have not completed registration (HTTP mode only; direct-DB cannot see in-memory state) |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                                                                                  |
| `--json`               |         | Emit JSON output                                                                                                                     |

### `kici-admin agent logs`

Tail and follow agent service logs

Synopsis: `kici-admin agent logs [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance whose logs to read         |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--since <duration>`    |         | Show logs since duration (e.g. 1h, 30m)                  |
| `--level <level>`       |         | Filter by log level (error\|warn\|info)                  |
| `--json`                |         | Output as structured JSON                                |
| `--no-follow`           |         | Snapshot mode (do not tail)                              |

### `kici-admin agent register`

Create a static agent token

Synopsis: `kici-admin agent register [options]`

**Options**

| Option                      | Default | Description                                                                                                           |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `--labels <labels>`         |         | Comma-separated agent labels (e.g. linux,x64)                                                                         |
| `--mandatory-label <label>` |         | Taint label the agent only accepts jobs demanding (repeatable). Also authorized as an advertised label.               |
| `--privileged-root`         |         | Shorthand for --mandatory-label kici:privileged:root: mint a confined root agent token (the agent must run as uid 0). |

### `kici-admin agent restart`

Restart the agent service

Synopsis: `kici-admin agent restart [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to restart                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent revoke`

Revoke an agent token by ID

Synopsis: `kici-admin agent revoke <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin agent start`

Start the agent service

Synopsis: `kici-admin agent start [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to start                   |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent status`

Show agent service status and health information

Synopsis: `kici-admin agent status [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to inspect                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--json`                |         | Output as JSON                                           |

### `kici-admin agent stop`

Stop the agent service

Synopsis: `kici-admin agent stop [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to stop                    |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent uninstall`

Remove the agent service registration

Synopsis: `kici-admin agent uninstall [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to uninstall               |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin agent upgrade`

Upgrade agent to a new version using versioned directory layout

Synopsis: `kici-admin agent upgrade [options]`

**Options**

| Option                  | Default | Description                                           |
| ----------------------- | ------- | ----------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose) |
| `--instance-dir <path>` |         | Deploy folder of the instance to upgrade              |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD) |
| `--from <path>`         |         | Path to package archive (.tar.gz or .zip)             |
| `--url <url>`           |         | URL to download package archive from                  |
| `--version <version>`   |         | Target version string (e.g., 0.3.0)                   |
| `--yes`                 |         | Skip confirmation prompt                              |
| `--force`               |         | Overwrite existing versioned directory                |
| `--cleanup`             |         | Remove old versions (keeps current and previous)      |
| `--rollback`            |         | Roll back to the previous version                     |
| `--pick`                |         | Interactively pick an installed version to activate   |

### `kici-admin api-key`

Manage Platform API keys and routing keys

Synopsis: `kici-admin api-key`

### `kici-admin api-key add-routing-key`

Add a routing key permission pattern to an API key

Synopsis: `kici-admin api-key add-routing-key <id> <pattern>`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `id`      | yes      | no       |             |
| `pattern` | yes      | no       |             |

### `kici-admin api-key create`

Create a new API key with optional routing key permissions

Synopsis: `kici-admin api-key create [options]`

**Options**

| Option                  | Default   | Description                                                     |
| ----------------------- | --------- | --------------------------------------------------------------- |
| `--label <label>`       | `unnamed` | Label for the API key                                           |
| `--routing-keys <keys>` |           | Comma-separated routing key patterns (e.g. github:42,github:99) |

### `kici-admin attestations`

Provenance-attestation maintenance (orchestrator DB)

Synopsis: `kici-admin attestations`

### `kici-admin attestations list`

List provenance attestations from the orchestrator DB (newest first)

Synopsis: `kici-admin attestations list [options]`

**Options**

| Option                 | Default | Description                                   |
| ---------------------- | ------- | --------------------------------------------- |
| `--run-id <id>`        |         | Filter to a single run                        |
| `--job-id <id>`        |         | Filter to a single job                        |
| `--limit <n>`          | `20`    | Max results (default 20, max 100)             |
| `--json`               |         | Emit the raw JSON envelope instead of a table |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL)  |

### `kici-admin attestations retry`

Mint deferred attestations now (drains the pending-attestations outbox)

Synopsis: `kici-admin attestations retry [options]`

**Options**

| Option               | Default | Description                                                         |
| -------------------- | ------- | ------------------------------------------------------------------- |
| `--run-id <id>`      |         | Scope to a single run (else drains every pending attestation)       |
| `--all-pending`      |         | Drain every pending attestation (default when --run-id is absent)   |
| `--include-rejected` |         | Also re-attempt rows previously marked terminally rejected (re-arm) |

### `kici-admin attestations reverify`

Recompute stored attestation verdicts (verify-at-ingest backfill)

Synopsis: `kici-admin attestations reverify [options]`

**Options**

| Option                 | Default | Description                                                        |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| `--all`                |         | Re-evaluate every attestation (default: only pending/unverifiable) |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL)                       |
| `--yes`                |         | Skip the --all confirmation prompt                                 |

### `kici-admin audit`

Query the secrets audit log

Synopsis: `kici-admin audit [options]`

**Options**

| Option               | Default | Description                                          |
| -------------------- | ------- | ---------------------------------------------------- |
| `--context <name>`   |         | Filter by context name                               |
| `--routing-key <rk>` |         | Filter by routing key (required for cold-store scan) |
| `--action <action>`  |         | Filter by action type                                |
| `--from <date>`      |         | From date (ISO 8601)                                 |
| `--to <date>`        |         | To date (ISO 8601)                                   |
| `--limit <n>`        | `100`   | Max entries to return                                |
| `--offset <n>`       |         | Offset for pagination                                |
| `--include-archived` | `false` | Include rows from cold storage (Phase D)             |

### `kici-admin backend`

Manage secret backends

Synopsis: `kici-admin backend`

### `kici-admin backend add`

Register a new secret backend

Synopsis: `kici-admin backend add <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | yes      | no       |             |

**Options**

| Option                      | Default   | Description                                            |
| --------------------------- | --------- | ------------------------------------------------------ |
| `--type <type>`             |           | Backend type: pg or vault                              |
| `--vault-url <url>`         |           | Vault/OpenBao URL (env: KICI_BACKEND_VAULT_URL)        |
| `--auth-method <method>`    | `approle` | Vault auth method: approle or token (default: approle) |
| `--role-id <id>`            |           | Vault AppRole role ID (env: KICI_BACKEND_ROLE_ID)      |
| `--secret-id <id>`          |           | Vault AppRole secret ID (env: KICI_BACKEND_SECRET_ID)  |
| `--secret-id-file <path>`   |           | Read Vault secret ID from file (avoids shell history)  |
| `--token <token>`           |           | Vault token (env: KICI_BACKEND_TOKEN)                  |
| `--namespace <ns>`          |           | Vault namespace                                        |
| `--mount-path <path>`       | `secret`  | Vault mount path (default: secret)                     |
| `--base-path <path>`        |           | Vault base path for secrets                            |
| `--connection-string <url>` |           | PG connection string (env: KICI_BACKEND_PG_URL)        |
| `--scope-filter <pattern>`  | `**`      | Scope filter glob pattern (default: \*\*)              |
| `--sync-interval <ms>`      | `300000`  | Sync interval in milliseconds (default: 300000)        |

### `kici-admin backend list`

List all registered secret backends

Synopsis: `kici-admin backend list`

### `kici-admin backend purge-stale`

Delete backends with encrypted config that can no longer be decrypted (direct-DB, pre-orchestrator)

Synopsis: `kici-admin backend purge-stale [options]`

**Options**

| Option                 | Default | Description                                               |
| ---------------------- | ------- | --------------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (or KICI_DATABASE_URL / DATABASE_URL) |
| `--json`               |         | Emit JSON output                                          |

### `kici-admin backend remove`

Remove a registered secret backend

Synopsis: `kici-admin backend remove <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | yes      | no       |             |

**Options**

| Option  | Default | Description              |
| ------- | ------- | ------------------------ |
| `--yes` |         | Skip confirmation prompt |

### `kici-admin backend sync`

Trigger scope discovery sync (all backends if name omitted)

Synopsis: `kici-admin backend sync [name]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | no       | no       |             |

### `kici-admin backend test`

Test backend connectivity (by name or inline config)

Synopsis: `kici-admin backend test [name] [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | no       | no       |             |

**Options**

| Option                      | Default   | Description                                           |
| --------------------------- | --------- | ----------------------------------------------------- |
| `--type <type>`             |           | Backend type: pg or vault                             |
| `--vault-url <url>`         |           | Vault/OpenBao URL (env: KICI_BACKEND_VAULT_URL)       |
| `--auth-method <method>`    | `approle` | Vault auth method: approle or token                   |
| `--role-id <id>`            |           | Vault AppRole role ID (env: KICI_BACKEND_ROLE_ID)     |
| `--secret-id <id>`          |           | Vault AppRole secret ID (env: KICI_BACKEND_SECRET_ID) |
| `--secret-id-file <path>`   |           | Read Vault secret ID from file                        |
| `--token <token>`           |           | Vault token (env: KICI_BACKEND_TOKEN)                 |
| `--namespace <ns>`          |           | Vault namespace                                       |
| `--mount-path <path>`       | `secret`  | Vault mount path                                      |
| `--base-path <path>`        |           | Vault base path                                       |
| `--connection-string <url>` |           | PG connection string (env: KICI_BACKEND_PG_URL)       |

### `kici-admin cluster`

Cluster identity recovery (DB <-> S3 sentinel reconcile).

Synopsis: `kici-admin cluster`

### `kici-admin cluster reconcile-identity`

Reconcile cluster_meta.cluster_id with the S3 sentinel. Default restores the DB from the sentinel.

Synopsis: `kici-admin cluster reconcile-identity [options]`

**Options**

| Option                 | Default | Description                                                            |
| ---------------------- | ------- | ---------------------------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL)                           |
| `--bucket <bucket>`    |         | S3 bucket (else KICI_STORAGE_BUCKET)                                   |
| `--prefix <prefix>`    |         | Storage prefix (else KICI_STORAGE_PREFIX, default empty = bucket root) |
| `--region <region>`    |         | S3 region (else KICI_STORAGE_REGION)                                   |
| `--endpoint <url>`     |         | S3 endpoint (else KICI_STORAGE_ENDPOINT)                               |
| `--force-path-style`   |         | Use S3 path-style addressing                                           |
| `--adopt-db`           |         | Reverse direction: rewrite the sentinel from the DB cluster_id         |
| `--dry-run`            |         | Report drift and exit without changing anything                        |
| `--yes`                |         | Skip confirmation and apply on drift                                   |

### `kici-admin cluster-name`

Manage this orchestrator's cluster name (Platform-visible identifier)

Synopsis: `kici-admin cluster-name`

### `kici-admin cluster-name get`

Print the current cluster name.

Synopsis: `kici-admin cluster-name get [options]`

**Options**

| Option              | Default | Description                |
| ------------------- | ------- | -------------------------- |
| `--format <format>` | `table` | Output format: json\|table |

### `kici-admin cluster-name set`

Rename the cluster. Cluster name must match ^[a-z][a-z0-9-]{0,62}$ (lowercase letters, digits, hyphens; start with a letter; ≤63 chars).

Synopsis: `kici-admin cluster-name set <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | yes      | no       |             |

**Options**

| Option              | Default | Description                |
| ------------------- | ------- | -------------------------- |
| `--format <format>` | `table` | Output format: json\|table |

### `kici-admin cold-store`

Inspect and operate the orchestrator-side cold-storage archival

Synopsis: `kici-admin cold-store`

### `kici-admin cold-store archive-now`

Run one archive cycle synchronously for a single registered adapter

Synopsis: `kici-admin cold-store archive-now <table> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `table`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                        |
| ---------------------- | ------- | -------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL) |

### `kici-admin cold-store dry-run-archive`

Show what would be archived (no S3 writes, no PG writes)

Synopsis: `kici-admin cold-store dry-run-archive <table> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `table`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                        |
| ---------------------- | ------- | -------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL) |
| `--tenant <rk>`        |         | Scope to a single routing key                      |
| `--from <date>`        |         | Lower bound on partition column (ISO date)         |
| `--to <date>`          |         | Upper bound on partition column (ISO date)         |

### `kici-admin cold-store list-chunks`

List archived chunks (one JSON object per line) for a table

Synopsis: `kici-admin cold-store list-chunks <table> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `table`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                                   |
| ---------------------- | ------- | ------------------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL)            |
| `--missing-data`       |         | Only list chunks whose data file is missing in object storage |
| `--missing-manifest`   |         | Only list chunks whose manifest is missing in object storage  |
| `--tenant <rk>`        |         | Scope to a single routing key                                 |
| `--from <date>`        |         | Lower bound on partition column (ISO date)                    |
| `--to <date>`          |         | Upper bound on partition column (ISO date)                    |

### `kici-admin cold-store list-purgeable`

Phase 2: list chunks past their cold-retention horizon (read-only)

Synopsis: `kici-admin cold-store list-purgeable [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL)    |
| `--table <table>`      |         | Filter to a single adapter table (else all)           |
| `--bucket <bucket>`    |         | Filter to a single cold-bucket (30d / 180d / 1y / 2y) |
| `--limit <n>`          | `1000`  | Max candidates to inspect                             |

### `kici-admin cold-store peek-chunk`

Stream the first N rows of a chunk to stdout (for debugging)

Synopsis: `kici-admin cold-store peek-chunk <chunkId> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `chunkId` | yes      | no       |             |

**Options**

| Option                          | Default | Description                                        |
| ------------------------------- | ------- | -------------------------------------------------- |
| `--database-url <url>`          |         | Orchestrator Postgres URL (else KICI_DATABASE_URL) |
| `--table <table>`               |         | Adapter table name                                 |
| `--tenant <rk>`                 |         | Routing key for the chunk                          |
| `--partition-date <YYYY-MM-DD>` |         | Partition date for the chunk                       |
| `--limit <n>`                   | `10`    | Number of rows to print                            |

### `kici-admin cold-store purge-now`

Phase 2: purge expired chunks from S3 + PG bookkeeping. DRY-RUN by default — pass --apply to actually delete.

Synopsis: `kici-admin cold-store purge-now [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL)    |
| `--table <table>`      |         | Filter to a single adapter table (else all)           |
| `--bucket <bucket>`    |         | Filter to a single cold-bucket (30d / 180d / 1y / 2y) |
| `--limit <n>`          | `1000`  | Max candidates to process                             |
| `--apply`              |         | Actually delete (default is dry-run)                  |

### `kici-admin cold-store reconcile`

Walk S3 prefix and rebuild missing manifests from data files

Synopsis: `kici-admin cold-store reconcile <table> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `table`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `--database-url <url>` |         | Orchestrator Postgres URL (else KICI_DATABASE_URL)      |
| `--tenant <rk>`        |         | Scope to a single routing key                           |
| `--confirm-cleanup`    |         | Also delete chunk_counts rows whose S3 objects are gone |

### `kici-admin cold-store replay-chunk`

Re-run UPDATE+DELETE+audit for a chunk that landed in S3 but not in PG

Synopsis: `kici-admin cold-store replay-chunk <chunkId> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `chunkId` | yes      | no       |             |

**Options**

| Option                          | Default | Description                                        |
| ------------------------------- | ------- | -------------------------------------------------- |
| `--database-url <url>`          |         | Orchestrator Postgres URL (else KICI_DATABASE_URL) |
| `--table <table>`               |         | Adapter table name                                 |
| `--tenant <rk>`                 |         | Routing key for the chunk                          |
| `--partition-date <YYYY-MM-DD>` |         | Partition date for the chunk                       |

### `kici-admin cold-store replay-into-pg`

Phase F: promote every row in a chunk BACK into orchestrator PG (clear archived_at, write replay audit)

Synopsis: `kici-admin cold-store replay-into-pg <chunkId> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `chunkId` | yes      | no       |             |

**Options**

| Option                          | Default | Description                                        |
| ------------------------------- | ------- | -------------------------------------------------- |
| `--database-url <url>`          |         | Orchestrator Postgres URL (else KICI_DATABASE_URL) |
| `--table <table>`               |         | Adapter table name (currently: execution_runs)     |
| `--tenant <rk>`                 |         | Routing key for the chunk                          |
| `--partition-date <YYYY-MM-DD>` |         | Partition date for the chunk                       |

### `kici-admin cold-store verify-chunk`

Recompute the gzipped contentHash for a chunk and compare to its manifest

Synopsis: `kici-admin cold-store verify-chunk <chunkId> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `chunkId` | yes      | no       |             |

**Options**

| Option                          | Default | Description                                         |
| ------------------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>`          |         | Orchestrator Postgres URL (else KICI_DATABASE_URL)  |
| `--table <table>`               |         | Adapter table name (chunkId is unique within table) |
| `--tenant <rk>`                 |         | Routing key for the chunk (from list-chunks output) |
| `--partition-date <YYYY-MM-DD>` |         | Partition date (from list-chunks output)            |

### `kici-admin config`

Manage orchestrator configuration

Synopsis: `kici-admin config`

### `kici-admin config delete`

Remove a field from the shared config

Synopsis: `kici-admin config delete <path> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | yes      | no       |             |

**Options**

| Option                 | Default | Description                      |
| ---------------------- | ------- | -------------------------------- |
| `--description <desc>` |         | Change description               |
| `--format <format>`    | `json`  | Output format: json\|yaml\|table |

### `kici-admin config diff`

Compare local YAML config vs shared DB config

Synopsis: `kici-admin config diff [options]`

**Options**

| Option              | Default | Description                      |
| ------------------- | ------- | -------------------------------- |
| `--format <format>` | `table` | Output format: json\|yaml\|table |

### `kici-admin config export`

Export shared config (sensitive values redacted)

Synopsis: `kici-admin config export [options]`

**Options**

| Option              | Default | Description               |
| ------------------- | ------- | ------------------------- |
| `--format <format>` | `yaml`  | Output format: json\|yaml |

### `kici-admin config get`

Get current effective config (merged local + shared + env)

Synopsis: `kici-admin config get [path] [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | no       | no       |             |

**Options**

| Option              | Default | Description                      |
| ------------------- | ------- | -------------------------------- |
| `--format <format>` | `json`  | Output format: json\|yaml\|table |

### `kici-admin config history`

Show config version history

Synopsis: `kici-admin config history [options]`

**Options**

| Option              | Default | Description                      |
| ------------------- | ------- | -------------------------------- |
| `--limit <n>`       | `20`    | Maximum versions to show         |
| `--format <format>` | `table` | Output format: json\|yaml\|table |

### `kici-admin config init`

Generate a starter orchestrator.yaml with commented defaults

Synopsis: `kici-admin config init [options]`

**Options**

| Option            | Default               | Description      |
| ----------------- | --------------------- | ---------------- |
| `--output <path>` | `./orchestrator.yaml` | Output file path |

### `kici-admin config reload`

Trigger config reload across the cluster

Synopsis: `kici-admin config reload [options]`

**Options**

| Option                   | Default | Description                           |
| ------------------------ | ------- | ------------------------------------- |
| `--drain`                |         | Drain in-flight work before reloading |
| `--target <instance-id>` |         | Target specific instance              |
| `--format <format>`      | `json`  | Output format: json\|yaml\|table      |

### `kici-admin config rollback`

Rollback shared config to a specific version

Synopsis: `kici-admin config rollback [options]`

**Options**

| Option              | Default | Description                      |
| ------------------- | ------- | -------------------------------- |
| `--to <version>`    |         | Target version number            |
| `--format <format>` | `json`  | Output format: json\|yaml\|table |

### `kici-admin config seed`

Bulk import shared config from a YAML file

Synopsis: `kici-admin config seed [options]`

**Options**

| Option                 | Default | Description                      |
| ---------------------- | ------- | -------------------------------- |
| `--file <path>`        |         | Path to YAML config file         |
| `--description <desc>` |         | Change description               |
| `--format <format>`    | `json`  | Output format: json\|yaml\|table |

### `kici-admin config set`

Set a single field in the shared config

Synopsis: `kici-admin config set <path> <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | yes      | no       |             |
| `value`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                      |
| ---------------------- | ------- | -------------------------------- |
| `--description <desc>` |         | Change description               |
| `--format <format>`    | `json`  | Output format: json\|yaml\|table |

### `kici-admin config validate`

Validate a config file against schema

Synopsis: `kici-admin config validate [options]`

**Options**

| Option              | Default  | Description                                      |
| ------------------- | -------- | ------------------------------------------------ |
| `--file <path>`     |          | Path to config file                              |
| `--type <type>`     | `shared` | Schema type: local\|shared\|full                 |
| `--offline`         |          | Validate locally without contacting orchestrator |
| `--format <format>` | `json`   | Output format: json\|yaml\|table                 |

### `kici-admin context`

Context management (dual-mode)

Synopsis: `kici-admin context`

### `kici-admin context bind`

Upsert a context_bindings row (scope_pattern → context)

Synopsis: `kici-admin context bind [options]`

**Options**

| Option                 | Default | Description                                                                   |
| ---------------------- | ------- | ----------------------------------------------------------------------------- |
| `--org <id>`           |         | Org ID                                                                        |
| `--env <name>`         |         | Context name                                                                  |
| `--scope <pattern>`    |         | Scope pattern (e.g. "staging" or "aws/prod/\*\*")                             |
| `--host <pattern>`     | `**`    | Host selector (exact/glob/regex over agentId/host/labels); "\*\*" = all hosts |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                           |
| `--json`               |         | Emit JSON output                                                              |

### `kici-admin context create`

Upsert a context (idempotent by org+name)

Synopsis: `kici-admin context create [options]`

**Options**

| Option                         | Default | Description                                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `--org <id>`                   |         | Org ID                                                                          |
| `--name <name>`                |         | Context name                                                                    |
| `--type <t>`                   | `fixed` | Context type (fixed\|glob\|template)                                            |
| `--glob-pattern <pattern>`     |         | Glob pattern matched against declared context names (required with --type glob) |
| `--enabled <bool>`             | `true`  | Enabled flag (true\|false)                                                      |
| `--branch-restrictions <json>` |         | JSON array of allowed branches (e.g. '["main"]')                                |
| `--required-reviewers <csv>`   |         | CSV of required reviewer user IDs (or empty to clear)                           |
| `--wait-timer <seconds>`       |         | Wait timer before release (seconds)                                             |
| `--hold-expiry <seconds>`      |         | Hold expiry TTL (seconds)                                                       |
| `--minimum-trust <level>`      |         | Minimum trust (known\|trusted)                                                  |
| `--database-url <url>`         |         | Use direct DB access instead of HTTP (offline mode)                             |
| `--json`                       |         | Emit JSON output                                                                |

### `kici-admin context create-template`

Create or update a context template + its seed variables

Synopsis: `kici-admin context create-template [options]`

**Options**

| Option                         | Default    | Description                                             |
| ------------------------------ | ---------- | ------------------------------------------------------- |
| `--org <id>`                   |            | Org ID                                                  |
| `--template <name>`            |            | Template name                                           |
| `--type <t>`                   | `template` | Context type (defaults to "template")                   |
| `--branch-restrictions <json>` |            | JSON array of allowed branches                          |
| `--required-reviewers <csv>`   |            | CSV of required reviewer user IDs                       |
| `--wait-timer <seconds>`       |            | Wait timer (seconds)                                    |
| `--hold-expiry <seconds>`      |            | Hold expiry TTL (seconds)                               |
| `--minimum-trust <level>`      |            | Minimum trust (known\|trusted)                          |
| `--variables <json>`           |            | JSON object of env variables to seed (e.g. '{"K":"V"}') |
| `--database-url <url>`         |            | Use direct DB access instead of HTTP (offline mode)     |
| `--json`                       |            | Emit JSON output                                        |

### `kici-admin context delete`

Delete a context (cascades bindings, variables, overrides; held-run history survives; pending held runs block with a clear error, resolved holds do not)

Synopsis: `kici-admin context delete [options]`

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--org <id>`           |         | Org ID                                              |
| `--name <name>`        |         | Context name                                        |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin context list`

List contexts for an org

Synopsis: `kici-admin context list [options]`

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--org <id>`           |         | Org ID                                              |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin context purge`

Delete all contexts (and held runs) for an org — direct-DB break-glass / warm-start reset

Synopsis: `kici-admin context purge [options]`

**Options**

| Option                 | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access (or KICI_DATABASE_URL)             |
| `--org <id>`           |         | Restrict purge to a single org (omit to purge all orgs) |
| `--json`               |         | Emit JSON output                                        |

### `kici-admin context set-policy`

Update policy fields on a context (only provided fields change)

Synopsis: `kici-admin context set-policy [options]`

**Options**

| Option                           | Default | Description                                           |
| -------------------------------- | ------- | ----------------------------------------------------- |
| `--org <id>`                     |         | Org ID                                                |
| `--env <name>`                   |         | Context name                                          |
| `--branch-restrictions <json>`   |         | JSON array of allowed branches                        |
| `--required-reviewers <csv>`     |         | CSV of required reviewer user IDs (empty to clear)    |
| `--wait-timer <seconds>`         |         | Wait timer before release (seconds)                   |
| `--hold-expiry <seconds>`        |         | Hold expiry TTL (seconds)                             |
| `--minimum-trust <level>`        |         | Minimum trust (known\|trusted, or "null" to clear)    |
| `--enabled <bool>`               |         | Enabled flag (true\|false)                            |
| `--allow-local-execution <bool>` |         | Allow CLI/test runs to resolve this env (true\|false) |
| `--database-url <url>`           |         | Use direct DB access instead of HTTP (offline mode)   |
| `--json`                         |         | Emit JSON output                                      |

### `kici-admin context show`

Show a single context with variables + bindings

Synopsis: `kici-admin context show [options]`

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--org <id>`           |         | Org ID                                              |
| `--name <name>`        |         | Context name                                        |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin db`

Database management

Synopsis: `kici-admin db`

### `kici-admin db check-schema`

Compare bundled migrations vs live schema. Exit 2 on drift.

Synopsis: `kici-admin db check-schema [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Target DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--json`               | `false` | Emit JSON instead of a human-readable line            |

### `kici-admin db collation-check`

Compare pg_database.datcollversion against the running libc collation version. Exit 2 on drift.

Synopsis: `kici-admin db collation-check [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Target DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--json`               | `false` | Emit JSON instead of a human-readable line            |

### `kici-admin db create-readonly-user`

Create a read-only role with SELECT on all tables + default privileges

Synopsis: `kici-admin db create-readonly-user [options]`

**Options**

| Option                  | Default | Description                           |
| ----------------------- | ------- | ------------------------------------- |
| `--database-url <url>`  |         | Target DB URL (must connect as owner) |
| `--user <name>`         |         | Read-only role name                   |
| `--password <password>` |         | Role password                         |

### `kici-admin db create-role`

CREATE / ALTER ROLE with LOGIN [+ CREATEDB] (idempotent)

Synopsis: `kici-admin db create-role [options]`

**Options**

| Option                  | Default | Description                                          |
| ----------------------- | ------- | ---------------------------------------------------- |
| `--database-url <url>`  |         | Admin DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--user <name>`         |         | Role name to create or update                        |
| `--password <password>` |         | Role password (raw — quote as needed)                |
| `--createdb`            | `false` | Grant CREATEDB to the new role                       |

### `kici-admin db ensure`

CREATE DATABASE IF NOT EXISTS (idempotent)

Synopsis: `kici-admin db ensure <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | yes      | no       |             |

**Options**

| Option                        | Default | Description                                                                                                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--database-url <url>`        |         | Admin DB URL (else KICI_DATABASE_URL / DATABASE_URL)                                                                                              |
| `--owner <role>`              |         | DB owner role (default: URL user). Pass when the admin connection is privileged but the new DB should be owned by a separate non-privileged role. |
| `--revoke-connect-public`     |         | After ensure, REVOKE CONNECT ON DATABASE "<name>" FROM PUBLIC (recommended on shared clusters).                                                   |
| `--grant-connect-role <role>` |         | After ensure (and any --revoke-connect-public), GRANT CONNECT ON DATABASE "<name>" TO "<role>". Repeatable.                                       |

### `kici-admin db fresh`

DROP + CREATE the orchestrator DB, run migrations, record content hash

Synopsis: `kici-admin db fresh [options]`

**Options**

| Option                 | Default | Description                                                 |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `--database-url <url>` |         | Target database URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--confirm`            |         | Explicit confirmation (destructive)                         |
| `--yes`                |         | Skip interactive confirmation (for scripted use)            |

### `kici-admin db migrate`

Run pending database migrations (via orchestrator HTTP admin API)

Synopsis: `kici-admin db migrate [options]`

**Options**

| Option     | Default | Description                            |
| ---------- | ------- | -------------------------------------- |
| `--status` |         | Show migration status without applying |

### `kici-admin db refresh-collation-version`

ALTER DATABASE <db> REFRESH COLLATION VERSION. Metadata-only bump; pair with db reindex after a libc-base image rebuild.

Synopsis: `kici-admin db refresh-collation-version [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Target DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--reason <text>`      |         | Reason (recorded in stderr banner)                    |

### `kici-admin db reindex`

REINDEX DATABASE CONCURRENTLY <db>. Rebuilds every index under the running libc collation rules. Non-blocking but takes minutes + ~2× temp disk.

Synopsis: `kici-admin db reindex [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--database-url <url>` |         | Target DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--confirm`            |         | Explicit confirmation (destructive — long-running)    |
| `--reason <text>`      |         | Reason (recorded in stderr banner)                    |

### `kici-admin debug-bundle`

Generate a diagnostic debug bundle ZIP for troubleshooting

Synopsis: `kici-admin debug-bundle [options]`

**Options**

| Option                      | Default                      | Description                                                                                                   |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `-o, --output <path>`       | `kici-debug-<timestamp>.zip` | Output ZIP file path                                                                                          |
| `--log-dir <path>`          |                              | Directory with rotated \*.log files to include (defaults to $KICI_LOG_DIR)                                    |
| `--log-window <hours>`      | `4`                          | Hours of log history to include in the bundle                                                                 |
| `--fleet`                   |                              | Collect logs from every node in the cluster (server-side fan-out)                                             |
| `--list`                    |                              | With --fleet: print the fleet topology and exit (no collection)                                               |
| `--json`                    |                              | With --fleet --list: emit the topology as JSON                                                                |
| `--pick [selectors]`        |                              | With --fleet: comma-separated selectors (id/host\*/label:k=v); bare flag opens an interactive picker on a TTY |
| `--fleet-timeout <seconds>` | `60`                         | Per-node deadline for --fleet                                                                                 |

### `kici-admin diagnose`

Run diagnostic health checks on the orchestrator

Synopsis: `kici-admin diagnose [options]`

**Options**

| Option   | Default | Description                                |
| -------- | ------- | ------------------------------------------ |
| `--json` |         | Output raw JSON instead of formatted table |

### `kici-admin event`

Internal event emission (kici_events)

Synopsis: `kici-admin event`

### `kici-admin event emit`

INSERT a row into kici_events and fire pg_notify — simulates agent ctx.emit() for e2e tests

Synopsis: `kici-admin event emit <name> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `name`   | yes      | no       |             |

**Options**

| Option                     | Default | Description                                                       |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| `--payload-file <path>`    |         | Path to JSON file whose contents become the event payload         |
| `--source-routing-key <k>` |         | Source routing key for cross-repo event matching (default: empty) |
| `--source-repo <r>`        |         | Source repo identifier for cross-repo matching (default: empty)   |
| `--database-url <url>`     |         | Use direct DB access instead of HTTP (offline mode)               |
| `--json`                   | `false` | Emit JSON output { eventId } on stdout                            |

### `kici-admin event-dlq`

Inspect / retry / discard events in the DLQ (at-least-once delivery)

Synopsis: `kici-admin event-dlq`

### `kici-admin event-dlq count`

Print the total number of events in the DLQ

Synopsis: `kici-admin event-dlq count`

### `kici-admin event-dlq discard`

Permanently delete an event from the DLQ

Synopsis: `kici-admin event-dlq discard <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin event-dlq list`

List events currently in the DLQ (most recent first)

Synopsis: `kici-admin event-dlq list [options]`

**Options**

| Option           | Default | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `--limit <n>`    | `50`    | Max rows (default 50, max 200)                       |
| `--before <iso>` |         | Cursor: list events with dlq_at < this ISO timestamp |
| `--json`         | `false` | Print raw JSON instead of a formatted table          |

### `kici-admin event-dlq retry`

Clear the DLQ flag, reset attempts, and schedule the event for immediate retry

Synopsis: `kici-admin event-dlq retry <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin event-log`

Inspect the inbound webhook delivery log

Synopsis: `kici-admin event-log`

### `kici-admin event-log list`

List inbound webhook deliveries (dogfooded via /api/v1/admin/event-log)

Synopsis: `kici-admin event-log list [options]`

**Options**

| Option                   | Default | Description                                                                              |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `--org <orgId>`          |         | Filter by org/tenant ID                                                                  |
| `--routing-key <key>`    |         | Filter by routing key (e.g. github:42)                                                   |
| `--event <type>`         |         | Filter by event type (e.g. push, pull_request)                                           |
| `--action <action>`      |         | Filter by event action (e.g. opened, closed, synchronize for pull_request)               |
| `--status <s>`           |         | Filter by outcome status (received\|processed\|duplicate\|lockfile_missing\|failed)      |
| `--from <ts>`            |         | ISO timestamp lower bound (inclusive)                                                    |
| `--to <ts>`              |         | ISO timestamp upper bound (exclusive)                                                    |
| `--delivery-id <substr>` |         | Substring filter on delivery_id                                                          |
| `--limit <n>`            | `50`    | Max results (default 50, max 200)                                                        |
| `--offset <n>`           | `0`     | Skip first N results                                                                     |
| `--include-archived`     |         | Merge cold-store archived rows into the result (requires --routing-key for cold scoping) |
| `--json`                 |         | Emit raw JSON instead of a table                                                         |

### `kici-admin event-log show`

Show a single delivery (optionally including the payload body)

Synopsis: `kici-admin event-log show <deliveryId> [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `deliveryId` | yes      | no       |             |

**Options**

| Option                | Default | Description                                                     |
| --------------------- | ------- | --------------------------------------------------------------- |
| `--org <orgId>`       |         | Org/tenant ID for the delivery                                  |
| `--include-payload`   |         | Also fetch the payload body (requires event_log.read_payload)   |
| `--routing-key <key>` |         | Routing key hint for cold-store fallback (scopes the cold scan) |
| `--json`              |         | Emit raw JSON instead of formatted output                       |

### `kici-admin execution`

Execution data maintenance

Synopsis: `kici-admin execution`

### `kici-admin execution list`

List execution_runs (read-only)

Synopsis: `kici-admin execution list [options]`

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--routing-key <k>`    |         | Filter by routing_key                               |
| `--status <s>`         |         | Filter by status                                    |
| `--workflow-name <n>`  |         | Filter by workflow_name                             |
| `--limit <n>`          |         | Max rows to return (default 100, max 1000)          |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin execution purge-stale`

DELETE execution_runs/jobs whose routing_key differs from the current cluster

Synopsis: `kici-admin execution purge-stale [options]`

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--routing-key <key>`  |         | Current routing key to preserve                     |
| `--confirm`            |         | Explicit confirmation flag                          |

### `kici-admin execution show`

Show one run + its jobs (by run_id)

Synopsis: `kici-admin execution show <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin firecracker`

Provision and verify Firecracker host networking

Synopsis: `kici-admin firecracker`

### `kici-admin firecracker provision`

Create/heal a Firecracker host bridge (NAT + egress isolation)

Synopsis: `kici-admin firecracker provision [options]`

**Options**

| Option                 | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `--bridge <name>`      |         | bridge interface name (e.g. kici-br0)                   |
| `--cidr <cidr>`        |         | gateway IP + prefix (e.g. 10.0.0.1/24)                  |
| `--table <name>`       | `kici`  | nft table name                                          |
| `--host-iface <iface>` |         | NAT egress interface (auto-detected if omitted)         |
| `--persist`            |         | install a systemd oneshot so the bridge survives reboot |
| `--sudo`               |         | wrap privileged commands with sudo -n (non-root host)   |

### `kici-admin firecracker teardown`

Remove a Firecracker host bridge + its nft table (leaves NM conf in place)

Synopsis: `kici-admin firecracker teardown [options]`

**Options**

| Option            | Default     | Description                                            |
| ----------------- | ----------- | ------------------------------------------------------ |
| `--bridge <name>` |             | bridge interface name                                  |
| `--cidr <cidr>`   | `0.0.0.0/0` | gateway IP + prefix (unused but accepted for symmetry) |
| `--table <name>`  | `kici`      | nft table name                                         |
| `--sudo`          |             | wrap privileged commands with sudo -n                  |

### `kici-admin firecracker verify`

Check a Firecracker host bridge is up with its addr + nft table

Synopsis: `kici-admin firecracker verify [options]`

**Options**

| Option            | Default | Description                           |
| ----------------- | ------- | ------------------------------------- |
| `--bridge <name>` |         | bridge interface name                 |
| `--cidr <cidr>`   |         | gateway IP + prefix                   |
| `--table <name>`  | `kici`  | nft table name                        |
| `--sudo`          |         | wrap privileged commands with sudo -n |

### `kici-admin host`

Inspect and declare the host roster

Synopsis: `kici-admin host`

### `kici-admin host declare`

Pre-declare a static host before it connects

Synopsis: `kici-admin host declare [options]`

**Options**

| Option                   | Default | Description                                                              |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `--agent-id <id>`        |         | Agent id the host will register as                                       |
| `--labels <labels>`      |         | Comma-separated labels                                                   |
| `--hostname <name>`      |         | Hostname                                                                 |
| `--prop <key=value>`     |         | Typed host property (repeatable; true/false ⇒ boolean, numeric ⇒ number) |
| `--address <host>`       |         | Pre-agent SSH reach address (IP / hostname) for bootstrap                |
| `--ssh-user <user>`      |         | SSH login user for bootstrap bring-up                                    |
| `--ssh-port <port>`      |         | SSH port for bootstrap bring-up                                          |
| `--ssh-key-secret <ref>` |         | Scoped-secret ref (scope/key) holding the bring-up private key           |

### `kici-admin host get`

Show one roster host

Synopsis: `kici-admin host get [options]`

**Options**

| Option            | Default | Description |
| ----------------- | ------- | ----------- |
| `--agent-id <id>` |         | Agent id    |
| `--json`          |         | Output JSON |

### `kici-admin host list`

List all roster hosts

Synopsis: `kici-admin host list [options]`

**Options**

| Option   | Default | Description |
| -------- | ------- | ----------- |
| `--json` |         | Output JSON |

### `kici-admin host remove`

Remove a host from the roster

Synopsis: `kici-admin host remove [options]`

**Options**

| Option            | Default | Description        |
| ----------------- | ------- | ------------------ |
| `--agent-id <id>` |         | Agent id to remove |

### `kici-admin inspect-bundle`

Parse and display a structured summary of a debug bundle

Synopsis: `kici-admin inspect-bundle <path>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | yes      | no       |             |

### `kici-admin join`

Join an existing orchestrator cluster using a join token

Synopsis: `kici-admin join [options]`

**Options**

| Option             | Default                    | Description                                                              |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| `--token <token>`  |                            | Join token (kici_join_v1.<routing>.<secret>)                             |
| `--platform <url>` |                            | Platform WebSocket URL for relay mode (e.g., wss://platform.kici.dev/ws) |
| `--peer <url>`     |                            | Peer HTTP URL for direct mode (e.g., https://orch-1:8080)                |
| `--api-key <key>`  |                            | API key for Platform authentication (required for --platform mode)       |
| `--config <path>`  | `./kici-orchestrator.yaml` | Path to write the resulting local config YAML                            |

### `kici-admin orchestrator`

Manage orchestrator service installation and lifecycle

Synopsis: `kici-admin orchestrator`

### `kici-admin orchestrator install`

Install the orchestrator as a system service

Synopsis: `kici-admin orchestrator install [options]`

**Options**

| Option                  | Default             | Description                                                                                                          |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--platform <type>`     |                     | Service platform (systemd, launchd, windows, compose)                                                                |
| `--env-file <path>`     |                     | Path to existing env/config file to use                                                                              |
| `--binary <path>`       |                     | Path to orchestrator binary (default: current executable)                                                            |
| `--dev`                 |                     | Dev mode: spin up PostgreSQL container on port 15432                                                                 |
| `--wizard`              |                     | Interactive wizard for guided setup                                                                                  |
| `--name <name>`         | `kici-orchestrator` | Service name                                                                                                         |
| `--system`              |                     | Install as system-level service (requires root)                                                                      |
| `--user-level`          |                     | Install as user-level service (no root required)                                                                     |
| `--user <name>`         |                     | Run the service as the named user (system-level launchd only; sets UserName in plist so the daemon drops privileges) |
| `--instance-dir <path>` |                     | Deploy folder; the instance manifest is written here (default: current working directory)                            |
| `--force`               |                     | Overwrite an existing same-named foreign instance                                                                    |

### `kici-admin orchestrator logs`

Tail and follow orchestrator service logs

Synopsis: `kici-admin orchestrator logs [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance whose logs to read         |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--since <duration>`    |         | Show logs since duration (e.g. 1h, 30m)                  |
| `--level <level>`       |         | Filter by log level (error\|warn\|info)                  |
| `--json`                |         | Output as structured JSON                                |
| `--no-follow`           |         | Snapshot mode (do not tail)                              |

### `kici-admin orchestrator restart`

Restart the orchestrator service

Synopsis: `kici-admin orchestrator restart [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to restart                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin orchestrator start`

Start the orchestrator service

Synopsis: `kici-admin orchestrator start [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to start                   |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin orchestrator status`

Show orchestrator service status and health information

Synopsis: `kici-admin orchestrator status [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to inspect                 |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |
| `--json`                |         | Output as JSON                                           |

### `kici-admin orchestrator stop`

Stop the orchestrator service

Synopsis: `kici-admin orchestrator stop [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to stop                    |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin orchestrator uninstall`

Remove the orchestrator service registration

Synopsis: `kici-admin orchestrator uninstall [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd, launchd, windows, compose)    |
| `--instance-dir <path>` |         | Deploy folder of the instance to uninstall               |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD)    |
| `--system`              |         | Operate against the system-level service (requires root) |
| `--user-level`          |         | Operate against the user-level service                   |

### `kici-admin orchestrator upgrade`

Upgrade orchestrator to a new version using versioned directory layout

Synopsis: `kici-admin orchestrator upgrade [options]`

**Options**

| Option                  | Default | Description                                           |
| ----------------------- | ------- | ----------------------------------------------------- |
| `--platform <type>`     |         | Service platform (systemd\|launchd\|windows\|compose) |
| `--instance-dir <path>` |         | Deploy folder of the instance to upgrade              |
| `--name <name>`         |         | Service name (no default — must resolve via flag/CWD) |
| `--from <path>`         |         | Path to package archive (.tar.gz or .zip)             |
| `--url <url>`           |         | URL to download package archive from                  |
| `--version <version>`   |         | Target version string (e.g., 0.3.0)                   |
| `--yes`                 |         | Skip confirmation prompt                              |
| `--force`               |         | Overwrite existing versioned directory                |
| `--cleanup`             |         | Remove old versions (keeps current and previous)      |
| `--rollback`            |         | Roll back to the previous version                     |
| `--pick`                |         | Interactively pick an installed version to activate   |

### `kici-admin org-settings`

Manage org-level security settings

Synopsis: `kici-admin org-settings`

### `kici-admin org-settings allow-http-npm`

Permit plain http:// npm registry URLs in workflow registries:. Default false; loopback / \*.local are always allowed regardless.

Synopsis: `kici-admin org-settings allow-http-npm <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval`

Manage the per-org held-approval expiry + self-approval policy

Synopsis: `kici-admin org-settings approval`

### `kici-admin org-settings approval set-expiry`

Set the per-org held-approval expiry (integer seconds, >= 1)

Synopsis: `kici-admin org-settings approval set-expiry <seconds> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `seconds` | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval set-self-approval`

Allow or forbid a run triggerer approving its own held elements (true|false)

Synopsis: `kici-admin org-settings approval set-self-approval <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings approval show`

Print the current per-org approval policy

Synopsis: `kici-admin org-settings approval show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dashboard-writes`

Manage per-orch dashboard write policy (which Platform-routed dashboard.\* writes the orch accepts)

Synopsis: `kici-admin org-settings dashboard-writes`

### `kici-admin org-settings dashboard-writes reset`

Reset all operations to enabled (permissive default).

Synopsis: `kici-admin org-settings dashboard-writes reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dashboard-writes set`

Set one or more operations. Use --op <name>=<true|false> per operation. Sugar: --category or --sensitivity + --enabled <bool> expands to the matching operations.

Synopsis: `kici-admin org-settings dashboard-writes set [options]`

**Options**

| Option                 | Default | Description                                                                              |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `--customer-id <id>`   |         | Customer / org id (alias: --org)                                                         |
| `--org <id>`           |         | Alias for --customer-id                                                                  |
| `--op <op=bool>`       |         | Single operation flip; repeatable (e.g. --op secrets.set=false --op variables.set=false) |
| `--category <name>`    |         | Apply --enabled to every operation in this category                                      |
| `--sensitivity <name>` |         | Apply --enabled to every operation in this sensitivity bucket                            |
| `--enabled <bool>`     |         | Pair with --category or --sensitivity to flip the whole group                            |
| `--format <format>`    | `table` | Output format: json\|table                                                               |

### `kici-admin org-settings dashboard-writes show`

Print current dashboard-write policy. Empty = all enabled.

Synopsis: `kici-admin org-settings dashboard-writes show [options]`

**Options**

| Option                 | Default | Description                                                                                                    |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`   |         | Customer / org id (alias: --org)                                                                               |
| `--org <id>`           |         | Alias for --customer-id                                                                                        |
| `--category <name>`    |         | Filter to one category (Secrets\|Variables\|Environments\|Bindings\|"Held runs"\|DLQ\|Registrations\|Topology) |
| `--sensitivity <name>` |         | Filter to one sensitivity bucket (plaintext\|authority\|dispatch)                                              |
| `--format <format>`    | `table` | Output format: json\|table                                                                                     |

### `kici-admin org-settings dispatch-ack`

Manage the per-org dispatch-acknowledgment deadline (null = cluster default)

Synopsis: `kici-admin org-settings dispatch-ack`

### `kici-admin org-settings dispatch-ack reset`

Clear the per-org dispatch-ack deadline override (fall back to the cluster default)

Synopsis: `kici-admin org-settings dispatch-ack reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dispatch-ack set`

Set the per-org dispatch-acknowledgment deadline (integer milliseconds, >= 1000)

Synopsis: `kici-admin org-settings dispatch-ack set <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dispatch-ack show`

Print the current per-org dispatch-acknowledgment deadline

Synopsis: `kici-admin org-settings dispatch-ack show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings global-workflows`

Manage per-org global workflow policy

Synopsis: `kici-admin org-settings global-workflows`

### `kici-admin org-settings global-workflows allow-add`

Add a glob pattern to the workflow-author allow-list. Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows allow-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows allow-remove`

Remove a glob pattern from the workflow-author allow-list. Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows allow-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows deny-add`

Add a glob pattern to the source-repo deny-list. Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows deny-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows deny-remove`

Remove a glob pattern from the source-repo deny-list. Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows deny-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows elevate-add`

Add a glob pattern to the elevated-access list. Use --source to qualify the entry to one webhook source.

Synopsis: `kici-admin org-settings global-workflows elevate-add <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                |
| ----------------------- | ------- | -------------------------------------------------------------------------- |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                           |
| `--org <id>`            |         | Alias for --customer-id                                                    |
| `--source <routingKey>` |         | Pin the entry to one webhook source (e.g. github:42). Omit for any source. |
| `--format <format>`     | `table` | Output format: json\|table                                                 |

### `kici-admin org-settings global-workflows elevate-remove`

Remove a glob pattern from the elevated-access list. Use --source to target a source-qualified entry.

Synopsis: `kici-admin org-settings global-workflows elevate-remove <pattern> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `pattern` | yes      | no       |             |

**Options**

| Option                  | Default | Description                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------ |
| `--customer-id <id>`    |         | Customer / org id (alias: --org)                                               |
| `--org <id>`            |         | Alias for --customer-id                                                        |
| `--source <routingKey>` |         | Match an entry pinned to this routing key. Omit to match an unqualified entry. |
| `--format <format>`     | `table` | Output format: json\|table                                                     |

### `kici-admin org-settings global-workflows set-enabled`

Toggle the master enable switch (true|false)

Synopsis: `kici-admin org-settings global-workflows set-enabled <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings global-workflows show`

Print current global workflow settings for an org

Synopsis: `kici-admin org-settings global-workflows show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache`

Manage per-org user-facing cache quota + entry TTL (null = cluster default)

Synopsis: `kici-admin org-settings user-cache`

### `kici-admin org-settings user-cache reset-quota`

Clear the per-org user-cache quota override (fall back to the cluster default)

Synopsis: `kici-admin org-settings user-cache reset-quota [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache reset-ttl`

Clear the per-org user-cache ttl override (fall back to the cluster default)

Synopsis: `kici-admin org-settings user-cache reset-ttl [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache set-quota`

Set the per-org user-cache quota (positive integer bytes)

Synopsis: `kici-admin org-settings user-cache set-quota <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache set-ttl`

Set the per-org user-cache ttl (positive integer milliseconds)

Synopsis: `kici-admin org-settings user-cache set-ttl <value> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `value`  | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings user-cache show`

Print the current per-org user-cache quota + TTL settings

Synopsis: `kici-admin org-settings user-cache show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin peer`

Manage peer tokens and credentials

Synopsis: `kici-admin peer`

### `kici-admin peer create-token`

Create a join token for a new peer

Synopsis: `kici-admin peer create-token [options]`

**Options**

| Option                   | Default       | Description                                                       |
| ------------------------ | ------------- | ----------------------------------------------------------------- |
| `--role <role>`          | `coordinator` | Peer role (worker or coordinator)                                 |
| `--expiry-hours <hours>` | `1`           | Token expiry in hours                                             |
| `--org-id <id>`          | `default`     | Organization ID                                                   |
| `--routing-key <key>`    | `default`     | Routing key                                                       |
| `--created-by <actor>`   | `cli`         | Attribution written to join_tokens.created_by                     |
| `--json`                 | `false`       | Emit JSON { token, role, expiresAt, orgId, routingKey } on stdout |

### `kici-admin peer list`

List active peer credentials

Synopsis: `kici-admin peer list`

### `kici-admin peer prune-credentials`

DELETE peer_credentials rows whose instance_id does NOT LIKE <filter> (direct-DB only, destructive). Used by cluster e2e to wipe stale staging peer credentials while leaving e2e-\* peers intact. HTTP mode is intentionally unsupported: the call site is a warm-deploy preflight run while the orchestrator is stopped, mirroring peer reset-raft-state.

Synopsis: `kici-admin peer prune-credentials [options]`

**Options**

| Option                 | Default | Description                                                                                   |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `--filter <pattern>`   |         | SQL LIKE pattern for instance_ids to KEEP (e.g. "e2e-%"). Rows that do NOT match are deleted. |
| `--database-url <url>` |         | Use direct DB access (offline mode, required)                                                 |
| `--json`               | `false` | Emit JSON { deleted } on stdout                                                               |

### `kici-admin peer reset-raft-state`

DELETE all rows from raft_state so a freshly-started orchestrator self-elects with a clean term (direct-DB only, destructive)

Synopsis: `kici-admin peer reset-raft-state [options]`

**Options**

| Option                 | Default | Description                                   |
| ---------------------- | ------- | --------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access (offline mode, required) |
| `--json`               | `false` | Emit JSON { rowsDeleted } on stdout           |

### `kici-admin peer revoke`

Revoke a peer credential by instance ID

Synopsis: `kici-admin peer revoke [options]`

**Options**

| Option               | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `--instance-id <id>` |         | Instance ID of the peer to revoke |

### `kici-admin peer revoke-all`

Revoke all active peer credentials

Synopsis: `kici-admin peer revoke-all [options]`

**Options**

| Option      | Default | Description                                |
| ----------- | ------- | ------------------------------------------ |
| `--confirm` |         | Confirm revocation of all peer credentials |

### `kici-admin queue`

Dispatch queue maintenance

Synopsis: `kici-admin queue`

### `kici-admin queue clear`

TRUNCATE the dispatch_queue table (destructive)

Synopsis: `kici-admin queue clear [options]`

**Options**

| Option                 | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)     |
| `--confirm`            |         | Explicit confirmation flag                              |
| `--yes`                |         | Skip interactive confirmation prompt (for scripted use) |

### `kici-admin queue list`

List dispatch_queue entries (read-only)

Synopsis: `kici-admin queue list [options]`

**Options**

| Option                          | Default | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `--status <s>`                  |         | Filter by exact status (pending\|dispatched\|...)             |
| `--status-not-in <csv>`         |         | Filter status NOT IN (CSV; e.g. "completed,failed,cancelled") |
| `--job-name-prefix <p>`         |         | Filter by job_name prefix                                     |
| `--job-name <name>`             |         | Filter by exact job_name match                                |
| `--job-name-not-like <pattern>` |         | Exclude job_name LIKE pattern (e.g. "**build**%")             |
| `--workflow-name <n>`           |         | Filter by exact workflow_name                                 |
| `--created-after <iso>`         |         | Filter created_at > <ISO timestamp>                           |
| `--limit <n>`                   |         | Max rows to return (default 100, max 1000)                    |
| `--database-url <url>`          |         | Use direct DB access instead of HTTP (offline mode)           |
| `--json`                        |         | Emit JSON output                                              |

### `kici-admin queue show`

Show a single dispatch_queue row by id

Synopsis: `kici-admin queue show <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin registration`

Registered workflow instance read (workflow_registrations table)

Synopsis: `kici-admin registration`

### `kici-admin registration list`

List workflow_registrations rows (also returns registry_version)

Synopsis: `kici-admin registration list [options]`

**Options**

| Option                  | Default | Description                                         |
| ----------------------- | ------- | --------------------------------------------------- |
| `--org <id>`            |         | Filter by customer_id                               |
| `--routing-key <k>`     |         | Filter by routing_key                               |
| `--repo <ident>`        |         | Filter by repo_identifier                           |
| `--trigger-type <type>` |         | Filter by trigger type (in trigger_types[])         |
| `--limit <n>`           |         | Max rows (default 100, max 1000)                    |
| `--database-url <url>`  |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`                |         | Emit JSON output                                    |

### `kici-admin registration show`

Show a single workflow_registrations row by id

Synopsis: `kici-admin registration show <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                 | Default | Description                                         |
| ---------------------- | ------- | --------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode) |
| `--json`               |         | Emit JSON output                                    |

### `kici-admin remote-source`

Inspect the auto-provisioned remote-source org anchor

Synopsis: `kici-admin remote-source`

### `kici-admin remote-source show`

Print the remote_sources anchor row for an org (routing key remote:<orgId>).

Synopsis: `kici-admin remote-source show <orgId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--format <format>`    | `table` | Output format: json\|table                   |

### `kici-admin rotate-key`

Rotate the master encryption key (re-encrypts scoped_secrets and config_versions)

Synopsis: `kici-admin rotate-key`

### `kici-admin runs`

Inspect execution runs, jobs, and steps

Synopsis: `kici-admin runs`

### `kici-admin runs ephemeral-key`

Show whether the run-ephemeral key has been scrubbed yet

Synopsis: `kici-admin runs ephemeral-key <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option   | Default | Description                         |
| -------- | ------- | ----------------------------------- |
| `--json` |         | Emit raw JSON instead of plain text |

### `kici-admin runs jobs`

List jobs for a run (dogfooded via /api/v1/admin/runs/:runId/jobs)

Synopsis: `kici-admin runs jobs <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option            | Default | Description                                     |
| ----------------- | ------- | ----------------------------------------------- |
| `--include-steps` |         | Embed step list inside each job (default false) |
| `--json`          |         | Emit raw JSON instead of a table                |

### `kici-admin runs list`

List execution runs (dogfooded via /api/v1/admin/runs)

Synopsis: `kici-admin runs list [options]`

**Options**

| Option                   | Default | Description                                                                                  |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `--status <statuses>`    |         | Filter by run status. Accepts a single value or a comma-separated list (e.g. success,failed) |
| `--workflow-name <name>` |         | Filter by workflow name                                                                      |
| `--repo <ownerRepo>`     |         | Filter by repo identifier (owner/repo)                                                       |
| `--since <iso8601>`      |         | Only include runs with created_at strictly later than this ISO-8601 timestamp                |
| `--count`                |         | Return only the count of matching runs, skipping the row listing                             |
| `--limit <n>`            | `20`    | Max results (default 20, max 100)                                                            |
| `--offset <n>`           | `0`     | Skip first N results                                                                         |
| `--json`                 |         | Emit raw JSON instead of a table                                                             |

### `kici-admin runs secret-outputs`

List per-job secret outputs (masked by default; --reveal decrypts and audits)

Synopsis: `kici-admin runs secret-outputs <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option               | Default | Description                                                                                                     |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `--output-key <key>` |         | Filter to a single output_key                                                                                   |
| `--reveal`           |         | Decrypt and print plaintext values. Audited with actor=secret-outputs.reveal; requires secret.reveal permission |
| `--json`             |         | Emit raw JSON instead of a table                                                                                |

### `kici-admin runs show`

Show run detail with jobs and steps

Synopsis: `kici-admin runs show <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option   | Default | Description                               |
| -------- | ------- | ----------------------------------------- |
| `--json` |         | Emit raw JSON instead of formatted output |

### `kici-admin runs structured`

Show the provenance-tagged structured run result (agent read path; /structured)

Synopsis: `kici-admin runs structured <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option   | Default | Description                                                 |
| -------- | ------- | ----------------------------------------------------------- |
| `--json` |         | Emit the raw AgentRunResult (untrusted envelopes preserved) |

### `kici-admin scaler`

Scaler maintenance (local, no orchestrator)

Synopsis: `kici-admin scaler`

### `kici-admin scaler reap-orphans`

Free leaked Firecracker/container resources without a running orchestrator

Synopsis: `kici-admin scaler reap-orphans [options]`

**Options**

| Option            | Default | Description                                                                           |
| ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `--config <path>` |         | Path to the orchestrator config (default: KICI_CONFIG or /etc/kici/orchestrator.yaml) |
| `--force`         | `false` | Reap even if the local orchestrator reports healthy                                   |
| `--json`          | `false` | Emit machine-readable JSON counts                                                     |

### `kici-admin secret`

Manage scoped secrets

Synopsis: `kici-admin secret`

### `kici-admin secret delete`

Delete a secret

Synopsis: `kici-admin secret delete <orgId> <scope> <key> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |
| `scope`  | yes      | no       |             |
| `key`    | yes      | no       |             |

**Options**

| Option  | Default | Description              |
| ------- | ------- | ------------------------ |
| `--yes` |         | Skip confirmation prompt |

### `kici-admin secret list`

List secret key names in a scope (values are never shown)

Synopsis: `kici-admin secret list <orgId> <scope>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |
| `scope`  | yes      | no       |             |

### `kici-admin secret purge`

Bulk-delete scoped_secrets. Irreversible — pair with rotate-key for recovery.

Synopsis: `kici-admin secret purge [options]`

**Options**

| Option                 | Default | Description                                             |
| ---------------------- | ------- | ------------------------------------------------------- |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)     |
| `--confirm`            |         | Explicit confirmation flag                              |
| `--org <orgId>`        |         | Restrict to a single org (defaults to ALL orgs)         |
| `--yes`                |         | Skip interactive confirmation prompt (for scripted use) |

### `kici-admin secret scopes`

List secret scopes for an organization

Synopsis: `kici-admin secret scopes <orgId>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |

### `kici-admin secret set`

Set a secret value. Positional form: "set <orgId> <scope> <key>". Sugar form (context scope): "set --org <id> --context <env> --key <k>". Value comes from one of: --prompt (default on TTY), --from-stdin (default on pipe), --from-file <path>, --from-env <VAR>, --value <plaintext> (discouraged).

Synopsis: `kici-admin secret set [orgId] [scope] [key] [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | no       | no       |             |
| `scope`  | no       | no       |             |
| `key`    | no       | no       |             |

**Options**

| Option                              | Default | Description                                                                                         |
| ----------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `--value <value>`                   |         | Secret value via argv (visible in shell history; prefer --prompt)                                   |
| `--org <orgId>`                     |         | Org ID (use with --context + --key; mutually exclusive with positional form)                        |
| `--context <name>`                  |         | Context scope — sugar for positional <scope>. Requires --org and --key.                             |
| `--key <key>`                       |         | Secret key name (use with --org + --context)                                                        |
| `--prompt`                          |         | Interactive no-echo prompt (requires TTY)                                                           |
| `--from-stdin`                      |         | Read value from piped stdin until EOF                                                               |
| `--from-file <path>`                |         | Read value from a file (trailing newline trimmed)                                                   |
| `--from-env <var>`                  |         | Read value from a named environment variable                                                        |
| `--no-trim`                         |         | When reading --from-file, keep the trailing newline (default: trim once)                            |
| `--confirm-fingerprint <sha256hex>` |         | Refuse the write unless SHA-256(value) matches this 64-hex string                                   |
| `--dry-run`                         |         | Parse + validate the value, print fingerprint + length, do not write                                |
| `--database-url <url>`              |         | Direct-DB mode: write encrypted_value verbatim to scoped_secrets (offline; skips HTTP + encryption) |

### `kici-admin source`

Manage webhook sources

Synopsis: `kici-admin source`

### `kici-admin source add`

Add a new webhook source

Synopsis: `kici-admin source add`

### `kici-admin source add generic`

Add a new generic webhook source

Synopsis: `kici-admin source add generic [options]`

**Options**

| Option                                | Default | Description                                                                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `--org <orgId>`                       |         | Organization/customer ID                                                                                    |
| `--name <name>`                       |         | Human-readable source name                                                                                  |
| `--verification <method>`             |         | Verification method: hmac_sha256, bearer_token, ip_allowlist, none                                          |
| `--secret <value>`                    |         | Verification secret (HMAC secret or bearer token, prefix with @ for file)                                   |
| `--from-env <varName>`                |         | Read verification secret from environment variable                                                          |
| `--stdin`                             |         | Read verification secret from stdin                                                                         |
| `--event-type-header <header>`        |         | Header name for event type extraction                                                                       |
| `--event-type-path <jsonpath>`        |         | JSONPath for event type extraction from body                                                                |
| `--idempotency-key-header <header>`   |         | Header name for idempotency key                                                                             |
| `--idempotency-key-path <jsonpath>`   |         | JSONPath for idempotency key from body                                                                      |
| `--dedup-window <seconds>`            |         | Dedup window in seconds (default: 300)                                                                      |
| `--max-payload <bytes>`               |         | Maximum payload size in bytes (default: 1048576)                                                            |
| `--allowed-events <events>`           |         | Comma-separated list of allowed event types                                                                 |
| `--strip-headers <headers>`           |         | Comma-separated list of headers to strip                                                                    |
| `--rate-limit <rpm>`                  |         | Rate limit in requests per minute (default: 600)                                                            |
| `--preset <name>`                     |         | Universal-git preset: forgejo, gitea, gogs, gitlab-repo, github-repo, custom                                |
| `--git-url-template <url>`            |         | Clone URL template with {owner}/{name}/{repo}                                                               |
| `--credential-ref <key>`              |         | Secret key name (under **source**/<id> scope)                                                               |
| `--credential-store <backend>`        |         | Secret backend name (default: pg)                                                                           |
| `--credential-type <type>`            |         | Credential type: pat, basic, ssh                                                                            |
| `--credential-user <user>`            |         | Username for PAT/basic auth (default: x-access-token)                                                       |
| `--ssh-host-key-policy <policy>`      |         | SSH host-key policy: accept-new, pinned                                                                     |
| `--ssh-known-hosts-pem <pathOrValue>` |         | Pinned SSH known_hosts (prefix with @ for file). Required when --ssh-host-key-policy=pinned                 |
| `--provider-type <type>`              |         | Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://) |
| `--json`                              |         | Emit raw JSON (the full source row) instead of formatted text                                               |

### `kici-admin source add github`

Add a new GitHub App source

Synopsis: `kici-admin source add github [options]`

**Options**

| Option                        | Default | Description                                                                                                                                                                        |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`               |         | Human-readable source name                                                                                                                                                         |
| `--app-id <id>`               |         | GitHub App ID (omit when using --manifest)                                                                                                                                         |
| `--private-key <pathOrValue>` |         | Private key (prefix with @ for file path)                                                                                                                                          |
| `--webhook-secret <secret>`   |         | Webhook secret                                                                                                                                                                     |
| `--from-env <varName>`        |         | Read private key from environment variable                                                                                                                                         |
| `--stdin`                     |         | Read private key from stdin                                                                                                                                                        |
| `--manifest`                  |         | One-click setup: create and configure a new GitHub App via the App Manifest flow                                                                                                   |
| `--no-browser`                |         | Headless manifest setup: print a URL and paste the setup code back                                                                                                                 |
| `--github-org <slug>`         |         | Create the App under a GitHub org instead of your personal account                                                                                                                 |
| `--webhook-url <url>`         |         | Advanced/self-hosted: bake this https:// URL into the App webhook verbatim and skip platform-mode URL resolution. KiCI adds no ingress at this URL — your own infra owns delivery. |
| `--json`                      |         | Emit raw JSON (the API response) instead of formatted text                                                                                                                         |

### `kici-admin source add local`

Register a git repo present on the agent filesystem as a file:// source

Synopsis: `kici-admin source add local [options]`

**Options**

| Option                   | Default | Description                                                                                                      |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `--org <orgId>`          |         | Organization/customer ID                                                                                         |
| `--path <dir>`           |         | Absolute path to the repo (or base dir of repos) on the agent filesystem                                         |
| `--name <name>`          | `local` | Human-readable source name                                                                                       |
| `--clone-url-base <url>` |         | Optional git://\|http:// base for remote agents that do not share the orchestrator filesystem (default: file://) |
| `--json`                 |         | Emit raw JSON (the full source row) instead of formatted text                                                    |

### `kici-admin source disable`

Disable a generic webhook source

Synopsis: `kici-admin source disable <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin source enable`

Enable a generic webhook source

Synopsis: `kici-admin source enable <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin source get`

Get details of a generic webhook source

Synopsis: `kici-admin source get <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option   | Default | Description                                                   |
| -------- | ------- | ------------------------------------------------------------- |
| `--json` |         | Emit raw JSON (the full source row) instead of formatted text |

### `kici-admin source get-webhook-secret`

Get the webhook secret for a source (for GitHub webhook configuration)

Synopsis: `kici-admin source get-webhook-secret <routingKey>`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

### `kici-admin source install-hook`

Install a post-receive hook in the local source repo that triggers runs on push

Synopsis: `kici-admin source install-hook <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option             | Default                 | Description                                  |
| ------------------ | ----------------------- | -------------------------------------------- |
| `--repo <path>`    |                         | Repo path (default: the source repoBasePath) |
| `--base-url <url>` | `http://localhost:8080` | Orchestrator base URL                        |

### `kici-admin source list`

List all configured sources (GitHub and generic)

Synopsis: `kici-admin source list [options]`

**Options**

| Option              | Default | Description                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `--org <orgId>`     |         | Filter generic sources by organization ID                                 |
| `--include-deleted` |         | Include soft-deleted generic sources                                      |
| `--json`            |         | Emit raw JSON ({github: [...], generic: [...]}) instead of formatted text |

### `kici-admin source list-presets`

List built-in universal-git presets (forge shapes supported out of the box)

Synopsis: `kici-admin source list-presets [options]`

**Options**

| Option              | Default | Description                |
| ------------------- | ------- | -------------------------- |
| `--format <format>` | `table` | Output format: table\|json |

### `kici-admin source purge-stale`

DELETE sources + scoped secrets whose routing_key differs from the current cluster

Synopsis: `kici-admin source purge-stale [options]`

**Options**

| Option                 | Default | Description                                            |
| ---------------------- | ------- | ------------------------------------------------------ |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)    |
| `--routing-key <key>`  |         | Current routing key to preserve                        |
| `--dry-run`            | `false` | Count stale rows without deleting them                 |
| `--confirm`            |         | Explicit confirmation flag (required unless --dry-run) |

### `kici-admin source refresh`

Re-sync a GitHub source's name and slug from GitHub (use --all for every source)

Synopsis: `kici-admin source refresh [routingKey] [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | no       | no       |             |

**Options**

| Option   | Default | Description                             |
| -------- | ------- | --------------------------------------- |
| `--all`  |         | Refresh every GitHub source             |
| `--json` |         | Emit raw JSON instead of formatted text |

### `kici-admin source remove`

Remove a source (GitHub, or generic/local with --generic / --local)

Synopsis: `kici-admin source remove <routingKey> [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

**Options**

| Option      | Default | Description                                                               |
| ----------- | ------- | ------------------------------------------------------------------------- |
| `--yes`     |         | Skip confirmation                                                         |
| `--generic` |         | Remove a generic source (routingKey is treated as source ID)              |
| `--local`   |         | Remove a local (file://) source (routingKey is treated as source ID)      |
| `--hard`    |         | Permanently delete a generic/local source (requires --generic or --local) |

### `kici-admin source trigger-local`

Trigger a run against a local source (reads HEAD when --ref/--sha omitted)

Synopsis: `kici-admin source trigger-local <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                    | Default                 | Description                               |
| ------------------------- | ----------------------- | ----------------------------------------- |
| `--event <event>`         | `push`                  | push \| pull_request                      |
| `--ref <ref>`             |                         | Git ref (default: repo HEAD branch)       |
| `--sha <sha>`             |                         | Commit SHA (default: repo HEAD)           |
| `--repo-full-name <name>` | `local/repo`            | owner/name identifier used in the payload |
| `--base-url <url>`        | `http://localhost:8080` | Orchestrator base URL                     |

### `kici-admin source update`

Update a GitHub source

Synopsis: `kici-admin source update <routingKey> [options]`

**Arguments**

| Argument     | Required | Variadic | Description |
| ------------ | -------- | -------- | ----------- |
| `routingKey` | yes      | no       |             |

**Options**

| Option                        | Default | Description                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------------ |
| `--name <name>`               |         | New name                                                           |
| `--private-key <pathOrValue>` |         | New private key (prefix with @ for file)                           |
| `--webhook-secret <secret>`   |         | New webhook secret                                                 |
| `--from-env <varName>`        |         | Read new private key from environment variable                     |
| `--stdin`                     |         | Read new private key from stdin                                    |
| `--customer-id <orgId>`       |         | Update the customer/org ID used for secret and environment scoping |

### `kici-admin source update-generic`

Update a generic webhook source

Synopsis: `kici-admin source update-generic <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                                | Default | Description                                                                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `--name <name>`                       |         | New name                                                                                                    |
| `--verification <method>`             |         | Verification method: hmac_sha256, bearer_token, ip_allowlist, none                                          |
| `--secret <value>`                    |         | New verification secret (prefix with @ for file)                                                            |
| `--from-env <varName>`                |         | Read verification secret from environment variable                                                          |
| `--stdin`                             |         | Read verification secret from stdin                                                                         |
| `--event-type-header <header>`        |         | Header name for event type extraction                                                                       |
| `--event-type-path <jsonpath>`        |         | JSONPath for event type extraction from body                                                                |
| `--idempotency-key-header <header>`   |         | Header name for idempotency key                                                                             |
| `--idempotency-key-path <jsonpath>`   |         | JSONPath for idempotency key from body                                                                      |
| `--dedup-window <seconds>`            |         | Dedup window in seconds                                                                                     |
| `--max-payload <bytes>`               |         | Maximum payload size in bytes                                                                               |
| `--allowed-events <events>`           |         | Comma-separated list of allowed event types                                                                 |
| `--strip-headers <headers>`           |         | Comma-separated list of headers to strip                                                                    |
| `--rate-limit <rpm>`                  |         | Rate limit in requests per minute                                                                           |
| `--preset <name>`                     |         | Universal-git preset                                                                                        |
| `--git-url-template <url>`            |         | Clone URL template                                                                                          |
| `--credential-ref <key>`              |         | Secret key name                                                                                             |
| `--credential-store <backend>`        |         | Secret backend name                                                                                         |
| `--credential-type <type>`            |         | Credential type: pat, basic, ssh                                                                            |
| `--credential-user <user>`            |         | Username for PAT/basic auth                                                                                 |
| `--ssh-host-key-policy <policy>`      |         | SSH host-key policy: accept-new, pinned                                                                     |
| `--ssh-known-hosts-pem <pathOrValue>` |         | Pinned SSH known_hosts (prefix with @ for file)                                                             |
| `--clear-git-config`                  |         | Revert this source back to a payload-only generic webhook                                                   |
| `--provider-type <type>`              |         | Provider implementation: generic (default) or local (a git repo on the agent filesystem cloned via file://) |
| `--json`                              |         | Emit raw JSON (the full source row) instead of formatted text                                               |

### `kici-admin source update-local`

Update a local filesystem (file://) source

Synopsis: `kici-admin source update-local <id> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

**Options**

| Option                   | Default | Description                                                   |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `--name <name>`          |         | New name                                                      |
| `--path <dir>`           |         | New absolute repo base path on the agent filesystem           |
| `--clone-url-base <url>` |         | New git://\|http:// clone base (default: file://)             |
| `--json`                 |         | Emit raw JSON (the full source row) instead of formatted text |

### `kici-admin token`

Manage admin API tokens

Synopsis: `kici-admin token`

### `kici-admin token create`

Create a new admin API token

Synopsis: `kici-admin token create <label> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `label`  | yes      | no       |             |

**Options**

| Option                | Default | Description                                                                                                                                                                                |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--role <role>`       |         | Token role (owner, admin, auditor)                                                                                                                                                         |
| `--routing-key <key>` |         | Restrict the token to a single source routing key (e.g. "github:42"). The token can only act on requests targeting that routing key. Without this, the token has full orchestrator access. |

### `kici-admin token list`

List all admin API tokens

Synopsis: `kici-admin token list`

### `kici-admin token revoke`

Revoke an admin API token

Synopsis: `kici-admin token revoke <id>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `id`     | yes      | no       |             |

### `kici-admin variable`

Manage context variables

Synopsis: `kici-admin variable`

### `kici-admin variable delete`

Delete a context variable

Synopsis: `kici-admin variable delete <orgId> <context> <key> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `orgId`   | yes      | no       |             |
| `context` | yes      | no       |             |
| `key`     | yes      | no       |             |

**Options**

| Option  | Default | Description              |
| ------- | ------- | ------------------------ |
| `--yes` |         | Skip confirmation prompt |

### `kici-admin variable get`

Print the value of a single variable

Synopsis: `kici-admin variable get <orgId> <context> <key>`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `orgId`   | yes      | no       |             |
| `context` | yes      | no       |             |
| `key`     | yes      | no       |             |

### `kici-admin variable list`

List org-level variables in a context

Synopsis: `kici-admin variable list <orgId> <context> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `orgId`   | yes      | no       |             |
| `context` | yes      | no       |             |

**Options**

| Option     | Default | Description                                                     |
| ---------- | ------- | --------------------------------------------------------------- |
| `--values` |         | Print variable values inline (default: keys + locked flag only) |

### `kici-admin variable set`

Set a context variable. Value comes from one of: --prompt (default on TTY), --from-stdin (default on pipe), --from-file <path>, --from-env <VAR>, --value <plaintext> (discouraged).

Synopsis: `kici-admin variable set <orgId> <context> <key> [options]`

**Arguments**

| Argument  | Required | Variadic | Description |
| --------- | -------- | -------- | ----------- |
| `orgId`   | yes      | no       |             |
| `context` | yes      | no       |             |
| `key`     | yes      | no       |             |

**Options**

| Option                              | Default | Description                                                              |
| ----------------------------------- | ------- | ------------------------------------------------------------------------ |
| `--value <value>`                   |         | Variable value via argv (visible in shell history)                       |
| `--prompt`                          |         | Interactive no-echo prompt (requires TTY)                                |
| `--from-stdin`                      |         | Read value from piped stdin until EOF                                    |
| `--from-file <path>`                |         | Read value from a file (trailing newline trimmed)                        |
| `--from-env <var>`                  |         | Read value from a named environment variable                             |
| `--no-trim`                         |         | When reading --from-file, keep the trailing newline (default: trim once) |
| `--locked`                          |         | Mark the variable as locked (source overrides cannot replace it)         |
| `--confirm-fingerprint <sha256hex>` |         | Refuse the write unless SHA-256(value) matches this 64-hex string        |
| `--dry-run`                         |         | Parse + validate the value, print fingerprint + length, do not write     |

### `kici-admin workflow`

Inspect workflow registrations

Synopsis: `kici-admin workflow`

### `kici-admin workflow list`

List workflow registrations (dogfooded via /api/v1/admin/registrations)

Synopsis: `kici-admin workflow list [options]`

**Options**

| Option                  | Default | Description                                              |
| ----------------------- | ------- | -------------------------------------------------------- |
| `--org <orgId>`         |         | Filter by customer/org id (server param: customerId)     |
| `--routing-key <key>`   |         | Filter by routing key, e.g. github:42                    |
| `--repo <ownerRepo>`    |         | Filter by repo identifier (owner/repo)                   |
| `--trigger-type <type>` |         | Filter by trigger type, e.g. webhook, push, schedule     |
| `--event <eventName>`   |         | Filter by webhook event name (scans lock_entry.triggers) |
| `--json`                |         | Emit raw JSON instead of a table                         |

### `kici-admin workflow register-manual`

Manually upsert workflow_registrations rows from a lock file + bump registry_versions. Transactional. Used by E2E helpers that seed registrations without a real push event.

Synopsis: `kici-admin workflow register-manual [options]`

**Options**

| Option                      | Default | Description                                              |
| --------------------------- | ------- | -------------------------------------------------------- |
| `--lock-file <path>`        |         | Path to a kici.lock.json file                            |
| `--repo <ident>`            |         | repo_identifier value (e.g. "owner/repo")                |
| `--routing-key <key>`       |         | Routing key for the source (e.g. "github:42")            |
| `--customer <id>`           |         | customer_id (org) to attribute rows to                   |
| `--provider-context <json>` | `{}`    | Provider-specific context as a JSON object (default: {}) |
| `--commit-sha <sha>`        |         | Optional commit SHA stamped on each row                  |
| `--database-url <url>`      |         | Use direct DB access instead of HTTP (offline mode)      |
| `--json`                    |         | Emit JSON output                                         |

<!-- END GENERATED: kici-admin-commands -->

## Command guide

Per-namespace explanations, synopses, and worked examples. For the authoritative argument/option signatures, see the [command reference](#command-reference) above.

### access-log -- read / admin-mutation attribution log

```bash
kici-admin access-log list [--org-id <orgId>] [--actor-type <t>] [--actor-id <id>] [--action <action>] [--source <s>] [--outcome <o>] [--target-type <t>] [--target-id <id>] [--from <ts>] [--to <ts>] [--q <text>] [--limit <n>] [--cursor <c>] [--json]
kici-admin access-log show <id> [--json]
```

Operator-facing read access to the orchestrator's `access_log` table — every read / admin-mutation attributed to an `ActorPrincipal` (user, api_key, service_account, platform_operator, system). Dogfood replacement for raw `psql` when an operator asks "who read this run's payload last Tuesday" or "show me everything a platform_operator actor did".

Output includes actor (type + id + optional metadata), action, source, outcome, target (if any), request ID, and timestamps.

### agent -- agent token management and service lifecycle

**Token management:**

```bash
kici-admin agent register [--labels <labels>] [--mandatory-label <label>...] [--privileged-root]
kici-admin agent list [--type static|ephemeral] [--include-pending] [--database-url <url>] [--json]
kici-admin agent revoke <id>
```

- `register` creates a static agent token. The token is shown once -- save it and set `KICI_AGENT_TOKEN` on the agent.
- `--labels` accepts comma-separated labels (e.g., `linux,x64,gpu`) for label-based routing.
- `--mandatory-label` (repeatable) taints the token with a label the agent only accepts jobs demanding (a Kubernetes-taint-style gate). Each mandatory label is also authorized as an advertised label, so the agent can both advertise it (selector) and be confined by it (taint).
- `--privileged-root` is shorthand for `--mandatory-label kici:privileged:root`: it mints a **confined root agent** token. The agent must run as uid 0 — the orchestrator refuses the registration otherwise. See [Confined root agents](../security/agent-security.md#confined-root-agents) for the full security model.
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
kici-admin agent upgrade [--from <path>] [--url <url>] [--version <version>] [--cleanup] [--rollback] [--pick] [--yes] [--force] [--platform <type>] [--instance-dir <path>] [--name <name>]
```

These commands manage the agent as a native system service. The `install --wizard` flow walks through orchestrator URL, agent token, and labels configuration. Lifecycle targeting is folder-anchored — see [Service installation guide](../distribution/service-installation.md) for platform-specific details and the full description of the manifest, the instance index, and the name-scoped on-disk layout.

Every lifecycle command (`uninstall`, `upgrade`, `start`, `stop`, `restart`, `status`, `logs`) resolves its target through the priority chain `--instance-dir` > `--name` > manifest in the current working directory. A bare `kici-admin agent <cmd>` outside any deploy folder with no flags refuses non-zero and prints the candidate list of installed agent instances on the host.

### api-key -- API key management

```bash
kici-admin api-key create [--label <label>] [--routing-keys <keys>]
kici-admin api-key add-routing-key <id> <pattern>
```

- Creates API keys for orchestrator-to-Platform authentication.
- `--routing-keys` accepts comma-separated routing key patterns (e.g., `github:42,github:99`).
- The key is shown once on creation -- save it immediately.

### attestations -- provenance verdict backfill and listing

```bash
kici-admin attestations reverify [--all] [--database-url <url>]
```

- `reverify` recomputes the stored verification verdict for build-provenance
  attestations. The orchestrator verifies each provenance bundle when it records
  the attestation (verify-at-ingest), so the org-wide **Attestations** page shows
  a trustworthy badge with no per-row work. This command refreshes that stored
  verdict for rows that predate verification, or for an org that configured
  provenance **after** some builds already ran.
- Default scope is rows with no usable verdict yet (`pending` / `unverifiable`).
  `--all` re-evaluates every attestation (gated by a confirmation prompt; pass
  `--yes` to skip it in scripts). Idempotent — re-running recomputes the same
  verdict over the immutable bundles.
- Direct orchestrator DB + object storage. The provenance trust root comes from
  the orchestrator's `KICI_PROVENANCE_ISSUER` config; when it is unset every
  verdict is `unverifiable`.

```bash
kici-admin attestations list [--run-id <id>] [--job-id <id>] [--limit <n>] [--json] [--database-url <url>]
```

- `list` reads recorded provenance attestations from the orchestrator DB, newest
  first. `--run-id` / `--job-id` scope to a single run or job; `--limit` caps the
  result count (default 20, max 100). `--json` emits `{ "attestations": [ ... ] }`
  with `id`, `runId`, `jobId`, `subjectName`, `verifyStatus`, and `createdAt`
  fields; without it the rows print as a compact table.
- Direct orchestrator DB read — no orchestrator HTTP call. The DB URL comes from
  `--database-url` or `KICI_DATABASE_URL` (else the orchestrator config).

```bash
kici-admin attestations retry [--run-id <id>] [--all-pending] [--include-rejected]
```

- `retry` mints deferred attestations now — it drains the pending-attestations
  outbox (the rows a run left behind when its initial provenance mint could not
  reach the signer). `--run-id` scopes to a single run; `--all-pending` (the
  default when `--run-id` is absent) drains every pending row. `--include-rejected`
  additionally re-arms rows previously marked terminally rejected (it clears the
  terminal `rejected_at` marker so they mint again).
- Unlike `list` / `reverify`, this goes through the orchestrator **admin HTTP
  API**, so it requires an **unscoped** admin token holding the
  `attestation.retry` permission — granted to the **owner** and **admin** roles
  only, never to the read-only **auditor** role. Every retry writes an
  `attestation.retry` `access_log` row (always audited) recording the actor,
  `include_rejected`, the target run, and the `minted` / `still_pending` /
  `rejected` counts — so a re-arm of a terminal rejection is never silent.

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

**PostgreSQL options** (for `add` and `test`):

**Common options** (for `add`):

### cluster -- cluster identity recovery (direct DB + S3)

```bash
kici-admin cluster reconcile-identity [--adopt-db] [--dry-run] [--yes] [--database-url <url>] [--bucket <bucket>] [--prefix <prefix>] [--region <region>] [--endpoint <url>] [--force-path-style]
```

Reconciles the orchestrator's `cluster_meta.cluster_id` with the durable S3 sentinel — the cross-restart / peer anchor that lets a redeployed orchestrator reclaim its identity. Talks **directly** to the orchestrator Postgres and the same S3 bucket the running process uses (no HTTP admin path), so it works while the orchestrator is offline. Requires `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for the sentinel.

- Default direction **restores the DB from the sentinel** (`db-from-sentinel`) — the common recovery after a database was rebuilt but the durable identity in object storage is authoritative.
- `--adopt-db` reverses the direction (`sentinel-from-db`): rewrite the sentinel from the DB's current `cluster_id`.
- `--dry-run` reports drift and exits without changing anything.
- `--yes` skips the confirmation prompt and applies on drift (scripted use).
- Storage flags fall back to the orchestrator's `KICI_DATABASE_URL` / `KICI_STORAGE_BUCKET` / `KICI_STORAGE_PREFIX` (default empty = bucket root) / `KICI_STORAGE_REGION` / `KICI_STORAGE_ENDPOINT` when omitted. `--force-path-style` selects S3 path-style addressing.

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
kici-admin context create --org <id> --name <name> [--type fixed|glob|template] [--glob-pattern <pattern>] [--enabled true|false] [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted] [--database-url <url>] [--json]
kici-admin context bind --org <id> --env <name> --scope <pattern> [--host <pattern>] [--database-url <url>] [--json]
kici-admin context set-policy --org <id> --env <name> [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted|null] [--enabled true|false] [--database-url <url>] [--json]
kici-admin context list --org <id> [--database-url <url>] [--json]
kici-admin context show --org <id> --name <name> [--database-url <url>] [--json]
kici-admin context delete --org <id> --name <name> [--database-url <url>] [--json]
kici-admin context create-template --org <id> --template <name> [--type template] [--branch-restrictions <json>] [--required-reviewers <csv>] [--wait-timer <seconds>] [--hold-expiry <seconds>] [--minimum-trust known|trusted] [--variables <json>] [--database-url <url>] [--json]
kici-admin context purge [--org <id>] [--database-url <url>] [--json]
```

Seeds and mutates environment rows (plus their variables and scope bindings). Defaults to the orchestrator admin API; pass `--database-url` (or set `KICI_DATABASE_URL`) to run the SQL directly — used by E2E `globalSetup` helpers that need to seed envs before the orchestrator is up.

- `create` upserts an environment (idempotent by `org + name`). Omit a policy flag to leave it unset. `--glob-pattern` is required when `--type glob` and sets the match pattern that resolves run scopes to this environment; passing it with any other `--type` is an error.
- `bind` upserts an `environment_bindings` row mapping a scope pattern to an environment. `--host <pattern>` scopes the binding to a subset of hosts (default `**` = all hosts) — see [Per-host secret scoping](../security/secrets.md#per-host-secret-scoping) for the host dimension, the templating syntax, and precedence.
- `set-policy` updates only the provided policy fields on an existing environment. Pass `--minimum-trust null` to clear the tier gate.
- `list` / `show` read back the current state; `show` also returns variables and bindings.
- `delete` removes an environment and cascades its bindings, variables, and overrides. Reports `deleted=true` on success and exits non-zero if no matching environment exists. Pending held runs block the deletion with a clear error (HTTP mode returns 409) — approve or reject them first; resolved held-run history survives the deletion with its environment reference cleared.
- `create-template` creates/updates a template environment and seeds its variables in one call (`--variables '{"K":"V"}'`).
- `purge` (direct-DB only) bulk-deletes every environment for an org (cascading bindings, variables, and overrides) and removes the org's held runs for a clean slate. Omit `--org` to clear all orgs. Destructive break-glass / test-reset verb with no orchestrator HTTP wire; requires `--database-url` (or `KICI_DATABASE_URL`). Reports `{ environmentsDeleted, heldRunsDeleted }` with `--json`.

See [Contexts](../contexts.md) for the broader feature walkthrough.

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
kici-admin orchestrator upgrade [--from <path>] [--url <url>] [--version <version>] [--cleanup] [--rollback] [--pick] [--yes] [--force] [--platform <type>] [--instance-dir <path>] [--name <name>]
```

Manages the orchestrator as a native system service. The `install --wizard` flow handles database setup, encryption key generation, Platform credentials, and optionally adding your first source. Lifecycle targeting is folder-anchored — see [Service installation guide](../distribution/service-installation.md) for platform-specific details and the full description of the manifest, the instance index, and the name-scoped on-disk layout.

The `upgrade` command uses a name-scoped versioned directory layout: new versions are extracted under the resolved instance's own `<installBase>/<name>/` tree alongside old ones, and a per-instance symlink is atomically switched. Other installed instances on the host are not touched. Use `--rollback` to revert to the previous version and `--cleanup` to remove old versions (keeping current and previous). Use `--pick` to switch to any already-installed version: it lists every installed version, lets you choose one interactively (the active version is shown but not selectable), prints the change summary, and confirms before switching. Like `--rollback`, `--pick` only switches between versions already extracted under the instance's install base — it never downloads.

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

- `set-expiry <seconds>` writes `org_settings.approval_expiry_seconds` (integer, minimum 1; default 86400 — one day). A held element that is not fully approved within this window expires and its run/job/step is rejected. A workflow's own `approval` `timeout` overrides this per element.
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
kici-admin runs structured <runId> [--json]
kici-admin runs jobs <runId> [--include-steps] [--json]
kici-admin runs ephemeral-key <runId> [--json]
kici-admin runs secret-outputs <runId> [--output-key <k>] [--reveal] [--json]
```

Inspects execution runs, jobs, ephemeral keys, and secret outputs. Useful for investigating run status and failures — and, with `secret-outputs --reveal`, for recovering a job's output values during incident response — without direct database access.

Shows run header (status, repo, ref, SHA, provider, timing, environment, trust tier), jobs table, and steps per job. Internally composes two admin API calls: `GET /admin/runs/:runId` (run header) + `GET /admin/runs/:runId/jobs?includeSteps=true`.

Shows the machine-first, provenance-tagged structured run result — the same shape an automation agent reads over the admin API (`GET /admin/runs/:runId/structured`). Trusted fields (run/job/step ids, enum statuses, exit codes, durations, hashes, the derived failure category) are plain; untrusted fields (workflow / repo / job / step names, refs, error text, job output values) are wrapped in an `{ untrusted: true, value }` envelope so a consumer can keep user-controlled content out of an instruction channel. Secret output **values** are never returned — only their key names. The human view unwraps envelopes for display; `--json` is lossless. See [Agent run-result API](./agent-run-result-api.md) for the full contract.

Lists the execution jobs for a single run. Cheaper than `runs show` when you only need job-level state (e.g., for polling). Each job row carries its resolved upstream dependency edges in `needs` (an array of `{ upstreamName, runOn }`, where `runOn` is the per-edge set of upstream terminal statuses that satisfy the edge, or `null` when the job has no upstreams) — the same dependency structure the dashboard run-detail graph view renders.

Answers the security-relevant question "did the per-run ephemeral key get scrubbed?" without `psql`. Returns `{ exists, createdAt }`; the key material itself is **never** exposed on the wire, regardless of role.

Lists the secret outputs produced by a run's jobs. Values are **masked** by default — the row set shows `jobId`, `outputKey`, `createdAt`, and nothing that could reconstruct the secret. `--reveal` is the break-glass path for incident response only: it is always audited, requires the stricter `secret.reveal` permission, and fails with HTTP 503 if the orchestrator was started without a master key (e.g., no `KICI_SECRET_KEY`).

**RBAC tokens for these commands:** `run.read` is enough for `list`, `show`, `jobs`, `ephemeral-key`, and masked `secret-outputs` (all three roles — owner, admin, auditor — carry it). `secret-outputs --reveal` additionally requires `secret.reveal`, which only owner + admin roles hold — auditor tokens get 403. Successful reveals land in `secret_audit_log` with `action = secret-outputs.reveal`, `run_id`, `user_id`, `role`, and a `metadata` JSON object summarising the revealed / failed output keys.

### scaler -- scaler maintenance (local, no orchestrator)

```bash
kici-admin scaler reap-orphans [--config <path>] [--force] [--json]
```

Frees leaked Firecracker / container resources (orphaned microVMs, TAP devices, containers) without a running orchestrator. Runs locally against the host using the orchestrator config, so it is the recovery path when the orchestrator crashed and left scaler-managed resources behind.

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
kici-admin source add github --name <name> --manifest [--github-org <slug>] [--webhook-url <url>] [--no-browser] [--json]
# Manual: store credentials for a GitHub App you already created
kici-admin source add github --name <name> --app-id <id> --private-key <value|@file> [--webhook-secret <secret>] [--from-env <var>] [--stdin]
kici-admin source update <routingKey> [--name <name>] [--private-key <value|@file>] [--webhook-secret <secret>] [--from-env <var>] [--stdin]
# Re-sync a GitHub source's display name + slug from GitHub (GitHub is the source of truth)
kici-admin source refresh <routingKey> [--json]
kici-admin source refresh --all [--json]
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

| Flag                  | Description                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--manifest`          | Enable one-click setup via GitHub's App Manifest flow (mutually exclusive with `--app-id` / `--private-key`)                                                                        |
| `--github-org <slug>` | Create the App under a GitHub organization instead of your personal account                                                                                                         |
| `--webhook-url <url>` | Advanced/self-hosted: bake this `https://` URL into the App webhook verbatim and skip platform-mode URL resolution. KiCI adds no ingress at this URL — your own infra owns delivery |
| `--no-browser`        | Headless mode: print a `kici.dev` URL to open, then read the short-lived setup code you paste back via stdin                                                                        |
| `--json`              | Emit raw JSON (the API response) instead of formatted text                                                                                                                          |

**`source refresh`**: re-reads a GitHub source's display name + slug from GitHub (`GET /app`) and updates the orchestrator + dashboard if they drifted (e.g. after renaming the App in GitHub's UI). For GitHub App sources GitHub is the source of truth for the displayed name — `--name` is only the name requested at creation. Pass a `<routingKey>` for one source or `--all` for every GitHub source; the command prints `old → new` for any changed field and is a no-op when GitHub already matches. The orchestrator also runs this refresh automatically once a day (`KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS`, default 24h). Non-GitHub routing keys are rejected.

See the [GitHub provider guide](../../user/providers/github.md) for the full one-click walkthrough. The manifest flow resolves the App's webhook URL from the orchestrator's Platform connection, so it requires a **platform** or **hybrid** orchestrator. **Independent-mode** orchestrators have no Platform connection (and therefore no GitHub-App ingress), so the pre-flight returns no webhook URL and the flow aborts — use a generic webhook source there instead.

**Secret input modes** (for private keys and webhook secrets — the manual path):

| Mode                 | Example                             |
| -------------------- | ----------------------------------- |
| Direct value         | `--private-key "-----BEGIN RSA..."` |
| File (@ prefix)      | `--private-key @/path/to/key.pem`   |
| Environment variable | `--from-env GITHUB_APP_KEY`         |
| Stdin                | `--stdin`                           |

**Universal-git options** (promote a generic source to clone + trigger-match for Forgejo / Gitea / Gogs / GitLab / plain GitHub — see [Universal-git provider](../../user/providers/universal-git.md)):

List the canonical presets and their expanded `payloadPaths` + `eventMapping`:

```bash
kici-admin source list-presets
```

**Local filesystem (`file://`) source options** (a git repo present on the agent
filesystem — see the [Local filesystem source guide](../../user/providers/local-file.md)):

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

`register-manual` seeds `workflow_registrations` rows straight from a compiled lock file — used by local-only / non-Git deployments and E2E helpers that can't rely on a webhook-driven compile-and-register flow. Dual-mode (HTTP via admin API, or direct DB via `--database-url`).

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
