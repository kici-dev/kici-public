/**
 * Answers the Platform's dashboard.* and run.* WS messages from the local
 * execution tables and LogStorage.
 */
import { compareStepRowsForDisplay, setupStepsFirst } from '../reporting/step-display-order.js';
import { HeldRunCancelRefusedError } from '../cancel/cancel-run.js';
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type {
  AccessLogAction,
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
  DashboardAdminTokensListRequest,
  DashboardAdminTokensListResponse,
  DashboardStepLogsRequest,
  DashboardAttestationsListRequest,
  DashboardAttestationsListAllRequest,
  DashboardAttestationGetRequest,
  DashboardAttestationRetryRequest,
  AttestationListItem,
  AttestationListSummary,
  DashboardPayloadRequest,
  DashboardOrchLogsRequest,
  DashboardEventLogListRequest,
  DashboardEventLogActivityRequest,
  EventLogActivityCounts,
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
  DashboardRunStructuredRequest,
  DashboardArtifactsListRequest,
  TrustTier,
} from '@kici-dev/engine';
import {
  AccessLogAction as AccessLogActionEnum,
  dashboardRunDetailApiResponseSchema,
  dashboardStepLogsApiResponseSchema,
  dashboardArtifactsListResponseSchema,
  dashboardAttestationsListResponseSchema,
  dashboardAttestationsListAllResponseSchema,
  dashboardAttestationGetResponseSchema,
  attestationVerifyStatusSchema,
  agentLabelOf,
  stringifyActor,
  EventLogStatus,
  EventLogSource,
  PayloadOmittedReason,
  EVENT_LOG_PAYLOAD_CHUNK_BYTES,
  EventLogPayloadStreamError,
  SourceOrigin,
  AttestationOrigin,
} from '@kici-dev/engine';
import { gunzipSync } from 'node:zlib';
import type { Database } from '../db/types.js';
import { groupNeedsByJobName } from './needs-edges.js';
import {
  applyAttestationFilters,
  baseAttestationsQuery,
  basePendingAttestationsQuery,
} from './attestation-filters.js';

/** Page size for the org-wide attestations list (offset+count pagination). */
const ATTESTATIONS_PAGE_SIZE = 25;
import {
  buildRunDetailJobs,
  aggregateRunDetail,
  type RunDetailJobLookups,
} from '../reporting/run-aggregator.js';
import { mapToAgentRunResult } from '../reporting/agent-run-result-mapper.js';
import type { LogStorage } from '../reporting/log-storage.js';
import { resolveStepLogPath } from '../reporting/step-log-reader.js';
import type { CacheStorage } from '../storage/types.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { EventStore } from '../events/event-store.js';
import { redactEventPayload } from '../events/types.js';
import { loadEventLogByDeliveryId } from '../cold-store/load-event-log-range.js';
import { webhookPayloadPath } from '../pipeline/webhook-payload-store.js';
import type { RunStartAnswer } from '../pipeline/request-idempotency.js';
import type { DashboardWriteOperation } from '@kici-dev/engine/protocol/dashboard-write-operations';
import {
  assertDashboardWriteAllowed,
  buildPolicyDeniedResponse,
  DashboardWritePolicyDisabledError,
} from '../policy/dashboard-write-policy.js';
import { DashboardAccessRecorder } from '../ws/dashboard-access.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const logger = createLogger({ prefix: 'dashboard-handler' });

interface DashboardHandlerDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
  /**
   * The orchestrator's own provenance issuer (`KICI_ORCHESTRATOR_PROVENANCE_ISSUER`)
   * when it owns signing. The Platform returns it as `trustedIssuer`, so the
   * dashboard / CLI verify against the orchestrator that signed the bundles.
   */
  provenanceSigningIssuer?: string | null;
  /**
   * The cache storage backend attestation bundles are written to. The handler
   * inlines each bundle (by `storage_key`) so the dashboard verifies it
   * client-side without a second fetch. Absent (no provenance configured) ⇒ an
   * `error` reply with an empty list.
   */
  provenanceStorage?: CacheStorage | null;
  /**
   * Backs `dashboard.artifacts.list` (a presigned GET per artifact). Absent (no
   * DB / cache storage) ⇒ an `error` reply with an empty list.
   */
  artifactStore?: ArtifactStore | null;
  /**
   * Drain the deferred-attestation outbox on demand (mints in this process,
   * which owns the Platform WS). Backs `dashboard.attestation.retry`.
   */
  retryAttestations?: (opts: {
    runId?: string;
  }) => Promise<{ minted: number; stillPending: number }>;
  send: (msg: unknown) => void;
  /** Included in job detail responses. */
  orchestratorId?: string;
  /** Records one row per read / mutation with actor attribution. */
  accessLog?: AccessLogWriter;
  /** Org ID for access_log rows (null when the orchestrator isn't org-scoped). */
  orgId?: string | null;
  /** Routing key for access_log rows (null when not run-scoped). */
  routingKey?: string | null;
  /**
   * Run / job / step lookups fall through to this S3 cold store once a row ages
   * out of PG; `null` serves PG rows only.
   */
  coldStore?: ColdStore | null;
  /**
   * Throws on failure. `routingKey` comes from the Platform's denormalized
   * `execution_runs.routing_key`, so the cold-store probe uses the right tenant
   * prefix when the run row is missing from PG. It is optional for mixed-deploy
   * back-compat; absent ⇒ the legacy "no PG row → throw" path.
   */
  onRerun: (
    runId: string,
    triggeredBy: string | null,
    triggeredByAgentLabel: string | null,
    /**
     * Platform-minted `requestId` for this rerun. Stable across an HA relay
     * failover re-send, so the orchestrator uses it as an idempotency key: a
     * re-sent request returns the first coordinator's run instead of minting a
     * second one.
     */
    requestId: string,
    routingKey?: string,
  ) => Promise<RunStartAnswer>;
  /** Throws on failure. `force` force-cancels (SIGKILL, skip hooks). */
  onCancel: (
    runId: string,
    cancelledBy: string | null,
    cancelledByAgentLabel: string | null,
    force?: boolean,
    // `alreadyTerminal` is optional so a caller that cannot distinguish the case
    // (and every test double) satisfies the type; it is forwarded when present.
  ) => Promise<{ cancelledJobs: number; alreadyTerminal?: boolean }>;
  /** Throws on failure. */
  onManualSchedule: (
    registrationId: string,
    triggeredBy: string | null,
    triggeredByAgentLabel: string | null,
    /**
     * Platform-minted `requestId` for this manual schedule. Used as an
     * idempotency key so an HA relay failover re-send returns the first
     * coordinator's run instead of minting a second one.
     */
    requestId: string,
  ) => Promise<RunStartAnswer>;
  /**
   * Backs the per-org DLQ surface (wired by `bootstrapOrchestrator`). Absent ⇒
   * `handleEventDlq*` replies with a structured `error`, which the dashboard
   * renders as an empty state.
   */
  eventStore?: EventStore | null;
  /**
   * **Test-only fault injection**, supplied only by the build-time test double:
   * awaited before `onRerun` so an HA test can slow the first coordinator into
   * a relay failover. The shipped default is undefined (no delay).
   */
  beforeRerun?: () => Promise<void>;
}

/** The run's own workflow, naming a job row that records none (see `jobWorkflowName`). */
function runWorkflowLookup(
  run: { workflow_name: string | null; is_test_run: boolean | null } | undefined,
): Pick<RunDetailJobLookups, 'runWorkflow'> {
  if (!run?.workflow_name) return {};
  return {
    runWorkflow: { workflow_name: run.workflow_name, is_test_run: run.is_test_run === true },
  };
}

