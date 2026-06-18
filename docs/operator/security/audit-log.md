---
title: Audit log and data access tracking
description: How orchestrator-side access_log and secret_audit_log work and how to query each
---

KiCI keeps two orchestrator-side audit tables — `access_log` and `secret_audit_log`. This guide explains what lives where, how to read the dashboard's Audit log page, and how to run ad-hoc queries via `kici-admin`.

## The two orchestrator-side tables

| Table              | Scope                                                                                                                                                   | Actor                                                                                                                                                                            | Retention                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `access_log`       | Read + orchestrator-admin mutation attribution for every dashboard proxy call, `kici-admin` admin HTTP call, and `kici-admin access-log` CLI invocation | `ActorPrincipal` (user / api_key / service_account / system / `platform_operator` for upstream support-read break-glass) flattened into (`actor_type`, `actor_id`, `actor_meta`) | 30 days warm + cold (S3 forever) |
| `secret_audit_log` | Secret **mutations only**: create, update, delete, reveal-on-write, and rotate-key operations                                                           | Token owner (`user_id`, `role`)                                                                                                                                                  | 90 days warm + cold (S3 forever) |

The split matters:

- `access_log` answers "who read run Z's payload?" and "who cancelled job Q via the admin API?". It covers every read attributable to an `ActorPrincipal`, plus the orchestrator-admin mutations that now flow through the Bearer-authed `/api/v1/admin/*` surface (including the newly-moved `POST /api/v1/admin/runs/:runId/cancel`).
- `secret_audit_log` is the always-consistent transactional audit trail for secret **writes** (and secret **reveals** when they come in via the legacy `/admin/runs/:runId/secret-outputs?reveal=true` path). It predates `access_log` and is kept around because secret mutations must not depend on a best-effort writer.

`access_log` is explicitly best-effort: insert failures are logged and swallowed so a broken audit table never takes down dashboard reads. `secret_audit_log` stays as the source of truth for secret mutations because those must commit inside the same transaction as the DB change.

## Sampling and rate-limit policy

Both `access_log` and `secret_audit_log` apply a per-action policy at write time so that high-volume but low-forensic-value events do not bury the rows that actually matter. The policy is the single source of truth at `packages/engine/src/audit/access-log-policy.ts` and is exhaustive over the action enums — adding a new action without a verdict is a TypeScript error.

Two override layers run before the per-action policy and force a row regardless of sampling:

1. **`outcome` is `denied` or `error`.** Forensic class — every failed attempt lands at full fidelity. "Who tried to read this run and was denied?" is the question we always need to answer.
2. **Actor is `platform_operator`.** Any activity by a SaaS operator (the `kici-platform-admin support-read` break-glass path) is logged in full, on every action, ignoring sampling and rate-limits. Operator activity is non-tenant-attributable in the normal sense, so we record it exhaustively for compliance.

After the overrides, each action falls into one of three buckets:

| Bucket         | Effective behaviour                                                                                                                                                                | Actions                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **always**     | Every allowed event records a row.                                                                                                                                                 | All mutations (`run.cancel`, `run.rerun`, `secret.set`, `secret.delete`, `environment.create`, `held_run.approve`, etc.), all sensitive reads (`secret.reveal`, `secret.list.read`, `event_log.detail.read`, `event_log.payload.read`, `run.payload.read`, `access_log.list.read`, `env_var.list.read`, `source_override.list.read`), and `archive_chunk`.                                |
| **sample**     | Hash-based stable sampling on `(actor key, requestId)` so a single user's poll trace is coherent — either every poll lands in the sample or none do. Denied/error always recorded. | `run.detail.read` (5%), `event_log.list.read` (5%), `run.orch_logs.read` (10%), `step.logs.read` (10%), `environment.list.read` (10%), `registration.list.read` (10%), `global_workflows.get.read` (10%), `environment.get.read` (20%), `environment.history.read` (20%), `held_run.list.read` (20%), `env_binding.list.read` (20%), `backend.list.read` (20%), `backend.get.read` (20%). |
| **rate_limit** | At most one allowed row per actor per minute, in-memory token bucket. Denied/error always recorded.                                                                                | `diagnostics.read`, `scaler.capacity.read`, `scaler.agents.read` (one row per actor per minute each).                                                                                                                                                                                                                                                                                     |

The `secret_audit_log` writer applies the same override layers, then samples `resolve` and `resolve_named` allowed entries at **1%** (job-execution credential fetches; volume is per-step, not per-user). Every other secret action — `setSecret`, `deleteSecret`, `rotateKey`, `secret-outputs.reveal` — bypasses the sampler because those rows are transactional with their mutation and must always land.

