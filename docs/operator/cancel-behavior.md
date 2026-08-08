---
title: Cancel behavior
description: Grace period, hook timeout, force cancel, and monitoring stuck cancelling jobs
---

This document describes the operator-facing configuration and monitoring aspects of KiCI's cancel system.

## Grace period

The grace period is the time between sending SIGTERM and sending SIGKILL to a running step when a job is cancelled.

| Setting                | Default | Scope     | Description                                   |
| ---------------------- | ------- | --------- | --------------------------------------------- |
| SDK `gracePeriod`      | 30s     | Per-job   | Set by workflow authors in the SDK (optional) |
| Agent max grace period | 30s     | Per-agent | Hardcoded upper bound (fork-based backends)   |

The agent enforces the lower of the two values. If a workflow author sets `gracePeriod: 60` but the agent max is 30, the effective grace period is 30 seconds.

### SDK configuration

Workflow authors set the grace period per-job:

```typescript
job('deploy', {
  runsOn: 'linux',
  gracePeriod: 60, // seconds
  steps: [/* ... */],
});
```

### Agent configuration

The maximum grace period depends on the scaler backend:

| Backend                              | Max grace period | Configurable |
| ------------------------------------ | ---------------- | ------------ |
| Fork-based (bare-metal, Firecracker) | 30s              | No           |
| Container (Docker/Podman)            | 10s              | No           |

Both values are hardcoded. The effective grace period for a job is `Math.min(jobGracePeriod, backendMaxGracePeriod)`.

## Hook timeout

After the step exits (via SIGTERM/SIGKILL or normal completion), lifecycle hooks run. Each hook has a timeout:

| Setting       | Default   | Scope    | Description                                |
| ------------- | --------- | -------- | ------------------------------------------ |
| Hook timeout  | 5 minutes | Per-hook | Maximum time for a single hook to complete |
| SDK `timeout` | 5 min     | Per-hook | Set by workflow authors in the SDK         |

Workflow authors can customize per-hook:

```typescript
cleanup: {
  run: async (ctx) => { /* ... */ },
  timeout: 10 * 60 * 1000, // 10 minutes in ms
},
```

## Total cancel time

The maximum time a cancel operation can take is:

```
total_cancel_time = gracePeriod + hookTimeout
```

With defaults: 30s + 5min = 5 minutes 30 seconds maximum.

Operators should account for this when setting stale detection timeouts. A job in `cancelling` state for longer than `total_cancel_time` is stuck.

## Force cancel

Force cancel bypasses the grace period and all hooks:

1. SIGKILL sent immediately to the running step process
2. All hooks (onCancel, cleanup, onSuccess, onFailure) are skipped
3. If hooks are currently running (during a graceful cancel), they are killed via SIGKILL
4. The job transitions directly to `cancelled`

Force cancel is available through:

- **Dashboard**: click the "Force cancel" button (appears after initial graceful cancel)
- **CLI**: `kici runs cancel <runId> --force` or second Ctrl+C during interactive mode
- **Orchestrator admin API**: `POST /api/v1/admin/runs/:runId/cancel { "force": true }`, authenticated with an admin Bearer token and gated by the `run.cancel` permission. Every attempt -- allowed, denied, or errored -- is written to the access log.

### When to use force cancel

- Step is stuck in a blocking syscall that ignores SIGTERM
- Hook is stuck (e.g., network timeout during cleanup)
- Need immediate termination regardless of cleanup

## Monitoring stuck cancelling jobs

A job in `cancelling` state beyond `total_cancel_time` indicates a problem.

### Detection

Query for jobs stuck in cancelling state:

```sql
SELECT j.job_id, j.run_id, j.status, j.updated_at,
       EXTRACT(EPOCH FROM (NOW() - j.updated_at)) AS stuck_seconds
FROM execution_jobs j
WHERE j.status = 'cancelling'
  AND j.updated_at < NOW() - INTERVAL '10 minutes'
ORDER BY j.updated_at;
```

### Common causes

