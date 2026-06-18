---
title: Basic workflow patterns
description: Basic CI, PR-only / push-only filters, multiple triggers, manual-only workflows
---

A standard lint-then-test pipeline using job dependencies (`needs`):

```typescript
import { workflow, job, step, pr } from '@kici-dev/sdk';

const lint = job('lint', {
  runsOn: 'linux',
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('check', async ({ $ }) => {
      await $`pnpm lint`;
      await $`pnpm format:check`;
    }),
  ],
});

const test = job('test', {
  runsOn: 'linux',
  needs: [lint],
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});

const typecheck = job('typecheck', {
  runsOn: 'linux',
  needs: [lint],
  steps: [
    step('install', async ({ $ }) => {
      await $`pnpm install --frozen-lockfile`;
    }),
    step('typecheck', async ({ $ }) => {
      await $`pnpm typecheck`;
    }),
  ],
});

export default workflow('ci', {
  on: pr({ target: 'main' }),
  jobs: [lint, test, typecheck],
});
```

The `test` and `typecheck` jobs both depend on `lint`, so they run in parallel after lint succeeds. KiCI validates the dependency graph at compile time -- cycles and missing references are caught before you commit. At runtime, jobs are gated on upstream completion: a job only dispatches after every entry in its `needs` array reaches a terminal state. If an upstream fails, downstream jobs skip by default (override per-edge with `ifFailed: 'run'`). See [Job dependencies (`needs`)](../sdk/core.md#job-dependencies-needs) in the SDK reference for the full matrix of `needs` forms (string, `Job` ref, `{ name, ifFailed }`, `dynamicGroup()`) and [needs-scheduler](../../architecture/execution/needs-scheduler.md) for the dispatch semantics.

**Single-step jobs don't need a `steps` array.** When a job only does one thing, pass `run` to `job()` instead of wrapping it in `steps: [step(...)]`:

```typescript
import { job, workflow, push } from '@kici-dev/sdk';

const smoke = job('smoke', {
  runsOn: 'default',
  run: async ({ $, log }) => {
    await $`curl -fsS https://example.com/health`;
    log.info('Health check passed');
  },
});

export default workflow('smoke', {
  on: push({ branches: 'main' }),
  jobs: [smoke],
});
```

`run` is mutually exclusive with `steps` (throws at compile time if both are set). Outputs are flat on `job.result` (no step-name nesting). See [Single-step job shorthand](../sdk/core.md#single-step-job-shorthand) in the SDK reference.

## PR-only workflow with branch filters

Use `pr()` to filter by events, target branches, source branches, and file paths:

```typescript
import { workflow, job, step, pr } from '@kici-dev/sdk';

// Only trigger on opened/synchronize events targeting main,
// and only when source code files change
const trigger = pr({
  events: ['opened', 'synchronize'],
  target: ['main', 'develop'],
  paths: ['src/**', 'packages/**', '!**/*.md', '!docs/**'],
});

const build = job('build', {
  runsOn: 'linux',
  steps: [
    step('build', async ({ $ }) => {
      await $`pnpm build`;
    }),
  ],
});

export default workflow('pr-checks', {
  on: trigger,
  jobs: [build],
});
```

### PR trigger options

| Option        | Type                                       | Description                                                                                 |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `target`      | `string \| RegExp \| (string \| RegExp)[]` | Match target branches (glob or regex)                                                       |
| `source`      | `string \| RegExp \| (string \| RegExp)[]` | Match source branches (glob or regex)                                                       |
| `events`      | `PrEvent[]`                                | Filter PR event types                                                                       |
| `paths`       | `string[]`                                 | Only trigger when matching files change. Use `!` prefix for exclusions (e.g., `'!docs/**'`) |
| `description` | `string`                                   | Add a human-readable description                                                            |

Default PR events (when `events` is not specified): `opened`, `synchronize`, `reopened`, `closed`.

## Push trigger with branch filters

Use `push()` for push-based workflows:

```typescript
import { workflow, job, step, push } from '@kici-dev/sdk';

// Deploy on pushes to main
const deploy = job('deploy', {
  runsOn: 'linux',
  steps: [
    step('deploy', async ({ $ }) => {
      await $`pnpm build`;
      await $`pnpm deploy`;
    }),
  ],
});

export default workflow('deploy', {
  on: push({ branches: 'main' }),
  jobs: [deploy],
});
```

### Push trigger options

| Option        | Type                                       | Description                                                                                 |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `branches`    | `string \| RegExp \| (string \| RegExp)[]` | Match branch names (glob or regex)                                                          |
| `tags`        | `string \| RegExp \| (string \| RegExp)[]` | Match tag names (glob or regex)                                                             |
| `paths`       | `string[]`                                 | Only trigger when matching files change. Use `!` prefix for exclusions (e.g., `'!docs/**'`) |
| `description` | `string`                                   | Add a human-readable description                                                            |

### Regex branch patterns

Both `pr()` and `push()` accept regex patterns alongside glob strings:

```typescript
// Glob pattern
push({ branches: 'release/*' });

