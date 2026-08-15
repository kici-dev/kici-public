---
title: 'kici-admin: runs, execution & events'
description: 'Run inspection, execution maintenance, the dispatch queue, workflow registrations, and event / dead-letter triage'
---

## Guide

### runs -- execution run inspection

```bash
kici-admin runs list [--status <csv>] [--workflow-name <name>] [--repo <ownerRepo>] [--since <iso>] [--count] [--limit <n>] [--offset <n>] [--json]
kici-admin runs show <runId> [--json]
kici-admin runs structured <runId> [--json]
kici-admin runs jobs <runId> [--include-steps] [--json]
kici-admin runs ephemeral-key <runId> [--json]
kici-admin runs secret-outputs <runId> [--output-key <k>] [--reveal] [--json]
kici-admin runs logs <runId> --job <jobId> [--step <n>] [--limit <n>] [--cursor <c>] [--json]
```

Inspects execution runs, jobs, ephemeral keys, and secret outputs. Useful for investigating run status and failures — and, with `secret-outputs --reveal`, for recovering a job's output values during incident response — without direct database access.

Shows run header (status, repo, ref, SHA, provider, timing, environment, trust tier), jobs table, and steps per job. Internally composes two admin API calls: `GET /admin/runs/:runId` (run header) + `GET /admin/runs/:runId/jobs?includeSteps=true`.

Shows the machine-first, provenance-tagged structured run result — the same shape an automation agent reads over the admin API (`GET /admin/runs/:runId/structured`). Trusted fields (run/job/step ids, enum statuses, exit codes, durations, hashes, the derived failure category) are plain; untrusted fields (workflow / repo / job / step names, refs, error text, job output values) are wrapped in an `{ untrusted: true, value }` envelope so a consumer can keep user-controlled content out of an instruction channel. Secret output **values** are never returned — only their key names. The human view unwraps envelopes for display; `--json` is lossless. See [Agent run-result API](../agent-run-result-api.md) for the full contract.

Lists the execution jobs for a single run. Cheaper than `runs show` when you only need job-level state (e.g., for polling). Each job row carries its resolved upstream dependency edges in `needs` (an array of `{ upstreamName, runOn }`, where `runOn` is the per-edge set of upstream terminal statuses that satisfy the edge, or `null` when the job has no upstreams) — the same dependency structure the dashboard run-detail graph view renders.

Answers the security-relevant question "did the per-run ephemeral key get scrubbed?" without `psql`. Returns `{ exists, createdAt }`; the key material itself is **never** exposed on the wire, regardless of role.

Lists the secret outputs produced by a run's jobs. Values are **masked** by default — the row set shows `jobId`, `outputKey`, `createdAt`, and nothing that could reconstruct the secret. `--reveal` is the break-glass path for incident response only: it is always audited, requires the stricter `secret.reveal` permission, and fails with HTTP 503 if the orchestrator was started without a master key (e.g., no `KICI_SECRET_KEY`).

Prints a page of one step's log lines. It reads the orchestrator admin route rather than the dashboard plane, and that is what lets it serve the pre-run evaluation round of an organization-wide workflow: such a round writes no execution run of its own, so neither the dashboard nor `kici runs logs` can address it, and this command is the only path to its output — including anything the workflow's `filter` printed. `--step` defaults to `0`, which is the evaluation itself. `--limit` defaults to 500 and the server caps it at 2000; a truncated page returns a cursor to pass back as `--cursor`.

An evaluation round has no run entry, so its two ids come from the dispatch queue instead:

```bash
# 1. The round's workflow name is `__globaleval__<owner>/<repo>` of the repo the
#    workflow was authored in. In the JSON rows, `id` is the job id and `run_id`
#    is the run id — use `--json`, because the plain table abbreviates both to
#    their first eight characters.
kici-admin queue list --workflow-name '__globaleval__myorg/ci-pipelines' --limit 5 --json

# 2. Step 0 is the evaluation itself.
kici-admin runs logs <run_id> --job <id>
```

**Run this recipe with an owner or admin token — an auditor token cannot complete it.** The two steps sit on different permissions: step 1 reads the dispatch queue, which requires `secret.read`, so an auditor is refused with a 403 and never reaches step 2. Only step 2 falls under the `run.read` grant described next. (An operator with database access can take step 1 offline instead, via `kici-admin queue list --database-url <url>`, which bypasses the admin API and its role check entirely.)

**RBAC tokens for these commands:** `run.read` is enough for `list`, `show`, `jobs`, `ephemeral-key`, `logs`, and masked `secret-outputs` (all three roles — owner, admin, auditor — carry it). `secret-outputs --reveal` additionally requires `secret.reveal`, which only owner + admin roles hold — auditor tokens get 403. Successful reveals land in `secret_audit_log` with `action = secret-outputs.reveal`, `run_id`, `user_id`, `role`, and a `metadata` JSON object summarising the revealed / failed output keys.

### execution -- execution read + maintenance

