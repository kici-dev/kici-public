---
title: 'kici-admin: inspection & recovery'
description: 'Cold-storage inspection, attestation backfill, access / event logs, and diagnostic bundles'
---

## Guide

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

### signing-key -- provenance signing key lifecycle (direct DB)

```bash
kici-admin signing-key list [--database-url <url>] [--json]
kici-admin signing-key generate [--database-url <url>] [--yes] [--dry-run]
kici-admin signing-key rotate [--database-url <url>] [--yes] [--dry-run]
kici-admin signing-key retire <kid> [--database-url <url>]
kici-admin signing-key revoke <kid> --reason <reason> [--database-url <url>] [--yes]
kici-admin signing-key export --public [--out <file>] [--database-url <url>]
```

Manages the orchestrator's own ES256 provenance signing key — the trust root that signs build-attestation identity tokens and backs the JWKS your orchestrator publishes. Talks to the orchestrator database directly, so it works before the orchestrator is up.

- `generate` mints the initial key and is a no-op when one is already active; `rotate` mints a new active key and moves the old one to `retiring`.
- `retire <kid>` moves a retiring key to `retired`. It **stays in the JWKS**, so bundles it already signed keep verifying — this is the normal end of a rotation.
- `revoke <kid>` is the compromise path: the key is **removed from the JWKS** and everything it signed becomes distrusted. `--reason` is required and recorded for audit.
- `export --public` writes the `{ issuer, jwks }` artifact containing **public halves only** (the private half is non-exportable, and the flag is the explicit confirmation of that). It doubles as the offline trust root for `kici verify-attestation --trust-root` and as the public-JWKS backup.

See [Signing keys](../signing-keys.md) for the full provisioning, rotation, and backup procedure.

### dashboard-encryption-key -- browser write-sealing key (direct DB)

```bash
kici-admin dashboard-encryption-key show [--database-url <url>] [--json]
kici-admin dashboard-encryption-key list [--database-url <url>] [--json]
kici-admin dashboard-encryption-key rotate [--database-url <url>] [--yes] [--dry-run]
```

Manages the X25519 key browsers seal dashboard secret / variable writes to under the `encrypted` dashboard-write posture. Separate from the provenance signing key above: this one is an encryption key, never a signing key.

- `show` prints the active key — its `kid`, public JWK, and the JWKS URLs the browser fetches it from.
- `list` shows every key on record with its status, so you can confirm a prior key is still present to decrypt envelopes sealed to it.
- `rotate` mints a new active key. The prior key is retained and still decrypts envelopes already sealed to it, so an in-flight browser write is never orphaned.

Requires the orchestrator's master key (`KICI_SECRET_KEY`) — the private half is stored encrypted. See [Encrypted dashboard writes](../../security/encrypted-dashboard-writes.md) for the three write postures and the Convenient / Verified key-distribution tiers.

### access-log -- read / admin-mutation attribution log

```bash
kici-admin access-log list [--org-id <orgId>] [--actor-type <t>] [--actor-id <id>] [--action <action>] [--source <s>] [--outcome <o>] [--target-type <t>] [--target-id <id>] [--from <ts>] [--to <ts>] [--q <text>] [--limit <n>] [--cursor <c>] [--json]
kici-admin access-log show <id> [--json]
```

Operator-facing read access to the orchestrator's `access_log` table — every read / admin-mutation attributed to an `ActorPrincipal` (user, api_key, service_account, platform_operator, system). Dogfood replacement for raw `psql` when an operator asks "who read this run's payload last Tuesday" or "show me everything a platform_operator actor did".

Output includes actor (type + id + optional metadata), action, source, outcome, target (if any), request ID, and timestamps.

### event-log -- inbound webhook delivery log

```bash
kici-admin event-log list [--org <orgId>] [--routing-key <key>] [--event <type>] [--status <s>] [--from <ts>] [--to <ts>] [--delivery-id <substr>] [--limit <n>] [--offset <n>] [--include-archived] [--json]
kici-admin event-log show <deliveryId> --org <orgId> [--include-payload] [--routing-key <key>] [--json]
```

Operator-facing read access to the orchestrator's `event_log` table — every inbound webhook delivery (relay or direct) the orchestrator has seen, with metadata + a pointer to the gzipped payload in object storage.

Output includes routing key, event/action, source (relay/direct), provider, repo, ref, status, matched workflow count, first run spawned, error message (if failed), received-at, archived-at (when the row has been moved to cold-store), payload size + hash, and (with `--include-payload`) the JSON body.

**Retention model:** rows older than 30 days are archived to S3 instead of being hard-deleted, so the cold tail is effectively forever. Set `--include-archived` on `list` (and pass `--routing-key`) to fold the cold tail into a list query; `show` always tries cold on PG miss when `--routing-key` is supplied. The orch retains the per-row gzipped webhook payload at `event-log/<orgId>/<deliveryId>.json.gz` indefinitely, so `--include-payload` continues to work for archived deliveries.

