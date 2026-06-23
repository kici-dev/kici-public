/**
 * Dashboard handler for the orchestrator.
 *
 * Responds to dashboard.* and run.* WS messages from Platform by querying the local
 * execution_jobs and execution_steps tables and reading logs from LogStorage.
 *
 * Supported messages:
 * - dashboard.run.detail: returns jobs with nested steps for a run
 * - dashboard.step.logs: returns log lines for a specific step
 * - dashboard.payload: returns the original webhook payload for a run
 * - run.rerun.request: re-runs a completed workflow run
 * - run.cancel.request: cancels a running workflow run
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ActorPrincipal,
  DashboardRunDetailRequest,
  DashboardRunsListRequest,
  DashboardRunsListResponse,
  DashboardRunsFiltersRequest,
  DashboardRunsFiltersResponse,
  DashboardRunSummary,
  DashboardSourcesListRequest,
  DashboardSourcesListResponse,
  DashboardStepLogsRequest,
  DashboardAttestationsListRequest,
  AttestationListItem,
  DashboardPayloadRequest,
  DashboardOrchLogsRequest,
  DashboardEventLogListRequest,
  DashboardEventLogDetailRequest,
  DashboardEventLogPayloadStreamRequest,
  DashboardAccessLogListRequest,
  DashboardEventDlqListRequest,
  DashboardEventDlqCountRequest,
  DashboardEventDlqRetryRequest,
  DashboardEventDlqDiscardRequest,
  DashboardEventDlqListItem,
  EventLogListItem,
  InitFailure,
  RunRerunRequest,
  RunCancelRequest,
  ManualScheduleRequest,
} from '@kici-dev/engine';
import {
  AccessLogAction as AccessLogActionEnum,
  dashboardRunDetailApiResponseSchema,
  dashboardStepLogsApiResponseSchema,
  dashboardAttestationsListResponseSchema,
  stringifyActor,
  EventLogStatus,
  EventLogSource,
  PayloadOmittedReason,
  EVENT_LOG_PAYLOAD_CHUNK_BYTES,
  EventLogPayloadStreamError,
} from '@kici-dev/engine';
import { gunzipSync } from 'node:zlib';
import type { Database } from '../db/types.js';
import { groupNeedsByJobName } from './needs-edges.js';
import type { LogStorage } from '../reporting/log-storage.js';
import type { CacheStorage } from '../storage/types.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { EventStore } from '../events/event-store.js';
import { loadEventLogByDeliveryId } from '../cold-store/load-event-log-range.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';

const logger = createLogger({ prefix: 'dashboard-handler' });

interface DashboardHandlerDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
  /**
   * Object-storage backend for provenance bundles. The attestations handler
   * reads each stored bundle by `storage_key` and inlines it into the response
   * so the dashboard verifies it client-side without a second fetch. Optional —
   * when absent (e.g. orchestrators without provenance configured) the handler
   * replies with an `error` and an empty list. Reuses the cache storage backend
   * (the same one P1.5 writes bundles to).
   */
  provenanceStorage?: CacheStorage | null;
  /** Send a response message back to Platform over the WS connection. */
  send: (msg: unknown) => void;
  /** This orchestrator's instance ID, included in job detail responses. */
  orchestratorId?: string;
  /** Access log writer — records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Org ID for access_log rows (null when the orchestrator isn't org-scoped). */
  orgId?: string | null;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
  /**
   * Long-lived cold-store handle for read fallback. When set, run /
   * job / step lookups fall through to S3 if the row has aged out of
   * PG. `null` means the orchestrator is running without cold-store
   * configured — handler then returns its pre-Phase-C behavior.
   */
  coldStore?: ColdStore | null;
  /**
   * Callback for handling re-run requests.
   * Returns { newRunId } on success or throws on failure.
   *
   * Phase F — `routingKey` is forwarded from the Platform (read from
   * Platform's denormalized `execution_runs.routing_key`) so the
   * orchestrator can probe its cold-store under the right tenant
   * prefix when the run row is missing from PG. Optional for back-
   * compat with mixed deploys; absent means the orchestrator falls
   * back to the legacy "no PG row → throw" path.
   */
  onRerun: (
    runId: string,
    triggeredBy: string | null,
    routingKey?: string,
  ) => Promise<{ newRunId: string }>;
  /**
   * Callback for handling cancel requests.
   * Returns { cancelledJobs } on success or throws on failure.
   * The force flag indicates whether to force-cancel (SIGKILL, skip hooks).
   */
  onCancel: (
    runId: string,
    cancelledBy: string | null,
    force?: boolean,
  ) => Promise<{ cancelledJobs: number }>;
  /**
   * Callback for handling manual schedule trigger requests.
   * Returns { newRunId } on success or throws on failure.
   */
  onManualSchedule: (
    registrationId: string,
    triggeredBy: string | null,
  ) => Promise<{ newRunId: string }>;
  /**
   * Event store for the per-org DLQ surface. Optional — when absent the
   * `handleEventDlq*` methods reply with a structured `error` so the
   * dashboard renders an empty-state without crashing. In real
   * deployments the store is wired by `bootstrapOrchestrator`.
   */
  eventStore?: EventStore | null;
}

/** A run-detail step row as queried by handleRunDetail (warm + cold paths). */
interface RunDetailStepRow {
  step_index: number;
  step_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  exit_code: number | null;
  error_message: string | null;
  step_type: string;
  secrets_accessed: string | null;
  check_outcome: string | null;
  drift_summary: string | null;
}

/** Map a step row to the dashboard run-detail step shape. */
function mapRunDetailStep(step: RunDetailStepRow) {
  return {
    stepIndex: step.step_index,
    stepName: step.step_name,
    status: step.status,
    startedAt: step.started_at ? step.started_at.getTime() : null,
    completedAt: step.completed_at ? step.completed_at.getTime() : null,
    durationMs: step.duration_ms ?? null,
    exitCode: step.exit_code ?? null,
    errorMessage: step.error_message ?? null,
    ...(step.step_type !== 'step' && { stepType: step.step_type }),
    secretsAccessed: step.secrets_accessed ?? null,
    ...(step.check_outcome != null && { checkOutcome: step.check_outcome }),
    ...(step.drift_summary != null && { driftSummary: step.drift_summary }),
  };
}

/** A run-detail job row as queried by handleRunDetail (warm + cold paths). */
interface RunDetailJobRow {
  job_id: string;
  job_name: string;
  status: string;
  matrix_values: unknown;
  base_job_name: string | null;
  variant_kind: string | null;
  variant_label: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  agent_id: string | null;
  error_message: string | null;
  runs_on_labels: unknown;
  outputs: unknown;
  init_failure: unknown;
}

/** Lookups threaded into {@link buildRunDetailJobs} from the per-run batch queries. */
interface RunDetailJobLookups {
  stepsByJob: Map<string, RunDetailStepRow[]>;
  secretKeysByJob: Map<string, string[]>;
  needsByJob: Map<string, Array<{ upstreamName: string; ifFailed: 'skip' | 'run' }>>;
}

/** Map queried job + step rows into the dashboard run-detail job DTO shape. */
function buildRunDetailJobs(jobs: RunDetailJobRow[], lookups: RunDetailJobLookups) {
  const { stepsByJob, secretKeysByJob, needsByJob } = lookups;
  return jobs.map((job) => {
    const jobSteps = stepsByJob.get(job.job_id) ?? [];
    const jobInitFailure = (job.init_failure as InitFailure | null) ?? undefined;
    return {
      jobId: job.job_id,
      jobName: job.job_name,
      status: job.status,
      matrixValues: (job.matrix_values as Record<string, unknown> | null) ?? null,
      baseJobName: job.base_job_name ?? null,
      variantKind: job.variant_kind ?? null,
      variantLabel: job.variant_label ?? null,
      startedAt: job.started_at ? job.started_at.getTime() : null,
      completedAt: job.completed_at ? job.completed_at.getTime() : null,
      durationMs: job.duration_ms ?? null,
      agentId: job.agent_id ?? null,
      orchestratorId: null,
      errorMessage: job.error_message ?? null,
      runsOnLabels: (job.runs_on_labels as string[] | null) ?? null,
      outputs: job.outputs
        ? typeof job.outputs === 'string'
          ? JSON.parse(job.outputs)
          : job.outputs
        : null,
      secretOutputKeys: secretKeysByJob.get(job.job_id) ?? null,
      ...(jobInitFailure && { initFailure: jobInitFailure }),
      needs: needsByJob.get(job.job_name) ?? null,
      steps: jobSteps.map(mapRunDetailStep),
    };
  });
}

export class DashboardHandler {
  private readonly db: Kysely<Database>;
  private readonly logStorage: LogStorage;
  private readonly provenanceStorage: CacheStorage | null;
  private readonly send: (msg: unknown) => void;
  private readonly orchestratorId: string | undefined;
  private readonly accessLog: AccessLogWriter | undefined;
  private orgId: string | null;
  private routingKey: string | null;
  private readonly onRerun: DashboardHandlerDeps['onRerun'];
  private readonly onCancel: DashboardHandlerDeps['onCancel'];
  private readonly onManualSchedule: DashboardHandlerDeps['onManualSchedule'];
  private readonly coldStore: ColdStore | null;
  private readonly eventStore: EventStore | null;

  constructor(deps: DashboardHandlerDeps) {
    this.db = deps.db;
    this.logStorage = deps.logStorage;
    this.provenanceStorage = deps.provenanceStorage ?? null;
    this.send = deps.send;
    this.orchestratorId = deps.orchestratorId;
    this.accessLog = deps.accessLog;
    this.orgId = deps.orgId ?? null;
    this.routingKey = deps.routingKey ?? null;
    this.onRerun = deps.onRerun;
    this.onCancel = deps.onCancel;
    this.onManualSchedule = deps.onManualSchedule;
    this.coldStore = deps.coldStore ?? null;
    this.eventStore = deps.eventStore ?? null;
  }