| Cause                            | Symptom                   | Resolution                                  |
| -------------------------------- | ------------------------- | ------------------------------------------- |
| Agent disconnected during cancel | No status update          | Stale detection will time out the job       |
| Hook infinite loop               | Hook running forever      | Force cancel via `kici runs cancel --force` |
| Process ignoring SIGTERM         | Step not exiting          | Wait for grace period expiry (SIGKILL)      |
| Network partition                | Agent can't report status | Reconnection or stale timeout               |

### Resolution

1. First, try force cancel via the CLI: `kici runs cancel <runId> --force` (or the equivalent HTTP call `POST /api/v1/admin/runs/:runId/cancel { "force": true }`)
2. If the agent is disconnected, the stale run detection system will mark the job as `timed_out_stale`
3. Check agent logs for errors during the cancel sequence

## Firecracker VMs

Firecracker VM-based jobs handle cancellation the same way as container and bare-metal jobs. The agent runs inside the VM and handles the SIGTERM/SIGKILL/hooks sequence. There is no special VM-level shutdown handling -- the VM is destroyed after the agent reports the final job status.

## Cancel permissions

Cancelling a run requires the `runs:write` permission. Organization owners hold it by default; plain members default to `runs:read` and cannot cancel until they are granted a role that raises `runs` to `write` or higher. Cancelling is non-destructive -- it doesn't modify code or configuration -- but it does stop work other people may be waiting on, so it sits on the write side of the permission split.

The `cancelled_by` field on the run record stores the user ID of who initiated the cancel. The dashboard shows "Cancelled by @username" on the run detail page.

## Queued run cancellation

Queued runs (waiting in a concurrency group) can be cancelled before they start executing. Since no step is running, the cancel is immediate:

- No grace period
- No hooks execute (no step context to run them in)
- The run transitions directly to `cancelled`
- The queue slot is freed for the next waiting run

## Cancelling a run that already finished

A run that has reached `success`, `failed`, or `cancelled` is finished, and its
recorded result is a historical record. Cancelling such a run is a **no-op**:
nothing is written, so the run keeps its status, its completion time, its
attribution, and its recorded jobs and step logs.

This matters because a cancel can arrive moments after a run finishes — a
dashboard click on a run that completed while the page was open, a scripted
cancel racing the last job, a scheduled cleanup sweep. Without the no-op, that
late cancel would overwrite the finished result with `cancelled`.

Each surface reports the no-op in its own convention:

| Surface                                                | Response                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Operator API (`POST /api/v1/admin/runs/:runId/cancel`) | `409` with `{ "error": "Run already in terminal state", "status": "<status>" }` |
| Dashboard / `kici runs cancel`                         | `409` with `{ "error": "Run is already <status>" }`                             |
| MCP `cancel_run` tool                                  | Success with `cancelledJobs: 0` and `alreadyTerminal: true` — not a tool error  |

The dashboard and `kici runs cancel` refuse the cancel up front, against the run
status the Platform has mirrored. That mirror trails the orchestrator by a relay
hop, so a cancel can still get past the refusal and reach a run that has just
finished. The orchestrator then applies the same no-op, and the surface reports
it rather than claiming a cancellation: the response is a success carrying
`cancelledJobs: 0` and `alreadyTerminal: true`, `kici runs cancel` prints that
the run had already finished, and the run's mirrored record is left alone —
including its `cancelled_by` attribution. Cancelling a whole branch
(`kici runs cancel --branch`) does not count such a run in its total.

A cancel result carries `alreadyTerminal: true` when the orchestrator reported
the no-op. The field is optional: when it is absent, the run's status was not
reported, which is not the same as `false` — read the run to find out what
happened.

The check is applied twice on purpose. The run's status is read before any work
starts, and the writes that stamp attribution and the cancellation reason each
also refuse to touch a row in a terminal status. So a cancel that finds the run
live but loses the race against it finishing still writes nothing.

No cancel path deletes step records, so a run's step logs stay readable for as
long as the run itself is retained.

---

_Source: `packages/agent/src/execution/job-runner.ts`, `packages/orchestrator/src/reporting/execution-tracker.ts`_
