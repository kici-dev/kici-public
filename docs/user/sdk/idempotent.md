---
title: 'SDK reference: idempotent'
description: Idempotent helpers for declarative check / apply patterns inside workflow steps
---

The SDK exposes three idempotency helpers — a generic function `idempotent()`, the step factory `idempotentStep()`, and its check-mode-aware sibling `checkStep()` — for the common case where a workflow step should:

1. **Check** whether the desired state is already in place.
2. **Apply** the change only when drift is detected.
3. **Surface** the resource (or its identifier) on both branches, so downstream steps don't need to know whether work happened or was skipped.

`idempotent()` and `idempotentStep()` wrap the same underlying runner and always apply on drift. Pick `idempotentStep()` when the operation is the whole job of a step; use `idempotent()` from anywhere — inside a multi-action step, a hook, or a bare async function. Pick `checkStep()` when the step should respect the run-level check mode — `kici run --check` previews the drift without applying it.

## `idempotent(options)`

Run a single check / apply cycle and return a discriminated result describing the outcome.

### Parameters

| Name         | Type                                   | Required | Description                                                                                      |
| ------------ | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`       | `string`                               | No       | Label that appears in log lines. Defaults to `'idempotent'`.                                     |
| `check`      | `() => Promise<TDrift \| null>`        | Yes      | Read-only inspection. Return `null` when the system is already in the desired state.             |
| `apply`      | `(drift: TDrift) => Promise<TApplied>` | Yes      | Brings the system to the desired state when `check()` returned a non-null drift value.           |
| `whenInSync` | `() => Promise<TInSync>`               | No       | Runs when `check()` returned `null`. Use it to fetch the already-satisfied resource.             |
| `summarize`  | `(drift: TDrift) => string`            | No       | Human-readable, multi-line summary of what `apply()` would do. Defaults to a JSON dump of drift. |
| `log`        | `(line: string) => void`               | No       | Sink for status lines. Defaults to `console.log`.                                                |

### Result

`idempotent()` resolves to a discriminated `IdempotentResult` union:

| Outcome     | `drift`  | `result`                                         |
| ----------- | -------- | ------------------------------------------------ |
| `'skipped'` | `null`   | The `whenInSync()` return value, or `undefined`. |
| `'applied'` | `TDrift` | The `apply()` return value.                      |

Narrow on `result.outcome` before reading `result.result` to get the correct typed shape.

### Example

```typescript
import { idempotent } from '@kici-dev/sdk';

const result = await idempotent({
  name: 'create-dns-record',
  check: async () => {
    const existing = await dns.getRecord('api.example.com');
    return existing ? null : { fqdn: 'api.example.com', target: '203.0.113.10' };
  },
  whenInSync: async () => {
    const existing = await dns.getRecord('api.example.com');
    return { id: existing.id };
  },
  apply: async (drift) => {
    const created = await dns.createRecord(drift.fqdn, drift.target);
    return { id: created.id };
  },
  summarize: (drift) => `Create A record ${drift.fqdn} → ${drift.target}`,
});

// Both branches surface the record id.
const recordId = result.result.id;
```

## `idempotentStep(name, options)`

A factory returning an SDK `Step` whose `run` body executes `idempotent(...)` and routes status lines through the step's structured logger.

### Parameters

| Name      | Type                                       | Required | Description                                                                                            |
| --------- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `name`    | `string`                                   | Yes      | Step name. Appears in the run timeline and in log lines.                                               |
| `options` | `Omit<IdempotentOptions, 'name' \| 'log'>` | Yes      | Same shape as `idempotent()` minus `name` (already provided) and `log` (provided by the step context). |

### Result

`idempotentStep(...)` returns `Step<IdempotentResult<TDrift, TInSync, TApplied>>`. Other steps can consume the result through the standard step output mechanisms.

### Example

```typescript
import { idempotentStep, job } from '@kici-dev/sdk';

const ensureBucket = idempotentStep('ensure-bucket', {
  check: async () => {
    const exists = await s3.bucketExists('app-cache');
    return exists ? null : { bucket: 'app-cache', region: 'eu-central-1' };
  },
  whenInSync: async () => ({ arn: 'arn:aws:s3:::app-cache' }),
  apply: async (drift) => {
    const created = await s3.createBucket(drift.bucket, drift.region);
    return { arn: created.arn };
  },
  summarize: (drift) => `Create S3 bucket ${drift.bucket} in ${drift.region}`,
});

