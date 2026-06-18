---
title: Source tarball and dependency caching
description: Configure and manage the orchestrator-side source tarball and dependency caches
---

KiCI caches two artifacts so execution agents do not re-clone and reinstall on every job:

- **Source tarball** — the `.kici/` directory (raw TypeScript source + lock file + any assets referenced by `hashFiles`), excluding `node_modules/`.
- **Dependency tarball** — the installed dependency closure for `.kici/`. The package manager is detected from the repo: `npm` by default, `pnpm` when the workflow lives in a pnpm workspace, or `yarn` for a yarn repo (both classic v1 and berry v2+). For npm this is the `.kici/node_modules/` tree; pnpm and yarn additionally pack the in-repo workspace sibling directories `.kici/` depends on (and, for pnpm, the root virtual store), since those resolve outside `.kici/node_modules/`. yarn berry installs run with a forced `nodeLinker: node-modules`, so its dependency tree has the same `node_modules`-based shape as classic and is packed identically (the committed zero-install PnP cache is never consumed); the cache key folds the yarn flavor in, so a classic-layout tarball is never restored into a berry install.

A build agent packs each tarball once, uploads it to cache storage, and subsequent runs download and extract them instead of re-cloning or reinstalling. The execution agent registers the shared `@kici-dev/shared/ts-loader-hook` so dynamic `import()` of the extracted `.ts` files Just Works — there is no runtime bundling step.

## How it works

KiCI uses a two-phase build/execution model for both artifacts:

```
Cache miss flow:

  Webhook -> Trigger match -> Cache check (source: MISS, deps: MISS)
    -> Build job dispatch (kici:role:builder agent)
    -> Build agent: clone -> install deps (npm/pnpm) -> pack .kici/ source -> pack node_modules
       -> upload both tarballs to cache -> report hashes
    -> Execution job dispatch (with sourceTarUrl + depsUrl)
    -> Execution agent: extract source tarball into workDir/.kici/
       -> extract deps tarball into .kici/node_modules/
       -> register TS loader hook -> dynamic-import workflow .ts
       -> execute steps

Cache hit flow:

  Webhook -> Trigger match -> Cache check (source: HIT, deps: HIT)
    -> Execution job dispatch (with sourceTarUrl + depsUrl)
    -> Execution agent: two S3 GETs (source + deps) -> extract -> execute
```

The execution job's "hot path" is always exactly two S3 GETs (one source tarball, one deps tarball); no `git clone`, no dependency reinstall, no bundler at runtime.

### Cache keys

**Source tarball** is keyed by the workflow's `contentHash` (SHA-256 of `schemaVersion:rawWorkflowSource[\0assetDigest]` from `@kici-dev/compiler/lockfile/hasher.ts`):

Key format: `source/{contentHash}.tar.gz`

The tarball is **platform-agnostic** — raw `.kici/` source files are identical across architectures, so one entry serves linux-x64, linux-arm64, darwin-arm64, and win32-x64 agents alike. `contentHash` changes when any workflow `.ts` source changes or any file listed in `hashFiles([...])` changes.

**Dependency tarball** is keyed by:

- **Lockfile hash**: SHA-256 of the workflow's lock file — `.kici/package-lock.json` for an npm project, or the repo-root `pnpm-lock.yaml` for a pnpm workspace
- **Platform**: detected from the target agent (e.g., `linux`, `darwin`, `win32`; defaults to `linux` when no agents are registered)
- **Arch**: detected from the target agent (e.g., `x64`, `arm64`; defaults to `x64` when no agents are registered)

Key format: `deps/{platform}-{arch}/{lockfileHash}.tar.gz`

When the lockfile changes (new dependency added, version bumped), the cache key changes and a fresh build is triggered. When the lockfile is unchanged and the platform/arch match, the cached tarball is reused. Different architectures produce separate cache entries (e.g., `deps/linux-x64/abc123.tar.gz` and `deps/linux-arm64/abc123.tar.gz`) because native `node_modules` builds are not portable.

### Source cache and dep cache