Why this shape:

- **Volume.** Before sampling, every dashboard render of a run-detail page produced ~5 `access_log` rows; the diagnostics page (an internal-ops view that no human ever audits) was the worst offender. Sampling and rate-limiting cut this by an estimated 80% without losing a single forensically-interesting event.
- **Compliance preserved.** Denied/error and platform_operator overrides keep the events that matter — failed attempts, support-read break-glass — at full fidelity regardless of sampling.
- **Mutations untouched.** The sampler never drops a mutation. Every `run.cancel`, `secret.set`, `held_run.approve`, etc. always records.

The in-memory rate-limiter has a process-wide map keyed by `(action, actor key)` whose entries are pruned every five minutes of idleness; memory stays bounded for long-lived orchestrators without a background timer. Restarts reset the buckets — that is intentional and acceptable: a restart is a rare event and at most lets one extra diagnostics row through per actor.

## Dashboard "Activity" page

The dashboard's Activity page (`/orgs/:customerId/activity`) federates the upstream tenant-plane audit log and the orchestrator's `access_log` into one chronological stream, gated by the `audit:read` RBAC permission. The legacy `/audit-log` URL redirects so existing bookmarks survive.

Each row has the actor (sub + display name + email when applicable), the action dotted name, the target, and an outcome badge for access-log rows. Audit rows expand into a field-level diff (old/new); access-log rows expand into request id, origin (`platform_proxy` / `admin_http` / `admin_cli`), and any error message.

### Filters

The filter bar matches the CLI surface (`kici-admin access-log list`):

- **Source** — `all` (default), audit (mutations only), `access_log` (reads + admin only)
- **Actor type** — user / api_key / service_account / system
- **Actor ID** — sub or key id
- **Action** — exact match (e.g. `run.cancel`, `secret.reveal`)
- **Target type** + **Target ID** — free-form (e.g. `run` / `run_abc123`)
- **Run ID** — sugar that maps to (targetType=run, targetId). Both halves of the federation respect it
- **Outcome** — allowed / denied / error (access-log only)
- **Origin** — platform_proxy / admin_http / admin_cli (access-log only)
- **Search** — full-text over `access_log.error_message` and the upstream audit details
- **From** / **To** — ISO date bounds (inclusive lower, exclusive upper)

Filters live entirely in the URL. Bookmarking or sharing a URL replays the filtered view:

```
/orgs/acme/activity?source=access_log&outcome=denied&runId=run_abc123&q=permission&from=2026-04-01
```

### Run-id correlation

The run detail page exposes a "View activity" button in the metadata panel that links to `/activity?runId=…` so operators can pivot from a run into its forensic trail in one click. The reverse is also wired: rows whose `target.type='run'` render the target as a link to the run detail page.

### Federation, partial results, and the CLI

The federated endpoint (`GET /orgs/:customerId/activity`) reads the upstream tenant-plane audit half directly and proxies to the orchestrator for `access_log`. When the orchestrator is unreachable, the upstream half is still returned with a `partialResults: true` banner.

The single-source CLI endpoint stays live because `kici-admin access-log list` consumes `/access-log` directly.

## Querying `access_log` from `kici-admin`

`kici-admin access-log` is the dogfooded operator-facing way to query the same data the dashboard's Data access tab shows, over the orchestrator's admin HTTP surface (`/api/v1/admin/access-log`). The caller needs a Bearer token whose role grants the `access_log.read` permission (granted to `owner`, `admin`, and `auditor`).

### Common invocations

```bash
# Recent reads across all actors:
kici-admin access-log list --limit 50

# Just the reads a specific user performed (by OIDC sub):
kici-admin access-log list --actor-type user --actor-id <user-sub>

# Everything a specific upstream operator touched, with justification:
kici-admin access-log list --actor-type platform_operator --actor-id <sub> --json

# All `run.detail.read` events in the last 24 hours for one org:
kici-admin access-log list --org-id <customerId> --action run.detail.read \
  --from "$(date -u -d '-24 hours' -Iseconds)"

# Everything ever done to a specific run:
kici-admin access-log list --target-type run --target-id <runId>

# One row by id (the filter list returns an id; use it with show):
kici-admin access-log show <accessLogId>
```

Common flags for `list`:

