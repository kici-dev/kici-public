---
title: Execution status vocabulary
description: Run, job, and step status vocabulary, terminal-state rules, and the tracker that owns lifecycle state
---

## Overview

Every workflow run moves through a lifecycle: it is created, its jobs are dispatched to agents, the agents execute steps and report status back, and the run settles on a final outcome. Three status vocabularies describe that lifecycle at three granularities — the run, its jobs, and each job's steps.

The status vocabularies are the wire contract. They are shared enums defined once in `packages/engine/src/protocol/messages/execution-status.ts` and carried on the `execution.status`, `job.status`, and `step.status` protocol messages, so the orchestrator and agent always agree on the set of legal values.

Lifecycle _logic_ — deciding when a run is complete, rolling job outcomes up into a run outcome, and persisting the result — lives in the orchestrator's execution tracker (`packages/orchestrator/src/reporting/execution-tracker.ts`). The tracker is the single authority for run state; there is no separate transition engine.

## Status vocabularies

### Run status (`ExecutionRunStatus`)

A run is the top-level unit of work. Its status is one of:

| Status       | Description                                                                                     | Terminal |
| ------------ | ----------------------------------------------------------------------------------------------- | -------- |
| `pending`    | Created, not yet dispatched.                                                                    | No       |
| `running`    | One or more jobs are executing.                                                                 | No       |
| `cancelling` | Graceful cancellation in progress (cancel hooks running).                                       | No       |
| `held`       | Paused at a workflow install-gate protection rule (awaiting reviewer approval or a wait timer). | No       |
| `success`    | All jobs succeeded.                                                                             | Yes      |
| `failed`     | At least one job failed.                                                                        | Yes      |
| `cancelled`  | Cancelled before or during execution (no job failed).                                           | Yes      |

### Job status (`ExecutionJobStatus`)

A job is one dispatchable unit within a run, executed by a single agent. Its status carries more outcomes than a run because jobs surface agent-level and scheduling verdicts that a run only ever reports as an aggregate:

| Status            | Description                                                                | Terminal |
| ----------------- | -------------------------------------------------------------------------- | -------- |
| `pending`         | Queued behind dependencies or parallelism limits.                          | No       |
| `queued`          | Ready to dispatch, waiting for an agent.                                   | No       |
| `running`         | Executing on an agent.                                                     | No       |
| `recovering`      | Agent temporarily disconnected; awaiting reconnect or timeout.             | No       |
| `cancelling`      | Graceful cancellation in progress.                                         | No       |
| `success`         | Completed successfully.                                                    | Yes      |
| `failed`          | Completed with a failure.                                                  | Yes      |
| `cancelled`       | Cancelled before or during execution.                                      | Yes      |
| `skipped`         | Not run because its `if` condition or a dependency excluded it.            | Yes      |
| `timed_out_stale` | Reaped after its agent went silent past the stale threshold.               | Yes      |
| `drift_dropped`   | Dropped because the workflow definition changed under the run.             | Yes      |
| `unroutable`      | Its `runsOn` matched no agent for the whole queue window, so it never ran. | Yes      |

### Step status (`ExecutionStepStatus`)

A step is one command within a job. Steps report independently so the run timeline can render per-step progress.

| Status      | Description                                                                             |
| ----------- | --------------------------------------------------------------------------------------- |
| `running`   | Executing.                                                                              |
| `success`   | Completed successfully.                                                                 |
| `failed`    | Completed with a failure.                                                               |
| `skipped`   | Not run because its condition excluded it.                                              |
| `pending`   | A parallel-group child queued behind the group's `maxParallel` limit, not yet launched. |
| `cancelled` | A parallel-group sibling aborted by fail-fast. This is **not** a failure.               |

There is no terminal-state constant for steps: a step's outcome is read directly from its status, and only runs and jobs carry the terminal sets described below.

Each step also carries a concurrency role (`StepConcurrencyKind`) that explains which of those values it can take: `sequential` for an ordinary step in the flat step sequence, `parallel-child` for a member of a `parallel()` group running concurrently with its siblings, and `parallel-group` for the structural group wrapper the dashboard renders as an aggregate band. The `pending` and `cancelled` statuses only ever appear on parallel-group children.

## Terminal states

A status is **terminal** when the entity has reached a final outcome and will not change again. The terminal sets live alongside the enums in `execution-status.ts` as two constants, and they deliberately differ:

- **`TERMINAL_RUN_STATES`** = `success`, `failed`, `cancelled`.
- **`TERMINAL_JOB_STATES`** = `success`, `failed`, `cancelled`, `skipped`, `timed_out_stale`, `drift_dropped`, `unroutable`.

