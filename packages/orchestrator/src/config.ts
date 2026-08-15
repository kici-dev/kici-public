/**
 * Orchestrator configuration.
 *
 * This is a thin backward-compatible wrapper around the new config resolution
 * chain (config/resolver.ts). It preserves the existing synchronous loadConfig()
 * API so that no other files need changing.
 *
 * The new config system lives in config/ and supports:
 * - YAML config files (config/loader.ts)
 * - Shared DB config store (config/shared-store.ts)
 * - 4-layer resolution: env > YAML > DB > defaults (config/resolver.ts)
 * - KICI_ env var mapping (config/env-overlay.ts)
 *
 * Provider configuration (GitHub Apps, etc.) is managed via the `sources` table
 * and PgSecretStore, not through config. See SourceStore and SourceManager.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars, LOGGER_ENV_VARS } from '@kici-dev/shared/env';
import { OrchestratorMode, PLATFORM_CONNECTED_MODES } from '@kici-dev/engine';
import { DEFAULT_CACHE_STORAGE_S3_PREFIX } from './cluster/cluster-identity.js';

/** Human-readable rendering of `PLATFORM_CONNECTED_MODES` for validation messages. */
const PLATFORM_CONNECTED_MODES_TEXT = `${PLATFORM_CONNECTED_MODES.slice(0, -1).join(', ')}, or ${PLATFORM_CONNECTED_MODES[PLATFORM_CONNECTED_MODES.length - 1]}`;

