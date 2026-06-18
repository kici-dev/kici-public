---
title: Stale run detection architecture
description: Architecture deep-dive into KiCI's two-tier stale detection and failure marking system
---

This document describes the architecture of KiCI's stale run detection system, which automatically detects and marks CI jobs that have stopped responding.

## Two-tier model

KiCI uses a two-tier detection model that covers both agent-level and orchestrator-level failures:

```
Tier 1 (Orchestrator):
  Agent --job.heartbeat (60s)--> Orchestrator WS handler
                                      |
                                      v
                              execution_jobs.last_heartbeat_at
                                      |
                              StaleRunDetector --scan (60s)--> DB
                                      |
                                      v
                              Mark timed_out_stale + GitHub check run + force-terminate

Tier 2 (Upstream):
  Orchestrator --WS connection--> KiCI
                                    |
                              WS disconnect event
                                    |
                                    v
                              Stale-orch detector --scan after threshold
                                    |
                                    v
                              Mark execution_runs timed_out_stale
```

### Why two tiers

A single detection tier cannot cover all failure modes:

- **Agent dies**: The orchestrator detects this via missing heartbeats (Tier 1).
- **Orchestrator dies**: Only the upstream tier can detect this because it holds the WS connection (Tier 2).
- **Network partition**: Depending on which side of the partition, either tier may detect the failure.

## Heartbeat flow

### Agent side

The agent sends a `job.heartbeat` message every 60 seconds (configurable via `KICI_JOB_HEARTBEAT_INTERVAL_MS`) for each running job. The heartbeat timer starts when the job enters the `running` state and is cleaned up in a `finally` block to handle all exit paths (success, failure, cancellation).

Heartbeats use the buffered `send()` path (not `sendDirect()`) so they queue during temporary orchestrator disconnects and flush on reconnect.

The `job.heartbeat` schema is lightweight (no `messageId`):

```typescript
{
  type: 'job.heartbeat',
  runId: string,
  jobId: string,
  timestamp: number
}
```

### Orchestrator side

The orchestrator handles `job.heartbeat` messages in the agent WS handler and calls `executionTracker.updateJobHeartbeat()`, which updates `execution_jobs.last_heartbeat_at` with an optimistic `WHERE status='running'` clause (completed jobs are safely skipped).

An **initial `last_heartbeat_at`** is set when the job enters the `running` state via `onJobStatus()`. This ensures newly-running jobs have a heartbeat timestamp before the first periodic heartbeat arrives (60 seconds later).

### Separate from WS heartbeat

The per-job heartbeat (60s) is separate from the WebSocket-level heartbeat (30s). The WS heartbeat monitors connection-level health (handled by `AgentHeartbeatMonitor`), while the job heartbeat monitors job-level liveness (handled by `StaleRunDetector`).

## Detection flow

`StaleRunDetector` runs a periodic scan at a configurable interval (default 60s). Each scan consists of three sub-scans (A, B, C) followed by two post-scan steps (E, D):

### Sub-scan A: stale running jobs (heartbeat present)

```sql
SELECT ej.*, er.workflow_name, er.repo_identifier, er.sha, er.provider, er.provider_context
FROM execution_jobs ej
INNER JOIN execution_runs er ON er.run_id = ej.run_id
WHERE ej.status = 'running'
  AND ej.last_heartbeat_at IS NOT NULL
  AND ej.last_heartbeat_at < :threshold
```

Finds running jobs where the last heartbeat is older than the stale threshold (default: 2 minutes).

### Sub-scan B: stale running jobs (NULL heartbeat)

```sql
WHERE ej.status = 'running'
  AND ej.last_heartbeat_at IS NULL
  AND ej.created_at < :threshold
```

Catches jobs that started before the heartbeat system existed, or where the initial heartbeat was never set. Falls back to `created_at` as the staleness indicator.

### Sub-scan C: stale dispatched queue entries

```sql
SELECT id, run_id, job_name FROM dispatch_queue
WHERE status = 'dispatched'
  AND created_at < :threshold
```