The four extra job-terminal values — `skipped`, `timed_out_stale`, `drift_dropped`, `unroutable` — are **job-level verdicts**. They describe how an individual job settled, and they roll up into the run's aggregate outcome rather than appearing on the run directly. A run whose only unfinished job is skipped still settles on `success` or `failed` based on its other jobs; it never carries a `skipped` status of its own. Keeping the two sets separate is what makes a run-level terminal check use the 3-value set and a job-level check use the 7-value set.

## Run outcome roll-up

The tracker folds job outcomes into the run outcome with a fixed rule, applied in order:

- The run is `failed` if **any** job ended `failed`, `timed_out_stale`, `drift_dropped`, or `unroutable` — the three infra-class job verdicts fail the run exactly like an ordinary job failure. `unroutable` in particular is what stops a run whose job could not be routed from reporting success on its siblings alone.
- Otherwise the run is `cancelled` if **any** job was cancelled.
- Otherwise the run is `success`. Jobs that were `skipped` do not hold a run back from succeeding.

One case bypasses the roll-up entirely: a run executing in `check-fail-on-drift` mode that saw at least one step report drift is `failed`, even when every job succeeded. That is the mode's whole point — previewing changes without applying them, and failing the run when the preview is non-empty. See [Idempotent steps](../../user/idempotent-steps.md) for the check modes.

A run reaches a terminal status when all of its jobs are terminal. At that point the tracker stamps the run's `completed_at` and `duration_ms` and records the failure class (`RunFailureClass`) for a failed or cancelled run, so downstream reads and notification subscriptions can match on why it ended.

That rollup is only as correct as the set of jobs the run knows about, so the tracker holds a run open while jobs are still to be registered. It has two mechanisms for that, and neither introduces a second notion of completeness — both keep the same all-jobs-terminal check from passing early:

- **Jobs gated behind another job** (a `needs` dependency, a rolling-wave hold) are registered up front as non-terminal placeholder rows and swapped for the real job when it is dispatched.
- **Jobs whose registration is still pending.** Several windows leave a run registered with fewer jobs than it will end up with, and the tracker holds the run open across each one. A workflow whose source must be packed first runs its build job alone while the run's real jobs wait. A job whose environment or matrix is resolved by an init step, and a dynamic job function that generates its jobs at run time, both register their jobs from work that continues after the dispatch call returns. Without a hold, the jobs registered so far reaching a terminal state would read as the run finishing — posting a green check to the provider and forwarding a terminal status to the Platform before the jobs it was still registering had run. The hold counts the outstanding registrations rather than flagging one window, so overlapping windows each keep the run open until their own jobs land, and it is a property of the in-memory run rather than a placeholder job, so it never appears as a phantom job or inflates the run's reported job count.

A run paused at a workflow install gate is likewise never rolled up complete: it tracks no jobs and resumes into a fresh dispatch, so the jobs registered before the gate held it cannot satisfy the completion check.

## Ordering tolerance

Status updates arrive over the network and can race. The most common race is a dispatch path re-touching a job row while a fast agent has already reported that same job terminal. The tracker guards against this by never overwriting an already-terminal status: before resetting a job back to `pending`, it checks both its in-memory entry and the persisted row, and preserves any terminal status it finds. Job rows are upserted idempotently, so a repeated or reordered update settles on the same final state rather than corrupting it. This tolerance is a property of the tracker's write path, not of a separate validation layer.

Runs carry the same guard, and the status the orchestrator forwards to the Platform follows it. The writes that can arrive after a run has already settled — the stale detector recomputing a finished run, the crash-recovery fallback whose run-state read raced a normal completion, an init failure landing on a run that finished anyway — are each conditional on the run still being non-terminal, and their forward fires only when that write actually changed the row. So the Platform is never told an outcome the orchestrator declined to record. This matters because the Platform mirrors what it is told and its run-mirror reconciler only revisits mirrors that are still non-terminal: a suppressed forward leaves a mirror the reconciler can heal, while a wrong one would stand forever.

## Persistence

The tracker keeps in-memory run state for fast lookups (job-name resolution, run-completion detection) and write-through to the orchestrator's `execution_runs`, `execution_jobs`, and `execution_steps` tables. Completed runs are pruned from memory after a short delay; the database rows are the durable record that the run timeline and history views read from.

## See also

- [Architecture overview](../overview.md) — three-tier model and package relationships
- [Protocol messages](../protocol-messages.md) — the `job.status` and `step.status` messages that carry status values
- [Job execution](job-execution.md) — how the agent runs a job and reports step status
