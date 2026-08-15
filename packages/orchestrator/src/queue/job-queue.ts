import { randomUUID } from 'node:crypto';
import { type Kysely, type SqlBool, sql } from 'kysely';
import { type LabelMatcher, matcherSatisfiedBy, type ResourceRequest } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { Database, DispatchQueueItem } from '../db/types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

const logger = createLogger({ prefix: 'job-queue' });

/** Info about an expired dispatch_queue entry, returned by markExpired(). */
export interface ExpiredJobInfo {
  /** dispatch_queue row ID */
  id: string;
  runId: string;
  jobName: string;
  /** Most recent scaler spawn-failure detail, if any was recorded. */
  lastProvisioningError: string | null;
  /**
   * The job's routing selectors, carried so the expiry sweep can ask whether
   * any agent could ever have run it. A job that expires with NO matching agent
   * is `unroutable` (a fleet/label problem); one whose agent existed but never
   * freed up is `timed_out_stale` (a capacity problem).
   */
  runsOnLabels: string[];
  runsOnPatterns: LabelMatcher[];
  excludeLabels: string[];
  excludePatterns: LabelMatcher[];
}

/**
 * A pending job as the unroutable probe sees it: the same routing facts the
 * expiry sweep reads, plus the persisted grace clock.
 */
export interface UnroutableCandidate extends ExpiredJobInfo {
  /** When this job first read unroutable; null while it reads routable. */
  unroutableSince: Date | null;
}

/** The dispatch_queue columns both the expiry sweep and the probe select. */
interface ExpiryRowShape {
  id: string;
  run_id: string;
  job_name: string;
  last_provisioning_error: string | null;
  runs_on_labels: unknown;
  runs_on_patterns: unknown;
  exclude_labels: unknown;
  exclude_patterns: unknown;
}

/**
 * Shared row -> {@link ExpiredJobInfo} mapping, so the expiry sweep and the
 * unroutable probe can never read a job's selectors differently.
 */
function rowToExpiredJobInfo(r: ExpiryRowShape): ExpiredJobInfo {
  return {
    id: r.id,
    runId: r.run_id,
    jobName: r.job_name,
    lastProvisioningError: r.last_provisioning_error ?? null,
    runsOnLabels: parseSelectorColumnForExpiry<string>(r.runs_on_labels, 'runs_on_labels'),
    runsOnPatterns: parseSelectorColumnForExpiry<LabelMatcher>(
      r.runs_on_patterns,
      'runs_on_patterns',
    ),
    excludeLabels: parseSelectorColumnForExpiry<string>(r.exclude_labels, 'exclude_labels'),
    excludePatterns: parseSelectorColumnForExpiry<LabelMatcher>(
      r.exclude_patterns,
      'exclude_patterns',
    ),
  };
}

/**
 * Point-in-time breakdown of dispatch_queue depth used for Prometheus gauges
 * and operator-facing depth warnings.
 *
 * `byStatus` carries the raw COUNT(*) for each {@link DispatchQueueStatus.Pending}
 * and {@link DispatchQueueStatus.Dispatched} bucket (other statuses are
 * terminal and not surfaced here).
 *
 * `byLabel` is a flat rollup of pending-only jobs keyed by each distinct label
 * in `runs_on_labels`. Multi-label jobs fan out: a job with `runs_on_labels =
 * ['linux', 'x64']` contributes 1 to both `linux` and `x64`. This matches the
 * "label pool" mental model operators use in Grafana (agents advertise their
 * labels; the gauge answers "how many pending jobs want this label").
 */
export interface DispatchQueueDepthBreakdown {
  byStatus: Partial<Record<DispatchQueueStatus, number>>;
  byLabel: Record<string, number>;
}

/**
 * Status values for dispatch_queue entries.
 *
 * Lifecycle: pending → dispatched → completed | failed
 *                    ↘ recovering → failed | dispatched (reclaimed)
 *            pending → expired (timeout)
 */
export enum DispatchQueueStatus {
  Pending = 'pending',
  Dispatched = 'dispatched',
  Completed = 'completed',
  Failed = 'failed',
  Expired = 'expired',
  Recovering = 'recovering',
}

/**
 * Maximum delivery attempts for a single dispatch_queue job. A job whose
 * `dispatch_attempts` reaches this value is failed permanently instead of
 * being requeued again. Bounds requeue loops from repeated job.reject /
 * pre-start agent loss; `expires_at` is the time-based backstop.
 */
export const MAX_DISPATCH_ATTEMPTS = 5;

/**
 * Input for enqueuing a job. Callers provide these fields;
 * the queue generates id, status, created_at, and expires_at.
 */
export interface QueuedJobInput {
  /**
   * Optional pre-allocated job identifier. When set, the queue uses this
   * exact id instead of generating one — required for the cluster reroute
   * path so the sending coord can register execution_runs/execution_jobs
   * rows under the same id the receiving worker dispatches against.
   */
  jobId?: string;
  runId: string;
  workflowName: string;
  jobName: string;
  runsOnLabels: string[];
  jobConfig: Record<string, unknown>;
  repoUrl: string;
  ref: string;
  sha: string;
  deliveryId: string;
  /** Provider type (e.g., "github", "gitlab") */
  provider: string;
  /** Provider-specific context (e.g., { installationId: 42 } for GitHub) */
  providerContext: Record<string, unknown>;
  /** Routing key (e.g. "github:12345") for selecting the per-app provider
   *  bundle when dispatching. Required for multi-app safety. */
  routingKey: string;
  /** Override default timeout. 0 = indefinite (no expiry). */
  timeoutMs?: number;
  /** URL to pre-compiled bundle (from cache). Passed through to job.dispatch. */
  sourceTarUrl?: string;
  /** Content hash of the pre-compiled bundle for verification. */
  sourceTarHash?: string;
  /** URL to pre-built dependency tarball (from dep cache). Passed through to job.dispatch. */
  depsUrl?: string;
  /** SHA-256 hash of the dependency tarball for integrity verification. */
  depsHash?: string;
  /** Request trace ID for cross-tier correlation. Passed through to job.dispatch. */
  requestId?: string;
  /** Labels that the dispatched agent must NOT have. */
  excludeLabels?: string[];
  /** Regex matchers the agent's labels must satisfy (JS post-filter on the exact @> prefilter). */
  runsOnPatterns?: LabelMatcher[];
  /** Regex matchers that disqualify an agent (JS post-filter). */
  excludePatterns?: LabelMatcher[];
  /**
   * Per-job resource request and limit (K8s-style). Drives scaler cap accounting
   * (`requests`) and kernel-side enforcement on the spawned agent (`limits`).
   * Stored inside `jobConfig` JSON; this typed field is a convenience for callers.
   */
  resources?: ResourceRequest;
  /**
   * For a runsOnAll host-fanout child: the agent this job is pinned to. The
   * dispatcher routes it only to that agent; the drain never hands it to another.
   */
  pinnedAgentId?: string;
  /**
   * For a pinned child: which orchestrator instance owns the pinned agent's live
   * WS (null = not currently connected). Used by the cross-cluster pin reroute.
   */
  connectedInstanceId?: string | null;
}

