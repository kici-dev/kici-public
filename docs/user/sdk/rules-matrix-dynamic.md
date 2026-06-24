---
title: 'SDK reference: rules, matrix, dynamic jobs'
description: rule(), skip(), matrix builds (static + dynamic), and dynamicJob / dynamicGroup
---

## Rules

Rules control conditional execution of workflows and jobs. A rule that returns `false` (or whose check function returns `false`) prevents execution.

### rule(label) / rule(label, check)

Create a rule.

```typescript
function rule(label: string): Rule;
function rule(label: string, check: RuleCheckFn): Rule;
```

**Without check function:** Always passes. Useful as a marker in the decision trace.

```typescript
rule('ci: required check');
```

**With check function:** Passes when the function returns `true`.

```typescript
rule('has source changes', async (ctx) => {
  return ctx.changedFiles.some((f) => f.startsWith('src/'));
});
```

### skip(label, check)

Create a rule that skips when the condition is met. Inverts the check function.

```typescript
function skip(label: string, check: RuleCheckFn): Rule;
```

When the check returns `true` (condition met), the rule returns `false` (skip execution).
When the check returns `false` (condition not met), the rule returns `true` (allow execution).

```typescript
// Skip when only docs changed
skip('docs only PR', async (ctx) => {
  return ctx.changedFiles.every((f) => f.endsWith('.md'));
});
```

### RuleCheckFn

```typescript
type RuleCheckFn = (ctx: RuleContext) => Promise<boolean> | boolean;
```

Can be sync or async. Receives a `RuleContext`:

| Property       | Type                                | Description                                                           |
| -------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `event`        | `EventPayload`                      | The triggering event payload (discriminated union — narrow on `type`) |
| `changedFiles` | `string[]`                          | Files changed in this event                                           |
| `env`          | `Record<string, string\|undefined>` | Environment variables                                                 |
| `$`            | zx shell                            | Shell executor for running commands                                   |

### evaluateRules(rules, context, label, onRuleResult?)

Evaluate an array of rules sequentially with fail-fast behavior. Stops on the first failure.

```typescript
function evaluateRules(
  rules: Rule[],
  context: RuleContext,
  label: string,
  onRuleResult?: (result: RuleResult) => void,
): Promise<RuleEvaluationResult>;
```

Returns a `RuleEvaluationResult`:

```typescript
interface RuleEvaluationResult {
  allPassed: boolean;
  results: RuleResult[];
}
```

### isEventType(event, type)

Type guard that narrows an `EventPayload` to a specific event type variant. Use this in rule check functions to get autocomplete on provider-specific fields.

```typescript
function isEventType<T extends EventPayload['type']>(
  event: EventPayload,
  type: T,
): event is Extract<EventPayload, { type: T }>;
```

**Example — skip draft PRs:**

```typescript
rule('skip-draft-prs', (ctx) => {
  if (!isEventType(ctx.event, 'pull_request')) return true;
  // ctx.event is now PullRequestEventPayload — full autocomplete
  return !ctx.event.payload.pull_request.draft;
});
```

**Example — branch-based rule with push narrowing:**

```typescript
rule('only-main-pushes', (ctx) => {
  if (!isEventType(ctx.event, 'push')) return false;
  // ctx.event.payload.ref is typed as string
  return ctx.event.payload.ref === 'refs/heads/main';
});
```

You can also narrow directly with `if (ctx.event.type === 'pull_request')` — TypeScript's discriminated union narrowing works on the `type` field.

### EventPayload

`EventPayload` is a discriminated union over the `type` field. Each variant provides typed access to the normalized event fields and the raw webhook payload.

Every variant carries the shared `EventBase` fields — `type`, `action`, `targetBranch`, `sourceBranch`, `provider`, `isForkPR`, `baseBranch`, `senderUsername`, `sourceRepo`, `changedFiles`, and the raw `payload` — plus a per-type `payload` shape for the typed variants. The complete field-by-field schema, including every typed `payload` shape and the shared GitHub object types, is in the [event payload reference](./event-payloads.md).

**Typed variants** (with GitHub-specific payload fields): `pull_request`, `push`, `tag`, `comment`, `review`, `review_comment`, `release`, `dispatch`, `create`, `delete`, `status`, `workflow_run`, `fork`, `star`, `watch`.

**Generic variants** (payload is `Record<string, unknown>`): `webhook`, `kici_event`, `workflow_complete`, `job_complete`, `generic_webhook`, `schedule`, `lifecycle`.

## Matrix

Matrix configurations expand a single job into multiple instances, one per parameter combination. Maximum 256 combinations.

Expansion happens at **dispatch time**: the orchestrator materializes the matrix into N execution jobs — one per combination, each dispatched to its own agent — before any job runs. Each instance receives its combination as `ctx.matrix`. This is identical whether the workflow runs via `kici run local` or remotely through a webhook trigger, and the dashboard groups the N instances under one parent node.

