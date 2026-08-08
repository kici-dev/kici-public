---
title: Concurrency groups
description: Control parallel execution with auto-cancel and queue modes
---

Concurrency groups prevent multiple workflow runs from executing in parallel when they target the same resource. Common use cases include preventing parallel deploys to the same environment or serializing database migrations.

## Basic usage

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: push({ branches: ['main', 'staging'] }),
  concurrency: {
    group: (ctx) => `deploy-${ctx.branch}`,
    cancelInProgress: true,
    max: 1,
  },
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy', async ({ $ }) => {
          await $`./deploy.sh`;
        }),
      ],
    }),
  ],
});
```

## Configuration

The `concurrency` option on a workflow accepts:

| Field              | Type     | Default  | Description                                |
| ------------------ | -------- | -------- | ------------------------------------------ |
| `group`            | Function | Required | Returns the concurrency group key string   |
| `cancelInProgress` | boolean  | `true`   | Cancel older runs when a newer run arrives |
| `max`              | number   | `1`      | Maximum concurrent runs in the same group  |

### Group key function

The group key function receives a context with the branch name and event payload. Runs with the same group key are subject to concurrency limits.

```typescript
// Per-branch concurrency (most common)
group: (ctx) => `deploy-${ctx.branch}`;

// Global concurrency (across all branches)
group: () => 'deploy';

// Per-target-branch concurrency
group: (ctx) => `deploy-${ctx.event.targetBranch ?? 'default'}`;
```

The workflow-level group function is always evaluated **agent-side** at runtime -- the lock file records only that a group function exists (`hasGroup: true`), not the function itself. The agent loads the workflow source, calls the group function with `{ branch, event }`, and reports the evaluated key back to the orchestrator before step execution begins. This differs from job-level `concurrencyGroup` (see [Contexts](contexts.md#concurrency-groups)), where the compiler performs purity analysis and can inline pure functions for orchestrator-side evaluation.

## cancelInProgress mode

When `cancelInProgress: true`, a newer run supersedes older runs in the same group:

```
Run #1 starts deploying to main        -> running
Run #2 arrives for deploy-main group   -> Run #1 cancelled ("Superseded by run in concurrency group 'deploy-main'")
Run #2 continues                       -> running
```

This is the most common mode for deploy workflows -- you want the latest code deployed, not an outdated version.

The cancelled run:

- Receives a cancellation with reason "Superseded by run in concurrency group 'deploy-main'"
- Goes through the normal cancel flow (grace period, hooks if graceful)
- GitHub Check status updated to `cancelled` with the superseded reason

```typescript
workflow('deploy', {
  concurrency: {
    group: (ctx) => `deploy-${ctx.branch}`,
    cancelInProgress: true,
  },
  jobs: [/* ... */],
});
```

## Queue mode

When `cancelInProgress: false`, newer runs will wait until older runs complete:

```
Run #1 starts deploying                -> running
Run #2 arrives for same group          -> queued ("Waiting for deploy-main (1 ahead)")
Run #1 completes                       -> success
Run #2 starts                          -> running
```

In queue mode, the agent that picked up the queued run **stays connected** to the orchestrator and parks on a long-poll wait. When the holder finishes (success, failure, or cancel), the orchestrator dequeues the FIFO-next entry and pushes a `proceed` notification over the same WebSocket; the queued agent then continues with normal step execution against the workspace it already has. The agent's slot is therefore held for the duration of the queue wait — bound by `KICI_CONCURRENCY_WAIT_TIMEOUT_MS` (default 1 hour).

```typescript
workflow('migrate-db', {
  concurrency: {
    group: () => 'migrations',
    cancelInProgress: false,
    max: 1,
  },
  jobs: [/* ... */],
});
```

The dashboard will show a "Queued" badge with the reason: "Waiting for deploy-main (1 ahead)".

## Max concurrent runs

The `max` field controls how many runs can execute simultaneously in the same group:

```typescript
// Allow up to 3 parallel test runs per branch
workflow('test', {
  concurrency: {
    group: (ctx) => `test-${ctx.branch}`,
    cancelInProgress: false,
    max: 3,
  },
  jobs: [/* ... */],
});
```

When `max: 1` (default), runs are fully serialized within the group.

## Group key examples

### Deploy per environment

```typescript
workflow('deploy', {
  concurrency: {
    group: (ctx) => `deploy-${ctx.branch}`,
    cancelInProgress: true,
  },
  jobs: [
    job('deploy-staging', {
      runsOn: 'linux',
      context: 'staging',
      steps: [/* ... */],
    }),
  ],
});
```

### Global singleton

```typescript
// Only one migration can run at a time, regardless of branch
workflow('migrate', {
  concurrency: {
    group: () => 'db-migration',
    cancelInProgress: false,
  },
  jobs: [/* ... */],
});
```

### Environment-aware groups

```typescript
// Serialize deploys per environment
workflow('deploy', {
  concurrency: {
    group: (ctx) => {
      const env = ctx.branch === 'main' ? 'production' : 'staging';
      return `deploy-${env}`;
    },
    cancelInProgress: true,
  },
  jobs: [/* ... */],
});
```

## Interaction with context protection

When a workflow has both `concurrency` and `context` protection rules:

1. Context protection gates (required reviewers, wait timer) apply first
2. Concurrency group check happens after protection gates pass
3. If the run is queued by concurrency, it keeps its protection approval

This means a run that passed approval won't need re-approval if it gets queued by concurrency.

## Cancelling queued runs

Queued runs can be cancelled before they start executing. The cancel request removes them from the queue immediately -- they don't go through the grace period since no step is running.

## Job-level concurrency groups

In addition to workflow-level concurrency, individual jobs can define their own concurrency group via the `concurrencyGroup` property. This controls concurrent execution at the job level rather than the workflow level. See [Contexts — concurrency groups](contexts.md#concurrency-groups) for details.

## Local execution

`kici run <event> --local` is a real routed dispatch: your machine becomes an ephemeral agent behind the local dev plane, whose own orchestrator applies the same concurrency machinery described above. The `group` callback is evaluated agent-side against the simulated event, and `cancelInProgress` carries its usual semantics — `true` supersedes the older run in the group, `false` queues the newer one behind it.

Coordination is scoped to that plane. The plane's state (including its database) lives under `~/.kici/local/`, so enforcement is per-machine and per-user: running the same workflow on two different machines does not serialize across them. For cross-host enforcement (queueing across agents, dashboard visibility), use `kici run remote` against a deployed orchestrator.

See [`kici run <event> --local`](./cli/runs-and-approvals.md#kici-run-event---local) for the rest of the local-run behavior, and [the local dev plane](../operator/orchestrator/local-dev-plane.md) for the plane's state directory and lifecycle.

---

_Source: `packages/sdk/src/types.ts` (WorkflowOptions.concurrency, JobOptions.concurrencyGroup)_
