---
title: 'SDK reference: idempotent'
description: Idempotent helpers for declarative check / apply patterns inside workflow steps
---

The SDK exposes two idempotency helpers — a generic function `idempotent()` and a step factory `idempotentStep()` — for the common case where a workflow step should:

1. **Check** whether the desired state is already in place.
2. **Apply** the change only when drift is detected.
3. **Surface** the resource (or its identifier) on both branches, so downstream steps don't need to know whether work happened or was skipped.

Both helpers wrap the same underlying runner, so they share semantics and return shape. Pick `idempotentStep()` when the operation is the whole job of a step; use `idempotent()` from anywhere — inside a multi-action step, a hook, or a bare async function.

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