| Flag            | Meaning                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- |
| `--org-id`      | Filter by customer org                                                                  |
| `--actor-type`  | `user` / `api_key` / `service_account` / `platform_operator` / `system`                 |
| `--actor-id`    | Actor identifier (OIDC sub for user, key id, etc.)                                      |
| `--action`      | Dotted action name (e.g. `run.detail.read`, `secret.reveal`, `run.cancel`)              |
| `--source`      | `platform_proxy` / `admin_http` / `admin_cli`                                           |
| `--outcome`     | `allowed` / `denied` / `error`                                                          |
| `--target-type` | `run` / `job` / `step` / `payload` / `event_log` / `secret_scope` / `environment` / ... |
| `--target-id`   | Target identifier                                                                       |
| `--from`        | ISO-8601 lower bound (inclusive)                                                        |
| `--to`          | ISO-8601 upper bound (exclusive)                                                        |
| `--limit`       | Max results, default 50, max 200                                                        |
| `--cursor`      | Opaque cursor from a previous `nextCursor`                                              |
| `--json`        | Emit raw JSON                                                                           |

Enum values are source-of-truth defined in `packages/engine/src/protocol/messages/access-log.ts` — see that file for the full list of dotted actions and target types.

## Retention — cold-store archival

All audit-style tables and both `event_log` instances now flow through the cold-storage archival framework. The hot Postgres copy is bounded by a per-table warm TTL; everything older is archived to S3 (one JSONL-gzip chunk per tenant + day) and DELETEd from Postgres in the same transaction.