Detects jobs that were dispatched to an agent but never acknowledged (agent died after dispatch, before starting execution). Both the `dispatch_queue` entry and the corresponding `execution_jobs` row are marked as failed/timed_out_stale, ensuring `dispatch_queue` failures propagate to the execution tables.

### Post-scan E: held run expiry

If a `HeldRunStore` is configured, calls `heldRunStore.expireOverdue()` to cancel held jobs whose hold expiry deadline has passed. This is a separate concern from heartbeat-based staleness -- held runs are waiting for reviewer approval, not executing.

### Post-scan D: batch run completion

After all sub-scans and held run expiry, collects the unique `runId` values of all affected jobs and calls `completeRunIfAllJobsTerminal()` for each. This checks if all jobs in the run have reached terminal state and, if so, updates the `execution_runs` row.

## Status model

### timed_out_stale as distinct DB status

`timed_out_stale` is stored as a distinct value in `execution_jobs.status`, not just as an `error_message` on a `failed` row. This design enables:

- **Direct querying**: `WHERE status = 'timed_out_stale'` without parsing error messages.
- **Separate metrics**: Stale timeouts counted independently from regular failures.
- **GitHub distinction**: Maps to `timed_out` conclusion (not `failure`).

### Relationship to engine state machine

The engine's 11-state `ExecutionState` type (the pure-function state machine) is **not modified**. `timed_out_stale` is included in the engine's `ExecutionJobStatus` Zod enum and `TERMINAL_JOB_STATES` set (defined in `packages/engine/src/protocol/messages/execution-status.ts`), so it's recognized as a terminal state for run completion logic across all tiers.

### Overall run status

`timed_out_stale` is treated as `failed` when computing overall run status:

- Any `timed_out_stale` job -> run status is `failed`
- `failed` takes precedence over `cancelled`

## Failure flow

When a stale job is detected:

1. **Optimistic UPDATE**: `SET status='timed_out_stale' WHERE status='running'`
2. **Log warning**: Includes runId, jobId, agentId, staleDurationMs
3. **Metric increment**: `staleRunsDetectedTotal` and `staleDetectionDurationSeconds`
4. **In-memory sync**: `executionTracker.updateInMemoryJob()` (no redundant DB write)
5. **Forward terminal status to Platform**: `executionTracker.forwardJobTerminalStatus()` keeps the Platform execution_jobs projection in sync
6. **Emit infrastructure event**: `executionTracker.emitInfraEvent()` with `orchestrator.job.stale_detected` for the dashboard timeline
7. **Cancel in-progress steps**: `executionTracker.cancelStepsForJob()` removes stale running indicators from the dashboard
8. **Check run update**: `checkRunReporter.updateJobStatus()` with `timed_out` conclusion
9. **Force-terminate agent**: `scalerManager.onAgentDisconnected()` + `dispatcher.onAgentDisconnect()`
10. **Run completion check**: `completeRunIfAllJobsTerminal()` for each affected run (batched)

## Crash recovery

On orchestrator startup, `StaleRunDetector.start()` runs an **immediate scan** before starting the periodic interval. This catches any jobs that became stale while the orchestrator was down.

### DB-Fallback in completeRunIfAllJobsTerminal

`completeRunIfAllJobsTerminal()` has two code paths:

- **Path A (normal)**: In-memory `RunState` Map available. Checks `isRunComplete()`, computes status from in-memory job states, updates DB, fires callback.
- **Path B (crash recovery)**: In-memory Map is empty (post-restart). Queries `execution_jobs` from DB, checks if all are terminal, computes status from DB rows, updates `execution_runs`, fires callback.

Path B is critical for crash recovery: after a restart, in-memory state is empty, but the DB contains jobs that were marked `timed_out_stale` by the immediate startup scan. Without Path B, `execution_runs.status` would never be updated from `running` to `failed`.

## Dispatch queue propagation

When a stale dispatch queue entry is found:

