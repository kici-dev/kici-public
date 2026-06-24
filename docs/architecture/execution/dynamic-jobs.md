---
title: Dynamic job generation
description: ''
---

## Overview

DynamicJobFn enables workflows to generate jobs at runtime based on external state. Unlike static jobs (defined at compile time and stored in the lock file), dynamic jobs are produced by an async function that runs on an agent during webhook processing.

## SDK API

A DynamicJobFn is an async function placed in a workflow's `jobs` array alongside static jobs:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

export default workflow('my-workflow', {
  on: [push()],
  jobs: [
    // Static job (known at compile time)
    job('lint', { runsOn: 'linux', steps: [...] }),

    // Dynamic job function (evaluated at runtime)
    async ({ $, ctx, log, kici }) => {
      const infra = await kici.infrastructure.list();
      return infra.scalers.map(scaler =>
        job(`test-${scaler.name}`, {
          runsOn: scaler.labelSets[0],
          steps: [step('verify', async (ctx) => { ... })],
        })
      );
    },
  ],
});
```

The `DynamicJobContext` provides:

- `$` — zx shell executor
- `ctx` — `{ workflow: { name }, event }` (webhook event data)
- `log` — structured logger
- `kici` — typed KiCI API (see [KiCI API](#kici-api-ctxkici) below)

## Lock file representation

The compiler stores DynamicJobFn entries as `_type: 'dynamic'` in the lock file:

```json
{
  "_type": "dynamic",
  "source": { "file": ".kici/workflows/my-workflow.ts", "index": 1 }
}
```

## Dispatch flow

```
Webhook → orchestrator processWebhook
  ├── Static jobs: dispatched immediately
  └── Dynamic entries (_type: 'dynamic'):
      1. Dispatch eval job to init-runner agent (__dynamic__<workflow>__<index>)
      2. Agent loads workflow bundle, extracts DynamicJobFn by index
      3. Agent calls function with DynamicJobContext (including ctx.kici API)
      4. Agent serializes returned Job[] → LockJob[]
      5. Agent sends LockJob[] back via job.status (dynamicComplete: true)
      6. Orchestrator receives LockJob[], runs each through:
         - Environment resolution
         - Secret resolution (PG + Vault/OpenBao)
         - Protection rules
      7. Each generated job dispatched normally
```

## Step function re-evaluation

Generated jobs' step functions are closures inside the DynamicJobFn return value. Since functions can't be serialized over JSON, the **executing agent re-evaluates the DynamicJobFn** to extract steps.

Each generated job's `jobConfig` includes `dynamicSource: { index, event, expectedJobNames }`. When the executing agent loads the workflow, it:

1. Finds the DynamicJobFn by `index`
2. Calls it with the original `event` context
3. Compares the re-evaluated job names against `expectedJobNames` (determinism guard)
4. Finds the generated job by `name` in the returned array
5. Extracts its steps

**This requires the DynamicJobFn to be deterministic** — given the same event context, it must return the same jobs with the same names and steps.

### Determinism guard

The orchestrator includes the list of job names from the original eval (`expectedJobNames`) in the dispatch payload. The executing agent compares re-evaluated output against this list:

- **Sibling mismatch, target exists:** logs a warning about non-deterministic behavior but proceeds. The job runs with whatever steps the re-eval produced.
- **Target job missing:** hard failure with a clear error message explaining the determinism requirement and listing expected vs actual job names.

### Writing deterministic DynamicJobFn

The DynamicJobFn is called twice: once during the eval phase (on an init-runner agent) and once during execution (on the executing agent). These may be different machines at different times.

**What's deterministic:**

- `ctx.event` — the normalized event envelope (`{ type, action, targetBranch, sourceBranch, changedFiles, payload, … }`), frozen and passed unchanged. The raw provider body is nested at `ctx.event.payload`.

**What can drift between eval and re-eval:**

- `$` (shell executor) — different agent, different filesystem, different git state
- `env` (process.env) — different agent may have different environment variables
- `kici.infrastructure.list()` — infrastructure changes over time (agents connect/disconnect, scalers added/removed)
- `Date.now()`, `Math.random()` — inherently non-deterministic

**Do:**

```typescript
// Derive job names from event data (deterministic)
async ({ ctx }) => {
  const changedDirs = ctx.event.payload.commits
    .flatMap(c => c.modified)
    .map(f => f.split('/')[0]);
  return [...new Set(changedDirs)].map(dir =>
    job(`test-${dir}`, { runsOn: 'linux', steps: [...] })
  );
};
```

**Don't:**

```typescript
// Job names depend on infrastructure state (can change between eval and re-eval)
async ({ kici }) => {
  const infra = await kici.infrastructure.list();
  return infra.scalers.map(scaler =>
    job(`test-${scaler.name}`, { runsOn: scaler.labelSets[0], steps: [...] })
  );
};
```

If you must use non-deterministic inputs (like infrastructure queries) to decide job names, understand that changes between eval and re-eval will produce a warning — or a failure if the specific job being executed disappears from the output.

## KiCI API (`ctx.kici`)

DynamicJobFn (and step functions) access the orchestrator through a typed API available as `ctx.kici`. Calls are transported over the agent's existing WebSocket connection — no separate HTTP endpoint or configuration needed.

### Transport chain

```
Step/DynamicJobFn → ctx.kici.infrastructure.list()
  → IPC to fork-runner (agent.api.request)
  → job-runner relays over WS (agent.api.request)
  → orchestrator AgentApiRegistry handles + responds (agent.api.response)
  → IPC relay back to sandbox