const baseSchema = z.object({
  // Operating mode
  mode: OrchestratorMode.default('platform'),
  // Server
  port: z.coerce.number().default(4000),
  basePath: z.string().default('/'),
  // TLS cert path for expiry diagnostic (optional)
  tlsCertPath: z.string().optional(),
  // Platform connection (required in platform/hybrid/observed modes — the
  // relay leg in platform/hybrid, observability only in observed)
  platformUrl: z.string().optional(),
  platformToken: z.string().optional(),
  /**
   * Base URL of the user-facing dashboard. Used to build `details_url`
   * on GitHub Check Runs and similar outbound URLs that reach public
   * surfaces — the `oal_<12-char>` public alias is appended to this
   * base. When unset, no `details_url` is emitted (preserving today's
   * behavior). Trailing slash optional.
   */
  dashboardUrl: z.string().optional(),
  /**
   * Provenance trust root (the OIDC issuer) used to verify build-provenance
   * bundles. The live process learns this over the Platform `auth.success`
   * connect message; this config/env value is the source for the CLI backfill
   * (`kici-admin attestations reverify`), which has no live handshake. When
   * unset, the orchestrator records attestation verdicts as `unverifiable`.
   */
  provenanceIssuer: z.string().optional(),
  /**
   * The orchestrator's OWN provenance issuer identity (`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`).
   * When set, orchestrator-owned attestation signing is ON: the orchestrator
   * generates/holds its own ES256 key, mints identity tokens locally, and serves
   * `/.well-known/openid-configuration` + `/.well-known/jwks.json` at this base
   * URL. Distinct from `provenanceIssuer` (the verification trust-root). Must be a
   * stable, durable URL — a change re-roots the cluster's provenance identity.
   */
  provenanceSigningIssuer: z.string().optional(),
  /**
   * Custody backend for the orchestrator signing key (`KICI_ORCHESTRATOR_SIGNER_KIND`):
   * `db` (default — private JWK master-key-wrapped in the DB), `aws-kms`, or
   * `command` (generic external signer). Only consulted when signing is on.
   */
  provenanceSignerKind: z.string().optional(),
  /** AWS KMS key ARN for `aws-kms` custody (`KICI_ORCHESTRATOR_KMS_KEY_ARN`). */
  provenanceKmsKeyArn: z.string().optional(),
  /** AWS region for `aws-kms` custody (`KICI_ORCHESTRATOR_KMS_REGION`). */
  provenanceKmsRegion: z.string().optional(),
  /** AWS access key id for `aws-kms` custody (`KICI_ORCHESTRATOR_KMS_ACCESS_KEY_ID`). */
  provenanceKmsAccessKeyId: z.string().optional(),
  /** AWS secret access key for `aws-kms` custody (`KICI_ORCHESTRATOR_KMS_SECRET_ACCESS_KEY`). */
  provenanceKmsSecretAccessKey: z.string().optional(),
  /** Operator-provided signing command for `command` custody (`KICI_ORCHESTRATOR_SIGNER_COMMAND`). */
  provenanceSignerCommand: z.string().optional(),
  /**
   * Public base URL at which this orchestrator's own webhook ingress is
   * reachable (independent/hybrid self-serve generic webhooks:
   * `<base>/webhook/<customerId>/generic/<sourceId>`). Used by
   * `kici-admin source add` to print a generic source's webhook URL. GitHub-App
   * ingress is Platform-relayed, so GitHub URLs come from the Platform's
   * `source.register.ack`, not this value. Trailing slash optional.
   */
  webhookPublicUrl: z.string().optional(),
  /**
   * WebSocket URL that agents this orchestrator spawns or bootstraps should
   * dial to reach it (`ws://<host>:<port>/ws`). Without it the connect-back URL
   * falls back to `ws://127.0.0.1:<port>/ws`, which only resolves for agents
   * sharing this host — set it whenever agents live elsewhere: a container
   * network, a Firecracker guest, or a fresh box being bootstrapped over SSH
   * from another machine. A per-scaler `orchestratorUrl` in `scalers.yaml`
   * overrides this for that scaler; the fresh-box bring-up path has no
   * per-scaler override, so this is its only way to advertise a routable
   * address.
   */
  orchestratorUrl: z.string().optional(),
  // Database (PostgreSQL only — optional for worker role)
  databaseUrl: z.string().default(''),
  // DB connection pool sizing. Bootstrap config (the pool must exist before the
  // orchestrator can read org_settings), so these stay env-var/static per the
  // cluster-config carve-out for connection settings. `max` bounds concurrent
  // hot-path acquirers; the acquire timeout fails fast when the pool is
  // saturated (instead of queueing forever); the statement timeout stops a
  // single runaway query from holding a connection indefinitely.
  dbPoolMax: z.coerce.number().int().positive().default(20),
  dbPoolAcquireTimeoutMs: z.coerce.number().int().nonnegative().default(5_000),
  dbStatementTimeoutMs: z.coerce.number().int().nonnegative().default(30_000),
  // Lockfile cache
  lockfileCacheMax: z.coerce.number().default(500),
  lockfileCacheTtlMs: z.coerce.number().default(3_600_000), // 1 hour
  lockfileCacheMaxBytes: z.coerce.number().default(64 * 1024 * 1024), // 64 MiB
  // Content-requirements cache (Tier-1 `requires` static content filter). Keyed
  // by (repo, sha, path), content-addressable by construction. Sizing mirrors
  // the lock-file cache.
  contentCacheMax: z.coerce.number().default(500),
  contentCacheTtlMs: z.coerce.number().default(3_600_000), // 1 hour
  contentCacheMaxBytes: z.coerce.number().default(64 * 1024 * 1024), // 64 MiB
  // Tier-2 global eval round. One pre-run job per (event x workflow repo) runs
  // each candidate global workflow's `filter` and then its generators on a
  // shared dual checkout. The two budgets are handed to the agent on every
  // round, so an operator override lands on the next push; the cache size is
  // structural to its LRU and applies at the next restart.
  globalEvalRoundTimeoutMs: z.coerce.number().default(120_000), // 2 minutes
  globalEvalCandidateTimeoutMs: z.coerce.number().default(20_000), // 20 seconds
  globalEvalCacheMax: z.coerce.number().default(500),
  // The orchestrator's own ceiling on awaiting a round. The two budgets above
  // are enforced by the AGENT and only start once the round job is running, so
  // neither bounds a round that never reached an agent (an empty init-runner
  // fleet queues the job, which counts as accepted) or an agent that wedged
  // before its own budget started. Webhook processing awaits the round inline,
  // so without this ceiling that delivery blocks forever and never reaches the
  // event log. Set above `globalEvalRoundTimeoutMs` — 4 minutes leaves the
  // agent its 2-minute round budget plus checkout time. ONE attempt still
  // fires before the relay force-releases its admitted-pipeline slot at 5
  // minutes; the round is retried once, so a group whose agent never answers
  // spends up to 8 minutes and does cross that mark. Crossing it costs relay
  // concurrency, not the delivery: the force-release drops the admission slot
  // while the pipeline promise keeps running and still writes the event-log
  // row. An operator who needs both attempts inside the 5-minute window sets
  // this knob below 150s and lowers the round budget with it.
  globalEvalWaitTimeoutMs: z.coerce.number().default(240_000), // 4 minutes
  // Dispatch queue
  queueMaxDepth: z.coerce.number().default(1000),
  queueTimeoutMs: z.coerce.number().default(3_600_000), // 1 hour, 0 = indefinite
  /**
   * Grace a job may stay continuously unroutable (nothing in the fleet matches
   * its selectors) before it is terminalized. Cluster default; the live value
   * is the `unroutable_grace_ms` cluster setting. 0 = fast-fail disabled.
   */
  unroutableGraceMs: z.coerce.number().default(120_000),
  /**
   * Fleet-wide default for the global-workflows master switch. Cluster default;
   * the live value is the `global_workflows_enabled` cluster setting, and NULL
   * there means this value applies.
   *
   * Defaults to false: a global workflow runs against events from repos other
   * than the one that defines it, so it is opt-in by the operator.
   */
  globalWorkflowsEnabled: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true')),
  /**
   * Operator-facing backpressure warning threshold for the dispatch queue.
   * When pending-queue depth stays at or above this value for at least two
   * consecutive refresher ticks (~10s), the orchestrator emits a
   * `logger.warn` pointing operators at the per-label Grafana panel so
   * they can identify which label pool is starved. `0` disables the
   * warner entirely — metrics are still exported, but the periodic warn
   * is silenced. See docs/operator/monitoring.md for tuning guidance.
   */
  queueBackpressureThreshold: z.coerce.number().default(100),
  // Worker
  workerConcurrency: z.coerce.number().default(5),
  // Cap on how long the orchestrator's in-memory waiters map keeps a queued
  // concurrency entry parked before considering the agent's wait abandoned.
  // Mirrors the agent-side `KICI_CONCURRENCY_WAIT_TIMEOUT_MS` default; the
  // orchestrator currently uses this only for diagnostics — actual eviction
  // happens on agent disconnect via `cancelQueued`.
  concurrencyWaitTimeoutMs: z.coerce.number().int().min(1000).default(3_600_000),
  // Cluster-wide default for the dispatch-acknowledgment deadline: how long
  // the orchestrator waits for job.ack / job.reject / job.status running
  // after sending a job.dispatch before treating the dispatch as lost
  // (requeue + disconnect the agent). Per-org override in
  // org_settings.dispatch_ack_timeout_ms (set via kici-admin org-settings).
  dispatchAckTimeoutMs: z.coerce.number().int().min(1000).default(10_000),
  // Deadline for one database-backed agent-ownership lookup, used when the
  // in-memory ownership map misses (typically right after a coordinator
  // failover). Past the deadline the lookup resolves as undecided: the frame is
  // refused, but no ownership violation is recorded against the agent.
  // Fleet-wide override in cluster_settings.ownership_db_check_timeout_ms.
  ownershipDbCheckTimeoutMs: z.coerce.number().int().min(100).default(5_000),
  // Webhook-ingest admission controller tunables. Generous defaults → the
  // controller is a no-op under normal load; the event-loop-lag gate is what
  // tightens under real pressure. All are cluster-wide except the per-org
  // fairness cap, which is overridable per tenant via
  // org_settings.ingest_max_concurrency (kici-admin org-settings).
  // ingestMaxConcurrency (G): global in-flight pipeline backstop.
  ingestMaxConcurrency: z.coerce.number().int().min(1).default(256),
  // ingestMaxQueueDepth (Q): CoDel queue length backstop (HTTP direct ingress).
  ingestMaxQueueDepth: z.coerce.number().int().min(0).default(1000),
  // ingestCodelTargetMs (T): CoDel target sojourn.
  ingestCodelTargetMs: z.coerce.number().int().min(1).default(50),
  // ingestCodelIntervalMs (I): CoDel interval.
  ingestCodelIntervalMs: z.coerce.number().int().min(1).default(100),
  // ingestQueueMaxWaitMs (W_max): hard sojourn ceiling (< the 5s WS ack timeout).
  ingestQueueMaxWaitMs: z.coerce.number().int().min(1).default(3000),
  // ingestLoopLagShedMs (L_shed): p99 event-loop delay shed threshold
  // (generous; calibrate down on staging via the always-emitted p99 gauge).
  ingestLoopLagShedMs: z.coerce.number().int().min(1).default(200),
  // ingestLoopLagResumeMs (L_resume): hysteresis re-open threshold — the gate
  // closes only when p99 falls below this, preventing bang-bang flapping.
  ingestLoopLagResumeMs: z.coerce.number().int().min(1).default(150),
  // ingestLoopLagSampleMs (S): loop-lag sample + gauge-refresh + queue-sweep
  // interval. Must be <= ingestCodelIntervalMs so T/I are honored.
  ingestLoopLagSampleMs: z.coerce.number().int().min(1).default(100),
  // ingestOrgMaxConcurrency (P): per-org fairness cap cluster default; a per-org
  // override lives in org_settings.ingest_max_concurrency.
  ingestOrgMaxConcurrency: z.coerce.number().int().min(1).default(32),
  // ingestOverflowEnabled: default-on durable buffer for shed deliveries. When
  // true, a shed still returns 429/shed_retry_later AND additively persists the
  // delivery to ingest_overflow_buffer for replay once capacity recovers.
  ingestOverflowEnabled: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // ingestOverflowMax: buffered-row cap. At the cap, capture drops the delivery
  // (429 still stands — lossy fallback, never unbounded rows).
  ingestOverflowMax: z.coerce.number().int().min(1).default(5000),
  // ingestOverflowReplayIntervalMs: replayer pass interval.
  ingestOverflowReplayIntervalMs: z.coerce.number().int().min(1).default(2000),
  // ingestOverflowReplayBatch: max rows re-injected per pass (rate bound).
  ingestOverflowReplayBatch: z.coerce.number().int().min(1).default(50),
  // ingestOverflowMaxAttempts: replay attempts before a row goes `failed`.
  ingestOverflowMaxAttempts: z.coerce.number().int().min(1).default(10),
  // ingestOverflowClaimTimeoutMs: how long a `replaying` claim may stand before
  // the drain pass reclaims the row. A worker killed mid-pipeline leaves its
  // row claimed with nothing to release it, so without this the delivery is
  // stranded rather than durably queued. The default sits above the 600s
  // cacheBuildTimeoutMs with headroom, because reclaiming a row whose pipeline
  // is merely slow would re-run work still in flight. Fleet-wide override in
  // cluster_settings.ingest_overflow_claim_timeout_ms.
  ingestOverflowClaimTimeoutMs: z.coerce.number().int().min(60_000).default(900_000),
  // Cluster-wide defaults for the cross-peer reroute subsystem. Per-org
  // overrides live in org_settings.reroute_spawn_window_ms /
  // reroute_ack_timeout_ms / reroute_max_hops (set via kici-admin org-settings).
  // rerouteSpawnWindowMs: after a peer ACKs a reroute, how long the coordinator
  // waits for the first job.progress before treating "accepted but no progress"
  // as a spawn failure and re-dispatching to another backend / local fallback.
  rerouteSpawnWindowMs: z.coerce.number().int().min(1000).default(90_000),
  // rerouteAckTimeoutMs: the reroute sendAndWaitAck deadline.
  rerouteAckTimeoutMs: z.coerce.number().int().min(1000).default(15_000),
  // rerouteMaxHops: maximum peer hops for a rerouted job (loop prevention).
  rerouteMaxHops: z.coerce.number().int().min(1).default(3),
  // rerouteFlapGraceMs: grace window during which a rerouted job stays deferred
  // from the recovery sweepers while its worker peer momentarily flaps. Matches
  // DEFAULT_REROUTE_FLAP_GRACE_MS in cluster/rerouted-job-guard.ts. Cluster-wide
  // default; overridable per cluster via cluster_settings.reroute_flap_grace_ms.
  rerouteFlapGraceMs: z.coerce.number().int().min(1000).default(120_000),
  // Cluster-wide default deadline for a single scaler `backend.spawn` (image
  // pull + container create + start). Bounds a hung runtime/registry so a stuck
  // provision cannot hold its per-backend spawn-semaphore slot forever and
  // head-of-line block every spawn queued behind it. Generous by default (a
  // cold-cache pull of a large agent image is legitimate); operators tune it
  // down per tenant via org_settings.scaler_spawn_timeout_ms (kici-admin
  // org-settings scaler-spawn-timeout). NULL org row → this default applies.
  scalerSpawnTimeoutMs: z.coerce.number().int().min(1000).default(300_000),
  // Cluster-wide default staleness threshold (hours) for the DB-backup
  // freshness diagnostic. Per-org override lives in
  // org_settings.backup_staleness_warn_hours (set via kici-admin org-settings);
  // the global diagnose check warns when the newest backup_runs row is older
  // than the strictest effective threshold.
  backupStalenessWarnHours: z.coerce.number().int().min(1).default(24),
  // scalerPendingSweepIntervalMs: leader-gated backstop interval for the scaler
  // capacity-freed re-drive. The capacity-freed hook handles the common case at
  // near-zero latency; this sweep re-offers pending at-capacity jobs to the
  // scaler on a timer so nothing is stranded if the hook misses an edge case
  // (silent spawn failure, reservation freed on a non-leader coord, lost event).
  // A cluster-singleton leader-gated infra timer (like the host-roster reaper /
  // event-retry scanner) — not per-tenant behavior, so it is a cluster-wide
  // config default, not a per-org org_settings knob.
  scalerPendingSweepIntervalMs: z.coerce.number().int().min(1000).default(10_000),
  // Cache storage (for compiled bundle caching). Two backends:
  //   - s3:         pre-signed URLs, multi-host / production
  //   - filesystem: local files served via /api/v1/cache/blob/, single-host
  cacheStorageType: z.enum(['s3', 'filesystem']).optional(),
  cacheStoragePath: z.string().optional(), // legacy, used for log storage filesystem fallback
  cacheStorageS3Bucket: z.string().optional(), // S3 only
  cacheStorageS3Prefix: z.string().default(DEFAULT_CACHE_STORAGE_S3_PREFIX), // S3 only — empty; the bucket already scopes the cache
  cacheStorageS3Region: z.string().optional(), // S3 only
  cacheStorageS3Endpoint: z.string().optional(), // S3-compatible endpoint (SeaweedFS, LocalStack)
  cacheStorageS3ExternalEndpoint: z.string().optional(), // Separate endpoint for pre-signed URLs (agents)
  cacheStorageS3UploadEndpoint: z.string().optional(), // Host-facing endpoint for CLI pre-signed uploads
  cacheStorageS3ForcePathStyle: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(), // Path-style access for S3-compatible services
  // Source for fresh-box agent payloads (the `agent-packages/` prefix). Unset ⇒
  // the orchestrator's OWN cache bucket (the secure default — never a vendor
  // CDN). An `s3://bucket[/prefix]` value points the bring-up presign at another
  // bucket on the same S3 endpoint (the customer supply-chain mirror). An
  // external HTTP(S) source is rejected so a vendor-CDN default can never slip in.
  agentBinarySource: z
    .string()
    .describe(
      "Source for fresh-box agent payloads. Unset uses the orchestrator's own cache bucket (the secure default — never a vendor CDN); an s3://bucket[/prefix] value points the bring-up presign at a mirror bucket. An external HTTP(S) source is rejected.",
    )
    .refine((v) => !/^https?:\/\//i.test(v), {
      message:
        'KICI_AGENT_BINARY_SOURCE must not be an external HTTP(S) source (no vendor CDN); leave it unset for the orchestrator cache bucket, or use an s3://bucket[/prefix] mirror',
    })
    .optional(),
  // Filesystem backend: absolute base directory for cached blobs. Required
  // when cacheStorageType === 'filesystem'.
  cacheStorageFsPath: z.string().optional(),
  // Filesystem backend: base URL the agent uses to reach this orchestrator
  // (e.g., http://orch.local:10143). Used to mint signed blob-route URLs.
  // When unset, derived from the orchestrator's bind host:port at boot.
  cacheStorageFsBaseUrl: z.string().optional(),
  logStorageS3Bucket: z.string().optional(), // Separate bucket for logs (defaults to cache bucket)
  // Step-log segment sealing (S3 backend). The S3 log store buffers per step
  // key in memory and seals an immutable `seg-NNNNNN` object when the buffer
  // reaches logSegmentFlushBytes OR its oldest byte reaches logSegmentFlushMs.
  // Larger values mean fewer/larger objects (less PUT IOPS) at the cost of a
  // slightly staler durable record; the live dashboard tail is unaffected (it
  // is served by the WS fan-out, not S3).
  logSegmentFlushBytes: z.coerce.number().int().positive().default(1_048_576), // 1 MB
  logSegmentFlushMs: z.coerce.number().int().positive().default(2_000),
  cacheTtlDays: z.coerce.number().default(30), // TTL in days (minimum 30)
  // Terminal dispatch_queue row retention (days). The cleanup sweep deletes
  // completed/failed/expired rows older than this; the durable run history
  // lives in the cold-stored execution_* tables. 0 disables pruning. Cluster-
  // wide (dispatch_queue carries no tenant column), mirroring cacheTtlDays.
  dispatchQueueTtlDays: z.coerce.number().default(30),
  // Step-log object retention (days). The cleanup sweep bulk-deletes S3 log
  // objects older than this. Longer than the cache window (CI norm ≈ 90 days).
  // 0 disables the sweep — the opt-out for operators running their own bucket
  // lifecycle rule.
  stepLogTtlDays: z.coerce.number().default(90),
  // Check-run tracking row retention (days). The cleanup sweep deletes rows
  // untouched for longer than this. Generous on purpose: the rows are narrow,
  // and a late check-run status update resolves its check-run ID by reading
  // one. 0 disables the sweep. Cluster-wide, mirroring dispatchQueueTtlDays.
  //
  // `.int()` is load-bearing rather than cosmetic: the sweep interpolates this
  // into `make_interval(days => $1)`, which Postgres rejects for a fractional
  // value, and the caller swallows that error — so a non-integer would leave
  // the table growing unbounded with nothing but a log line to say so. The
  // admin route enforces the same floor on the cluster-settings knob.
  checkRunTrackingTtlDays: z.coerce.number().int().nonnegative().default(7),
  // Window of terminal runs the reconnect `state.replay` frame carries back to
  // Platform. Declared here rather than read straight off `process.env` so the
  // unknown-KICI_*-var startup guard recognises it: an undeclared name makes
  // the orchestrator refuse to boot, which turned this documented operator
  // knob into a way to take the service down rather than a way to recover it.
  // Not `.int()` — any finite positive value is meaningful for a time window.
  reconnectReplayWindowHours: z.coerce.number().positive().default(24),
  cacheBuildTimeoutMs: z.coerce.number().default(600_000), // 10 min build timeout
  cacheMaxTarballBytes: z.coerce.number().default(524_288_000), // Max dep tarball size (500MB)
  // User-facing cache (ctx.cache / declarative job/step cache). Per-org byte
  // quota and per-entry TTL for the UserCache layer. Defaults: 5 GiB / 7 days.
  userCacheQuotaBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024 * 1024)
    .describe(
      'Cluster-wide default per-org byte quota for the user-facing cache (ctx.cache). ' +
        'A per-org override in org_settings.user_cache_quota_bytes (set via ' +
        '`kici-admin org-settings user-cache set-quota`) takes precedence when present.',
    ),
  userCacheTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000)
    .describe(
      'Cluster-wide default per-entry TTL (ms) for the user-facing cache. ' +
        'A per-org override in org_settings.user_cache_ttl_ms (set via ' +
        '`kici-admin org-settings user-cache set-ttl`) takes precedence when present.',
    ),
  // User-facing artifacts (ctx.artifacts.upload/download). Per-org byte quota +
  // per-artifact TTL for the ArtifactStore. Defaults: 20 GiB / 30 days.
  artifactQuotaBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024 * 1024)
    .describe(
      'Cluster-wide default per-org byte quota for user-facing artifacts (ctx.artifacts). ' +
        'A per-org override in org_settings.artifact_quota_bytes (set via ' +
        '`kici-admin org-settings artifacts set-quota`) takes precedence when present.',
    ),
  artifactTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000)
    .describe(
      'Cluster-wide default per-artifact TTL (ms) for user-facing artifacts. ' +
        'A per-org override in org_settings.artifact_ttl_ms (set via ' +
        '`kici-admin org-settings artifacts set-ttl`) takes precedence when present.',
    ),
  // Per-artifact size cap + per-run count cap for user-facing artifacts. Each is
  // a cluster-wide default with a per-org override in org_settings
  // (artifact_max_bytes / artifact_max_per_run), settable via
  // `kici-admin org-settings artifacts set-max-bytes` / `set-max-per-run`.
  artifactMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(1 * 1024 * 1024 * 1024)
    .describe(
      'Cluster-wide default max size (bytes) of a single user-facing artifact tarball (1 GiB). ' +
        'A per-org override in org_settings.artifact_max_bytes (set via ' +
        '`kici-admin org-settings artifacts set-max-bytes`) takes precedence when present.',
    ),
  artifactMaxPerRun: z.coerce
    .number()
    .int()
    .positive()
    .default(50)
    .describe(
      'Cluster-wide default max number of user-facing artifacts a single run may upload (50). ' +
        'A per-org override in org_settings.artifact_max_per_run (set via ' +
        '`kici-admin org-settings artifacts set-max-per-run`) takes precedence when present.',
    ),
  // Webhook payload storage (optional -- if set, writes raw payloads to this directory)
  webhookPayloadDir: z.string().optional(),
  // Orchestrator data root for execution-log/cache storage (optional). When
  // unset, resolves /var/lib/kici if writable, else ${XDG_STATE_HOME:-$HOME/
  // .local/state}/kici — so a user-level install works without root-owned
  // /var/lib/kici. KICI_WEBHOOK_PAYLOAD_DIR still overrides the log base.
  dataDir: z.string().optional(),
  // Scaler (optional -- if neither is set, scaler is not enabled)
  scalerConfigPath: z.string().optional(),
  scalerConfigDir: z.string().optional(),
  // Machine-wide resource ledger directory used by named machine pools.
  // The ledger is a small JSON file per pool, coordinated across processes via
  // an atomic mkdir-based directory lock. Default: /var/lib/kici/scaler-ledger.
  // Falls back to ${XDG_STATE_HOME:-$HOME/.local/state}/kici/scaler-ledger when
  // the default path is not writable.
  machineLedgerDir: z.string().optional(),
  // Stale detection
  staleDetectorScanIntervalMs: z.coerce.number().default(60_000),
  staleDetectorThresholdMultiplier: z.coerce.number().default(2),
  jobHeartbeatIntervalMs: z.coerce.number().default(60_000),
  // GitHub App name/slug refresh — how often the orchestrator re-fetches every
  // GitHub source's display name + slug from GitHub (`GET /app`) and re-registers
  // it if it drifted. Default: 24h.
  githubAppNameRefreshIntervalMs: z.coerce.number().default(86_400_000),
  // Secrets management (optional -- enables encrypted secret store + admin API)
  secretKey: z.string().optional(), // KICI_SECRET_KEY (hex-encoded or base64 32-byte key)
  secretKeyFile: z.string().optional(), // KICI_SECRET_KEY_FILE (path to key file)
  secretKeyOld: z.string().optional(), // KICI_SECRET_KEY_OLD (previous key for rotation)
  secretKeyFileOld: z.string().optional(), // KICI_SECRET_KEY_FILE_OLD (path to previous key file)
  bootstrapAdminToken: z.string().optional(), // KICI_BOOTSTRAP_ADMIN_TOKEN
  // Independent-mode opt-in for dispatch-time context-scoped secret resolution.
  // Off by default: a bare independent orchestrator resolves NO context-scoped
  // secrets at dispatch (unchanged behavior). The local dev plane sets this to
  // 'true' so a workflow's `secrets.yaml` contexts resolve through the real
  // resolver. Ignored outside independent mode (server.ts always builds one).
  independentSecrets: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'), // KICI_INDEPENDENT_SECRETS
  // Independent-mode opt-in for the dev-signed identity (OIDC + attestation).
  // Off by default: a bare independent orchestrator has NO local signer and does
  // not register the local mint path. The offline local dev plane sets this to
  // 'true' (with a freshly-generated keypair via KICI_DEV_IDENTITY_KEY_FILE) so
  // `ctx.kici.oidc.token()` / `ctx.attestProvenance()` mint a `kici-local`
  // dev-signed identity. A Platform-connected orchestrator NEVER reaches this
  // path — it keeps minting via the Platform relay (app.ts registers the relay
  // in preference; the local path is the strict else branch).
  independentIdentity: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'), // KICI_INDEPENDENT_IDENTITY
  // Path to the dev-signed identity's EC P-256 private JWK (mode 0600), freshly
  // generated by the local dev plane — never derived from any sops secret. Read
  // only when independentIdentity is on. The public JWK is written next to it.
  devIdentityKeyFile: z.string().optional(), // KICI_DEV_IDENTITY_KEY_FILE
  // PG customer secrets toggle (default: true)
  pgCustomerSecrets: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Agent authentication
  agentAuth: z.enum(['token', 'none']).default('token'),
  agentTokenTtlMs: z.coerce.number().default(3_600_000), // 1 hour default TTL for ephemeral agent tokens
  // Host roster (declared inventory) timing knobs (cluster-wide defaults)
  rosterGraceMs: z.coerce.number().int().min(1000).default(300_000), // 5 min — static grace before unreachable
  rosterTtlMs: z.coerce.number().int().min(1000).default(1_800_000), // 30 min — ephemeral GC ttl
  // Cluster-wide default deadline for a workflow-initiated host reboot to
  // complete its down-then-up cycle. Replaces the short recovery window for a
  // reboot-pending host; the held post-restart job fails on expiry. Authors
  // override per-restart via `restartHost({ deadlineMs })`.
  hostRebootDeadlineMs: z.coerce.number().int().min(1000).default(900_000), // 15 min
  // Co-located guard for workflow-level host restart: the agentId of an agent
  // that shares this orchestrator's host. A `restartHost()` request from that
  // agent is refused so the orchestrator can never reboot its own box. Empty =
  // no co-located agent.
  orchestratorHostAgentId: z.string().optional(),
  maxFanoutHosts: z.coerce.number().int().min(1).default(1024), // cap on runsOnAll per-host children
  // Event router
  eventRouterMaxChainDepth: z.coerce.number().default(10),
  eventRouterRateLimitPerWorkflowPerMinute: z.coerce.number().default(100),
  eventRouterEventTtlSeconds: z.coerce.number().default(604_800), // 7 days
  eventRouterCleanupIntervalMs: z.coerce.number().default(3_600_000), // 1 hour
  // Event delivery retry / DLQ knobs (added with at-least-once dispatch).
  // Defaults match `DEFAULT_EVENT_ROUTER_CONFIG` in events/types.ts; bumping
  // either here OR in code requires bumping both to keep parity.
  eventRouterMaxDispatchAttempts: z.coerce.number().default(5),
  eventRouterLeaseDurationMs: z.coerce.number().default(60_000),
  eventRouterRetryBaseBackoffMs: z.coerce.number().default(5_000),
  eventRouterRetryMaxBackoffMs: z.coerce.number().default(300_000),
  eventRouterRetryScanIntervalMs: z.coerce.number().default(10_000),
  /**
   * **Test-only.** Master switch for fault-injection knobs in the event
   * dispatch pipeline. When `false` (default) the orchestrator ignores
   * every test-only knob below, even if its env var is set. Pair with
   * `KICI_TEST_EVENT_FAIL_FIRST_N` to drive the E2E retry / DLQ
   * scenarios. Production deployments leave this at its default.
   */
  testMode: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
  /**
   * **Test-only.** JSON map of `{ "<eventName>": <N> }` instructing the
   * EventRouter to throw a synthetic dispatch error while
   * `event.attempts <= N`. Ignored unless `KICI_TEST_MODE=1`.
   */
  testEventFailFirstN: z.string().optional(),
  /**
   * **Test-only.** When set (and `KICI_TEST_MODE=1`), the orchestrator forces
   * the *initial* agent provenance mint to fail transiently (defer) for any job
   * whose requested OIDC `audience` equals this value, so an E2E can exercise
   * the deferred-attestation retry + per-run serve path with a REAL run. The
   * retrier's re-mint uses a different call site and is unaffected. Ignored
   * unless `KICI_TEST_MODE=1`. Production deployments leave this unset.
   */
  testMintDeferAudience: z.string().optional(),
  /**
   * **Test-only.** When set (and `KICI_TEST_MODE=1`), the orchestrator forces
   * the *initial* agent provenance mint to DEFER for any job whose requested
   * OIDC `audience` equals this value (same as `testMintDeferAudience`), AND the
   * retrier's later re-mint to TERMINALLY REJECT it — so an E2E can exercise the
   * `markRejected` → gauge-exclusion → `--include-rejected` re-arm cycle with a
   * REAL run. Ignored unless `KICI_TEST_MODE=1`. Production leaves this unset.
   */
  testMintRejectAudience: z.string().optional(),
  /**
   * **Test-only.** When set (and `KICI_TEST_MODE=1`), `handleRerunRequest`
   * sleeps this many milliseconds before invoking `onRerun`, so an HA E2E can
   * make the first coordinator slow enough that the Platform relay fails over
   * to a sibling — exercising the `requestId` idempotency claim. Ignored unless
   * `KICI_TEST_MODE=1`. Production deployments leave this unset.
   */
  testRerunDelayMs: z.coerce.number().optional(),
  /**
   * **Test-only.** Comma-separated list of `dashboard.*` request types to drop
   * from the capability manifest this orchestrator advertises to the Platform,
   * so an integration test can reproduce an older / sourceless orchestrator that
   * predates a given capability (e.g. `dashboard.contexts.list`). Only ever
   * *removes* advertised types. Ignored unless `KICI_TEST_MODE=1`. Production
   * deployments leave this unset.
   */
  testOmitDashboardRequestTypes: z.string().optional(),
  // Inbound webhook delivery log (event_log table). Default soft-cap 5MB.
  // Phase E retired the row TTL: rows are now archived to cold-store after
  // 30 days rather than hard-deleted. Oversized payloads are still recorded
  // with payload_omitted=true rather than 413'd.
  eventLogMaxPayloadBytes: z.coerce.number().default(5 * 1024 * 1024),
  // Cluster defaults for the fleet-wide tunables backed by cluster_settings.
  // Each is the fallback when the cluster_settings row's column is NULL; an
  // operator overrides them at runtime via `kici-admin cluster-settings`.
  // GitHub webhook body cap (bytes). GitHub itself caps at 25MB.
  maxGithubPayloadBytes: z.coerce
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),
  // Per-lockfile fetch size cap (bytes).
  lockFileMaxBytes: z.coerce
    .number()
    .int()
    .min(1024)
    .default(5 * 1024 * 1024),
  // Webhook dedup entry TTL (ms).
  webhookDedupTtlMs: z.coerce
    .number()
    .int()
    .min(1000)
    .default(24 * 60 * 60 * 1000),
  // Contributor-cache entry TTL (ms).
  contributorCacheTtlMs: z.coerce
    .number()
    .int()
    .min(1000)
    .default(15 * 60 * 1000),
  // How long ClusterSettingsReader caches the single cluster_settings row (ms).
  // Bootstrap/perf detail about reaching the config store — env-only by design,
  // deliberately NOT itself a cluster_settings knob.
  clusterSettingsCacheTtlMs: z.coerce.number().int().min(0).default(10_000),
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  // Migrations / boot
  autoMigrate: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Agent recovery (used by Dispatcher to bound how long it waits for a
  // disconnected agent to come back before failing in-flight jobs).
  agentMaxReconnectDelayMs: z.coerce.number().default(60_000),
  // S3 sentinel validation (escape hatch for E2E fault-injection tests).
  skipS3SentinelValidation: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // OpenTelemetry exporter endpoint (consumed by initTelemetry).
  otelExporterOtlpEndpoint: z.string().optional(),
  // Optional first-boot seed for the orchestrator's cluster_name (the
  // human-friendly identifier surfaced to Platform). Only honored when
  // the `cluster_meta.cluster_name` row is missing; subsequent boots
  // ignore the env var in favor of the stored value. See
  // `packages/orchestrator/src/config/cluster-name.ts` for the
  // resolution order. Registered here so the env-var validator knows
  // about the name; the resolver still reads it directly from
  // `process.env` because it runs before the config object is exposed.
  clusterName: z.string().optional(),
  // Cluster mode (multi-orchestrator coordination)
  cluster: z
    .object({
      /** This orchestrator's unique instance ID. Default: random UUID. */
      instanceId: z
        .string()
        .optional()
        .default(() => randomUUID()),
      /** This orchestrator's address for peers to connect to. Required when peers are configured. */
      address: z.string().optional(),
      /** Join token for cluster bootstrap. */
      joinToken: z.string().optional(),
      /** Path to peer credential file. */
      credentialFile: z.string().default('~/.kici/peer-credential'),
      /** Auto-rotate credentials. */
      autoRotateCredentials: z.boolean().default(false),
      /** Static peer addresses for independent mode. Comma-separated URLs. */
      peers: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
      /** Raft election timeout minimum in ms. Default: 5000. */
      raftElectionTimeoutMinMs: z.coerce.number().default(5000),
      /** Raft election timeout maximum in ms. Default: 10000. */
      raftElectionTimeoutMaxMs: z.coerce.number().default(10000),
      /** Raft leader heartbeat interval in ms. Default: 2000. */
      raftHeartbeatMs: z.coerce.number().default(2000),
      /** Peer heartbeat interval in ms (inventory broadcast). Default: 30000. */
      peerHeartbeatIntervalMs: z.coerce.number().default(30000),
      /** Maximum peer reconnect delay in ms. Default: 60000. */
      peerMaxReconnectDelayMs: z.coerce.number().default(60000),
      /** Cluster role: coordinator (full orchestrator) or worker (delegated execution). Default: coordinator. */
      role: z.enum(['coordinator', 'worker']).default('coordinator'),
      /** URL of the coordinator to connect to when role=worker. Single-coord mode. */
      coordinatorUrl: z.string().optional(),
      /**
       * URLs of all coordinators to connect to when role=worker (comma-separated).
       * Worker maintains one outbound PeerClient per coord so every coord can
       * route work to it. Takes precedence over coordinatorUrl when both are set.
       */
      coordinatorUrls: z
        .string()
        .optional()
        .transform((v) =>
          v
            ? v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        ),
      /** Stale peer timeout in ms (2 missed heartbeats at 30s = 60s default). */
      peerStaleTimeoutMs: z.coerce.number().default(60_000),
      /** Grace period before dormant-mode self-election (0 peers). Default: 60000ms.
       *  Prevents false self-election during the peer discovery window. */
      electionGracePeriodMs: z.coerce.number().default(60_000),
      /** Single-node deployment mode. When true, election grace period is bypassed
       *  for immediate self-election. Default: false. */
      singleNode: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true')),
      /** Trusted proxy IPs/CIDRs for X-Forwarded-For/X-Real-IP extraction. Comma-separated. */
      trustedProxies: z
        .string()
        .default('')
        .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
    })
    .prefault({}),
});

