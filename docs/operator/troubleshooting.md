---
title: Troubleshooting
description: Operator diagnostics for common KiCI failure modes
---

Operator-facing diagnostics for runtime failures that aren't already covered by the monitoring or observability guides.

Workflow authors hitting the same failures from the developer side have a
companion reference at [Common failures](../user/common-failures.md); this page
is the orchestrator-operator depth behind it.

## Investigating a failed run

When a run ends in `failed`, work outward from the highest-signal surface to the lowest.

### 1. Read the run's failure reason and per-job error

A failed run carries a top-level `failureReason` and each job carries an `errorMessage`. The fastest way to see them:

- **Dashboard → run detail.** The run header shows a red banner with the `failureReason`; the job tree marks the failed job, and selecting it shows its logs. This is the recommended starting point.
- **`kici-admin runs show <runId>`.** Prints the run header (including `failureReason`), the jobs table, and per-job steps. `kici-admin runs list --status failed` finds recent failures; `kici-admin runs jobs <runId>` lists jobs with their `errorMessage`.

`kici runs show <runId>` is the workflow author's quick check — it shows the run status and the jobs-and-steps tree (including each step's exit code). `kici runs logs <runId>` replays the step logs.

### 2. Read the step logs

For failures that happen **inside** a step (a command exited non-zero, a script threw), the step's own log output is the answer:

- Dashboard → run detail → select the failed job/step → **Logs** tab (live for running steps, historical for completed ones).
- `kici runs logs <runId> --job <name>` from the CLI.
- `kici-admin runs logs <runId> --job <jobId>` from the operator plane. Reach for this when the other two cannot see the step at all — most often the pre-run evaluation round of an organization-wide workflow, which records no execution run, so the dashboard has nothing to show and `kici runs logs` cannot resolve the id. Find the round's ids in the dispatch queue first: `kici-admin queue list --workflow-name '__globaleval__<owner>/<repo>' --limit 5 --json`, where `<owner>/<repo>` is the repo the workflow was authored in; each JSON row carries the job id as `id` and the run id as `run_id`. Use an owner or admin token for both steps: the queue lookup requires `secret.read`, so an auditor token is refused with a 403 before it reaches the logs call (which needs only `run.read`). See [kici-admin: runs, execution & events](./orchestrator/kici-admin/runs-execution-events.md).

### 3. Low-level provisioning / agent-init failures

A distinct failure class happens **before** any step runs — the orchestrator dispatched the job but the agent never came up. Examples: the bare-metal scaler can't find the `node` binary it was told to launch (`spawn node ENOENT`), a container image fails to pull or start, or a Firecracker microVM fails to boot.

This is the dividing line for log-gathering: a failure **after** the agent connects shows up in the step logs (covered in step 2 above), so collect the agent's logs. A failure **before** the agent connects produces no step logs — the agent never ran — so the signal lives in the provisioning surfaces described here.

