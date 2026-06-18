import { randomUUID } from 'node:crypto';
import { type Kysely, type SqlBool, sql } from 'kysely';
import { type LabelMatcher, matcherSatisfiedBy, type ResourceRequest } from '@kici-dev/engine';
import type { Database, DispatchQueueItem } from '../db/types.js';

/** Info about an expired dispatch_queue entry, returned by markExpired(). */
export interface ExpiredJobInfo {
  /** dispatch_queue row ID */
  id: string;
  runId: string;
  jobName: string;
  /** Most recent scaler spawn-failure detail, if any was recorded. */
  lastProvisioningError: string | null;
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
  private readonly maxDepth: number;
  private readonly defaultTimeoutMs: number;
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

  constructor(db: Kysely<Database>, options: { maxDepth: number; defaultTimeoutMs: number }) {
    this.db = db;
    this.maxDepth = options.maxDepth;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  /**
   * Enqueue a job. Checks depth first, rejects with 'queue full' if >= maxDepth.
   * @returns The generated job ID.
   */
  async enqueue(job: QueuedJobInput): Promise<string> {
    const depth = await this.getDepth();
    if (depth >= this.maxDepth) {
      throw new Error('queue full');
    }

    const id = job.jobId ?? randomUUID();
    const now = new Date().toISOString();
    const timeoutMs = job.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null;

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
    // Fast path: pattern-free rows, single-row atomic claim (the 99% hot path,
    // unchanged from the pure-exact behavior — the SELECT FOR UPDATE row is
    // returned pending and the caller transitions it via markDispatched).
    const fast = await this.claimPatternFree(agentLabels, agentMandatoryLabels, agentId);
    if (fast) return fast;
    // Pattern path: rows carrying regex matchers, JS post-filter via the engine's
    // matcherSatisfiedBy (the single matching authority — never a Postgres ~).
    return this.claimWithPatterns(agentLabels, agentMandatoryLabels, agentId);
  }

  /**
   * Build the shared drain WHERE chain (status / expiry / exact-label @> /
   * exclude-label / pin / mandatory-label gate) common to both drain passes.
   * The pattern columns are NOT filtered here — each pass adds its own
   * pattern-free / pattern-bearing guard on top.
   */
  private drainBaseQuery(agentLabels: string[], agentMandatoryLabels: string[], agentId?: string) {
    const agentLabelsJson = JSON.stringify(agentLabels);
    const mandatoryLabelsJson = JSON.stringify(agentMandatoryLabels);
    let query = this.db
      .selectFrom('dispatch_queue')
      .selectAll()
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
   * pass to rows that need no JS post-filter, so the single-row atomic claim
   * (FOR UPDATE SKIP LOCKED) keeps the original hot-path semantics intact.
   */
  private async claimPatternFree(
    agentLabels: string[],
    agentMandatoryLabels: string[],
    agentId?: string,
  ): Promise<QueuedJob | null> {
    const row = await this.drainBaseQuery(agentLabels, agentMandatoryLabels, agentId)
      .where(sql<SqlBool>`runs_on_patterns = '[]'::jsonb AND exclude_patterns = '[]'::jsonb`)
      .orderBy('created_at', 'asc')
      .limit(1)
      .forUpdate()
      .skipLocked()
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
   */
  private async claimWithPatterns(
    agentLabels: string[],
    agentMandatoryLabels: string[],
    agentId?: string,
  ): Promise<QueuedJob | null> {
    const labelSet = new Set(agentLabels);
    const rows = await this.drainBaseQuery(agentLabels, agentMandatoryLabels, agentId)
      .where(sql<SqlBool>`(runs_on_patterns <> '[]'::jsonb OR exclude_patterns <> '[]'::jsonb)`)
      .orderBy('created_at', 'asc')
      .limit(10)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const row of rows) {
      const job = this.rowToQueuedJob(row);
      if (!jobPatternsSatisfiedBy(job, labelSet)) continue;
      const claimed = await this.db
        .updateTable('dispatch_queue')
        .set({ status: DispatchQueueStatus.Dispatched })
        .where('id', '=', row.id)
        .where('status', '=', DispatchQueueStatus.Pending)
        .executeTakeFirst();
      // Another agent may have won the conditional claim; only return on success.
      if ((claimed.numUpdatedRows ?? 0n) > 0n) return job;
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
   * requirements are no longer satisfied by the agent, or the agent's gate
   * is not satisfied by the job's `runsOn`.
   */
  async dequeueById(
    jobId: string,
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
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
    return job;
  }

  /**
   * Insert a job directly with status='dispatched' (bypasses the queue).
   * Used when an agent is immediately available and the job doesn't need to wait.
   * @returns The generated job ID.
   */
  async insertDispatched(job: QueuedJobInput): Promise<string> {
    const id = job.jobId ?? randomUUID();
    const now = new Date().toISOString();

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
      })
      .execute();

    return id;
  }

  /**
   * Mark a job as dispatched.
   *
   * Note: agentId is not persisted in the dispatch_queue table.
   * The dispatcher tracks agent-to-job mappings in memory (agentJobs Map).
   * The dispatch_queue is a transient routing table, not the execution record.
   */
  async markDispatched(jobId: string, _agentId: string): Promise<void> {
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Dispatched, last_provisioning_error: null })
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
      .select(['id', 'run_id', 'job_name', 'last_provisioning_error'])
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

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      jobName: r.job_name,
      lastProvisioningError: r.last_provisioning_error ?? null,
    }));
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
   * Mark a job as dispatched only if it is still in 'recovering' state.
   * Used when an agent reconnects and claims a recovering job.
   * @returns true if the update affected a row (job was still recovering).
   */
  async markDispatchedIfRecovering(jobId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('dispatch_queue')
      .set({
        status: DispatchQueueStatus.Dispatched,
        recovery_deadline: null,
        recovery_agent_id: null,
        ack_deadline: null,
        ack_agent_id: null,
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
   * `agentId` previously held `jobId` according to any of:
   *
   *   - `status='dispatched'` AND the registry-managed bookkeeping
   *     records the agent assignment (caller-side `agentJobs` map),
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
      .select(['status', 'recovery_agent_id'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) return false;
    const status = row.status as DispatchQueueStatus;
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
  ): Promise<Array<{ id: string; runId: string; status: DispatchQueueStatus }>> {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .select(['id', 'run_id', 'status'])
      .where('status', '=', status)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      status: r.status as DispatchQueueStatus,
    }));
  }

  /**
   * Get all pending jobs in FIFO order (for queue drain on agent connect).
   */
  async getPendingJobs(): Promise<QueuedJob[]> {
    const rows = await this.db
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('status', '=', DispatchQueueStatus.Pending)
      .where(sql<SqlBool>`(expires_at IS NULL OR expires_at >= now())`)
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row) => this.rowToQueuedJob(row));
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
 * (from tests / a non-parsing driver). A missing / malformed value yields `[]`.
 */
function parseMatcherColumn(v: unknown): LabelMatcher[] {
  if (Array.isArray(v)) return v as LabelMatcher[];
  if (typeof v === 'string') return JSON.parse(v) as LabelMatcher[];
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