/**
 * Validation scope for orchestrator config: a running orchestrator (`runtime`)
 * vs a build-artifact (agent packaging) operation (`packaging`). Packaging only
 * needs the object-storage config, so it skips the runtime coordinator/platform
 * cross-field requirements.
 */
export const ConfigScope = z.enum(['runtime', 'packaging']);
export type ConfigScope = z.infer<typeof ConfigScope>;

type ConfigData = z.infer<typeof baseSchema>;

/**
 * Storage-shape cross-field rules: cache backend (S3 bucket / filesystem path)
 * and the cluster address-when-peers structural check. Enforced in every scope,
 * including packaging (a package upload confirms an S3 bucket is configured).
 */
function refineStorageShape(data: ConfigData, ctx: z.RefinementCtx): void {
  // Cache: S3 type requires bucket
  if (data.cacheStorageType === 's3' && !data.cacheStorageS3Bucket) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'KICI_STORAGE_BUCKET is required when KICI_STORAGE_TYPE is s3',
      path: ['cacheStorageS3Bucket'],
    });
  }
  // Cache: filesystem type requires an absolute base path
  if (data.cacheStorageType === 'filesystem') {
    if (!data.cacheStorageFsPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_STORAGE_FS_PATH is required when KICI_STORAGE_TYPE is filesystem',
        path: ['cacheStorageFsPath'],
      });
    } else if (!data.cacheStorageFsPath.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_STORAGE_FS_PATH must be an absolute path',
        path: ['cacheStorageFsPath'],
      });
    }
  }
  // Cluster validation: address required when peers are explicitly configured
  if (data.cluster.peers.length > 0 && !data.cluster.address) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'KICI_CLUSTER_ADDRESS is required when KICI_CLUSTER_PEERS is set (peers need to know where to connect back)',
      path: ['cluster', 'address'],
    });
  }
}

