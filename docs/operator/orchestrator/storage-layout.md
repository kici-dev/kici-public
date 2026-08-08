---
title: Storage layout
description: Bucket and prefix map for every object-storage subsystem the orchestrator writes to
---

The orchestrator writes to **three independent object-storage subsystems**: cache, logs, and cold-store. Each is configured with its own env vars and key prefix; they can share a bucket or use separate ones depending on retention and access patterns. This doc is the canonical map of which prefix holds what data, which env var names the bucket, and where to look in code if the doc and reality drift.

> **Doc invariants:** any change to a storage prefix, env var, or cold-store table requires updating this doc in the same commit. See `.claude/rules/storage.md` for the enforced 1:1 rules.

## Bucket inventory

| Subsystem  | Bucket env var            | Default prefix | Retention                                                                                                                     | What lives there                                                                              |
| ---------- | ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cache      | `KICI_STORAGE_BUCKET`     | _(none)_       | TTL via `KICI_CACHE_TTL_DAYS` (default 30 days)                                                                               | Compiled source tarballs, dependency tarballs, dep-tarball integrity-hash companions          |
| Logs       | `KICI_STORAGE_LOG_BUCKET` | `kici-logs/`   | Step logs: cleanup sweep after `KICI_STEP_LOG_TTL_DAYS` (default 90; 0 disables); webhook payloads → cold-store after 30 days | NDJSON step logs, gzipped webhook delivery payloads                                           |
| Cold-store | `KICI_COLD_STORE_BUCKET`  | `cold-store/`  | Per-table tier (`30d` / `180d` / `1y` / `2y` / `forever`)                                                                     | Append-only archive of execution rows, secret-audit-log rows, access-log rows, event-log rows |

The log bucket falls back to the cache bucket if `KICI_STORAGE_LOG_BUCKET` is unset; the cold-store bucket is independent and may live in a different account/region.

## Cache storage

Compiled source bundles and dependency tarballs the orchestrator hands to execution agents. Two backends ship:

- `s3` — pre-signed URLs against an S3-compatible bucket. Recommended for multi-host / production deployments.
- `filesystem` — local files served through the orchestrator's HMAC-signed `/api/v1/cache/blob/<key>` HTTP route. Intended for single-host deployments and E2E sandboxes where standing up an S3-compatible service is overkill.

### Prefixes

