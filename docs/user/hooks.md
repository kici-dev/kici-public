---
title: Lifecycle hooks
description: SDK hook API for cancel, cleanup, success, failure, and step-level callbacks
---

Hooks are callbacks that run at specific points in the execution lifecycle. They let you react to outcomes (cancellation, success, failure) and perform cleanup without affecting the execution flow.

## Hook types

KiCI supports six hook types at three levels (step, job, workflow):

| Hook         | When it runs                         | Available on        |
| ------------ | ------------------------------------ | ------------------- |
| `onCancel`   | After step/job/workflow is cancelled | Step, Job, Workflow |
| `cleanup`    | Always (success, failure, or cancel) | Step, Job, Workflow |
| `onSuccess`  | After job/workflow succeeds          | Job, Workflow       |
| `onFailure`  | After job/workflow fails             | Job, Workflow       |
| `beforeStep` | Before each step in a job            | Job                 |
| `afterStep`  | After each step in a job             | Job                 |

## Basic usage

### Job-level hooks

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('deploy', {
  on: push({ branches: ['main'] }),
  jobs: [
    job('deploy-prod', {
      runsOn: 'linux',
      steps: [
        step('deploy', async ({ $ }) => {
          await $`kubectl apply -f manifests/`;
        }),
      ],
      onCancel: async (ctx) => {
        console.log(`Deploy cancelled: ${ctx.outcome.reason}`);
        await ctx.$`kubectl rollout undo deployment/app`;
      },
      cleanup: async (ctx) => {
        // Always runs -- release lock, notify team, etc.
        await ctx.$`curl -X POST https://slack.com/webhook -d '{"text": "Deploy ${ctx.outcome.status}"}'`;
      },
      onSuccess: async (ctx) => {
        console.log(`Deploy succeeded in ${ctx.outcome.duration}ms`);
      },
      onFailure: async (ctx) => {
        console.log(`Deploy failed at step: ${ctx.outcome.failedStep}`);
      },
      gracePeriod: 60, // 60 seconds before SIGKILL on cancel
    }),
  ],
});
```

### Step-level hooks

```typescript
step('download-artifacts', {
  run: async ({ $ }) => {
    await $`wget https://artifacts.example.com/build.tar.gz`;
  },
  onCancel: async (ctx) => {
    // Clean up partial downloads
    await ctx.$`rm -f build.tar.gz`;
  },
  cleanup: async (ctx) => {
    await ctx.$`rm -rf /tmp/staging`;
  },
});
```

### Workflow-level hooks

```typescript
workflow('ci', {
  on: push({ branches: ['main'] }),
  jobs: [
    /* ... */
  ],
  onCancel: async (ctx) => {
    // Notify when any job in the workflow is cancelled
    console.log('CI workflow cancelled');
  },
  cleanup: async (ctx) => {
    // Always runs after all jobs complete
    console.log(`CI workflow finished with status: ${ctx.outcome.status}`);
  },
});
```

## Hook context

Hook functions receive the same `StepContext` as regular steps (`$`, `ctx`, `log`, `env`), plus an `outcome` object with metadata about the execution result.

### ctx.outcome

```typescript
interface OutcomeMetadata {
  /** Final status of the job/workflow. */
  status: 'cancelled' | 'success' | 'failed';
  /** Reason for cancellation (e.g., "User requested", "Superseded by run #42"). */
  reason?: string;
  /** Name of the step that caused failure (for onFailure hooks). */
  failedStep?: string;
  /** Outputs from all completed steps. */
  stepOutputs: Record<string, unknown>;
  /** Total execution duration in milliseconds. */
  duration: number;
}
```

### Capabilities

Hooks can do everything regular steps can:

- Run shell commands via `$`
- Set environment variables via `ctx.setEnv()` and prepend to `PATH` via `ctx.addPath()`
- Access previous step outputs via `ctx.outputsOf()` and `ctx.jobOutputs()`
- Publish encrypted secret outputs via `ctx.setSecretOutput()`
- Log via `log.info()`, `log.error()`, etc.

## Hook timeout

Each hook has a timeout (default: 5 minutes). You can customize it per-hook:

```typescript
job('deploy', {
  runsOn: 'linux',
  steps: [
    /* ... */
  ],
  cleanup: {
    run: async (ctx) => {
      await ctx.$`./lengthy-cleanup.sh`;
    },
    timeout: 10 * 60 * 1000, // 10 minutes in ms
  },
});
```

## Hook execution order

Hooks execute inside-out on cancellation (like stack unwinding):

1. **Step-level** cleanup (on the cancelled step)
2. **Job-level** onCancel, then cleanup
3. **Workflow-level** onCancel, then cleanup

On success: step afterStep (after each step), then job onSuccess + cleanup, then workflow onSuccess + cleanup.

On failure: job onFailure + cleanup, then workflow onFailure + cleanup.

**cleanup always runs** -- regardless of whether the outcome was success, failure, or cancel.

## Hooks are observers

Hooks follow the "one mechanism per concern" principle:

- **Rules** control whether a step/job executes (conditional logic)
- **Hooks** react to execution outcomes (lifecycle callbacks)

Hooks cannot short-circuit step execution or change the execution flow. They observe and respond.

## beforeStep and afterStep

These job-level hooks run around every step in the job:

```typescript
job('test', {
  runsOn: 'linux',
  beforeStep: async (ctx) => {
    console.log(`Starting step at ${new Date().toISOString()}`);
  },
  afterStep: async (ctx) => {
    console.log(`Step completed with status: ${ctx.outcome.status}`);
  },
  steps: [
    step('lint', async ({ $ }) => {
      await $`pnpm lint`;
    }),
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});
```

`afterStep` runs immediately after its step, before the next step starts (not deferred to the end of the job).

## Step-level rules

Step-level rules control whether a step executes, evaluated at runtime by the agent:

```typescript
import { step, rule, skip, isEventType } from '@kici-dev/sdk';

step('deploy', {
  run: async ({ $ }) => {
    await $`kubectl apply -f manifests/`;
  },
  rules: [
    rule('only on main pushes', (ctx) => {
      if (!isEventType(ctx.event, 'push')) return false;
      return ctx.event.payload.ref === 'refs/heads/main';
    }),
  ],
});

// Or use skip() for explicit skip with a reason
step('optional-check', {
  run: async ({ $ }) => {
    await $`./optional-check.sh`;
  },
  rules: [skip('not needed in CI', () => true)],
});
```

When a rule returns `false`, the step is reported as `skipped` and subsequent steps continue normally. Skipped steps don't cause the job to fail.

Step rules have access to runtime context via `RuleContext`: `event` (typed discriminated union), `changedFiles`, `env`, and `$`. They evaluate agent-side (unlike job-level rules which evaluate at the orchestrator during trigger matching).

## Hook failure behavior

If a hook throws an error or times out:

- The job status changes to `failed` with a compound reason (e.g., "cancelled (onCancel hook failed: Connection timeout)")
- Remaining hooks for that level are skipped
- The failure is visible in the dashboard as a failed hook step
- Force cancel kills running hooks immediately via SIGKILL

This behavior is consistent across all hook types.

---

_Source: `packages/sdk/src/hooks/`, `packages/sdk/src/types.ts`_
