---
title: Needs-aware dispatch scheduler
description: ''
---

## Overview

The needs-aware dispatch scheduler is a DB-backed module that gates job dispatch on upstream completion. `needs` is a hard dispatch gate: a job only dispatches when every upstream in its `needs` array reaches a terminal state. This applies to all edge types:

- **Static-to-static**: `job('test', { needs: ['lint'] })`
- **Static-to-dynamic-group**: `job('deploy', { needs: [dynamicGroup('tests')] })`
- **Dynamic-to-static**: generated jobs with `needs: ['lint']`
- **Dynamic-to-dynamic**: generated jobs referencing other generated jobs

## Dispatch behavior

- Jobs without `needs` (root jobs) dispatch immediately.
- Jobs with `needs` wait until all upstreams reach terminal state.
- `upstreamJobOutputs` is a guaranteed-fresh read at dispatch time — upstreams are always complete before the downstream is dispatched.

## Schema

The squashed baseline migration `001_initial` provides:

### Columns on `execution_jobs`

| Column            | Type                             | Description                                                          |
| ----------------- | -------------------------------- | -------------------------------------------------------------------- |
| `needs_satisfied` | `BOOLEAN NOT NULL DEFAULT false` | True when all upstream edges are terminal-success (or policy allows) |
| `ready_at`        | `TIMESTAMPTZ`                    | When `needs_satisfied` first flipped to true                         |
| `group_name`      | `TEXT`                           | Dynamic group membership tag (NULL for static jobs)                  |

### Edge table: `execution_job_needs`

| Column          | Type                                  | Description                                                                         |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `run_id`        | `UUID NOT NULL`                       | Execution run ID                                                                    |
| `job_name`      | `TEXT NOT NULL`                       | Downstream job name                                                                 |
| `upstream_name` | `TEXT NOT NULL`                       | Upstream job name                                                                   |
| `run_on`        | `TEXT NOT NULL DEFAULT '["success"]'` | Per-edge run-on set: JSON array of upstream terminal statuses that satisfy the edge |

Primary key: `(run_id, job_name, upstream_name)`

Indexes:

- Partial index on `execution_jobs(run_id, needs_satisfied) WHERE needs_satisfied = false`
- `execution_job_needs(run_id, upstream_name)` for downstream lookups
- `execution_job_needs(run_id, job_name)` for upstream lookups

## Algorithm

The scheduler is event-driven from `onJobStatus(terminal)`. No polling, no LISTEN/NOTIFY.

### Core flow: `evaluateDownstreams`

```
onJobStatus(runId, jobName, terminal_state)
  -> find downstream edges in execution_job_needs WHERE upstream_name = jobName
  -> for each downstream:
     if upstream's terminal status NOT IN edge.run_on:
       return { action: 'skip', reason: 'upstream_unmet: <name> (<status>)' }
     else:
       check ALL upstreams of this downstream (not just the one that triggered)
       if all terminal and every status is in its edge's run_on:
         SET needs_satisfied = true, ready_at = NOW()
         return { action: 'dispatch' }
       else:
         skip (not all upstreams ready yet)
```

When a downstream is skipped due to failure propagation, the skip itself triggers `onJobStatus` recursively, cascading through the DAG. The DAG is acyclic (validated at compile time and eval time), so recursion terminates naturally.

### Edge insertion

Edges are inserted at two points:

1. **Run start** (`insertEdgesForRun`): static-to-static edges from the lock file's `needs` arrays. Root jobs (no needs, no `dependsOnGroups`) are marked `needs_satisfied = true` immediately.

2. **Dynamic eval completion** (`resolveGroupEdges`): when the eval agent reports generated jobs, the processor:
   - Sets `group_name` on generated job rows
   - For each static job with `dependsOnGroups` containing the group, inserts one concrete edge per group member
   - Inserts dyn-to-static edges for generated jobs referencing static jobs
   - Recomputes `needs_satisfied` for affected jobs

### Group resolution

Group resolution happens once, at dynamic eval completion. Before resolution, static jobs with `dependsOnGroups` start with `needs_satisfied = false` and no concrete edges. The scheduler's "ready?" query never fires them because they have unresolved dependencies.