// Regex pattern
push({ branches: /^release\/v\d+\.\d+$/ });
```

## Multiple triggers

A workflow can respond to multiple trigger types:

```typescript
import { workflow, job, step, pr, push } from '@kici-dev/sdk';

const test = job('test', {
  runsOn: 'linux',
  steps: [
    step('test', async ({ $ }) => {
      await $`pnpm test`;
    }),
  ],
});

export default workflow('ci', {
  on: [pr({ target: 'main' }), push({ branches: 'main' })],
  jobs: [test],
});
```

## Manual / local-only workflow (no git events)

Sometimes you want a workflow that does **not** fire on pushes, pull requests, tags, or any other git activity — only when you explicitly ask for it. Use `dispatch()` as the trigger: it corresponds to GitHub's `repository_dispatch` event, which is never emitted by commits, PRs, tags, releases, or any other automatic git action. The workflow stays idle until someone explicitly invokes it.

There are two ways to "explicitly invoke" a `dispatch()` workflow:

1. **Locally from your laptop**, with `kici run local dispatch` — no orchestrator, no agent, no webhook, nothing deployed. This is the only path while you haven't wired the repo to a deployed KiCI orchestrator.
2. **Remotely**, if the repo is connected to a KiCI orchestrator via a GitHub App, by calling GitHub's repository-dispatch API: `curl -X POST -H "Authorization: token <PAT>" -H "Accept: application/vnd.github+json" https://api.github.com/repos/<owner>/<repo>/dispatches -d '{"event_type":"hello"}'`. GitHub fans the webhook out to the App, the orchestrator normalizes it into a KiCI `dispatch` event (see `packages/orchestrator/src/providers/github/normalizer.ts`), and the matched workflow runs.

Note that GitHub's `workflow_dispatch` event (the "Run workflow" button / `/actions/workflows/.../dispatches` API) is GitHub-Actions-internal and is **not** delivered to KiCI. The SDK has no `workflowDispatch()` trigger. Only `repository_dispatch` reaches KiCI.

```typescript
import { workflow, job, step, dispatch } from '@kici-dev/sdk';

export default workflow('hello-world', {
  on: dispatch(),
  jobs: [
    job('greet', {
      runsOn: 'linux',
      steps: [
        step('say-hello', async ({ $ }) => {
          await $`echo "Hello, World!"`;
        }),
      ],
    }),
  ],
});
```

Run it locally, without any orchestrator or agent infrastructure:

```bash
npx kici compile           # regenerate .kici/kici.lock.json
npx kici run local dispatch
```

`kici run local` compiles the workflow, matches triggers against a simulated `dispatch` event, and executes the matched jobs directly on your machine with DAG-based scheduling. No webhook, no GitHub, no deployed orchestrator involved. See [`kici run local`](../cli-reference.md#kici-run-local) for options like `--job`, `--env`, `--json`, and `--junit`.

### Scoping to a single workflow

Because `kici run local dispatch` matches **every** workflow that listens for a `dispatch` event, running it in a repo with several dispatch-triggered workflows will fire all of them. Narrow execution to one with `--workflow <name>`:

```bash
npx kici run local dispatch --workflow hello-world
```

`--workflow` is a post-match filter: the workflow still has to have a trigger that matches the event argument. If `hello-world` does not list a `dispatch()` trigger, the command reports `No workflow named "hello-world" matched the event` and exits successfully without running anything.

If you do not want to memorise event args, use the interactive picker instead:

```bash
npx kici run local --pick
```

`--pick` (aliased as `-p`) lists every workflow alongside a compact summary of its triggers, lets you select one, and derives a matching event arg from the chosen trigger — so the execution still flows through the normal trigger-matching pipeline and "cannot produce an inconsistent run". Multi-trigger workflows show a second prompt for which trigger to simulate. `--pick` is mutually exclusive with `--workflow`; in a non-TTY shell it prints the workflow list and exits without running anything.

### Unfiltered vs typed `dispatch()`

Leave `dispatch()` unfiltered while you drive it from `kici run local`. The CLI currently simulates a dispatch event with no event type (i.e. `action` is undefined), so a trigger defined as `dispatch({ types: ['deploy', 'rollback'] })` will not match `kici run local dispatch` — the typed form is intended for real `repository_dispatch` deliveries from the orchestrator.

## Conditional execution with rules