/**
 * Runtime cross-field rules for a running orchestrator: worker coordinator URL,
 * coordinator database URL, and platform/hybrid relay connection. These fields
 * are not read by the agent-packaging path, so packaging scope skips them.
 */
function refineRuntimeRequirements(data: ConfigData, ctx: z.RefinementCtx): void {
  const isWorker = data.cluster.role === 'worker';

  // Workers require at least one coordinator URL (singular or plural form).
  if (
    isWorker &&
    !data.cluster.coordinatorUrl &&
    (!data.cluster.coordinatorUrls || data.cluster.coordinatorUrls.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'KICI_CLUSTER_COORDINATOR_URL or KICI_CLUSTER_COORDINATOR_URLS is required when KICI_CLUSTER_ROLE=worker',
      path: ['cluster', 'coordinatorUrls'],
    });
  }

  // KICI_DATABASE_URL is required for coordinator mode (workers don't need it)
  if (!isWorker && !data.databaseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'KICI_DATABASE_URL is required for coordinator mode',
      path: ['databaseUrl'],
    });
  }

  // Platform-connected modes require the Platform connection (skip for workers
  // — they don't connect to Platform). `observed` connects for observability
  // only; `platform`/`hybrid` also use it for the webhook relay.
  if (!isWorker && PLATFORM_CONNECTED_MODES.includes(data.mode)) {
    if (!data.platformUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `KICI_PLATFORM_URL is required when KICI_MODE is ${PLATFORM_CONNECTED_MODES_TEXT}`,
        path: ['platformUrl'],
      });
    }
    if (!data.platformToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `KICI_PLATFORM_TOKEN is required when KICI_MODE is ${PLATFORM_CONNECTED_MODES_TEXT}`,
        path: ['platformToken'],
      });
    }
  }

  // `observed` serves its OWN webhook ingress, so it must advertise the public
  // URL providers post to (the Platform never fronts a URL for it).
  if (!isWorker && data.mode === OrchestratorMode.enum.observed && !data.webhookPublicUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'KICI_WEBHOOK_PUBLIC_URL is required when KICI_MODE is observed',
      path: ['webhookPublicUrl'],
    });
  }
}

