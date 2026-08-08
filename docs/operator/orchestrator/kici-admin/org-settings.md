---
title: 'kici-admin: org settings'
description: 'Org-level security policy: npm, cache, dispatch, approval, CI trust, and dashboard-write policy'
---

## Guide

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

This is the cluster-configurable knob for "this one tenant needs a bigger cache budget / longer retention" without editing the orchestrator unit file or redeploying. See [Storage layout: user cache](../storage-layout.md#user-cache) for the eviction + TTL mechanics.

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

## Reference

<!-- BEGIN GENERATED: kici-admin-org-settings (do not edit; run the doc generator) -->

### `kici-admin org-settings`

Manage org-level security settings

Synopsis: `kici-admin org-settings`

### `kici-admin org-settings allow-http-npm`

Permit plain http:// npm registry URLs in workflow registries:. Default false; loopback / *.local are always allowed regardless.

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

### `kici-admin org-settings artifacts`

Manage per-org artifact quota / TTL / size cap / per-run cap (null = cluster default)

Synopsis: `kici-admin org-settings artifacts`

### `kici-admin org-settings artifacts reset-max-bytes`

Clear the per-org artifact max-bytes override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-max-bytes [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-max-per-run`

Clear the per-org artifact max-per-run override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-max-per-run [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-quota`

Clear the per-org artifact quota override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-quota [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts reset-ttl`

Clear the per-org artifact ttl override (fall back to the cluster default)

Synopsis: `kici-admin org-settings artifacts reset-ttl [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings artifacts set-max-bytes`

Set the per-org artifact max-bytes (positive integer bytes)

Synopsis: `kici-admin org-settings artifacts set-max-bytes <value> [options]`

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

### `kici-admin org-settings artifacts set-max-per-run`

Set the per-org artifact max-per-run (positive integer artifacts)

Synopsis: `kici-admin org-settings artifacts set-max-per-run <value> [options]`

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

### `kici-admin org-settings artifacts set-quota`

Set the per-org artifact quota (positive integer bytes)

Synopsis: `kici-admin org-settings artifacts set-quota <value> [options]`

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

### `kici-admin org-settings artifacts set-ttl`

Set the per-org artifact ttl (positive integer milliseconds)

Synopsis: `kici-admin org-settings artifacts set-ttl <value> [options]`

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

### `kici-admin org-settings artifacts show`

Print the current per-org artifact quota + TTL settings

Synopsis: `kici-admin org-settings artifacts show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings backup-freshness`

Manage the per-org DB-backup freshness WARN threshold (null = cluster default)

Synopsis: `kici-admin org-settings backup-freshness`

### `kici-admin org-settings backup-freshness reset`

Clear the per-org override (fall back to the cluster default)

Synopsis: `kici-admin org-settings backup-freshness reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings backup-freshness set`

Set the per-org backup-freshness WARN threshold in hours (>= 1)

Synopsis: `kici-admin org-settings backup-freshness set [options]`

**Options**

| Option               | Default | Description                       |
| -------------------- | ------- | --------------------------------- |
| `--hours <n>`        |         | Threshold in hours (integer >= 1) |
| `--customer-id <id>` |         | Customer / org id (alias: --org)  |
| `--org <id>`         |         | Alias for --customer-id           |
| `--format <format>`  | `table` | Output format: json\|table        |

### `kici-admin org-settings backup-freshness show`

Print the current per-org backup-freshness threshold

Synopsis: `kici-admin org-settings backup-freshness show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings dashboard-writes`

Manage per-orch dashboard write policy (which Platform-routed dashboard.* writes the orch accepts)

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

Set one or more operations. Use --op <name>=<permissive|encrypted|disabled> per operation (legacy true|false accepted). "encrypted" is valid only for plaintext operations (secrets.set, variables.set). Sugar: --category or --sensitivity + --enabled <bool> expands to the matching operations.

Synopsis: `kici-admin org-settings dashboard-writes set [options]`

**Options**

| Option                 | Default | Description                                                                                        |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `--customer-id <id>`   |         | Customer / org id (alias: --org)                                                                   |
| `--org <id>`           |         | Alias for --customer-id                                                                            |
| `--op <op=state>`      |         | Single operation posture; repeatable (e.g. --op secrets.set=encrypted --op variables.set=disabled) |
| `--category <name>`    |         | Apply --enabled to every operation in this category                                                |
| `--sensitivity <name>` |         | Apply --enabled to every operation in this sensitivity bucket                                      |
| `--enabled <bool>`     |         | Pair with --category or --sensitivity to flip the whole group                                      |
| `--format <format>`    | `table` | Output format: json\|table                                                                         |

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

### `kici-admin org-settings ingest-concurrency`

Manage the per-org webhook-ingest concurrency cap (null = cluster default)

Synopsis: `kici-admin org-settings ingest-concurrency`

### `kici-admin org-settings ingest-concurrency reset`

Clear the per-org webhook-ingest concurrency override (fall back to the cluster default)

Synopsis: `kici-admin org-settings ingest-concurrency reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings ingest-concurrency set`

Set the per-org webhook-ingest concurrency cap (integer, >= 1)

Synopsis: `kici-admin org-settings ingest-concurrency set <value> [options]`

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

### `kici-admin org-settings ingest-concurrency show`

Print the current per-org webhook-ingest concurrency cap

Synopsis: `kici-admin org-settings ingest-concurrency show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout`

Manage the per-org dispatch-queue job timeout (null = cluster default)

Synopsis: `kici-admin org-settings queue-timeout`

### `kici-admin org-settings queue-timeout reset`

Clear the per-org queue-timeout override (fall back to the cluster default)

Synopsis: `kici-admin org-settings queue-timeout reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout set`

Set the per-org queue timeout in milliseconds (0 = indefinite)

Synopsis: `kici-admin org-settings queue-timeout set <ms> [options]`

**Arguments**

| Argument | Required | Variadic | Description                                  |
| -------- | -------- | -------- | -------------------------------------------- |
| `ms`     | yes      | no       | Queue timeout in milliseconds (integer >= 0) |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings queue-timeout show`

Print the current per-org queue timeout

Synopsis: `kici-admin org-settings queue-timeout show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings reroute`

Manage the per-org cross-peer reroute tunables (null = cluster default)

Synopsis: `kici-admin org-settings reroute`

### `kici-admin org-settings reroute reset`

Clear all per-org reroute overrides (fall back to the cluster defaults)

Synopsis: `kici-admin org-settings reroute reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings reroute set`

Set one or more reroute tunables. At least one of --window / --ack-timeout / --max-hops.

Synopsis: `kici-admin org-settings reroute set [options]`

**Options**

| Option               | Default | Description                                         |
| -------------------- | ------- | --------------------------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org)                    |
| `--org <id>`         |         | Alias for --customer-id                             |
| `--window <ms>`      |         | Spawn window (integer milliseconds, >= 1000)        |
| `--ack-timeout <ms>` |         | Reroute ACK timeout (integer milliseconds, >= 1000) |
| `--max-hops <n>`     |         | Maximum peer hops (integer >= 1)                    |
| `--format <format>`  | `table` | Output format: json\|table                          |

### `kici-admin org-settings reroute show`

Print the current per-org reroute tunables

Synopsis: `kici-admin org-settings reroute show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist`

Manage the per-org container-sandbox escape-hatch allow-list (empty = deny all)

Synopsis: `kici-admin org-settings sandbox-allowlist`

### `kici-admin org-settings sandbox-allowlist allow-host-network`

Allow (true) or deny (false) workflow-requested host networking

Synopsis: `kici-admin org-settings sandbox-allowlist allow-host-network <value> [options]`

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

### `kici-admin org-settings sandbox-allowlist reset`

Clear the allow-list (deny all capabilities and host networking)

Synopsis: `kici-admin org-settings sandbox-allowlist reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist set-capabilities`

Set the allowed capabilities (comma-separated, e.g. NET_ADMIN,SYS_PTRACE; empty clears)

Synopsis: `kici-admin org-settings sandbox-allowlist set-capabilities <capabilities> [options]`

**Arguments**

| Argument       | Required | Variadic | Description |
| -------------- | -------- | -------- | ----------- |
| `capabilities` | yes      | no       |             |

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings sandbox-allowlist show`

Print the current per-org sandbox capability + host-network allow-list

Synopsis: `kici-admin org-settings sandbox-allowlist show [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings scaler-spawn-timeout`

Manage the per-org scaler spawn deadline (null = cluster default)

Synopsis: `kici-admin org-settings scaler-spawn-timeout`

### `kici-admin org-settings scaler-spawn-timeout reset`

Clear the per-org scaler spawn deadline override (fall back to the cluster default)

Synopsis: `kici-admin org-settings scaler-spawn-timeout reset [options]`

**Options**

| Option               | Default | Description                      |
| -------------------- | ------- | -------------------------------- |
| `--customer-id <id>` |         | Customer / org id (alias: --org) |
| `--org <id>`         |         | Alias for --customer-id          |
| `--format <format>`  | `table` | Output format: json\|table       |

### `kici-admin org-settings scaler-spawn-timeout set`

Set the per-org scaler spawn deadline (integer milliseconds, >= 1000)

Synopsis: `kici-admin org-settings scaler-spawn-timeout set <value> [options]`

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

### `kici-admin org-settings scaler-spawn-timeout show`

Print the current per-org scaler spawn deadline

Synopsis: `kici-admin org-settings scaler-spawn-timeout show [options]`

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

### `kici-admin trust-policy`

Show or set the org trust policy the orchestrator enforces

Synopsis: `kici-admin trust-policy`

### `kici-admin trust-policy set`

Set the trust policy (independent orchestrators only — a Platform-attached orchestrator is managed from the dashboard). At least one flag required.

Synopsis: `kici-admin trust-policy set [options]`

**Options**

| Option                                 | Default | Description                                      |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `--customer-id <id>`                   |         | Org / customer id                                |
| `--format <format>`                    | `table` | Output format: json\|table                       |
| `--fork-policy <value>`                |         | Fork PR policy (hold \| reject \| allow)         |
| `--unknown-contributor-policy <value>` |         | Unknown contributor policy (hold \| reject)      |
| `--workflow-change-policy <value>`     |         | Workflow change policy (hold \| reject \| allow) |
| `--approval-expiry-hours <value>`      |         | Security-hold approval expiry (integer >= 1)     |

### `kici-admin trust-policy show`

Print the trust policy currently enforced for an org

Synopsis: `kici-admin trust-policy show [options]`

**Options**

| Option               | Default | Description                |
| -------------------- | ------- | -------------------------- |
| `--customer-id <id>` |         | Org / customer id          |
| `--format <format>`  | `table` | Output format: json\|table |

<!-- END GENERATED: kici-admin-org-settings -->