/**
 * Full queued job as stored in the database.
 */
export interface QueuedJob {
  id: string;
  runId: string;
  workflowName: string;
  jobName: string;
  runsOnLabels: string[];
  jobConfig: Record<string, unknown>;
  repoUrl: string;
  ref: string;
  sha: string;
  status: DispatchQueueStatus;
  createdAt: string;
  expiresAt: string | null;
  deliveryId: string;
  /** Provider type (e.g., "github", "gitlab") */
  provider: string;
  /** Provider-specific context */
  providerContext: Record<string, unknown>;
  /** Routing key (e.g. "github:12345") used to look up the per-app provider
   *  bundle on dispatch. Required for multi-app safety. */
  routingKey: string;
  /** URL to pre-compiled bundle (from cache). Passed through to job.dispatch. */
  sourceTarUrl?: string;
  /** Content hash of the pre-compiled bundle for verification. */
  sourceTarHash?: string;
  /** URL to pre-built dependency tarball (from dep cache). Passed through to job.dispatch. */
  depsUrl?: string;
  /** SHA-256 hash of the dependency tarball for integrity verification. */
  depsHash?: string;
  /** Request trace ID for cross-tier correlation. Passed through to job.dispatch. */
  requestId?: string;
  /** Labels that the dispatched agent must NOT have. */
  excludeLabels: string[];
  /** Regex matchers the agent's labels must satisfy (JS post-filter on the exact @> prefilter). */
  runsOnPatterns: LabelMatcher[];
  /** Regex matchers that disqualify an agent (JS post-filter). */
  excludePatterns: LabelMatcher[];
  /**
   * Per-job resource request and limit (K8s-style). Materialized from `jobConfig.resources`
   * by `rowToQueuedJob` so callers can read it without re-parsing the JSON column.
   */
  resources?: ResourceRequest;
  /** For a runsOnAll host-fanout child: the agent this job is pinned to. */
  pinnedAgentId?: string;
}

/**
 * DB-backed FIFO job dispatch queue using Kysely (PostgreSQL only).
 * Uses SQL-based JSONB containment queries (@> operator) for label matching.
 */
export class JobQueue {
  private readonly db: Kysely<Database>;
  /** Cluster-wide fallback for queue_max_depth when cluster_settings is null. */
  private readonly defaultMaxDepth: number;
  private readonly defaultTimeoutMs: number;
  private readonly clusterSettings?: ClusterSettingsReader;
  /** Per-job (per-org) queue-timeout resolver; falls back to defaultTimeoutMs. */
  private readonly getQueueTimeoutMs?: (job: {
    jobConfig?: Record<string, unknown>;
  }) => Promise<number>;
  /** 1-second TTL cache for pending depth count to avoid extra SELECT COUNT per enqueue. */
  private depthCache: { count: number; expiresAt: number } | null = null;
  /**
   * 1-second TTL cache for the dispatch-queue depth breakdown (per-status + per-label).
   * Fed by {@link JobQueue.getDepthBreakdown} and read synchronously by
   * {@link JobQueue.readCachedDepthBreakdown} so the Prometheus observable
   * gauge callback never issues an extra COUNT per scrape.
   */
  private breakdownCache: {
    breakdown: DispatchQueueDepthBreakdown;
    expiresAt: number;
  } | null = null;

  constructor(
    db: Kysely<Database>,
    options: {
      maxDepth: number;
      defaultTimeoutMs: number;
      clusterSettings?: ClusterSettingsReader;
      getQueueTimeoutMs?: (job: { jobConfig?: Record<string, unknown> }) => Promise<number>;
    },
  ) {
    this.db = db;
    this.defaultMaxDepth = options.maxDepth;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.clusterSettings = options.clusterSettings;
    this.getQueueTimeoutMs = options.getQueueTimeoutMs;
  }

