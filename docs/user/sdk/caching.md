---
title: Caching
description: Cache files and directories across runs with declarative job/step cache or the imperative ctx.cache API
---

KiCI ships a general-purpose cache for any files or directories your workflow produces — compiled artifacts, downloaded toolchains, package manager stores, build outputs. A cache entry is keyed, immutable once written, and shared across runs of the same repository so a later run can restore what an earlier run produced instead of recomputing it.

Two surfaces drive the same cache:

- **Declarative** — a `cache` field on a job or a step. The runtime restores before the work runs and saves after it succeeds, with no code in your step body.
- **Imperative** — `ctx.cache.restore(spec)` / `ctx.cache.save(spec)` inside a step body, for fine-grained control over when restore and save happen.

The cache is backed by the orchestrator's object storage. Entries are isolated per organization and per ref scope (see [Isolation](#isolation)); no other tenant can read your cache, and an untrusted/fork ref can never poison the cache a trusted branch reads.

## CacheSpec

Both surfaces take the same shape:

```typescript
interface CacheSpec {
  /** Exact cache key. First save wins; re-saving an existing key is a no-op. */
  key: string;
  /** Files/directories to cache. Repo-root-relative or `~`-prefixed. */
  paths: string[];
  /** Ordered prefix fallbacks for partial restore; newest matching entry wins. */
  restoreKeys?: string[];
}
```

- **`key`** is the exact cache key. It is **immutable** — the first save under a given key wins, and any later save under the same exact key is a no-op (the existing entry is never overwritten). Build keys from inputs that change when the cached content should change, e.g. a hash of your lockfile: `` key: `deps-${await ctx.$`sha256sum pnpm-lock.yaml`}` ``.
- **`paths`** are the files and directories to archive, repo-root-relative or `~`-prefixed (the agent expands `~` to the workspace home). At least one path is required.
- **`restoreKeys`** are ordered **prefix** fallbacks tried only when the exact `key` misses on restore. Each prefix is matched against existing entries; the **newest** matching entry wins. This lets a run that changed its lockfile still restore the closest previous cache and rebuild incrementally.

## Declarative cache

Add a `cache` field to a job or a step. It accepts one `CacheSpec` or an array of them. The runtime restores every spec before the job/step runs (surfaced as a `cache:restore` pseudo-step) and saves every spec after it completes successfully (surfaced as a `cache:save` pseudo-step):

```typescript
import { job } from '@kici-dev/sdk';

job('build', {
  runsOn: 'linux-x64',
  cache: {
    key: 'mise-tools-v1',
    paths: ['~/.local/share/mise'],
  },
  steps: [
    step('install-tools', async (ctx) => {
      await ctx.$`mise install`;
    }),
    step('build', async (ctx) => {
      await ctx.$`mise exec -- pnpm build`;
    }),
  ],
});
```

Step-level cache scopes the restore/save to a single step:

```typescript
step('deps', {
  cache: { key: `npm-${lockfileHash}`, paths: ['node_modules'], restoreKeys: ['npm-'] },
  run: async (ctx) => {
    await ctx.$`pnpm install --frozen-lockfile`;
  },
});
```

On a cache **hit**, the archived paths are restored before the step body runs, so `pnpm install` sees a warm `node_modules`. On a **miss**, the step runs cold and the resulting paths are saved under the exact key for the next run.

## Imperative cache (`ctx.cache`)

When you need to decide at runtime whether to restore or save — for example, save only when a build actually changed something — use the imperative API on the step context:

```typescript
step('build', async (ctx) => {
  const result = await ctx.cache.restore({
    key: `build-${sourceHash}`,
    paths: ['dist'],
    restoreKeys: ['build-'],
  });

  if (result.hit) {
    ctx.log.info(`restored cache (matched ${result.matchedKey})`);
  }

  await ctx.$`pnpm build`;

  await ctx.cache.save({ key: `build-${sourceHash}`, paths: ['dist'] });
});
```

`restore(spec)` returns `{ hit, matchedKey? }`:

- `hit` is `true` when the exact `key` matched **or** a `restoreKeys` prefix matched.
- `matchedKey` is the full key that actually matched — the exact key on a direct hit, or the full key of the matched prefix entry on a fallback hit.

`save(spec)` archives `spec.paths` under `spec.key`. Like the declarative surface, it is immutable: the first save under an exact key wins, and re-saving the same key is a no-op.

## Restore semantics

A restore resolves in this order:

1. **Exact key.** If an entry exists under the exact `key`, it is restored and `matchedKey === key`.
2. **restoreKeys prefix fallback.** Each `restoreKeys` prefix is tried in order. Within a prefix, the **newest** matching entry wins; `matchedKey` is that entry's full key.
3. **Miss.** If nothing matches, `hit` is `false` and no paths are restored.

This mirrors the familiar lockfile-hash pattern: key the entry on the exact lockfile hash, and add a `restoreKeys` prefix so a changed lockfile still restores the most recent prior cache to rebuild from.

## Immutability

Cache keys are write-once. The **first** save under an exact key wins; every subsequent save under that same exact key is a no-op and the original bytes are preserved. To publish new content, use a new key (typically by including a content hash in the key). Immutability is what makes a cache hit safe to trust — the bytes behind a given key never change after they are first written.

## Isolation

Each cache entry is scoped to your organization and to the ref's trust level:

- **Trusted refs** (your repository's own branches, default branch) read and write a **shared** scope visible to the whole org for that repository.
- **Untrusted / fork refs** read the shared scope as a fallback but write to an **isolated** per-run scope. A fork build can therefore benefit from a warm cache the trusted branch produced, but can never write into the shared scope — so a malicious fork cannot poison the cache a trusted branch later restores.

No tenant can read another tenant's cache; the org boundary is enforced in the cache key namespace.

## Eviction

Cache storage is bounded per organization. Two mechanisms keep it bounded:

- **Quota** — when a save pushes the org over its byte quota (`KICI_USER_CACHE_QUOTA_BYTES`, default 5 GiB), the oldest entries are evicted until the org is back under quota.
- **TTL** — entries unused for `KICI_USER_CACHE_TTL_MS` (default 7 days) expire. The TTL refreshes on read (touch-on-read), so an actively used cache stays warm.

Both knobs are operator-configured on the orchestrator — see [orchestrator storage layout](../../operator/orchestrator/storage-layout.md).

## Observability

Each cache restore and save surfaces in the run timeline as a `cache:restore` / `cache:save` pseudo-step, reporting the outcome (hit/miss/saved, the matched key, bytes). The same outcomes are recorded as `cache.restore` / `cache.save` run events. See [data flows](../../architecture/data-flows.md#user-facing-cache-flow) for the restore/save protocol.

## See also

- [Core](./core.md) -- `job()` / `step()` factories the `cache` field attaches to
- [Runtime](./runtime.md) -- `StepContext`, where `ctx.cache` lives
- [Orchestrator storage layout](../../operator/orchestrator/storage-layout.md) -- cache prefix, quota, TTL, and eviction
- [Data flows](../../architecture/data-flows.md#user-facing-cache-flow) -- restore/save protocol and trust→scope mapping