// Full runtime validation: runtime requirements first, then storage shape
// (preserves the issue order the runtime path has always emitted).
const configSchema = baseSchema.superRefine((data, ctx) => {
  refineRuntimeRequirements(data, ctx);
  refineStorageShape(data, ctx);
});

// Packaging validation: storage shape only — the agent-packaging path reads
// only the object-storage config, so runtime coordinator/platform fields are
// not required.
export const packagingConfigSchema = baseSchema.superRefine(refineStorageShape);

/**
 * App configuration type. Includes computed instanceId for multi-instance support.
 *
 * Provider configuration (GitHub Apps) is now managed via the sources table
 * and SourceManager, not through config.
 */
export type AppConfig = z.infer<typeof configSchema> & {
  /** Unique identifier for this orchestrator instance, generated at startup */
  instanceId: string;
  /** Object storage settings (populated from legacy env vars or SharedConfig) */
  storage?: {
    type?: 's3' | 'filesystem';
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    externalEndpoint?: string;
    uploadEndpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
    /** Filesystem backend: absolute base directory for cached blobs. */
    fsBasePath?: string;
    /** Filesystem backend: base URL the agent uses to reach this orchestrator. */
    fsBaseUrl?: string;
    /** Per-org byte quota for the user-facing cache (UserCache). */
    userCacheQuotaBytes?: number;
    /** Per-entry TTL (ms) for the user-facing cache (UserCache). */
    userCacheTtlMs?: number;
  };
};

