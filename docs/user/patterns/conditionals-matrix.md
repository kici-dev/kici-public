---
title: Conditionals & matrix patterns
description: Conditional execution with rules, matrix builds (static + dynamic), dynamic job generation
---

Rules control whether a workflow or job runs. Use `rule()` for conditions that must pass, and `skip()` for conditions that should skip execution.

### Workflow-level rules

```typescript
import { workflow, job, step, pr, rule } from '@kici-dev/sdk';

const test = job('test', {
  runsOn: 'linux',
  steps: [
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});

export default workflow('ci', {
  on: pr(),
  rules: [
    rule('has source changes', async (ctx) => {
      return ctx.changedFiles.some((f) => f.startsWith('src/'));
    }),
  ],
  jobs: [test],
});
```

### Job-level rules

```typescript
import { workflow, job, step, pr, rule, skip } from '@kici-dev/sdk';

const unitTests = job('unit-tests', {
  runsOn: 'linux',
  steps: [
    step('test', async ({ $ }) => {
      await $`pnpm test:unit`;
    }),
  ],
});

const e2eTests = job('e2e-tests', {
  runsOn: 'linux',
  rules: [
    // Skip E2E when only docs change
    skip('docs only', async (ctx) => {
      return ctx.changedFiles.every((f) => f.endsWith('.md'));
    }),
  ],
  steps: [
    step('test', async ({ $ }) => {
      await $`pnpm test:e2e`;
    }),
  ],
});

export default workflow('ci', {
  on: pr(),
  jobs: [unitTests, e2eTests],
});
```

### Rule context

Rule check functions receive a `RuleContext` with:

| Property       | Type                                | Description                         |
| -------------- | ----------------------------------- | ----------------------------------- |
| `event`        | `EventPayload`                      | The triggering event data           |
| `changedFiles` | `string[]`                          | Files changed in this event         |
| `env`          | `Record<string, string\|undefined>` | Environment variables               |
| `$`            | zx shell                            | Shell executor for running commands |

### Marker rules

A rule without a check function always passes. Useful for labeling in the decision trace:

```typescript
rule('ci: required check');
```

## Matrix builds

Matrix configurations run a job across multiple parameter combinations.

### Simple array matrix

Run a job for each value in an array:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

const test = job('test', {
  runsOn: 'linux',
  matrix: ['18', '20', '22'],
  steps: [
    step('test', async ({ $, matrix }) => {
      await $`nvm use ${matrix!.value}`;
      await $`pnpm test`;
    }),
  ],
});