  /**
   * Enqueue a job. Checks depth first, rejects with 'queue full' if >= the
   * fleet-wide `queue_max_depth` (cluster_settings, falling back to the config
   * default). The per-job timeout resolves through the per-org
   * `queue_timeout_ms` override.
   * @returns The generated job ID.
   */
  async enqueue(job: QueuedJobInput): Promise<string> {
    const maxDepth =
      (await this.clusterSettings?.getNumber('queue_max_depth', this.defaultMaxDepth)) ??
      this.defaultMaxDepth;
    const depth = await this.getDepth();
    if (depth >= maxDepth) {
      throw new Error('queue full');
    }

    const id = job.jobId ?? randomUUID();
    const now = new Date().toISOString();
    const clusterTimeout = this.getQueueTimeoutMs
      ? await this.getQueueTimeoutMs(job)
      : this.defaultTimeoutMs;
    const timeoutMs = job.timeoutMs ?? clusterTimeout;
    const expiresAt = timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null;

    // ON CONFLICT (id) DO NOTHING: a reroute re-enqueue reuses a preassigned
    // jobId, so a duplicate from a sibling coordinator is a benign no-op rather
    // than a dispatch_queue_pkey error. Queuing is naturally idempotent — the
    // existing row already represents the pending job.
    await this.db
      .insertInto('dispatch_queue')
      .values({
        id,
        run_id: job.runId,
        workflow_name: job.workflowName,
        job_name: job.jobName,
        runs_on_labels: JSON.stringify(job.runsOnLabels),
        job_config: JSON.stringify(job.jobConfig),
        repo_url: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        status: DispatchQueueStatus.Pending,
        created_at: now as unknown as Date,
        expires_at: expiresAt as unknown as Date | null,
        delivery_id: job.deliveryId,

        provider: job.provider,
        provider_context: JSON.stringify(job.providerContext),
        source_tar_url: job.sourceTarUrl ?? null,
        source_tar_hash: job.sourceTarHash ?? null,
        deps_url: job.depsUrl ?? null,
        deps_hash: job.depsHash ?? null,
        request_id: job.requestId ?? null,
        exclude_labels: JSON.stringify(job.excludeLabels ?? []),
        runs_on_patterns: JSON.stringify(job.runsOnPatterns ?? []),
        exclude_patterns: JSON.stringify(job.excludePatterns ?? []),
        routing_key: job.routingKey,
        pinned_agent_id: job.pinnedAgentId ?? null,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Invalidate both caches so the next enqueue / gauge scrape sees the updated counts
    this.depthCache = null;
    this.breakdownCache = null;

    return id;
  }

  /**
   * Dequeue the oldest pending job whose runsOnLabels are a subset of the
   * provided agent labels. Uses SQL JSONB containment (@> operator) with
   * GIN index for O(1) lookups instead of fetching all rows and filtering in JS.
   *
   * Semantics: agentLabels @> runs_on_labels (agent provides all labels the job requires).
   * FOR UPDATE SKIP LOCKED prevents concurrent dequeue races between agents.
   *
   * When `agentMandatoryLabels` is non-empty, an additional containment check
   * (`runs_on_labels @> agentMandatoryLabels`) enforces the
   * Kubernetes-taint-style gate inherited from the spawning scaler: a gated
   * agent only accepts jobs whose `runsOn` lists every gate label. The
   * default (`[]`) is a no-op for static / non-scaler agents — every JSONB
   * array trivially contains the empty array, so the predicate is vacuously
   * true.
   *
   * @param agentLabels Labels the agent provides.
   * @param agentMandatoryLabels Mandatory labels the spawning scaler declared
   *   (empty for static / non-scaler agents).
   * @returns The matching job, or null if none found.
   */
  async dequeueForLabels(
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
    agentId?: string,
  ): Promise<QueuedJob | null> {
    // Fast path: pattern-free rows, single-statement atomic claim (the 99% hot
    // path) — the row leaves Pending in the same statement that selects it, so
    // the caller's markDispatched only re-affirms a transition already made.
    const fast = await this.claimPatternFree(agentLabels, agentMandatoryLabels, agentId);
    if (fast) return fast;
    // Pattern path: rows carrying regex matchers, JS post-filter via the engine's
    // matcherSatisfiedBy (the single matching authority — never a Postgres ~).
    return this.claimWithPatterns(agentLabels, agentMandatoryLabels, agentId);
  }

  /**
   * The column writes that constitute a claim. Identical to what
   * {@link markDispatched} sets, so a claim and the caller's follow-up
   * markDispatched are the same transition applied twice rather than two
   * different half-transitions — and a row is never observable as Dispatched
   * with no owner.
   *
   * `agentId` is optional only because `dequeueForLabels` accepts it optionally;
   * every production caller supplies it.
   */
  private claimTransition(agentId?: string): {
    status: DispatchQueueStatus;
    last_provisioning_error: null;
    agent_id?: string;
  } {
    return {
      status: DispatchQueueStatus.Dispatched,
      last_provisioning_error: null,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    };
  }

  /**
   * Conditionally claim one row by id: flip Pending -> Dispatched, returning
   * whether this caller won. The `status = Pending` guard is the arbiter — a
   * loser updates zero rows and must treat that as "someone else took it",
   * never as an error.
   *
   * Used by every claim path that has to run a JS post-filter before claiming
   * (the regex matchers), since that filter runs after the SELECT's
   * per-statement lock window has already closed.
   */
  private async claimRowById(jobId: string, agentId?: string): Promise<boolean> {
    const claimed = await this.db
      .updateTable('dispatch_queue')
      .set(this.claimTransition(agentId))
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Pending)
      .executeTakeFirst();
    return (claimed.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Build the shared drain WHERE chain (status / expiry / exact-label @> /
   * exclude-label / pin / mandatory-label gate) common to both drain passes.
   * The pattern columns are NOT filtered here — each pass adds its own
   * pattern-free / pattern-bearing guard on top.
   *
   * No projection is attached: the pattern-free pass selects `id` alone (it
   * embeds this as the sub-select of its claiming UPDATE), while the pattern
   * pass selects every column so it can run the JS matcher post-filter.
   */
  private drainBaseQuery(agentLabels: string[], agentMandatoryLabels: string[], agentId?: string) {
    const agentLabelsJson = JSON.stringify(agentLabels);
    const mandatoryLabelsJson = JSON.stringify(agentMandatoryLabels);
    let query = this.db
      .selectFrom('dispatch_queue')
      .where('status', '=', DispatchQueueStatus.Pending)
      .where(sql<SqlBool>`(expires_at IS NULL OR expires_at >= now())`)
      .where(sql<SqlBool>`${sql.lit(agentLabelsJson)}::jsonb @> runs_on_labels`)
      .where(
        sql<SqlBool>`NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(exclude_labels) AS e
          WHERE e.value = ANY(${sql.val(agentLabels)}::text[])
        )`,
      );
    // A pinned host-fanout child is only drainable by its pinned agent; an
    // unpinned job is drainable by any matching agent.
    query = query.where(
      sql<SqlBool>`(pinned_agent_id IS NULL${
        agentId ? sql` OR pinned_agent_id = ${sql.val(agentId)}` : sql``
      })`,
    );
    if (agentMandatoryLabels.length > 0) {
      query = query.where(sql<SqlBool>`runs_on_labels @> ${sql.lit(mandatoryLabelsJson)}::jsonb`);
    }
    return query;
  }

  /**
   * Fast path: claim the oldest pending pattern-free row. The
   * `runs_on_patterns = '[]' AND exclude_patterns = '[]'` guard restricts this
   * pass to rows that need no JS post-filter, which is what lets the whole
   * claim be ONE statement.
   *
   * Selecting a row and transitioning it in two statements is not a claim.
   * Outside an explicit transaction the `FOR UPDATE` lock lives only for the
   * duration of its own SELECT, so a second agent arriving between the SELECT
   * and the UPDATE reads the row still Pending, skips nothing, and dispatches
   * the same job — which is one job executing twice on two agents, side effects
   * and all.
   *
   * So the sub-select is embedded in the claiming UPDATE: its `FOR UPDATE SKIP
   * LOCKED` row lock is now taken inside the UPDATE's own transaction and held
   * until commit. That buys both halves at once — exactly one claimant can win
   * a given row, and a concurrent claimant SKIPs the locked row and takes the
   * *next* one instead of coming back empty-handed, which a select-then-claim
   * retry loop would not preserve. The redundant outer `status = Pending` is
   * belt-and-braces on the arbiter.
   */
  private async claimPatternFree(
    agentLabels: string[],
    agentMandatoryLabels: string[],
    agentId?: string,
  ): Promise<QueuedJob | null> {
    const candidate = this.drainBaseQuery(agentLabels, agentMandatoryLabels, agentId)
      .select('id')
      .where(sql<SqlBool>`runs_on_patterns = '[]'::jsonb AND exclude_patterns = '[]'::jsonb`)
      .orderBy('created_at', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked();

    const row = await this.db
      .updateTable('dispatch_queue')
      .set(this.claimTransition(agentId))
      .where('id', '=', candidate)
      .where('status', '=', DispatchQueueStatus.Pending)
      .returningAll()
      .executeTakeFirst();
    return row ? this.rowToQueuedJob(row) : null;
  }

  /**
   * Pattern path: load a small batch of pattern-bearing candidate rows, apply
   * the JS regex post-filter (matcherSatisfiedBy), and atomically claim the
   * first match by id with a conditional `status = Pending` guard. The claim is
   * a conditional UPDATE rather than relying on the SELECT lock alone because
   * the JS filter runs after the per-statement lock window has closed, so two
   * agents could both pass the filter for the same row; the `where status =
   * Pending` makes exactly one of them win. The claim transitions the row to
   * Dispatched, matching the value the caller-side markDispatched would set
   * (which then re-sets it idempotently).
   *
   * Losing the claim continues to the next candidate rather than returning
   * null, so a lost race costs this agent a candidate and not a whole drain.
   */
  private async claimWithPatterns(
    agentLabels: string[],
    agentMandatoryLabels: string[],
    agentId?: string,
  ): Promise<QueuedJob | null> {
    const labelSet = new Set(agentLabels);
    const rows = await this.drainBaseQuery(agentLabels, agentMandatoryLabels, agentId)
      .selectAll()
      .where(sql<SqlBool>`(runs_on_patterns <> '[]'::jsonb OR exclude_patterns <> '[]'::jsonb)`)
      .orderBy('created_at', 'asc')
      .limit(10)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const row of rows) {
      const job = this.rowToQueuedJob(row);
      if (!jobPatternsSatisfiedBy(job, labelSet)) continue;
      // Another agent may have won the conditional claim; only return on success.
      if (await this.claimRowById(row.id, agentId)) return job;
    }
    return null;
  }

  /**
   * Atomically claim the oldest pending job pinned to a specific agent. Used by
   * the eager pin drain when the pinned agent (re)registers or frees a slot —
   * the host-fanout analog of `dispatchBoundJob`'s eager path. Ignores the exact
   * label gate: the pin was resolved against the roster at materialize time.
   *
   * Still applies the JS regex post-filter (`jobPatternsSatisfiedBy`) when
   * `agentLabels` is supplied, mirroring `dequeueById`: a pinned child whose
   * `runsOn`/`exclude` patterns no longer match the agent's current labels must
   * not be claimed. The single matching authority is the engine's
   * `matcherSatisfiedBy` (never a Postgres `~`).
   *
   * The claim is the conditional UPDATE, not the SELECT: the JS post-filter has
   * to run first (claiming and then releasing a pattern-rejected row would
   * strand it as Dispatched), which puts the filter outside the SELECT's
   * per-statement lock window. Losing that claim returns null, and
   * `onAgentAvailable` then falls through to the generic label drain — which
   * also matches jobs pinned to this agent — so a lost race is not a stall.
   */
  async dequeueByPinnedAgent(agentId: string, agentLabels?: string[]): Promise<QueuedJob | null> {
    const row = await this.db
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('status', '=', DispatchQueueStatus.Pending)
      .where('pinned_agent_id', '=', agentId)
      .where(sql<SqlBool>`(expires_at IS NULL OR expires_at >= now())`)
      .orderBy('created_at', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();

    if (!row) return null;
    const job = this.rowToQueuedJob(row);
    if (agentLabels && !jobPatternsSatisfiedBy(job, new Set(agentLabels))) return null;
    if (!(await this.claimRowById(job.id, agentId))) return null;
    return job;
  }

  /**
   * Atomically claim a specific pending job by ID, validating it still
   * matches the agent's labels and isn't expired.
   *
   * Used by the eager-dispatch path: when the scaler spawned an agent for a
   * specific queued job, the orchestrator claims that exact job on agent
   * registration instead of racing the generic dequeueForLabels drain.
   *
   * Applies the same `agentMandatoryLabels` gate as `dequeueForLabels` so
   * the eager-dispatch path can never claim a job that the scaler-side gate
   * would have rejected (e.g. when the bound jobId outlived the scaler that
   * spawned the agent and was reassigned to a different queued job).
   *
   * Returns null if the job is gone, no longer pending, expired, its label
   * requirements are no longer satisfied by the agent, the agent's gate is not
   * satisfied by the job's `runsOn`, or another claimant won the row first.
   *
   * That last case is the one this shares with every other claim path: the
   * eager bound claim and the generic drain can target the same row moments
   * apart, and a SELECT that returns the row still Pending lets both dispatch
   * it. The conditional UPDATE below is the arbiter, and it runs after the JS
   * post-filter so a pattern-rejected row is never claimed and stranded. A
   * loser returns null, and `dispatchBoundJob` then falls back to the generic
   * `onAgentAvailable` drain exactly as it does for an already-gone job.
   *
   * @param claimingAgentId Recorded as the row's durable owner as part of the
   *   claim. Optional so existing 3-arg callers keep working; the caller's
   *   markDispatched sets the same column immediately afterwards either way.
   */
  async dequeueById(
    jobId: string,
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
    claimingAgentId?: string,
  ): Promise<QueuedJob | null> {
    const agentLabelsJson = JSON.stringify(agentLabels);
    const mandatoryLabelsJson = JSON.stringify(agentMandatoryLabels);

    let query = this.db
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Pending)
      .where(sql<SqlBool>`(expires_at IS NULL OR expires_at >= now())`)
      .where(sql<SqlBool>`${sql.lit(agentLabelsJson)}::jsonb @> runs_on_labels`)
      .where(
        sql<SqlBool>`NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(exclude_labels) AS e
          WHERE e.value = ANY(${sql.val(agentLabels)}::text[])
        )`,
      );

    if (agentMandatoryLabels.length > 0) {
      query = query.where(sql<SqlBool>`runs_on_labels @> ${sql.lit(mandatoryLabelsJson)}::jsonb`);
    }

    const row = await query.forUpdate().skipLocked().executeTakeFirst();
    if (!row) return null;

    // JS post-filter the regex matchers (single matching authority): a bound
    // job whose runsOn/exclude patterns are no longer satisfied by this agent's
    // labels must not be claimed.
    const job = this.rowToQueuedJob(row);
    if (!jobPatternsSatisfiedBy(job, new Set(agentLabels))) return null;
    if (!(await this.claimRowById(job.id, claimingAgentId))) return null;
    return job;
  }

  /**
   * Insert a job directly with status='dispatched' (bypasses the queue).
   * Used when an agent is immediately available and the job doesn't need to wait.
   *
   * `agentId` is the durable owner, written here for the same reason
   * {@link markDispatched} writes it on the queue-drain path: this row is
   * dispatched the moment it is inserted, so it never passes through
   * `markDispatched` and would otherwise carry a NULL owner for its whole life.
   * A coordinator that never saw the dispatch resolves ownership from this
   * column alone, so omitting it here would make {@link hasAgentOwnedJob} answer
   * "not owned" for every directly-dispatched job after a failover.
   *
   * Idempotent on the primary key: a reroute re-dispatch reuses a preassigned
   * jobId, so a concurrent reroute from a sibling coordinator (or a duplicate
   * delivery) may target a row this instance already wrote. ON CONFLICT (id) DO
   * NOTHING makes that a no-op instead of a dispatch_queue_pkey error; the
   * returned `inserted` flag tells the caller whether a fresh row was created so
   * it can avoid double-dispatching an already-present job. The conflicting row
   * keeps the owner the winning writer recorded.
   *
   * @returns The job ID and whether a new row was inserted (false = row already existed).
   */
  async insertDispatched(
    job: QueuedJobInput,
    agentId: string,
  ): Promise<{ id: string; inserted: boolean }> {
    const id = job.jobId ?? randomUUID();
    const now = new Date().toISOString();

    const inserted = await this.db
      .insertInto('dispatch_queue')
      .values({
        id,
        run_id: job.runId,
        workflow_name: job.workflowName,
        job_name: job.jobName,
        runs_on_labels: JSON.stringify(job.runsOnLabels),
        job_config: JSON.stringify(job.jobConfig),
        repo_url: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        status: DispatchQueueStatus.Dispatched,
        created_at: now as unknown as Date,
        expires_at: null,
        delivery_id: job.deliveryId,
        provider: job.provider,
        provider_context: JSON.stringify(job.providerContext),
        source_tar_url: job.sourceTarUrl ?? null,
        source_tar_hash: job.sourceTarHash ?? null,
        deps_url: job.depsUrl ?? null,
        deps_hash: job.depsHash ?? null,
        request_id: job.requestId ?? null,
        exclude_labels: JSON.stringify(job.excludeLabels ?? []),
        runs_on_patterns: JSON.stringify(job.runsOnPatterns ?? []),
        exclude_patterns: JSON.stringify(job.excludePatterns ?? []),
        routing_key: job.routingKey,
        pinned_agent_id: job.pinnedAgentId ?? null,
        agent_id: agentId,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();

    return { id, inserted: inserted !== undefined };
  }

  /**
   * Mark a job as dispatched and record the agent it went to.
   *
   * `agent_id` is the durable owner: the dispatcher also tracks agent-to-job
   * mappings in memory (agentJobs Map), but that map is per-coordinator, so a
   * coordinator that never saw the dispatch has to read the owner back from the
   * row to answer an ownership question.
   */
  async markDispatched(jobId: string, agentId: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({
        status: DispatchQueueStatus.Dispatched,
        last_provisioning_error: null,
        agent_id: agentId,
      })
      .where('id', '=', jobId)
      .execute();
  }

  /**
   * Mark a job as failed.
   *
   * Note: reason is not persisted in the dispatch_queue table.
   * Failure details are tracked in execution_jobs via the reporting pipeline.
   * The dispatch_queue only tracks routing status transitions.
   */
  async markFailed(jobId: string, _reason: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Failed })
      .where('id', '=', jobId)
      .execute();
  }

  /**
   * Mark a dispatched job as completed (terminal success).
   *
   * Only transitions rows from `Dispatched` or `Recovering`. A row that has
   * already reached a terminal state (`Failed`, `Expired`, `Completed`,
   * `Cancelled`) is left untouched — if the orchestrator already declared
   * the job failed (e.g. build-coordinator timeout cascading through
   * {@link failByRunId}), a late `job.complete` from the agent that was
   * still working must NOT silently flip the row back to `Completed`.
   */
  async markCompleted(jobId: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Completed })
      .where('id', '=', jobId)
      .where('status', 'in', [DispatchQueueStatus.Dispatched, DispatchQueueStatus.Recovering])
      .execute();
  }

  /**
   * Expire timed-out pending jobs.
   * SELECT-then-UPDATE so callers get the expired job details for forwarding.
   * @returns Array of expired job info (id, runId, jobName).
   */
  async markExpired(): Promise<ExpiredJobInfo[]> {
    const now = new Date().toISOString();

    // 1. SELECT the about-to-expire rows
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select([
        'id',
        'run_id',
        'job_name',
        'last_provisioning_error',
        'runs_on_labels',
        'runs_on_patterns',
        'exclude_labels',
        'exclude_patterns',
      ])
      .where('status', '=', DispatchQueueStatus.Pending)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<', now as unknown as Date)
      .execute();

    if (rows.length === 0) return [];

    // 2. UPDATE those rows by ID
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Expired })
      .where(
        'id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();

    return rows.map((r) => rowToExpiredJobInfo(r));
  }

