---
title: Scheduling & event patterns
description: Nightly cron, workflow-complete-triggered deploys, custom event chaining
---

Run a full build and test suite on a schedule using `schedule()`. Schedule triggers are evaluated by the orchestrator's Raft leader in clustered deployments.

```typescript
import { workflow, job, step, schedule } from '@kici-dev/sdk';

const install = step('install', async ({ $ }) => {
  await $`pnpm install --frozen-lockfile`;
});

const fullTest = job('full-test', {
  runsOn: 'linux',
  steps: [
    install,
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
    step('typecheck', async ({ $ }) => {
      await $`pnpm typecheck`;
    }),
  ],
});

const publish = job('publish-nightly', {
  runsOn: 'linux',
  needs: [fullTest],
  steps: [
    install,
    step('build', async ({ $ }) => {
      await $`pnpm build`;
    }),
    step('publish', async ({ $ }) => {
      await $`./scripts/publish-nightly.sh`;
    }),
  ],
});

export default workflow('nightly-build', {
  on: schedule({ cron: '0 2 * * *', description: 'Every day at 2 AM UTC' }),
  jobs: [fullTest, publish],
});
```

**Notes:**

- The `cron` field uses standard 5-field cron syntax. Use the `timezone` option (defaults to `'UTC'`) to control evaluation in a specific timezone: `schedule({ cron: '0 2 * * *', timezone: 'America/New_York' })`.
- Schedule workflows use the [registration model](../events.md#the-registration-model) -- the cron will not start firing until you push to your default branch.
- In clustered orchestrator deployments, only the Raft leader evaluates cron schedules. If the leader changes, the new leader recovers missed schedules.

**Timing precision and scaling:**

- The orchestrator's cron evaluator wakes up every **30 seconds** (fixed interval, not configurable at runtime). A schedule due at 02:00:00 fires on the next tick after that moment, so expect **0-30 seconds of jitter after the scheduled time** -- never early. The event payload's `scheduledAt` field carries the exact cron-computed time (not the fire time), so downstream consumers can reason about the intended schedule rather than the dispatch moment.
- All cron schedules are evaluated **serially** within a single tick on the leader. Each evaluation does an in-memory cron computation plus two DB writes (atomic claim + event emit), so per-schedule cost is on the order of low tens of milliseconds. Practically, dozens of schedules firing in the same tick add up to well under a second of extra dispatch latency between the first and the last -- negligible compared to the 0-30 s tick alignment.
- If the leader fails over, the new leader recovers **at most one fire per schedule** -- the most recent past scheduled time. KiCI does not backfill multiple missed runs (a cron stuck for two hours fires once, not four times). The per-schedule lower bound on fire frequency is the cron expression's natural period; the upper bound on lateness is `30 s + (Raft election + restart time)`.
- Sub-minute crons (`* * * * *`) are supported but constrained by the 30-second tick: a schedule for `* * * * *` will fire roughly once per minute, but the actual fire time within each minute can drift by up to 30 seconds.

## Workflow-complete-triggered deploy

Trigger a deployment automatically when a build workflow succeeds, using `workflowComplete()`. This is one of the most common event chaining patterns.

```typescript
import { workflow, job, step, push, workflowComplete } from '@kici-dev/sdk';

// Workflow A: build and test on push to main
export const build = workflow('build', {
  on: push({ branches: 'main' }),
  jobs: [
    job('test', {
      runsOn: 'linux',
      steps: [
        step('install', async ({ $ }) => {
          await $`pnpm install --frozen-lockfile`;
        }),
        step('test', async ({ $ }) => {
          await $`pnpm test`;
        }),
        step('build', async ({ $ }) => {
          await $`pnpm build`;
        }),
      ],
    }),
  ],
});

// Workflow B: deploy when build succeeds
export const deploy = workflow('deploy-on-success', {
  on: workflowComplete({ name: 'build', status: ['success'] }),
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy-staging', async ({ $ }) => {
          await $`./scripts/deploy.sh staging`;
        }),
        step('run-smoke-tests', async ({ $ }) => {
          await $`./scripts/smoke-test.sh staging`;
        }),
        step('deploy-production', async ({ $ }) => {
          await $`./scripts/deploy.sh production`;
        }),
      ],
    }),
  ],
});
```

**Notes:**

- `workflowComplete()` is a system event trigger -- the orchestrator automatically emits these events when workflows finish. You do not need to call `ctx.emit()`.
- The `status` filter accepts `'success'`, `'failed'`, and `'cancelled'`. Omit `status` to trigger on any completion.
- The `deploy-on-success` workflow uses the [registration model](../events.md#the-registration-model) -- it will not trigger until you push to your default branch. The `build` workflow (using `push()`) works immediately.
- You can also use `jobComplete()` to trigger on individual job completions within a workflow.

## Custom event chaining

Two workflows communicating through custom events using `kiciEvent()` and `ctx.emit()`. Workflow A runs tests and emits a typed event with results. Workflow B listens for that event and triggers a deployment.

```typescript
import { workflow, job, step, push, kiciEvent, defineEvent, z } from '@kici-dev/sdk';

// Define a typed event contract
const testsPassedEvent = defineEvent(
  'tests-passed',
  z.object({
    branch: z.string(),
    commit: z.string(),
    testCount: z.number(),
    duration: z.number(),
  }),
);

// Workflow A: run tests and emit result event
export const testSuite = workflow('test-suite', {
  on: push({ branches: 'main' }),
  jobs: [
    job('test', {
      runsOn: 'linux',
      steps: [
        step('install', async ({ $ }) => {
          await $`pnpm install --frozen-lockfile`;
        }),
        step('run-tests', async ({ $ }) => {
          await $`pnpm test`;
        }),
        step('emit-results', async (ctx) => {
          await ctx.emit(testsPassedEvent.name, {
            branch: 'main',
            commit: 'abc123',
            testCount: 142,
            duration: 45,
          });
        }),
      ],
    }),
  ],
});

// Workflow B: deploy when tests pass (in the same or separate file)
export const autoDeploy = workflow('auto-deploy', {
  on: kiciEvent({ name: 'tests-passed' }),
  jobs: [
    job('deploy', {
      runsOn: 'linux',
      steps: [
        step('deploy', async ({ $ }) => {
          await $`./scripts/deploy.sh`;
        }),
        step('notify', async ({ $ }) => {
          await $`./scripts/notify-slack.sh "Deployment complete"`;
        }),
      ],
    }),
  ],
});
```

**Notes:**

- Both workflows can live in the same `.kici/workflows/` file or in separate files -- the event system routes by event name, not by file.
- `defineEvent()` creates a typed contract using Zod. This is optional but recommended for documenting event payloads.
- Custom events are delivered immediately when `ctx.emit()` is called (mid-workflow), not queued until the workflow completes.
- Payload matching is available via the `match` option: `kiciEvent({ name: 'tests-passed', match: { '$.branch': 'main' } })`.
- The `auto-deploy` workflow uses the [registration model](../events.md#the-registration-model) -- it will not trigger until you push to your default branch.
- The [circuit breaker](../events.md#circuit-breaker) limits chain depth (default: 10) and rate (default: 100/min per workflow) to prevent infinite loops.

## Step context
