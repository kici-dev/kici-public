---
title: Artifacts
description: Share named, durable build outputs between jobs of a run and download them from the run page with ctx.artifacts
---

An **artifact** is a named, durable build output — a compiled binary, a bundle, a report — that one job produces and a later job (or a human) consumes. `ctx.artifacts.upload(name, paths)` packs the given files and stores them under a name; `ctx.artifacts.download(name, destDir?)` retrieves them in a later job of the same run. Uploaded artifacts also appear on the run detail page, where anyone with access can download them.

```ts
import { workflow, job } from '@kici-dev/sdk';

const build = job('build', {
  runsOn: 'kici:os:linux',
  run: async (ctx) => {
    await ctx.$`npm run build`;
    // Pack ./dist and upload it as the "app" artifact.
    await ctx.artifacts.upload('app', ['dist']);
  },
});

const publish = job('publish', {
  runsOn: 'kici:os:linux',
  needs: [build],
  run: async (ctx) => {
    // Download what `build` produced, into the working directory.
    await ctx.artifacts.download('app');
    await ctx.$`ls dist && ./scripts/publish.sh`;
  },
});

export default workflow('release', {
  on: [/* triggers */],
  jobs: [build, publish],
});
```

## The API

```ts
interface ArtifactsApi {
  /** Pack `paths` and upload them as `name`. Returns the packed size + sha256. */
  upload(name: string, paths: string[]): Promise<{ size: number; sha256: string }>;
  /** Download `name` (uploaded by an earlier job of this run) into destDir
   *  (default: the step's working directory). Returns the size + sha256. */
  download(name: string, destDir?: string): Promise<{ size: number; sha256: string }>;
}
```

- **`name`** is a short token of letters, digits, `.`, `_`, and `-` (up to 128 chars), and cannot be made only of dots. It is how a downstream job addresses the artifact. A name that breaks the rule fails the step with the reason — `invalid artifact name`, plus which part of the rule it broke — rather than being quietly rewritten. The orchestrator enforces the same rule when it receives the upload and reports it with the same sentence, so the error reads the same whichever side caught it.
- **`paths`** are repo-root-relative or `~`-prefixed, exactly like [cache paths](./caching.md) — the same packing, path-safety, and multi-root anchoring apply. Absolute paths and `..` escapes are rejected.
- **`destDir`** on download defaults to the step's working directory; pass an explicit directory to extract elsewhere.

Both methods verify the content hash end to end: the SHA-256 computed at upload is checked again when the tarball is downloaded, so a corrupted transfer fails loudly.

`upload()` returns only once the orchestrator confirms it recorded the artifact. If that commit cannot be completed — the uploaded object never landed, or the orchestrator's storage or database is unreachable long enough for its retries to run out — the step fails with that reason instead of returning successfully. So a green upload step always means a downstream job can download the artifact. The reason names which kind of failure it was, not the orchestrator's internal error text — an internal commit failure is one to take to whoever runs the orchestrator, who can read the details in its logs.

A connection blip while that confirmation is in flight does not fail the step. Recording the artifact is idempotent, so the agent re-sends the confirmation once the connection is back and waits for the answer, within the same overall deadline it already had. If the connection never comes back in time, the step still fails — and says the artifact may nevertheless have been recorded, so you know to check the run's artifacts before assuming the upload was lost.

## Immutable per run

The **first upload of a name within a run wins.** A second `upload('app', ...)` in the same run — from a retry, a parallel writer, or a copy-paste — fails with a clear error rather than silently overwriting the first. This makes artifacts a deterministic contract between jobs: once `build` has uploaded `app`, every downstream job that downloads `app` gets exactly those bytes.

Downloading a name that was never uploaded in the run throws a not-found error.

## Viewing artifacts in the dashboard

Every artifact a run uploads is listed on the run detail page under the **Artifacts** tab, with its name, the job that produced it, size, content hash, and creation time. Anyone with read access to the run can download an artifact directly from there — a link straight to the stored object, so the bytes never pass through the control plane.


## From the CLI

You can also list and fetch a run's artifacts from a terminal:

- `kici runs artifacts list <run-id>` — the same rows the dashboard **Artifacts** tab shows (`--json` for machine-readable output).
- `kici runs artifacts download <run-id> [name]` — download one artifact, or every artifact of the run if you omit the name. Each one extracts into its own `<name>/` directory; `--archive` keeps the raw `.tar.gz` and `-o <dir>` sets the target directory.

Like the dashboard download, the bytes stream straight from object storage over a short-lived signed URL and never pass through the control plane — and the CLI verifies the content hash end to end. See the [CLI reference](../cli/runs-and-approvals.md#kici-runs-artifacts-list) for the full flag list.

## Artifacts vs cache vs outputs

KiCI gives you three ways to move data between jobs. They look similar but solve different problems:

| Mechanism     | Addressed by             | Lifetime                              | Use it for                                                           |
| ------------- | ------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| **Outputs**   | job/step name (`needs`)  | the run                               | small JSON values — a version string, a computed flag, a list of ids |
| **Cache**     | a content key you choose | shared across runs, eviction-tolerant | recomputable speedups — a package store, a toolchain, a build cache  |
| **Artifacts** | a name you choose        | this run, durable + downloadable      | deliverables — a built binary, a bundle, a test report               |

- Reach for **[outputs](./core.md#job-dependencies-needs)** when the value is small and structured (it rides the `needs` graph as JSON).
- Reach for **[cache](./caching.md)** when the data is a recomputable speedup keyed by its inputs (a cache miss just recomputes; entries are evicted under quota).
- Reach for **artifacts** when the data is a _deliverable_ that a later job or a person needs verbatim — something you would be unhappy to see silently recomputed or evicted.

## Limits

An orchestrator enforces a few limits, each surfaced as a clear step error when hit:

- A **per-artifact size cap** (1 GiB by default).
- A **per-run count cap** (50 artifacts by default).
- A **per-org storage quota** (20 GiB by default) across all non-expired artifacts.
- An **expiry** (30 days by default) after which an artifact is no longer downloadable or listed.

Each of the four is a cluster-wide default an operator can raise or lower per organization; see the [orchestrator storage layout](../../operator/orchestrator/storage-layout.md#artifacts) for the operator-facing knobs.

When an upload or download fails for a reason that is **not** one of these limits — the orchestrator has no artifact storage configured, or it could not service the request — the step error says exactly that, instead of reporting a quota rejection or a missing artifact. So an error that names a limit really is a limit you can act on, and an error that names an orchestrator problem is one to take to whoever runs it.