**RBAC tokens for these commands:** the bearer token's role must include `event_log.read` (all roles get this by default — owner, admin, auditor) for `list` / `show`, and additionally `event_log.read_payload` (owner, admin only — NOT auditor) for `show --include-payload`.

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

### inspect-bundle -- bundle analysis (offline)

```bash
kici-admin inspect-bundle <path>
```

Parses a previously created debug bundle and displays a structured, colorized summary. Works fully offline -- no running orchestrator needed.

## Reference

<!-- BEGIN GENERATED: kici-admin-inspection-recovery (do not edit; run the doc generator) -->

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

### `kici-admin dashboard-encryption-key`

Manage the X25519 key browsers seal dashboard secret/variable writes to (orchestrator DB)

Synopsis: `kici-admin dashboard-encryption-key`

### `kici-admin dashboard-encryption-key list`

List every dashboard-encryption key on record (kid / status / created_at)

Synopsis: `kici-admin dashboard-encryption-key list [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--json`               |         | Emit raw JSON                                |

### `kici-admin dashboard-encryption-key rotate`

Mint a new active dashboard-encryption key (the prior key still decrypts envelopes already sealed to it)

Synopsis: `kici-admin dashboard-encryption-key rotate [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--yes`                |         | Skip the confirmation prompt                 |
| `--dry-run`            |         | Show what would happen without rotating      |

### `kici-admin dashboard-encryption-key show`

Print the active dashboard-encryption key (kid, public JWK, JWKS URLs)

Synopsis: `kici-admin dashboard-encryption-key show [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--json`               |         | Emit raw JSON                                |

### `kici-admin debug-bundle`

Generate a diagnostic debug bundle ZIP for troubleshooting

Synopsis: `kici-admin debug-bundle [options]`

**Options**

| Option                      | Default                      | Description                                                                                                  |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-o, --output <path>`       | `kici-debug-<timestamp>.zip` | Output ZIP file path                                                                                         |
| `--log-dir <path>`          |                              | Directory with rotated *.log files to include (defaults to $KICI_LOG_DIR)                                    |
| `--log-window <hours>`      | `4`                          | Hours of log history to include in the bundle                                                                |
| `--fleet`                   |                              | Collect logs from every node in the cluster (server-side fan-out)                                            |
| `--list`                    |                              | With --fleet: print the fleet topology and exit (no collection)                                              |
| `--json`                    |                              | With --fleet --list: emit the topology as JSON                                                               |
| `--pick [selectors]`        |                              | With --fleet: comma-separated selectors (id/host*/label:k=v); bare flag opens an interactive picker on a TTY |
| `--fleet-timeout <seconds>` | `60`                         | Per-node deadline for --fleet                                                                                |

### `kici-admin diagnose`

Run diagnostic health checks on the orchestrator

Synopsis: `kici-admin diagnose [options]`

**Options**

| Option   | Default | Description                                |
| -------- | ------- | ------------------------------------------ |
| `--json` |         | Output raw JSON instead of formatted table |

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

### `kici-admin inspect-bundle`

Parse and display a structured summary of a debug bundle

Synopsis: `kici-admin inspect-bundle <path>`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | yes      | no       |             |

### `kici-admin signing-key`

Orchestrator-owned provenance signing key management (orchestrator DB)

Synopsis: `kici-admin signing-key`

### `kici-admin signing-key export`

Export the { issuer, jwks } backup + air-gap trust-root artifact (public halves ONLY)

Synopsis: `kici-admin signing-key export [options]`

**Options**

| Option                 | Default | Description                                                            |
| ---------------------- | ------- | ---------------------------------------------------------------------- |
| `--public`             |         | Confirm export of PUBLIC key material only (private is non-exportable) |
| `--out <file>`         |         | Write to a file instead of stdout                                      |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL)                           |

### `kici-admin signing-key generate`

Generate the initial db-custody signing key (no-op if one is active)

Synopsis: `kici-admin signing-key generate [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--yes`                |         | Skip the confirmation prompt                 |
| `--dry-run`            |         | Show what would happen without generating    |

### `kici-admin signing-key list`

List provenance signing keys (kid / status / created_at)

Synopsis: `kici-admin signing-key list [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--json`               |         | Emit raw JSON                                |

### `kici-admin signing-key retire`

Move a retiring key to retired (stays in the JWKS; historical bundles keep verifying)

Synopsis: `kici-admin signing-key retire <kid> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `kid`    | yes      | no       |             |

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |

### `kici-admin signing-key revoke`

Distrust a compromised key (REMOVED from the JWKS; everything it signed is distrusted)

Synopsis: `kici-admin signing-key revoke <kid> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `kid`    | yes      | no       |             |

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--reason <reason>`    |         | Why the key is being revoked (audit)         |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--yes`                |         | Skip the confirmation prompt                 |

### `kici-admin signing-key rotate`

Generate a new db-custody key and activate it (old key → retiring)

Synopsis: `kici-admin signing-key rotate [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--yes`                |         | Skip the confirmation prompt                 |
| `--dry-run`            |         | Show what would happen without rotating      |

<!-- END GENERATED: kici-admin-inspection-recovery -->