After resolution, the scheduler only sees concrete name-to-name edges -- no group awareness in the hot path.

### Empty group semantics

If a `dynamicJob()` returns `[]`, zero edges are inserted. The static downstream's `recomputeNeedsSatisfied` finds zero edges, which evaluates to "all upstreams satisfied" (empty AND = true). The downstream dispatches immediately.

## Failure propagation

Default behavior: each edge's `run_on` set defaults to `["success"]`, so when an upstream reaches a non-success terminal status (`failed`, `drift_dropped`, `cancelled`, `skipped`, `timed_out_stale`), the downstream transitions to `skipped`.

Per-edge override: a wider `run_on` set (authored via the SDK `when` keyword, e.g. `'always'`, `'on-skip'`, `'on-failure'`, or a raw status array) allows dispatch on the listed upstream statuses. Use `'always'` for cleanup or notification jobs, `'on-failure'` for error-handler jobs.

The keyword → `run_on` mapping is:

| `when`       | `run_on` set                    |
| ------------ | ------------------------------- |
| `on-success` | `["success"]`                   |
| `always`     | every terminal status           |
| `on-skip`    | `["success", "skipped"]`        |
| `on-failure` | `["failed", "timed_out_stale"]` |

`getFailurePropagationTargets` performs a BFS traversal following edges whose `run_on` set does **not** admit the propagating upstream's terminal status, finding all transitive downstreams that should be skipped.

## Cycle detection

Three-layer defense in depth:

1. **Layer 1 (compile-time, best-effort)**: `validateJobDag` creates synthetic `__group:` nodes for dynamic groups and runs topological sort. Catches cycles visible at compile time.

2. **Layer 2 (eval-time, authoritative)**: after the DynamicJobFn runs and concrete generated names are known, a full topological sort (Kahn's algorithm) runs on the fully-resolved graph. Rejects the run if a cycle is detected.

3. **Layer 3 (scheduler-time, defensive invariant)**: `checkSchedulerInvariant` detects stuck jobs -- pending with `needs_satisfied = false` whose ALL upstreams are terminal. This should never happen in a correct graph; it's a backstop against internal bugs.

## Drift handling

When the executing agent's re-evaluation drops a generated job (determinism drift), the `drift_dropped` terminal state triggers normal failure propagation. Downstream jobs waiting on the dropped job are skipped.

Detection flows through the IPC pipeline: `workflow-runner.ts` -> `fork-runner.ts` -> `job-runner.ts` -> WS `job.status` with `droppedJobs` field -> execution tracker transitions to `drift_dropped`.

## Recovery

The scheduler is fully DB-backed. On orchestrator restart:

- All state is in `execution_jobs` and `execution_job_needs`
- `recomputeNeedsSatisfied` runs for pending jobs in non-terminal runs
- Newly-ready jobs are dispatched via the `onJobReady` callback

No in-memory state, no recovery code beyond the DB queries.

## Cluster path

In the cluster coordinator path, the coordinator subscribes to peer `onJobStatus` messages via `onPeerJobComplete`. These are forwarded to the local execution tracker, which fires the same scheduler hook. The scheduler works identically regardless of whether the upstream job completed locally or on a peer.

## Source

| Component                | Source                                                                     |
| ------------------------ | -------------------------------------------------------------------------- |
| Scheduler module         | `packages/orchestrator/src/pipeline/needs-scheduler.ts`                    |
| Execution tracker hook   | `packages/orchestrator/src/reporting/execution-tracker.ts`                 |
| Migration                | Squashed into `packages/orchestrator/src/db/migrations/001_initial.ts`     |
| Edge insertion (static)  | `packages/orchestrator/src/pipeline/processor.ts` (insertEdgesForRun call) |
| Edge insertion (dynamic) | `packages/orchestrator/src/pipeline/processor.ts` (resolveGroupEdges call) |
| Dispatch callback        | `packages/orchestrator/src/pipeline/processor.ts` (dispatchReadyJob)       |