/**
 * Env-var definition for the orchestrator. Exported so the docs generator and
 * the deploy-stg pre-validator can re-parse without going through process.env.
 *
 * Note: passes the inner `baseSchema` (a ZodObject) so describe() can walk
 * `.shape`, but uses the outer `configSchema` (with .superRefine) as the parser
 * so cross-field rules still fire.
 */
export const envDef = defineEnv({
  service: 'orchestrator',
  schema: baseSchema,
  parser: configSchema,
  envMap: {
    mode: 'KICI_MODE',
    port: 'KICI_PORT',
    basePath: 'KICI_BASE_PATH',
    tlsCertPath: 'KICI_SERVER_TLS_CERT_PATH',
    platformUrl: 'KICI_PLATFORM_URL',
    platformToken: 'KICI_PLATFORM_TOKEN',
    dashboardUrl: 'KICI_DASHBOARD_URL',
    provenanceIssuer: 'KICI_PROVENANCE_ISSUER',
    provenanceSigningIssuer: 'KICI_ORCHESTRATOR_PROVENANCE_ISSUER',
    provenanceSignerKind: 'KICI_ORCHESTRATOR_SIGNER_KIND',
    provenanceKmsKeyArn: 'KICI_ORCHESTRATOR_KMS_KEY_ARN',
    provenanceKmsRegion: 'KICI_ORCHESTRATOR_KMS_REGION',
    provenanceKmsAccessKeyId: 'KICI_ORCHESTRATOR_KMS_ACCESS_KEY_ID',
    provenanceKmsSecretAccessKey: 'KICI_ORCHESTRATOR_KMS_SECRET_ACCESS_KEY',
    provenanceSignerCommand: 'KICI_ORCHESTRATOR_SIGNER_COMMAND',
    webhookPublicUrl: 'KICI_WEBHOOK_PUBLIC_URL',
    orchestratorUrl: 'KICI_ORCHESTRATOR_URL',
    databaseUrl: 'KICI_DATABASE_URL',
    dbPoolMax: 'KICI_DB_POOL_MAX',
    dbPoolAcquireTimeoutMs: 'KICI_DB_POOL_ACQUIRE_TIMEOUT_MS',
    dbStatementTimeoutMs: 'KICI_DB_STATEMENT_TIMEOUT_MS',
    cacheStorageType: 'KICI_STORAGE_TYPE',
    cacheStoragePath: 'KICI_STORAGE_PATH',
    cacheStorageS3Bucket: 'KICI_STORAGE_BUCKET',
    cacheStorageS3Prefix: 'KICI_STORAGE_PREFIX',
    cacheStorageS3Region: 'KICI_STORAGE_REGION',
    cacheStorageS3Endpoint: 'KICI_STORAGE_ENDPOINT',
    cacheStorageS3ExternalEndpoint: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
    cacheStorageS3UploadEndpoint: 'KICI_STORAGE_UPLOAD_ENDPOINT',
    cacheStorageS3ForcePathStyle: 'KICI_STORAGE_FORCE_PATH_STYLE',
    cacheStorageFsPath: 'KICI_STORAGE_FS_PATH',
    cacheStorageFsBaseUrl: 'KICI_STORAGE_FS_BASE_URL',
    agentBinarySource: 'KICI_AGENT_BINARY_SOURCE',
    logStorageS3Bucket: 'KICI_STORAGE_LOG_BUCKET',
    logSegmentFlushBytes: 'KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES',
    logSegmentFlushMs: 'KICI_LOG_STORAGE_SEGMENT_FLUSH_MS',
    cacheTtlDays: 'KICI_CACHE_TTL_DAYS',
    dispatchQueueTtlDays: 'KICI_DISPATCH_QUEUE_TTL_DAYS',
    stepLogTtlDays: 'KICI_STEP_LOG_TTL_DAYS',
    checkRunTrackingTtlDays: 'KICI_CHECK_RUN_TRACKING_TTL_DAYS',
    reconnectReplayWindowHours: 'KICI_ORCH_RECONNECT_REPLAY_WINDOW_HOURS',
    cacheBuildTimeoutMs: 'KICI_CACHE_BUILD_TIMEOUT_MS',
    cacheMaxTarballBytes: 'KICI_CACHE_MAX_TARBALL_BYTES',
    userCacheQuotaBytes: 'KICI_USER_CACHE_QUOTA_BYTES',
    userCacheTtlMs: 'KICI_USER_CACHE_TTL_MS',
    artifactQuotaBytes: 'KICI_ARTIFACT_QUOTA_BYTES',
    artifactTtlMs: 'KICI_ARTIFACT_TTL_MS',
    artifactMaxBytes: 'KICI_ARTIFACT_MAX_BYTES',
    artifactMaxPerRun: 'KICI_ARTIFACT_MAX_PER_RUN',
    lockfileCacheMax: 'KICI_LOCKFILE_CACHE_MAX',
    lockfileCacheTtlMs: 'KICI_LOCKFILE_CACHE_TTL_MS',
    lockfileCacheMaxBytes: 'KICI_LOCKFILE_CACHE_MAX_BYTES',
    contentCacheMax: 'KICI_CONTENT_CACHE_MAX',
    contentCacheTtlMs: 'KICI_CONTENT_CACHE_TTL_MS',
    contentCacheMaxBytes: 'KICI_CONTENT_CACHE_MAX_BYTES',
    globalEvalRoundTimeoutMs: 'KICI_GLOBAL_EVAL_ROUND_TIMEOUT_MS',
    globalEvalCandidateTimeoutMs: 'KICI_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS',
    globalEvalCacheMax: 'KICI_GLOBAL_EVAL_CACHE_MAX',
    globalEvalWaitTimeoutMs: 'KICI_GLOBAL_EVAL_WAIT_TIMEOUT_MS',
    queueMaxDepth: 'KICI_QUEUE_MAX_DEPTH',
    queueTimeoutMs: 'KICI_QUEUE_TIMEOUT_MS',
    unroutableGraceMs: 'KICI_UNROUTABLE_GRACE_MS',
    globalWorkflowsEnabled: 'KICI_GLOBAL_WORKFLOWS_ENABLED',
    queueBackpressureThreshold: 'KICI_QUEUE_BACKPRESSURE_THRESHOLD',
    workerConcurrency: 'KICI_WORKER_CONCURRENCY',
    concurrencyWaitTimeoutMs: 'KICI_CONCURRENCY_WAIT_TIMEOUT_MS',
    dispatchAckTimeoutMs: 'KICI_DISPATCH_ACK_TIMEOUT_MS',
    ownershipDbCheckTimeoutMs: 'KICI_OWNERSHIP_DB_CHECK_TIMEOUT_MS',
    ingestMaxConcurrency: 'KICI_INGEST_MAX_CONCURRENCY',
    ingestMaxQueueDepth: 'KICI_INGEST_MAX_QUEUE_DEPTH',
    ingestCodelTargetMs: 'KICI_INGEST_CODEL_TARGET_MS',
    ingestCodelIntervalMs: 'KICI_INGEST_CODEL_INTERVAL_MS',
    ingestQueueMaxWaitMs: 'KICI_INGEST_QUEUE_MAX_WAIT_MS',
    ingestLoopLagShedMs: 'KICI_INGEST_LOOP_LAG_SHED_MS',
    ingestLoopLagResumeMs: 'KICI_INGEST_LOOP_LAG_RESUME_MS',
    ingestLoopLagSampleMs: 'KICI_INGEST_LOOP_LAG_SAMPLE_MS',
    ingestOrgMaxConcurrency: 'KICI_INGEST_ORG_MAX_CONCURRENCY',
    ingestOverflowEnabled: 'KICI_INGEST_OVERFLOW_ENABLED',
    ingestOverflowMax: 'KICI_INGEST_OVERFLOW_MAX',
    ingestOverflowReplayIntervalMs: 'KICI_INGEST_OVERFLOW_REPLAY_INTERVAL_MS',
    ingestOverflowReplayBatch: 'KICI_INGEST_OVERFLOW_REPLAY_BATCH',
    ingestOverflowMaxAttempts: 'KICI_INGEST_OVERFLOW_MAX_ATTEMPTS',
    ingestOverflowClaimTimeoutMs: 'KICI_INGEST_OVERFLOW_CLAIM_TIMEOUT_MS',
    rerouteSpawnWindowMs: 'KICI_REROUTE_SPAWN_WINDOW_MS',
    rerouteAckTimeoutMs: 'KICI_REROUTE_ACK_TIMEOUT_MS',
    rerouteMaxHops: 'KICI_REROUTE_MAX_HOPS',
    rerouteFlapGraceMs: 'KICI_REROUTE_FLAP_GRACE_MS',
    scalerSpawnTimeoutMs: 'KICI_SCALER_SPAWN_TIMEOUT_MS',
    backupStalenessWarnHours: 'KICI_BACKUP_STALENESS_WARN_HOURS',
    scalerPendingSweepIntervalMs: 'KICI_SCALER_PENDING_SWEEP_INTERVAL_MS',
    webhookPayloadDir: 'KICI_WEBHOOK_PAYLOAD_DIR',
    dataDir: 'KICI_DATA_DIR',
    scalerConfigPath: 'KICI_SCALER_CONFIG_PATH',
    scalerConfigDir: 'KICI_SCALER_CONFIG_DIR',
    machineLedgerDir: 'KICI_MACHINE_LEDGER_DIR',
    staleDetectorScanIntervalMs: 'KICI_STALE_DETECTOR_SCAN_INTERVAL_MS',
    staleDetectorThresholdMultiplier: 'KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER',
    jobHeartbeatIntervalMs: 'KICI_JOB_HEARTBEAT_INTERVAL_MS',
    githubAppNameRefreshIntervalMs: 'KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS',
    secretKey: 'KICI_SECRET_KEY',
    secretKeyFile: 'KICI_SECRET_KEY_FILE',
    secretKeyOld: 'KICI_SECRET_KEY_OLD',
    secretKeyFileOld: 'KICI_SECRET_KEY_FILE_OLD',
    bootstrapAdminToken: 'KICI_BOOTSTRAP_ADMIN_TOKEN',
    independentSecrets: 'KICI_INDEPENDENT_SECRETS',
    independentIdentity: 'KICI_INDEPENDENT_IDENTITY',
    devIdentityKeyFile: 'KICI_DEV_IDENTITY_KEY_FILE',
    pgCustomerSecrets: 'KICI_PG_CUSTOMER_SECRETS',
    agentAuth: 'KICI_AGENT_AUTH',
    agentTokenTtlMs: 'KICI_AGENT_TOKEN_TTL_MS',
    rosterGraceMs: 'KICI_ROSTER_GRACE_MS',
    rosterTtlMs: 'KICI_ROSTER_TTL_MS',
    hostRebootDeadlineMs: 'KICI_HOST_REBOOT_DEADLINE_MS',
    orchestratorHostAgentId: 'KICI_ORCHESTRATOR_HOST_AGENT_ID',
    maxFanoutHosts: 'KICI_MAX_FANOUT_HOSTS',
    eventRouterMaxChainDepth: 'KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH',
    eventRouterRateLimitPerWorkflowPerMinute:
      'KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE',
    eventRouterEventTtlSeconds: 'KICI_EVENT_ROUTER_EVENT_TTL_SECONDS',
    eventRouterCleanupIntervalMs: 'KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS',
    eventRouterMaxDispatchAttempts: 'KICI_EVENT_ROUTER_MAX_DISPATCH_ATTEMPTS',
    eventRouterLeaseDurationMs: 'KICI_EVENT_ROUTER_LEASE_DURATION_MS',
    eventRouterRetryBaseBackoffMs: 'KICI_EVENT_ROUTER_RETRY_BASE_BACKOFF_MS',
    eventRouterRetryMaxBackoffMs: 'KICI_EVENT_ROUTER_RETRY_MAX_BACKOFF_MS',
    eventRouterRetryScanIntervalMs: 'KICI_EVENT_ROUTER_RETRY_SCAN_INTERVAL_MS',
    testMode: 'KICI_TEST_MODE',
    testEventFailFirstN: 'KICI_TEST_EVENT_FAIL_FIRST_N',
    testMintDeferAudience: 'KICI_TEST_MINT_DEFER_AUDIENCE',
    testMintRejectAudience: 'KICI_TEST_MINT_REJECT_AUDIENCE',
    testRerunDelayMs: 'KICI_TEST_RERUN_DELAY_MS',
    testOmitDashboardRequestTypes: 'KICI_TEST_OMIT_DASHBOARD_REQUEST_TYPES',
    eventLogMaxPayloadBytes: 'KICI_EVENT_LOG_MAX_PAYLOAD_BYTES',
    maxGithubPayloadBytes: 'KICI_MAX_GITHUB_PAYLOAD_BYTES',
    lockFileMaxBytes: 'KICI_LOCK_FILE_MAX_BYTES',
    webhookDedupTtlMs: 'KICI_WEBHOOK_DEDUP_TTL_MS',
    contributorCacheTtlMs: 'KICI_CONTRIBUTOR_CACHE_TTL_MS',
    clusterSettingsCacheTtlMs: 'KICI_CLUSTER_SETTINGS_CACHE_TTL_MS',
    logLevel: 'KICI_LOG_LEVEL',
    nodeEnv: 'NODE_ENV',
    autoMigrate: 'KICI_AUTO_MIGRATE',
    agentMaxReconnectDelayMs: 'KICI_AGENT_MAX_RECONNECT_DELAY_MS',
    skipS3SentinelValidation: 'KICI_SKIP_S3_SENTINEL_VALIDATION',
    otelExporterOtlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    clusterName: 'KICI_CLUSTER_NAME',
    cluster: {
      instanceId: 'KICI_CLUSTER_INSTANCE_ID',
      address: 'KICI_CLUSTER_ADDRESS',
      joinToken: 'KICI_CLUSTER_JOIN_TOKEN',
      credentialFile: 'KICI_CLUSTER_CREDENTIAL_FILE',
      peers: 'KICI_CLUSTER_PEERS',
      raftElectionTimeoutMinMs: 'KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS',
      raftElectionTimeoutMaxMs: 'KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS',
      raftHeartbeatMs: 'KICI_CLUSTER_RAFT_HEARTBEAT_MS',
      peerHeartbeatIntervalMs: 'KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS',
      peerMaxReconnectDelayMs: 'KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS',
      role: 'KICI_CLUSTER_ROLE',
      coordinatorUrl: 'KICI_CLUSTER_COORDINATOR_URL',
      coordinatorUrls: 'KICI_CLUSTER_COORDINATOR_URLS',
      peerStaleTimeoutMs: 'KICI_CLUSTER_PEER_STALE_TIMEOUT_MS',
      electionGracePeriodMs: 'KICI_CLUSTER_ELECTION_GRACE_PERIOD_MS',
      singleNode: 'KICI_CLUSTER_SINGLE_NODE',
      trustedProxies: 'KICI_CLUSTER_TRUSTED_PROXIES',
    },
  },
});

