---
title: Idempotent steps and check mode
description: 'Declare desired state with a step check facet, then run in apply or --check preview mode'
---

An **idempotent step** describes _desired state_ rather than a fixed sequence of
commands. You give the step a `check` function that inspects the world and a
`run` function that converges it. KiCI then executes the workflow in one of two
modes:

- **Apply mode** (the default): for each step, `check()` runs first; on drift the
  step applies the change; when already in sync the step is skipped.
- **Check mode** (`--check`): for each step, `check()` runs and KiCI reports what
  _would_ change — **without changing anything**. This is the same model as a
  dry-run plan: you see the drift before any side effect happens.

This turns a workflow into convergent configuration management: re-running an
apply is safe (in-sync steps do nothing), and a check-mode run is a read-only
preview you can gate a build on.

## Authoring a checked step

Add a `check` facet to the existing `step()` factory. When `check` is present,
`run` becomes the _apply_ function and receives the drift value `check`
returned:

```typescript
import { step, z } from '@kici-dev/sdk';

const configureNginx = step('configure-nginx', {
  // optional schema for the drift value — gives the dashboard a typed shape
  drift: z.object({ want: z.string() }),

  // read-only inspection; return null when already in the desired state
  check: async (ctx) => {
    const current = await ctx.$`nginx -T`;
    return current.stdout.includes(DESIRED) ? null : { want: DESIRED };
  },

  // human-readable preview line — REQUIRED when check is set. It is the drift's
  // serializable face: it streams to the logs and persists for the dashboard.
  summarize: (drift) => `would rewrite nginx.conf (${drift.want.length} bytes)`,

  // apply — runs only when check returned drift (apply mode); receives that drift
  run: async (ctx, drift) => {
    await writeConfig(drift.want);
    return { reloaded: true };
  },

  // optional — runs when check returned null, to produce the step's outputs
  whenInSync: async () => ({ reloaded: false }),
});
```

### The facet fields

| Field        | Required         | Purpose                                                                |
| ------------ | ---------------- | ---------------------------------------------------------------------- |
| `check`      | to opt in        | Read-only inspection. Return a drift value, or `null` when in sync.    |
| `summarize`  | when `check` set | Human-readable, serializable preview of the drift. Streams + persists. |
| `run`        | always           | Apply function. With `check`, it receives the drift as its second arg. |
| `whenInSync` | optional         | Produces the step's outputs when `check` returned `null`.              |
| `drift`      | optional         | Schema that validates / shapes the drift value.                        |

`summarize` is **required** whenever `check` is declared. `run` and `whenInSync`
both produce the same output type — one output shape per step, whichever path
runs. Every other step facet (`cache`, `rules`, `continueOnError`, `timeout`,
`approval`, `onCancel`, `cleanup`, `outputs`) composes unchanged.

A plain `step()` without `check` keeps its exact current behavior — the check
facet is fully optional.

## Run modes

A run carries one of three modes:

| Mode                  | CLI flags                 | Behavior                                                                                   |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `apply`               | (default, no flags)       | Converge: drift ⇒ apply ⇒ **applied**; null ⇒ **in sync** (skipped).                       |
| `check`               | `--check`                 | Preview only: drift ⇒ **would change**; null ⇒ **in sync**. Never applies. Always exits 0. |
| `check-fail-on-drift` | `--check --fail-on-drift` | Same as check, but the run **fails** if any step reports drift.                            |

Per-step outcomes:

- **applied** — drift was found and the step applied the change (apply mode).
- **in sync** — `check` returned `null`; nothing to do.
- **would change** — drift was found in check mode; the change was previewed, not applied.
- **no check** — a plain step (no `check`) reached under check mode. A
  side-effecting step can't be safely previewed, so it is skipped.

In check mode KiCI never invokes a checked step's `run` (apply) — the preview is
guaranteed side-effect-free.

## Running in check mode

`--check` and `--fail-on-drift` work on both local and remote runs:

```bash
# Apply (default): converge the workflow.
kici run local push
kici run remote my-fixture

# Check: report drift, change nothing. Always exits 0.
kici run local push --check
kici run remote my-fixture --check

# Check + fail on drift: exit non-zero (2) locally, or fail the run remotely,
# when any step reports drift. Use this as a CI gate ("fail the build if prod
# has drifted").
kici run local push --check --fail-on-drift
```

`--fail-on-drift` only modifies check mode — passing it without `--check` is an
error.

## Where outcomes show up

A check-mode run is labeled in the dashboard with a **CHECK MODE — preview**
badge on the run header. Each step shows its outcome chip — applied / in sync /
would change / no check — and, when drift was detected, the `summarize` line
describing what would change. The rendering is read-only.

## See also

- [Idempotent SDK helpers](./sdk/idempotent.md) — the `idempotent()` / `idempotentStep()` convenience wrappers (always apply on drift), plus `checkStep()`, the clean-shape sibling that respects the run-level check mode.
- [Core SDK reference](./sdk/core.md) — the `step()`, `job()`, and `workflow()` factories the check facet extends.
- [Lock file and drift](./lock-file-and-drift.md) — how the lock file carries step capability flags.