export class DashboardHandler {
  private readonly db: Kysely<Database>;
  private readonly logStorage: LogStorage;
  private readonly provenanceStorage: CacheStorage | null;
  private readonly artifactStore: ArtifactStore | null;
  private readonly send: (msg: unknown) => void;
  private readonly orchestratorId: string | undefined;
  private readonly accessLog: AccessLogWriter | undefined;
  private readonly access: DashboardAccessRecorder;
  private orgId: string | null;
  private routingKey: string | null;
  private readonly onRerun: DashboardHandlerDeps['onRerun'];
  private readonly onCancel: DashboardHandlerDeps['onCancel'];
  private readonly onManualSchedule: DashboardHandlerDeps['onManualSchedule'];
  private readonly coldStore: ColdStore | null;
  private readonly eventStore: EventStore | null;
  private readonly retryAttestations: DashboardHandlerDeps['retryAttestations'];
  private readonly provenanceSigningIssuer: string | null;
  private readonly beforeRerun: (() => Promise<void>) | undefined;

  constructor(deps: DashboardHandlerDeps) {
    this.db = deps.db;
    this.logStorage = deps.logStorage;
    this.provenanceSigningIssuer = deps.provenanceSigningIssuer ?? null;
    this.provenanceStorage = deps.provenanceStorage ?? null;
    this.artifactStore = deps.artifactStore ?? null;
    this.send = deps.send;
    this.orchestratorId = deps.orchestratorId;
    this.accessLog = deps.accessLog;
    this.access = new DashboardAccessRecorder(
      deps.accessLog,
      () => ({ orgId: this.orgId, routingKey: this.routingKey }),
      logger,
    );
    this.orgId = deps.orgId ?? null;
    this.routingKey = deps.routingKey ?? null;
    this.onRerun = deps.onRerun;
    this.onCancel = deps.onCancel;
    this.onManualSchedule = deps.onManualSchedule;
    this.coldStore = deps.coldStore ?? null;
    this.eventStore = deps.eventStore ?? null;
    this.retryAttestations = deps.retryAttestations;
    this.beforeRerun = deps.beforeRerun;
  }

  /**
   * Called from server.ts after resolving the single tenant org from the
   * `sources`, `generic_webhook_sources` or `remote_sources` table.
   *
   * The binding is only the **fallback** access_log scope: run-targeted
   * handlers resolve the run-owning org per request via `resolveOrgForRun`
   * and use the bound pair only when that yields nothing (e.g. cold-archived
   * run, deleted source). On a multi-tenant
   * orchestrator the bound pair is non-deterministic (server.ts `onAuthenticated`
   * picks the first row from a `LIMIT 1` query with no `ORDER BY`), so it
   * MUST NOT be the source of truth for `access_log.org_id`.
   */
  setOrgContext(orgId: string | null, routingKey: string | null): void {
    this.orgId = orgId;
    this.routingKey = routingKey;
  }

  /**
   * Null when the run row is missing (e.g. cold-archived), so the caller falls
   * back to the bound context. Otherwise `routingKey` is set even when the
   * source row was deleted (best-effort attribution), and `orgId` is null only
   * when no source row matches the routing key.
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
   * GitHub-app `sources` first, then `generic_webhook_sources`. Also used
   * directly by `handleRerunRequest` with the Platform's `routingKey` hint.
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

    // Deleted source: keep the routing key and leave orgId null for
    // `contextOrFallback` to fill from the bound context.
    return { orgId: null, routingKey };
  }

  /** Null when the registration is missing (caller falls back to bound context). */
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
   * The merge point that makes the bound context a per-field fallback for a
   * per-target resolution, never the source of truth.
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
   * Defense-in-depth policy gate for the DLQ handlers: false when the policy
   * disables the op, after recording a `denied` row and sending the
   * `operation_disabled` envelope.
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
        this.access.recordIn(
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

  /** dashboard.run.detail: the run's nested job/step tree. */
  async handleRunDetail(msg: DashboardRunDetailRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      // Trust context is set for PR-triggered runs; init_failure for runs that
      // never executed a step.
      let runRow:
        | {
            trust_tier: string | null;
            lock_file_source: string | null;
            contributor_username: string | null;
            init_failure: InitFailure | null;
            check_mode: string | null;
            workflow_name: string | null;
            is_test_run: boolean | null;
          }
        | undefined = await this.db
        .selectFrom('execution_runs')
        .select([
          'trust_tier',
          'lock_file_source',
          'contributor_username',
          'init_failure',
          'check_mode',
          'workflow_name',
          'is_test_run',
        ])
        .where('run_id', '=', msg.runId)
        .executeTakeFirst();

      let jobs = await this.db
        .selectFrom('execution_jobs')
        .select([
          'job_id',
          'job_name',
          'workflow_name',
          'status',
          'matrix_values',
          'base_job_name',
          'variant_kind',
          'variant_label',
          'job_kind',
          'summoned_run_id',
          'agent_id',
          'started_at',
          'completed_at',
          'duration_ms',
          'error_message',
          'routing_reason',
          'runs_on_labels',
          'contexts',
          'skipped_contexts',
          'env_warning',
          'outputs',
          'init_failure',
        ])
        .where('run_id', '=', msg.runId)
        .orderBy('created_at', 'asc')
        .execute();

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
          'concurrency_kind',
          'group_id',
        ])
        .where('run_id', '=', msg.runId)
        .orderBy(setupStepsFirst())
        .orderBy('step_index', 'asc')
        .execute();

      // 0 PG jobs ⇒ archived (jobs + steps move to S3 in one archive cycle), so
      // run detail works for any run this orchestrator ever owned. Run-row trust
      // context is best-effort: archived runs may have had nulls anyway.
      if (jobs.length === 0 && this.coldStore && this.routingKey) {
        const cold = await this.fetchArchivedRunDetail(this.routingKey, msg.runId);
        if (cold.run && !runRow) runRow = cold.run;
        if (cold.jobs.length > 0) jobs = cold.jobs as typeof jobs;
        if (cold.steps.length > 0) steps = cold.steps as typeof steps;
      }

      // No run row and no jobs, hot or archived: this orchestrator does not hold
      // the run. Answer with an error, so the Platform falls back as
      // `orchestrator_error` rather than reporting that the run has no jobs.
      if (!runRow && jobs.length === 0) {
        this.sendRunDetailNotFound(ctx, msg);
        return;
      }

      // Secret output key names only: values are NOT sent to the dashboard.
      const secretOutputRows = await this.db
        .selectFrom('run_secret_outputs')
        .select(['job_id', 'output_key'])
        .where('run_id', '=', msg.runId)
        .execute();

      const secretKeysByJob = new Map<string, string[]>();
      for (const row of secretOutputRows) {
        let keys = secretKeysByJob.get(row.job_id);
        if (!keys) {
          keys = [];
          secretKeysByJob.set(row.job_id, keys);
        }
        keys.push(row.output_key);
      }

      const stepsByJob = new Map<string, typeof steps>();
      for (const step of steps) {
        let jobSteps = stepsByJob.get(step.job_id);
        if (!jobSteps) {
          jobSteps = [];
          stepsByJob.set(step.job_id, jobSteps);
        }
        jobSteps.push(step);
      }

      // The resolved edges the needs-scheduler enforced: dynamic-group edges are
      // already concrete job-name edges here.
      const needsRows = await this.db
        .selectFrom('execution_job_needs')
        .select(['job_name', 'upstream_name', 'run_on'])
        .where('run_id', '=', msg.runId)
        .execute();
      const needsByJob = groupNeedsByJobName(needsRows);

      const responseJobs = buildRunDetailJobs(jobs, {
        stepsByJob,
        secretKeysByJob,
        needsByJob,
        ...runWorkflowLookup(runRow),
      });