export default workflow('test-matrix', {
  on: push(),
  jobs: [test],
});
```

With a single-dimension matrix, the current value is available as `matrix.value` in the step context.

### Multi-dimensional matrix

Use an object to define multiple dimensions. KiCI expands all combinations (capped at 256):

```typescript
const test = job('test', {
  runsOn: ['linux', 'kici:agent:container'],
  matrix: {
    os: ['linux', 'arm64'],
    node: ['18', '20', '22'],
  },
  steps: [
    step('test', async ({ $, matrix }) => {
      // matrix.os = 'linux' | 'arm64'
      // matrix.node = '18' | '20' | '22'
      await $`echo "Testing on ${matrix!.os} with Node ${matrix!.node}"`;
      await $`pnpm test`;
    }),
  ],
});
```

This creates 6 job instances (2 OS x 3 Node versions).

> **Labels are customer-defined.** `runsOn` values such as `linux` or `arm64` are scaler
> labels **you** define in your orchestrator's `labelSets` — they are matched by subset
> semantics, not by a hosted-runner name. You can also target reserved auto-injected labels
> in the `kici:` namespace (e.g. `kici:agent:firecracker`, `kici:agent:container`) to pin a
> job to a specific backend type.

### Include and exclude

Fine-tune matrix combinations:

```typescript
const test = job('test', {
  runsOn: 'linux',
  matrix: {
    os: ['linux', 'arm64', 'windows'],
    node: ['18', '20', '22'],
  },
  // Remove specific combination
  exclude: [{ os: 'windows', node: '18' }],
  // Add specific combination not in the matrix
  include: [{ os: 'linux', node: '23' }],
  steps: [
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});
```

Exclude is applied first (removes matching combinations), then include adds additional entries.

### Dynamic matrix

Compute matrix values at runtime using an async function:

```typescript
const test = job('test', {
  runsOn: 'linux',
  matrix: async ({ $ }) => {
    // Discover packages in a monorepo
    const result = await $`ls packages/`;
    return result.stdout.trim().split('\n');
  },
  steps: [
    step('test', async ({ $, matrix }) => {
      await $`cd packages/${matrix!.value} && pnpm test`;
    }),
  ],
});
```

Dynamic matrix functions receive the same context as dynamic job functions (`$`, `ctx`, `log`, `env`).

### Matrix type guards

Use type guards to inspect matrix configuration at compile time:

```typescript
import { isStaticArray, isStaticObject, isDynamicFunction } from '@kici-dev/sdk';

if (isStaticArray(myMatrix)) {
  // string[]
}
if (isStaticObject(myMatrix)) {
  // Record<string, string[]>
}
if (isDynamicFunction(myMatrix)) {
  // async function
}
```

## Dynamic job generation

Generate jobs at runtime using async factory functions. Useful for monorepos or when the set of jobs depends on the repository state:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';
import type { DynamicJobFn } from '@kici-dev/sdk';

const discoverAndTest: DynamicJobFn = async ({ $ }) => {
  // Discover packages at runtime
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

export default workflow('monorepo-ci', {
  on: push(),
  jobs: [discoverAndTest],
});
```

### Mixing static and dynamic jobs

The `jobs` array accepts both static `Job` objects and `DynamicJobFn` functions:

```typescript
const lint = job('lint', {
  runsOn: 'linux',
  steps: [
    step('lint', async ({ $ }) => {
      await $`pnpm lint`;
    }),
  ],
});

export default workflow('monorepo-ci', {
  on: push(),
  jobs: [lint, discoverAndTest],
});
```

Static jobs and dynamic generators live side by side. The `isDynamicJobFn()` type guard distinguishes them at runtime.

## Combining patterns

A full example combining triggers, rules, matrix, and job dependencies:

```typescript
import { workflow, job, step, pr, push, rule, skip } from '@kici-dev/sdk';

// Only run on PRs targeting main with source changes
const prTrigger = pr({ target: 'main', paths: ['src/**', 'packages/**', '!**/*.md'] });

// Also run on pushes to main
const pushTrigger = push({ branches: 'main' });

const lint = job('lint', {
  runsOn: 'linux',
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('lint', async ({ $ }) => {
      await $`pnpm lint`;
    }),
  ],
});

const test = job('test', {
  runsOn: 'linux',
  needs: [lint],
  matrix: { node: ['18', '20', '22'] },
  steps: [
    step('test', async ({ $, matrix }) => {
      await $`pnpm test`;
    }),
  ],
});

const deploy = job('deploy', {
  runsOn: 'linux',
  needs: [test],
  rules: [
    // Only deploy from push events (not PRs)
    rule('push event only', async (ctx) => {
      return ctx.event.type === 'push';
    }),
  ],
  steps: [
    step('deploy', async ({ $ }) => {
      await $`pnpm build && pnpm deploy`;
    }),
  ],
});

export default workflow('full-pipeline', {
  on: [prTrigger, pushTrigger],
  rules: [
    skip('docs only', async (ctx) => {
      return ctx.changedFiles.every((f) => f.endsWith('.md'));
    }),
  ],
  jobs: [lint, test, deploy],
});
```

This workflow:

1. Triggers on PRs targeting main (with path filters) and pushes to main
2. Skips entirely if only docs files changed (workflow-level `skip` rule)
3. Runs lint first, then tests across 3 Node versions in parallel
4. Deploys only on push events (not on PRs), after all tests pass

## Workflow chaining