  /**
   * Bulk-fail every still-non-terminal dispatch_queue entry for a run.
   *
   * Called from the run-level failure cascades in `ExecutionTracker`
   * (`onBuildFailed`, `failRun`). At that point the run itself is being
   * declared failed, so any dispatch_queue row still in `Pending`,
   * `Recovering`, or `Dispatched` is by definition orphaned and must
   * also be moved to `Failed` — leaving a `Dispatched` row in place
   * keeps the row in a non-terminal state forever, which the build-timeout
   * E2E (and any operator query for "is this run actually done") relies
   * on never happening. The complementary {@link markCompleted} status
   * guard ensures a late `job.complete` from the agent that was still
   * working when the run was declared failed cannot flip the row back
   * to `Completed`.
   *
   * @returns Number of affected rows.
   */
  async failByRunId(runId: string): Promise<number> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Failed })
      .where('run_id', '=', runId)
      .where('status', 'in', [
        DispatchQueueStatus.Pending,
        DispatchQueueStatus.Recovering,
        DispatchQueueStatus.Dispatched,
      ])
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /**
   * Bulk-cancel all pending dispatch_queue entries for a run.
   * Called when a run is cancelled via API.
   * @returns Number of affected rows.
   */
  async cancelByRunId(runId: string): Promise<number> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Expired })
      .where('run_id', '=', runId)
      .where('status', '=', DispatchQueueStatus.Pending)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }

  /**
   * Delete terminal dispatch_queue rows older than `retentionDays`.
   *
   * `dispatch_queue` is operational dispatch state; the durable run history
   * lives in the cold-stored execution_runs/jobs/steps tables, so a terminal
   * ({@link DispatchQueueStatus.Completed}/{@link DispatchQueueStatus.Failed}/
   * {@link DispatchQueueStatus.Expired}) row has no archival value once it ages
   * out. Non-terminal rows ({@link DispatchQueueStatus.Pending}/
   * {@link DispatchQueueStatus.Dispatched}/{@link DispatchQueueStatus.Recovering})
   * are never pruned — a still-active run keeps every one of its rows. Both the
   * terminal-status filter and the age cutoff must hold for a row to be deleted.
   *
   * `retentionDays <= 0` disables pruning (returns 0 without a query).
   *
   * @returns Number of rows deleted.
   */
  async pruneTerminalDispatchRows(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const result = await this.db
      .deleteFrom('dispatch_queue')
      .where('status', 'in', [
        DispatchQueueStatus.Completed,
        DispatchQueueStatus.Failed,
        DispatchQueueStatus.Expired,
      ])
      .where('created_at', '<', sql<Date>`now() - make_interval(days => ${retentionDays})`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /**
   * Get the current number of pending jobs.
   * Uses a 1-second TTL cache to avoid extra SELECT COUNT per enqueue.
   */
  async getDepth(): Promise<number> {
    const now = Date.now();
    if (this.depthCache && this.depthCache.expiresAt > now) {
      return this.depthCache.count;
    }

    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(this.db.fn.countAll<number>().as('count'))
      .where('status', '=', DispatchQueueStatus.Pending)
      .executeTakeFirst();

    const count = Number(rows?.count ?? 0);
    this.depthCache = { count, expiresAt: now + 1000 };
    return count;
  }

  /**
   * Compute the current dispatch-queue depth breakdown (pending + dispatched),
   * aggregated per status and, for pending rows, per label.
   *
   * Uses the same 1-second TTL cache pattern as {@link JobQueue.getDepth}: if
   * the cached breakdown is still fresh (or was refreshed within the last
   * second), the cached value is returned without issuing a query. This keeps
   * the Prometheus gauge callback cheap on high-frequency scrapes and avoids
   * any extra DB load during enqueue bursts.
   *
   * Multi-label jobs fan out: a pending row with `runs_on_labels = ['linux',
   * 'x64']` contributes `1` to both the `linux` and `x64` entries in
   * `byLabel`. The `byStatus` buckets always contain raw counts.
   */
  async getDepthBreakdown(): Promise<DispatchQueueDepthBreakdown> {
    const now = Date.now();
    if (this.breakdownCache && this.breakdownCache.expiresAt > now) {
      return this.breakdownCache.breakdown;
    }

    // Single pass: grab status + runs_on_labels for every non-terminal row.
    // This is O(n) with n bounded by maxDepth + a handful of dispatched rows,
    // so the work is negligible even at the 10k queue-depth guardrail.
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['status', 'runs_on_labels'])
      .where('status', 'in', [DispatchQueueStatus.Pending, DispatchQueueStatus.Dispatched])
      .execute();

    const byStatus: Partial<Record<DispatchQueueStatus, number>> = {
      [DispatchQueueStatus.Pending]: 0,
      [DispatchQueueStatus.Dispatched]: 0,
    };
    const byLabel: Record<string, number> = {};

    for (const row of rows) {
      const status = row.status as DispatchQueueStatus;
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (status !== DispatchQueueStatus.Pending) continue;

      const labels = Array.isArray(row.runs_on_labels)
        ? row.runs_on_labels
        : typeof row.runs_on_labels === 'string'
          ? (JSON.parse(row.runs_on_labels) as string[])
          : [];
      for (const label of labels) {
        byLabel[label] = (byLabel[label] ?? 0) + 1;
      }
    }

    const breakdown: DispatchQueueDepthBreakdown = { byStatus, byLabel };
    this.breakdownCache = { breakdown, expiresAt: now + 1000 };
    // Keep the simple pending-count cache in sync — both read the same row.
    this.depthCache = {
      count: byStatus[DispatchQueueStatus.Pending] ?? 0,
      expiresAt: now + 1000,
    };
    return breakdown;
  }

  /**
   * Return the most recently cached breakdown without issuing a DB query.
   *
   * Intended for synchronous contexts such as the OpenTelemetry observable
   * gauge callback, which MUST NOT perform I/O. Callers are responsible for
   * refreshing the cache periodically via {@link JobQueue.getDepthBreakdown}.
   */
  readCachedDepthBreakdown(): DispatchQueueDepthBreakdown | null {
    return this.breakdownCache?.breakdown ?? null;
  }

  /**
   * Get job IDs for a run that are currently dispatched or recovering.
   * Used by the cancel-run API to send job.cancel to the right agents.
   * Includes recovering jobs since they may still be reclaimed by a reconnecting agent.
   */
  async getDispatchedJobIdsByRunId(runId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select('id')
      .where('run_id', '=', runId)
      .where('status', 'in', [DispatchQueueStatus.Dispatched, DispatchQueueStatus.Recovering])
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * Mark a job as recovering (agent disconnected, within grace period).
   * Only transitions from 'dispatched' state for safety.
   *
   * When `deadline` and `agentId` are provided, persists them so a
   * replacement coord on Raft leader switch can recreate the recovery
   * timer (via `getRecoveringJobs()` on boot) or expire the row in
   * the leader-gated sweep (`sweepExpiredRecoveries()`).
   */
  async markRecovering(jobId: string, deadline?: Date, agentId?: string): Promise<void> {
    const setValues: {
      status: DispatchQueueStatus;
      recovery_deadline?: Date;
      recovery_agent_id?: string;
    } = { status: DispatchQueueStatus.Recovering };
    if (deadline !== undefined) setValues.recovery_deadline = deadline;
    if (agentId !== undefined) setValues.recovery_agent_id = agentId;
    await this.db
      .updateTable('dispatch_queue')
      .set(setValues)
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Dispatched)
      .execute();
  }

  /**
   * Stamp the dispatch-acknowledgment deadline for a dispatched job.
   * Only touches rows still in 'dispatched' for safety.
   */
  async setAckDeadline(jobId: string, deadline: Date, agentId: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ ack_deadline: deadline, ack_agent_id: agentId })
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Dispatched)
      .execute();
  }

  /** Clear the ack deadline (agent answered, or the job left 'dispatched'). */
  async clearAckDeadline(jobId: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ ack_deadline: null, ack_agent_id: null })
      .where('id', '=', jobId)
      .execute();
  }

  /**
   * List dispatched rows still awaiting an ack (non-null deadline). Used at
   * coord boot (`Dispatcher.recoverState()`) to re-arm in-memory timers.
   */
  async getDispatchedAwaitingAck(): Promise<
    Array<{ id: string; runId: string; agentId: string | null; deadline: Date }>
  > {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'ack_agent_id', 'ack_deadline'])
      .where('status', '=', DispatchQueueStatus.Dispatched)
      .where('ack_deadline', 'is not', null)
      .execute();
    return rows
      .filter((r) => r.ack_deadline != null)
      .map((r) => ({
        id: r.id,
        runId: r.run_id,
        agentId: r.ack_agent_id ?? null,
        deadline: r.ack_deadline as Date,
      }));
  }

  /**
   * List every dispatched row whose ack deadline is in the past. The caller
   * (leader-gated `Dispatcher.sweepExpiredAckDeadlines`) requeues each via
   * the atomic `requeue()` (WHERE status='dispatched'), so racing coords
   * cannot double-requeue.
   */
  async listExpiredAckDeadlines(
    now: Date,
  ): Promise<Array<{ id: string; runId: string; agentId: string | null }>> {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'ack_agent_id'])
      .where('status', '=', DispatchQueueStatus.Dispatched)
      .where('ack_deadline', '<', now)
      .execute();
    return rows.map((r) => ({ id: r.id, runId: r.run_id, agentId: r.ack_agent_id ?? null }));
  }

  /**
   * List every job currently in `recovering` state with its persisted
   * recovery deadline. Used at coord boot (`Dispatcher.recoverState()`)
   * to recreate the in-memory `recoveringJobs` Map with fresh timers.
   *
   * Returns rows whose `recovery_deadline` is non-null (the populated
   * subset). Recovering rows from before the migration carry NULL and
   * are handled by the leader-gated sweep on its next pass.
   */
  async getRecoveringJobs(): Promise<
    Array<{ id: string; runId: string; agentId: string | null; deadline: Date | null }>
  > {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'recovery_agent_id', 'recovery_deadline'])
      .where('status', '=', DispatchQueueStatus.Recovering)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      agentId: r.recovery_agent_id ?? null,
      deadline: r.recovery_deadline ?? null,
    }));
  }

  /**
   * Sweep every `recovering` row whose `recovery_deadline` is in the
   * past, marking them `failed`. Returns the rows that flipped so the
   * caller can fire the per-job `onJobFailedPermanently` hook in process.
   *
   * Intended for the leader-gated `Dispatcher.sweepExpiredRecoveries`
   * tick — running on N coords would still be correct (the WHERE
   * `status='recovering'` clause prevents double-failure) but only one
   * needs to do the work.
   */
  async sweepExpiredRecoveries(
    now: Date,
  ): Promise<Array<{ id: string; runId: string; agentId: string | null }>> {
    const expired = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'recovery_agent_id'])
      .where('status', '=', DispatchQueueStatus.Recovering)
      .where('recovery_deadline', '<', now)
      .execute();
    if (expired.length === 0) return [];
    const ids = expired.map((r) => r.id);
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Failed })
      .where('id', 'in', ids)
      .where('status', '=', DispatchQueueStatus.Recovering)
      .execute();
    return expired.map((r) => ({
      id: r.id,
      runId: r.run_id,
      agentId: r.recovery_agent_id ?? null,
    }));
  }

  /**
   * Mark a job as failed only if it is still in 'recovering' state.
   * Uses optimistic concurrency to avoid failing jobs that were reclaimed.
   * @returns true if the update affected a row (job was still recovering).
   */
  async markFailedIfRecovering(jobId: string, _reason: string): Promise<boolean> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Failed })
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Recovering)
      .execute();
    return (result[0]?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Return a dispatched job to the pending queue for re-dispatch, bumping
   * its attempt counter. Used when an agent explicitly rejects a dispatch
   * (job.reject) and when a scaler-managed agent disconnects before the
   * job started. Only flips rows still in 'dispatched' — a job that was
   * concurrently completed / failed / cancelled is left untouched.
   *
   * @returns the post-increment dispatch_attempts, or null when the row
   *   was not in 'dispatched' state (nothing requeued).
   */
  async requeue(jobId: string): Promise<number | null> {
    const row = await this.db
      .updateTable('dispatch_queue')
      .set({
        status: DispatchQueueStatus.Pending,
        dispatch_attempts: sql<number>`dispatch_attempts + 1`,
        ack_deadline: null,
        ack_agent_id: null,
        agent_id: null,
        // A job that got dispatched was routable at that moment, so any grace
        // clock stamped before the dispatch is spent. Leaving it set would let
        // the probe fail a requeued job on its very next tick with no fresh
        // window — the clock must measure a CONTINUOUS unroutable stretch.
        unroutable_since: null,
      })
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Dispatched)
      .returning('dispatch_attempts')
      .executeTakeFirst();
    this.depthCache = null;
    this.breakdownCache = null;
    return row ? Number(row.dispatch_attempts) : null;
  }

  /**
   * Get the full QueuedJob row by ID regardless of status. Used by the
   * dispatcher's redispatch path, which needs runsOnLabels / excludeLabels /
   * resources to pick an agent or consult the scaler for a requeued job.
   */
  async getFullJobById(jobId: string): Promise<QueuedJob | null> {
    const row = await this.db
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirst();
    return row ? this.rowToQueuedJob(row) : null;
  }

  /**
   * Mark a job as dispatched only if it is still in 'recovering' state, and
   * record `agentId` as the durable owner of the reclaimed job.
   * Used when an agent reconnects and claims a recovering job.
   * @returns true if the update affected a row (job was still recovering).
   */
  async markDispatchedIfRecovering(jobId: string, agentId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({
        status: DispatchQueueStatus.Dispatched,
        recovery_deadline: null,
        recovery_agent_id: null,
        ack_deadline: null,
        ack_agent_id: null,
        agent_id: agentId,
      })
      .where('id', '=', jobId)
      .where('status', '=', DispatchQueueStatus.Recovering)
      .execute();
    return (result[0]?.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Get a single job by ID.
   * Used to look up runId during recovery timer setup.
   */
  async getJobById(
    jobId: string,
  ): Promise<{ id: string; runId: string; status: DispatchQueueStatus } | null> {
    const row = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'status'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    return row
      ? { id: row.id, runId: row.run_id, status: row.status as DispatchQueueStatus }
      : null;
  }

  /**
   * HA-safe ownership check. Returns true if the DB shows that
   * `agentId` holds or previously held `jobId` according to any of:
   *
   *   - `status='dispatched'` AND `agent_id = <agent>` — the live
   *     owner of an in-flight job, readable by any coordinator
   *     including one that never saw the dispatch,
   *   - `status='recovering'` AND `recovery_agent_id = <agent>` (so a
   *     replacement coord still recognises in-flight chunks), OR
   *   - the row is already terminal (`completed` / `failed` /
   *     `expired`) — late `log.chunk` chunks from the agent's drain
   *     window are accepted as benign duplicates rather than
   *     rejected.
   *
   * Used by `OwnershipTracker.validateAsync` so a Raft leader switch
   * doesn't turn the next 30s of legitimate per-job chunks into a
   * stream of ownership violations.
   */
  async hasAgentOwnedJob(agentId: string, jobId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('dispatch_queue')
      .select(['status', 'recovery_agent_id', 'agent_id'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) return false;
    const status = row.status as DispatchQueueStatus;
    // A live dispatched row names its owner. A NULL owner (a row dispatched
    // before the column existed) never equals an agent id, so it resolves to
    // false without an explicit guard.
    if (status === DispatchQueueStatus.Dispatched && row.agent_id === agentId) {
      return true;
    }
    if (
      status === DispatchQueueStatus.Recovering &&
      row.recovery_agent_id != null &&
      row.recovery_agent_id === agentId
    ) {
      return true;
    }
    // Terminal rows: accept late chunks from any agent that previously
    // owned the row. The per-coord agentJobs Map is gone, but the
    // chunks were emitted before the agent learned the job was over.
    if (
      status === DispatchQueueStatus.Completed ||
      status === DispatchQueueStatus.Failed ||
      status === DispatchQueueStatus.Expired
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get all jobs matching a given status.
   * Used on startup to find 'dispatched' jobs from a previous instance for recovery.
   */
  async getJobsByStatus(
    status: DispatchQueueStatus,
  ): Promise<
    Array<{ id: string; runId: string; status: DispatchQueueStatus; agentId: string | null }>
  > {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'status', 'agent_id'])
      .where('status', '=', status)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      status: r.status as DispatchQueueStatus,
      agentId: r.agent_id ?? null,
    }));
  }

  /**
   * Shared builder for the non-expired pending rows, oldest-first
   * (`created_at ASC` — the same FIFO ordering as `dequeueForLabels` /
   * `markExpired`). Read-only: no `FOR UPDATE`, no claim. Used by both the
   * unbounded `getPendingJobs` drain and the capped `listPending` re-drive.
   */
  private pendingOldestFirstQuery() {
    return this.db
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('status', '=', DispatchQueueStatus.Pending)
      .where(sql<SqlBool>`(expires_at IS NULL OR expires_at >= now())`)
      .orderBy('created_at', 'asc');
  }

  /**
   * Get all pending jobs in FIFO order (for queue drain on agent connect).
   */
  async getPendingJobs(): Promise<QueuedJob[]> {
    const rows = await this.pendingOldestFirstQuery().execute();
    return rows.map((row) => this.rowToQueuedJob(row));
  }

  /**
   * Read-only oldest-first listing of pending jobs, capped at `limit`.
   *
   * Powers the scaler capacity-freed re-drive (`Dispatcher.retryPendingScaleRequests`):
   * when a scaler agent frees capacity, the oldest jobs that previously got an
   * `at-capacity` verdict are the ones re-offered to `requestScale`. Unlike
   * `dequeueForLabels`, this neither claims nor locks rows — it is a pure read;
   * the re-drive re-runs the normal scale path, which reserves capacity itself.
   */
  async listPending(limit: number): Promise<QueuedJob[]> {
    const rows = await this.pendingOldestFirstQuery().limit(limit).execute();
    return rows.map((row) => this.rowToQueuedJob(row));
  }

  /**
   * Pending, non-expired jobs with the facts the unroutable probe needs:
   * routing selectors, any recorded provisioning error, and the grace clock.
   *
   * Read-only — no claim, no `FOR UPDATE`; the probe never dispatches. Reuses
   * the shared pending query so it inherits the same FIFO ordering and
   * not-yet-expired filter the rest of the queue uses.
   */
  async listUnroutableCandidates(limit: number): Promise<UnroutableCandidate[]> {
    const rows = await this.pendingOldestFirstQuery().limit(limit).execute();
    return rows.map((row) => ({
      ...rowToExpiredJobInfo(row as unknown as ExpiryRowShape),
      unroutableSince: row.unroutable_since ? new Date(row.unroutable_since) : null,
    }));
  }

  /**
   * Stamp the grace clock the first time a job reads unroutable.
   *
   * The `unroutable_since IS NULL` guard is load-bearing, not defensive: the
   * cleanup/probe ticks are NOT leader-gated, so without it two coordinators
   * would each re-stamp `now` on every tick, pushing the deadline outward
   * forever and preventing the grace from ever elapsing.
   */
  async markUnroutableSince(id: string, at: Date): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ unroutable_since: at })
      .where('id', '=', id)
      .where('unroutable_since', 'is', null)
      .execute();
  }

  /** Clear the grace clock after the job reads routable again. */
  async clearUnroutableState(id: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ unroutable_since: null })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Claim a still-pending row for fast-fail, moving it out of the queue.
   *
   * Mirrors {@link markExpired}: the queue row has to leave `Pending` in the
   * same breath the job is terminalized, and for the same two reasons.
   * A row left pending is still dispatchable, so an agent connecting later
   * would pick up a job whose `execution_jobs` row already reads terminal; and
   * the probe re-lists it on every tick, re-running the whole terminalize path
   * (and re-counting the fast-fail metric) until the queue timeout finally
   * expires it.
   *
   * The `status = Pending` guard is also the concurrency arbiter — probe ticks
   * are NOT leader-gated, so exactly one coordinator's UPDATE hits a row and
   * the losers get `false` and move on.
   *
   * @returns true when this call claimed the row, false when it was already
   *   dispatched, cancelled, expired, or claimed by another coordinator.
   */
  async claimUnroutable(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Expired })
      .where('id', '=', id)
      .where('status', '=', DispatchQueueStatus.Pending)
      .executeTakeFirst();
    this.depthCache = null;
    this.breakdownCache = null;
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Convert a DB row to a QueuedJob object.
   * Handles both auto-parsed JSONB arrays (from pg driver) and JSON strings (from tests).
   */
  private rowToQueuedJob(row: DispatchQueueItem): QueuedJob {
    const jobConfig = JSON.parse(row.job_config) as Record<string, unknown>;
    const resources =
      jobConfig.resources && typeof jobConfig.resources === 'object'
        ? (jobConfig.resources as ResourceRequest)
        : undefined;
    return {
      id: row.id,
      runId: row.run_id,
      workflowName: row.workflow_name,
      jobName: row.job_name,
      runsOnLabels: Array.isArray(row.runs_on_labels)
        ? row.runs_on_labels
        : JSON.parse(row.runs_on_labels),
      jobConfig,
      resources,
      repoUrl: row.repo_url,
      ref: row.ref,
      sha: row.sha,
      status: row.status as DispatchQueueStatus,
      createdAt: String(row.created_at),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      deliveryId: row.delivery_id,
      provider: row.provider,
      providerContext:
        typeof row.provider_context === 'string'
          ? JSON.parse(row.provider_context)
          : (row.provider_context ?? {}),
      sourceTarUrl: row.source_tar_url ?? undefined,
      sourceTarHash: row.source_tar_hash ?? undefined,
      depsUrl: row.deps_url ?? undefined,
      depsHash: row.deps_hash ?? undefined,
      requestId: row.request_id ?? undefined,
      excludeLabels:
        typeof row.exclude_labels === 'string'
          ? JSON.parse(row.exclude_labels)
          : Array.isArray(row.exclude_labels)
            ? row.exclude_labels
            : [],
      runsOnPatterns: parseMatcherColumn(row.runs_on_patterns),
      excludePatterns: parseMatcherColumn(row.exclude_patterns),
      routingKey: row.routing_key,
      pinnedAgentId: row.pinned_agent_id ?? undefined,
    };
  }
}

