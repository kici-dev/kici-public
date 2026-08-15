---
title: Lock file and workflow drift
description: Keep the lock file in sync with your workflow source and avoid drift
---

KiCI uses a **two-artifact model**: TypeScript workflows are the source of truth; the lock file (`kici.lock.json`) is the execution contract. The orchestrator reads only the lock file to match triggers and decide cache vs build. Keeping these in sync is important.

## Why the lock file matters

- **Orchestrator** fetches the lock file at the commit SHA and uses it to evaluate triggers and to look up the cached `.kici/` source tarball + `node_modules` tarball. It never runs your TypeScript.
- **Agents** download the cached source tarball (or, on cold cache, the build agent clones + packs it), register the shared TypeScript loader hook, and dynamic-`import()` the workflow `.ts` directly. The lock file's per-workflow `contentHash` identifies the expected raw-source bytes and is verified against the extracted source before any step runs.

If you change a workflow file (`.ts`) but do **not** regenerate and commit the lock file, the repo at that commit has **drift**: the lock file no longer matches the source. Triggers and cache keys can be wrong, and runs can fail with a clear “stale lock file” error once the agent verifies the hash.

## Lock file structure

The lock file (`kici.lock.json`) is a JSON file with the following top-level fields:

| Field              | Description                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`    | Lock file schema version, stamped by the compiler that produced the lock. Incremented on every format change. The orchestrator accepts a range of versions — see [schema compatibility window](#schema-compatibility-window) — rather than requiring an exact match.                                                                                  |
| `minReaderVersion` | The oldest orchestrator schema version that can read this lock (the newest breaking version at compile time). An orchestrator whose own schema is below this rejects the lock and asks you to upgrade it. Omitted on locks compiled before the compatibility window existed. See [schema compatibility window](#schema-compatibility-window).         |
| `source`           | Reference to the source file and export (e.g., `{ file: '.kici/workflows/ci.ts', export: '#default' }`).                                                                                                                                                                                                                                              |
| `contentHash`      | SHA-256 of the serialized lock file content (excluding itself). Changes when any workflow, trigger, or job changes.                                                                                                                                                                                                                                   |
| `lockfileHash`     | SHA-256 of the detected package manager's lockfile, used as the dependency cache key. The lockfile is `.kici/package-lock.json` for npm, or the repo-root `pnpm-lock.yaml` / `yarn.lock` for a pnpm/yarn workspace; the hash input is prefixed with the manager name so a manager change is a guaranteed cache miss. Omitted when no lockfile exists. |
| `workflows`        | Array of workflow entries, each with its own `contentHash`, `compileSchemaVersion`, triggers, and jobs.                                                                                                                                                                                                                                               |

Each workflow entry includes:

| Field                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | Workflow name.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `source`               | Per-workflow source file and export reference.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contentHash`          | SHA-256 of the raw workflow source mixed with `compileSchemaVersion` (and an `assetDigest` of declared `hashFiles` when present): `SHA-256(compileSchemaVersion + ":" + rawSource [+ "\0" + assetDigest])`. The orchestrator uses this as the source-tarball cache key and the agent re-computes it against the extracted source to detect drift.                                                                                                               |
| `compileSchemaVersion` | Compiler schema version used when computing `contentHash` (currently `5`). The hash input is line-ending-normalized (CRLF → LF) so a lock file produced on Linux matches the agent's hash on Windows where Git's `core.autocrlf=true` rewrites checked-out text to CRLF. Bumping the schema version invalidates every existing source cache entry even if source is unchanged, which is the correct behavior when the compile-time or runtime contract changes. |
| `triggers`             | Trigger definitions extracted from the workflow (used by the orchestrator for event matching).                                                                                                                                                                                                                                                                                                                                                                  |
| `jobs`                 | Job definitions with scheduling metadata (runsOn, needs, matrix, contexts, concurrency, container, checkout, gracePeriod, label routing, dynamic fields, etc.).                                                                                                                                                                                                                                                                                                 |
| `rules`                | Workflow-level conditional rules (optional). Stored as dynamic references since rule functions cannot be serialized.                                                                                                                                                                                                                                                                                                                                            |
| `description`          | Optional workflow description.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hashFiles`            | Declared glob patterns for extra files included in the content hash (optional). See [extra files in the content hash](#extra-files-in-the-content-hash-hashfiles).                                                                                                                                                                                                                                                                                              |
| `resolvedHashFiles`    | Resolved file paths from `hashFiles` at compile time (optional). Recorded so the agent can verify without re-discovering.                                                                                                                                                                                                                                                                                                                                       |
| `contexts`             | Secret contexts declared by the workflow (optional). The orchestrator validates access to each context before dispatch.                                                                                                                                                                                                                                                                                                                                         |
| `registries`           | Private npm registry declarations the agent authenticates against before install (optional): `url`, `scope`, `tokenSecret` reference, `alwaysAuth`. Resolved token bytes never appear in the lock file. See [private registries](private-registries.md).                                                                                                                                                                                                        |
| `installEnv`           | Extra qualified secret refs (`<context>:<secret-name>`) projected as env vars on the install subprocess for use with a committed `.kici/.npmrc` (optional). See [private registries](private-registries.md).                                                                                                                                                                                                                                                    |
| `concurrency`          | Workflow-level concurrency config: `hasGroup`, `cancelInProgress`, `max` (optional). See [concurrency groups](concurrency.md).                                                                                                                                                                                                                                                                                                                                  |
| `timeout`              | Whole-run wall-clock timeout in milliseconds (optional). The orchestrator reads this at run creation to set the run deadline.                                                                                                                                                                                                                                                                                                                                   |
| `approval`             | Normalized approval gate (optional): `clauses`, `reason`, `timeoutSeconds`, `when`. When present the whole run is held before any job is dispatched. Job and step entries carry the same normalized block for job- and step-level gates. See [approval gates](approvals.md).                                                                                                                                                                                    |
| `hasFilter`            | `true` when the workflow declares a workflow-level `filter` predicate (optional; omitted rather than `false`). The predicate itself is never serialized — the flag tells the orchestrator an agent must evaluate the workflow before any of its jobs is dispatched. See [global workflows](global-workflows.md#narrowing-with-a-filter).                                                                                                                        |
| Hook flags             | Boolean flags (`hasOnCancel`, `hasCleanup`, `hasOnSuccess`, `hasOnFailure`) indicating which lifecycle hooks are defined. Job entries additionally have `hasBeforeStep` and `hasAfterStep`.                                                                                                                                                                                                                                                                     |

Step entries carry their own capability flags, so the orchestrator can reason about a step without loading your TypeScript:

| Flag            | Meaning                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hasCheck`      | The step declares an idempotent `check` facet, so a run can be dispatched in check mode. See [idempotent steps and check mode](idempotent-steps.md). |
| `hasWhenInSync` | The step declares a `whenInSync` facet that produces its outputs when `check` reports no drift.                                                      |
| `hasRules`      | The step has conditional rules (evaluated agent-side).                                                                                               |
| `hasOnCancel`   | The step has an `onCancel` hook.                                                                                                                     |
| `hasCleanup`    | The step has a `cleanup` hook.                                                                                                                       |