      const trustContext =
        runRow?.trust_tier || runRow?.lock_file_source || runRow?.contributor_username
          ? {
              trustTier: (runRow.trust_tier as TrustTier | null) ?? null,
              lockFileSource: (runRow.lock_file_source as 'head' | 'base' | null) ?? null,
              contributorUsername: runRow.contributor_username ?? null,
            }
          : undefined;

      // E.g. lock-file fetch or build coordination failed; the dashboard
      // renders a banner with the reason.
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
        this.access.recordIn(
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

      this.access.recordIn(
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

      this.access.recordIn(
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

  /** Answer a run-detail read for a run this orchestrator does not hold. */
  private sendRunDetailNotFound(
    ctx: ReturnType<DashboardHandler['contextOrFallback']>,
    msg: DashboardRunDetailRequest,
  ): void {
    this.access.recordIn(
      ctx,
      msg.actor,
      'run.detail.read',
      { type: 'run', id: msg.runId },
      msg.requestId,
      'error',
      'run not found',
    );
    this.send({
      type: 'dashboard.run.detail.response',
      requestId: msg.requestId,
      jobs: [],
      error: 'Run not found',
    });
  }

  /**
   * dashboard.run.structured: the user-plane twin of the orchestrator-admin
   * `/runs/:id/structured` endpoint, byte-identical because it reuses the
   * aggregator + provenance mapper. The `run.structured.read` access-log row
   * carries the agent label when the actor came through an agent PAT.
   */
  async handleRunStructured(msg: DashboardRunStructuredRequest): Promise<void> {
    const start = Date.now();
    // The org context only feeds the access-log row, so resolve it concurrently
    // with the aggregate. With aggregateRunDetail's concurrent child-row reads,
    // this keeps the read within the fixed relay-timeout budget even when a
    // concurrent execution contends the Postgres pool.
    const resolvedPromise = this.resolveOrgForRun(msg.runId);
    try {
      const [detail, resolved] = await Promise.all([
        aggregateRunDetail(this.db, msg.runId),
        resolvedPromise,
      ]);
      const ctx = this.contextOrFallback(resolved);
      const result = detail ? mapToAgentRunResult(detail) : null;
      this.access.recordIn(
        ctx,
        msg.actor,
        'run.structured.read',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'allowed',
      );
      logger.info('Served dashboard.run.structured', {
        runId: msg.runId,
        durationMs: Date.now() - start,
        jobCount: detail?.jobs.length ?? 0,
        stepCount: detail ? detail.jobs.reduce((n, j) => n + j.steps.length, 0) : 0,
      });
      this.send({
        type: 'dashboard.run.structured.response',
        requestId: msg.requestId,
        result,
      });
    } catch (err) {
      // The org-resolve may have succeeded even though the aggregate failed.
      const ctx = this.contextOrFallback(await resolvedPromise.catch(() => null));
      logger.error('Error handling dashboard.run.structured', {
        runId: msg.runId,
        durationMs: Date.now() - start,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
        ctx,
        msg.actor,
        'run.structured.read',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.run.structured.response',
        requestId: msg.requestId,
        result: null,
        error: 'Internal error querying structured run result',
      });
    }
  }

  /**
   * The orchestrator is single-org but multi-routing-key: one org owns one
   * GitHub-app source plus N generic sources. `execution_runs` has no `org_id`;
   * ownership is only `routing_key → sources.customer_id` /
   * `generic_webhook_sources.customer_id`, so an org-scoped run query scopes to
   * the union of the org's routing keys.
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
   * Same name/subtype/provider derivation as `handleSourcesList`, so a run
   * summary's `source` block matches the sources page. Keys with no live source
   * row are absent (the caller falls back to the run's own provider).
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
   * Per-run `jobCount` plus compile-job markers (`hadCompileJob` /
   * `compileJobId`) for one page, in one query. Runs with no job rows are
   * absent (the caller omits the fields).
   */
  private async resolveRunJobAggregates(
    runIds: string[],
  ): Promise<Map<string, { jobCount: number; compileJobId: string | null; contexts: string[] }>> {
    const map = new Map<
      string,
      { jobCount: number; compileJobId: string | null; contexts: string[] }
    >();
    if (runIds.length === 0) return map;

    const jobRows = await this.db
      .selectFrom('execution_jobs')
      .select(['run_id', 'job_id', 'job_name', 'contexts'])
      .where('run_id', 'in', runIds)
      .execute();

    for (const j of jobRows) {
      let agg = map.get(j.run_id);
      if (!agg) {
        agg = { jobCount: 0, compileJobId: null, contexts: [] };
        map.set(j.run_id, agg);
      }
      agg.jobCount += 1;
      // The synthetic `__build__*` compile job, as the Platform run-list route
      // defines it (`job_name LIKE '__build__%'`); its id backs the compile-step link.
      if (j.job_name.startsWith('__build__') && !agg.compileJobId) {
        agg.compileJobId = j.job_id;
      }
      // Distinct bound contexts across the run's jobs, in first-seen order.
      if (j.contexts) {
        const names = (
          typeof j.contexts === 'string'
            ? (JSON.parse(j.contexts) as string[])
            : (j.contexts as string[])
        ).filter((n) => !agg!.contexts.includes(n));
        agg.contexts.push(...names);
      }
    }

    return map;
  }

  /**
   * dashboard.runs.list: a page of run summaries scoped to ALL routing keys of
   * the bound org. The bound `this.routingKey` is just ONE of them (picked
   * non-deterministically at startup), so filtering on it alone would drop runs
   * under a sibling key. Attribution uses the bound `orgId` / `routingKey`
   * directly, like the org-scoped event-log / access-log handlers.
   *
   * Serves the operator console (`support-read` break-glass) and the run-list
   * view. The access_log row carries the wire actor (including the
   * platform_operator reason) so the customer can audit any operator read.
   */
  async handleRunsList(msg: DashboardRunsListRequest): Promise<DashboardRunsListResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    try {
      const limit = Math.min(Math.max(msg.limit ?? 50, 1), 200);

      // Unbound orchestrator (no org resolved yet) — nothing to scope to.
      if (!this.orgId) {
        this.access.recordIn(
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

      // No live sources ⇒ an empty page, never an unbounded query.
      const routingKeys = await this.resolveOrgRoutingKeys(this.orgId);
      if (routingKeys.length === 0) {
        this.access.recordIn(
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
          'triggered_by_agent_label',
          'cancelled_by',
          'cancelled_by_agent_label',
          'failure_reason',
        ])
        .where('routing_key', 'in', routingKeys);

      // Cursor: { createdAt: ISO, runId }. Stable on the (created_at, run_id) pair.
      if (msg.cursor) {
        const cur = decodeCursor(msg.cursor, ['createdAt', 'runId']);
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

      // Enrichment lookups are skipped for an empty page.
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
              new Map<
                string,
                { jobCount: number; compileJobId: string | null; contexts: string[] }
              >(),
              new Map<string, { name: string | null; subtype: string; provider: string }>(),
            ];

      const runs = pageRows.map((r) => mapRunSummary(r, jobAggregates, sourceIdentities));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow
          ? encodeCursor({ createdAt: lastRow.created_at.toISOString(), runId: lastRow.run_id })
          : undefined;

      this.access.recordIn(
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
      this.access.recordIn(
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
   * dashboard.runs.filters: the distinct filter-option values for the customer
   * runs page, with `handleRunsList`'s scoping and attribution. Values come
   * in-memory from one column projection over `execution_runs`; `sources`
   * reuses `resolveSourceIdentities` to match the sources page.
   *
   * `triggerTypes` comes from `execution_runs.provider` (`github` / `generic` /
   * `local`): with no trigger-event column, it is the closest discriminator.
   * The access_log row carries the wire actor (including the platform_operator
   * reason) so the customer can audit any operator read.
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
        this.access.recordIn(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['runs.filters.read'],
          null,
          msg.requestId,
          'allowed',
        );
        return emptyResponse;
      }

      // No live sources ⇒ empty options, never an unbounded query.
      const routingKeys = await this.resolveOrgRoutingKeys(this.orgId);
      if (routingKeys.length === 0) {
        this.access.recordIn(
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

      this.access.recordIn(
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
      this.access.recordIn(
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
   * dashboard.sources.list: the bound org's GitHub-app `sources` plus live
   * `generic_webhook_sources`, unpaginated because counts are tiny (`msg.limit`
   * is ignored). Secret-bearing columns (`config`, `git_config`,
   * `verification_config`) are never returned; `git_config` is read only to
   * derive the subtype. Attribution follows `handleRunsList`; the access_log
   * row carries the wire actor so the customer can audit any operator read.
   */
  async handleSourcesList(msg: DashboardSourcesListRequest): Promise<DashboardSourcesListResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    try {
      if (!this.orgId) {
        this.access.recordIn(
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

      this.access.recordIn(
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
      this.access.recordIn(
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
   * dashboard.admin-tokens.list: the live admin-token inventory for the
   * Platform's RBAC drift report. `admin_tokens` is orchestrator-wide (one org
   * per orchestrator), so there is no `orgId` filter; the bound context
   * attributes the row. Revoked or expired tokens are not findings, so they
   * are left out as noise.
   *
   * `token_hash` is never selected: a hash is a credential verifier, and
   * relaying one would put an offline-crackable value on the dashboard plane.
   * Reading who holds admin tokens is privileged, so every read writes an
   * access_log row carrying the wire actor.
   */
  async handleAdminTokensList(
    msg: DashboardAdminTokensListRequest,
  ): Promise<DashboardAdminTokensListResponse> {
    const ctx = { orgId: this.orgId, routingKey: this.routingKey };
    try {
      const rows = await this.db
        .selectFrom('admin_tokens')
        .select([
          'id',
          'label',
          'role',
          'subject',
          'routing_key',
          'created_at',
          'expires_at',
          'last_used_at',
          'revoked',
        ])
        .where('revoked', '=', false)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]),
        )
        .orderBy('created_at', 'desc')
        .execute();

      const tokens = rows.map((r) => ({
        id: r.id,
        label: r.label,
        role: r.role,
        subject: r.subject ?? null,
        routingKey: r.routing_key ?? null,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
        revoked: r.revoked,
      }));

      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['admin_tokens.list.read'],
        null,
        msg.requestId,
        'allowed',
      );
      return { type: 'dashboard.admin-tokens.list.response', requestId: msg.requestId, tokens };
    } catch (err) {
      logger.error('Error handling dashboard.admin-tokens.list', { error: toErrorMessage(err) });
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['admin_tokens.list.read'],
        null,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      return {
        type: 'dashboard.admin-tokens.list.response',
        requestId: msg.requestId,
        tokens: [],
        error: 'Internal error querying admin tokens',
      };
    }
  }

  /** dashboard.step.logs: reads the step's log_path from LogStorage. */
  async handleStepLogs(msg: DashboardStepLogsRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      // The workflow-level log (step -1: the job's setup narration) has no step
      // row; the shared reader derives its key. A job that wrote none reads as
      // an empty page rather than an error, so a client can probe for it.
      // fails-when: step -1 goes through the row lookup below and always
      // answers "Step not found".
      const isWorkflowLog = msg.stepIndex < 0;
      const step = isWorkflowLog
        ? {
            log_path:
              (await resolveStepLogPath({ db: this.db, logStorage: this.logStorage }, msg)) ?? '',
          }
        : await this.db
            .selectFrom('execution_steps')
            .select(['log_path'])
            .where('run_id', '=', msg.runId)
            .where('job_id', '=', msg.jobId)
            .where('step_index', '=', msg.stepIndex)
            .executeTakeFirst();

      if (!step) {
        this.access.recordIn(
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
        this.access.recordIn(
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
          // breaks-if-wrong: a regular step with no log path still reports why.
          // fails-when: a job that wrote no setup log reads like one whose log is empty
          ...(isWorkflowLog
            ? { nextCursor: null, recorded: false }
            : { error: 'No logs available' }),
        });
        return;
      }

      const result = await this.logStorage.read(step.log_path);
      const allLines = result.data.split('\n').filter(Boolean);
      const totalLines = allLines.length;

      // Unbounded by default (the human dashboard relies on this); a caller
      // (the MCP step-logs tool) opts into paging by sending an explicit limit.
      const offset = msg.cursor ? Math.max(0, parseInt(msg.cursor, 10) || 0) : 0;
      const page = msg.limit ? allLines.slice(offset, offset + msg.limit) : allLines.slice(offset);
      const nextOffset = offset + page.length;
      const nextCursor = nextOffset < totalLines ? String(nextOffset) : null;

      // Validate outgoing response against engine schema (double validation)
      const validated = dashboardStepLogsApiResponseSchema.safeParse({
        lines: page,
        totalLines,
        nextCursor,
        recorded: true,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.step.logs response validation failed', {
          runId: msg.runId,
          jobId: msg.jobId,
          stepIndex: msg.stepIndex,
          errors: validated.error.issues,
        });
        this.access.recordIn(
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
          nextCursor: null,
          error: 'Internal error: response validation failed',
        });
        return;
      }

      this.access.recordIn(
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
        nextCursor: validated.data.nextCursor ?? null,
        recorded: validated.data.recorded,
      });
    } catch (err) {
      logger.error('Error handling dashboard.step.logs', {
        runId: msg.runId,
        jobId: msg.jobId,
        stepIndex: msg.stepIndex,
        error: toErrorMessage(err),
      });

      this.access.recordIn(
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

  /** Oldest-first so the dashboard table is stable. */
  private async resolveAttestationsForRun(runId: string) {
    // `attestations` ids are TEXT and `execution_jobs` ids are `uuid`; Postgres
    // won't compare `uuid = text` implicitly, so the uuid side is cast to text.
    return this.db
      .selectFrom('attestations')
      .innerJoin('execution_jobs', (join) =>
        join
          .on(sql`execution_jobs.job_id::text`, '=', sql.ref('attestations.job_id'))
          .on(sql`execution_jobs.run_id::text`, '=', sql.ref('attestations.run_id')),
      )
      .leftJoin('execution_runs', (join) =>
        join.on(sql`execution_runs.run_id::text`, '=', sql.ref('attestations.run_id')),
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
        'execution_runs.local_working_tree as localWorkingTree',
      ])
      .where('attestations.run_id', '=', runId)
      .orderBy('attestations.created_at', 'asc')
      .execute();
  }

  /**
   * dashboard.attestations.list: the run's attestations with each bundle
   * inlined for client-side verification. A row whose bundle can't be read is
   * skipped rather than failing the whole list.
   */
  async handleAttestationsList(msg: DashboardAttestationsListRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    const target = { type: 'run' as const, id: msg.runId };
    try {
      if (!this.provenanceStorage) {
        this.access.recordIn(
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
        const item = await this.inlineBundle(row);
        if (item) attestations.push(item);
      }

      const validated = dashboardAttestationsListResponseSchema.safeParse({
        type: 'dashboard.attestations.list.response',
        requestId: msg.requestId,
        attestations,
        trustedIssuer: this.provenanceSigningIssuer,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.attestations.list response validation failed', {
          runId: msg.runId,
          errors: validated.error.issues,
        });
        this.access.recordIn(
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

      this.access.recordIn(ctx, msg.actor, 'attestations.read', target, msg.requestId, 'allowed');
      this.send(validated.data);
    } catch (err) {
      logger.error('Error handling dashboard.attestations.list', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
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
   * dashboard.artifacts.list: a presigned GET per named artifact. The org comes
   * from the run row, never the wire, so the listing cannot cross tenants.
   */
  async handleArtifactsList(msg: DashboardArtifactsListRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    const target = { type: 'run' as const, id: msg.runId };
    try {
      if (!this.artifactStore || !ctx.orgId) {
        this.access.recordIn(
          ctx,
          msg.actor,
          'artifacts.read',
          target,
          msg.requestId,
          'error',
          this.artifactStore ? 'run org not resolvable' : 'artifact store not configured',
        );
        this.send({
          type: 'dashboard.artifacts.list.response',
          requestId: msg.requestId,
          artifacts: [],
          error: this.artifactStore
            ? 'Run organization not resolvable'
            : 'Artifact storage not configured',
        });
        return;
      }

      const { artifacts, downloadUrlExpiresInSeconds } =
        await this.artifactStore.listForRunWithUrls(ctx.orgId, msg.runId);
      const validated = dashboardArtifactsListResponseSchema.safeParse({
        type: 'dashboard.artifacts.list.response',
        requestId: msg.requestId,
        artifacts,
        downloadUrlExpiresInSeconds,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.artifacts.list response validation failed', {
          runId: msg.runId,
          errors: validated.error.issues,
        });
        this.access.recordIn(
          ctx,
          msg.actor,
          'artifacts.read',
          target,
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.artifacts.list.response',
          requestId: msg.requestId,
          artifacts: [],
          error: 'Internal error: response validation failed',
        });
        return;
      }

      this.access.recordIn(ctx, msg.actor, 'artifacts.read', target, msg.requestId, 'allowed');
      this.send(validated.data);
    } catch (err) {
      logger.error('Error handling dashboard.artifacts.list', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
        ctx,
        msg.actor,
        'artifacts.read',
        target,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.artifacts.list.response',
        requestId: msg.requestId,
        artifacts: [],
        error: 'Internal error reading artifacts',
      });
    }
  }

  /** Null (logged) when the bundle is missing or not valid JSON. */
  private async inlineBundle(row: {
    id: string;
    jobId: string;
    jobName: string | null;
    subjectName: string;
    subjectDigest: string;
    mode: string;
    mediaType: string;
    storageKey: string;
    createdAt: Date | string;
    localWorkingTree?: boolean | null;
  }): Promise<AttestationListItem | null> {
    if (!this.provenanceStorage) return null;
    const raw = await this.provenanceStorage.get(row.storageKey);
    if (!raw) {
      logger.warn('Attestation bundle missing from object storage', {
        attestationId: row.id,
        storageKey: row.storageKey,
      });
      return null;
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(raw.toString('utf-8'));
    } catch (parseErr) {
      logger.warn('Attestation bundle is not valid JSON', {
        attestationId: row.id,
        error: toErrorMessage(parseErr),
      });
      return null;
    }
    return {
      id: row.id,
      jobId: row.jobId,
      jobName: row.jobName ?? null,
      subjectName: row.subjectName,
      subjectDigest: row.subjectDigest,
      mode: row.mode,
      mediaType: row.mediaType,
      createdAt: new Date(row.createdAt).toISOString(),
      bundle: bundle as AttestationListItem['bundle'],
      // Source-origin brand: a kici run remote run executes a local working-tree
      // overlay, so its repo/ref/sha are caller-supplied, not VCS-verified.
      sourceOrigin: row.localWorkingTree
        ? SourceOrigin.enum['run-remote']
        : SourceOrigin.enum.triggered,
      // Authoritative origin: this orchestrator's bound org id.
      ...(this.orgId ? { originOrgId: this.orgId } : {}),
    };
  }

  /** One page of metadata-only summaries (no bundle fetch) plus the total count. */
  private async resolveAttestationsListAll(
    filters: DashboardAttestationsListAllRequest['filters'],
    page: number,
  ): Promise<{ rows: AttestationListSummary[]; total: number; pageSize: number }> {
    const offset = Math.max(0, page - 1) * ATTESTATIONS_PAGE_SIZE;
    const rows = await applyAttestationFilters(baseAttestationsQuery(this.db), filters)
      .select([
        'attestations.id as id',
        'attestations.run_id as runId',
        'attestations.job_id as jobId',
        'execution_jobs.job_name as jobName',
        'attestations.subject_name as subjectName',
        'attestations.subject_digest as subjectDigest',
        'attestations.mode as mode',
        'attestations.media_type as mediaType',
        'attestations.created_at as createdAt',
        'attestations.verify_status as verifyStatus',
        'attestations.verify_reason as verifyReason',
        'execution_runs.repo_identifier as repository',
        'execution_runs.workflow_name as workflow',
        'execution_runs.local_working_tree as localWorkingTree',
      ])
      .orderBy('attestations.created_at', 'desc')
      .limit(ATTESTATIONS_PAGE_SIZE)
      .offset(offset)
      .execute();

    const countRow = await applyAttestationFilters(baseAttestationsQuery(this.db), filters)
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();

    const summaries: AttestationListSummary[] = rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      jobId: row.jobId,
      jobName: row.jobName ?? null,
      subjectName: row.subjectName,
      subjectDigest: row.subjectDigest,
      mode: row.mode,
      mediaType: row.mediaType,
      createdAt: new Date(row.createdAt).toISOString(),
      verifyStatus: attestationVerifyStatusSchema
        .catch(attestationVerifyStatusSchema.enum.pending)
        .parse(row.verifyStatus),
      verifyReason: row.verifyReason ?? null,
      repository: row.repository ?? null,
      workflow: row.workflow ?? null,
      sourceOrigin: row.localWorkingTree
        ? SourceOrigin.enum['run-remote']
        : SourceOrigin.enum.triggered,
    }));

    // Deferred attestations awaiting a mint show on page 1 only, with a `pending`
    // badge + retry action. No status/name filter applies: a pending row has
    // no bundle and no verdict.
    const pendingSummaries =
      page <= 1 && !filters.status ? await this.resolvePendingAttestationSummaries() : [];

    return {
      rows: [...pendingSummaries, ...summaries],
      total: Number(countRow?.count ?? 0) + pendingSummaries.length,
      pageSize: ATTESTATIONS_PAGE_SIZE,
    };
  }

  private async resolvePendingAttestationSummaries(): Promise<AttestationListSummary[]> {
    const rows = await basePendingAttestationsQuery(this.db)
      .select([
        'pending_attestations.id as id',
        'pending_attestations.run_id as runId',
        'pending_attestations.job_id as jobId',
        'execution_jobs.job_name as jobName',
        'pending_attestations.subject_name as subjectName',
        'pending_attestations.subject_digest as subjectDigest',
        'pending_attestations.media_type as mediaType',
        'pending_attestations.origin_kind as originKind',
        'pending_attestations.created_at as createdAt',
        'execution_runs.repo_identifier as repository',
        'execution_runs.workflow_name as workflow',
        'execution_runs.local_working_tree as localWorkingTree',
      ])
      .orderBy('pending_attestations.created_at', 'desc')
      .limit(ATTESTATIONS_PAGE_SIZE)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      jobId: row.jobId,
      jobName: row.jobName ?? null,
      subjectName: row.subjectName,
      subjectDigest: row.subjectDigest,
      mode: 'kici',
      mediaType: row.mediaType,
      createdAt: new Date(row.createdAt).toISOString(),
      verifyStatus: attestationVerifyStatusSchema.enum.pending,
      verifyReason: null,
      repository: row.repository ?? null,
      workflow: row.workflow ?? null,
      sourceOrigin: row.localWorkingTree
        ? SourceOrigin.enum['run-remote']
        : SourceOrigin.enum.triggered,
      attestationOrigin: AttestationOrigin.safeParse(row.originKind).success
        ? (row.originKind as 'deferred' | 'offline-backfill')
        : AttestationOrigin.enum.deferred,
      pending: true,
    }));
  }

  /** Org-wide, metadata only; access-logged against the `attestation` target. */
  async handleAttestationsListAll(msg: DashboardAttestationsListAllRequest): Promise<void> {
    const ctx = this.contextOrFallback(null);
    const target = { type: 'attestation' as const, id: 'list' };
    try {
      const { rows, total, pageSize } = await this.resolveAttestationsListAll(
        msg.filters,
        msg.page,
      );
      const validated = dashboardAttestationsListAllResponseSchema.safeParse({
        type: 'dashboard.attestations.list.all.response',
        requestId: msg.requestId,
        attestations: rows,
        page: msg.page,
        pageSize,
        total,
        trustedIssuer: this.provenanceSigningIssuer,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.attestations.list.all response validation failed', {
          errors: validated.error.issues,
        });
        this.access.recordIn(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['attestations.read'],
          target,
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.attestations.list.all.response',
          requestId: msg.requestId,
          attestations: [],
          page: msg.page,
          pageSize: ATTESTATIONS_PAGE_SIZE,
          total: 0,
          error: 'Internal error: response validation failed',
        });
        return;
      }
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'allowed',
      );
      this.send(validated.data);
    } catch (err) {
      logger.error('Error handling dashboard.attestations.list.all', {
        error: toErrorMessage(err),
      });
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.attestations.list.all.response',
        requestId: msg.requestId,
        attestations: [],
        page: msg.page,
        pageSize: ATTESTATIONS_PAGE_SIZE,
        total: 0,
        error: 'Internal error reading attestations',
      });
    }
  }

