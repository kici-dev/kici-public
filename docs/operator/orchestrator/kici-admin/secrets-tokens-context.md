---
title: 'kici-admin: secrets, tokens & context'
description: 'Scoped secrets, context variables, secret backends, API tokens, and key rotation'
---

## Guide

### secret -- scoped secret management

```bash
kici-admin secret scopes <orgId> [--all-backends]
kici-admin secret list <orgId> <scope>
kici-admin secret set [orgId] [scope] [key] [--value <v> | --prompt | --from-stdin | --from-file <p> | --from-env <var>] [--no-trim] [--confirm-fingerprint <sha256>] [--dry-run] [--database-url <url>]
kici-admin secret set --org <orgId> --context <name> --key <k> [value-source flags as above]
kici-admin secret delete <orgId> <scope> <key> [--yes]
kici-admin secret fix-prefixed-scopes <orgId> [--dry-run] [--database-url <url>]
```

- Secret values are **write-only** -- there is no command to read a secret value.
- A `<scope>` may be **qualified** with the backend that owns it (`pg:production`, `openbao-prod:aws/creds`). The qualifier selects the backend and is not part of the stored name; an unqualified scope targets the PG backend. A head that names no registered backend stays part of the path.
- `scopes --all-backends` aggregates every registered backend and prints scopes in qualified form. Without the flag it lists the PG backend only, unqualified — that default flips at v1.0.0.
- `fix-prefixed-scopes` repairs PG-backend scopes that an older orchestrator stored with a `pg:` qualifier attached (and which are therefore unreachable after upgrading). It re-encrypts each value as it renames, because the scope name is bound into the encryption. Preview with `--dry-run`; it never merges two scopes, never moves a secret between backends, and exits `2` when any scope was skipped.
- `set` accepts either the positional `<orgId> <scope> <key>` form or the context-scope sugar form (`--org` + `--context` + `--key`). The two forms are mutually exclusive.
- Value sources (mutually exclusive; first matching wins): `--prompt` (interactive no-echo, default on TTY), `--from-stdin` (read piped stdin until EOF; default when stdin is a pipe), `--from-file <path>` (file body, trailing newline trimmed unless `--no-trim`), `--from-env <var>` (named env var), `--value <plaintext>` (visible in shell history — discouraged).
- `--confirm-fingerprint <sha256hex>` refuses the write unless `SHA-256(value)` matches the supplied 64-hex string. Pair with a value source for unattended automation.
- `--dry-run` parses + validates the value, prints fingerprint + length, and skips the write.
- `--database-url` (on `set`) switches to direct-DB mode and writes the caller-supplied `encrypted_value` verbatim into `scoped_secrets` — used by E2E `globalSetup` helpers that need to seed secrets before the orchestrator is up.
- `delete` asks for confirmation unless `--yes` is passed.

For full details on encryption, backends, and key rotation, see [Secrets management](../../security/secrets.md).

### secret -- scoped secret management (purge)

```bash
kici-admin secret purge --confirm                              # All orgs (nuclear — use rotate-key first)
kici-admin secret purge --confirm --org <orgId>                # One org
kici-admin secret purge --confirm --database-url $URL --yes    # Offline mode
```

`purge` bulk-deletes `scoped_secrets` rows. Recovery path for "the encryption key is lost and I can't decrypt". Prefer `kici-admin rotate-key` first — it re-encrypts rather than discards. `purge` is the path when the old key is gone or the ciphertext is corrupt.

### variable -- context variable management

```bash
kici-admin variable list <orgId> <context> [--values]
kici-admin variable get <orgId> <context> <key>
kici-admin variable set <orgId> <context> <key> [--value <v> | --prompt | --from-stdin | --from-file <p> | --from-env <var>] [--no-trim] [--locked] [--confirm-fingerprint <sha256>] [--dry-run]
kici-admin variable delete <orgId> <context> <key> [--yes]
```

Manages org-level context variables (plaintext-at-rest in the orchestrator DB). Variables are the non-secret sibling of scoped secrets — both write to the same per-context trust cone, gated by the `variables.set` / `variables.delete` switches in the dashboard-write policy. This CLI is the always-available authority path when the dashboard is disabled for either switch.