  /**
   * Update the bound orgId + routingKey. Called from server.ts after resolving
   * the single tenant org from the `sources` / `generic_webhook_sources` table.
   *
   * NOTE: this binding is the **fallback** for `recordAccess`. Run-targeted
   * handlers resolve the run-owning org per-request via `resolveOrgForRun`;
   * the bound pair is consulted only when the per-target lookup yields no
   * result (e.g. cold-archived run, deleted source). On a multi-tenant
   * orchestrator the bound pair is non-deterministic (server.ts:937-955
   * picks the first row from a `LIMIT 1` query with no `ORDER BY`), so it
   * MUST NOT be the source of truth for `access_log.org_id`.
   */
  setOrgContext(orgId: string | null, routingKey: string | null): void {
    this.orgId = orgId;
    this.routingKey = routingKey;
  }

  /**
   * Resolve the run-owning org from `execution_runs.routing_key` plus a
   * sources/generic_webhook_sources lookup on that routing key. Returns
   * `null` when the run row is missing (e.g. cold-archived) so the caller
   * can fall back to the handler-bound context.
   *
   * Returns `{ orgId, routingKey }` where either field can be null:
   * - `routingKey` is non-null whenever the PG run row was found, even if
   *   the source row has since been deleted (best-effort attribution).
   * - `orgId` is null only when the routing key has no matching source row.
   */
  private async resolveOrgForRun(
    runId: string,
  ): Promise<{ orgId: string | null; routingKey: string | null } | null> {
    const run = await this.db
      .selectFrom('execution_runs')
      .select(['routing_key'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!run?.routing_key) return null;
    return this.resolveOrgForRoutingKey(run.routing_key);
  }

  /**
   * Resolve the org owning a routing key by consulting both source tables
   * (GitHub-app `sources` first, then `generic_webhook_sources`). Used
   * directly for `handleRerunRequest` (which gets a `routingKey` hint from
   * Platform — Phase F denormalization) and indirectly via
   * `resolveOrgForRun`.
   */
  private async resolveOrgForRoutingKey(
    routingKey: string,
  ): Promise<{ orgId: string | null; routingKey: string | null }> {
    const ghSrc = await this.db
      .selectFrom('sources')
      .select(['customer_id'])
      .where('routing_key', '=', routingKey)
      .executeTakeFirst();
    if (ghSrc?.customer_id) return { orgId: ghSrc.customer_id, routingKey };

    const genSrc = await this.db
      .selectFrom('generic_webhook_sources')
      .select(['customer_id'])
      .where('routing_key', '=', routingKey)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (genSrc?.customer_id) return { orgId: genSrc.customer_id, routingKey };

    // Routing key found but no source row matches (deleted source) —
    // best-effort attribution: keep the routing key, leave orgId null so
    // `contextOrFallback` can substitute the bound orgId.
    return { orgId: null, routingKey };
  }

  /**
   * Resolve the org from a `workflow_registrations` row. Returns null when
   * the registration is missing (caller falls back to bound context).
   */
  private async resolveOrgForRegistration(
    registrationId: string,
  ): Promise<{ orgId: string | null; routingKey: string | null } | null> {
    const reg = await this.db
      .selectFrom('workflow_registrations')
      .select(['customer_id', 'routing_key'])
      .where('id', '=', registrationId)
      .executeTakeFirst();
    if (!reg) return null;
    return { orgId: reg.customer_id, routingKey: reg.routing_key };
  }

  /**
   * Apply a per-target resolution result, falling back to the handler-bound
   * orgId / routingKey when the resolution is null or its individual fields
   * are null. This is the merge point that makes the bound context a
   * fallback rather than the source of truth.
   */
  private contextOrFallback(resolved: { orgId: string | null; routingKey: string | null } | null): {
    orgId: string | null;
    routingKey: string | null;
  } {
    if (resolved && (resolved.orgId !== null || resolved.routingKey !== null)) {
      return {
        orgId: resolved.orgId ?? this.orgId,
        routingKey: resolved.routingKey ?? this.routingKey,
      };
    }
    return { orgId: this.orgId, routingKey: this.routingKey };
  }

  /**
   * Defense-in-depth dashboard-write policy gate for the DLQ handlers.
   * Returns true when allowed; false (with a `denied` access_log row and
   * an `operation_disabled` envelope on the wire) when the orch policy
   * has the operation switched off.
   */
  private async enforcePolicy(
    msg: { actor: ActorPrincipal; requestId: string; orgId: string },
    op: DashboardWriteOperation,
    responseType: string,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
    ctx: { orgId: string | null; routingKey: string | null },
  ): Promise<boolean> {
    try {
      await assertDashboardWriteAllowed(this.db, msg.orgId, op);
      return true;
    } catch (err) {
      if (err instanceof DashboardWritePolicyDisabledError) {
        this.recordAccess(
          ctx,
          msg.actor,
          action,
          target,
          msg.requestId,
          'denied',
          `operation_disabled:${err.operation}`,
        );
        this.send(buildPolicyDeniedResponse(op, responseType, msg.requestId));
        return false;
      }
      throw err;
    }
  }

  /**
   * Write an access_log row for a handler invocation. The caller resolves
   * the run-owning org via `resolveOrgForRun` (or the registration / event-
   * log equivalents) and threads it in here so each row carries the org
   * that owns the target — not the handler-bound (multi-tenant: non-
   * deterministic) pair. Best-effort; the writer swallows failures.
   */
  private recordAccess(
    ctx: { orgId: string | null; routingKey: string | null },
    actor: ActorPrincipal,
    action: AccessLogAction,
    target: { type: AccessLogTargetType; id: string } | null,
    requestId: string | null,
    outcome: AccessLogOutcome,
    errorMessage?: string | null,
  ): void {
    if (!this.accessLog) return;
    void this.accessLog.record({
      orgId: ctx.orgId,
      routingKey: ctx.routingKey,
      actor,
      action,
      target,
      requestId,
      source: 'platform_proxy',
      outcome,
      errorMessage: errorMessage ?? null,
    });
  }

  /**
   * Handle a dashboard.run.detail request.
   * Queries execution_jobs and execution_steps for the given runId,
   * builds a nested job/step tree, and sends the response.
   */
  async handleRunDetail(msg: DashboardRunDetailRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      // Query trust context + run-scoped init_failure from execution_runs
      // (trust context is populated for PR-triggered runs; init_failure is
      // populated for runs that never executed a step).
      let runRow:
        | {
            trust_tier: string | null;
            lock_file_source: string | null;
            contributor_username: string | null;
            init_failure: InitFailure | null;
            check_mode: string | null;
          }
        | undefined = await this.db
        .selectFrom('execution_runs')
        .select([
          'trust_tier',
          'lock_file_source',
          'contributor_username',
          'init_failure',
          'check_mode',
        ])
        .where('run_id', '=', msg.runId)
        .executeTakeFirst();

      // Query all jobs for this run
      let jobs = await this.db
        .selectFrom('execution_jobs')
        .select([
          'job_id',
          'job_name',
          'status',
          'matrix_values',
          'base_job_name',
          'variant_kind',
          'variant_label',
          'agent_id',
          'started_at',
          'completed_at',
          'duration_ms',
          'error_message',
          'runs_on_labels',
          'outputs',
          'init_failure',
        ])
        .where('run_id', '=', msg.runId)
        .orderBy('created_at', 'asc')
        .execute();

      // Query all steps for this run in one query (more efficient than per-job)
      let steps = await this.db
        .selectFrom('execution_steps')
        .select([
          'job_id',
          'step_index',
          'step_name',
          'status',
          'started_at',
          'completed_at',
          'duration_ms',
          'exit_code',
          'error_message',
          'step_type',
          'secrets_accessed',
          'check_outcome',
          'drift_summary',
        ])
        .where('run_id', '=', msg.runId)
        .orderBy('step_index', 'asc')
        .execute();

      // Phase C: cold-store fallback. If PG has 0 jobs, the run was
      // archived (jobs + steps moved to S3 in the same archive cycle).
      // Pull the chunk rows back to populate the response so the
      // dashboard run-detail page works for any run the orchestrator
      // has ever owned. Run-row trust context is best-effort —
      // archived runs may have had null values anyway.
      if (jobs.length === 0 && this.coldStore && this.routingKey) {
        const cold = await this.fetchArchivedRunDetail(this.routingKey, msg.runId);
        if (cold.run && !runRow) runRow = cold.run;
        if (cold.jobs.length > 0) jobs = cold.jobs as typeof jobs;
        if (cold.steps.length > 0) steps = cold.steps as typeof steps;
      }

      // Query secret output key names per job (values are NOT sent to dashboard)
      const secretOutputRows = await this.db
        .selectFrom('run_secret_outputs')
        .select(['job_id', 'output_key'])
        .where('run_id', '=', msg.runId)
        .execute();

      // Group secret output keys by job_id
      const secretKeysByJob = new Map<string, string[]>();
      for (const row of secretOutputRows) {
        let keys = secretKeysByJob.get(row.job_id);
        if (!keys) {
          keys = [];
          secretKeysByJob.set(row.job_id, keys);
        }
        keys.push(row.output_key);
      }

      // Group steps by job_id
      const stepsByJob = new Map<string, typeof steps>();
      for (const step of steps) {
        let jobSteps = stepsByJob.get(step.job_id);
        if (!jobSteps) {
          jobSteps = [];
          stepsByJob.set(step.job_id, jobSteps);
        }
        jobSteps.push(step);
      }

      // Query dependency edges for the whole run in one batch (keyed by
      // downstream job_name). These are the resolved edges the needs-scheduler
      // enforced — dynamic-group edges are already concrete job-name edges here.
      const needsRows = await this.db
        .selectFrom('execution_job_needs')
        .select(['job_name', 'upstream_name', 'if_failed'])
        .where('run_id', '=', msg.runId)
        .execute();
      const needsByJob = groupNeedsByJobName(needsRows);

      // Build response
      const responseJobs = buildRunDetailJobs(jobs, {
        stepsByJob,
        secretKeysByJob,
        needsByJob,
      });

      // Build trust context if available (PR-triggered runs)
      const trustContext =
        runRow?.trust_tier || runRow?.lock_file_source || runRow?.contributor_username
          ? {
              trustTier: (runRow.trust_tier as 'trusted' | 'known' | 'unknown' | null) ?? null,
              lockFileSource: (runRow.lock_file_source as 'head' | 'base' | null) ?? null,
              contributorUsername: runRow.contributor_username ?? null,
            }
          : undefined;

      // Run-scoped init failure — set when the run never executed a step
      // (e.g. lock-file fetch failed, build coordination failed). The
      // dashboard renders a banner explaining the reason.
      const runInitFailure = (runRow?.init_failure as InitFailure | null) ?? undefined;

      // Validate outgoing response against engine schema (double validation)
      const validated = dashboardRunDetailApiResponseSchema.safeParse({
        jobs: responseJobs,
        ...(trustContext && { trustContext }),
        ...(runInitFailure && { initFailure: runInitFailure }),
        ...(runRow?.check_mode != null && { checkMode: runRow.check_mode }),
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.run.detail response validation failed', {
          runId: msg.runId,
          errors: validated.error.issues,
        });
        this.recordAccess(
          ctx,
          msg.actor,
          'run.detail.read',
          { type: 'run', id: msg.runId },
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.run.detail.response',
          requestId: msg.requestId,
          jobs: [],
          error: 'Internal error: response validation failed',
        });
        return;
      }