/**
 * Parse a `dispatch_queue` jsonb pattern column into a `LabelMatcher[]`. Handles
 * both the auto-parsed array form (from the pg driver) and the JSON string form
 * (from tests / a non-parsing driver). A missing value yields `[]`.
 *
 * Strict on purpose: this feeds the dispatch path, where an `excludePatterns`
 * that silently degraded to `[]` would let a job run on an agent its `runsOn`
 * excluded. A malformed value must fail the dispatch, not widen it. The expiry
 * sweep uses {@link parseSelectorColumnForExpiry} instead.
 */
function parseMatcherColumn(v: unknown): LabelMatcher[] {
  if (Array.isArray(v)) return v as LabelMatcher[];
  if (typeof v === 'string') return JSON.parse(v) as LabelMatcher[];
  return [];
}

/**
 * Parse a `dispatch_queue` selector column for the **expiry sweep only**, where
 * a malformed value degrades to `[]` rather than throwing.
 *
 * `markExpired` reads these columns *after* it has already flipped the rows to
 * `Expired`, so a throw would strand every job in the batch: their
 * `execution_jobs` rows never settle and the runs never complete — the same
 * false-not-done the `unroutable` status exists to prevent. Nothing is
 * dispatched off this value; the only cost of degrading is that the job settles
 * `timed_out_stale` instead of `unroutable`.
 */
function parseSelectorColumnForExpiry<T>(v: unknown, column: string): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed as T[];
      logger.warn('dispatch_queue selector column is not a JSON array', { column });
    } catch {
      logger.warn('dispatch_queue selector column holds malformed JSON', { column });
    }
  }
  return [];
}

/**
 * Whether an agent's label set satisfies a job's regex matchers: every
 * `runsOnPatterns` matcher must match some label AND no `excludePatterns`
 * matcher may match any label. The single matching authority is the engine's
 * `matcherSatisfiedBy` (JS RegExp) — never a Postgres `~`.
 */
function jobPatternsSatisfiedBy(job: QueuedJob, labels: ReadonlySet<string>): boolean {
  if (!job.runsOnPatterns.every((p) => matcherSatisfiedBy(p, labels))) return false;
  if (job.excludePatterns.some((p) => matcherSatisfiedBy(p, labels))) return false;
  return true;
}