```bash
kici-admin execution list [--routing-key <k>] [--status <s>] [--workflow-name <n>] [--limit <n>] [--database-url <url>] [--json]
kici-admin execution show <runId> [--database-url <url>] [--json]
kici-admin execution purge-stale --routing-key <key> --confirm
kici-admin execution purge-stale --routing-key <key> --confirm --database-url $URL
```

- `list` / `show` are read-only inspection verbs over `execution_runs` / `execution_jobs` (dual-mode).
- `purge-stale` deletes `execution_runs` + `execution_jobs` whose `routing_key` differs from the current cluster (or is NULL). Used by redeploy workflows that move a cluster to a new `routing_key` — leftover rows from the previous key would otherwise violate FK constraints on restart.

### check-run -- check-run tracking reads

```bash
kici-admin check-run list --sha <sha> [--check-name <name>] [--limit <n>] [--database-url <url>] [--json]
```

- Read-only. Answers "did we post that check run?" for a commit, without reaching into the database by hand.
- Each row is one check run the orchestrator recorded for the commit, and each column answers a different half of the question:
  - `CHECK_RUN_ID` — the id the provider returned at _create_ time, when the check run was still queued. It answers "did we create it?" and nothing more.
  - `CREATE_STATE` — `pending` from just before the create call until it returns. Nothing resets it on failure, so a row left on `pending` means the create never returned an id: still in flight, or permanently failed. It distinguishes an in-flight create from a missing one; it does not prove the create succeeded.
  - `TERMINAL_SENT` — when the terminal `completed` update was accepted by the provider. This is the column that answers "did we complete it?".
  - `IN_PROGRESS_SENT_AT` — written only for per-job check names (`kici/<workflow>/job/<job>`). The workflow-level `kici/<workflow>` row always shows an em dash here.
- **Every write on this table is best-effort**, so an em dash (`—`) means "no record", never proof that the call failed. If the database is unreachable the orchestrator falls back to an in-memory copy and keeps reporting to the provider, so a check run can exist at the provider with nothing recorded here.
- Direct-DB only — pass `--database-url` or set `KICI_DATABASE_URL`. There is no HTTP form of this command.

```bash
# Did we post the workflow-level check run for this commit?
kici-admin check-run list --sha 4f2c1ab --check-name kici/e2e-test --database-url $URL
```

A check run that GitHub still shows as queued reads as: `TERMINAL_SENT` set means we sent the terminal update and the provider is lagging or dropped it; `TERMINAL_SENT` empty with the run itself finished means the terminal update never left the orchestrator.

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

### workflow -- workflow registration inspection

```bash
kici-admin workflow list [--org <orgId>] [--routing-key <key>] [--repo <ownerRepo>] [--trigger-type <type>] [--event <eventName>] [--json]
kici-admin workflow register-manual --lock-file <path> --repo <ident> --routing-key <key> --customer <id> [--provider-context <json>] [--commit-sha <sha>] [--database-url <url>] [--json]
```

`list` inspects workflow registrations from the `workflow_registrations` table. All filters are optional and combinable.

`register-manual` seeds `workflow_registrations` rows straight from a compiled lock file — used by local-only / non-Git deployments and E2E helpers that can't rely on a webhook-driven compile-and-register flow. Dual-mode (HTTP via admin API, or direct DB via `--database-url`).

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

## Reference

<!-- BEGIN GENERATED: kici-admin-runs-execution-events (do not edit; run the doc generator) -->

### `kici-admin check-run`

Check-run tracking reads (read-only)

Synopsis: `kici-admin check-run`

### `kici-admin check-run list`

List the check runs the orchestrator recorded for a commit

Synopsis: `kici-admin check-run list [options]`

**Options**

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--sha <sha>`          |         | Commit SHA to look up                        |
| `--check-name <name>`  |         | Filter by check name (e.g. kici/e2e-test)    |
| `--limit <n>`          |         | Max rows to return (default 50, max 1000)    |
| `--database-url <url>` |         | Orchestrator DB URL (else KICI_DATABASE_URL) |
| `--json`               |         | Emit JSON output                             |

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

### `kici-admin runs logs`

Print a page of a step log (dogfooded via /api/v1/admin/runs/:runId/jobs/:jobId/steps/:i/logs)

Synopsis: `kici-admin runs logs <runId> [options]`

**Arguments**

| Argument | Required | Variadic | Description |
| -------- | -------- | -------- | ----------- |
| `runId`  | yes      | no       |             |

**Options**

| Option          | Default | Description                                            |
| --------------- | ------- | ------------------------------------------------------ |
| `--job <jobId>` |         | Job id (the dispatch_queue row id for an eval round)   |
| `--step <n>`    | `0`     | Step index (default 0)                                 |
| `--limit <n>`   | `500`   | Max lines to return (default 500, server caps at 2000) |
| `--cursor <c>`  |         | Line-offset cursor from a previous page                |
| `--json`        |         | Emit raw JSON instead of plain lines                   |

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

<!-- END GENERATED: kici-admin-runs-execution-events -->