      this.recordAccess(
        ctx,
        msg.actor,
        'run.detail.read',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.run.detail.response',
        requestId: msg.requestId,
        jobs: validated.data.jobs,
        ...(validated.data.trustContext && { trustContext: validated.data.trustContext }),
        ...(validated.data.initFailure && { initFailure: validated.data.initFailure }),
        ...(validated.data.checkMode != null && { checkMode: validated.data.checkMode }),
      });
    } catch (err) {
      logger.error('Error handling dashboard.run.detail', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'run.detail.read',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.run.detail.response',
        requestId: msg.requestId,
        jobs: [],
        error: 'Internal error querying run detail',
      });
    }
  }

  /**
   * Resolve every routing key owned by an org by unioning both source
   * tables. The orchestrator is single-org but multi-routing-key: one org
   * owns one GitHub-app source plus N generic sources, each with its own
   * `routing_key`. `execution_runs` has no `org_id` column — org ownership
   * is expressed purely through `routing_key → sources.customer_id` /
   * `generic_webhook_sources.customer_id`, so scoping a run query to an org
   * means scoping it to the union of that org's routing keys.
   *
   * Predicates mirror the org-context resolver in `server.ts` and
   * `resolveOrgForRoutingKey` above:
   * - `sources`: `customer_id = orgId` excluding the `__default__` sentinel.
   * - `generic_webhook_sources`: `customer_id = orgId` and not soft-deleted
   *   (`deleted_at is null`).
   */
  private async resolveOrgRoutingKeys(orgId: string): Promise<string[]> {
    const ghRows = await this.db
      .selectFrom('sources')
      .select('routing_key')
      .where('customer_id', '=', orgId)
      .where('customer_id', '!=', '__default__')
      .execute();

    const genRows = await this.db
      .selectFrom('generic_webhook_sources')
      .select('routing_key')
      .where('customer_id', '=', orgId)
      .where('deleted_at', 'is', null)
      .execute();

    const keys = new Set<string>();
    for (const r of ghRows) if (r.routing_key) keys.add(r.routing_key);
    for (const r of genRows) if (r.routing_key) keys.add(r.routing_key);
    return [...keys];
  }

  /**
   * Resolve a per-routing-key source identity map for a set of routing keys,
   * unioning both source tables. Uses the identical name/subtype/provider
   * derivation as `handleSourcesList` so a run summary's `source` block
   * matches what the sources page shows for the same routing key. Routing
   * keys with no live source row are simply absent from the map (the caller
   * falls back to the run's own provider).
   */
  private async resolveSourceIdentities(
    routingKeys: string[],
  ): Promise<Map<string, { name: string | null; subtype: string; provider: string }>> {
    const map = new Map<string, { name: string | null; subtype: string; provider: string }>();
    if (routingKeys.length === 0) return map;

    const ghRows = await this.db
      .selectFrom('sources')
      .select(['routing_key', 'name', 'provider'])
      .where('routing_key', 'in', routingKeys)
      .execute();
    for (const r of ghRows) {
      map.set(r.routing_key, { name: r.name ?? null, provider: r.provider, subtype: 'github_app' });
    }

    const genRows = await this.db
      .selectFrom('generic_webhook_sources')
      .select(['routing_key', 'name', 'provider_type', 'git_config'])
      .where('routing_key', 'in', routingKeys)
      .where('deleted_at', 'is', null)
      .execute();
    for (const r of genRows) {
      map.set(r.routing_key, {
        name: r.name ?? null,
        provider: r.provider_type === 'local' ? 'local' : 'generic',
        subtype:
          r.provider_type === 'local'
            ? 'local'
            : r.git_config
              ? 'universal_git'
              : 'generic_webhook',
      });
    }

    return map;
  }

  /**
   * Look up the page's jobs in one query to derive per-run `jobCount` plus the
   * compile-job markers (`hadCompileJob` / `compileJobId`). The compile job is
   * the synthetic `__build__*` job KiCI inserts for the compile phase — the
   * same definition the Platform run-list route uses
   * (`job_name LIKE '__build__%'`). Returns a per-run aggregate keyed by
   * `run_id`; runs with no job rows are absent (the caller omits the fields).
   */
  private async resolveRunJobAggregates(
    runIds: string[],
  ): Promise<Map<string, { jobCount: number; compileJobId: string | null }>> {
    const map = new Map<string, { jobCount: number; compileJobId: string | null }>();
    if (runIds.length === 0) return map;

    const jobRows = await this.db
      .selectFrom('execution_jobs')
      .select(['run_id', 'job_id', 'job_name'])
      .where('run_id', 'in', runIds)
      .execute();

    for (const j of jobRows) {
      let agg = map.get(j.run_id);
      if (!agg) {
        agg = { jobCount: 0, compileJobId: null };
        map.set(j.run_id, agg);
      }
      agg.jobCount += 1;
      // The synthetic compile job (`__build__*`) is the build phase; surface
      // its id so the page can render the compile-step link, matching the
      // Platform run-list route's `job_name LIKE '__build__%'` definition.
      if (j.job_name.startsWith('__build__') && !agg.compileJobId) {
        agg.compileJobId = j.job_id;
      }
    }

    return map;
  }

  /**
   * Handle a dashboard.runs.list request.
   *
   * Returns a page of run summaries from `execution_runs`, scoped to ALL
   * routing keys owned by this orchestrator's bound org (`this.orgId`). The
   * orchestrator is single-org but multi-routing-key, and the bound
   * `this.routingKey` is just ONE of the org's keys (resolved
   * non-deterministically at startup), so filtering on it alone would drop
   * runs that arrived under a sibling routing key. We resolve the org's full
   * routing-key set from `sources` + `generic_webhook_sources` and filter on
   * the union. Attribution still uses the handler-bound `orgId` /
   * `routingKey` directly — the same inline-ctx pattern as the org-scoped
   * event-log / access-log handlers.
   *
   * Used by the operator console (`support-read` break-glass) and the
   * dashboard's run-list view. The access_log row carries the wire actor
   * (including the platform_operator reason) so the customer can audit any
   * operator read.
   */
  async handleRunsList(msg: DashboardRunsListRequest): Promise<DashboardRunsListResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    try {
      const limit = Math.min(Math.max(msg.limit ?? 50, 1), 200);

      // Unbound orchestrator (no org resolved yet) — nothing to scope to.
      if (!this.orgId) {
        this.recordAccess(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['runs.list.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return {
          type: 'dashboard.runs.list.response',
          requestId: msg.requestId,
          runs: [],
        };
      }

      // Scope by the union of the org's routing keys. An empty set means the
      // org owns no (live) sources — return an empty page rather than running
      // an unbounded query.
      const routingKeys = await this.resolveOrgRoutingKeys(this.orgId);
      if (routingKeys.length === 0) {
        this.recordAccess(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['runs.list.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return {
          type: 'dashboard.runs.list.response',
          requestId: msg.requestId,
          runs: [],
        };
      }

      let query = this.db
        .selectFrom('execution_runs')
        .select([
          'run_id',
          'routing_key',
          'repo_identifier',
          'status',
          'created_at',
          'completed_at',
          'workflow_name',
          'provider',
          'ref',
          'sha',
          'started_at',
          'duration_ms',
          'parent_run_id',
          'original_run_id',
          'triggered_by',
          'cancelled_by',
          'failure_reason',
        ])
        .where('routing_key', 'in', routingKeys);

      // Cursor: { createdAt: ISO, runId }. Stable on the (created_at, run_id) pair.
      if (msg.cursor) {
        const cur = decodeRunsCursor(msg.cursor);
        if (cur) {
          query = query.where((eb) =>
            eb.or([
              eb('created_at', '<', new Date(cur.createdAt)),
              eb.and([
                eb('created_at', '=', new Date(cur.createdAt)),
                eb('run_id', '<', cur.runId),
              ]),
            ]),
          );
        }
      }

      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('run_id', 'desc')
        .limit(limit + 1) // fetch one extra to detect "has more"
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      // Enrichment lookups for the page: per-run job aggregates (jobCount +
      // compile-job markers) and per-routing-key source identities. Skipped
      // when the page is empty so no needless query is issued.
      const pageRunIds = pageRows.map((r) => r.run_id);
      const pageRoutingKeys = [
        ...new Set(pageRows.map((r) => r.routing_key).filter((k): k is string => !!k)),
      ];
      const [jobAggregates, sourceIdentities] =
        pageRunIds.length > 0
          ? await Promise.all([
              this.resolveRunJobAggregates(pageRunIds),
              this.resolveSourceIdentities(pageRoutingKeys),
            ])
          : [
              new Map<string, { jobCount: number; compileJobId: string | null }>(),
              new Map<string, { name: string | null; subtype: string; provider: string }>(),
            ];

      const runs = pageRows.map((r) => mapRunSummary(r, jobAggregates, sourceIdentities));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow
          ? encodeRunsCursor({ createdAt: lastRow.created_at.toISOString(), runId: lastRow.run_id })
          : undefined;

      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['runs.list.read'],
        null,
        msg.requestId,
        'allowed',
      );
      return {
        type: 'dashboard.runs.list.response',
        requestId: msg.requestId,
        runs,
        ...(nextCursor ? { nextCursor } : {}),
      };
    } catch (err) {
      logger.error('Error handling dashboard.runs.list', {
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['runs.list.read'],
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      return {
        type: 'dashboard.runs.list.response',
        requestId: msg.requestId,
        runs: [],
        error: 'Internal error querying runs list',
      };
    }
  }

  /**
   * Handle a dashboard.runs.filters request.
   *
   * Returns the distinct filter-option values the customer runs page renders
   * in its filter controls — statuses / workflows / branches / repositories /
   * triggerTypes / sources — scoped to ALL routing keys owned by this
   * orchestrator's bound org (same scoping as `handleRunsList`). Distinct
   * values are derived in-memory from a single column projection over
   * `execution_runs`; `sources` reuses `resolveSourceIdentities` so the list
   * matches what the sources page shows for the same routing key.
   *
   * `triggerTypes` is populated from `execution_runs.provider` — the
   * orchestrator has no dedicated trigger-event column, so `provider`
   * (`github` / `generic` / `local`) is the closest available
   * discriminator the customer filter can offer.
   *
   * Attribution uses the handler-bound `orgId` / `routingKey` directly — the
   * same inline-ctx pattern as `handleRunsList`. The access_log row carries
   * the wire actor (including the platform_operator reason) so the customer
   * can audit any operator read.
   */
  async handleRunsFilters(msg: DashboardRunsFiltersRequest): Promise<DashboardRunsFiltersResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    const emptyResponse: DashboardRunsFiltersResponse = {
      type: 'dashboard.runs.filters.response',
      requestId: msg.requestId,
      statuses: [],
      workflows: [],
      branches: [],
      repositories: [],
      triggerTypes: [],
      sources: [],
    };
    try {
      // Unbound orchestrator (no org resolved yet) — nothing to scope to.
      if (!this.orgId) {
        this.recordAccess(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['runs.filters.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return emptyResponse;
      }

      // Scope by the union of the org's routing keys. An empty set means the
      // org owns no (live) sources — return empty options rather than running
      // an unbounded query.
      const routingKeys = await this.resolveOrgRoutingKeys(this.orgId);
      if (routingKeys.length === 0) {
        this.recordAccess(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['runs.filters.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return emptyResponse;
      }

      const rows = await this.db
        .selectFrom('execution_runs')
        .select(['status', 'workflow_name', 'ref', 'repo_identifier', 'provider'])
        .where('routing_key', 'in', routingKeys)
        .execute();

      const statuses = new Set<string>();
      const workflows = new Set<string>();
      const branches = new Set<string>();
      const repositories = new Set<string>();
      const triggerTypes = new Set<string>();
      for (const r of rows) {
        if (r.status) statuses.add(r.status);
        if (r.workflow_name) workflows.add(r.workflow_name);
        if (r.ref) branches.add(r.ref);
        if (r.repo_identifier) repositories.add(r.repo_identifier);
        if (r.provider) triggerTypes.add(r.provider);
      }

      const identities = await this.resolveSourceIdentities(routingKeys);
      const sources = routingKeys
        .map((routingKey) => ({ routingKey, name: identities.get(routingKey)?.name ?? null }))
        .sort((a, b) => a.routingKey.localeCompare(b.routingKey));

      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['runs.filters.read'],
        null,
        msg.requestId,
        'allowed',
      );
      return {
        type: 'dashboard.runs.filters.response',
        requestId: msg.requestId,
        statuses: [...statuses].sort(),
        workflows: [...workflows].sort(),
        branches: [...branches].sort(),
        repositories: [...repositories].sort(),
        triggerTypes: [...triggerTypes].sort(),
        sources,
      };
    } catch (err) {
      logger.error('Error handling dashboard.runs.filters', {
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['runs.filters.read'],
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      return { ...emptyResponse, error: 'Internal error querying runs filters' };
    }
  }

  /**
   * Handle a dashboard.sources.list request.
   *
   * Returns the org's webhook source summaries by unioning both source
   * tables (GitHub-app `sources` + live `generic_webhook_sources`), scoped
   * to this orchestrator's bound org (`this.orgId`). Source counts are tiny
   * so the page is returned unpaginated (`msg.limit` is ignored). Secret-
   * bearing columns (`config`, `git_config`, `verification_config`) are
   * never projected — `git_config` is read only to derive the subtype.
   *
   * Attribution uses the handler-bound `orgId` / `routingKey` directly —
   * the same inline-ctx pattern as `handleRunsList`. The access_log row
   * carries the wire actor so the customer can audit any operator read.
   */
  async handleSourcesList(msg: DashboardSourcesListRequest): Promise<DashboardSourcesListResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    try {
      if (!this.orgId) {
        this.recordAccess(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['sources.list.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return { type: 'dashboard.sources.list.response', requestId: msg.requestId, sources: [] };
      }

      const ghRows = await this.db
        .selectFrom('sources')
        .select(['routing_key', 'name', 'provider', 'created_at'])
        .where('customer_id', '=', this.orgId)
        .execute();

      const genRows = await this.db
        .selectFrom('generic_webhook_sources')
        .select(['routing_key', 'name', 'provider_type', 'git_config', 'enabled', 'created_at'])
        .where('customer_id', '=', this.orgId)
        .where('deleted_at', 'is', null)
        .execute();

      const sources = [
        ...ghRows.map((r) => ({
          routingKey: r.routing_key,
          name: r.name ?? null,
          provider: r.provider,
          subtype: 'github_app' as const,
          enabled: true,
          createdAt: r.created_at.toISOString(),
        })),
        ...genRows.map((r) => ({
          routingKey: r.routing_key,
          name: r.name ?? null,
          provider: r.provider_type === 'local' ? 'local' : 'generic',
          subtype:
            r.provider_type === 'local'
              ? ('local' as const)
              : r.git_config
                ? ('universal_git' as const)
                : ('generic_webhook' as const),
          enabled: r.enabled,
          createdAt: r.created_at.toISOString(),
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['sources.list.read'],
        null,
        msg.requestId,
        'allowed',
      );
      return { type: 'dashboard.sources.list.response', requestId: msg.requestId, sources };
    } catch (err) {
      logger.error('Error handling dashboard.sources.list', { error: toErrorMessage(err) });
      this.recordAccess(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['sources.list.read'],
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      return {
        type: 'dashboard.sources.list.response',
        requestId: msg.requestId,
        sources: [],
        error: 'Internal error querying sources list',
      };
    }
  }

  /**
   * Handle a dashboard.step.logs request.
   * Looks up the step's log_path and reads content from LogStorage.
   */
  async handleStepLogs(msg: DashboardStepLogsRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      // Query the step to get the log_path
      const step = await this.db
        .selectFrom('execution_steps')
        .select(['log_path'])
        .where('run_id', '=', msg.runId)
        .where('job_id', '=', msg.jobId)
        .where('step_index', '=', msg.stepIndex)
        .executeTakeFirst();

      if (!step) {
        this.recordAccess(
          ctx,
          msg.actor,
          'step.logs.read',
          { type: 'step', id: `${msg.runId}:${msg.jobId}:${msg.stepIndex}` },
          msg.requestId,
          'allowed',
          'step not found',
        );
        this.send({
          type: 'dashboard.step.logs.response',
          requestId: msg.requestId,
          lines: [],
          totalLines: 0,
          error: 'Step not found',
        });
        return;
      }

      if (!step.log_path) {
        this.recordAccess(
          ctx,
          msg.actor,
          'step.logs.read',
          { type: 'step', id: `${msg.runId}:${msg.jobId}:${msg.stepIndex}` },
          msg.requestId,
          'allowed',
          'no logs available',
        );
        this.send({
          type: 'dashboard.step.logs.response',
          requestId: msg.requestId,
          lines: [],
          totalLines: 0,
          error: 'No logs available',
        });
        return;
      }

      // Read the log file
      const result = await this.logStorage.read(step.log_path);
      const lines = result.data.split('\n').filter(Boolean);

      // Validate outgoing response against engine schema (double validation)
      const validated = dashboardStepLogsApiResponseSchema.safeParse({
        lines,
        totalLines: lines.length,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.step.logs response validation failed', {
          runId: msg.runId,
          jobId: msg.jobId,
          stepIndex: msg.stepIndex,
          errors: validated.error.issues,
        });
        this.recordAccess(
          ctx,
          msg.actor,
          'step.logs.read',
          { type: 'step', id: `${msg.runId}:${msg.jobId}:${msg.stepIndex}` },
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.step.logs.response',
          requestId: msg.requestId,
          lines: [],
          totalLines: 0,
          error: 'Internal error: response validation failed',
        });
        return;
      }

      this.recordAccess(
        ctx,
        msg.actor,
        'step.logs.read',
        { type: 'step', id: `${msg.runId}:${msg.jobId}:${msg.stepIndex}` },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.step.logs.response',
        requestId: msg.requestId,
        lines: validated.data.lines,
        totalLines: validated.data.totalLines,
      });
    } catch (err) {
      logger.error('Error handling dashboard.step.logs', {
        runId: msg.runId,
        jobId: msg.jobId,
        stepIndex: msg.stepIndex,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'step.logs.read',
        { type: 'step', id: `${msg.runId}:${msg.jobId}:${msg.stepIndex}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.step.logs.response',
        requestId: msg.requestId,
        lines: [],
        totalLines: 0,
        error: 'Internal error reading logs',
      });
    }
  }

  /**
   * Read the attestation rows for a run, joined to `execution_jobs` for the
   * job name. Ordered oldest-first so the dashboard table is stable.
   */
  private async resolveAttestationsForRun(runId: string) {
    // `attestations.run_id` / `job_id` are TEXT (P1.5 schema), while
    // `execution_jobs.run_id` / `job_id` are `uuid`. Postgres won't compare
    // `uuid = text` implicitly, so cast the uuid side to text in the join.
    return this.db
      .selectFrom('attestations')
      .innerJoin('execution_jobs', (join) =>
        join
          .on(sql`execution_jobs.job_id::text`, '=', sql.ref('attestations.job_id'))
          .on(sql`execution_jobs.run_id::text`, '=', sql.ref('attestations.run_id')),
      )
      .select([
        'attestations.id as id',
        'attestations.job_id as jobId',
        'execution_jobs.job_name as jobName',
        'attestations.subject_name as subjectName',
        'attestations.subject_digest as subjectDigest',
        'attestations.mode as mode',
        'attestations.media_type as mediaType',
        'attestations.storage_key as storageKey',
        'attestations.created_at as createdAt',
      ])
      .where('attestations.run_id', '=', runId)
      .orderBy('attestations.created_at', 'asc')
      .execute();
  }

  /**
   * Handle a dashboard.attestations.list request: list the run's provenance
   * attestations, inlining each stored bundle from object storage so the
   * dashboard verifies it client-side. Mirrors `handleStepLogs` (per-run org
   * resolution + `recordAccess` + `send`). Rows whose bundle can't be read are
   * skipped (best-effort) rather than failing the whole list.
   */
  async handleAttestationsList(msg: DashboardAttestationsListRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    const target = { type: 'run' as const, id: msg.runId };
    try {
      if (!this.provenanceStorage) {
        this.recordAccess(
          ctx,
          msg.actor,
          'attestations.read',
          target,
          msg.requestId,
          'error',
          'provenance storage not configured',
        );
        this.send({
          type: 'dashboard.attestations.list.response',
          requestId: msg.requestId,
          attestations: [],
          error: 'Provenance storage not configured',
        });
        return;
      }

      const rows = await this.resolveAttestationsForRun(msg.runId);
      const attestations: AttestationListItem[] = [];
      for (const row of rows) {
        const raw = await this.provenanceStorage.get(row.storageKey);
        if (!raw) {
          logger.warn('Attestation bundle missing from object storage', {
            runId: msg.runId,
            attestationId: row.id,
            storageKey: row.storageKey,
          });
          continue;
        }
        let bundle: unknown;
        try {
          bundle = JSON.parse(raw.toString('utf-8'));
        } catch (parseErr) {
          logger.warn('Attestation bundle is not valid JSON', {
            runId: msg.runId,
            attestationId: row.id,
            error: toErrorMessage(parseErr),
          });
          continue;
        }
        attestations.push({
          id: row.id,
          jobId: row.jobId,
          jobName: row.jobName ?? null,
          subjectName: row.subjectName,
          subjectDigest: row.subjectDigest,
          mode: row.mode,
          mediaType: row.mediaType,
          createdAt: new Date(row.createdAt).toISOString(),
          bundle: bundle as AttestationListItem['bundle'],
        });
      }

      const validated = dashboardAttestationsListResponseSchema.safeParse({
        type: 'dashboard.attestations.list.response',
        requestId: msg.requestId,
        attestations,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.attestations.list response validation failed', {
          runId: msg.runId,
          errors: validated.error.issues,
        });
        this.recordAccess(
          ctx,
          msg.actor,
          'attestations.read',
          target,
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.attestations.list.response',
          requestId: msg.requestId,
          attestations: [],
          error: 'Internal error: response validation failed',
        });
        return;
      }

      this.recordAccess(ctx, msg.actor, 'attestations.read', target, msg.requestId, 'allowed');
      this.send(validated.data);
    } catch (err) {
      logger.error('Error handling dashboard.attestations.list', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'attestations.read',
        target,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.attestations.list.response',
        requestId: msg.requestId,
        attestations: [],
        error: 'Internal error reading attestations',
      });
    }
  }

  /**
   * Handle a dashboard.payload request.
   * Reads the webhook payload from log storage for the given runId.
   */
  async handlePayload(msg: DashboardPayloadRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    const payloadPath = `executions/${msg.runId}/webhook-payload.json`;
    const backend = this.logStorage.constructor.name;
    logger.info('Dashboard payload request received', {
      requestId: msg.requestId,
      runId: msg.runId,
      payloadPath,
      logStorageBackend: backend,
      orchestratorId: this.orchestratorId,
    });
    try {
      const result = await this.logStorage.read(payloadPath);

      if (!result.data) {
        // INFO (not warn): a missing payload on this orch is expected when
        // Platform routes a dashboard.payload request to an orch that did
        // not ingest the webhook (e.g. fresh pool member, HA reroute). The
        // caller is responsible for retrying on a different orch or treating
        // this as 404.
        logger.info('Dashboard payload not found', {
          requestId: msg.requestId,
          runId: msg.runId,
          payloadPath,
          logStorageBackend: backend,
          orchestratorId: this.orchestratorId,
        });
        this.recordAccess(
          ctx,
          msg.actor,
          'run.payload.read',
          { type: 'payload', id: msg.runId },
          msg.requestId,
          'allowed',
          'payload not found',
        );
        this.send({
          type: 'dashboard.payload.response',
          requestId: msg.requestId,
          error: 'Payload not found',
        });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(result.data);
      } catch {
        logger.error('Dashboard payload data is not valid JSON', {
          requestId: msg.requestId,
          runId: msg.runId,
          payloadPath,
          logStorageBackend: backend,
          bytes: result.data.length,
        });
        this.recordAccess(
          ctx,
          msg.actor,
          'run.payload.read',
          { type: 'payload', id: msg.runId },
          msg.requestId,
          'error',
          'payload data is not valid JSON',
        );
        this.send({
          type: 'dashboard.payload.response',
          requestId: msg.requestId,
          error: 'Payload data is not valid JSON',
        });
        return;
      }

      logger.info('Dashboard payload served', {
        requestId: msg.requestId,
        runId: msg.runId,
        bytes: result.data.length,
        orchestratorId: this.orchestratorId,
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'run.payload.read',
        { type: 'payload', id: msg.runId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.payload.response',
        requestId: msg.requestId,
        payload,
      });
    } catch (err) {
      logger.error('Error handling dashboard.payload', {
        requestId: msg.requestId,
        runId: msg.runId,
        payloadPath,
        logStorageBackend: backend,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'run.payload.read',
        { type: 'payload', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.payload.response',
        requestId: msg.requestId,
        error: 'Internal error reading payload',
      });
    }
  }

  /**
   * Handle a dashboard.orch.logs request.
   * Reads orchestration + provisioning log files from LogStorage for the given run/job.
   * Provisioning logs are returned with phase "provisioning" so the dashboard can
   * render them in a separate collapsible section.
   */
  async handleOrchLogs(msg: DashboardOrchLogsRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      const basePath = `executions/${msg.runId}/jobs/${msg.jobId}`;

      // Read orchestration logs
      let orchLines: string[] = [];
      try {
        const orchResult = await this.logStorage.read(`${basePath}/orchestration.jsonl`);
        orchLines = orchResult.data.split('\n').filter(Boolean);
      } catch {
        // Orchestration logs may not exist yet
      }

      // Read provisioning logs (stored by emitScalerEvent in execution-tracker)
      let provLines: string[] = [];
      try {
        const provResult = await this.logStorage.read(`${basePath}/provisioning.jsonl`);
        provLines = provResult.data.split('\n').filter(Boolean);
      } catch {
        // Provisioning logs may not exist (non-scaler runs)
      }

      const allLines = [...orchLines, ...provLines];

      this.recordAccess(
        ctx,
        msg.actor,
        'run.orch_logs.read',
        { type: 'job', id: `${msg.runId}:${msg.jobId}` },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.orch.logs.response',
        requestId: msg.requestId,
        lines: allLines,
        totalLines: allLines.length,
      });
    } catch (err) {
      this.recordAccess(
        ctx,
        msg.actor,
        'run.orch_logs.read',
        { type: 'job', id: `${msg.runId}:${msg.jobId}` },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.orch.logs.response',
        requestId: msg.requestId,
        lines: [],
        totalLines: 0,
        error: 'Orchestration logs not available',
      });
    }
  }

  /**
   * Handle a run.rerun.request.
   * Delegates to the onRerun callback which invokes handleRerun from the rerun module.
   *
   * Resolution: prefer `msg.routingKey` (Phase F denormalization hint from
   * Platform — `execution_runs.routing_key` mirror). The hint is the ONLY
   * org context we have when the run row has been cold-archived out of PG,
   * so consult sources/generic_webhook_sources directly. If the hint is
   * absent, fall back to `resolveOrgForRun` against the warm PG row.
   */
  async handleRerunRequest(msg: RunRerunRequest): Promise<void> {
    let resolved: { orgId: string | null; routingKey: string | null } | null = null;
    if (msg.routingKey) {
      resolved = await this.resolveOrgForRoutingKey(msg.routingKey);
    } else {
      resolved = await this.resolveOrgForRun(msg.runId);
    }
    const ctx = this.contextOrFallback(resolved);

    try {
      const result = await this.onRerun(msg.runId, stringifyActor(msg.actor), msg.routingKey);

      this.recordAccess(
        ctx,
        msg.actor,
        'run.rerun',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'run.rerun.response',
        requestId: msg.requestId,
        newRunId: result.newRunId,
      });
    } catch (err) {
      logger.error('Error handling run.rerun.request', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'run.rerun',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      // Phase C: surface a stable code for archived-run rerun attempts so
      // the Platform proxy can map to HTTP 410 instead of a generic 400.
      // We detect by structural shape (`code === 'runArchivedNotRerunnable'`)
      // rather than `instanceof` so the orchestrator package doesn't have
      // to import from `pipeline/rerun.ts` at the type level.
      const errorCode =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : undefined;
      this.send({
        type: 'run.rerun.response',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : 'Internal error processing re-run',
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  /**
   * Handle a run.cancel.request.
   * Delegates to the onCancel callback which sends job.cancel to agents.
   */
  async handleCancelRequest(msg: RunCancelRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      const result = await this.onCancel(msg.runId, stringifyActor(msg.actor), msg.force);

      this.recordAccess(
        ctx,
        msg.actor,
        'run.cancel',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'run.cancel.response',
        requestId: msg.requestId,
        cancelledJobs: result.cancelledJobs,
      });
    } catch (err) {
      logger.error('Error handling run.cancel.request', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'run.cancel',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'run.cancel.response',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : 'Internal error processing cancel',
      });
    }
  }

  /**
   * Handle a dashboard.event-log.list request.
   *
   * Returns a paginated page of inbound webhook delivery rows owned by this
   * orchestrator (`event_log` table) for the given org. Pagination uses an
   * opaque cursor (received_at + id) so concurrent inserts don't shift pages.
   *
   * Filters: routingKey, event, status, fromTimestamp/toTimestamp,
   * deliveryId substring. All optional.
   */
  async handleEventLogList(msg: DashboardEventLogListRequest): Promise<void> {
    // The schema already carries `orgId` on the wire — that's the source of
    // truth for attribution. routingKey is an optional filter; default to
    // the bound routing key only when no filter was supplied.
    const ctx = { orgId: msg.orgId, routingKey: msg.routingKey ?? this.routingKey };
    try {
      const limit = Math.min(Math.max(msg.limit ?? 50, 1), 200);

      let query = this.db
        .selectFrom('event_log')
        .select([
          'id',
          'delivery_id',
          'routing_key',
          'event',
          'action',
          'source',
          'provider',
          'repo_identifier',
          'ref',
          'status',
          'matched_count',
          'run_id',
          'error_message',
          'received_at',
          'payload_omitted',
          'payload_omitted_reason',
          'payload_size_bytes',
          'payload_hash',
        ])
        .where('org_id', '=', msg.orgId);

      if (msg.routingKey) query = query.where('routing_key', '=', msg.routingKey);
      if (msg.event) query = query.where('event', '=', msg.event);
      if (msg.status) query = query.where('status', '=', msg.status);
      if (msg.fromTimestamp) {
        query = query.where('received_at', '>=', new Date(msg.fromTimestamp));
      }
      if (msg.toTimestamp) {
        query = query.where('received_at', '<', new Date(msg.toTimestamp));
      }
      if (msg.deliveryId) {
        query = query.where('delivery_id', 'like', `%${msg.deliveryId}%`);
      }

      // Cursor: { receivedAt: ISO, id: UUID }. Stable on (received_at, id) pair.
      if (msg.cursor) {
        const cur = decodeEventLogCursor(msg.cursor);
        if (cur) {
          query = query.where((eb) =>
            eb.or([
              eb('received_at', '<', new Date(cur.receivedAt)),
              eb.and([eb('received_at', '=', new Date(cur.receivedAt)), eb('id', '<', cur.id)]),
            ]),
          );
        }
      }

      const rows = await query
        .orderBy('received_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1) // fetch one extra to detect "has more"
        .execute();

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: EventLogListItem[] = pageRows.map((r) => rowToListItem(r));
      const nextCursor =
        hasMore && pageRows.length > 0
          ? encodeEventLogCursor({
              receivedAt: pageRows[pageRows.length - 1].received_at.toISOString(),
              id: pageRows[pageRows.length - 1].id,
            })
          : null;

      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.list.read',
        { type: 'event_log', id: msg.orgId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-log.list.response',
        requestId: msg.requestId,
        items,
        nextCursor,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-log.list', {
        orgId: msg.orgId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.list.read',
        { type: 'event_log', id: msg.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-log.list.response',
        requestId: msg.requestId,
        items: [],
        nextCursor: null,
        error: 'Internal error querying event log',
      });
    }
  }

  /**
   * Handle a dashboard.access-log.list request.
   *
   * Returns a paginated page of access_log rows for the given org. Used by
   * the dashboard "Data access" tab to show who read what (and when).
   *
   * Every filter is optional; the orchestrator scopes on orgId then applies
   * each supplied filter independently. Records its own access_log row
   * under action='access_log.list.read' so there's a meta-audit of who
   * looked at the audit log.
   */
  async handleAccessLogList(msg: DashboardAccessLogListRequest): Promise<void> {
    // `msg.orgId` is the source of truth for attribution; routingKey is
    // informational only on this handler so we keep the bound value.
    const ctx = { orgId: msg.orgId, routingKey: this.routingKey };
    if (!this.accessLog) {
      this.send({
        type: 'dashboard.access-log.list.response',
        requestId: msg.requestId,
        items: [],
        nextCursor: null,
        error: 'Access log not available on this orchestrator',
      });
      return;
    }
    try {
      const result = await this.accessLog.query({
        orgId: msg.orgId,
        actorType: msg.actorType,
        actorId: msg.actorId,
        action: msg.action,
        source: msg.source,
        outcome: msg.outcome,
        targetType: msg.targetType,
        targetId: msg.targetId,
        fromTimestamp: msg.fromTimestamp,
        toTimestamp: msg.toTimestamp,
        q: msg.q,
        limit: msg.limit,
        cursor: msg.cursor,
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'access_log.list.read',
        { type: 'access_log', id: msg.orgId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.access-log.list.response',
        requestId: msg.requestId,
        items: result.items,
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      logger.error('Error handling dashboard.access-log.list', {
        orgId: msg.orgId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'access_log.list.read',
        { type: 'access_log', id: msg.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.access-log.list.response',
        requestId: msg.requestId,
        items: [],
        nextCursor: null,
        error: 'Internal error querying access log',
      });
    }
  }

  /**
   * Handle a dashboard.event-log.detail request.
   *
   * Returns the metadata row only — the webhook body bytes stream over a
   * separate chunked-WS path (`handleEventLogPayloadStream` below) so
   * Platform never holds the full body in memory and the dashboard can
   * render progress as bytes arrive. When `payload_omitted=true` the row's
   * `payloadOmitted`/`payloadOmittedReason` fields tell the dashboard to
   * skip issuing a stream request.
   */
  async handleEventLogDetail(msg: DashboardEventLogDetailRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: msg.routingKey ?? this.routingKey };
    try {
      // Phase E: hot lookup first; on miss falls back to cold-store
      // (scoped by `routingKey` hint from Platform when available).
      const row = await loadEventLogByDeliveryId({
        db: this.db,
        coldStore: this.coldStore ?? undefined,
        orgId: msg.orgId,
        deliveryId: msg.deliveryId,
        routingKey: msg.routingKey,
      });

      if (!row) {
        this.recordAccess(
          ctx,
          msg.actor,
          'event_log.detail.read',
          { type: 'event_log', id: msg.deliveryId },
          msg.requestId,
          'allowed',
          'delivery not found',
        );
        this.send({
          type: 'dashboard.event-log.detail.response',
          requestId: msg.requestId,
          error: 'Delivery not found',
        });
        return;
      }

      const item = rowToListItem(row);

      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.detail.read',
        { type: 'event_log', id: msg.deliveryId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-log.detail.response',
        requestId: msg.requestId,
        item,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-log.detail', {
        orgId: msg.orgId,
        deliveryId: msg.deliveryId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.detail.read',
        { type: 'event_log', id: msg.deliveryId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-log.detail.response',
        requestId: msg.requestId,
        error: 'Internal error querying event log detail',
      });
    }
  }

  /**
   * Handle a dashboard.event-log.payload.stream request.
   *
   * Reads the gzipped body from LogStorage, decompresses it, slices the
   * decompressed bytes into 64 KiB chunks, base64-encodes each, and emits a
   * sequence of `dashboard.event-log.payload.chunk` messages. The first
   * chunk carries `totalBytes`; the last chunk carries `isLast=true`.
   *
   * The single audit row (`event_log.payload.read`) is written at the start
   * of the stream — outcome `allowed` when the row exists and the body
   * begins streaming, `not_found` / `denied` when the request resolves to
   * an empty/error stream. Per-chunk audits would inflate the access-log
   * volume without adding attribution detail.
   *
   * Pacing: a `setImmediate` yield between sends keeps the WS connection
   * from saturating. For a 5 MB cap (the wishlist's worst case) this means
   * ~80 yields per stream — negligible.
   */
  async handleEventLogPayloadStream(msg: DashboardEventLogPayloadStreamRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: msg.routingKey ?? this.routingKey };
    const sendTerminal = (seq: number, error: EventLogPayloadStreamError): void => {
      this.send({
        type: 'dashboard.event-log.payload.chunk',
        requestId: msg.requestId,
        seq,
        data: '',
        isLast: true,
        error,
      });
    };

    let row;
    try {
      row = await loadEventLogByDeliveryId({
        db: this.db,
        coldStore: this.coldStore ?? undefined,
        orgId: msg.orgId,
        deliveryId: msg.deliveryId,
        routingKey: msg.routingKey,
      });
    } catch (err) {
      logger.error('Error loading event-log row for payload stream', {
        orgId: msg.orgId,
        deliveryId: msg.deliveryId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.payload.read',
        { type: 'event_log_payload', id: msg.deliveryId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      sendTerminal(0, EventLogPayloadStreamError.enum.read_failed);
      return;
    }

    if (!row) {
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.payload.read',
        { type: 'event_log_payload', id: msg.deliveryId },
        msg.requestId,
        'denied',
        'delivery not found',
      );
      sendTerminal(0, EventLogPayloadStreamError.enum.not_found);
      return;
    }

    if (row.payload_omitted || !row.payload_key) {
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.payload.read',
        { type: 'event_log_payload', id: msg.deliveryId },
        msg.requestId,
        'denied',
        row.payload_omitted_reason ?? 'payload_unavailable',
      );
      sendTerminal(0, EventLogPayloadStreamError.enum.payload_unavailable);
      return;
    }

    let decompressed: Buffer;
    try {
      // LogStorage.read() returns the binary content as a string (FS
      // backend reads as UTF-8; S3 backend treats body as bytes). The
      // writer used .append() with a binary-encoded gzip buffer, so we
      // round-trip through Buffer and gunzip — same shape as the legacy
      // detail handler used to do.
      const result = await this.logStorage.read(row.payload_key);
      const buf = Buffer.from(result.data, 'binary');
      decompressed = gunzipSync(buf);
    } catch (err) {
      logger.warn('Failed to read or decode event-log payload for stream', {
        deliveryId: msg.deliveryId,
        payloadKey: row.payload_key,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_log.payload.read',
        { type: 'event_log_payload', id: msg.deliveryId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      sendTerminal(0, EventLogPayloadStreamError.enum.read_failed);
      return;
    }

    this.recordAccess(
      ctx,
      msg.actor,
      'event_log.payload.read',
      { type: 'event_log_payload', id: msg.deliveryId },
      msg.requestId,
      'allowed',
    );

    const totalBytes = decompressed.byteLength;
    if (totalBytes === 0) {
      // Empty body is still a valid (if unusual) decompression — emit a
      // single terminal chunk with no error so the dashboard can render
      // an empty body view.
      this.send({
        type: 'dashboard.event-log.payload.chunk',
        requestId: msg.requestId,
        seq: 0,
        data: '',
        isLast: true,
        totalBytes: 0,
      });
      return;
    }

    const chunkSize = EVENT_LOG_PAYLOAD_CHUNK_BYTES;
    const chunkCount = Math.ceil(totalBytes / chunkSize);
    for (let seq = 0; seq < chunkCount; seq++) {
      const start = seq * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const slice = decompressed.subarray(start, end);
      const isLast = seq === chunkCount - 1;
      this.send({
        type: 'dashboard.event-log.payload.chunk',
        requestId: msg.requestId,
        seq,
        data: slice.toString('base64'),
        isLast,
        ...(seq === 0 && { totalBytes }),
      });
      if (!isLast) {
        // Yield the event loop between chunks so we don't saturate the
        // single WS connection. Mirrors the agent-side log.chunk pacing.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  /**
   * Handle a dashboard.event-dlq.list request.
   *
   * Returns a paginated page of DLQ rows (events whose dispatch attempts
   * exhausted the retry budget). The page is keyed off `dlq_at DESC` and
   * paginates with a single `before` ISO cursor.
   *
   * Records one `event_dlq.list.read` access_log entry using the user
   * actor on the wire — mirrors the HTTP admin route's audit shape but
   * with the calling user's identity instead of the bearer-token role.
   */
  async handleEventDlqList(msg: DashboardEventDlqListRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: this.routingKey };
    try {
      if (!this.eventStore) {
        this.send({
          type: 'dashboard.event-dlq.list.response',
          requestId: msg.requestId,
          items: [],
          nextCursor: null,
          error: 'Event store not available on this orchestrator',
        });
        return;
      }

      const limit = Math.min(Math.max(msg.limit ?? 50, 1), 200);
      const beforeDlqAt = msg.before ? new Date(msg.before) : undefined;
      const events = await this.eventStore.listDlq(
        limit,
        beforeDlqAt && !Number.isNaN(beforeDlqAt.getTime()) ? beforeDlqAt : undefined,
      );

      const items: DashboardEventDlqListItem[] = events.map((e) => ({
        id: e.id,
        eventName: e.eventName,
        payload: e.payload,
        sourceRepo: e.sourceRepo ?? null,
        sourceRoutingKey: e.sourceRoutingKey ?? null,
        sourceRunId: e.sourceRunId ?? null,
        sourceJobId: e.sourceJobId ?? null,
        chainDepth: e.chainDepth,
        createdAt: e.createdAt.toISOString(),
        dlqAt: e.dlqAt?.toISOString() ?? null,
        dlqReason: e.dlqReason,
        attempts: e.attempts,
        lastError: e.lastError,
      }));

      const nextCursor = items.length === limit ? (items[items.length - 1].dlqAt ?? null) : null;

      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.list.read',
        { type: 'event_dlq', id: msg.orgId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-dlq.list.response',
        requestId: msg.requestId,
        items,
        nextCursor,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-dlq.list', {
        orgId: msg.orgId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.list.read',
        { type: 'event_dlq', id: msg.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-dlq.list.response',
        requestId: msg.requestId,
        items: [],
        nextCursor: null,
        error: 'Internal error querying DLQ',
      });
    }
  }

  /**
   * Handle a dashboard.event-dlq.count request.
   *
   * Returns the DLQ depth for the sidebar badge. Polled ~30s by the
   * dashboard. No access_log row — the count surface is intentionally
   * un-audited (it's a frequent badge poll, not a triage action).
   */
  async handleEventDlqCount(msg: DashboardEventDlqCountRequest): Promise<void> {
    try {
      if (!this.eventStore) {
        this.send({
          type: 'dashboard.event-dlq.count.response',
          requestId: msg.requestId,
          total: 0,
        });
        return;
      }
      const total = await this.eventStore.countDlq();
      this.send({
        type: 'dashboard.event-dlq.count.response',
        requestId: msg.requestId,
        total,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-dlq.count', {
        orgId: msg.orgId,
        error: toErrorMessage(err),
      });
      this.send({
        type: 'dashboard.event-dlq.count.response',
        requestId: msg.requestId,
        error: 'Internal error querying DLQ count',
      });
    }
  }

  /**
   * Handle a dashboard.event-dlq.retry request.
   *
   * Clears the DLQ flag on the row and issues a `pg_notify` so a healthy
   * node picks the event up immediately rather than waiting for the
   * leader-only retry scanner's next tick. Notify failure is non-fatal —
   * the scanner will catch up.
   */
  async handleEventDlqRetry(msg: DashboardEventDlqRetryRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: this.routingKey };
    if (
      !(await this.enforcePolicy(
        msg,
        'event_dlq.retry',
        'dashboard.event-dlq.retry.response',
        'event_dlq.retry',
        { type: 'event_dlq', id: msg.eventId },
        ctx,
      ))
    ) {
      return;
    }
    try {
      if (!this.eventStore) {
        this.send({
          type: 'dashboard.event-dlq.retry.response',
          requestId: msg.requestId,
          error: 'Event store not available on this orchestrator',
        });
        return;
      }

      const existing = await this.eventStore.getById(msg.eventId);
      if (!existing || !existing.dlqAt) {
        this.recordAccess(
          ctx,
          msg.actor,
          'event_dlq.retry',
          { type: 'event_dlq', id: msg.eventId },
          msg.requestId,
          'allowed',
          'DLQ event not found',
        );
        this.send({
          type: 'dashboard.event-dlq.retry.response',
          requestId: msg.requestId,
          error: 'DLQ event not found',
        });
        return;
      }

      const ok = await this.eventStore.resetFromDlq(msg.eventId);
      if (!ok) {
        this.send({
          type: 'dashboard.event-dlq.retry.response',
          requestId: msg.requestId,
          error: 'DLQ event not found',
        });
        return;
      }

      try {
        await sql`SELECT pg_notify('kici_event_channel', ${msg.eventId})`.execute(
          this.eventStore.getDb(),
        );
      } catch (err) {
        logger.warn('pg_notify failed after DLQ retry; scanner will catch up', {
          eventId: msg.eventId,
          error: toErrorMessage(err),
        });
      }

      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.retry',
        { type: 'event_dlq', id: msg.eventId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-dlq.retry.response',
        requestId: msg.requestId,
        retried: true,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-dlq.retry', {
        orgId: msg.orgId,
        eventId: msg.eventId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.retry',
        { type: 'event_dlq', id: msg.eventId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-dlq.retry.response',
        requestId: msg.requestId,
        error: 'Internal error retrying DLQ event',
      });
    }
  }

  /**
   * Handle a dashboard.event-dlq.discard request.
   *
   * Permanently deletes the DLQ row. No retry, no archive — used when the
   * payload is corrupt or the routing target has been removed.
   */
  async handleEventDlqDiscard(msg: DashboardEventDlqDiscardRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: this.routingKey };
    if (
      !(await this.enforcePolicy(
        msg,
        'event_dlq.discard',
        'dashboard.event-dlq.discard.response',
        'event_dlq.discard',
        { type: 'event_dlq', id: msg.eventId },
        ctx,
      ))
    ) {
      return;
    }
    try {
      if (!this.eventStore) {
        this.send({
          type: 'dashboard.event-dlq.discard.response',
          requestId: msg.requestId,
          error: 'Event store not available on this orchestrator',
        });
        return;
      }

      const existing = await this.eventStore.getById(msg.eventId);
      if (!existing || !existing.dlqAt) {
        this.recordAccess(
          ctx,
          msg.actor,
          'event_dlq.discard',
          { type: 'event_dlq', id: msg.eventId },
          msg.requestId,
          'allowed',
          'DLQ event not found',
        );
        this.send({
          type: 'dashboard.event-dlq.discard.response',
          requestId: msg.requestId,
          error: 'DLQ event not found',
        });
        return;
      }

      const ok = await this.eventStore.deleteDlq(msg.eventId);
      if (!ok) {
        this.send({
          type: 'dashboard.event-dlq.discard.response',
          requestId: msg.requestId,
          error: 'DLQ event not found',
        });
        return;
      }

      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.discard',
        { type: 'event_dlq', id: msg.eventId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-dlq.discard.response',
        requestId: msg.requestId,
        discarded: true,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-dlq.discard', {
        orgId: msg.orgId,
        eventId: msg.eventId,
        error: toErrorMessage(err),
      });
      this.recordAccess(
        ctx,
        msg.actor,
        'event_dlq.discard',
        { type: 'event_dlq', id: msg.eventId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-dlq.discard.response',
        requestId: msg.requestId,
        error: 'Internal error discarding DLQ event',
      });
    }
  }

  /**
   * Handle a run.manual_schedule.request.
   * Delegates to the onManualSchedule callback which invokes handleManualSchedule.
   */
  async handleManualScheduleRequest(msg: ManualScheduleRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRegistration(msg.registrationId));
    try {
      const result = await this.onManualSchedule(msg.registrationId, stringifyActor(msg.actor));

      this.recordAccess(
        ctx,
        msg.actor,
        'run.manual_schedule',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'run.manual_schedule.response',
        requestId: msg.requestId,
        newRunId: result.newRunId,
      });
    } catch (err) {
      logger.error('Error handling run.manual_schedule.request', {
        registrationId: msg.registrationId,
        error: toErrorMessage(err),
      });

      this.recordAccess(
        ctx,
        msg.actor,
        'run.manual_schedule',
        { type: 'registration', id: msg.registrationId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'run.manual_schedule.response',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : 'Internal error processing manual schedule',
      });
    }
  }

  /**
   * Phase C cold-store fallback: fetch the run + its jobs + its steps
   * from S3 when the PG copy has been archived. Bounded scan: stops at
   * the warm cutoff (older entries don't exist in cold-store yet by
   * construction). Each row is filtered by `run_id` because chunks
   * span multiple runs.
   */
  private async fetchArchivedRunDetail(
    routingKey: string,
    runId: string,
  ): Promise<{
    run:
      | {
          trust_tier: string | null;
          lock_file_source: string | null;
          contributor_username: string | null;
          init_failure: InitFailure | null;
          check_mode: string | null;
        }
      | undefined;
    jobs: Array<{
      job_id: string;
      job_name: string;
      status: string;
      matrix_values: string | null;
      base_job_name: string | null;
      variant_kind: string | null;
      variant_label: string | null;
      agent_id: string | null;
      started_at: Date | null;
      completed_at: Date | null;
      duration_ms: number | null;
      error_message: string | null;
      runs_on_labels: string | null;
      outputs: string | null;
      init_failure: InitFailure | null;
    }>;
    steps: Array<{
      job_id: string;
      step_index: number;
      step_name: string;
      status: string;
      started_at: Date | null;
      completed_at: Date | null;
      duration_ms: number | null;
      exit_code: number | null;
      error_message: string | null;
      step_type: string;
      secrets_accessed: string | null;
      check_outcome: string | null;
      drift_summary: string | null;
    }>;
  }> {
    const out = {
      run: undefined as
        | {
            trust_tier: string | null;
            lock_file_source: string | null;
            contributor_username: string | null;
            init_failure: InitFailure | null;
            check_mode: string | null;
          }
        | undefined,
      jobs: [] as Array<{
        job_id: string;
        job_name: string;
        status: string;
        matrix_values: string | null;
        base_job_name: string | null;
        variant_kind: string | null;
        variant_label: string | null;
        agent_id: string | null;
        started_at: Date | null;
        completed_at: Date | null;
        duration_ms: number | null;
        error_message: string | null;
        runs_on_labels: string | null;
        outputs: string | null;
        init_failure: InitFailure | null;
      }>,
      steps: [] as Array<{
        job_id: string;
        step_index: number;
        step_name: string;
        status: string;
        started_at: Date | null;
        completed_at: Date | null;
        duration_ms: number | null;
        exit_code: number | null;
        error_message: string | null;
        step_type: string;
        secrets_accessed: string | null;
        check_outcome: string | null;
        drift_summary: string | null;
      }>,
    };
    if (!this.coldStore) return out;
    const epoch = new Date(0);
    // 30 days warm window matches the Phase C adapter defaults.
    const warmCutoff = new Date(Date.now() - 30 * 86_400_000);

    const fetchByRun = async (table: 'execution_runs' | 'execution_jobs' | 'execution_steps') => {
      const rows: Record<string, unknown>[] = [];
      try {
        for await (const row of this.coldStore!.fetchRange({
          db: 'orchestrator',
          table,
          tenantId: routingKey,
          fromTs: epoch,
          toTs: warmCutoff,
        })) {
          const r = row as Record<string, unknown>;
          if (r.run_id === runId) rows.push(r);
        }
      } catch (err) {
        logger.warn('cold-store fetchRange failed for run-detail', {
          table,
          runId,
          error: toErrorMessage(err),
        });
      }
      return rows;
    };

    const [runRows, jobRows, stepRows] = await Promise.all([
      fetchByRun('execution_runs'),
      fetchByRun('execution_jobs'),
      fetchByRun('execution_steps'),
    ]);

    if (runRows[0]) {
      const r = runRows[0];
      out.run = {
        trust_tier: typeof r.trust_tier === 'string' ? r.trust_tier : null,
        lock_file_source: typeof r.lock_file_source === 'string' ? r.lock_file_source : null,
        contributor_username:
          typeof r.contributor_username === 'string' ? r.contributor_username : null,
        init_failure: (r.init_failure as InitFailure | null) ?? null,
        check_mode: typeof r.check_mode === 'string' ? r.check_mode : null,
      };
    }
    out.jobs = jobRows.map((r) => ({
      job_id: String(r.job_id ?? ''),
      job_name: String(r.job_name ?? ''),
      status: String(r.status ?? ''),
      matrix_values: typeof r.matrix_values === 'string' ? r.matrix_values : null,
      base_job_name: typeof r.base_job_name === 'string' ? r.base_job_name : null,
      variant_kind: typeof r.variant_kind === 'string' ? r.variant_kind : null,
      variant_label: typeof r.variant_label === 'string' ? r.variant_label : null,
      agent_id: typeof r.agent_id === 'string' ? r.agent_id : null,
      started_at: coerceToDate(r.started_at),
      completed_at: coerceToDate(r.completed_at),
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
      error_message: typeof r.error_message === 'string' ? r.error_message : null,
      runs_on_labels: typeof r.runs_on_labels === 'string' ? r.runs_on_labels : null,
      outputs: typeof r.outputs === 'string' ? r.outputs : null,
      init_failure: (r.init_failure as InitFailure | null) ?? null,
    }));
    // Order steps by step_index to match the PG path's ORDER BY.
    stepRows.sort((a, b) => Number(a.step_index ?? 0) - Number(b.step_index ?? 0));
    out.steps = stepRows.map((r) => ({
      job_id: String(r.job_id ?? ''),
      step_index: Number(r.step_index ?? 0),
      step_name: String(r.step_name ?? ''),
      status: String(r.status ?? ''),
      started_at: coerceToDate(r.started_at),
      completed_at: coerceToDate(r.completed_at),
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
      exit_code: typeof r.exit_code === 'number' ? r.exit_code : null,
      error_message: typeof r.error_message === 'string' ? r.error_message : null,
      step_type: typeof r.step_type === 'string' ? r.step_type : 'step',
      secrets_accessed: typeof r.secrets_accessed === 'string' ? r.secrets_accessed : null,
      check_outcome: typeof r.check_outcome === 'string' ? r.check_outcome : null,
      drift_summary: typeof r.drift_summary === 'string' ? r.drift_summary : null,
    }));
    return out;
  }
}

function coerceToDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── event_log helpers ──────────────────────────────────────────────

/** Map a DB row to the WS list-item shape. */
function rowToListItem(r: {
  delivery_id: string;
  routing_key: string;
  event: string;
  action: string | null;
  source: string;
  provider: string;
  repo_identifier: string | null;
  ref: string | null;
  status: string;
  matched_count: number;
  run_id: string | null;
  error_message: string | null;
  received_at: Date;
  payload_omitted: boolean;
  payload_omitted_reason: string | null;
  payload_size_bytes: number;
  payload_hash: string;
}): EventLogListItem {
  return {
    deliveryId: r.delivery_id,
    routingKey: r.routing_key,
    event: r.event,
    action: r.action,
    source: r.source as EventLogSource,
    provider: r.provider,
    repoIdentifier: r.repo_identifier,
    ref: r.ref,
    status: r.status as EventLogStatus,
    matchedCount: r.matched_count,
    runId: r.run_id,
    errorMessage: r.error_message,
    receivedAt: r.received_at.toISOString(),
    payloadOmitted: r.payload_omitted,
    payloadOmittedReason: r.payload_omitted_reason as PayloadOmittedReason | null,
    payloadSizeBytes: r.payload_size_bytes,
    payloadHash: r.payload_hash,
  };
}

/** Encode a pagination cursor as base64url(JSON({receivedAt, id})). */
function encodeEventLogCursor(c: { receivedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url');
}

function decodeEventLogCursor(s: string): { receivedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as { receivedAt?: unknown; id?: unknown };
    if (typeof parsed.receivedAt === 'string' && typeof parsed.id === 'string') {
      return { receivedAt: parsed.receivedAt, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Encode a runs-list pagination cursor as base64url(JSON({createdAt, runId})). */
function encodeRunsCursor(c: { createdAt: string; runId: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url');
}

function decodeRunsCursor(s: string): { createdAt: string; runId: string } | null {
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as { createdAt?: unknown; runId?: unknown };
    if (typeof parsed.createdAt === 'string' && typeof parsed.runId === 'string') {
      return { createdAt: parsed.createdAt, runId: parsed.runId };
    }
    return null;
  } catch {
    return null;
  }
}

/** The execution_runs columns `handleRunsList` projects for each page row. */
interface RunSummaryRow {
  run_id: string;
  routing_key: string | null;
  repo_identifier: string | null;
  status: string;
  created_at: Date;
  completed_at: Date | null;
  workflow_name: string;
  provider: string;
  ref: string;
  sha: string;
  started_at: Date;
  duration_ms: number | null;
  parent_run_id: string | null;
  original_run_id: string | null;
  triggered_by: string | null;
  cancelled_by: string | null;
  failure_reason: string | null;
}

/**
 * Map one `execution_runs` page row plus its enrichment lookups into the
 * customer run-summary shape (`DashboardRunSummary`). Every optional field is
 * omitted when the orchestrator can't supply it, so the reused customer runs
 * page degrades cleanly to '—'.
 *
 * Deliberately omitted because the orchestrator has no source for them:
 * - `commitMessage` — no commit-message column on `execution_runs`.
 * - `triggerEvent` — no trigger-event column (the run's `provider` is NOT the
 *   trigger event, so it must not be substituted).
 * - resolved user-display objects (`triggeredByUser` / `cancelledByUser`) —
 *   not part of the enriched schema; only the raw `triggeredBy` / `cancelledBy`
 *   identity strings are mapped.
 */
function mapRunSummary(
  r: RunSummaryRow,
  jobAggregates: Map<string, { jobCount: number; compileJobId: string | null }>,
  sourceIdentities: Map<string, { name: string | null; subtype: string; provider: string }>,
): DashboardRunSummary {
  const agg = jobAggregates.get(r.run_id);
  const routingKey = r.routing_key ?? '';
  const identity = r.routing_key ? sourceIdentities.get(r.routing_key) : undefined;

  return {
    runId: r.run_id,
    routingKey,
    repoIdentifier: r.repo_identifier ?? undefined,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    ...(r.completed_at ? { updatedAt: r.completed_at.toISOString() } : {}),
    ...(r.workflow_name ? { workflowName: r.workflow_name } : {}),
    ...(r.sha ? { sha: r.sha } : {}),
    ...(r.ref ? { ref: r.ref } : {}),
    ...(r.started_at ? { startedAt: r.started_at.toISOString() } : {}),
    ...(r.completed_at ? { completedAt: r.completed_at.toISOString() } : {}),
    ...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
    ...(r.parent_run_id ? { parentRunId: r.parent_run_id } : {}),
    ...(r.original_run_id ? { originalRunId: r.original_run_id } : {}),
    ...(r.triggered_by ? { triggeredBy: r.triggered_by } : {}),
    ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
    ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
    ...(agg ? { jobCount: agg.jobCount, hadCompileJob: agg.compileJobId !== null } : {}),
    ...(agg?.compileJobId ? { compileJobId: agg.compileJobId } : {}),
    source: {
      routingKey,
      name: identity?.name ?? null,
      subtype: identity?.subtype ?? r.provider,
      provider: identity?.provider ?? r.provider,
    },
  };
}