```

### Available methods

| Method                  | Role | Description                                 |
| ----------------------- | ---- | ------------------------------------------- |
| `infrastructure.list()` | read | List available scalers and connected agents |

### Response format (`infrastructure.list`)

```json
{
  "scalers": [
    {
      "name": "docker-linux",
      "type": "container",
      "labelSets": [["linux", "docker"]],
      "source": "local"
    },
    {
      "name": "macos-pool",
      "type": "bare-metal",
      "labelSets": [["macos"]],
      "source": "peer-mac-01"
    }
  ],
  "agents": [
    {
      "agentId": "agent-123",
      "labels": ["linux", "custom-agent"],
      "scalerManaged": false,
      "source": "local"
    },
    {
      "agentId": "win-agent-1",
      "labels": ["windows"],
      "scalerManaged": false,
      "source": "peer-win-01"
    }
  ]
}
```

The `source` field indicates where each scaler/agent is located: `"local"` for the current orchestrator, or the peer's `instanceId` for remote cluster members. This enables DynamicJobFn to generate jobs targeting infrastructure across the entire cluster.

### Adding a new API method

1. Add the typed method + return type in `packages/sdk/src/api-types.ts`
2. Wire the proxy in `buildKiciApi()` (same file)
3. Register the handler in the orchestrator's `AgentApiRegistry` (`packages/orchestrator/src/app.ts`)

## Dynamic fields on generated jobs

Generated jobs may declare function-typed `environment`, `env`, `concurrencyGroup`, and `matrix`. The dynamic job serializer (`packages/agent/src/execution/dynamic-job-serializer.ts`) invokes each user function against the same eval context that was just passed to the parent DynamicJobFn (the normalized event envelope, `$`, `log`, `env`, and workflow name) and embeds the resolved values into the lock job before dispatch. Each call is wrapped in a 60s timeout (mirroring the static-job dynamic-field path in `init-runner.ts`). User functions that throw cause the eval job to fail with the user's error message; functions that return `undefined` leave the field unset.

```ts
async ({ event }) => [
  job('deploy', {
    runsOn: ['default'],
    environment: (event) => `staging-${event.targetBranch}`,
    env: (event) => ({ REF: String(event.payload.ref) }),
    concurrencyGroup: (event) => `cg-${event.targetBranch}`,
    matrix: async () => ['us-east', 'eu-west'],
    steps: [
      /* ... */
    ],
  }),
];
```

This is strictly simpler than the static-job pathway — the orchestrator's two-phase dynamic-field resolution doesn't apply because generated jobs don't exist in source, and the eval agent already has every value the resolver needs.

## Cross-domain needs

A DB-backed needs-aware dispatch scheduler gates all `needs` edges — static-to-static, static-to-dynamic-group, dynamic-to-static, and dynamic-to-dynamic. Static and dynamic jobs can freely reference each other.

### Static jobs referencing dynamic groups

Use the `dynamicGroup()` helper to declare a dependency on all generated jobs in a named group:

```typescript
import { workflow, job, step, push, dynamicGroup, dynamicJob } from '@kici-dev/sdk';

const deploy = job('deploy', {
  runsOn: 'linux',
  needs: [dynamicGroup('test-shards')],
  steps: [
    step('deploy', async ({ $ }) => {
      await $`echo "Deploying..."`;
    }),
  ],
});

