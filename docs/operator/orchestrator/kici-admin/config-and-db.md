---
title: 'kici-admin: configuration & database'
description: 'Orchestrator configuration and database management'
---

## Guide

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

For full configuration details, see [Configuration management](../config-management.md).

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

## Reference

<!-- BEGIN GENERATED: kici-admin-config-and-db (do not edit; run the doc generator) -->

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

### `kici-admin db`

Database management

Synopsis: `kici-admin db`

### `kici-admin db backup`

Dump the orchestrator DB to a local file (pg_dump custom format)

Synopsis: `kici-admin db backup [options]`

**Options**

| Option                 | Default | Description                                                     |
| ---------------------- | ------- | --------------------------------------------------------------- |
| `--database-url <url>` |         | Source DB URL (else KICI_DATABASE_URL / DATABASE_URL)           |
| `--output <path>`      |         | Dump output path (default ./kici-orchestrator-backup-<ts>.dump) |

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

### `kici-admin db restore`

Restore the orchestrator DB from a pg_dump file (DESTRUCTIVE)

Synopsis: `kici-admin db restore [options]`

**Options**

| Option                 | Default | Description                                           |
| ---------------------- | ------- | ----------------------------------------------------- |
| `--input <path>`       |         | Path to a .dump file produced by `db backup`          |
| `--database-url <url>` |         | Target DB URL (else KICI_DATABASE_URL / DATABASE_URL) |
| `--yes`                |         | Skip interactive confirmation (for scripted use)      |

<!-- END GENERATED: kici-admin-config-and-db -->
