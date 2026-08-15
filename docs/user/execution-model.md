---
title: How your workflow code executes
description: When and where your workflow TypeScript runs — compile time, orchestrator time, and agent time
---

Your workflow is plain TypeScript, but different parts of it run at three distinct moments, on three different machines. Knowing which part runs where is the difference between a workflow that behaves and one that surprises you. This page is the map.

## The three phases

| Phase            | Where it runs                            | What runs                                                                                                                                               | When                      |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Compile**      | Your dev machine or CI (`kici compile`)  | Load your workflow modules, validate the DAG, assign step IDs, emit `kici.lock.json`                                                                    | Before anything is pushed |
| **Orchestrator** | Your orchestrator (no repo clone)        | Match triggers against the lock and dispatch jobs; it never evaluates workflow code                                                                     | On each incoming event    |
| **Agent**        | An ephemeral agent (fresh clone per job) | Load the workflow module, evaluate job and step rules, run step bodies and hooks, run dynamic-value init steps and `dynamicJob` generators (both forms) | After dispatch            |

The lock file is the seam. Everything left of it is decided once at compile time and frozen into JSON; everything right of it reads that JSON. See [the lock file and workflow drift](./lock-file-and-drift.md) and [the three-tier architecture](../architecture/overview.md) for the wider picture.

## Compile time

`kici compile` loads your `.kici/workflows/*.ts`, validates dependencies (no cycles, no missing `needs`), assigns compile-time step IDs (unnamed steps become `step-1`, `step-2`, …), and writes `kici.lock.json`.

The compiler runs your module's **top-level code** to build the workflow object — but that execution's side effects and in-memory state do not travel. Only the resulting workflow structure lands in the lock. Anything your top-level code computes that isn't part of the returned workflow object simply doesn't exist past this point.