The check, apply, and `whenInSync` closures themselves are never serialized — only the flags are. The agent re-evaluates the real workflow TypeScript.

## Schema compatibility window

The orchestrator does not require the lock's `schemaVersion` to exactly match its
own. Instead it accepts a **compatibility window**, so an additive SDK update no
longer forces every orchestrator sharing a fleet to upgrade in lockstep.

A lock is accepted when **both** hold:

- Its `schemaVersion` is at or above the orchestrator's oldest supported version.
  Most schema bumps are additive — they add fields older readers simply ignore —
  so a lock compiled by a newer SDK still loads on an older orchestrator.
- The orchestrator's own schema version is at or above the lock's
  `minReaderVersion`. This guards the one case a version floor alone cannot
  detect: a lock that relies on a **breaking** change the orchestrator predates.

Two out-of-window cases are rejected with an actionable error (recorded as a
`lockfile_corrupt` delivery, never a silent mis-route):

- **Lock too old** — compiled by an SDK predating a breaking schema change the
  orchestrator relies on. Fix: recompile with a current SDK (`kici compile`) and
  push the refreshed lock.
- **Lock too new (breaking)** — requires an orchestrator newer than the one
  reading it. Fix: upgrade the orchestrator to the version the error names.

When you `kici compile` at a schema version that is itself a breaking version,
the CLI prints a one-line notice that orchestrators older than that version
cannot read the emitted lock. It is informational only — the orchestrator is the
authoritative check.