### Static array (single dimension)

```typescript
matrix: ['18', '20', '22'];
```

Creates 3 job instances. In steps, the current value is `matrix.value`:

```typescript
step('test', async ({ $, matrix }) => {
  console.log(matrix!.value); // '18', '20', or '22'
});
```

### Static object (multi-dimensional)

```typescript
matrix: {
  os: ['linux', 'arm64'],
  node: ['18', '20'],
}
```

Creates 4 job instances (2 x 2). The `os` values (`linux`, `arm64`) are **customer-defined scaler labels** matched by subset semantics against the labels your orchestrator advertises in its scaler `labelSets` — not hosted-runner names. In steps, values are named properties:

```typescript
step('test', async ({ $, matrix }) => {
  console.log(matrix!.os); // 'linux' or 'arm64'
  console.log(matrix!.node); // '18' or '20'
});
```

### Dynamic function

Compute matrix values at runtime:

```typescript
matrix: async ({ $ }) => {
  const result = await $`ls packages/`;
  return result.stdout.trim().split('\n');
};
```

The function receives a `DynamicMatrixContext`:

| Property | Type                                | Description               |
| -------- | ----------------------------------- | ------------------------- |
| `$`      | zx shell                            | Shell executor            |
| `ctx`    | `{ workflow, job }`                 | Workflow and job metadata |
| `log`    | `Logger`                            | Structured logger         |
| `env`    | `Record<string, string\|undefined>` | Environment variables     |

Must return `string[]` (single dimension) or `Record<string, string[]>` (multi-dimensional).

A dynamic matrix is resolved at runtime, then materialized into N instances exactly like a static matrix. Because the combinations are not known until the function runs, the 256-combination cap (and the "zero combinations" guard) is enforced at that point: a dynamic matrix that resolves to more than 256 combinations, or to none, fails the job with a matrix-expansion error rather than dispatching.

### Include and exclude

Fine-tune matrix combinations on multi-dimensional matrices:

```typescript
matrix: {
  os: ['linux', 'arm64', 'windows'],
  node: ['18', '20', '22'],
},
exclude: [
  { os: 'windows', node: '18' },
],
include: [
  { os: 'linux', node: '23' },
],
```

**Exclude** removes combinations matching all specified keys. Applied first.
**Include** adds exact combinations. Applied after exclude.

Types:

```typescript
type MatrixInclude = Record<string, string>;
type MatrixExclude = Record<string, string>;
```

### MatrixValues

The shape of `matrix` in `StepContext`:

```typescript
interface MatrixValues {
  value?: string; // Single-dimension value
  [dimension: string]: string | undefined; // Named dimensions
}
```

### Bounding matrix concurrency (maxParallel / failFast)