export default workflow('ci', {
  on: [push()],
  jobs: [
    dynamicJob('test-shards', async ({ ctx }) => {
      const dirs = ['api', 'web', 'shared'];
      return dirs.map((dir) =>
        job(`test-${dir}`, {
          runsOn: ['linux'],
          steps: [
            step('test', async ({ $ }) => {
              await $`pnpm test --filter ${dir}`;
            }),
          ],
        }),
      );
    }),
    deploy,
  ],
});
```

The `deploy` job will not dispatch until every job generated by the `test-shards` group completes successfully.

### Generated jobs referencing static jobs

Generated jobs reference static jobs using plain string names — no special marker needed:

```typescript
const lint = job('lint', {
  runsOn: 'linux',
  steps: [
    step('lint', async ({ $ }) => {
      await $`pnpm lint`;
    }),
  ],
});

export default workflow('ci', {
  on: [push()],
  jobs: [
    lint,
    dynamicJob('tests', async ({ ctx }) => {
      return ['unit', 'integration'].map((suite) =>
        job(`test-${suite}`, {
          runsOn: ['linux'],
          needs: ['lint'], // plain string reference to static job
          steps: [
            step('test', async ({ $ }) => {
              await $`pnpm test:${suite}`;
            }),
          ],
        }),
      );
    }),
  ],
});
```

### The `dynamicJob()` factory

`dynamicJob(groupName, fn)` tags a DynamicJobFn with a group name. One factory = one group. Generated jobs inherit the group tag automatically. If you need multiple groups from one eval context, split into multiple `dynamicJob()` calls.

### `ifUpstreamFailed` option

By default, when an upstream job fails, all downstreams are skipped (matching GitHub Actions semantics). Override this per-edge with the object form:

```typescript
const cleanup = job('cleanup', {
  runsOn: 'linux',
  needs: [{ name: 'build', when: 'always' }],
  steps: [
    step('cleanup', async ({ $ }) => {
      await $`echo "Cleaning up..."`;
    }),
  ],
});
```

For dynamic groups:

```typescript
const notify = job('notify', {
  runsOn: 'linux',
  needs: [dynamicGroup('tests', { when: 'always' })],
  steps: [
    step('notify', async ({ $ }) => {
      await $`echo "Notifying..."`;
    }),
  ],
});
```

Keywords: `'on-success'` (default), `'always'` (dispatch on any terminal status), `'on-skip'`, `'on-failure'`; or a raw status-set array.

### Empty group semantics

If a `dynamicJob()` returns `[]` (zero generated jobs), static downstreams that depend on that group dispatch immediately. The empty AND over no edges evaluates to true. Authors who want to prevent this must gate with a separate condition.

### Determinism drift with cross-domain needs

When an executing agent re-evaluates a DynamicJobFn and produces fewer jobs than the original eval, the dropped jobs transition to `drift_dropped` (a terminal failure state). Any downstream jobs that depend on the dropped job (directly or via group membership) are skipped with a drift error. The run fails.

## Result-aware generation

An event-only DynamicJobFn is evaluated during webhook processing, before any job in the run executes, so its only deterministic input is `ctx.event`. A **result-aware** generator instead declares `needs` on upstream jobs/groups, is deferred until those upstreams complete, and receives their frozen runtime outputs as `ctx.needs` — letting it fan out follow-up jobs from what an earlier job actually produced (e.g. job A discovers a list of targets at runtime → generate one `report-<target>` job per target).

### API surface

`dynamicJob` is polymorphic. The function form is unchanged (event-only, dispatched at webhook time). An options-object form `{ needs, generate }` marks a result-aware generator:

```typescript
import { workflow, job, step, push, dynamicJob, dynamicGroup } from '@kici-dev/sdk';

const discover = job('discover', {
  runsOn: 'linux',
  steps: [
    step('emit', {
      outputs: { targets: z.array(z.string()) },
      run: async () => ({ targets: ['a', 'b'] }),
    }),
  ],
});

