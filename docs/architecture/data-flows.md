---
title: Data flows
description: End-to-end data flows through the KiCI three-tier architecture
---

This document describes the key data flows through the KiCI architecture: webhook delivery, job execution, developer-initiated remote runs, dependency caching, re-run and cancel, trace ID propagation, internal event routing, and generic webhook ingestion.

> **Lock file schema version:** The lock file uses schema version 21, which adds the `CheckMode` / `CheckStepOutcome` enums for check-mode step execution on top of v20's `LabelMatcher` (exact/regex) selectors for `runsOn`/`runsOnAll`/`excludeLabels`, v19's `maxParallel`/`failFast` fan-out concurrency, v18's `runsOnAll` host fan-out predicate and `onUnreachable` policy, v17's typed init presets (`mise` / `{ mise }`) and `auto` detection, v16's normalized approval config, v15's per-job init config, v14's declarative cache specs, v11's `LockInlineValue` for pure function inline evaluation, v10's simplified negative patterns (! prefix in repos/paths arrays), v9's global workflow repos matching, and v8's runsOn polymorphic type support.

## Webhook delivery flow

A webhook event from a provider (e.g., GitHub) travels through three tiers before execution begins.

```
GitHub  -->  Platform Relay  -->  Orchestrator  -->  Agent
        1. Webhook          2. WebSocket        3. Job dispatch
           POST                relay               + execution
```

### Step by step