| Key                                                                   | Description                                                                                                                                                                                                                                                   | Source                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `source/{contentHash}.tar.gz`                                         | Platform-agnostic source tarball (`.kici/` minus `node_modules/`); one entry shared across linux-x64 / linux-arm64 / etc.                                                                                                                                     | `packages/orchestrator/src/storage/s3.ts`                                 |
| `deps/{platform}-{arch}/{lockfileHash}.tar.gz`                        | Platform-specific dependency tarball; one entry per (platform, arch, lockfile-hash) tuple.                                                                                                                                                                    | `packages/orchestrator/src/storage/s3.ts`                                 |
| `deps/{platform}-{arch}/{lockfileHash}.tar.gz.hash`                   | SHA-256 companion file for dep-tarball integrity verification.                                                                                                                                                                                                | `packages/orchestrator/src/storage/s3.ts`                                 |
| `provenance/{runId}/{jobId}/{subjectDigest}.kici.json`                | Signed build-provenance bundle produced by `ctx.attestProvenance` (DSSE envelope + ephemeral public key + identity token). One entry per attested artifact; the `attestations` DB row points at this key.                                                     | `packages/engine/src/provenance/bundle.ts` (`provenanceStorageKey`)       |
| `agent-packages/{version}/kici-agent-{platform}.tar.gz` (+ `.sha256`) | Self-contained agent + vendored Node payload for fresh-box bootstrap, produced by `kici-admin agent package --upload`. Version-keyed so a given version is always the same bytes; the `.sha256` sidecar is verified on the box before extract.                | `packages/orchestrator/src/agent-packaging/upload.ts` (`agentPackageKey`) |
| `.kici-cluster-id`                                                    | Cluster identity sentinel (UUID). Written once on first orch boot, validated on every subsequent boot. Mismatch with `cluster_meta.cluster_id` blocks startup — see [cluster identity](../../architecture/clustering/multi-orchestrator.md#cluster-identity). | `packages/orchestrator/src/cluster/cluster-identity.ts`                   |

The source / deps keys are namespaced under the configured prefix, which defaults to **empty** — the bucket already scopes the cache, so the default keys land at `<bucket>/source/...` and `<bucket>/deps/...` with no extra path segment. Set `KICI_STORAGE_PREFIX` to add an explicit prefix when two clusters share a physical bucket. The `.kici-cluster-id` sentinel sits at `<KICI_STORAGE_PREFIX>/.kici-cluster-id` (or at the bucket root when no prefix is set), so two clusters can safely share a physical bucket as long as they use distinct prefixes.

### Env vars

| Env var                            | Required?               | Description                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KICI_STORAGE_TYPE`                | yes (when caching)      | `s3` or `filesystem`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `KICI_STORAGE_BUCKET`              | yes (when `s3`)         | Bucket name                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KICI_STORAGE_PREFIX`              | no (empty)              | Object-key prefix. Defaults to empty (the bucket already scopes the cache); set it to share one physical bucket across clusters via distinct per-cluster prefixes                                                                                                                                                                                                                                                                    |
| `KICI_STORAGE_REGION`              | no                      | AWS region                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KICI_STORAGE_ENDPOINT`            | no                      | Custom S3 endpoint the orchestrator uses for its own object operations                                                                                                                                                                                                                                                                                                                                                               |
| `KICI_STORAGE_EXTERNAL_ENDPOINT`   | no                      | Endpoint baked into pre-signed URLs handed to **agents** (container-routable). Falls back to `KICI_STORAGE_ENDPOINT` when unset                                                                                                                                                                                                                                                                                                      |
| `KICI_STORAGE_UPLOAD_ENDPOINT`     | no                      | Endpoint baked into the pre-signed **upload** URL handed to the host CLI running `kici run remote`. Set when the developer machine reaches the bucket at a different address than the orchestrator. Falls back to `KICI_STORAGE_ENDPOINT` when unset                                                                                                                                                                                 |
| `KICI_STORAGE_FORCE_PATH_STYLE`    | no                      | `true` for S3-compatible services that need path-style addressing                                                                                                                                                                                                                                                                                                                                                                    |
| `KICI_STORAGE_FS_PATH`             | yes (when `filesystem`) | Absolute directory where blobs are stored                                                                                                                                                                                                                                                                                                                                                                                            |
| `KICI_STORAGE_FS_BASE_URL`         | no                      | Base URL the agent uses to reach the orchestrator (e.g., `http://orch.local:10143`). Defaults to `http://127.0.0.1:<KICI_PORT>`                                                                                                                                                                                                                                                                                                      |
| `KICI_STORAGE_LOG_BUCKET`          | no                      | Optional separate bucket for log storage (see "Log storage" below)                                                                                                                                                                                                                                                                                                                                                                   |
| `KICI_CACHE_TTL_DAYS`              | no (`30`)               | Days of inactivity before an entry is evicted (touch-on-read). Overridable per cluster at runtime via `kici-admin cluster-settings --cache-ttl-days`.                                                                                                                                                                                                                                                                                |
| `KICI_STEP_LOG_TTL_DAYS`           | no (`90`)               | Step-log object retention (days). The cleanup sweep bulk-deletes S3 step-log objects older than this. `0` disables the sweep — the opt-out for operators running their own bucket lifecycle rule. S3 backend only; the filesystem backend's lifecycle is operator-managed.                                                                                                                                                           |
| `KICI_DISPATCH_QUEUE_TTL_DAYS`     | no (`30`)               | Terminal `dispatch_queue` **row** retention (days, Postgres — not object storage). The cleanup sweep deletes completed/failed/expired rows older than this; the durable run history lives in the cold-stored `execution_*` tables. `0` disables pruning.                                                                                                                                                                             |
| `KICI_CHECK_RUN_TRACKING_TTL_DAYS` | no (`7`)                | `check_run_tracking` **row** retention (days, Postgres — not object storage). The cleanup sweep deletes rows untouched for longer than this; the window is inactivity age, not run completion, so a check-run status update arriving after its run was pruned can still resolve which check run to update. `0` disables pruning. Overridable per cluster at runtime via `kici-admin cluster-settings --check-run-tracking-ttl-days`. |
| `KICI_CACHE_MAX_TARBALL_BYTES`     | no (`524288000`)        | Max dep-tarball size; build fails if exceeded. Overridable per cluster at runtime via `kici-admin cluster-settings --cache-max-tarball-bytes`.                                                                                                                                                                                                                                                                                       |
| `KICI_CACHE_BUILD_TIMEOUT_MS`      | no (`600000`)           | Build job timeout                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `KICI_USER_CACHE_QUOTA_BYTES`      | no (`5368709120`)       | Cluster-wide **default** byte quota for the user-facing cache (`ctx.cache` / declarative job-step cache); least-recently-used entries evicted past quota. Overridable per org via `org_settings.user_cache_quota_bytes` (`kici-admin org-settings user-cache set-quota`)                                                                                                                                                             |
| `KICI_USER_CACHE_TTL_MS`           | no (`604800000`)        | Cluster-wide **default** per-entry TTL for the user-facing cache (touch-on-read). Overridable per org via `org_settings.user_cache_ttl_ms` (`kici-admin org-settings user-cache set-ttl`)                                                                                                                                                                                                                                            |
| `KICI_ARTIFACT_QUOTA_BYTES`        | no (`21474836480`)      | Cluster-wide **default** per-org byte quota for user-facing artifacts (`ctx.artifacts`). Overridable per org via `org_settings.artifact_quota_bytes` (`kici-admin org-settings artifacts set-quota`)                                                                                                                                                                                                                                 |
| `KICI_ARTIFACT_TTL_MS`             | no (`2592000000`)       | Cluster-wide **default** per-artifact TTL. An artifact is treated as expired (excluded from downloads, listings, and quota) this many ms after creation. Overridable per org via `org_settings.artifact_ttl_ms` (`kici-admin org-settings artifacts set-ttl`)                                                                                                                                                                        |
| `KICI_ARTIFACT_MAX_BYTES`          | no (`1073741824`)       | Cluster-wide **default** per-artifact size cap (1 GiB). An upload declaring more than this is refused with `size_cap` before any presigned PUT is minted. Overridable per org via `org_settings.artifact_max_bytes` (`kici-admin org-settings artifacts set-max-bytes`)                                                                                                                                                              |
| `KICI_ARTIFACT_MAX_PER_RUN`        | no (`50`)               | Cluster-wide **default** max number of artifacts a single run may upload; the next upload is refused with `run_cap`. Overridable per org via `org_settings.artifact_max_per_run` (`kici-admin org-settings artifacts set-max-per-run`)                                                                                                                                                                                               |

#### The three endpoints (one per vantage point)

`kici run remote` involves three parties that each reach the bucket from a different place on the network, so the S3 backend exposes three endpoint knobs:

| Endpoint                         | Used by                                                           | Set it to an address reachable from             |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `KICI_STORAGE_ENDPOINT`          | the orchestrator's own object operations (head / copy / metadata) | the orchestrator process                        |
| `KICI_STORAGE_UPLOAD_ENDPOINT`   | the host CLI's pre-signed **upload** URL                          | the developer machine running `kici run remote` |
| `KICI_STORAGE_EXTERNAL_ENDPOINT` | the agent's pre-signed up/download URLs                           | the execution agent (often a container)         |

When the orchestrator, the developer machine, and the agents all reach the bucket at the same address (e.g. a public AWS S3 endpoint), only `KICI_STORAGE_ENDPOINT` is needed — the other two fall back to it. They matter when the addresses diverge: the Docker quickstart, for example, runs the orchestrator in a container (so its endpoint is the compose DNS name `seaweedfs:8333`), the host CLI uses `localhost:8333`, and spawned agent containers use `host.docker.internal:8333`.

These three endpoints are **static connection / topology configuration**, set once per deployment based on the network layout. They are **not** per-tenant `org_settings` tunables — they describe where each party reaches the bucket, which is a property of the deployment's network, not of any one organization.

#### Startup validation: loopback agent-facing endpoint

When at least one scaler is configured (`container`, `firecracker`, or `bare-metal`), the orchestrator **refuses to start** if the agent-facing storage URL resolves to a loopback address (`localhost`, `127.x`, `::1`, `0.0.0.0`). A loopback URL is only reachable by a co-located process, so a scaled agent — which runs in a separate network namespace, microVM, or host — would fail its overlay/cache download with `ECONNREFUSED`. Failing fast at startup surfaces the misconfiguration as a clear orchestrator-side error instead of an opaque agent-side connection refusal.

- **S3 storage:** set `KICI_STORAGE_EXTERNAL_ENDPOINT` to an address the agents can reach (the agent-facing pre-signed URLs are signed against it). A loopback `KICI_STORAGE_ENDPOINT` paired with a routable `KICI_STORAGE_EXTERNAL_ENDPOINT` passes — the orchestrator validates the **agent-facing** URL, not its own.
- **Filesystem storage:** set `KICI_STORAGE_FS_BASE_URL` to the orchestrator's agent-reachable base URL. The loopback default (`http://127.0.0.1:<KICI_PORT>`) only works for co-located agents — i.e. a no-scaler orchestrator.

A no-scaler orchestrator (agents managed externally and assumed co-located, or none at all) skips this check entirely. The error names the exact env var to set and is written to the orchestrator logs (`kici-admin orchestrator logs`), where an operator looks.

#### `kici run remote` against a hidden orchestrator

`kici run remote` uploads the working-tree overlay **directly** from the developer machine to the object store via a pre-signed PUT URL minted with `KICI_STORAGE_UPLOAD_ENDPOINT` (falling back to `KICI_STORAGE_ENDPOINT`). The run is initiated and its logs are retrieved through the Platform relay over a WebSocket connection — the developer machine never talks to the orchestrator's HTTP API directly. This means an orchestrator can sit entirely behind a private network: only the **object store** needs to be reachable from the developer machine for remote runs to work; the orchestrator's HTTP API does not. Point `KICI_STORAGE_UPLOAD_ENDPOINT` at a dev-reachable bucket address whenever the developer machine reaches the object store at a different address than the orchestrator does.

`kici run remote` is offered **by the Platform** — an orchestrator with no Platform connection cannot serve remote runs (there is no air-gapped, orchestrator-direct remote-run path). Executing workflow steps on the developer machine with no orchestrator at all is `kici run <event> --local`.

### Filesystem backend specifics

When `KICI_STORAGE_TYPE=filesystem`, the orchestrator stores each blob as a file under `KICI_STORAGE_FS_PATH/<key>` with a sibling `<key>.meta.json` carrying the same `created-at` / `last-accessed-at` timestamps the S3 backend uses for TTL. The cache infrastructure (source cache, dep cache, build coordinator) treats both backends uniformly — the only difference is how URLs are minted.

Agents fetch blobs over HTTP at `<KICI_STORAGE_FS_BASE_URL>/api/v1/cache/blob/<key>?sig=<token>`. The `sig` token is an HMAC-SHA256 over `(method, key, expiry)` keyed by a process-local secret generated at boot, with a one-hour lifetime. Tokens become invalid on orchestrator restart — fine for the single-host deployment shape the backend targets. Upload completion still flows through the existing `cache.upload.complete` WebSocket message so the orchestrator can stamp metadata atomically.

The filesystem backend is not appropriate for production: the cache directory is local to one orchestrator host, the URLs are not portable across orchestrator restarts, and there is no shared-bucket lifecycle policy to fall back on for TTL enforcement. Lazy expiry via `last-accessed-at` is the only eviction path — long-running deployments should still pick `s3`.

These names are read directly by `loadConfig()` in `packages/orchestrator/src/config.ts` and bridged into the `storage.*` config field. They follow the project-wide `KICI_`-prefix convention and benefit from the unknown-env-var typo catcher at boot.

### Sizing & API ops

> Estimates derived from configurable caps and per-event derivation. Empirical numbers depend on workload — verify against the linked Prometheus metrics on a running deployment.

| Object                                | Typical size           | Hard cap                                                                                | Write op                                                            | Read op                                                    |
| ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `source/{contentHash}.tar.gz`         | tens of KB to a few MB | none (raw `.kici/` minus node_modules)                                                  | 1× `PutObject` per cache MISS (per unique workflow content)         | 1× `GetObject` per execution job dispatch (cache HIT path) |
| `deps/{platform}-{arch}/{...}.tar.gz` | 50–200 MB (npm deps)   | `KICI_CACHE_MAX_TARBALL_BYTES` (500 MB; per-cluster override `cache_max_tarball_bytes`) | 1× `PutObject` per cache MISS (per unique lockfile + platform/arch) | 1× `GetObject` per execution job dispatch                  |
| `deps/{...}.tar.gz.hash`              | 64 bytes (SHA-256 hex) | --                                                                                      | 1× `PutObject` per dep MISS (companion to dep tarball)              | 1× `GetObject` per dep download (integrity check)          |

**Per-job cost** (cache HIT path): 2× `GetObject` (1 source + 1 dep) on the agent's pre-signed URL — the orchestrator itself only signs the URLs.

**Per-build cost** (cache MISS): 2× `PutObject` (source + dep) + 1× `PutObject` for the `.hash` companion + 2× metadata `CopyObject` (initMeta TTL bookkeeping). Build duration tracked by `kici_orch_build_duration_seconds`.

**Touch-on-read** (every cache HIT): 1× `CopyObject` to refresh the `last-accessed-at` metadata. This is fire-and-forget; failure to touch does not fail the dispatch.

**Hit/miss ratio** (verifiable): `kici_orch_source_cache_hits_total` / `kici_orch_source_cache_misses_total` and `kici_orch_dep_cache_hits_total` / `kici_orch_dep_cache_misses_total`.

### Lifecycle

| Phase   | Trigger                                       | What happens                                                                                                                                           |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Created | Build job completes (cache MISS path)         | Build agent uploads via pre-signed PUT URL; orchestrator runs `initMeta` (`CopyObject` to set `last-accessed-at`); writes `.hash` companion for deps   |
| Updated | (immutable content; only metadata refreshed)  | `S3CacheStorage.get()` issues a `CopyObject` to bump `last-accessed-at` on every cache HIT (touch-on-read)                                             |
| Deleted | TTL expiry (`KICI_CACHE_TTL_DAYS` default 30) | S3 bucket lifecycle rule deletes objects whose `last-accessed-at` is older than the TTL; lazy delete also runs in `get()` if the object is found stale |

Source: `packages/orchestrator/src/storage/s3.ts`. See [dependency caching](../dependency-caching.md) for the full cache flow including pre-signed URL exchanges and integrity verification.

## User cache

The user-facing cache backs the SDK's declarative `cache: { key, paths, restoreKeys? }` on jobs/steps and the imperative `ctx.cache.restore()` / `ctx.cache.save()` API. It reuses the same `CacheStorage` backend (and the same `KICI_STORAGE_*` configuration) as the source/dep cache above, but lives under its own `cache/` prefix and has its own per-org quota and TTL. See the [SDK caching reference](../../user/sdk/caching.md) for the author-facing surface.

The byte quota and per-entry TTL are **cluster-configurable per org**. The `KICI_USER_CACHE_QUOTA_BYTES` / `KICI_USER_CACHE_TTL_MS` env vars set the cluster-wide default; an operator overrides them for a single tenant at runtime by writing `org_settings.user_cache_quota_bytes` / `org_settings.user_cache_ttl_ms` (both NULLABLE — NULL means "use the cluster default"). The override is reachable through both the orchestrator admin HTTP route and the CLI:

```bash
# Read the current per-org quota + TTL (cluster default shown when unset):
kici-admin org-settings user-cache show --org <customerId>
# Set a per-org override (positive integer; bytes / milliseconds):
kici-admin org-settings user-cache set-quota 10737418240 --org <customerId>   # 10 GiB
kici-admin org-settings user-cache set-ttl 1209600000 --org <customerId>      # 14 days
# Clear the override and fall back to the cluster default:
kici-admin org-settings user-cache reset-quota --org <customerId>
kici-admin org-settings user-cache reset-ttl --org <customerId>
```

The orchestrator resolves the effective quota + TTL from `org_settings` at cache operation time, falling back to the env-var default when the org column is NULL.

### Prefixes

| Key                                                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `cache/<orgId>/<repoId>/shared/<key>-<discriminator>.tar.gz`       | Committed cache entry for a **trusted** ref (org-shared scope, visible to every run of the repo). Immutable: first save under an exact key wins. The `{discriminator}` is a hash of the exact cache key, so two keys differing only by case stay distinct objects even on a case-insensitive store such as the filesystem backend on a macOS or Windows host — without it, a restore for one key could be served the tarball saved under the other. It is a suffix, so `restoreKeys` prefix matching is unaffected. Entries written in the earlier un-discriminated form are still restored on an exact-key lookup for one cache-TTL window (default 7 days), and only when the key could not have been part of a case collision. | `packages/orchestrator/src/cache/user-cache.ts` |
| `cache/<orgId>/<repoId>/iso/<runId>/<key>-<discriminator>.tar.gz`  | Committed cache entry for an **untrusted / fork** ref (per-run isolated scope). Reads fall back to the shared scope, but writes can never land in `shared/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/orchestrator/src/cache/user-cache.ts` |
| `cache/<orgId>/<repoId>/<scope>/<key>-<discriminator>.tar.gz.hash` | SHA-256 companion of the tarball bytes, for integrity verification on download (the presigned upload carries no custom metadata).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/orchestrator/src/cache/user-cache.ts` |
| `cache/<orgId>/<repoId>/<scope>/<key>-<discriminator>.tar.gz.size` | Tarball byte-size companion, used for per-org quota accounting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `packages/orchestrator/src/cache/user-cache.ts` |
| `cache/<orgId>/<repoId>/<scope>/.tmp-<uuid>.tar.gz`                | Transient upload target for an in-flight save. Copied to the final `<key>-<discriminator>.tar.gz` and deleted on commit, so a crashed save never leaves a corrupt final entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/orchestrator/src/cache/user-cache.ts` |

**Isolation invariant.** Every key is namespaced under `cache/<orgId>/` first, so no tenant can read another tenant's cache — the org segment is the per-tenant boundary and the per-org quota scope. Within an org, `<repoId>` separates repositories, and the trailing scope segment separates the **shared** (trusted-ref) scope from per-run **isolated** (untrusted/fork-ref) scopes. A trusted ref reads and writes `shared/`; an untrusted ref reads its own `iso/<runId>/` then falls back to `shared/` on restore, but writes **only** to `iso/<runId>/`. This is the cache-isolation model that stops a fork build from poisoning the cache a trusted branch later restores. The orchestrator maps a ref's trust level to the write scope via the `cacheRefScope` field on the job dispatch (`trusted → shared`, otherwise `isolated`).

### Sizing & API ops

| Object                        | Typical size                    | Hard cap                                                                                                | Write op                                                                                                     | Read op                                                           |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `cache/.../<key>.tar.gz`      | KB to hundreds of MB (workload) | per-org quota: `org_settings.user_cache_quota_bytes` if set, else `KICI_USER_CACHE_QUOTA_BYTES` (5 GiB) | 1× presigned `PutObject` (to temp) + 1× `CopyObject` (temp→final) + 1× `initMeta` `CopyObject` per save MISS | 1× presigned `GetObject` per cache HIT (agent downloads directly) |
| `cache/.../<key>.tar.gz.hash` | 64 bytes (SHA-256 hex)          | --                                                                                                      | 1× `PutObject` on commit                                                                                     | 1× `GetObject` per restore (integrity check on download)          |
| `cache/.../<key>.tar.gz.size` | <16 bytes (decimal byte count)  | --                                                                                                      | 1× `PutObject` on commit                                                                                     | 1× `GetObject` per quota sweep entry                              |

**Per-restore cost** (cache HIT): 1× presigned `GetObject` (the agent fetches the tarball directly) + 1× `GetObject` for the `.hash` companion + 1× `CopyObject` touch-on-read to refresh the entry's TTL.

**Per-save cost** (cache MISS): 1× presigned `PutObject` to a `.tmp-<uuid>` object, then on commit 1× `CopyObject` (temp→final) + 1× `DeleteObject` (temp) + 1× `initMeta` `CopyObject` + 2× `PutObject` (`.hash` + `.size`). A save under an already-existing exact key is skipped entirely (immutable no-op).

**Quota sweep** (on every commit): 1× `ListObjectsV2` over `cache/<orgId>/` + 1× `GetObject` per entry's `.size` companion to total the org's bytes; if over quota, the orchestrator reads each entry's `last-accessed-at` metadata and evicts least-recently-used-first (`HeadObject` / `.meta.json` read per candidate), `DeleteObject`-ing the tarball + its `.hash` + `.size` companions until back under quota. Each eviction is logged.

### Lifecycle

| Phase   | Trigger                                       | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created | A save under a new exact key commits          | Agent uploads via presigned PUT to a `.tmp-<uuid>` object; orchestrator copies temp→final, runs `initMeta`, writes `.hash` + `.size` companions, deletes the temp                                                                                                                                                                                                                                                                                                                                                         |
| Updated | (immutable content; only metadata refreshed)  | A restore issues a `CopyObject` touch-on-read to bump `last-accessed-at` (TTL refresh). A re-save under an existing exact key is a no-op.                                                                                                                                                                                                                                                                                                                                                                                 |
| Deleted | Per-org quota exceeded on save, or TTL expiry | Quota: least-recently-used entries (oldest `lastAccessedAt`, refreshed on every restore) evicted on the committing save until the org is under its effective quota (`org_settings.user_cache_quota_bytes`, else the `KICI_USER_CACHE_QUOTA_BYTES` default). TTL: entries unused for the org's effective TTL (`org_settings.user_cache_ttl_ms`, else the `KICI_USER_CACHE_TTL_MS` 7-day default) expire lazily on access — the per-org TTL is threaded into the backing `CacheStorage` access as a per-operation override. |

Source: `packages/orchestrator/src/cache/user-cache.ts`. The quota and TTL default cluster-wide via `KICI_USER_CACHE_QUOTA_BYTES` / `KICI_USER_CACHE_TTL_MS` (see the [env vars](#env-vars) table above) and are overridable per org via `org_settings.user_cache_quota_bytes` / `org_settings.user_cache_ttl_ms` (`kici-admin org-settings user-cache`). See [architecture: data flows](../../architecture/data-flows.md#user-facing-cache-flow) for the restore/save protocol and the trust→scope mapping.

## Artifacts

User-facing artifacts back the SDK's imperative `ctx.artifacts.upload(name, paths)` / `ctx.artifacts.download(name, destDir?)` API — named, immutable-per-run build deliverables shared between jobs of a run and downloadable from the dashboard run detail. They reuse the same `CacheStorage` backend (and the same `KICI_STORAGE_*` configuration) as the cache above, but live under their own `artifacts/` prefix, carry one `artifacts` DB row per upload, and have an independent per-org quota + TTL. See the [SDK artifacts reference](../../user/sdk/artifacts.md) for the author-facing surface.

Artifacts differ from the cache in three ways: they are addressed by **name** (not a content hash), they are **immutable per run** (the first upload of a name wins — a duplicate fails loudly, enforced by both a pre-mint check and the `UNIQUE (run_id, name)` DB constraint), and they are **deliverables** rather than eviction-tolerant speedups (a shorter, independent TTL and no LRU eviction).

### Prefixes

| Key                                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Source                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `artifacts/{runId}/{name}-{discriminator}.tar.gz` | Packed tarball for a named artifact of a run. One object per upload; the `artifacts` DB row (`customer_id, run_id, job_id, name, size_bytes, sha256, storage_key`) points at this key and carries the size + hash. The orchestrator derives the key from the run and artifact name it resolved server-side, and records `size_bytes` from the stored object itself — never from values the agent reports. The name is validated against the artifact-name contract first (letters, digits, `.`, `_`, `-`, up to 128 chars, not all dots), so it becomes the key segment unchanged and two distinct names can never produce one key. The `{discriminator}` is a hash of the exact artifact name, so two names differing only by case produce keys that differ by more than case — they stay distinct objects even on a case-insensitive store such as the filesystem backend on a macOS or Windows host. Downloads resolve through the `storage_key` recorded on the row rather than re-deriving it, so artifacts written under an earlier key format keep resolving. An upload whose object never landed records no row. | `packages/orchestrator/src/artifacts/artifact-store.ts` |

### Enforcement & quotas

All enforcement happens **before** a presigned PUT is minted; each **enforcement** refusal carries a named reason the step error spells out:

- **`size_cap`** — the declared tarball size exceeds the org's effective per-artifact size cap (`org_settings.artifact_max_bytes` if set, else `KICI_ARTIFACT_MAX_BYTES`, 1 GiB default).
- **`duplicate_name`** — the run already uploaded an artifact by that name (immutability).
- **`run_cap`** — the run already has its effective per-run maximum of non-expired artifacts (`org_settings.artifact_max_per_run` if set, else `KICI_ARTIFACT_MAX_PER_RUN`, 50 default).
- **`org_quota`** — the org's non-expired artifact bytes plus this upload would exceed its effective quota (`org_settings.artifact_quota_bytes` if set, else `KICI_ARTIFACT_QUOTA_BYTES`, 20 GiB default).

A request the orchestrator cannot service at all is **not** one of these reasons: when artifact storage is unavailable, the job's run cannot be resolved, or the storage or database call fails, the reply carries no named reason and the step error instead states that the orchestrator could not complete the request. Workflow authors therefore never see a quota rejection (or, on download, a missing-artifact error) for what is an orchestrator-side problem. Where to look for each case:

- **Artifact storage unavailable** — artifacts need both object storage and a database; the store is absent when either is missing. There is no per-request log line for this one, so check the startup configuration (`Cache storage not configured, caching disabled` is logged when storage itself is off) rather than the request logs.
- **Unresolvable run** — logged as `artifact upload for unresolvable job, rejecting` / `artifact download for unresolvable job, replying not_found` / `artifact upload.complete for unresolvable job, dropping`, with the agent and job ids.
- **Storage or database failure** — logged as `artifact begin-upload failed` / `artifact download failed` / `artifact upload-complete failed`, with the job id and the underlying exception. The exception text stays in that log line and is never sent to the agent, so the log is where you diagnose it. The same holds for the commit that records an upload: its failure ack tells the workflow author only which kind of failure it was, so the storage key and the driver-level message are yours to read here.
- **Commit for an object that never landed** — the presigned PUT wrote nothing, so there is no object to record. Logged as `artifact complete for a missing object` with the run id, artifact name, and the server-derived storage key; the author's step error names the case without the key. Retrying cannot help — the upload itself is what failed.

The byte quota, per-artifact TTL, per-artifact size cap, and per-run count cap are all **cluster-configurable per org** (same model as the user cache): the `KICI_ARTIFACT_QUOTA_BYTES` / `KICI_ARTIFACT_TTL_MS` / `KICI_ARTIFACT_MAX_BYTES` / `KICI_ARTIFACT_MAX_PER_RUN` env vars set the cluster-wide defaults, and an operator overrides them for a single tenant at runtime by writing `org_settings.artifact_quota_bytes` / `org_settings.artifact_ttl_ms` / `org_settings.artifact_max_bytes` / `org_settings.artifact_max_per_run` (all NULLABLE — NULL means "use the cluster default"), reachable through the orchestrator admin HTTP route and the CLI:

```
kici-admin org-settings artifacts show --org <customerId>

kici-admin org-settings artifacts set-quota 53687091200 --org <customerId>   # 50 GiB
kici-admin org-settings artifacts set-ttl 604800000 --org <customerId>       # 7 days
kici-admin org-settings artifacts set-max-bytes 2147483648 --org <customerId>  # 2 GiB per artifact
kici-admin org-settings artifacts set-max-per-run 100 --org <customerId>       # 100 artifacts/run

kici-admin org-settings artifacts reset-quota --org <customerId>
kici-admin org-settings artifacts reset-ttl --org <customerId>
kici-admin org-settings artifacts reset-max-bytes --org <customerId>
kici-admin org-settings artifacts reset-max-per-run --org <customerId>
```

### Lifecycle

An artifact is considered **expired** its per-org TTL (`org_settings.artifact_ttl_ms`, else the `KICI_ARTIFACT_TTL_MS` 30-day default) after `created_at`. Expired artifacts are excluded from downloads, the dashboard listing, and quota sums — a lazy model (no active sweep) that mirrors the user-cache TTL; the backing object also expires lazily via `CacheStorage`'s own TTL passed as a per-operation override. Source: `packages/orchestrator/src/artifacts/artifact-store.ts`.

## Log storage

Step execution logs (NDJSON) and webhook delivery payloads (gzipped). Both subsystems share one `LogStorage` instance configured via `KICI_STORAGE_LOG_BUCKET` (or a fallback to the cache bucket if unset).

### Prefixes

| Key                                      | Description                                                                                                                                  | Source                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `kici-logs/.../step-N.log/seg-NNNNNN`    | NDJSON step logs, written as immutable append-only segment objects (one per seal). Reads concatenate the segments in order, range-paginated. | `packages/orchestrator/src/orchestrator-core.ts` |
| `event-log/{orgId}/{deliveryId}.json.gz` | Gzipped webhook delivery payload, hashed and metadata-attached. Capped at `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES` (default 5 MB).                 | `packages/orchestrator/src/webhook/event-log.ts` |

Both prefixes are **hardcoded in source** — there is no env var that overrides them. If you need a different layout (e.g., to share the log bucket with another service that already owns one of these prefixes), use a dedicated `KICI_STORAGE_LOG_BUCKET` rather than trying to relocate the prefix.

### Env vars

| Env var                                | Required? | Default        | Description                                                                                                                                                                                                  |
| -------------------------------------- | --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KICI_STORAGE_LOG_BUCKET`              | no        | (cache bucket) | Bucket for step logs + webhook payloads. When unset, log objects co-locate with cache objects.                                                                                                               |
| `KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES` | no        | `1048576`      | S3 backend only. Seal a step-log segment once its in-memory buffer reaches this many bytes. Larger values mean fewer, larger objects (fewer PUT operations) at the cost of a slightly staler durable record. |
| `KICI_LOG_STORAGE_SEGMENT_FLUSH_MS`    | no        | `2000`         | S3 backend only. Seal a step-log segment once the oldest buffered byte reaches this age (milliseconds).                                                                                                      |
| `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES`     | no        | `5242880`      | Soft cap for stored webhook payload size. Larger payloads are recorded with `payload_omitted=true`.                                                                                                          |
| `KICI_WEBHOOK_PAYLOAD_DIR`             | no        | --             | Local-filesystem fallback when `KICI_STORAGE_TYPE` is unset (no S3). When set, also the base of the on-disk step-log store (`<dir>/logs`).                                                                   |
| `KICI_DATA_DIR`                        | no        | (auto)         | Data root for the filesystem step-log store when `KICI_WEBHOOK_PAYLOAD_DIR` is unset. Logs land under `<KICI_DATA_DIR>/cache/logs`.                                                                          |

Region, endpoint, force-path-style, and credentials for the log bucket are inherited from the cache configuration — there are no separate `KICI_STORAGE_LOG_REGION` / `KICI_STORAGE_LOG_ENDPOINT` vars.

When `KICI_STORAGE_TYPE` is unset (no S3), step logs are written to a local directory resolved in this order: `KICI_WEBHOOK_PAYLOAD_DIR/logs` if set, otherwise `<data-root>/cache/logs` where `<data-root>` is `KICI_DATA_DIR` if set, else `/var/lib/kici` if writable, else `${XDG_STATE_HOME:-$HOME/.local/state}/kici`. The final fallback means a **user-level** orchestrator (one that cannot write the root-owned `/var/lib/kici`) stores logs under its own home directory instead of failing the first job with `EACCES`.

### Sizing & API ops

| Object                                   | Typical size              | Hard cap                                            | Write op                                                                                                                                                                                                                                                                                                                                                                                                             | Read op                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kici-logs/...` (step logs)              | <1 MB typical             | 10 MB per step (`KICI_MAX_LOG_SIZE_BYTES` on agent) | Buffered append-only segments (S3 backend): the orchestrator buffers agent chunks per step and seals an immutable `step-N.log/seg-NNNNNN` object (1× `PutObject`, unique key) once the buffer reaches `KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES` or ages past `KICI_LOG_STORAGE_SEGMENT_FLUSH_MS`; a run-completion finalize seals the tail. Each byte is written exactly once. The filesystem backend appends directly. | Range-paginated read across the ordered segments on dashboard log-viewer page navigation (one `ListObjectsV2` + ranged `GetObject`s)                                                                                                                     |
| `event-log/{orgId}/{deliveryId}.json.gz` | <100 KB typical (gzipped) | 5 MB (`KICI_EVENT_LOG_MAX_PAYLOAD_BYTES`)           | 1× `PutObject` per accepted webhook delivery                                                                                                                                                                                                                                                                                                                                                                         | 1× `GetObject` per payload-viewer click (chunked-WS transport — body is decompressed once on the orchestrator, then sliced into 64 KiB chunks streamed through Platform; Platform never buffers the full body) + 1× per re-run that needs payload replay |

**Per-step cost**: high-frequency step logs use buffered append-only segments, so a burst of agent chunks costs one `PutObject` per sealed segment rather than a full read-modify-write per flush — each log byte is written to the object store exactly once. Single-shot writers (webhook delivery payloads, rerun payloads, orchestration logs) still use an immediately-durable read-modify-write via `S3LogStorage.append()`; that is correct for a one-time write and needs no finalize. Reads also transparently include any pre-existing single-object step log, so a step half-written before a redeploy concatenates cleanly ahead of its segments.

**Oversize webhook payloads**: deliveries above `KICI_EVENT_LOG_MAX_PAYLOAD_BYTES` are NOT stored — the row is recorded with `payload_omitted=true` and the metadata + hash + size remain durable. The 5 MB cap is sized for GitHub's max webhook body; raise only if the provider regularly exceeds it.

**Verifiable counters**: `kici_orch_log_chunks_received_total`, `kici_orch_log_bytes_stored_total`. Both carry a `source` attribute — `local` for a chunk from a directly-connected agent, `peer` for one relayed by a worker orchestrator (a worker owns no log storage, so the coordinator writes on its behalf). Per-org bytes gauge: `orgLogBytes` (Platform-side aggregate).

### Lifecycle

| Object           | Phase   | Trigger                                                                         | What happens                                                                                                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step logs        | Created | First chunk arrives from agent for a given step                                 | Chunk is buffered in memory (S3 backend); no object exists until the first segment seals                                                                      |
| Step logs        | Updated | Buffer reaches `KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES` / `_MS`, or run completes | `PutObject` of the buffered bytes to a new immutable `step-N.log/seg-NNNNNN` object; run completion seals the tail segment                                    |
| Step logs        | Deleted | Cleanup sweep after `KICI_STEP_LOG_TTL_DAYS` (default 90; 0 disables)           | The orchestrator cleanup tick bulk-deletes S3 objects older than the TTL (`DeleteObjects`, ≤1000 keys/call). Filesystem-backend lifecycle is operator-managed |
| Webhook payloads | Created | `processWebhook()` accepts a delivery                                           | Gzip + `PutObject` to `event-log/{orgId}/{deliveryId}.json.gz`                                                                                                |
| Webhook payloads | Updated | (immutable; never updated)                                                      | --                                                                                                                                                            |
| Webhook payloads | Deleted | Cold-store sweeper after `KICI_COLD_STORE_EVENT_LOG_WARM_TTL_DAYS` (30d)        | Row archived into `cold-store/orchestrator/event_log/...` chunk; original `event-log/...` deleted                                                             |

Source: `packages/orchestrator/src/reporting/s3-log-storage.ts`, `packages/orchestrator/src/webhook/event-log.ts`, `packages/orchestrator/src/cold-store/orchestrator-cold-store.ts`.

## Worker terminal-status outbox

A worker-mode orchestrator (`KICI_CLUSTER_ROLE=worker`) holds no database, so it keeps a small durable on-disk outbox of **terminal job statuses** awaiting acknowledgement from its owning coordinator. When a rerouted job reaches a terminal state, the worker writes the status to this outbox before sending it over the peer connection, replays unacknowledged records to the coordinator on every (re)connect, and removes a record once the coordinator acknowledges it. See [coordinator/worker topology](../../architecture/clustering/coordinator-worker.md#reliable-terminal-status-relay) for the relay protocol.

| Path                              | Description                                                                                                                                                                                    | Source                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `<data-dir>/worker-outbox/*.json` | One `fsync`'d JSON record per unacknowledged terminal job status, keyed by `(coordinator URL, runId, jobId)`. Pruned after a 24-hour retention window so the outbox cannot grow without bound. | `packages/orchestrator/src/worker/peer-outbox.ts` |

`<data-dir>` is the worker's data root, resolved the same way as the filesystem step-log store: `KICI_DATA_DIR` if set, otherwise `/var/lib/kici` when writable (system-level install), otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/kici` (user-level install), with a tmpdir fallback. A user-level worker therefore keeps its outbox under its own home directory rather than failing on the root-owned `/var/lib/kici`.

## Provenance attestations

When a workflow step calls `ctx.attestProvenance`, the agent uploads the signed provenance bundle to the cache storage backend under `provenance/{runId}/{jobId}/{subjectDigest}.kici.json` (see the cache [Prefixes](#prefixes) table), and the orchestrator records one row in the `attestations` table so the dashboard can list and fetch attestations per run/job.

### `attestations` table

| Column           | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `id`             | Random primary key.                                                    |
| `run_id`         | KiCI run the attestation belongs to (indexed with `job_id`).           |
| `job_id`         | KiCI job that produced the attestation.                                |
| `subject_name`   | Caller-supplied artifact name.                                         |
| `subject_digest` | Primary subject digest (lowercase hex); the storage-key discriminator. |
| `storage_key`    | Object-storage key of the bundle.                                      |
| `mode`           | Signing mode (`kici` for the KiCI-signed bundle).                      |
| `media_type`     | Bundle media type.                                                     |
| `created_at`     | Insert timestamp.                                                      |

Migration: `packages/orchestrator/src/db/migrations/036_attestations.ts`. The row is written on a `provenance.upload.complete` from the agent, with `run_id` resolved server-side from the job's dispatch state (never the wire). The bundle objects are immutable and follow the same cache-bucket lifecycle as source/dep tarballs.

## Cold-store

Append-only archive of warm-table rows that have aged out of the operational tables. Backed by a versioned S3 bucket so accidental operator deletes are recoverable.

### Key format

```
{prefix}orchestrator/{table}/{tenantId}/{YYYY}/{MM}/{DD}/{retention-bucket}/{chunkId}.{jsonl.gz|manifest.json}
```

- `{prefix}` — `KICI_COLD_STORE_PREFIX`, default `cold-store/`
- `orchestrator` — fixed db segment that distinguishes orchestrator chunks from platform chunks (the two services share one bucket)
- `{table}` — the source table name (see "Tables" below)
- `{tenantId}` — the customer org id
- `{YYYY}/{MM}/{DD}` — chunk write date in UTC
- `{retention-bucket}` — one of `30d`, `180d`, `1y`, `2y`, `forever` (defined in `packages/shared/src/cold-store/bucket.ts` as `COLD_BUCKET_NAMES`)
- `{chunkId}` — random unique chunk identifier
- Two objects per chunk: the data (`*.jsonl.gz`) and a manifest (`*.manifest.json`) that records the row range and integrity hash.

Source: `packages/shared/src/cold-store/key.ts`.

### Tables

| Table              | Default warm TTL | What lives there                                                          |
| ------------------ | ---------------- | ------------------------------------------------------------------------- |
| `execution_runs`   | 30 days          | Completed run metadata (status, timings, parent_run_id) for terminal runs |
| `execution_jobs`   | 30 days          | Per-job metadata (status, agent, queue/run timings)                       |
| `execution_steps`  | 30 days          | Per-step execution details (status, exit code, duration, log pointer)     |
| `secret_audit_log` | 30 days          | Secret access / rotation / write events                                   |
| `access_log`       | 30 days          | Audit trail of API and CLI actions on the orchestrator                    |
| `event_log`        | 30 days          | Webhook delivery metadata (paired with the gzipped payload object)        |

Tables registered in `packages/orchestrator/src/cold-store/orchestrator-cold-store.ts`. Adding a new table to that file is a doc trigger — see `.claude/rules/storage.md`.

### Env vars

| Env var                             | Required?          | Default       | Description                                     |
| ----------------------------------- | ------------------ | ------------- | ----------------------------------------------- |
| `KICI_COLD_STORE_ENABLED`           | no                 | `false`       | Master toggle. When unset, archival never runs. |
| `KICI_COLD_STORE_BUCKET`            | yes (when enabled) | --            | Bucket for archived chunks                      |
| `KICI_COLD_STORE_PREFIX`            | no                 | `cold-store/` | Object-key prefix                               |
| `KICI_COLD_STORE_REGION`            | no                 | --            | AWS region                                      |
| `KICI_COLD_STORE_ENDPOINT`          | no                 | --            | Custom S3 endpoint                              |
| `KICI_COLD_STORE_EXTERNAL_ENDPOINT` | no                 | --            | Endpoint used when generating pre-signed URLs   |
| `KICI_COLD_STORE_FORCE_PATH_STYLE`  | no                 | --            | Path-style addressing (`true` / `false`)        |
| `KICI_COLD_STORE_S3_CONCURRENCY`    | no                 | `4`           | Concurrent S3 PUT/GET cap                       |

These vars are read directly via `process.env` in `cold-store/orchestrator-cold-store.ts` — they are not part of the main `defineEnv()` Zod schema, so they don't appear in the auto-generated [env reference](../env-reference.md). They're listed in `COLD_STORE_ENV_VARS` (`packages/orchestrator/src/config.ts`) so the unknown-`KICI_*` typo catcher allows them.

### Per-table tuning

Six knobs per table, with the table name segment uppercased:

```
KICI_COLD_STORE_<TABLE>_WARM_TTL_DAYS
KICI_COLD_STORE_<TABLE>_MIN_WARM_TENANT_BYTES
KICI_COLD_STORE_<TABLE>_MIN_CHUNK_BYTES
KICI_COLD_STORE_<TABLE>_MAX_CHUNK_BYTES
KICI_COLD_STORE_<TABLE>_MAX_ROWS_PER_CYCLE
KICI_COLD_STORE_<TABLE>_ENABLED
```

Where `<TABLE>` is one of `EXECUTION_RUNS`, `EXECUTION_JOBS`, `EXECUTION_STEPS`, `SECRET_AUDIT_LOG`, `ACCESS_LOG`, `EVENT_LOG`. Defaults: 30 days warm, 5 MiB minimum tenant bytes before archival kicks in, chunk sizes between 1 MiB and 50 MiB, 50000 rows per cycle hard cap, all tables enabled.

Read-through uses the same resolved value. Cold reads bound their upper edge at
the table's effective warm TTL — the built-in default merged with this override —
so lowering the override can never hide archived rows from a read. Raising it is
the direction to be careful with: rows already archived under the previous,
smaller value fall outside the widened bound and stop appearing in read-through.

### Sizing & API ops

| Object             | Typical size | Hard cap / floor                                                | Write op                                                                                       | Read op                                                                         |
| ------------------ | ------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `*.jsonl.gz` chunk | 1–50 MB      | floor `MIN_CHUNK_BYTES` (1 MiB), cap `MAX_CHUNK_BYTES` (50 MiB) | 1× `PutObject` per chunk per archive cycle (per `(table, tenant)` with eligible bytes ≥ floor) | 1× `GetObject` per chunk on rehydration (rare; only when reading archived rows) |
| `*.manifest.json`  | ~1 KB        | --                                                              | 1× `PutObject` per chunk (paired with the data write)                                          | 1× `GetObject` per chunk on rehydration / catalog scan                          |

**Archive-cycle scheduling**: the `cold-store-archive` scheduled job runs **hourly** (`0 * * * *` cron). Each cycle scans `cold_store_chunks` candidates per `(table, tenant)`, archives up to `MAX_ROWS_PER_CYCLE` (50000) rows, splitting into chunks no smaller than `MIN_CHUNK_BYTES` (1 MiB) and no larger than `MAX_CHUNK_BYTES` (50 MiB). Tenants below `MIN_WARM_TENANT_BYTES` (5 MiB) are skipped.

**Per-cycle cost** (per `(table, tenant)` with N rows producing K chunks): `K` × `PutObject` (data) + `K` × `PutObject` (manifest) + 1× `ListObjectsV2` to detect prior chunks + database mutations. Concurrency capped at `KICI_COLD_STORE_S3_CONCURRENCY` (default 4).

**Rehydration cost** (rare, on dashboard archive query or `kici-admin` rehydrate): `ListObjectsV2` to find chunks in date range → `GetObject` for matching `*.manifest.json` files → `GetObject` for selected `*.jsonl.gz` chunks.

**Purge schedule**: `cold-store-purge` runs hourly (`15 * * * *` cron) and `DeleteObject`s chunks whose retention bucket has expired (`30d` etc).

**Steady-state per-tenant write volume** (rough): if a tenant produces ~10 MB/day of warm rows across all 6 tables, expect ~10 archive `PutObject` ops per day per table at the chunk floor, hourly cycles.

### Lifecycle

| Phase   | Trigger                                                       | What happens                                                                                                                                           |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Created | `cold-store-archive` cycle (hourly) finds eligible warm rows  | Build chunk → gzip → `PutObject` data + `PutObject` manifest. Chunk metadata recorded in `cold_store_chunks` table.                                    |
| Updated | (immutable; never updated)                                    | Cold-store chunks are append-only. The bucket has S3 versioning **enabled** so any operator-error overwrite is recoverable.                            |
| Deleted | `cold-store-purge` cycle (hourly) finds chunks past retention | `DeleteObject` data + `DeleteObject` manifest. Retention bucket (`30d` / `180d` / `1y` / `2y` / `forever`) is set at write time based on table policy. |

Source: `packages/orchestrator/src/cold-store/orchestrator-cold-store.ts`. See [security audit log](../security/audit-log.md) for the rehydration flow.

## External services

Two non-KiCI services deployed alongside the orchestrator in staging also write to S3, with their own buckets and credentials:

- **Loki** (log aggregation): `<deployment-slug>-loki`
- **Mimir** (metrics TSDB): `<deployment-slug>-mimir`

These are out of scope for this doc — they're maintained by the platform deployment, not the orchestrator. See `docs/internal/platform/storage-layout.md` for the full inventory (internal docs only).

## See also

- [Source tarball and dependency caching](../dependency-caching.md) — cache flow, key derivation, build agent setup
- [Audit log](../security/audit-log.md) — cold-store key layout, archival lifecycle, rehydration
- [Architecture: data flows](../../architecture/data-flows.md) — cache miss/hit data flows and pre-signed URL protocol
- [Environment variable reference](../env-reference.md) — auto-generated catalog of the shared env vars; the orchestrator-specific `KICI_STORAGE_*` table lives in the [orchestrator configuration reference](configuration.md)
