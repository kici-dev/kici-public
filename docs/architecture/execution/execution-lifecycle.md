---
title: Execution lifecycle
description: Cancel flow, hook execution order, and concurrency group protocol
---

## Overview

This document describes the runtime lifecycle of a KiCI workflow execution, focusing on cancellation, lifecycle hooks, and concurrency groups. For the underlying state machine, see [state-machine.md](./state-machine.md). For job execution details, see [job-execution.md](./job-execution.md).

## State machine: cancelling state

The `cancelling` state is a transient state between `running` and `cancelled`. It represents the grace period during which the agent terminates the active step and runs lifecycle hooks.

```
pending -> queued -> running -> cancelling -> cancelled
                         \                       ^
                          \-> cancelled ----------|  (direct, force cancel)
```

### Transitions involving cancelling

| From         | Event             | To           | Description                        |
| ------------ | ----------------- | ------------ | ---------------------------------- |
| `running`    | `CANCEL`          | `cancelled`  | Force cancel (immediate, no hooks) |
| `running`    | `CANCEL_GRACEFUL` | `cancelling` | Graceful cancel (hooks will run)   |
| `cancelling` | `CANCEL_FORCE`    | `cancelled`  | Force cancel escalation            |
| `cancelling` | `COMPLETE`        | `cancelled`  | Hooks finished normally            |
| `cancelling` | `FAIL`            | `failed`     | A hook failed during cancellation  |

The `cancelling` state is NOT terminal -- `isTerminal('cancelling')` returns `false`.

## Cancel chain

The cancel chain propagates from the user interface down to the executing agent.

### Graceful cancel flow

```
Dashboard/CLI/API
  |
  |  POST /api/v1/orgs/:customerId/runs/:runId/cancel { force: false }
  v
Dashboard's API endpoint
  |
  |  run.cancel.request (WebSocket)
  v
Orchestrator
  |
  |  Sets run status to 'cancelling'
  |  Sends job.cancel { force: false } to agent
  v
Agent
  |
  1. SIGTERM to running step process
  2. Wait grace period (default: 30s, configurable per-job)
  3. SIGKILL if step hasn't exited
  4. Run onCancel hook (if defined)
  5. Run cleanup hook (if defined)
  6. Report job.status = 'cancelled'
  v
Orchestrator
  |
  |  Transitions run from 'cancelling' to 'cancelled'
  v
Done
```

### Force cancel flow

```
Dashboard/CLI/API
  |
  |  POST /api/v1/orgs/:customerId/runs/:runId/cancel { force: true }
  v
Dashboard API -> Orchestrator
  |
  |  Sets run status to 'cancelled' (immediate)
  |  Sends job.cancel { force: true } to agent
  v
Agent
  |
  1. SIGKILL to running step process (immediate)
  2. Skip all hooks (onCancel, cleanup)
  3. Report job.status = 'cancelled'
  v
Done
```

### Two-level cancel UX

The dashboard and CLI implement a two-level cancel pattern:

1. **First cancel request** -- graceful. The run transitions to `cancelling` (amber badge). The cancel button changes to "Force cancel" (red).
2. **Second cancel request** -- force. The run transitions immediately to `cancelled`. All hooks are skipped.

In the CLI: first Ctrl+C sends graceful cancel, second Ctrl+C sends force cancel.

## Hook execution order

Hooks execute inside-out, like stack unwinding.

### On cancellation

```
1. Step-level hooks (on the cancelled step):
   - onCancel (if step defines one)
   - cleanup (if step defines one)

2. Job-level hooks:
   - onCancel
   - cleanup (always runs)
```

### On success

```
1. Step-level hooks:
   - afterStep (runs after each step, before next step starts)

2. Job-level hooks:
   - onSuccess
   - cleanup (always runs)
```

### On failure

```
1. Job-level hooks:
   - onFailure
   - cleanup (always runs)
```

### Key principles

- **Hooks are observers** -- they cannot change execution flow. One mechanism per concern: rules for conditional logic, hooks for lifecycle callbacks.
- **Hooks run sequentially** after the step exits, not in parallel with the step.
- **cleanup always runs** regardless of outcome (success, failure, or graceful cancel), but is skipped on force cancel.
- **afterStep** runs immediately after its step, before the next step starts (not deferred).
- **Hook failure** changes job status to `failed` with a compound reason (e.g., "cancelled (onCancel hook failed: timeout)").

## Hook step protocol

Each hook execution is reported as a separate step in the protocol, with a `step_type` field distinguishing it from regular steps.

```typescript
// Agent sends step.status for hook execution
{
  type: 'step.status',
  runId: 'run-001',
  jobId: 'deploy',
  stepIndex: 2,        // incremented from the last regular step
  stepName: 'onCancel',
  state: 'running',    // or 'success', 'failed'
  step_type: 'hook:onCancel',  // hook type identifier
}
```

Valid `step_type` values:

- `step` (default, regular step)
- `hook:onCancel`
- `hook:cleanup`
- `hook:onSuccess`
- `hook:onFailure`
- `hook:beforeStep`
- `hook:afterStep`

Hook steps appear in the dashboard with a distinct visual marker (hook icon) and lighter styling. Each hook gets its own execution_steps row with separate status, timing, and log stream.

## Concurrency group protocol

Concurrency groups prevent parallel execution of related workflow runs. The evaluation happens agent-side (the group key function needs runtime context), with the orchestrator making the concurrency decision.

### Protocol flow

```
Agent (evaluates group function)
  |
  |  job.concurrency.report { group: 'deploy-main', runId, jobId }
  v
Orchestrator
  |
  |  Checks in-progress runs with same group key
  |  Decides: proceed, wait, or cancel
  |
  |  job.concurrency.ack { action: 'proceed' | 'wait' | 'cancel', reason? }
  v
Agent
  |
  |  proceed: continue execution
  |  wait: release agent back to pool (queued state)
  |  cancel: report job cancelled with superseded reason
```

### cancelInProgress mode

When `cancelInProgress: true`, the orchestrator cancels older runs in the same group:

1. New run joins group
2. Orchestrator finds older running run with same group key
3. Older run receives `job.cancel` with reason "Superseded by run #N"
4. New run receives `job.concurrency.ack { action: 'proceed' }`

### Queue mode

When `cancelInProgress: false`, the orchestrator holds the new run:

1. New run joins group
2. Orchestrator finds active run with same group key
3. New run receives `job.concurrency.ack { action: 'wait', reason: 'Waiting for deploy-main (1 ahead)' }`
4. Agent releases back to pool
5. When prior run completes, orchestrator dispatches the queued run

### Timeouts

Concurrency group evaluation has a configurable timeout (default: 30s). If the agent doesn't report the group key within the timeout, the job fails.

## Grace period and hook timeout

The total time a cancel can take is bounded by:

```
total_cancel_time = gracePeriod + hookTimeout
```

- **gracePeriod**: seconds between SIGTERM and SIGKILL. Configured per-job in the SDK (`gracePeriod: 60`), with an operator-configurable maximum. Default: 30s.
- **hookTimeout**: maximum time for all hooks to complete. Default: 5 minutes. Configurable per-hook.

Both are enforced by the agent. The orchestrator monitors for stuck jobs via stale detection.

## Cancelled dependent jobs

When a run is cancelled, pending/queued dependent jobs (jobs with `needs`) are marked `cancelled` (not `skipped`). This distinguishes "rule-skipped" from "parent-cancelled" in the UI and reporting.

---

_Source: `packages/engine/src/state-machine/`, `packages/engine/src/protocol/messages/orchestrator-agent.ts`_