KiCI maintains two caches that share the same storage backend:

| Cache        | Key Format                                     | Contents                                                                                              | Invalidation                                                                                  | Platform scope             |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| Source cache | `source/{contentHash}.tar.gz`                  | Raw `.kici/` directory minus `node_modules/` (deterministic gzip tar)                                 | Workflow `.ts` or any `hashFiles` asset changes; `COMPILE_SCHEMA_VERSION` bump                | Shared (platform-agnostic) |
| Dep cache    | `deps/{platform}-{arch}/{lockfileHash}.tar.gz` | `.kici/node_modules/` packed by the detected manager's install — npm or pnpm (deterministic gzip tar) | Lock file changes (`package-lock.json` or `pnpm-lock.yaml`); separate entry per platform/arch | Platform-specific          |

Both use the same `KICI_STORAGE_*` configuration. A single build job handles both caches when both miss — the build agent clones, installs dependencies with the detected manager (npm or pnpm), then packs `.kici/` source and `node_modules/` in parallel and uploads each via its own pre-signed `PUT` URL.

### Determinism

Both tarballs are produced in **portable tar mode** (user/group/mtime stripped) so the same input bytes produce the same output bytes on any builder host:

- Source tarball hash (the SHA-256 of the tarball bytes) equals across builders for the same `.kici/` source. The cache key itself, however, uses the workflow `contentHash` (a hash of the raw `.ts` source + optional asset digest) — so the cache key is independent of tar encoding and stable even across portability edge cases.
- Dep tarball hash equals across builders for the same lock file + platform + arch, assuming the install produced byte-identical `node_modules` (which it does when the lockfile is fully pinned).

The workflow `contentHash` is mixed with a `COMPILE_SCHEMA_VERSION` constant (currently `5`). The hash input is line-ending-normalized (CRLF → LF) so a Linux-compiled lockfile matches the agent's hash on Windows hosts whose Git installs default `core.autocrlf=true`. Bumping `COMPILE_SCHEMA_VERSION` invalidates every existing source cache entry even if source is unchanged, which is the correct behavior when the compile-time or runtime contract changes.

### Integrity verification

- **Dependency tarball:** the build agent reports the SHA-256 of the tarball bytes in `cache.upload.complete`; the orchestrator stores it as a companion `.hash` file and sends it alongside `depsUrl` in `job.dispatch`. The execution agent streams the download through a SHA-256 hasher and fails the job (with up to 2 retries on HTTP(S) transports) if the hash does not match.
- **Source tarball:** `sourceTarHash` on the `job.dispatch` message carries the **workflow `contentHash`**, not the tarball-bytes hash. The orchestrator-signed S3 GET URL establishes provenance; after extraction, `loadWorkflowSource` re-computes `contentHash` against the extracted raw source and fails the job with a **"lock file is out of date"** error if it diverges from the lock file's value. This covers lock-file drift end-to-end.

### Lock file and drift

The lock file at the commit SHA is the source of trigger matching and cache keys. If workflow source (`.ts`) changes without regenerating the lock file, the repo has _drift_. The execution agent verifies the raw workflow source it loaded against the lock file's `contentHash` before any step runs. If the hashes disagree, the run fails with a clear **"lock file is out of date"** error (including the baked agent `@kici-dev/sdk` version + bundle hash for cross-host debugging) instead of running with the wrong workflow. Encourage workflow authors to commit the lock file with their changes and to use `kici compile --check` in CI; see the user guide [Lock file and workflow drift](../user/lock-file-and-drift.md).

## Configuration

All cache configuration is set via environment variables on the orchestrator.

### Storage backend

