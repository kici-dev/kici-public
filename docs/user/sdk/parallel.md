---
title: 'SDK reference: parallel'
description: Run independent steps concurrently within a single job, each as its own observable step
---

`parallel([...steps], opts?)` runs a group of independent steps **concurrently**
within one job, behind a join barrier: execution continues past the group only
once every child has settled. Each child is its own observable step — it gets its
own logs, status, timing, and retry — instead of being hidden inside one step's
`Promise.all`.

```ts
import { workflow, job, step, parallel, push } from '@kici-dev/sdk';

export default workflow('ci', {
  on: push(),
  jobs: [
    job('checks', {
      runsOn: 'kici:os:linux',
      steps: [
        checkout,
        // lint, typecheck, and the unit tests have no ordering between them,
        // so they run together — the job's wall-clock is the slowest child,
        // not the sum of all three.
        parallel([lint, typecheck, unitTests], { failFast: true }),
        deploy,
      ],
    }),
  ],
});
```

`parallel(...)` returns a `ParallelGroup` that sits in the ordinary flat
`steps: [...]` array — there is no new `job` field. A group's children are
**sequential steps only**; groups cannot be nested.

## Options

`parallel(steps, opts?)` accepts:

- **`failFast?: boolean`** — default `true`. When a child fails, the in-flight
  siblings are cancelled immediately and the job fails. With `failFast: false`
  every child runs to completion first, then the job fails if any child failed.
- **`maxParallel?: number`** — default unlimited. Caps how many children run at
  once; children waiting for a slot report a `pending` status until they launch.
- **`name?: string`** — a label for the group's dashboard band.

A child marked `continueOnError: true` never trips fail-fast and never fails the
job — it still shows a `failed` status badge, but the group treats it as
non-fatal.

## Statuses

Parallel steps introduce two step statuses:

- **`pending`** — a child queued behind `maxParallel`, not yet launched.
- **`cancelled`** — a sibling aborted by fail-fast. A cancelled step is **not** a
  failure: only the child that actually failed fails the job; the cancelled
  siblings render in gray (distinct from the red failing step) on the dashboard.

Children may also complete **out of order** — the fastest child finishes first
regardless of array position. A later sequential step can read a parallel child's
`.result` after the barrier; children within a group cannot read each other's
results (there is no ordering inside the group).

## Scope: nests inside job-level fan-out

`parallel()`'s `failFast` / `maxParallel` are **step-group** scopes — they govern
only the steps inside the group. They are a different layer from the **job-level**
`failFast` / `maxParallel` on a matrix / `runsOnAll` fan-out, which govern how a
job's child _jobs_ spread across the matrix or host roster. A `parallel()` group
inside a fan-out job nests its concurrency inside each fan-out child.

## Local vs remote execution

Run remotely (the orchestrator + agent), parallel children execute concurrently
and each surfaces as its own dashboard step. `kici run local` executes the same
children in array order in its single-process model — the results are identical,
only the wall-clock and the live fail-fast cancellation differ. Use a remote run
to observe the concurrent timeline.