- `list` prints keys + `[locked]` flag only; pass `--values` to include the inline values.
- `get` prints a single variable's value (exits non-zero if the key is missing).
- `set` accepts the same value-source flag set as `secret set` (`--prompt`, `--from-stdin`, `--from-file`, `--from-env`, `--value`, `--no-trim`, `--confirm-fingerprint`, `--dry-run`). Add `--locked` to mark the variable as locked so source-level overrides cannot replace it.
- `delete` asks for confirmation unless `--yes` is passed.

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

Vault options (`--vault-url`, `--auth-method`, `--role-id`, `--secret-id`, `--secret-id-file`, `--token`, `--namespace`, `--mount-path`, `--base-path`), the PostgreSQL option (`--connection-string`), and the options common to both (`--scope-filter`, `--sync-interval`) are listed with their defaults under [`backend add`](#kici-admin-backend-add) and [`backend test`](#kici-admin-backend-test) in the reference below. Prefer `--secret-id-file` over `--secret-id` so the AppRole secret never enters shell history.

### audit -- secrets audit log

```bash
kici-admin audit [--context <name>] [--action <action>] [--from <date>] [--to <date>] [--limit <n>] [--offset <n>]
```

Queries the secrets operation audit log. All date filters use ISO 8601 format. Default limit is 100.

### api-key -- API key management

```bash
kici-admin api-key create [--label <label>] [--routing-keys <keys>]
kici-admin api-key add-routing-key <id> <pattern>
```

- Creates API keys for orchestrator-to-Platform authentication.
- `--routing-keys` accepts comma-separated routing key patterns (e.g., `github:42,github:99`).
- The key is shown once on creation -- save it immediately.

### token -- admin API token management

```bash
kici-admin token create <label> --role <role> [--routing-key <key>]
kici-admin token list
kici-admin token revoke <id>
```

- `create` returns the plaintext token once. Save it immediately.
- `--role` is required: `owner`, `admin`, or `auditor`.
- `--routing-key` optionally scopes the token to a specific routing key.

#### Routing-key-scoped tokens cannot manage secrets

A token created with `--routing-key <key>` is restricted to that one routing key,
and **every** admin secret route refuses it with `403`. This is deliberate:
routing keys and secret scopes are different namespaces. A routing key is
`<provider>:<id>` and identifies an inbound source; a secret scope is a path in a
backend namespace, where `:` is reserved to qualify the backend. There is no
per-routing-key slice of the secret store to grant, so there is nothing a scoped
token could safely be allowed to write.

Use an unscoped admin token to manage secrets. Source-owned credentials are a
separate mechanism: they live under the reserved `__source__/<sourceId>` scope
and are managed through the source commands, not by scoping a token.

### rotate-key -- master key rotation

```bash
kici-admin rotate-key
```

Re-encrypts all PostgreSQL-stored secrets with the current master key. When `KICI_SECRET_KEY_OLD` is configured alongside `KICI_SECRET_KEY`, this performs a true key rotation. Without the old key, it re-encrypts at an incremented key version.

See [Secrets management > Key rotation](../../security/secrets.md#key-rotation) for the full procedure.

### context -- context management (dual-mode)

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

Seeds and mutates context rows (plus their variables and scope bindings). Defaults to the orchestrator admin API; pass `--database-url` (or set `KICI_DATABASE_URL`) to run the SQL directly — used by E2E `globalSetup` helpers that need to seed contexts before the orchestrator is up.

- `create` upserts a context (idempotent by `org + name`). Omit a policy flag to leave it unset. `--glob-pattern` is required when `--type glob` and sets the match pattern that resolves run scopes to this context; passing it with any other `--type` is an error.
- `bind` upserts a `context_bindings` row mapping a scope pattern to a context. `--host <pattern>` scopes the binding to a subset of hosts (default `**` = all hosts) — see [Per-host secret scoping](../../security/secrets.md#per-host-secret-scoping) for the host dimension, the templating syntax, and precedence.
- `set-policy` updates only the provided policy fields on an existing context. Pass `--minimum-trust null` to clear the tier gate, and `--hold-expiry ''` (an empty value) to clear the hold expiry. Omitting a flag leaves that field untouched, which is why clearing needs an explicit empty / `null` value rather than omission.
- `list` / `show` read back the current state; `show` also returns variables and bindings.
- `delete` removes a context and cascades its bindings, variables, and overrides. Reports `deleted=true` on success and exits non-zero if no matching context exists. Pending held runs block the deletion with a clear error (HTTP mode returns 409) — approve or reject them first; resolved held-run history survives the deletion with its context reference cleared.
- `create-template` creates/updates a template context and seeds its variables in one call (`--variables '{"K":"V"}'`).
- `purge` (direct-DB only) bulk-deletes every context for an org (cascading bindings, variables, and overrides) and removes the org's held runs for a clean slate. Omit `--org` to clear all orgs. Destructive break-glass / test-reset verb with no orchestrator HTTP wire; requires `--database-url` (or `KICI_DATABASE_URL`). Reports `{ contextsDeleted, heldRunsDeleted }` with `--json`.

See [Contexts](../../contexts.md) for the broader feature walkthrough.

## Reference

<!-- BEGIN GENERATED: kici-admin-secrets-tokens-context (do not edit; run the doc generator) -->

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
| `--scope-filter <pattern>`  | `**`      | Scope filter glob pattern (default: **)                |
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

### `kici-admin context`

Context management (dual-mode)

Synopsis: `kici-admin context`

### `kici-admin context bind`

Upsert a context_bindings row (scope_pattern → context)

Synopsis: `kici-admin context bind [options]`

**Options**

| Option                 | Default | Description                                                                 |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `--org <id>`           |         | Org ID                                                                      |
| `--env <name>`         |         | Context name                                                                |
| `--scope <pattern>`    |         | Scope pattern (e.g. "staging" or "aws/prod/**")                             |
| `--host <pattern>`     | `**`    | Host selector (exact/glob/regex over agentId/host/labels); "**" = all hosts |
| `--database-url <url>` |         | Use direct DB access instead of HTTP (offline mode)                         |
| `--json`               |         | Emit JSON output                                                            |

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
| `--hold-expiry <seconds>`        |         | Hold expiry TTL in seconds (empty to clear)           |
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

### `kici-admin rotate-key`

Rotate the master encryption key (re-encrypts scoped_secrets, config_versions, and secret_backends)

Synopsis: `kici-admin rotate-key`

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

### `kici-admin secret fix-prefixed-scopes`

Repair PG-backend secret scopes stored with a stale pg: qualifier (direct-DB). Each affected scope is renamed to its bare path, re-encrypting every secret under the corrected AAD. Exits 2 when any scope needs manual repair.

Synopsis: `kici-admin secret fix-prefixed-scopes <orgId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |

**Options**

| Option                 | Default | Description                                |
| ---------------------- | ------- | ------------------------------------------ |
| `--dry-run`            |         | Print the plan and exit without writing    |
| `--database-url <url>` |         | Orchestrator DB URL (or KICI_DATABASE_URL) |

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

Synopsis: `kici-admin secret scopes <orgId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `orgId`  | yes      | no       |             |

**Options**

| Option           | Default | Description                                                                                                                                               |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--all-backends` |         | List scopes from every registered backend, qualified as <backend>:<path> (default today: the pg backend only, unqualified — this default flips at v1.0.0) |

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

| Option                | Default | Description                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--role <role>`       |         | Token role (owner, admin, auditor)                                                                                                                                                                                                                                                                                         |
| `--routing-key <key>` |         | Restrict the token to a single source routing key (e.g. "github:42"). The token can only act on requests targeting that routing key, and is refused (403) on every secret route -- the secret store has no per-routing-key slice, so secrets need an unscoped token. Without this, the token has full orchestrator access. |
| `--expires <value>`   |         | Optional expiry: a duration from now ("30d", "12h", "45m") or an ISO-8601 datetime. Omit for a non-expiring token.                                                                                                                                                                                                         |

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

<!-- END GENERATED: kici-admin-secrets-tokens-context -->