See [compile the workflow](./getting-started.md#compile-the-workflow) for the command in context.

## What serializes into the lock file

The lock is portable JSON. It carries:

- Workflow and trigger metadata.
- The job and step DAG, with compile-time step IDs.
- Static values, verbatim.
- Markers noting which fields are dynamic, so the orchestrator knows to resolve them on the agent's init step.

It does **not** carry:

- Your module's runtime state or module-level variables.
- Closures over those variables.
- Live instances of modules you imported.
- Anything computed at top level that isn't part of the returned workflow object.

The consequence is blunt: if a value isn't in the lock, the orchestrator can't see it — it has no copy of your repository.

## Orchestrator time

On each event the orchestrator matches triggers using only the lock — it never clones your repository and never evaluates workflow code. Dynamic `context`, `env`, and `concurrencyGroup` functions are not run here: the orchestrator dispatches a short init step to an agent to resolve them (see below).

Trigger matching can query the **contents** of individual source files, not just their paths: a `pr()`, `push()`, or `tag()` trigger with a [`requires`](./sdk/triggers.md#content-requirements-requires) filter is matched by reading the named files at the event's commit and evaluating the filter as declarative data — still with no repository clone and no workflow code executed. A `requires` regex is checked for catastrophic (ReDoS) shapes at `kici compile` time and rejected there, so only safe patterns reach the orchestrator.

The orchestrator also does **not** run `dynamicJob` generator bodies itself: for the event-only (function) form it dispatches a dedicated dynamic-evaluation job to an agent at event time; the generator function then runs agent-side (see below).

See [dynamic values](./dynamic-values.md) for how dynamic `context`, `env`, and `concurrencyGroup` functions resolve.

## Agent time

After dispatch, each job runs in its own ephemeral agent sandbox: a shallow clone at the dispatch ref (or a source-tarball extract for non-build jobs), then the workflow module is loaded fresh — TypeScript is transformed on import. On the agent, in order:

1. **Job-level rules** are evaluated. By this point the agent has already spawned and the source has already been restored, so a job that its rules skip has **still** paid for that spawn and clone; only its steps are avoided.
2. **Step-level rules**, then each step's `run()` body and its hooks.
3. **Dynamic values** (`context`, `env`, `concurrencyGroup` functions) are resolved here, via a short `__init__` job that runs the function before the real job runs; this shows in the run timeline as an `Init:` entry.
4. **`dynamicJob` generators run here — both forms.** The event-only (function) form runs in a dedicated evaluation job dispatched at event time; the result-aware (options) form is deferred until its declared `needs` complete, then run with the upstream outputs frozen as `ctx.needs`.

See [job execution](../architecture/execution/job-execution.md) and [hooks and rules](./hooks.md) for the details.

## What re-evaluates where

| Construct                    | Runs on          | When                            |
| ---------------------------- | ---------------- | ------------------------------- |
| Static value                 | Compile → lock   | Never re-evaluated              |
| Dynamic value                | Agent init step  | Per event                       |
| Job-level rules              | Agent            | After clone                     |
| Step-level rules             | Agent            | Per step                        |
| `dynamicJob` (function form) | Agent (eval job) | Dispatched at event time        |
| `dynamicJob` (options form)  | Agent            | Deferred until `needs` complete |
| Step / job body + hooks      | Agent            | Per job                         |

**Determinism note.** `ctx.event` and `ctx.needs` are frozen snapshots — captured once and replayed unchanged on any re-evaluation. A generator that derives its output from them is stable across re-evaluations; one that reads the wall clock (`Date.now()`) or a random source (`Math.random()`) is not.

## OutputProxy: how outputs flow

`step(...).result` and `job(...).result` return an `OutputProxy` — a lazy proxy that, at the type level, mirrors the shape of the step or job's declared outputs so that reading `result.foo` is type-checked, and at runtime defers each property read to a shared outputs map populated as the run progresses.

```typescript
import { workflow, job, step, z } from '@kici-dev/sdk';

const build = job('build', {
  runsOn: 'default',
  steps: [
    step('compile', {
      outputs: { artifact: z.string() },
      run: async () => ({ artifact: 'app.tar.gz' }),
    }),
    step('publish', {
      // `compile.result.artifact` is typed from the `outputs` schema above.
      run: async ({ steps }) => {
        await Promise.resolve(steps.compile.result.artifact);
      },
    }),
  ],
});

export default workflow('build-and-publish', { jobs: [build] });
```

Outputs are typed across the job boundary too: reading `jobRef.result.…` or `ctx.jobOutputs(jobRef)` on a **job reference** threads the upstream job's inferred output shape through — from any job, in a step body or a `run:` shorthand — so a typo on an output field or a renamed step is a compile error. Typed `ctx.needs.jobRef.result.…` additionally works in a `run:` shorthand job (where the run function's `ctx` derives from the enclosing job's `needs` tuple). Name your steps and use the options form (`step('name', { run })`) to give a job a typed output shape, and pass references rather than string names — string-form `needs` stay loosely typed. See [output chaining](./sdk/core.md#output-chaining) for the authoring rules.

## Common footguns

| Symptom                                                                   | Why                                                                                                                            | Fix                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A top-level `let seen = 0` (or a cache filled in job A) is empty in job B | Each job loads the workflow module fresh in its own agent process after its own clone — there is no shared memory between jobs | Pass data through step/job **outputs** (`OutputProxy` / `needs`), not module variables                                                   |
| Fan-out job identities shift between re-evaluations                       | `ctx.event` / `ctx.needs` are frozen and replayed, but `Date.now()` / `Math.random()` are not                                  | Derive job identity only from the frozen event/needs snapshot                                                                            |
| A rule-skipped job still spawned an agent and cloned                      | Job-level rules evaluate agent-side, after dispatch and clone — not on the orchestrator                                        | This is by design: rules can read true runtime context (`$`, `changedFiles`, `env`). See [step-level rules](./hooks.md#step-level-rules) |

## See also

- [Dynamic values](./dynamic-values.md)
- [Hooks and rules](./hooks.md)
- [Lock file and drift](./lock-file-and-drift.md)
- [Job execution (architecture)](../architecture/execution/job-execution.md)
- [SDK: rules, matrix, dynamic jobs](./sdk/rules-matrix-dynamic.md)
