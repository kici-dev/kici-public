---
title: 'SDK reference: waitFor'
description: Polling helpers for steps that pause until an external condition becomes true
---

The SDK exposes two wait-for helpers — a generic function `waitFor()` and a step factory `waitForStep()` — for the common case where a workflow step should:

1. **Poll** a condition on a fixed interval.
2. **Proceed** as soon as the condition is met, optionally running a success action.
3. **Fail or recover** gracefully when the deadline is exceeded, with an optional timeout action.

Both helpers wrap the same polling loop, so they share semantics and return shape. Pick `waitForStep()` when the wait is the whole job of a step; use `waitFor()` from anywhere — inside a multi-action step, a hook, or a bare async function.

## `waitFor(options)`

Poll `check()` on a fixed interval until it returns a non-null value or the deadline is exceeded. Resolves to a discriminated result describing which outcome occurred.

### Parameters

| Name             | Type                                                                   | Required | Description                                                                                                |
| ---------------- | ---------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `name`           | `string`                                                               | No       | Label that appears in log lines and in the timeout error. Defaults to `'waitFor'`.                         |
| `check`          | `() => Promise<TValue \| null>`                                        | Yes      | Polled inspection. Return the resolved value when the condition is met, or `null` to keep polling.         |
| `intervalMs`     | `number`                                                               | No       | Time between successive `check()` invocations. Defaults to `2000` milliseconds.                            |
| `timeoutMs`      | `number`                                                               | No       | Total time budget for the wait. Defaults to `60000` milliseconds.                                          |
| `initialDelayMs` | `number`                                                               | No       | Time to wait before the first `check()` invocation. Defaults to `0`.                                       |
| `onSuccess`      | `(value: TValue) => Promise<TSuccess>`                                 | No       | Runs once after `check()` returns a non-null value. Its return value is surfaced as `result` on success.   |
| `onTimeout`      | `(info: { elapsedMs: number; attempts: number }) => Promise<TTimeout>` | No       | Runs when the deadline is exceeded. Its return value is surfaced as `result` on the `'timed-out'` outcome. |
| `swallowErrors`  | `boolean`                                                              | No       | When `true` (default), errors thrown by `check()` are logged and polling continues.                        |
| `log`            | `(line: string) => void`                                               | No       | Sink for status lines. Defaults to `console.log`.                                                          |

### Result

`waitFor()` resolves to a discriminated `WaitForResult` union:

| Outcome       | Branch fields                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `'succeeded'` | `value: TValue`, `elapsedMs`, `attempts`, `result: TSuccess` (the `onSuccess` return or `undefined`). |
| `'timed-out'` | `elapsedMs`, `attempts`, `result: TTimeout` (the `onTimeout` return).                                 |

Narrow on `result.outcome` before reading the branch-specific fields.

When `onTimeout` is **not** supplied, the helper throws a `WaitForTimeoutError` instead of returning a `'timed-out'` result. The error exposes `stepName`, `elapsedMs`, and `attempts` as instance fields so a catch block can branch on them.

### Cancellation and the deadline check

The loop inspects the deadline at the top of each iteration. A `check()` that takes longer than `intervalMs` is not aborted mid-flight; the helper has no `AbortSignal` plumbing. The step's own `timeout` field is the hard kill if the step needs to be interrupted unconditionally.

### Example

```typescript
import { waitFor } from '@kici-dev/sdk';

const result = await waitFor({
  name: 'await-build-artifact',
  check: async () => {
    const artifact = await registry.findArtifact('myapp', 'v1.2.3');
    return artifact ?? null;
  },
  onSuccess: async (artifact) => ({ digest: artifact.digest }),
  intervalMs: 5000,
  timeoutMs: 5 * 60 * 1000,
});

if (result.outcome === 'succeeded') {
  console.log(`Artifact ready: ${result.result.digest} (${result.attempts} polls)`);
} else {
  console.log(`Gave up after ${result.elapsedMs} ms`);
}
```

## `waitForStep(name, options)`

A factory returning an SDK `Step` whose `run` body executes `waitFor(...)` and routes status lines through the step's structured logger.

### Parameters

| Name      | Type                                    | Required | Description                                                                                         |
| --------- | --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`    | `string`                                | Yes      | Step name. Appears in the run timeline and in log lines.                                            |
| `options` | `Omit<WaitForOptions, 'name' \| 'log'>` | Yes      | Same shape as `waitFor()` minus `name` (already provided) and `log` (provided by the step context). |

### Result

`waitForStep(...)` returns `Step<WaitForResult<TValue, TSuccess, TTimeout>>`. Other steps can consume the result through the standard step output mechanisms.

### Example

```typescript
import { waitForStep, job } from '@kici-dev/sdk';

const awaitMarker = waitForStep('await-marker', {
  check: async () => {
    const stat = await tryStatMarker('/tmp/build-ready');
    return stat ? { path: '/tmp/build-ready' } : null;
  },
  intervalMs: 1000,
  timeoutMs: 60_000,
  onTimeout: async ({ attempts }) => ({ aborted: true, attempts }),
});

export const release = job('release', {
  runsOn: 'linux',
  steps: [awaitMarker],
});
```

If `check()` throws while polling, the error is logged and polling continues — the default `swallowErrors: true` matches the "poll until healthy" pattern. Pass `swallowErrors: false` to fail fast on the first error instead.

## See also

- [Core SDK reference](./core.md) — the `step()`, `job()`, and `workflow()` factories that `waitForStep()` builds on.
- [Idempotent helpers](./idempotent.md) — `idempotent()` and `idempotentStep()` for check / apply patterns.
- [Runtime types](./runtime.md) — `StepContext`, `Logger`, and other surface used inside the helpers.