export default workflow('fan-out', {
  on: [push()],
  jobs: [
    discover,
    dynamicJob('reports', {
      needs: ['discover', dynamicGroup('scan-shards')],
      generate: async ({ ctx }) => {
        const targets = ctx.needs.discover.result.targets; // single job → OutputProxy
        return ctx.needs['scan-shards'].map(
          (
            { name, result }, // group → ordered [{ name, result }]
          ) =>
            job(`report-${name}`, {
              runsOn: 'linux',
              run: async () => report(result.findings),
            }),
        );
      },
    }),
  ],
});
```

- `ctx.needs.<jobName>` (a static / named-job need) is `{ result, status }`: `result` is an `OutputProxy` with the same shape as `jobRef.result` (`ctx.needs.<job>.result.<step>.<field>`; single-step `run` jobs flatten to `ctx.needs.<job>.result.<field>`), and `status` is the upstream's terminal status.
- `ctx.needs.<group>` (a `dynamicGroup(...)` need) is an **ordered array** of `{ name, result, status }`, one entry per group member in the group's deterministic eval order.
- `needs` accepts the same edge shapes as `JobOptions.needs`, including the `{ name, when }` and `dynamicGroup('g', { when })` object forms.

### Deferred-eval dispatch flow

A result-aware generator's eval job becomes a deferred, needs-gated job in the run DAG, reusing the same DB-backed [needs scheduler](#cross-domain-needs) that gates every other edge:

1. At run setup the orchestrator records the eval job (`__dynamic__<workflow>__<index>`) as a pending row with `execution_job_needs` edges to its declared upstreams — instead of dispatching the eval immediately. Group needs expand to their member job names.
2. When those upstreams reach a terminal state, the scheduler signals the eval job is ready. The orchestrator snapshots the now-terminal upstreams' stored outputs into a frozen `{ jobs, groups }` blob and dispatches the eval, threading the snapshot (and the declared needs) into the eval config.
3. The agent builds `ctx.needs` from the snapshot, runs `generate`, and returns the generated jobs. Each generated job's `dynamicSource` carries the same frozen snapshot.
4. Generated jobs flow through the existing environment / secret / protection resolution and dispatch path unchanged.

### Determinism contract

`ctx.needs` resolves against the snapshot **frozen at first eval** and replayed unchanged on the executing agent's re-eval — the same guarantee `ctx.event` carries. Because the upstreams are terminal before the eval dispatches, their outputs are stable; the freeze additionally protects the later, possibly-different-agent re-eval (which rebuilds `ctx.needs` from the frozen snapshot, never a live read). Non-deterministic _content_ inside an upstream's output (e.g. an embedded timestamp) behaves like any other non-deterministic generator input — the author's responsibility.

### Composition and limits

- Same-run result-aware generation and cross-workflow [`jobComplete()`](../../user/sdk/triggers.md) chaining are complementary: use result-aware generation for "this run needs more jobs based on what just ran", and `jobComplete()` for "a different workflow should react to this one finishing".
- The max-100-generated-jobs cap stays per eval invocation; chained result-aware tiers are each independently capped at 100.
- The generator's `needs` reuse the same `when` run-condition semantics as any edge: default `on-success` (an upstream failure skips the generator, so its group is empty) and a wider set like `when: 'always'` (run on any terminal upstream status, where upstream outputs may be partial). Because the generator's frozen snapshot carries each upstream's `status`, a result-aware generator under `when: 'always'` / `'on-failure'` can branch on `ctx.needs.<job>.status` and return `[]` or `[job]` — the arbitrary outcome-based dispatch gate.

## Current limitations

These are intentional constraints:

1. **DynamicJobFn determinism requirement** — the function is re-evaluated by executing agents to extract step closures. A runtime determinism guard validates that re-evaluated job names match the original eval (warns on sibling drift, fails hard on missing target). See [writing deterministic DynamicJobFn](#writing-deterministic-dynamicjobfn) above.
2. **Max 100 generated jobs** per DynamicJobFn invocation.
3. **Eval logging captures everything** — the synthetic "evaluate" step's `LogStreamer` receives three converging streams: explicit `log.info()` / `log.warn()` / `log.error()` / `log.debug()` calls, raw `console.log` / `console.error` / `console.warn` / `console.info` / `console.debug` calls inside the DynamicJobFn body and inside generated-job `environment` / `env` / `concurrencyGroup` / `matrix` functions (captured via `AsyncLocalStorage`-scoped `console.*` patching in `packages/agent/src/execution/console-capture.ts`), and subprocess stdout/stderr from `await $\`...\``inside the same scopes (captured via a per-invocation zx`$` whose log callback feeds the streamer). See [Log streaming](job-execution.md#log-streaming).
4. **Event-only generators see only `ctx.event`** — the bare-function form of a DynamicJobFn is evaluated during webhook processing, before any job runs, so its only deterministic input is `ctx.event`. To generate jobs from a _prior job's result_ in the same run, use the options-object form `dynamicJob(group, { needs, generate })` — it defers the generator until its declared upstreams complete and exposes their frozen outputs as `ctx.needs`. See [Result-aware generation](#result-aware-generation) above.