  /**
   * Drains the deferred-attestation outbox (optionally one run's) in this
   * process, which owns the Platform WS.
   */
  async handleAttestationRetry(msg: DashboardAttestationRetryRequest): Promise<void> {
    const ctx = this.contextOrFallback(null);
    const target = { type: 'attestation' as const, id: msg.runId ?? 'all' };
    // Defense-in-depth: the orch refuses the drain when the operator has
    // switched `attestations.retry` off (CLI-only). Keyed on the bound org.
    if (
      !(await this.enforcePolicy(
        { actor: msg.actor, requestId: msg.requestId, orgId: this.orgId ?? '' },
        'attestations.retry',
        'dashboard.attestation.retry.response',
        AccessLogActionEnum.enum['attestations.read'],
        target,
        ctx,
      ))
    ) {
      return;
    }
    try {
      if (!this.retryAttestations) {
        throw new Error('deferred-attestation retry is not available on this orchestrator');
      }
      const result = await this.retryAttestations(msg.runId ? { runId: msg.runId } : {});
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.attestation.retry.response',
        requestId: msg.requestId,
        minted: result.minted,
        stillPending: result.stillPending,
      });
    } catch (err) {
      logger.error('Error handling dashboard.attestation.retry', { error: toErrorMessage(err) });
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.attestation.retry.response',
        requestId: msg.requestId,
        minted: 0,
        stillPending: 0,
        error: 'Failed to retry deferred attestations',
      });
    }
  }

  /**
   * One attestation with its bundle inlined, logged against the `attestation`
   * target under the run-owning org.
   */
  async handleAttestationGet(msg: DashboardAttestationGetRequest): Promise<void> {
    const target = { type: 'attestation' as const, id: msg.attestationId };
    let ctx = this.contextOrFallback(null);
    try {
      const row = await this.db
        .selectFrom('attestations')
        .innerJoin('execution_jobs', (join) =>
          join
            .on(sql`execution_jobs.job_id::text`, '=', sql.ref('attestations.job_id'))
            .on(sql`execution_jobs.run_id::text`, '=', sql.ref('attestations.run_id')),
        )
        .leftJoin('execution_runs', (join) =>
          join.on(sql`execution_runs.run_id::text`, '=', sql.ref('attestations.run_id')),
        )
        .select([
          'attestations.id as id',
          'attestations.run_id as runId',
          'attestations.job_id as jobId',
          'execution_jobs.job_name as jobName',
          'attestations.subject_name as subjectName',
          'attestations.subject_digest as subjectDigest',
          'attestations.mode as mode',
          'attestations.media_type as mediaType',
          'attestations.storage_key as storageKey',
          'attestations.created_at as createdAt',
          'attestations.verify_status as verifyStatus',
          'attestations.verify_reason as verifyReason',
          'execution_runs.local_working_tree as localWorkingTree',
        ])
        .where('attestations.id', '=', msg.attestationId)
        .executeTakeFirst();

      if (row) ctx = this.contextOrFallback(await this.resolveOrgForRun(row.runId));

      const inlined = row ? await this.inlineBundle(row) : null;
      // Backs the detail page's "view run" link and recorded badge.
      const attestation =
        inlined && row
          ? {
              ...inlined,
              runId: row.runId,
              verifyStatus: attestationVerifyStatusSchema
                .catch(attestationVerifyStatusSchema.enum.pending)
                .parse(row.verifyStatus),
              verifyReason: row.verifyReason ?? null,
            }
          : null;
      const validated = dashboardAttestationGetResponseSchema.safeParse({
        type: 'dashboard.attestation.get.response',
        requestId: msg.requestId,
        attestation,
        trustedIssuer: this.provenanceSigningIssuer,
      });
      if (!validated.success) {
        logger.error('Outgoing dashboard.attestation.get response validation failed', {
          attestationId: msg.attestationId,
          errors: validated.error.issues,
        });
        this.access.recordIn(
          ctx,
          msg.actor,
          AccessLogActionEnum.enum['attestations.read'],
          target,
          msg.requestId,
          'error',
          'response validation failed',
        );
        this.send({
          type: 'dashboard.attestation.get.response',
          requestId: msg.requestId,
          attestation: null,
          error: 'Internal error: response validation failed',
        });
        return;
      }
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'allowed',
      );
      this.send(validated.data);
    } catch (err) {
      logger.error('Error handling dashboard.attestation.get', {
        attestationId: msg.attestationId,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['attestations.read'],
        target,
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.attestation.get.response',
        requestId: msg.requestId,
        attestation: null,
        error: 'Internal error reading attestation',
      });
    }
  }

  async handlePayload(msg: DashboardPayloadRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    const payloadPath = webhookPayloadPath(msg.runId);
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
        // INFO, not warn: expected when the request reaches an orch that did not
        // ingest the webhook (fresh pool member, HA reroute). The caller retries
        // on another orch or treats it as 404.
        logger.info('Dashboard payload not found', {
          requestId: msg.requestId,
          runId: msg.runId,
          payloadPath,
          logStorageBackend: backend,
          orchestratorId: this.orchestratorId,
        });
        this.access.recordIn(
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
        this.access.recordIn(
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
      this.access.recordIn(
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

      this.access.recordIn(
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
   * Provisioning logs carry phase "provisioning" so the dashboard renders them
   * in a separate collapsible section.
   */
  async handleOrchLogs(msg: DashboardOrchLogsRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      const basePath = `executions/${msg.runId}/jobs/${msg.jobId}`;

      let orchLines: string[] = [];
      try {
        const orchResult = await this.logStorage.read(`${basePath}/orchestration.jsonl`);
        orchLines = orchResult.data.split('\n').filter(Boolean);
      } catch {
        // May not exist yet.
      }

      // Written by emitScalerEvent in execution-tracker.
      let provLines: string[] = [];
      try {
        const provResult = await this.logStorage.read(`${basePath}/provisioning.jsonl`);
        provLines = provResult.data.split('\n').filter(Boolean);
      } catch {
        // Absent for non-scaler runs.
      }

      const allLines = [...orchLines, ...provLines];

      this.access.recordIn(
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
      this.access.recordIn(
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
   * Org resolution prefers the Platform's `msg.routingKey` hint: it is the ONLY
   * org context once the run row is cold-archived out of PG. Without it,
   * `resolveOrgForRun` reads the warm PG row.
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
      // Test-only (see `beforeRerun`): exercises the requestId idempotency claim.
      if (this.beforeRerun) await this.beforeRerun();
      const result = await this.onRerun(
        msg.runId,
        stringifyActor(msg.actor),
        agentLabelOf(msg.actor),
        msg.requestId,
        msg.routingKey,
      );

      this.access.recordIn(
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
        ...(result.alreadyAccepted && { alreadyAccepted: true }),
      });
    } catch (err) {
      logger.error('Error handling run.rerun.request', {
        runId: msg.runId,
        error: toErrorMessage(err),
      });

      this.access.recordIn(
        ctx,
        msg.actor,
        'run.rerun',
        { type: 'run', id: msg.runId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      // A stable code lets the Platform proxy answer HTTP 410, not a generic 400.
      // Detected by shape, not `instanceof`, to avoid a type-level import of
      // `pipeline/rerun.ts`.
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

  async handleCancelRequest(msg: RunCancelRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRun(msg.runId));
    try {
      const result = await this.onCancel(
        msg.runId,
        stringifyActor(msg.actor),
        agentLabelOf(msg.actor),
        msg.force,
      );

      this.access.recordIn(
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
        ...(result.alreadyTerminal !== undefined && { alreadyTerminal: result.alreadyTerminal }),
      });
    } catch (err) {
      // A decision (an approve, a reject, an expiry) that reached the held run
      // first is an expected race: the cancel is refused, not failed, so it is
      // neither an error log nor an error outcome (the admin cancel route
      // records it the same way).
      // fails-when: the race is logged at error level with an 'error' outcome
      // breaks-if-wrong: any other cancel failure must still record 'error'
      const refused = err instanceof HeldRunCancelRefusedError;
      if (refused) {
        logger.info('Cancel refused: a decision reached the held run first', {
          runId: msg.runId,
          decision: err.decision,
        });
      } else {
        logger.error('Error handling run.cancel.request', {
          runId: msg.runId,
          error: toErrorMessage(err),
        });
      }

      this.access.recordIn(
        ctx,
        msg.actor,
        'run.cancel',
        { type: 'run', id: msg.runId },
        msg.requestId,
        refused ? 'allowed' : 'error',
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
   * Inbound webhook deliveries (`event_log`) for the org. The opaque
   * (received_at + id) cursor keeps concurrent inserts from shifting pages.
   * Every filter is optional; deliveryId matches a substring.
   */
  async handleEventLogList(msg: DashboardEventLogListRequest): Promise<void> {
    // The wire `orgId` is the source of truth for attribution. The bound routing
    // key applies only when no routingKey filter was supplied.
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
        const cur = decodeCursor(msg.cursor, ['receivedAt', 'id']);
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
          ? encodeCursor({
              receivedAt: pageRows[pageRows.length - 1].received_at.toISOString(),
              id: pageRows[pageRows.length - 1].id,
            })
          : null;

      this.access.recordIn(
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
      this.access.recordIn(
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
   * Windowed matched / unmatched / lockfile-missing counts: facts the Platform
   * relay cannot compute (it only sees "delivered"). Powers the Runs-page
   * misconfig strip + the `kici runs` hint. Counts only — no payloads, no repo
   * identifiers — so the Platform route serves them to all org members.
   */
  async handleEventLogActivity(msg: DashboardEventLogActivityRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: this.routingKey };
    try {
      const row = await this.db
        .selectFrom('event_log')
        .where('org_id', '=', msg.orgId)
        .where('received_at', '>=', new Date(msg.fromTimestamp))
        .where('received_at', '<', new Date(msg.toTimestamp))
        .select([
          sql<number>`count(*)`.as('total'),
          sql<number>`count(*) filter (where status = ${EventLogStatus.enum.processed} and matched_count > 0)`.as(
            'matched',
          ),
          sql<number>`count(*) filter (where status = ${EventLogStatus.enum.processed} and matched_count = 0)`.as(
            'unmatched',
          ),
          sql<number>`count(*) filter (where status = ${EventLogStatus.enum.lockfile_missing})`.as(
            'lockfileMissing',
          ),
          sql<number>`count(*) filter (where status = ${EventLogStatus.enum.lockfile_corrupt})`.as(
            'lockfileCorrupt',
          ),
          sql<number>`count(*) filter (where status = ${EventLogStatus.enum.failed})`.as('failed'),
        ])
        .executeTakeFirstOrThrow();

      const counts: EventLogActivityCounts = {
        total: Number(row.total),
        matched: Number(row.matched),
        unmatched: Number(row.unmatched),
        lockfileMissing: Number(row.lockfileMissing),
        lockfileCorrupt: Number(row.lockfileCorrupt),
        failed: Number(row.failed),
      };

      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['event_log.list.read'],
        { type: 'event_log', id: msg.orgId },
        msg.requestId,
        'allowed',
      );
      this.send({
        type: 'dashboard.event-log.activity.response',
        requestId: msg.requestId,
        counts,
      });
    } catch (err) {
      logger.error('Error handling dashboard.event-log.activity', {
        orgId: msg.orgId,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
        ctx,
        msg.actor,
        AccessLogActionEnum.enum['event_log.list.read'],
        { type: 'event_log', id: msg.orgId },
        msg.requestId,
        'error',
        toErrorMessage(err),
      );
      this.send({
        type: 'dashboard.event-log.activity.response',
        requestId: msg.requestId,
        error: 'Internal error querying webhook activity',
      });
    }
  }

  /**
   * Backs the dashboard "Data access" tab. Scopes on orgId, then applies each
   * optional filter independently. Its own `access_log.list.read` row is a
   * meta-audit of who looked at the audit log.
   */
  async handleAccessLogList(msg: DashboardAccessLogListRequest): Promise<void> {
    // `msg.orgId` attributes; routingKey is informational, so the bound value stays.
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
        agentLabel: msg.agentLabel,
        agentOnly: msg.agentOnly,
        limit: msg.limit,
        cursor: msg.cursor,
      });

      this.access.recordIn(
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
      this.access.recordIn(
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
   * Metadata only: the body streams over `handleEventLogPayloadStream`, so the
   * Platform never holds it in memory and the dashboard shows progress. With
   * `payload_omitted=true`, `payloadOmitted`/`payloadOmittedReason` tell the
   * dashboard to skip the stream request.
   */
  async handleEventLogDetail(msg: DashboardEventLogDetailRequest): Promise<void> {
    const ctx = { orgId: msg.orgId, routingKey: msg.routingKey ?? this.routingKey };
    try {
      // On a hot miss, the cold store (scoped by the Platform's `routingKey` hint).
      const row = await loadEventLogByDeliveryId({
        db: this.db,
        coldStore: this.coldStore ?? undefined,
        orgId: msg.orgId,
        deliveryId: msg.deliveryId,
        routingKey: msg.routingKey,
      });

      if (!row) {
        this.access.recordIn(
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

      this.access.recordIn(
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
      this.access.recordIn(
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
   * Gunzips the body and emits it as base64 `dashboard.event-log.payload.chunk`
   * messages of 64 KiB decompressed bytes; the first carries `totalBytes`, the
   * last `isLast=true`.
   *
   * One `event_log.payload.read` audit row is written at stream start:
   * `allowed` when the body begins streaming, `not_found` / `denied` for an
   * empty/error stream. Per-chunk rows would add volume, not attribution.
   *
   * A `setImmediate` yield between sends keeps the WS from saturating: ~80
   * yields for the 5 MB cap.
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
      this.access.recordIn(
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
      this.access.recordIn(
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
      this.access.recordIn(
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
      // LogStorage.read() returns a string (FS reads UTF-8, S3 treats the body as
      // bytes) and the writer appended a binary-encoded gzip buffer, so
      // round-trip through Buffer before gunzip.
      const result = await this.logStorage.read(row.payload_key);
      const buf = Buffer.from(result.data, 'binary');
      decompressed = gunzipSync(buf);
    } catch (err) {
      logger.warn('Failed to read or decode event-log payload for stream', {
        deliveryId: msg.deliveryId,
        payloadKey: row.payload_key,
        error: toErrorMessage(err),
      });
      this.access.recordIn(
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

    this.access.recordIn(
      ctx,
      msg.actor,
      'event_log.payload.read',
      { type: 'event_log_payload', id: msg.deliveryId },
      msg.requestId,
      'allowed',
    );

    const totalBytes = decompressed.byteLength;
    if (totalBytes === 0) {
      // An empty body is valid: one terminal chunk, no error.
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
        // Mirrors the agent-side log.chunk pacing.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  /**
   * DLQ rows (dispatch retries exhausted), `dlq_at DESC` with one `before` ISO
   * cursor. The `event_dlq.list.read` row mirrors the HTTP admin route's audit
   * shape, with the wire user's identity instead of the bearer-token role.
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
        payload: redactEventPayload(e.payload),
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

      this.access.recordIn(
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
      this.access.recordIn(
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
   * DLQ depth for the sidebar badge, polled every ~30s. Deliberately
   * un-audited: a frequent badge poll is not a triage action.
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
   * Clears the DLQ flag and `pg_notify`s so a healthy node picks the event up
   * without waiting for the leader-only retry scanner. A notify failure is
   * non-fatal: the scanner catches up.
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
        this.access.recordIn(
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

      this.access.recordIn(
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
      this.access.recordIn(
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
   * Permanently deletes the DLQ row (no retry, no archive), for a corrupt
   * payload or a removed routing target.
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
        this.access.recordIn(
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

      this.access.recordIn(
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
      this.access.recordIn(
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

  async handleManualScheduleRequest(msg: ManualScheduleRequest): Promise<void> {
    const ctx = this.contextOrFallback(await this.resolveOrgForRegistration(msg.registrationId));
    try {
      const result = await this.onManualSchedule(
        msg.registrationId,
        stringifyActor(msg.actor),
        agentLabelOf(msg.actor),
        msg.requestId,
      );

      this.access.recordIn(
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
        ...(result.alreadyAccepted && { alreadyAccepted: true }),
      });
    } catch (err) {
      logger.error('Error handling run.manual_schedule.request', {
        registrationId: msg.registrationId,
        error: toErrorMessage(err),
      });

      this.access.recordIn(
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
   * Fetch an archived run + jobs + steps from S3. The scan stops at the warm
   * cutoff (cold-store holds nothing past it by construction), and rows are
   * filtered by `run_id` because chunks span runs.
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
          workflow_name: string | null;
          is_test_run: boolean | null;
        }
      | undefined;
    jobs: Array<{
      job_id: string;
      job_name: string;
      workflow_name: string | null;
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
      routing_reason: string | null;
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
      concurrency_kind: string | null;
      group_id: string | null;
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
            workflow_name: string | null;
            is_test_run: boolean | null;
          }
        | undefined,
      jobs: [] as Array<{
        job_id: string;
        job_name: string;
        workflow_name: string | null;
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
        routing_reason: string | null;
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
        concurrency_kind: string | null;
        group_id: string | null;
      }>,
    };
    if (!this.coldStore) return out;
    const epoch = new Date(0);

    // No explicit upper bound: each table's warm cutoff is tuned independently
    // via KICI_COLD_STORE_<TABLE>_WARM_TTL_DAYS and resolved by the store.
    const fetchByRun = async (table: 'execution_runs' | 'execution_jobs' | 'execution_steps') => {
      const rows: Record<string, unknown>[] = [];
      try {
        for await (const row of this.coldStore!.fetchRange({
          db: 'orchestrator',
          table,
          tenantId: routingKey,
          fromTs: epoch,
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
        workflow_name: typeof r.workflow_name === 'string' ? r.workflow_name : null,
        is_test_run: typeof r.is_test_run === 'boolean' ? r.is_test_run : null,
      };
    }
    out.jobs = jobRows.map((r) => ({
      job_id: String(r.job_id ?? ''),
      job_name: String(r.job_name ?? ''),
      workflow_name: typeof r.workflow_name === 'string' ? r.workflow_name : null,
      status: String(r.status ?? ''),
      matrix_values: typeof r.matrix_values === 'string' ? r.matrix_values : null,
      base_job_name: typeof r.base_job_name === 'string' ? r.base_job_name : null,
      variant_kind: typeof r.variant_kind === 'string' ? r.variant_kind : null,
      variant_label: typeof r.variant_label === 'string' ? r.variant_label : null,
      job_kind: typeof r.job_kind === 'string' ? r.job_kind : null,
      summoned_run_id: typeof r.summoned_run_id === 'string' ? r.summoned_run_id : null,
      agent_id: typeof r.agent_id === 'string' ? r.agent_id : null,
      started_at: coerceToDate(r.started_at),
      completed_at: coerceToDate(r.completed_at),
      duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
      error_message: typeof r.error_message === 'string' ? r.error_message : null,
      routing_reason: typeof r.routing_reason === 'string' ? r.routing_reason : null,
      runs_on_labels: typeof r.runs_on_labels === 'string' ? r.runs_on_labels : null,
      contexts: typeof r.contexts === 'string' ? r.contexts : null,
      skipped_contexts: typeof r.skipped_contexts === 'string' ? r.skipped_contexts : null,
      env_warning: typeof r.env_warning === 'string' ? r.env_warning : null,
      outputs: typeof r.outputs === 'string' ? r.outputs : null,
      init_failure: (r.init_failure as InitFailure | null) ?? null,
    }));
    // The PG path's ORDER BY: setup and init pseudo-steps first, then by step_index.
    stepRows.sort(compareStepRowsForDisplay);
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
      concurrency_kind: typeof r.concurrency_kind === 'string' ? r.concurrency_kind : null,
      group_id: typeof r.group_id === 'string' ? r.group_id : null,
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
  triggered_by_agent_label: string | null;
  cancelled_by: string | null;
  cancelled_by_agent_label: string | null;
  failure_reason: string | null;
}

/**
 * An optional field the orchestrator can't supply is omitted, so the reused
 * customer runs page degrades cleanly to '—'. Deliberately omitted, for lack
 * of a source:
 * - `commitMessage` — no commit-message column on `execution_runs`.
 * - `triggerEvent` — no trigger-event column (the run's `provider` is NOT the
 *   trigger event, so it must not be substituted).
 * - resolved user-display objects (`triggeredByUser` / `cancelledByUser`) —
 *   not part of the enriched schema; only the raw `triggeredBy` / `cancelledBy`
 *   identity strings are mapped.
 */
function mapRunSummary(
  r: RunSummaryRow,
  jobAggregates: Map<string, { jobCount: number; compileJobId: string | null; contexts: string[] }>,
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
    ...(r.triggered_by_agent_label ? { triggeredByAgentLabel: r.triggered_by_agent_label } : {}),
    ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
    ...(r.cancelled_by_agent_label ? { cancelledByAgentLabel: r.cancelled_by_agent_label } : {}),
    ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
    ...(agg ? { jobCount: agg.jobCount, hadCompileJob: agg.compileJobId !== null } : {}),
    ...(agg?.compileJobId ? { compileJobId: agg.compileJobId } : {}),
    ...(agg && agg.contexts.length > 0 ? { contexts: agg.contexts } : {}),
    source: {
      routingKey,
      name: identity?.name ?? null,
      subtype: identity?.subtype ?? r.provider,
      provider: identity?.provider ?? r.provider,
    },
  };
}