/**
 * Load orchestrator configuration from environment variables.
 *
 * This is the LEGACY synchronous config loader. It reads directly from process.env
 * using the env var names declared in `envDef` (KICI_DATABASE_URL, KICI_PORT, etc.).
 *
 * Provider configuration (GitHub Apps) is no longer loaded from env vars.
 * Use the sources table and SourceManager instead.
 *
 * For new deployments, use resolveLocalConfig() + resolveFullConfig() from
 * config/resolver.ts which support YAML files, KICI_ env var prefixes, and
 * the shared DB config store.
 */
/**
 * Cold-store env vars consumed by `OrchestratorColdStore` directly via
 * `process.env` (not threaded through the AppConfig schema). Registered
 * here so the unknown-KICI_* validator at boot doesn't reject them.
 * Per-table tuning mirrors `knownTables` in `orchestrator-cold-store.ts`.
 */
const COLD_STORE_ENV_VARS = [
  'KICI_COLD_STORE_ENABLED',
  'KICI_COLD_STORE_BUCKET',
  'KICI_COLD_STORE_PREFIX',
  'KICI_COLD_STORE_REGION',
  'KICI_COLD_STORE_ENDPOINT',
  'KICI_COLD_STORE_EXTERNAL_ENDPOINT',
  'KICI_COLD_STORE_FORCE_PATH_STYLE',
  'KICI_COLD_STORE_S3_CONCURRENCY',
  'KICI_COLD_STORE_EXECUTION_RUNS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_RUNS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_RUNS_ENABLED',
  'KICI_COLD_STORE_EXECUTION_JOBS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_JOBS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_JOBS_ENABLED',
  'KICI_COLD_STORE_EXECUTION_STEPS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_STEPS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_STEPS_ENABLED',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_ENABLED',
  'KICI_COLD_STORE_ACCESS_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_ACCESS_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_ACCESS_LOG_ENABLED',
  'KICI_COLD_STORE_EVENT_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EVENT_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EVENT_LOG_ENABLED',
];