| Variable                         | Default       | Description                                                                                              |
| -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `KICI_STORAGE_TYPE`              | (optional)    | Storage backend: `s3`                                                                                    |
| `KICI_STORAGE_BUCKET`            | (required)    | S3 bucket name                                                                                           |
| `KICI_STORAGE_PREFIX`            | `kici-cache/` | Key prefix within the bucket                                                                             |
| `KICI_STORAGE_REGION`            | (optional)    | AWS region                                                                                               |
| `KICI_STORAGE_ENDPOINT`          | (optional)    | Custom S3 endpoint URL (for SeaweedFS, LocalStack)                                                       |
| `KICI_STORAGE_EXTERNAL_ENDPOINT` | (optional)    | Separate S3 endpoint baked into pre-signed URLs handed to **agents**                                     |
| `KICI_STORAGE_UPLOAD_ENDPOINT`   | (optional)    | Separate S3 endpoint baked into the pre-signed upload URL handed to the **host CLI** (`kici run remote`) |
| `KICI_STORAGE_FORCE_PATH_STYLE`  | (optional)    | Set to `true` for path-style access (required for SeaweedFS)                                             |
| `KICI_STORAGE_LOG_BUCKET`        | (optional)    | Separate S3 bucket for log storage (when logs and cache use different buckets)                           |

### Cache behavior

| Variable                       | Default              | Description                                              |
| ------------------------------ | -------------------- | -------------------------------------------------------- |
| `KICI_CACHE_TTL_DAYS`          | `30`                 | Days of inactivity before cache entries expire           |
| `KICI_CACHE_MAX_TARBALL_BYTES` | `524288000` (500 MB) | Maximum dependency tarball size; build fails if exceeded |
| `KICI_CACHE_BUILD_TIMEOUT_MS`  | `600000` (10 min)    | Maximum time for a build job to complete                 |

### S3 storage (AWS)

For production deployments with multiple orchestrator instances or when persistent storage beyond the host is needed.

```bash
KICI_STORAGE_TYPE=s3
KICI_STORAGE_BUCKET=my-kici-cache
KICI_STORAGE_PREFIX=kici-cache/
KICI_STORAGE_REGION=us-east-1
```

Agents receive pre-signed S3 URLs (15-minute expiry) for direct download from S3.

### S3-compatible storage (MinIO, SeaweedFS, LocalStack)

For self-hosted deployments that cannot reach AWS (air-gapped, regulated environments), any S3-compatible service works. Set `KICI_STORAGE_ENDPOINT` to the service URL and `KICI_STORAGE_FORCE_PATH_STYLE=true` so the AWS SDK skips DNS-based virtual-host resolution (which only works for real AWS).

```bash
KICI_STORAGE_TYPE=s3
KICI_STORAGE_BUCKET=kici-cache
KICI_STORAGE_ENDPOINT=http://minio:9000
KICI_STORAGE_FORCE_PATH_STYLE=true
KICI_STORAGE_REGION=us-east-1
```

If the service runs in an "allow all / no auth" mode (e.g. a dev MinIO), the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables can be omitted.

## Build agent setup

Build agents are separate from execution agents. They handle dependency installation and source/deps tarball packing.

### Scaler configuration

In your scaler YAML config, use the `roles` field to designate build agents:

```yaml
# /etc/kici/scalers.d/builders.yaml
scalers:
  - name: builders
    type: container
    maxAgents: 3
    roles: [builder]
    labelSets:
      - labels: ['linux']
        image: kici-agent:latest
        # Build agents need npm available (ships with Node.js)
    warmPool:
      enabled: true
      size: 1
```

And a separate scaler for execution agents:

```yaml
# /etc/kici/scalers.d/runners.yaml
scalers:
  - name: runners
    type: container
    maxAgents: 10
    labelSets:
      - labels: ['default']
        image: kici-agent:latest
    warmPool:
      enabled: true
      size: 1
```

Build jobs are routed to agents with the `kici:role:builder` auto-label (injected from the `roles` config). Execution jobs go to agents matching the workflow's `runsOn` labels.

### Roles configuration

The `roles` field on scaler entries controls which internal job types an agent can handle:

| Value         | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| `builder`     | Handles build jobs (dependency install, source + deps tarball packing, cache upload) |
| `init-runner` | Handles init jobs (dynamic field resolution)                                         |
| `all`         | Handles both build and init jobs (default)                                           |