## Rule: commit both together

**Always commit `.kici/kici.lock.json` in the same commit as the workflow source files it was generated from.**

1. After editing `.kici/workflows/*.ts`, run:
   ```bash
   npx kici compile
   ```
2. Stage both the workflow file(s) and `.kici/kici.lock.json`.
3. Commit them together.

That way the lock file at every commit SHA matches the workflow source at that SHA.

## Catch drift early: pre-commit and CI

Use automation so drift is caught before it reaches the repo.

### Pre-commit hook

Install a hook that compiles and stages the lock file before each commit:

```bash
npx kici hook install
```

This runs `kici compile && git add .kici/kici.lock.json` before each commit: if compilation fails the commit is blocked; if it succeeds the updated lock file is automatically staged. See [CLI Reference — kici hook](./cli/authoring-and-local.md#kici-hook) for options (husky, lefthook, pre-commit, prek, raw git).

### CI check

In your CI pipeline, verify that the workflow source compiles without errors:

```bash
kici compile --check
```

This validates all workflows and generates the lock file in memory without writing it. If any workflow has syntax errors or invalid configuration, the command exits non-zero. Pair this with the agent-side hash verification (below) for full drift detection -- `--check` catches broken source, while the agent catches source-lock-file mismatches at run time.

## Extra files in the content hash (`hashFiles`)

By default, the per-workflow content hash is `SHA-256(compileSchemaVersion + ":" + rawSource)` where `rawSource` is the TypeScript text of the workflow entry file. If your workflow depends on files outside `.kici/workflows/` -- configuration files, scripts, Dockerfiles, etc. -- changes to those files will **not** invalidate the cache unless you declare them.

Use the `hashFiles` option on a workflow to include additional paths or glob patterns (relative to the repo root) in the content hash:

```typescript
export default workflow('deploy', {
  hashFiles: ['config.json', 'scripts/*.sh'],
  jobs: [/* ... */],
});
```

When any of the matched files change, the content hash formula becomes `SHA-256(compileSchemaVersion + ":" + rawSource + "\0" + assetDigest)` where `assetDigest` is a deterministic encoding of the resolved file paths and their contents. This busts the source-tarball cache and forces the build agent to pack and upload a fresh `source/{contentHash}.tar.gz`. The resolved file paths are recorded in the lock file under `resolvedHashFiles` so the agent can verify without re-discovering the workflow.

## Agent-side safety net

If drift still occurs (e.g. someone committed only the `.ts` change), the agent detects it at run time before any step runs:

- After extracting the `.kici/` source tarball (or loading source from a `git clone` on the build path), the agent reads the workflow entry file and re-computes `contentHash = SHA-256(compileSchemaVersion + ":" + rawSource [+ "\0" + assetDigest])` using the same formula as the compiler.
- If the orchestrator sent a `contentHash` (from the lock file) and the computed hash does **not** match, the agent fails the run with an error like: **lock file is out of date** (workflow source changed without regenerating the lock file). The error includes the baked agent `@kici-dev/sdk` version + bundle hash so operators can debug cross-host compile mismatches.

So even without a pre-commit or CI check, a stale lock file will cause the run to fail with a clear message instead of running with the wrong workflow.

## Summary

| Goal                         | What to do                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Keep lock file in sync       | Commit `kici.lock.json` with the workflow `.ts` changes; run `kici compile` before commit. |
| Catch drift before commit    | Install a pre-commit hook with `kici hook install`.                                        |
| Catch broken source in CI    | Run `kici compile --check` in CI.                                                          |
| Bust cache on external files | Add `hashFiles: ['config.json']` to include non-workflow files in the content hash.        |
| Fail fast when drift remains | Rely on the agent’s hash verification when it compiles from source.                        |

## See also

- [Getting started](getting-started.md) — compile and commit the lock file
- [CLI reference](cli-reference.md) — `kici compile`, `kici compile --check`, `kici hook`
- [Architecture — Data flows](../architecture/data-flows.md) — how the lock file is used in the pipeline