A matrix fan-out runs every combination at once by default. The fan-out-generic
`maxParallel` and `failFast` job options bound it the same way they bound a
[`runsOnAll`](./runs-on-all.md#rolling-rollout-maxparallel--failfast) host fan-out:

```typescript
const test = job('test', {
  runsOn: 'linux',
  matrix: { os: ['ubuntu', 'macos', 'windows'] },
  maxParallel: 1, // run one combination at a time (sliding window)
  failFast: true, // stop launching combinations after the first failure
  run: async (ctx) => {
    /* ctx.matrix.os */
  },
});
```

`maxParallel` is a sliding window (each combination that finishes releases the next;
`1` = serial; must be `>= 1`); `failFast` halts the fan-out on the first failure and
skips the held remainder (default `false`). They are ignored on a job with no `matrix`
or `runsOnAll`.

### Consuming matrix outputs downstream

A downstream job that lists a matrix job in its `needs` receives a **keyed envelope** instead of a flat outputs object, because the upstream produced N sets of outputs (one per combination). `ctx.jobOutputs(matrixJob)` returns a `MatrixJobOutputs`:

```typescript
interface MatrixJobOutputs<T = Record<string, unknown>> {
  /** Keyed by the combination suffix — the text inside `(...)` of the child name. */
  byMatrix: Record<string, T>;
  /** Last-write-wins flat merge across children, in child (name) order. */
  merged: T;
}
```

The suffix key matches the child job's display name: `byMatrix['a']` for a single-dimension `['a', 'b']` matrix, `byMatrix['linux, arm64']` for a multi-dimension combination. Use `isMatrixJobOutputs` (or `'byMatrix' in result`) to discriminate:

```typescript
import { isMatrixJobOutputs } from '@kici-dev/sdk';

step('collect', async ({ jobOutputs }) => {
  const out = jobOutputs(buildMatrixJob);
  if (isMatrixJobOutputs(out)) {
    console.log(out.byMatrix['a']); // outputs of the `a` combination
    console.log(out.merged); // last-write-wins across all combinations
  }
});
```

The downstream job waits for **all** matrix combinations to terminate before it dispatches. A non-matrix upstream keeps the flat outputs shape. The envelope is identical under `kici run local` and the remote path.

### Matrix type guards

```typescript
import { isStaticArray, isStaticObject, isDynamicFunction } from '@kici-dev/sdk';

isStaticArray(matrix); // true if string[]
isStaticObject(matrix); // true if Record<string, string[]>
isDynamicFunction(matrix); // true if async function
```

### Matrix expansion utilities

```typescript
import { expandMatrix, applyIncludeExclude } from '@kici-dev/sdk';
```

`expandMatrix(matrix)` takes a `StaticMatrixArray` or `StaticMatrixObject` and returns all combinations as `MatrixValues[]`. For a single-dimension array, each value becomes `{ value: '...' }`. For multi-dimensional objects, it produces the Cartesian product.

`applyIncludeExclude(values, include?, exclude?)` filters an expanded matrix: removes combinations matching any exclude entry, then appends include entries. Returns the filtered `MatrixValues[]`.

## Dynamic jobs

Generate jobs at runtime using async factory functions.

### DynamicJobFn

```typescript
type DynamicJobFn = (context: DynamicJobContext) => Promise<Job[]>;
```

Receives a `DynamicJobContext`:

| Property | Type                                | Description                 |
| -------- | ----------------------------------- | --------------------------- |
| `$`      | zx shell                            | Shell executor              |
| `ctx`    | `{ workflow, event? }`              | Workflow metadata and event |
| `log`    | `Logger`                            | Structured logger           |
| `env`    | `Record<string, string\|undefined>` | Environment variables       |

```typescript
const discoverJobs: DynamicJobFn = async ({ $ }) => {
  const result = await $`ls packages/`;
  const packages = result.stdout.trim().split('\n');
  return packages.map((pkg) =>
    job(`test-${pkg}`, {
      runsOn: 'linux',
      steps: [
        step('test', async ({ $ }) => {
          await $`cd packages/${pkg} && pnpm test`;
        }),
      ],
    }),
  );
};

export default workflow('ci', {
  jobs: [discoverJobs],
});
```

### dynamicJob — result-aware generation

`dynamicJob(group, fnOrConfig)` tags a generator with a group name (so static jobs can depend on it via `needs: [dynamicGroup('group')]`). It is polymorphic:

- **Function form** — event-only, dispatched at webhook time: `dynamicJob('shards', async ({ ctx }) => [...])`.
- **Options-object form** — result-aware, deferred until its declared `needs` complete, then run with the upstreams' frozen outputs as `ctx.needs`: `dynamicJob('reports', { needs, generate })`.

```typescript
import { workflow, job, step, dynamicJob, dynamicGroup, z } from '@kici-dev/sdk';

// Upstream job A discovers a list of targets at runtime.
const discover = job('discover', {
  runsOn: 'linux',
  steps: [
    step('emit', {
      outputs: { targets: z.array(z.string()) },
      run: async () => ({ targets: ['api', 'web'] }),
    }),
  ],
});

// Result-aware generator fans out one report job per discovered target.
const reports = dynamicJob('reports', {
  needs: ['discover'],
  generate: async ({ ctx }) => {
    const targets = ctx.needs.discover.result.targets; // OutputProxy over discover's outputs
    return targets.map((target) =>
      job(`report-${target}`, {
        runsOn: 'linux',
        run: async ({ log }) => log.info(`reporting on ${target}`),
      }),
    );
  },
});

export default workflow('discovery-fan-out', { jobs: [discover, reports] });
```

`ctx.needs` shape:

| Need form                                           | `ctx.needs[...]` value                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'jobName'` / `{ name, when }`                      | `{ result, status }` — `result` is an `OutputProxy` (`ctx.needs.<job>.result.<step>.<field>`; single-step `run` jobs flatten to `ctx.needs.<job>.result.<field>`); `status` is the upstream's terminal status |
| `dynamicGroup('g')` / `dynamicGroup('g', { when })` | ordered array of `{ name, result, status }`, one per group member                                                                                                                                             |

`ctx.needs` is deterministic — a snapshot of upstream outputs frozen at first eval and replayed unchanged on re-eval, like `ctx.event`. Use result-aware generation for same-run fan-out from a prior job's result; use [`jobComplete()`](./triggers.md) for cross-workflow reactions to a job finishing. See the architecture deep-dive in [dynamic jobs](../../architecture/execution/dynamic-jobs.md#result-aware-generation).

### JobOrFactory

The `jobs` array in `WorkflowOptions` accepts both static jobs and dynamic generators:

```typescript
type JobOrFactory = Job | DynamicJobFn;
```

### isDynamicJobFn(item)

Type guard to distinguish static jobs from dynamic generators:

```typescript
function isDynamicJobFn(item: JobOrFactory): item is DynamicJobFn;
```

```typescript
for (const item of workflow.jobs) {
  if (isDynamicJobFn(item)) {
    const generatedJobs = await item(context);
  } else {
    // item is Job
  }
}
```