1. `dispatch_queue.status` -> `failed`
2. `execution_jobs.status` -> `timed_out_stale` (for the matching run_id + job_name)
3. `executionTracker.updateInMemoryJob()` keeps in-memory state consistent
4. The affected run_id is added to the batch completion check

This guarantees a failed dispatch queue entry never leaves the corresponding `execution_jobs` row in a non-terminal state.

## Queue timeout expiry

Jobs waiting in the dispatch queue are subject to a configurable timeout (`queue.timeoutMs`, default 1 hour). The cleanup scheduler runs every 60 minutes and calls `JobQueue.markExpired()`, which:

1. SELECTs pending jobs with `expires_at < now()`
2. UPDATEs those rows to `expired` status
3. Returns `ExpiredJobInfo[]` (id, runId, jobName)

The cleanup function then follows the same pattern as the stale run detector:

1. Updates `execution_jobs.status` to `timed_out_stale` with error message `"Queue timeout expired (job was never dispatched to an agent)"`
2. Calls `executionTracker.updateInMemoryJob()` and `forwardJobTerminalStatus()`
3. Emits `orchestrator.job.queue_expired` infrastructure event
4. Checks run completion via `completeRunIfAllJobsTerminal()`

The `forwardJobTerminalStatus()` call sends a `job.status.forward` message upstream, keeping the dashboard's view of `execution_jobs` in sync.

The orchestrator also reports its `queue.timeoutMs` in the `source.register` protocol message so the upstream tier can run a safety-net GC of stale queued jobs.

## Race conditions

### Optimistic concurrency

The primary race condition is between the stale detector and a late-arriving agent completion:

```sql
UPDATE execution_jobs SET status='timed_out_stale'
WHERE run_id=:runId AND job_id=:jobId AND status='running'
```

If the agent completes the job between the SELECT and UPDATE, the `WHERE status='running'` clause prevents overwriting the legitimate completion. The stale detector checks `numUpdatedRows` and skips further processing if 0 (the job was already completed).

### No redundant writes

`StaleRunDetector` does **not** call `executionTracker.onJobStatus()` because that method writes to the DB (status, timestamps, etc.), which would be redundant with the detector's own UPDATE. Instead, it calls `updateInMemoryJob()` (in-memory only) and `completeRunIfAllJobsTerminal()` (handles run completion separately).

## Workflow timeout = orchestrator run deadline

A workflow-level `timeout` (see [Timeouts](../../user/sdk/core.md#timeouts)) caps the **whole run's** wall-clock across all jobs. Because a run's jobs can span multiple agents, this cap cannot be enforced agent-side — it is a run-level deadline owned by the orchestrator, enforced by a periodic scanner modeled on the stale-run detector.

- **Persisted at run creation.** When a run starts, the orchestrator reads the workflow's `timeout` from the lock file and persists it as `execution_runs.workflow_timeout_ms`. A run with no workflow timeout has a null column and is never deadline-enforced.
- **Periodic deadline scan.** A `WorkflowDeadlineDetector` runs on the same interval as the stale-run detector. Each scan finds non-terminal runs (`pending` / `running` / `cancelling`) with a non-null `workflow_timeout_ms` whose `started_at + workflow_timeout_ms` is in the past, time-bounded to the last 24 hours to avoid re-scanning ancient history.
- **Canonical cancel with a distinct reason.** Each overdue run is driven through the same run-cancellation path that a user-initiated `kici runs cancel` uses: queued dispatch rows are cancelled, `job.cancel` is sent to the agents running the run's jobs, and the run's failure reason is stamped with the distinct `workflow_timeout` reason so the dashboard labels the run "timed out" rather than a generic cancel. The run reaches `cancelled`.
- **Crash recovery.** Like the stale-run detector, the deadline detector runs an immediate scan on startup, catching runs that blew their deadline while the orchestrator was down.

This complements the **job-level** timeout, which is agent-enforced: the agent arms a job wall-clock deadline in the forked workflow runner and, on breach, aborts the job and reports it `failed` with the distinct `job_timeout` reason. Job and workflow timeouts are independent caps — each enforces only its own scope.