/**
 * Deployment-identity env vars injected by the installer (and the staging
 * deploy) so the orchestrator can report its own deployment shape in
 * `source.register`. Read directly from `process.env` by the deployment reader,
 * not threaded through the AppConfig schema — registered here so the
 * unknown-KICI_* validator at boot doesn't reject them.
 */
const DEPLOY_IDENTITY_ENV_VARS = [
  'KICI_DEPLOY_MODE',
  'KICI_DEPLOY_CONTAINER',
  'KICI_DEPLOY_CONTAINER_RUNTIME',
];

export function loadConfig(scope: ConfigScope = ConfigScope.enum.runtime): AppConfig {
  const packaging = scope === ConfigScope.enum.packaging;
  const data = packaging ? envDef.parse(process.env, packagingConfigSchema) : envDef.parse();

  // Reject typo'd KICI_* env vars at boot. Adds the logger's vars
  // (KICI_LOG_DIR, KICI_LOG_MAX_SIZE, …) and the cold-store overrides to the
  // known set so they don't trip the check. This boot-time typo guard is a
  // runtime concern: a build-artifact packaging operation runs in an arbitrary
  // operator shell that may carry unrelated KICI_* vars, so packaging scope
  // skips it (the storage-shape validation already guards the only config the
  // packaging path reads).
  if (!packaging) {
    validateUnknownKiciVars([
      ...envDef.listKnownEnvVars(),
      ...LOGGER_ENV_VARS,
      ...COLD_STORE_ENV_VARS,
      ...DEPLOY_IDENTITY_ENV_VARS,
      'KICI_TEST_ADMIN_DATABASE_URL', // admin DB URL that gates real-Postgres repo tests (vitest harness)
      'KICI_SKIP_DB_TESTS', // opt-out that stops the vitest harness starting a throwaway Postgres
    ]);
  }

  // Use cluster instanceId if provided, otherwise generate one
  const instanceId = data.cluster.instanceId || `${hostname()}-${randomUUID().slice(0, 8)}`;

  // Bridge KICI_STORAGE_* env vars into storage field. User-cache quota/TTL are
  // surfaced regardless of backend so the composition root can construct
  // UserCache even when no object-storage backend is configured.
  const userCacheStorage = {
    userCacheQuotaBytes: data.userCacheQuotaBytes,
    userCacheTtlMs: data.userCacheTtlMs,
  };
  let storage: AppConfig['storage'];
  if (data.cacheStorageType === 's3') {
    storage = {
      type: 's3',
      bucket: data.cacheStorageS3Bucket,
      prefix: data.cacheStorageS3Prefix,
      region: data.cacheStorageS3Region,
      endpoint: data.cacheStorageS3Endpoint,
      externalEndpoint: data.cacheStorageS3ExternalEndpoint,
      uploadEndpoint: data.cacheStorageS3UploadEndpoint,
      forcePathStyle: data.cacheStorageS3ForcePathStyle,
      logBucket: data.logStorageS3Bucket,
      ...userCacheStorage,
    };
  } else if (data.cacheStorageType === 'filesystem') {
    storage = {
      type: 'filesystem',
      fsBasePath: data.cacheStorageFsPath,
      fsBaseUrl: data.cacheStorageFsBaseUrl,
      ...userCacheStorage,
    };
  } else {
    storage = { ...userCacheStorage };
  }

  return {
    ...data,
    instanceId,
    storage,
  };
}