1. **Provider sends webhook** to the Platform relay endpoint.
2. **Platform routes the webhook** to the right orchestrator over WebSocket and forwards the body bytes verbatim. Platform never sees customer HMAC secrets — signature verification happens entirely on the orchestrator after reassembly.
3. **Orchestrator verifies signature** (HMAC-SHA256 against per-source webhook secret, with dual-secret rotation support).
4. **Orchestrator dedup check** against dual-layer `DedupCache` (in-memory set + `dedup_cache` DB table).
5. **Orchestrator resolves provider** by looking up the provider bundle from the `ProviderRegistry` using `getByRoutingKey()` (exact match first, falls back to provider type prefix for backward compatibility). Skips processing if the provider is unknown.
6. **Orchestrator normalizes** the webhook via the provider's `WebhookNormalizer` (extracts branch, event type, action, sender).
7. **Orchestrator extracts repo and credentials** from payload (repository identifier from `repository.full_name`, provider credentials such as GitHub installation ID).
8. **Orchestrator handles /kici commands** in `issue_comment` events: intercepts `/kici approve` and `/kici reject` approval commands before trigger matching, delegating to `handleApprovalComment()` for security hold management.
9. **Orchestrator resolves trust** for PR events (determines lock file source: head vs base branch).
10. **Orchestrator fetches lock file** via the provider's `LockFileFetcher` (cached with LRU). For untrusted PR events, fetches both base and head lock files in parallel; for trusted PRs and pushes, fetches from head SHA.
11. **Orchestrator detects workflow modifications** for untrusted PR events by comparing base and head lock files via `detectWorkflowModifications()`, applying security holds when non-trusted contributors modify workflow files.
12. **Orchestrator extracts registrations** on default-branch pushes: persists registerable workflows (event, schedule, lifecycle triggers) for cluster-wide event matching.
13. **Orchestrator notifies the event router** on default-branch pushes: after the registrations are persisted, emits a `registration.updated` event via `eventRouter.emit()` (if event routing is active). Workflow event subscriptions are the persisted registrations themselves, matched at emit time through the registration index.
14. **Orchestrator fetches changed files** via the provider's `ChangedFilesFetcher` for path-based trigger filtering (skipped when no workflow uses path filters).
15. **Orchestrator matches triggers** against lock file using `matchAllWorkflows()` from `@kici-dev/engine`.
16. **Orchestrator checks caches** for source tarballs and dependency tarballs.
17. **Orchestrator dispatches jobs** to agents via the job queue and WebSocket.
18. **Orchestrator persists a delivery row** keyed by `(org_id, delivery_id)` to its own `event_log`, including a pointer to the gzipped payload in object storage. The orchestrator's delivery log is surfaced in the dashboard's Settings → Event log tab. See [`webhook-delivery.md`](./webhooks/webhook-delivery.md#delivery-log).

## Job execution flow

Once the orchestrator has matched triggers and resolved caches, jobs are dispatched to agents.

```
Orchestrator                         Agent                    Sandbox (child process)
    |                                  |                          |
    |-- job.dispatch (WS) ------------>|                          |
    |   (jobConfig, sourceTarUrl,      |                          |
    |    sourceTarHash, depsUrl,       |-- Create sandbox ------->|
    |    depsHash)                     |   (container/bare-metal/ |
    |                                  |    firecracker)          |
    |                                  |                          |-- Restore .kici/ source (tarball)
    |                                  |                          |-- Restore deps (tarball)
    |                                  |                          |-- Load workflow (TS loader hook)
    |                                  |                          |-- Evaluate rules
    |                                  |                          |-- Execute steps
    |                                  |<-- IPC (step status, ----|
    |                                  |    log lines, events)    |
    |<-- job.status (WS) -------------|                          |
    |   (step progress, completion)    |-- Teardown sandbox ----->|
    |                                  |                          |
```

### Agent pipeline

The agent delegates job execution to an `ExecutionSandbox` (container, bare-metal, or firecracker). The sandbox runs customer code in an isolated child process -- never in the agent's V8 isolate. Four job types are handled: execution jobs (sandbox), build-only jobs (in-process, cache population), init-only jobs (in-process, dynamic field resolution), and DynamicJobFn evaluation jobs (in-process, runtime job generation). See [Job execution lifecycle](./execution/job-execution.md) for details.

1. **Report running** -- Send `job.status: running` immediately upon accepting the dispatch
2. **Sandbox selection** -- Determine execution mode (container, bare-metal, firecracker) from job config and environment
3. **Sandbox setup** -- Create and start the execution environment (container: `docker create`/`start`; bare-metal: validate; firecracker: detect)
4. **Context emission** -- Send `job.context` to orchestrator with runtime details (Node version, OS, arch, sandbox type)
5. **Sandbox execution** -- The sandbox child process handles the inner pipeline: `.kici/` source tarball restore, deps tarball restore, workflow loading (dynamic-import `.ts` via the shared TypeScript ESM loader hook), step extraction, rule evaluation, step execution sequentially with timeout and abort support. There is no runtime bundling step — workflow TS is transformed on import, not ahead of time.
6. **IPC callbacks** -- Step status, log lines, event emissions, and concurrency reports flow from the sandbox to the agent via IPC, then to the orchestrator via WebSocket
7. **Report** -- Send final `job.status` back to orchestrator with step results and timing
8. **Cleanup** -- Tear down sandbox and remove work directory

## Remote run flow (`kici run remote`)

A developer running `kici run remote` from a working tree initiates a run through the three-tier relay without a provider webhook. The flow splits into two independent planes: a **control plane** through the Platform relay, and a **data plane** that uploads the working-tree overlay straight to object storage.

```
Developer machine                Platform relay            Orchestrator           Object store
      |                               |                         |                      |
      |-- upload-init (control) ----->|--- WS relay ----------->|                      |
      |   (org, cluster, overlay      |                         |-- mint presigned     |
      |    metadata, inline lock)     |                         |   PUT URL ---------->|
      |<-- presigned PUT URL ---------|<--- WS relay -----------|                      |
      |                               |                         |                      |
      |== overlay tarball PUT (data plane) ===========================================>|
      |                               |                         |                      |
      |-- trigger (control) --------->|--- WS relay ----------->|-- dispatch jobs       |
      |                               |                         |   (agents fetch       |
      |                               |                         |    overlay)           |
      |-- poll logs + status -------->|--- WS relay ----------->|                      |
      |<-- log chunks + status -------|<--- WS relay -----------|                      |
```

### Control plane

Run initiation (`upload-init`), the trigger, status polling, log retrieval, and cancellation all flow from the developer machine to the Platform, which relays them over its WebSocket connection to the org's orchestrator. The developer machine never talks to the orchestrator's HTTP API directly. Logs are delivered by the CLI polling the Platform for log chunks — tracked by a monotonic line cursor — and run status until the run reaches a terminal state; there is no direct streaming socket between the developer machine and the orchestrator.

### Data plane

The working-tree overlay tarball uploads **directly** from the developer machine to the orchestrator's object store via a pre-signed PUT URL minted during `upload-init`. The overlay bytes never pass through the Platform. Because of this split, only the object store needs to be reachable from the developer machine — the orchestrator can sit behind a private network. See [Storage layout](../operator/orchestrator/storage-layout.md) for the upload-endpoint configuration.

### Org anchor

The run is dispatched to the developer's active organization (selected with `kici org use`, or overridden per-run). The orchestrator anchors its bound organization with a system-managed **remote source** (routing key `remote:<orgId>`) that it auto-provisions — no manual webhook source is required, so a zero-source org is immediately routable for remote runs. The Platform forces the run's routing key to `remote:<orgId>` server-side; the developer never sets a routing key. When an org has more than one connected orchestrator cluster, the CLI selects the target cluster explicitly (or relies on the per-org default), and a single connected cluster is auto-selected.

Remote runs are offered by the Platform; an orchestrator with no Platform connection cannot serve them. Executing workflow steps on the developer machine with no orchestrator is the separate `kici run local` path.

## Source and dependency caching flow

KiCI runs two orchestrator-side caches — the **source tarball cache** (raw `.kici/` directory minus `node_modules/`) and the **dependency tarball cache** (packed `node_modules/`). Both use a build-then-execute pattern: the orchestrator checks the caches before dispatching execution jobs, and if the source cache is cold a build agent populates both in one pass.

With the shared TypeScript loader hook plus source tarball, execution agents do not run `git clone` or compile anything at runtime — they perform exactly two S3 GETs (source + deps) and extract.

### Cache miss flow

When the source cache is cold and the dep cache is also missing:

```
Webhook
  |
  v
Trigger Match
  |
  v
Cache Check (source: MISS, deps: MISS)
  |
  v
Build Job Dispatch --> Build Agent (kici:role:builder + matching kici:os:/kici:arch:)
  |                      |
  |                      |-- git clone + checkout SHA
  |                      |-- npm ci in .kici/
  |                      |-- Pack .kici/ source (portable tar.gz, excludes node_modules)
  |                      |-- Pack .kici/node_modules (portable tar.gz)
  |                      |-- Upload source tarball to cache (source/{contentHash}.tar.gz)
  |                      |-- Upload deps tarball to cache (deps/{plat}-{arch}/{lockfileHash}.tar.gz)
  |                      |-- Upload deps companion .hash file
  |                      |-- Report success (cache.upload.complete × 2)
  |                      |
  v                      v
Build Complete <---------+
  |
  v
Get sourceTarUrl + depsUrl from cache (pre-signed S3 GETs)
  |
  v
Execution Job Dispatch --> Execution Agent
  |                          |
  |                          |-- Download source tarball (sourceTarUrl) -> extract to workDir/.kici/
  |                          |-- Download deps tarball (depsUrl) -> verify SHA-256 -> extract to .kici/node_modules/
  |                          |-- Register @kici-dev/shared/ts-loader-hook
  |                          |-- Verify workflow contentHash against lock file (drift guard)
  |                          |-- Dynamic-import workflow .ts
  |                          |-- Execute steps
  |                          |-- Report result
  |                          |
  v                          v
Done <-----------------------+
```

The execution agent never clones the repo. The source tarball IS the workflow repo's `.kici/` directory.

### Cache hit flow

When both caches have valid entries (the common case after the first run at a commit SHA):

```
Webhook
  |
  v
Trigger Match
  |
  v
Cache Check (source: HIT, deps: HIT)
  |
  v
Get sourceTarUrl + depsUrl from cache (pre-signed S3 GETs)
  |
  v
Execution Job Dispatch --> Execution Agent
  |                          |
  |                          |-- Download source tarball (sourceTarUrl) -> extract
  |                          |-- Download deps tarball (depsUrl) -> verify SHA-256 -> extract
  |                          |-- Register TS loader hook
  |                          |-- Dynamic-import workflow .ts
  |                          |-- Execute steps
  |                          |-- Report result
  |                          |
  v                          v
Done <-----------------------+
```

No build job is dispatched. The execution agent performs exactly two S3 GETs and extracts.

### Partial cache hit

The source cache and dep cache are independent. Four combinations are possible:

| Source | Deps | Behavior                                                                             |
| ------ | ---- | ------------------------------------------------------------------------------------ |
| HIT    | HIT  | Direct execution dispatch (fastest, two S3 GETs)                                     |
| HIT    | MISS | No build job; execution agent falls back to inline `npm ci` after restoring source   |
| MISS   | HIT  | Build job for source only (agent still packs deps opportunistically); then execution |
| MISS   | MISS | Build job for source + deps (single job packs both), then execution                  |

Dep cache misses alone do **not** trigger a build job. Deps are platform-specific (`deps/{platform}-{arch}/{hash}.tar.gz`) so a build job would need a builder agent matching the target platform, which may not exist (e.g., an arm64 builder when only x64 builders are available). When the source cache misses, the dispatched build job piggy-backs dep packing if deps are also missing. A single build job handles both artifacts when both miss, avoiding duplicate builds.

### Cross-source / no-contentHash workflows

- **Lock files without `contentHash`** (schema v1) skip the source cache entirely; agents compile from source. Regenerate lock files with `kici compile` to enable caching. The current lock file schema version is 21.
- **Cross-source / global-workflow dispatch** (a workflow registered against source A fired by a webhook on source B) bypasses both caches. The registration's lock file entry still carries `contentHash`, but the cross-source path always clone-and-installs — the eval temp dir doesn't ship `@kici-dev/sdk`. The execution agent still verifies `contentHash` against the cloned source for drift detection.

### Build deduplication

When multiple webhooks trigger simultaneously for the same repository state, the `BuildCoordinator` coalesces concurrent build requests using a combined key (`contentHash:lockfileHash`). Only one build job runs; all waiting dispatches share the result.

### Graceful degradation

If cache storage is unavailable or a download fails:

- **Source tarball download failure:** Hard failure today — the agent does not fall back to `git clone` on the execution path. (The build path is where cloning happens.) In practice this is rare because the same orchestrator that issued the pre-signed URL controls the cache backend.
- **Dep tarball download failure:** Agent falls back to running `npm ci` / `npm install` inline.
- **Dep tarball hash mismatch:** Agent retries the download twice (3 total attempts), then fails the job (no fallback for integrity failures).
- **Source tarball drift (extracted `contentHash` ≠ lock file):** Hard failure with "Lock file is out of date: workflow source changed without regenerating kici.lock.json" — see [Lock file and drift](../user/lock-file-and-drift.md).
- **Build failure:** Execution is skipped entirely with a "Build failed" check status. Workflows that contain dynamic job entries (DynamicJobFn) are allowed to proceed with their dynamic eval jobs since those compile from source.
- **No cache configured:** Agent runs inline install for every job (pre-caching behavior).

## Cache storage architecture

Both source and dep caches use `S3CacheStorage` as the sole backend. The `CacheStorage` interface provides a consistent API, but S3 (or any S3-compatible service: SeaweedFS, MinIO, LocalStack) is the only supported implementation.

```
                    +------------------+
                    | CacheStorage     |
                    | (interface)      |
                    +--------+---------+
                             |
                   +---------+---------+
                   | S3CacheStorage     |
                   | (AWS S3, SeaweedFS,|
                   |  MinIO, LocalStack)|
                   +--------------------+
```

### Cache key design

Cache keys reflect that source tarballs and deps have different platform characteristics:

- **Source:** `source/{contentHash}.tar.gz` — platform-agnostic. Raw TypeScript source is identical regardless of CPU architecture, so one entry is shared across all platforms. `contentHash` is the per-workflow hash from the lock file (`SHA-256(COMPILE_SCHEMA_VERSION + ":" + rawSource [+ "\0" + assetDigest])`, where `COMPILE_SCHEMA_VERSION = 5` and line endings are normalized to LF so the hash agrees across platforms).
- **Deps:** `deps/{platform}-{arch}/{lockfileHash}.tar.gz` (e.g., `deps/linux-arm64/def456.tar.gz`) — platform-specific. Native dependencies in `node_modules` differ across architectures, so each platform/arch combination gets its own cache entry.

The orchestrator derives the target platform/arch for dep cache lookups by probing `AgentRegistry.findAvailable()` with the workflow's first job's `runsOn` labels to find a representative matching agent, then using that agent's platform and arch. Falls back to `linux/x64` if no matching agents are registered.

### TTL and eviction (touch-on-read)

Both caches refresh TTL on read via `touch-on-read`. An entry's lifetime is reset every time an orchestrator issues a pre-signed GET URL for it. Default TTL is `KICI_CACHE_TTL_DAYS=30`; entries unused for 30 days expire at the storage level. Actively used sources and deps stay in cache indefinitely as long as they continue to be referenced by inbound webhooks or reruns. See [`docs/operator/dependency-caching.md`](../operator/dependency-caching.md#cache-behavior) for configuration.

For the full per-package bucket and prefix inventory — cache, logs, cold-store, and the observability sidecar buckets — see [orchestrator storage layout](../operator/orchestrator/storage-layout.md).

### Pre-signed URL upload flow

Agents upload artifacts directly to S3 using pre-signed PUT URLs. This eliminates the orchestrator as a data proxy — only coordination messages flow through WebSocket.

```
Agent                         Orchestrator                    S3
  |                                |                           |
  |-- cache.upload.request ------->|                           |
  |   { type: "source"|"dep",     |                           |
  |     key: "source/..." or       |                           |
  |          "deps/..." }          |                           |
  |                                |-- getUploadUrl(key) ----->|
  |                                |   (PutObject pre-sign)    |
  |<-- cache.upload.response ------|                           |
  |   { url: "https://s3.../..." } |                           |
  |                                |                           |
  |-- HTTP PUT (artifact body) --------------------------->|
  |   (direct S3 upload)           |                           |
  |                                |                           |
  |-- cache.upload.complete ------>|                           |
  |   { type, key, depsHash? }     |-- initMeta(key) -------->|
  |                                |   (CopyObject to set     |
  |                                |    TTL metadata)          |
  |                                |-- put(hashKey) --------->|
  |                                |   (companion .hash file   |
  |                                |    for deps integrity)    |
```

The two-phase metadata approach (`upload via PUT` then `initMeta via CopyObject`) works around the limitation that S3 pre-signed URLs cannot include custom metadata headers. For dependency tarballs, the agent also reports the SHA-256 content hash in `cache.upload.complete`; the orchestrator stores it as a companion `.hash` file alongside the tarball. When dispatching execution jobs, the orchestrator reads this hash and includes it as `depsHash` in `job.dispatch`, enabling agent-side integrity verification on download. Source tarballs do not use a companion `.hash` file — the workflow `contentHash` carried in `sourceTarHash` is used to verify the extracted source against the lock file after extraction, which covers drift end-to-end.

### URL delivery (downloads)

Agents receive pre-signed S3 GET URLs (15-minute expiry) directly in `job.dispatch` messages. Agents download artifacts from S3, bypassing the orchestrator for all data transfer.

## User-facing cache flow

The source/dep cache above is internal: the orchestrator owns its keys and decides when to hit or build. The **user-facing cache** is driven by the workflow author — the declarative `cache: { key, paths, restoreKeys? }` on a job/step, or the imperative `ctx.cache.restore()` / `ctx.cache.save()` API (see [SDK caching reference](../user/sdk/caching.md)). It reuses the same object-storage backend and the same direct-to-storage presigned-URL transport, but the agent — not the orchestrator — initiates each restore and save over WebSocket.

The agent's cache module archives `paths` into a gzipped tarball (computing a SHA-256 over the bytes) and streams downloads back through a checksum-verified extract pipeline. The orchestrator's `UserCache` owns the `cache/<orgId>/<repoId>/<scope>/<key>` namespacing, the immutable first-save check, the `restoreKeys` prefix scan, the two-phase atomic save, and per-org quota/TTL eviction.

### Restore flow

```
Agent                              Orchestrator (UserCache)          Object storage
  |                                      |                                |
  |-- cache.user.restore.request ------->|                                |
  |   { key, restoreKeys? }              |-- exact key in read prefixes ->|
  |                                      |   (isolated: iso/<runId>/      |
  |                                      |    then shared/; trusted:      |
  |                                      |    shared/ only)               |
  |                                      |-- restoreKeys prefix scan ---->|
  |                                      |   (newest match wins)          |
  |                                      |-- getUrl(matched) + touch ---->|
  |<-- cache.user.restore.response ------|                                |
  |   { hit, matchedKey?,                |                                |
  |     downloadUrl?, tarHash? }         |                                |
  |                                      |                                |
  |-- HTTP GET (tarball body) -------------------------------------->|
  |   (direct download; verify tarHash, extract paths)                |
```

The restore resolves the exact `key` across the ref's read prefixes first, then each `restoreKeys` prefix in order (newest matching entry wins). A trusted ref reads only `shared/`; an untrusted/fork ref reads its own `iso/<runId>/` scope and then falls back to `shared/`. On a hit the response carries a presigned GET URL plus the tarball's `tarHash`, which the agent verifies before extracting.

### Save flow (two-phase atomic)

```
Agent                              Orchestrator (UserCache)          Object storage
  |                                      |                                |
  |-- cache.user.save.request --------->|                                |
  |   { key }                            |-- has(final key)? ------------>|
  |                                      |   (immutable: skip if exists)  |
  |                                      |-- getUploadUrl(.tmp-<uuid>) -->|
  |<-- cache.user.save.response ---------|                                |
  |   { uploadUrl?, skip }               |                                |
  |                                      |                                |
  |-- HTTP PUT (tarball body) ----------------------------------->|
  |   (direct upload to temp object)                              |
  |                                      |                                |
  |-- cache.user.save.complete -------->|                                |
  |   { key, tarHash, sizeBytes }        |-- copy(temp -> final) -------->|
  |                                      |-- delete(temp) --------------->|
  |                                      |-- initMeta(final) ------------>|
  |                                      |-- put(.hash) + put(.size) ---->|
  |                                      |-- enforce per-org quota ------>|
```

The save is **immutable** and **atomic**. The orchestrator declines (`skip: true`) up front if the exact key already exists. Otherwise the agent uploads to a `.tmp-<uuid>` object via a presigned PUT, then `cache.user.save.complete` triggers a server-side copy temp→final, a delete of the temp, an `initMeta` to stamp TTL metadata, and `.hash` / `.size` companion writes. Because the final key only appears after the copy, a crashed upload never leaves a corrupt committed entry. The committing save then enforces the per-org byte quota, evicting oldest entries until the org is back under `KICI_USER_CACHE_QUOTA_BYTES`.

### Trust → scope mapping

The orchestrator threads a `cacheRefScope` onto each `job.dispatch`. A **trusted** ref (the repo's own branches, default branch) maps to the `shared` write scope; any other ref (a fork PR) maps to `isolated`, writing to a per-run `iso/<runId>/` scope. This is the cache-isolation model: a fork can restore from the trusted `shared/` cache but can never write into it, so it cannot poison the entries a trusted branch later restores. The org segment of the key namespace (`cache/<orgId>/`) is the per-tenant boundary — no tenant can read another tenant's cache. See [orchestrator storage layout](../operator/orchestrator/storage-layout.md#user-cache) for the full prefix map and quota/TTL knobs.

## Internal event routing flow

Internal events (custom events from `ctx.emit()` and system events from workflow/job completion) flow through the event router for fan-out delivery to matching workflows.

```
Step ctx.emit('event-name', payload)
  |
  v
Agent IPC (fork channel or stdout JSON-lines)
  |
  v
Agent -> event.emit WS message -> Orchestrator
  |
  v
EventRouter.emit()
  |-- CircuitBreaker check (chain depth, rate limit) — fail-fast, in-memory
  |-- BEGIN TRANSACTION
  |     |-- EventStore.writeWith(tx) -> INSERT into kici_events table
  |     |-- pg_notify('kici_event_channel', eventId) (queued; fires on commit)
  |-- COMMIT (rollback discards both insert and notify atomically)
  |
  v
All Orchestrators LISTEN on 'kici_event_channel' channel
  |
  v
EventRouter.onNotification(eventId) [private]
  |-- EventStore.tryLeaseForProcessing(eventId, nodeId, leaseDurationMs)
  |     (atomic UPDATE: claim only if processed=false AND dlq_at IS NULL
  |      AND (claimed_at IS NULL OR claimed_at < NOW() - leaseDurationMs);
  |      increments attempts and records claimed_at/claimed_by atomically)
  |-- If lease acquired:
  |     |-- processSubscriptions(event):
  |     |     |-- If RegistrationIndex available:
  |     |     |     Look up registrations by trigger type
  |     |     |     TrustStore.isTrusted() (for cross-repo events)
  |     |     |     matchAllWorkflows() against registered workflows
  |     |     |-- Else (no RegistrationIndex):
  |     |     |     TrustStore.isTrusted() (for cross-routing-key events)
  |     |     |     matchAllWorkflows() against in-memory lock file subscriptions
  |     |     |-- For each match: onEventMatched(event, lockFile, matchedWorkflows)
  |     |
  |     |-- On success: markProcessed (commits processed=true, clears lease)
  |     |-- On failure (any onEventMatched throws):
  |           |-- If attempts >= maxDispatchAttempts: markDlq('exhausted_retries')
  |           |-- Else: recordDispatchFailure (sets next_retry_at via exponential
  |                     backoff with full jitter; clears lease)
  |
  v
Job dispatch to agents (standard pipeline)
```

### At-least-once delivery + DLQ

Two invariants keep events from being silently lost:

- **Cron-fire atomicity:** `tryClaimFire` (advances `cron_last_fired`) and the
  event-row INSERT + `pg_notify` execute inside the same database transaction.
  If the leader process is killed between the two writes, the transaction
  rolls back and no `last_fired_at` advance leaks. The next tick re-evaluates
  and fires cleanly.
- **Dispatch retries:** the lease pattern (`tryLeaseForProcessing`) marks an
  event as in-flight without committing it as processed. When a handler
  throws, the lease wrapper records the failure, schedules a retry, and on
  the leader's retry-scanner tick the event is re-published via `pg_notify`.
  After `maxDispatchAttempts` (default 5) the
  event lands in the DLQ (`dlq_at` set, `dlq_reason='exhausted_retries'`)
  and is surfaced via Prometheus (`kici_orch_event_dlq_*`), Grafana
  (`event-delivery` dashboard), and the kici-admin CLI
  (`kici-admin event-dlq {list,count,retry,discard}`).
- **Crash detection:** when a node crashes mid-dispatch, its lease ages out
  after `leaseDurationMs` (default 60 s). The leader's
  `EventRetryScanner` releases the expired lease and re-publishes
  `pg_notify` so a healthy node picks the event up. Each release increments
  `kici_orch_event_lease_expirations_total` — a steady > 0 rate is the
  visible signal that an orchestrator instance is dying mid-dispatch.

### System events

The orchestrator auto-emits system events after execution completes:

- **`workflow_complete`** -- emitted when all jobs in a workflow finish (carries workflow name, status, duration)
- **`job_complete`** -- emitted when a single job finishes (carries workflow name, job name, status, duration)

These events are stored in the same `kici_events` table and matched against `workflowComplete()` and `jobComplete()` triggers in the lock file.

### Event.emit WS protocol

```
Agent                          Orchestrator
  |                                |
  |-- event.emit ----------------->|
  |   { jobId, requestId,         |
  |     eventName, payload,        |
  |     target? }                  |
  |                                |-- store event
  |                                |-- NOTIFY
  |<-- event.emit.response --------|
  |   { requestId, deliveryId? }   |
  |                                |
```

### Registration extraction flow

When code is pushed to the default branch, the orchestrator extracts event-triggered workflows from the lock file and stores them as registrations for cluster-wide event matching.

```
Git Push to Default Branch
==========================

GitHub Webhook -> Platform Relay -> Orchestrator Processor

  Processor (on default-branch push):
    |-- lockFileCache.get() (fetch/cache lock file by blob SHA)
    |-- extractRegisterableWorkflows(fullLockFile)
    |       |-- For each workflow entry in lock file:
    |       |     Check if any trigger type is registerable
    |       |     (kici_event, workflow_complete, job_complete,
    |       |      generic_webhook, schedule, lifecycle)
    |       |-- Return array of registerable workflows
    |
    |-- globalWorkflowPolicy.isWorkflowRepoAllowed() (if policy configured)
    |       |-- Filter out global workflows from repos not on the allow-list
    |
    |-- registrationStore.replaceAll(repoIdentifier, workflows, routingKey, credentials, { commitSha })
    |       |-- BEGIN TRANSACTION
    |       |-- DELETE FROM workflow_registrations WHERE routing_key AND repo_identifier
    |       |-- INSERT new registrations (with commit SHA for lock file pinning)
    |       |-- COMMIT
    |
    |-- registrationStore.bumpVersion()
    |       |-- UPDATE registry_versions SET version = version + 1
    |
    |-- registrationIndex.refreshIfNeeded(newVersion)
    |       |-- If local version != remote version:
    |       |     Load all registrations from DB
    |       |     Rebuild primary index (by customer:repo)
    |       |     Rebuild secondary index (by trigger type)
    |       |     Update local version
    |
    |-- cronScheduler.refreshCache() (defense-in-depth)
    |
    |-- eventRouter.emit('registration.updated', { repo, workflows })
```

### Cron schedule evaluation flow

Cron schedules are evaluated periodically by the Raft leader only.

```
Cron Schedule Evaluation
========================

CronScheduler (runs every 30 seconds, Raft leader only):
  |-- registrationIndex.getCronSchedules()
  |-- For each schedule:
  |     |-- new Cron(cronExpression, { timezone })
  |     |-- cron.previousRuns(1) -> most recent past scheduled time
  |     |-- Check last-fired cache (prevent double-fire)
  |     |-- If due and not recently fired:
  |           |-- BEGIN TRANSACTION
  |           |     |-- cronStore.tryClaimFire(registrationId, previousRun, tx)
  |           |     |     (atomic DB claim — prevents duplicate fires in
  |           |     |      multi-orchestrator clusters via WHERE last_fired_at <
  |           |     |      firedAt guard)
  |           |     |-- If claim successful:
  |           |           |-- eventRouter.emitInTx(__schedule_fire, tx)
  |           |                 |-- EventStore.writeWith(tx) -> INSERT kici_events
  |           |                 |-- pg_notify('kici_event_channel', id) on tx
  |           |-- COMMIT (rollback discards both writes; pg_notify fires on commit)
  |           |-- On commit:
  |                 |-- Update local last-fired cache
  |                 |-- EventRouter matches against registered workflows
  |                 |-- Matched workflows dispatched via standard pipeline
```

Recovery on leader election loads the `cron_last_fired` table into the
last-fired cache and fires once per missed schedule. Because the claim and
the event-row insert now share a transaction, a crash between the two no
longer leaves `last_fired_at` advanced with no event row — the rollback
discards both writes and the next tick fires cleanly.

#### Timing characteristics

- **Tick interval:** Hardcoded at 30 s (`evaluationIntervalMs` defaults to `30_000` in `CronScheduler` and is not exposed via orchestrator config or env vars). Changing it requires a code change.
- **Fire jitter:** A schedule due at time `T` fires at the first tick `>= T`, i.e. `0–30 s` after the scheduled moment, never before. The event payload's `scheduledAt` carries the cron-computed time (not the dispatch time), so downstream consumers see the intended schedule.
- **Per-tick concurrency:** All schedules are processed serially in a single `for` loop on the leader (`packages/orchestrator/src/cron/cron-scheduler.ts`, `evaluate()`). Each registration costs one in-memory cron computation plus two DB writes (`tryClaimFire` upsert + `eventStore.write` + `pg_notify`). Throughput is therefore bounded by sequential DB write latency: at ~5–15 ms per registration, 50 schedules firing in the same tick complete in well under a second between the first and last fire.
- **Recovery semantics:** On leader election, `recoverMissedSchedules()` calls `cron.previousRuns(1)` per schedule -- it fires at most one event per schedule regardless of how long the cluster was leaderless. There is no backfill for multiple missed scheduled instants.
- **Multi-node deduplication:** During cluster startup multiple nodes may transiently self-elect (dormant mode). The atomic `tryClaimFire` upsert with a `last_fired_at < firedAt` `WHERE` guard ensures only one node's emit succeeds; losing nodes update their local cache and skip emit.
- **Sub-minute crons:** Supported but bounded by the 30 s tick. `* * * * *` fires roughly once per minute with up to 30 s of drift; sub-30-second cadences are not achievable without lowering the interval in code.

## Generic webhook flow

Generic webhooks from non-GitHub sources follow a parallel ingestion path. The webhook can arrive directly at the orchestrator or be relayed through the Platform.

```
External Service (ArgoCD, Jenkins, Grafana, etc.)
  |
  v
POST /webhook/:orgId/generic/:sourceId
  |
  +--> Platform path:
  |      |-- Resolve source by routing key generic:<orgId>:<sourceId>
  |      |-- Relay via WebSocket to orchestrator (see internal/platform/data-flows.md)
  |      v
  +--> Orchestrator path (direct or via Platform relay):
         |-- GenericSourceManager.getByOrgAndName(orgId, sourceId)
         |-- Payload size check (per-source maxPayloadBytes)
         |-- Rate limit check (per-source rateLimitRpm)
         |-- Verify signature (HMAC-SHA256, bearer token, IP allowlist, or none)
         |-- Deduplication check (idempotency key within dedup window)
         |-- GenericWebhookNormalizer.normalizeEvent() -> SimulatedEvent
         |-- Match against lock file triggers (genericWebhook type)
         |-- Dispatch matched jobs to agents
```

### Generic vs GitHub webhook differences

| Aspect         | GitHub Webhooks             | Generic Webhooks                                |
| -------------- | --------------------------- | ----------------------------------------------- |
| Signature      | HMAC-SHA256 (always)        | Configurable (HMAC, bearer, IP, none)           |
| Event type     | X-GitHub-Event header       | Configurable header or payload field            |
| Delivery ID    | X-GitHub-Delivery header    | Configurable header or auto-generated UUID      |
| Lock file      | Fetched from repo           | Cached from lock file subscription              |
| Git operations | Clone, fetch, changed files | None (optional -- non-repo workflows supported) |

## Database topology

The orchestrator owns its own PostgreSQL database, with the authoritative `execution_runs`, `execution_jobs`, `execution_steps`, `dispatch_queue`, `dedup_cache`, `workflow_registrations`, `environments` / `scoped_secrets` / `environment_bindings`, `agent_tokens`, `cluster_meta`, and related tables. Each orchestrator deployment uses its own `KICI_DATABASE_URL`; database users are scoped per service.

## Execution reporting flow

After job execution, results flow back through the tiers:

```
Agent                    Orchestrator             Platform              GitHub
  |                          |                     |                  |
  |-- job.status ----------->|                     |                  |
  |   (completed/failed)     |                     |                  |
  |                          |-- execution.status ->|                  |
  |                          |   (run metadata)     |-- upsert        |
  |                          |                      |   execution_runs |
  |                          |-- job.status.forward>|                  |
  |                          |   (job metadata)     |-- upsert        |
  |                          |                      |   execution_jobs |
  |                          |-- GitHub Checks API ---------------------->|
  |                          |   (check run update)  |                  |
  |                          |                      |                  |
```

The orchestrator updates:

1. **GitHub Check Runs** via the Checks API (conclusion, summary, duration)
2. **Execution runs** in the orchestrator's own database (authoritative source)
3. **Platform execution status** via WebSocket (`execution.status` and `job.status.forward` messages, which the Platform upserts into its own projection tables)

## Re-run and cancel flows

The dashboard enables users to re-run completed workflows and cancel running workflows. Both flows use a REST-over-WS proxy pattern: the Platform receives a REST request from the dashboard, forwards it to the orchestrator via WebSocket, and returns the orchestrator's response.

### Re-run flow

```
Dashboard                    Platform                         Orchestrator
    |                          |                              |
    |-- POST /orgs/:id/runs/  ->|                              |
    |   :runId/rerun (auth)    |-- Cooldown check             |
    |                          |   (last_rerun_at < 5s ago?)  |
    |                          |                              |
    |                          |-- run.rerun.request (WS) --->|
    |                          |   { runId, triggeredBy }     |
    |                          |                              |-- Load original run from DB
    |                          |                              |-- Read webhook payload from storage
    |                          |                              |-- Re-fetch lock file at original SHA
    |                          |                              |-- Dispatch new jobs via Dispatcher
    |                          |                              |-- Record execution with parent_run_id + original_run_id
    |                          |                              |-- execution.status (WS, via callback)
    |                          |                              |   { parentRunId, originalRunId, triggeredBy }
    |                          |<- run.rerun.response (WS) ---|
    |                          |   { newRunId }               |
    |                          |                              |
    |<- 200 { newRunId } ------|                              |
    |                          |-- UPDATE last_rerun_at       |
    |-- Navigate to new run    |                              |
    |                          |                              |
```

Key design points:

- **Cooldown enforcement:** The Platform enforces a 5-second cooldown per original run via the `last_rerun_at` column. Rapid re-run attempts receive 429 Too Many Requests.
- **Payload reuse:** The orchestrator reads the original webhook payload from filesystem/object storage and stores a copy for the new run (enabling re-run of re-runs).
- **Lock file at original SHA:** The lock file is re-fetched at the original commit SHA, ensuring the re-run uses the same workflow definition.
- **Lineage tracking:** The new run has `parent_run_id` pointing to the immediate parent run, `original_run_id` pointing to the root ancestor run (for chain traversal), and `triggered_by` recording the user identity.
- **No trigger matching:** Re-runs skip deduplication, normalization, and trigger matching. They go directly from lock file parse to job dispatch.

### Cancel flow

```
Dashboard                    Platform                         Orchestrator          Agent(s)
    |                          |                              |                    |
    |-- POST /orgs/:id/runs/ ->|                              |                    |
    |   :runId/cancel (auth)   |                              |                    |
    |                          |-- run.cancel.request (WS) -->|                    |
    |                          |   { runId, cancelledBy }     |                    |
    |                          |                              |-- Find active jobs  |
    |                          |                              |   from dispatch queue
    |                          |                              |-- job.cancel (WS) ->|
    |                          |                              |   (for each agent)  |-- Abort step
    |                          |                              |                    |-- Cleanup
    |                          |<- run.cancel.response (WS) --|                    |
    |                          |   { cancelledJobs: N }       |                    |
    |                          |                              |<- job.status -------|
    |<- 200 { cancelledJobs } -|                              |   (cancelled)      |
    |                          |-- UPDATE cancelled_by        |                    |
    |                          |                              |                    |
```

The cancel flow is asynchronous: the orchestrator sends `job.cancel` to agents and immediately responds with the count. Agents asynchronously abort their current step, clean up, and report `job.status: cancelled` back to the orchestrator.

### Payload storage flow

Webhook payloads are stored during initial processing and retrieved later for re-runs and the payload viewer.

```
Webhook arrives                          Payload retrieved
    |                                        |
    v                                        v
processWebhook()                     GET /orgs/:id/runs/:runId/payload
    |                                        |
    v                                        v
logStorage.append(                   Platform -> dashboard.payload (WS)
  executions/{runId}/                        |
  webhook-payload.json,                      v
  JSON.stringify(payload)            Orchestrator -> logStorage.read(
)                                      executions/{runId}/
    |                                  webhook-payload.json
    v                                )
Filesystem or object storage               |
                                           v
                                    dashboard.payload.response (WS)
                                      { payload: {...} }
```

### Event-log payload streaming flow

The dashboard's event-log detail panel reads webhook bodies through a chunked transport so the dashboard can render progress as bytes arrive. The orchestrator slices the payload into 64 KiB chunks and streams them up to the browser.

### Lineage query

The lineage endpoint (`GET /orgs/:customerId/runs/:runId/reruns`) returns all runs with `parent_run_id` matching the given run ID.

## Trace ID propagation

Every webhook event is assigned a trace ID (`requestId`) at ingestion. A second ID (`runId`) is added at dispatch time. Both propagate through the three tiers via WebSocket protocol messages and are automatically injected into every log line using AsyncLocalStorage.

```
GitHub         Platform                  Orchestrator              Agent
  |              |                        |                       |
  |-- webhook -->|                        |                       |
  |              |-- generate requestId   |                       |
  |              |-- requestContext.run()  |                       |
  |              |   (requestId)          |                       |
  |              |                        |                       |
  |              |-- webhook.relay (WS) ->|                       |
  |              |   { ..., requestId }   |                       |
  |              |                        |-- requestContext.run() |
  |              |                        |   (requestId)         |
  |              |                        |                       |
  |              |                        |-- generate runId      |
  |              |                        |-- enrichRequestContext |
  |              |                        |   ({ runId })         |
  |              |                        |                       |
  |              |                        |-- job.dispatch (WS) ->|
  |              |                        |   { ..., requestId }  |
  |              |                        |                       |-- requestContext.run()
  |              |                        |                       |   (requestId, runId,
  |              |                        |                       |    jobId)
  |              |                        |                       |
  |              |                        |                       |-- log: "Run: X | Trace: Y"
  |              |                        |                       |-- execute steps
  |              |                        |                       |
```

### How it works

1. **Platform ingestion:** The webhook handler generates a `requestId` (UUID) and wraps the entire request in `requestContext.run()`. All log lines within this async scope automatically include `requestId`.

2. **WebSocket relay:** The `requestId` is included in the `webhook.relay` message sent to the orchestrator. For cross-instance relay (via Valkey pub/sub), the `requestId` is serialized in the notification payload.

3. **Orchestrator processing:** The orchestrator wraps webhook processing in `requestContext.run()` using the `requestId` from the relay message (falling back to a new UUID for backward compatibility). When a `runId` is generated for job dispatch, it is enriched into the existing context via `enrichRequestContext()`.

4. **Job dispatch:** Both `requestId` and `runId` are included in the `job.dispatch` WebSocket message to the agent.

5. **Agent execution:** The agent wraps each `onJobDispatch` callback in `requestContext.run()` with `requestId`, `runId`, and `jobId`. A trace header is printed once at job start. All subsequent log lines carry all trace fields automatically.

6. **Check run summaries:** GitHub Check Run updates include `Trace: <requestId> | Run: <runId>` in the summary text, giving operators a direct link from GitHub UI to Loki queries.

### Implementation

Trace propagation uses Node.js `AsyncLocalStorage` from `@kici-dev/shared`. A logger format reads the current context and injects fields into every JSON log line -- no changes needed at individual call sites.

Tier identification is handled at the infrastructure level: the `service` Loki label (set by Grafana Alloy from the systemd unit / log source) identifies which service produced the log (`platform`, `orchestrator`, `agent`, etc.). For agent logs forwarded through the orchestrator's stdout, the parsed JSON also carries an inner `service: 'agent'` field — query both with `{service="orchestrator"} | json | service="agent"` to disambiguate.

## Output chaining data flow

Output chaining allows steps to consume outputs from preceding steps (within a job) and jobs to consume outputs from preceding jobs (across jobs). The data flows through several phases.

### Definition time

When workflow code runs at definition time (`step()`, `job()` calls):

- `step()` creates an `OutputProxy<T>` via `createStepOutputProxy(stepName)` and attaches it as `.result`
- `job()` creates an `OutputProxy<any>` via `createJobOutputProxy(jobName)` and attaches it as `.result`
- The proxy is an ES6 `Proxy` object that defers all property access to a module-global `OutputsMap`
- No outputs exist yet -- accessing `.result.field` before execution throws "has not produced outputs yet"

### Compile time

The compiler processes the workflow definition:

- Unnamed steps (bare functions and id-less `step()` calls) receive counter IDs: `step-1`, `step-2`, etc.
- Unnamed jobs (id-less `job()` calls with UUID names) receive counter IDs: `job-1`, `job-2`, etc.
- The lock file records `hasOutputs: true` for steps with Zod output schemas
- Step counters are scoped per job; job counters are scoped per workflow

### Execution time (local test runner)

When `kici test` runs a workflow:

1. **SDK module resolution:** The runner resolves `setStepOutputsMap` / `setJobOutputsMap` from the same `@kici-dev/sdk` module instance that the workflow uses (ensures the proxy reads from the same map)
2. **Map injection:** Fresh `OutputsMap` and `StepRefMap` are created and injected via `setStepOutputsMap()` / `setStepRefMap()` before each job
3. **Step execution:** Each step runs sequentially. If the step returns a value, it is stored in the `OutputsMap` keyed by step name
4. **Bare function normalization:** Bare functions in the steps array are assigned counter names and registered in the `StepRefMap` (maps function reference to step name)
5. **Proxy resolution:** When a subsequent step accesses `stepRef.result.field`, the proxy reads from the `OutputsMap`
6. **ctx.outputsOf():** Resolves step outputs by reference (Step object or bare function). For bare functions, looks up the step name in the `StepRefMap`

### Cross-job output aggregation

After each job completes in the local test runner:

1. Step outputs from the completed job are aggregated into the `jobOutputsMap`
2. **Multi-step jobs:** Outputs are nested under step names: `{ stepName: { field: value }, ... }`
3. **Single-step jobs (run shorthand):** Outputs are flattened directly: `{ field: value }` (no step-name nesting)
4. The `jobOutputsMap` is injected via `setJobOutputsMap()`, enabling `jobRef.result.stepName.field` or `jobRef.result.field` access

### IPC transport (agent sandbox)

In the agent sandbox (remote pipeline execution):

1. Step return values are captured and included in `step.complete` IPC messages (optional `outputs` field)
2. The agent aggregates step outputs and includes them in the `job.complete` IPC message
3. **Within-job chaining:** The sandbox populates the `OutputsMap` as steps complete, so `.result` and `ctx.outputsOf()` resolve correctly within a single job
4. **Cross-job chaining:** The orchestrator collects plain outputs from completed upstream jobs at dispatch time (querying the DB for jobs listed in `needs`), then passes them as `upstreamJobOutputs` in the `job.dispatch` message. The sandbox receives this map and populates the `jobOutputsMap` via `setJobOutputsMap()`, enabling `ctx.jobOutputs()` and `jobRef.result` access across job boundaries. Secret outputs follow a separate encrypted path via `SecretOutputStore`.

#### Within-job output flow

```
Step A completes          Step B accesses A.result
    |                          |
    v                          v
Return value             Proxy.get('field')
    |                          |
    v                          v
OutputsMap.set('A', val)  OutputsMap.get('A')
    |                          |
    v                          v
Stored in shared map     Returns val.field
```

#### Cross-job output flow

```
Job A completes               Orchestrator dispatches Job B
    |                              |
    v                              v
Outputs stored in DB          Query upstream job outputs (needs)
                                   |
                                   v
                              job.dispatch includes upstreamJobOutputs
                                   |
                                   v
                              Sandbox populates jobOutputsMap
                                   |
                                   v
                              ctx.jobOutputs('A') resolves
```

## Browser protocol (Platform to dashboard)

The Platform tier exposes a `/ws/browser` WebSocket endpoint for dashboard clients (auth, log subscription / streaming / gaps, run / job / step status updates, `run.event` / `job.context` for the Summary tab).

## See also

- [Architecture overview](overview.md) -- three-tier model and component responsibilities
- [Protocol messages](protocol-messages.md) -- WebSocket message schemas
- [Event system internals](./webhooks/event-system.md) -- event router, registration model, cron scheduler
- [State machine](./execution/state-machine.md) -- job execution state transitions
- [Webhook delivery](./webhooks/webhook-delivery.md) -- detailed webhook processing pipeline
- [Operator: dependency caching](../operator/dependency-caching.md) -- configuration guide
- [Operator: monitoring & tracing](../operator/observability/monitoring.md) -- trace fields and Loki queries
- [Operator: event routing & generic webhooks](../operator/event-routing.md) -- generic source setup and trust management
- [SDK reference: output chaining](../user/sdk/core.md#output-chaining) -- user-facing output chaining API