- **Default:** `all` -- agents without an explicit `roles` field handle all job types.
- **Empty array (`roles: []`):** Execution only -- the agent handles user workflow jobs but not internal build/init jobs.
- Roles manifest as `kici:role:*` auto-labels (e.g., `kici:role:builder`) which the orchestrator uses for label-based routing.
- Build and init jobs also require matching platform labels (`kici:os:*`, `kici:arch:*`), so builder agents must run on the same platform as execution agents.

### Build agent requirements

Build agents need the following tools installed:

- **Node.js 24+** (same as execution agents)
- **npm** (included with Node.js -- the default dependency installer)
- **pnpm** -- required only when building workflows that live in a pnpm workspace; the agent shells out to `pnpm install` for those

## Monitoring

The orchestrator exposes Prometheus metrics for cache performance:

| Metric                                | Type      | Description                                   |
| ------------------------------------- | --------- | --------------------------------------------- |
| `kici_orch_dep_cache_hits_total`      | Counter   | Total number of dep cache hits                |
| `kici_orch_dep_cache_misses_total`    | Counter   | Total number of dep cache misses              |
| `kici_orch_source_cache_hits_total`   | Counter   | Total number of source tarball cache hits     |
| `kici_orch_source_cache_misses_total` | Counter   | Total number of source tarball cache misses   |
| `kici_orch_build_duration_seconds`    | Histogram | Duration of build agent operations in seconds |

Monitor the hit/miss ratio to understand cache effectiveness. A healthy cache should show a high hit rate after the initial cold-start period.

## Troubleshooting

### S3 endpoint not configured

**Symptom:** S3 operations fail with DNS resolution errors like `getaddrinfo ENOTFOUND bucket.s3.region.amazonaws.com`.

**Cause:** Missing `KICI_STORAGE_ENDPOINT` when using a non-AWS S3 service.

**Fix:** Set `KICI_STORAGE_ENDPOINT` to the S3 API URL (e.g., `http://seaweedfs:3900`) and `KICI_STORAGE_FORCE_PATH_STYLE=true`.

### Build job dispatched to execution agent

**Symptom:** Build jobs fail because npm install fails unexpectedly on the agent.

**Cause:** No agents have the `builder` role configured, or the builder agent's platform labels don't match the target platform.

**Fix:** Add `roles: [builder]` to a scaler entry, or use the default (no `roles` field, equivalent to `roles: [all]`) which handles both build and execution jobs. Ensure builder agents run on the same platform as execution agents.

### Tarball exceeds maximum size

**Symptom:** Build fails with `Dep tarball exceeds max size`.

**Cause:** The packed `node_modules` directory is larger than `KICI_CACHE_MAX_TARBALL_BYTES` (default 500 MB).

**Fix:** Increase `KICI_CACHE_MAX_TARBALL_BYTES` or reduce the dependency tree. Consider whether all dependencies are actually needed for workflow execution.

### Hash mismatch on download

**Symptom:** Agent fails with `Dep tarball hash mismatch: expected <hash>, got <hash>`.

**Cause:** The cached tarball was corrupted or modified between upload and download. This can happen with storage backend issues.

**Fix:** For HTTP/HTTPS downloads, the agent retries up to 2 times automatically (3 total attempts) with streaming hash verification. For `file://` URLs, there is no retry. If all attempts fail, clear the cached entry and let the next build repopulate it. Check the storage backend for corruption or intermittent errors.

### Cache miss rate unexpectedly high

**Symptom:** Build jobs run more often than expected despite no dependency changes.

**Cause:** The lockfile is changing between runs (e.g., `npm install` modifying metadata in `.kici/package-lock.json`). The cache key is based on the full lockfile content hash.

**Fix:** Use `npm ci` in your development workflow to keep lockfiles stable. Commit `.kici/package-lock.json` to version control.

## See also

- [Orchestrator configuration](orchestrator/configuration.md) -- full environment variable reference
- [Auto-scaler configuration](orchestrator/auto-scaler.md) -- scaler YAML config and label routing
- [Architecture: data flows](../architecture/data-flows.md) -- cache miss and cache hit data flows
