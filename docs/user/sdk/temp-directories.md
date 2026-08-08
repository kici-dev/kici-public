---
title: 'SDK reference: temp directories'
description: Allocate job-scoped scratch dirs and files with ctx.mktemp() / ctx.mktempFile()
---

Steps often need a throwaway working directory — somewhere to unpack an archive, stage a build, or write an intermediate file. `ctx.mktemp()` and `ctx.mktempFile()` allocate that scratch space and clean it up for you when the job ends, so you never leak temp trees on the agent.

## ctx.mktemp(label?)

Allocate a scratch **directory** for the current job. Returns a handle:

```typescript
interface TempHandle {
  /** Absolute path to the allocated directory (or file, for mktempFile). */
  readonly path: string;
  /** Remove the allocation. Idempotent — safe to call more than once. */
  cleanup(): Promise<void>;
  /** Enables `await using` — disposes on scope exit. */
  [Symbol.asyncDispose](): Promise<void>;
}
```

```typescript
step('build', async (ctx) => {
  const scratch = await ctx.mktemp();
  await ctx.$`git clone --depth 1 https://example.com/repo.git ${scratch.path}`;
  await ctx.$`tar -czf out.tgz -C ${scratch.path} .`;
});
```

The `label` argument is optional. When omitted it defaults to a sanitized step id, so the directory name carries a hint about which step created it. Pass an explicit label to make it obvious in the temp root:

```typescript
const cache = await ctx.mktemp('npm-cache');
// path looks like /tmp/kici-npm-cache-a1b2c3
```

A label must be lowercase alphanumeric with hyphens (`a-z`, `0-9`, `-`).

## ctx.mktempFile(label?, { suffix? })

Allocate a scratch **file** instead of a directory. Same handle shape; `path` points at an empty file you can write to. Pass `suffix` to give the file an extension:

```typescript
step('render', async (ctx) => {
  const config = await ctx.mktempFile('render-config', { suffix: '.json' });
  await ctx.$`echo ${JSON.stringify({ mode: 'prod' })} > ${config.path}`;
  await ctx.$`my-tool --config ${config.path}`;
  // path looks like /tmp/kici-render-config-a1b2c3/render-config.json
});
```

## Automatic cleanup

Every allocation from `ctx.mktemp()` / `ctx.mktempFile()` is tied to the job. When the job ends — on **success, failure, or cancellation** — its scratch dirs and files are removed automatically. You do not have to clean up in a `finally` block or worry about a failing step leaving debris behind.

## Manual cleanup

The returned `cleanup()` lets you release a large allocation early, before the job finishes — useful when a later step no longer needs a multi-gigabyte checkout:

```typescript
step('extract', async (ctx) => {
  const work = await ctx.mktemp('extract');
  await ctx.$`tar -xzf big-archive.tgz -C ${work.path}`;
  await ctx.$`./process.sh ${work.path}`;
  await work.cleanup(); // free the space now; don't wait for job end
});
```

`cleanup()` is **idempotent** — calling it a second time (or letting the automatic job-end cleanup run after you already called it) is a no-op, never an error.

## The `await using` form

Because a handle is an async disposable, you can bind its lifetime to the enclosing scope with `await using`. The directory is removed as soon as the block exits, whether it returns normally or throws:

```typescript
step('sign', async (ctx) => {
  await using keydir = await ctx.mktemp('gpg-home');
  await ctx.$`gpg --homedir ${keydir.path} --import key.asc`;
  await ctx.$`gpg --homedir ${keydir.path} --detach-sign artifact.tar`;
  // keydir is disposed here, at the end of the block
});
```

This is the tidiest form when a scratch dir is only needed for a bounded section of a step and you want it gone the moment you are done with it — you get the same guaranteed cleanup as a `try/finally` without the boilerplate.

## See also

- [SDK reference: runtime](./runtime.md) — the full `StepContext` surface (`$`, `log`, `env`, `secrets`, and more).
- [Artifacts](./artifacts.md) — for durable, named build deliverables that outlive the job, use `ctx.artifacts` instead of a temp dir.
