---
title: Execution lifecycle
description: Cancel flow, hook execution order, and concurrency group protocol
---

## Overview

This document describes the runtime lifecycle of a KiCI workflow execution, focusing on cancellation, lifecycle hooks, and concurrency groups. For the run, job, and step status vocabulary and terminal-state rules, see [state-machine.md](./state-machine.md). For job execution details, see [job-execution.md](./job-execution.md).

## The cancelling state

The `cancelling` state is a transient state between `running` and `cancelled`. It represents the grace period during which the agent terminates the active step and runs lifecycle hooks.

```
pending -> queued -> running -> cancelling -> cancelled
                         \                       ^
                          \-> cancelled ----------|  (direct, force cancel)
```

### Transitions involving cancelling

The execution tracker moves a run between these statuses in response to the following triggers:

| From         | Trigger                     | To           | Description                        |
| ------------ | --------------------------- | ------------ | ---------------------------------- |
| `running`    | Force cancel request        | `cancelled`  | Force cancel (immediate, no hooks) |
| `running`    | Graceful cancel request     | `cancelling` | Graceful cancel (hooks will run)   |
| `cancelling` | Force-cancel escalation     | `cancelled`  | Force cancel escalation            |
| `cancelling` | Cancellation hooks finished | `cancelled`  | Hooks finished normally            |
| `cancelling` | Cancellation hook failed    | `failed`     | A hook failed during cancellation  |

The `cancelling` status is transient, not terminal -- it is deliberately absent from `TERMINAL_RUN_STATES`.

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
  2. Wait grace period (default: 30s, requested per-job, capped by the sandbox)
  3. SIGKILL if step hasn't exited
  4. Run the four cancel hooks inside-out, each if defined:
     step onCancel -> step cleanup -> job onCancel -> job cleanup
  5. Report job.status = 'cancelled'
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

Hooks are not the only pseudo-steps that ride this field. The same convention carries the declarative cache phase (`cache:restore`, `cache:save`), the per-job init phase (`init:<n>`, one per init spec), and the container image build (`container:build`, which a reader sorts ahead of the real steps because it runs strictly first).

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
  |  wait: hold the job and long-poll the same connection for a
  |        follow-up ack (the agent stays connected)
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
4. The agent keeps the job and blocks on the same WebSocket connection, waiting for a follow-up ack
5. When the prior run completes, the orchestrator pushes an unsolicited `job.concurrency.ack { action: 'proceed' }` to that waiting agent, which resumes the job it was already holding

The wait is capped by `KICI_CONCURRENCY_WAIT_TIMEOUT_MS` (default 1 hour), overridable fleet-wide via the `concurrency_wait_timeout_ms` cluster setting; exceeding it fails the job. If the agent disconnects while queued, the orchestrator cancels its queued run rather than leaving the slot claimed.

### Timeouts

One 30-second bound covers both halves of the handshake: evaluating the group-key function, and then waiting for the orchestrator's first `job.concurrency.ack`. The job fails when either overruns. This bound is fixed, not operator-configurable. The configurable one is the queue-mode wait above (`KICI_CONCURRENCY_WAIT_TIMEOUT_MS`), which bounds how long a job already acked with `wait` holds for its follow-up ack.

## Grace period and hook timeouts

The total time a cancel can take is bounded by:

```
total_cancel_time = gracePeriod + (one timeout per cancel-path hook that runs)
```

- **gracePeriod**: milliseconds between SIGTERM and SIGKILL. Requested per-job in the SDK (`gracePeriod: 60`), then capped by the sandbox: the effective value is `Math.min(jobGracePeriod, agentMax)`. Both that cap and the value used when a job requests nothing default to 30s on bare-metal and firecracker, and the container sandbox uses 10s — so a job asking for more than the cap silently gets the cap. The cap is a code constant, not an operator setting: no environment variable or config field moves it. The one site that lowers it is the out-of-band cleanup-only re-run, which caps at 5s so an aborted cleanup resolves near its caller's timeout instead of one full grace period later.
- **hook timeout**: bounds **one** hook, not the cancel path as a whole. Authored as `timeout` on the hook object (`{ run, timeout }`) in milliseconds; 5 minutes when omitted.

The second bullet is why the formula sums rather than adds a single term. The cancel path runs up to four hooks in sequence, inside-out: step `onCancel`, step `cleanup`, job `onCancel`, job `cleanup`. Each carries its own timeout, so the worst case is the grace period plus every hook that is actually declared. A force-abort runs none of them.

Both are enforced by the agent. The orchestrator monitors for stuck jobs via stale detection.

## Cancelled dependent jobs

When a run is cancelled, pending/queued dependent jobs (jobs with `needs`) are marked `cancelled` (not `skipped`). This distinguishes "rule-skipped" from "parent-cancelled" in the UI and reporting.

---

_Source: `packages/orchestrator/src/reporting/execution-tracker.ts`, `packages/engine/src/protocol/messages/orchestrator-agent.ts`_