The scaler captures the underlying error (including a bounded tail of the agent process's stdout/stderr) and surfaces it everywhere a run failure shows up:

- The **dashboard run detail** shows it in the **Provisioning logs** section (collapsible, in the Logs view) and as a **Provisioning failed** entry in the **Provisioning** milestones of the **Timeline** tab.
- When the job ultimately fails because no agent ever registered (the dispatch queue times out), the captured error becomes the run's `failureReason` and the failed job's `errorMessage` instead of a generic "No agents available to dispatch jobs". It shows in the dashboard failure banner, `kici-admin runs show <runId>`, and `kici runs show <runId>`.
- The job may be marked `timed_out_stale` if no agent ever registered a heartbeat (see [Stale run detection](./stale-detection.md)). A recorded provisioning error is what keeps this verdict: the spawn was attempted, so the job's labels did route. The sibling verdict `unroutable` means the opposite — neither a connected agent nor a scaler backend could serve the labels at all, so nothing ever tried to spawn. If you see `unroutable`, the job's error message names the unsatisfied `runsOn` selectors and the fix is a label/fleet one, not a provisioning one; see [what happens when no match is found](./orchestrator/auto-scaler/operations.md#what-happens-when-no-match-is-found).

If a run failed at provisioning (no agent ever came up), run `kici-admin diagnose` and check the `scaler:<name>` rows — a **fail** there confirms the backend could not spawn an agent for a queued job, and the row message carries the captured provisioning error.

So for a suspected provisioning failure:

1. Read the `failureReason` / job `errorMessage` from any of the surfaces in section 1 — the captured scaler error names the root cause directly (missing binary, unpullable image, boot failure).
2. For deeper detail than the captured tail, read the orchestrator logs for the dispatch window. The captured tail is bounded; the full agent-process output and the scaler's launch sequence live in the orchestrator's own structured logs. On a self-hosted orchestrator with file logging, that is `${KICI_LOG_DIR}/orchestrator-*.log`; grep for the scaler backend and the run/job id, and look for the scaler launch attempt and any spawn / container / boot error around that timestamp.
3. Cross-check the scaler config against the host: for a bare-metal scaler, verify the configured `binaryPath` exists and is executable as the orchestrator's user; for a container scaler, verify the image reference is pullable; for Firecracker, verify the kernel/rootfs paths. See [Auto-scaler common configuration](./orchestrator/auto-scaler/common-config.md) and the per-backend pages ([container](./orchestrator/auto-scaler/container.md), [bare-metal](./orchestrator/auto-scaler/bare-metal.md), [Firecracker](./orchestrator/auto-scaler/firecracker.md)).

If you operate the orchestrator under systemd or a container runtime without a `KICI_LOG_DIR` file sink, read its stdout/stderr the way you read any other service (`journalctl`, `podman logs`, your aggregator). Capturing a `kici-admin debug-bundle` (see below) also bundles the recent log window for sharing.

### Capturing a diagnostics bundle

`kici-admin debug-bundle` generates a ZIP with redacted config, system info, cluster health, metrics, and a window of recent logs — the single artifact to attach when escalating a failure you can't resolve from the surfaces above. `kici-admin inspect-bundle <path>` reads one back offline.

### Init failures — runs that never started

A run can fail before any step executes. The dashboard surfaces these as a
banner above the logs panel and the metadata panel's failure summary carries
the same message.

Categories you may see:

- **Secret context resolution failed** — the workflow's secret contexts couldn't be resolved.
- **Install-secrets resolution rejected** — the .npmrc / install-secrets resolution rejected the dispatch.
- **Lock-file / dependency resolution failed** — a lock file was present for the repository but could not be parsed or validated, so the orchestrator records the delivery as a failed run instead of silently skipping it. This covers corrupt JSON, a missing schema version, malformed routing labels, and an **out-of-window schema version**: the orchestrator reads a compatibility window of lock schema versions, and a lock below the floor (too old) or requiring a newer reader (too new) is rejected with a clear, actionable message rather than dispatched. A too-old lock is fixed by recompiling with `kici compile` and pushing again; a too-new lock means the orchestrator must be upgraded to the version the error names — never force an out-of-window lock through. A repository with no lock file at all is not an error and produces no run.
- **Build coordination failed** — the build job dispatch was rejected or the build coordinator timed out.
- **Rejected by context protection rules** — a protection rule (review / wait timer / branch restriction) rejected the job.
- **Dynamic / deferred-init evaluation failed** — a dynamic or deferred-init job dispatch failed.
- **No agent available to run this job** — no agent matching the job's `runs-on` labels was reachable.
- **Matrix expansion failed** — a job's dynamic matrix function threw or timed out while resolving its matrix values, so that job is marked failed before any of its steps run.
- **Sandbox escape-hatch request not permitted** — the workflow requested a container-sandbox capability or host networking the org's allow-list does not permit.
- **Rejected by the org trust policy** — the org's trust policy is set to `reject` for this pull request (a fork PR, an unresolvable contributor, or a workflow-file change by a non-trusted contributor). The run fails before any job starts and is **not** approvable — an org owner must change the policy under **Settings > CI trust**, after which a new push re-evaluates it. See [CI security](security/security.md).
- **Approval gate misconfigured** — an approval gate carried an invalid timeout (it must be a positive integer number of seconds). The whole run fails before any job dispatches rather than letting the gate silently expire open. Fix the `approval.timeout` in the workflow (or the lock file) and re-run.

For run-scoped failures (the whole run never started), the dashboard offers
four entry points: in-dashboard tabs (Timeline, Summary, metadata),
`kici runs show <runId>`, `kici-admin` (`diagnose`, `runs show`, `debug-bundle`),
and this troubleshooting page.

### Log content is served by the orchestrator

If the dashboard shows "Log content is served by the orchestrator, which is
currently offline" above an otherwise-empty panel, the run-detail page is
working from Platform's cached metadata — start the orchestrator (or wait
for its WebSocket to reconnect) to retrieve step output.

## No jobs dispatched (no matching agent)

### Symptom

A matched workflow produces no work: the run ends with `No jobs dispatched (all
matched workflows had no static jobs or dispatch was rejected)`, a queued job
reports `No matching agent available`, or the run fails with `No agents
available to dispatch jobs`.

### Cause

The orchestrator matched the trigger and resolved jobs, but no agent carrying the
job's `runsOn` labels is online and none can be spawned. Two distinct root
causes:

- **Label mismatch.** The job asks for labels no agent reports.
  <!-- kici-lint-allow-github-runner: contrast line — GitHub-hosted labels never match a KiCI agent -->
  GitHub-hosted labels (`ubuntu-latest`, `windows-latest`) match no KiCI agent;
  agents report `kici:os:*` / `kici:arch:*` auto-labels plus whatever custom
  labels each scaler declares.
- **No capacity.** The labels are right, but every matching agent is busy and no
  scaler is configured (or able) to spawn another.

### Diagnose

`kici-admin diagnose` reports a `scaler:<name>` row per configured scaler — a
**pass** means the backend can spawn; a **fail** carries the spawn error.
Cross-check the labels a scaler declares against the job's `runsOn`.
`kici diagnostics` (or the dashboard Infrastructure page) lists the agents currently
registered and the labels they report.

### Fix

Either correct the workflow's `runsOn` to a label a scaler provides, or add a
scaler that declares the requested label (see
[Auto-scaler common configuration](./orchestrator/auto-scaler/common-config.md)).
A provisioning failure that prevents an otherwise-matching agent from spawning is
covered under [Investigating a failed run](#3-low-level-provisioning--agent-init-failures)
above.

## Webhook delivered but no run appears

### Symptom

A provider delivered a webhook (the delivery shows 2xx on the provider side) but
no run was created.

### Cause

The orchestrator records every delivery in its `event_log` with an outcome
status. A missing run maps to one of these terminal statuses:

- `processed` with a zero `matched_count` — the delivery was evaluated but no
  workflow trigger matched the event/branch.
- `lockfile_missing` — the repo lookup succeeded but no lock file existed at that
  ref (and no global workflow matched). This is not an error; no run is the
  correct outcome.
- `lockfile_corrupt` — a lock file was present but could not be parsed or
  validated; the orchestrator records a `lock_resolution` init-failure run rather
  than silently skipping (so this one DOES produce a failed run — see
  [Lock-file drift at the orchestrator](#lock-file-drift-at-the-orchestrator)).
- `duplicate` — the dedup cache rejected a re-delivered event.
- `received` — the delivery never reached trigger matching at all. Three things
  produce it: the routing key resolved to no provider, the provider does not map
  that event type to a trigger (a GitHub `check_suite` is the common one, and is
  normal), or the payload carried no repository the source's provider could read.

### Diagnose

`kici-admin event-log` lists recent deliveries with their status and
`matched_count`. Find the delivery in question and read its status: it tells you
directly which of the above happened.

For a `received` delivery, the orchestrator log names which of the three it was,
one line per delivery: `Unknown provider, skipping` also lists the routing keys
that WERE registered, and `Missing repository info in payload, skipping` names
the provider whose normalizer read the payload. Compare that provider against
the source's own type — a `local` or universal-git source answered by the
`generic` provider means the source's settings had not been applied to that
delivery.

### Fix

- `processed` / `matched_count = 0`: the workflow's triggers don't cover the
  event — the customer broadens the trigger and recompiles.
- `lockfile_missing`: no action unless a run WAS expected — then the lock file is
  not committed at that ref.
- `duplicate`: expected on provider retries; no action.
- `received`: no action when the event type simply has no trigger. When a run
  WAS expected, check the source resolves — `kici-admin source list --org <orgId>`
  — and confirm the routing key in the delivery matches the source's own.

## Agent won't connect or register

### Symptom

An agent connects to the orchestrator and is immediately dropped, or an ephemeral
agent never registers so its queued job never dispatches.

### Cause

The orchestrator closes an agent WebSocket with a specific close code:

- **4010 (agent auth failed)** — the agent's token is missing, wrong, or revoked.
  A revoked token closes with `Token revoked`; the agent does **not** retry a bad
  token, so it never registers.
- **4003 (invalid message)** — the agent sent a malformed protocol frame (usually
  a version skew between agent and orchestrator builds), or a second agent tried
  to register with the same agent ID but a different token (`AgentId already
registered with a different token`) — the later one is refused.

A different class never reaches the WebSocket at all: an **ephemeral agent that
failed to provision** (missing `node` binary — `spawn node ENOENT` — unpullable
image, or a microVM that won't boot). No connection attempt is logged because the
process never started.

### Diagnose

`kici diagnostics` (or the dashboard Infrastructure page) shows which agents are
currently registered. For a provisioning failure, `kici-admin diagnose`'s
`scaler:<name>` row carries the captured spawn error, and the dashboard run detail
shows it under **Provisioning logs**. For a close-code drop, read the orchestrator
log around the connection attempt — the close code names the cause.

### Fix

- 4010: reissue the agent token (`kici-admin`), update the agent config, and
  restart the agent.
- 4003: rebuild the agent so its protocol version matches the orchestrator; for an
  agent-ID collision, give each agent a distinct agent ID (or the same ID with the
  matching token).
- Provisioning: fix the host-side root cause the captured error names (install
  the binary, make the image pullable, repair the microVM boot inputs) — the
  per-backend pages under [Auto-scaler](./orchestrator/auto-scaler.md) cover each
  backend's prerequisites.

## Lock-file drift at the orchestrator

### Symptom

Deliveries for a repo record `lockfile_corrupt` in the `event_log`, and each
produces a failed `lock_resolution` init run rather than dispatching. The run's
failure reason names a parse, schema-version, or label-matcher problem.

### Cause

The orchestrator validates every fetched lock at its cache choke point. Three
rejections all surface as the corrupt-lock signal:

- **Not valid JSON**, or **missing/invalid `schemaVersion`** — the file is
  truncated or not a lock file.
- **Out-of-window `schemaVersion`** — the lock's schema version falls outside the
  orchestrator's compatibility window. A lock **below the floor** was compiled by
  an SDK predating a breaking change this orchestrator relies on (`Lock file
schema v<X> predates the oldest supported version v<Y>`) and must be recompiled;
  a lock **above the window** requires a reader newer than this orchestrator
  (`Lock file requires orchestrator schema >= v<X> but this orchestrator
understands <= v<Y>`) and needs the orchestrator upgraded. Locks inside the
  window (additive skew) are accepted, never rejected.
- **Invalid label matcher** — a job's `runsOn`/`excludeLabels` element is not a
  well-formed matcher (`The lock file is likely stale or compiled by an older
engine`). Without this gate a legacy string array would parse as an empty label
  set and mis-route jobs to an arbitrary scaler.

### Diagnose

`kici-admin event-log` shows the `lockfile_corrupt` status; the corresponding
failed run's reason (dashboard run detail or `kici-admin runs show <runId>`) names
which of the three rejections fired.

### Fix

The fix depends on which side of the window the lock fell on. A **too-old** lock
(below the floor) or an **invalid label matcher** is a customer-side fix: the
workflow repo recompiles with `kici compile` against the current toolchain and
pushes the regenerated `kici.lock.json` — point the customer at
[Common failures → Lock-file drift](../user/common-failures.md#lock-file-drift).
A **too-new** lock (requires a newer reader) is an orchestrator-side fix: upgrade
this orchestrator to the version the error names. Forcing an out-of-window lock
through is never correct.

## SDK bundle drift (`Lock file is out of date`)

### Symptom

Every workflow an agent picks up fails with:

```
Lock file is out of date: workflow source changed without regenerating kici.lock.json
(expected contentHash <X>, got <Y>, agent baked @kici-dev/sdk@<V> bundleHash=<Z>).
Run 'kici compile' and commit the updated lock file.
```

The `agent baked ...` suffix identifies the `@kici-dev/sdk` version + bundle hash that was compiled into the agent at build time.

### Root cause

The agent and the host that produced `kici.lock.json` compiled the same workflow source against **different builds of `@kici-dev/sdk`**, so their computed `contentHash` values disagree even though the `.ts` source is identical. This is protocol-level drift: the bundle format didn't change, but the bytes did.

This happens when the host that wrote the lock file and the agent image were built against **different `@kici-dev/sdk` bundles** — for example, the lock file was generated against one published `@kici-dev/sdk` version while the agent image was rebuilt from a different one. Any time those two SDK bundle hashes disagree, every workflow fails with the message above.

### Diagnostic (3-way hash compare)

Three signals tell you which side drifted:

**1. The agent's baked SDK hash** — from the startup log or `/health`:

```bash
# From the agent log files:
grep '"agent.build.info"' ${KICI_LOG_DIR}/agent-*.log | tail -1 | jq .

# Or over HTTP on a running agent:
curl -s http://<agent-host>:<agent-port>/health | jq '.sdkBundleHash, .sdkVersion'
```

**2. The orchestrator's baked SDK hash** — same shape:

```bash
grep '"orchestrator.build.info"' ${KICI_LOG_DIR}/orchestrator-*.log | tail -1 | jq .

curl -s http://<orch-host>:<orch-port>/health | jq '.sdkBundleHash, .sdkVersion'
```

**3. The host SDK hash** — the `@kici-dev/sdk` the host compiled against when it wrote the lock file. Compute the bundle hash of that SDK:

```bash
# If the host compile used a published SDK from a registry:
curl -s <registry-url>/@kici-dev/sdk/-/sdk-<version>.tgz | \
  tar -xzOf - package/dist/index.js | sha256sum

# If the host compile used the workspace source directly:
sha256sum <repo-root>/packages/sdk/dist/index.js
```

The enriched drift error prints the agent's `sdkBundleHash` directly. Compare that value against the orchestrator's (from its log / `/health`) and against whatever SDK the lock file was generated against. The odd one out is the side that drifted.

### Resolution

- **Agent image stale:** rebuild the agent image against the current workspace: `podman build -f packages/agent/Dockerfile .` (or the relevant multi-arch target).
- **Lock file stale:** run `kici compile` against the workflow repo and commit the updated `kici.lock.json`.
- **SDK publish lagging behind:** republish `@kici-dev/sdk` so the host and agent compile against the same bundle.

### Why the existing `--frozen-lockfile` check is not enough

`packages/agent/Dockerfile` already does `COPY pnpm-lock.yaml` + `pnpm install --frozen-lockfile`. That guarantees **image/lockfile parity** — the agent image can't ship a different `@kici-dev/sdk` than the lockfile declares. It does **not** cover the case described above, where the host **workflow-author** compile sees one SDK and the agent compile sees a different SDK even though both came from the same repo. The only guard that catches that class is the runtime bundle-hash echo this page documents.

### Extending the diagnostic

All three services (agent, orchestrator, Platform) mirror the same six fields:

| Field              | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `sdkVersion`       | `package.json#version` of `@kici-dev/sdk` at build time    |
| `sdkBundleHash`    | sha256 of `packages/sdk/dist/index.js` at build time       |
| `sharedVersion`    | `package.json#version` of `@kici-dev/shared` at build time |
| `sharedBundleHash` | sha256 of `packages/shared/dist/index.js` at build time    |
| `engineVersion`    | `package.json#version` of `@kici-dev/engine` at build time |
| `engineBundleHash` | sha256 of `packages/engine/dist/index.js` at build time    |

An `unknown` value means the peer's `dist/index.js` didn't exist when the service was bundled (self-build, or a broken workspace build order) — investigate before trusting the service.

## Postgres "row is missing" after an OS or image upgrade (collation drift)

A row that is provably present in the database reads back as **missing** — a
source's stored credentials, a secret, a run, an org membership — even though a
direct scan shows it. The orchestrator logs this shape:

```
error  Source missing private key in secret store   routingKey=github:...
warn   Failed to refresh GitHub source identity      error="... has no stored credentials ..."
```

If you also see this in the Postgres logs, it is the tell:

```
WARNING:  database "..." has no actual collation version, but a version was recorded
```

### What happened

PostgreSQL text b-tree indexes are ordered by the operating system's collation
(`glibc` for `libc`-provider collations such as `en_US.utf8`). When the collation's
sort order changes **under a live data directory** — an OS upgrade, or a Postgres
container image bumped to a newer base with a different `glibc`, while the data
volume persists — every text index silently becomes inconsistent with the data.
Equality lookups served by those indexes then **miss rows that are actually there**,
while sequential scans (and unique-constraint checks) can disagree. KiCI reads
secrets and sources by an indexed lookup (`WHERE org_id = … AND scope = … AND
key = …`), so a corrupted index surfaces as "the credential is missing."

### Diagnose

Confirm it is index corruption and not genuinely-absent data — compare an
index scan against a sequential scan of the same predicate:

```sql
-- via index (the corrupted path)
SELECT count(*) FROM scoped_secrets WHERE org_id = '__system__';

-- force a sequential scan of the identical predicate
SET enable_indexscan = off;
SET enable_bitmapscan = off;
SET enable_indexonlyscan = off;
SELECT count(*) FROM scoped_secrets WHERE org_id = '__system__';
```

Different counts for a byte-identical value = a corrupted text index. Check the
recorded-versus-actual collation version:

```sql
SELECT datname, datcollate, datcollversion,
       pg_database_collation_actual_version(oid) AS actual
FROM pg_database WHERE datname = current_database();
```

A `datcollversion` that differs from `actual` (or the persistent warning above)
confirms collation drift.

### Fix

Rebuild the indexes under the current collation ordering, then record the new
version:

```sql
REINDEX DATABASE <dbname>;
ALTER DATABASE <dbname> REFRESH COLLATION VERSION;
```

`REINDEX` is the actual repair — after it, the indexed lookup returns the correct
rows and the service reads its data again (restart the service to clear any cached
"missing" state). `REINDEX DATABASE` takes heavy locks; on a busy system prefer
per-index `REINDEX INDEX CONCURRENTLY`. `ALTER DATABASE … REFRESH COLLATION
VERSION` clears the advisory warning; on some `libc` states it errors with
`invalid collation version change` — that is a cosmetic follow-up, not a blocker,
and the `REINDEX` has already fixed the data.

### Prevent

Pin the Postgres image (and its base OS) so `glibc` cannot change under a
persisted data directory across upgrades. When you must move a data directory to a
host or image with a different `glibc` major, plan a `REINDEX` + `REFRESH COLLATION
VERSION` as part of the migration rather than discovering it as a phantom
"missing row."