export const setup = job('setup', {
  runsOn: 'linux',
  steps: [ensureBucket],
});
```

## `checkStep(name, options)`

The check-mode-aware sibling of `idempotentStep()`. It takes the **same option shape**, but behaves differently when a run is started in check mode (`kici run --check`):

| Factory          | Behavior under `kici run --check`         |
| ---------------- | ----------------------------------------- |
| `idempotentStep` | always applies on drift                   |
| `checkStep`      | reports drift, applies only in apply mode |

Use `checkStep()` for deploy-style steps where you want a dry-run preview of pending changes before committing them, and `idempotentStep()` for steps that must always converge (for example inside a hook). A `checkStep()` desugars to the first-class step check facet (`check` / `summarize` / `run(ctx, drift)` / `whenInSync`), so it participates in run-level check mode automatically: `kici run --check` reports the drift and skips `apply`, `kici run --check --fail-on-drift` exits non-zero when drift is detected, and apply mode applies the change.

### Parameters

| Name              | Type                                        | Required | Description                                                                                         |
| ----------------- | ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`            | `string`                                    | Yes      | Step name. Appears in the run timeline and in log lines.                                            |
| `check`           | `(ctx) => Promise<TDrift \| null>`          | Yes      | Read-only inspection. Return `null` when the system is already in the desired state.                |
| `apply`           | `(ctx, drift: TDrift) => Promise<TApplied>` | Yes      | Brings the system to the desired state. Runs only in apply mode (skipped under `kici run --check`). |
| `summarize`       | `(drift: TDrift) => string`                 | Yes      | Human-readable summary of what `apply()` would do; shown in check-mode drift output.                |
| `whenInSync`      | `(ctx) => Promise<TInSync>`                 | No       | Runs when `check()` returned `null` (already in sync).                                              |
| `continueOnError` | `boolean`                                   | No       | When true, the job proceeds even if this step fails.                                                |
| `timeout`         | `number`                                    | No       | Step-level timeout in milliseconds.                                                                 |

The one signature difference from `idempotentStep`: `apply` and `whenInSync` receive `ctx` as their first argument, so the apply logic has access to `ctx.$`, `ctx.log`, and `ctx.secrets`.

### Result

`checkStep(...)` returns `Step<TApplied | TInSync>` — the output is whichever of `apply` / `whenInSync` ran.

### Example

```typescript
import { checkStep, job } from '@kici-dev/sdk';

const ensureDnsRecord = checkStep('ensure-dns-record', {
  check: async (ctx) => {
    const existing = await ctx.$`dig +short api.example.com`;
    return existing.stdout.trim() ? null : { fqdn: 'api.example.com', target: '203.0.113.10' };
  },
  summarize: (drift) => `Create A record ${drift.fqdn} → ${drift.target}`,
  apply: async (ctx, drift) => {
    await ctx.$`dns-cli create ${drift.fqdn} ${drift.target}`;
    return { created: true };
  },
  whenInSync: async () => ({ created: false }),
});

export const deploy = job('deploy', {
  runsOn: 'linux',
  steps: [ensureDnsRecord],
});
```

Run `kici run --check` against this workflow to see the drift summary without touching DNS; run it without `--check` to apply.

## Worked example: create-if-missing returning a resource id

The typical use case is **resource provisioning that should be safe to re-run**. The helper guarantees the same downstream typed shape whether the resource already existed or was just created:

```typescript
import { idempotent } from '@kici-dev/sdk';

interface BucketDrift {
  bucket: string;
  region: string;
}

interface BucketHandle {
  arn: string;
}

async function ensureBucket(bucket: string, region: string): Promise<BucketHandle> {
  const result = await idempotent<BucketDrift, BucketHandle, BucketHandle>({
    name: `ensure-${bucket}`,
    check: async () => {
      const existing = await s3.describeBucket(bucket);
      return existing ? null : { bucket, region };
    },
    whenInSync: async () => {
      const existing = await s3.describeBucket(bucket);
      return { arn: existing.arn };
    },
    apply: async (drift) => {
      const created = await s3.createBucket(drift.bucket, drift.region);
      return { arn: created.arn };
    },
    summarize: (drift) => `Create S3 bucket ${drift.bucket} in ${drift.region}`,
  });

  return result.result;
}
```

The caller never has to branch on outcome — `result.result` is always a `BucketHandle`. A second invocation against the same bucket logs a single "in sync, skipping" line and returns the same ARN.

## See also

- [Core SDK reference](./core.md) — the `step()`, `job()`, and `workflow()` factories that `idempotentStep()` builds on.
- [Runtime types](./runtime.md) — `StepContext`, `Logger`, and other surface used inside the helpers.