| Table                      | Warm window             | Cold tail  | Read-through                                                                                                                                                  |
| -------------------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_audit_log`         | **30–365 days per row** | S3 forever | `kici-admin audit --include-archived` (explicit opt-in)                                                                                                       |
| `access_log`               | **30–365 days per row** | S3 forever | `kici-admin access-log list` and the dashboard "Activity" view (transparent — no flag, cursor crosses into the cold tail automatically)                       |
| `event_log` (Orchestrator) | **30 days**             | S3 forever | `kici-admin event-log list --routing-key <key> --include-archived`; `kici-admin event-log show <deliveryId> --routing-key <key>` always tries cold on PG miss |

The orchestrator-side audit tables apply **per-category** warm TTL — the row's action determines how long it stays in PG. See [Retention by category](#retention-by-category) below for the full bucket table. Neither `access_log` nor `event_log` carries an `expires_at` column; rows older than their per-category warm window are archived to S3 instead of being hard-deleted, so the cold tail is effectively forever. The per-row gzipped webhook payload at `event-log/<orgId>/<deliveryId>.json.gz` is intentionally **kept indefinitely** alongside the archived row metadata, so the dashboard delivery-detail view still resolves payload bodies for archived deliveries.

### Retention by category

The orchestrator-side audit tables (`access_log`, `secret_audit_log`) apply per-row warm TTL based on the row's `action` value. The per-row TTL is computed by the engine module `packages/engine/src/audit/retention-policy.ts`, which is the single source of truth — the cold-store adapters splice the engine-generated SQL `CASE` into their eligibility predicates so the same classification drives both the JS-side decision (where used) and the SQL-side archival pass.

| Category                                      | Example actions                                                                                                                                                                                | Hot PG retention | Cold S3 retention | Notes                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- | ------------------------------------------------------------------------------------- |
| **Secret mutations / reveals**                | `secret.set`, `secret.delete`, `secret.reveal`, `secret_scope.*`, `secret_audit_log` mutations (all non-`resolve` actions)                                                                     | 365 days         | forever           | Compliance.                                                                           |
| **Tenant-plane mutations (non-secret)**       | `environment.*` (non-read), `env_var.*` (non-read), `env_binding.set`, `source_override.*`, `backend.sync*`, `backend.test`, `registration.disable`, `registration.delete`, `run.cancel`, etc. | 180 days         | 730 days (2y)     | Long enough to investigate bugs, short enough to not bloat S3 indefinitely.           |
| **Tenant-plane reads (high volume, sampled)** | `run.detail.read`, `run.orch_logs.read`, `step.logs.read`, `event_log.list.read`, `environment.list.read`, `registration.list.read`, `backend.*.read`, `held_run.list.read`                    | 30 days          | 180 days (6m)     | Sampled at write time per the policy table — surviving rows kept for short forensics. |
| **Tenant-plane reads (sensitive)**            | `secret.list.read`, `source_override.list.read`, `env_var.list.read`, `access_log.list.read`, `event_log.detail.read`, `event_log.payload.read`, `run.payload.read`                            | 180 days         | 730 days (2y)     | Lower volume, higher forensic value.                                                  |
| **Job-execution secret resolves**             | `resolve`, `resolve_named` (in `secret_audit_log`)                                                                                                                                             | 30 days          | 180 days (6m)     | Sampled at 1% in writer; surviving rows kept short.                                   |
| **Internal-ops reads (rate-limited)**         | `diagnostics.read`, `scaler.capacity.read`, `scaler.agents.read`                                                                                                                               | 30 days          | 30 days           | Rate-limited at write time to 1/min/actor; only denied/error survive.                 |
| **Support-read (upstream operator)**          | any `actor_type='platform_operator'` row regardless of action                                                                                                                                  | 365 days         | forever           | Non-tenant actor — full-fidelity forensic record.                                     |
| **Cold-store internals**                      | `archive_chunk`, `replay_chunk`, `purge_chunk`, `scheduled_job_failure`                                                                                                                        | 365 days         | forever           | Low volume, high forensic value if archiver / purger misbehaves.                      |
| **Override — denied / error outcome**         | any action with `outcome IN ('denied', 'error')`                                                                                                                                               | 180 days         | 730 days (2y)     | Forensic full-fidelity; overrides the per-action bucket above on both dimensions.     |

**Override precedence** (applied in order):

1. **Outcome `denied` or `error`** → 180 days (any action, any actor). Forensic full-fidelity wins over the per-action policy.
2. **Actor type `platform_operator`** → 365 days (any action). Non-org-member break-glass wins over the per-action policy. Tied with override 1 only when both apply — outcome wins (more conservative for forensics).
3. Otherwise the per-action category in the table above.

**Adapter mechanics:** the engine generates a Postgres `CASE` expression once per call from the JS retention table; the cold-store adapter splices it into `listEligiblePartitions`, `selectEligible`, and `countTenantWarmBytes` SQL via `sql.raw()`. Every action key is asserted to match `/^[a-z0-9_.-]+$/` at unit-test time so the raw splice has no SQL-injection surface. To change a category's TTL in production, edit the engine retention map; the SQL fragment regenerates from it on the next cold-store cycle.

**Cold-tier purge** runs as the orchestrator's `cold-store-purge` scheduled job alongside the archive sweep (interval-driven, 60 minutes). It calls `BaseColdStore.purgeExpiredChunks()`, which queries `cold_store_chunks` for rows where `archived_at + max_cold_days * INTERVAL '1 day' < now()` AND `max_cold_days != 'forever'`, deletes the corresponding S3 data + manifest objects, and transactionally cleans up PG bookkeeping (`cold_store_chunks` row + `cold_store_chunk_counts` rollup + a `purge_chunk` audit row).

**Bucket layout.** Chunks land at `cold-store/<db>/<table>/<tenant>/<YYYY>/<MM>/<DD>/<bucket>/<chunkId>.jsonl.gz` where `<bucket>` is the row's cold-retention bucket (`30d` / `180d` / `1y` / `2y` / `forever`). The chunk's manifest carries the maximum `coldTtlDays` of any row in the chunk, so the GC sweep keys off the actual row-level retention rather than the bucket name. Older v1 chunks at the day prefix (without a bucket segment) remain readable; the framework treats them as `'forever'` so existing chunks are never purged retroactively.

**Operator surface.** `kici-admin` ships two purge-related subcommands:

- `cold-store list-purgeable [--table T] [--bucket B] [--limit N]` — read-only listing of chunks past their horizon. Streams one JSON object per line to stdout; summary line on stderr.
- `cold-store purge-now [--table T] [--bucket B] [--limit N] [--apply]` — run the same sweep as the scheduled job ad-hoc. **Defaults to dry-run**; the operator must pass `--apply` for the deletes to actually happen. Without `--apply`, the candidate list is printed but no S3 / PG mutations occur.

The purge is **irrecoverable** for chunks whose S3 versioning is off — there's no undo. Operators who run `purge-now --apply` should verify the bucket has versioning enabled (`aws s3api get-bucket-versioning`) if they need a recovery path. The dry-run default is the primary safety mechanism.

Prometheus metrics surface the sweep's behavior on the `Cold storage` Grafana dashboard:

- `cold_store_purge_chunks_total{db,table,result}` — chunks acted on per second by outcome (`purged` / `dry_run` / `skipped_locked` / `failure`).
- `cold_store_purge_bytes_total{db,table}` — gzipped bytes deleted per second.
- `cold_store_purge_duration_seconds{db}` — sweep duration histogram.

The `purge-rate-by-table` and `purge-bytes-by-table` panels visualize the first two; the duration histogram is available via the Grafana Explore for ad-hoc queries.

The hourly `cold-store-archive` scheduled job is the routine driver. To force one cycle on demand: `POST /api/v1/admin/scheduled-jobs/cold-store-archive/trigger` (covers `secret_audit_log` + `access_log` + `event_log` + the rest), or `kici-admin cold-store archive-now <table>` for a single adapter.

Routine inspection (`list-chunks`, `peek-chunk`, `verify-chunk`) is documented in the cold-store operator runbook. The CLI requires ambient access to the same S3 bucket the orchestrator uses (`KICI_COLD_STORE_*` + `AWS_*` env vars sourced from the deployed orchestrator env).

## Support-read break-glass (SaaS operator reads on customer's behalf)

When a KiCI SaaS operator reads a customer's run on the customer's behalf (incident investigation, support ticket response), the orchestrator records an `access_log` row attributed to the operator with `actor_type='platform_operator'`, including the operator's identifier and the justification reason in `actor_meta.reason`. The dashboard's Activity page renders this as:

> "Platform operator <email> read run <runId> — reason: INC-1234: customer report"

The reason string is non-empty (4–200 chars) and lands verbatim in `access_log.actor_meta.reason`, joinable by `request_id` across the federated activity stream. When the operator read happens inside a support session (rather than a one-shot break-glass read), the row also carries the session identifier in `access_log.actor_meta.sessionId`, so every read can be tied back to the session that authorised it; the Activity page surfaces both the reason and the session id on the row.

The same row shape appears whether the operator read a single run as a one-shot break-glass or opened a support session (a longer-lived, reason-bearing investigation window): in both cases the orchestrator records an `access_log` entry with `actor_type='platform_operator'`, `source='platform_proxy'`, and the justification in `actor_meta.reason`. A support session is **runs-only** and read-only. Opening a run inside a session is a deliberate, per-run action — the operator confirms each run before its detail loads — and produces these `access_log` rows, each carrying the same operator identity and reason, with the action naming exactly what was read:

- `run.detail.read` — a single run's metadata, jobs, and steps.
- `step.logs.read` — a step's log output.

Any such row means a KiCI operator opened the named run on your behalf, and the reason explains why — so you can see exactly what was read and when. Browsing the run **list** inside a session does not produce an orchestrator `access_log` row; that read is recorded on the SaaS side instead (the operator's identity plus the session reason), the same plane your own list reads are recorded on.

### Customer opt-in

A support session can only be opened against your organization after one of your org admins enables **support access** from the dashboard settings — sessions are off by default and nobody outside your org can read your data until you opt in. Disabling the toggle immediately ends any in-progress support session. Enabling and disabling support access is itself recorded, attributed to the user who changed it.

## Troubleshooting

### "I see no `access_log` rows"

Possible causes, in order of likelihood:

1. **The orchestrator's schema is out of date — the `access_log` table is missing.** Run `kici-admin db check-schema` — if it returns drift, redeploy the orchestrator so pending migrations apply. When the `access_log` table is absent, the writer silently no-ops with log warnings.
2. **`accessLogWriter` is not wired into the dashboard / admin handlers.** The handlers accept an optional writer; if the orchestrator was started without one (unusual but possible in test harnesses), reads complete but no row lands. Check orchestrator startup logs for `AccessLogWriter initialized` or equivalent.
3. **DB connectivity problem.** The writer is deliberately best-effort: insert failures are logged at `error` level and swallowed so a broken `access_log` never takes down the dashboard. Grep orchestrator logs for `access_log insert failed` — you will see the underlying Postgres error (connection refused, disk full, etc.).
4. **Row was archived to cold storage.** `access_log` does not carry an `expires_at` hard-delete TTL — rows older than 30 days live in S3, not Postgres. `kici-admin access-log list` merges hot + cold transparently when you pass a `--from` past the warm cutoff; if the row is missing from the merged list too, the chunk is genuinely lost (operator runbook covers `verify-chunk` and `replay-chunk`).
5. **Wrong filter.** The CLI's `--org-id` must match the customer's `customerId`, not an OIDC sub or an email. `--action` and `--source` are enums — typos silently produce an empty result. Use `--json` without filters to sanity-check that any rows exist at all before narrowing.

### "The audit row is there but the actor is `system`"

`actor_type='system'` is the fallback for internal operations (scheduler ticks, cleanup sweeps, retries). If you see it for what should be a user read, the upstream proxy probably did not stamp an actor on the request.

### "The audit row has no `actorEmail` / `actorDisplayName`"

Display-name enrichment for `user` and `platform_operator` actors happens upstream of the orchestrator, before the activity row is rendered in the dashboard. `api_key`, `service_account`, and `system` actors correctly have no display info. A `user` row with no display info usually means the user has not logged into the dashboard recently.

## Related docs

- [RBAC](../../architecture/security/rbac.md) — permission resources + levels, including the orchestrator `access_log.read` and `run.cancel`.
- [Secrets management](secrets.md) — `secret_audit_log` shape and how it interacts with `secret.reveal` rows in `access_log`.
