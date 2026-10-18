/**
 * Read-only admin API for execution runs and their sub-resources. Every route
 * requires a Bearer token and an RBAC permission: `run.read`, plus
 * `secret.reveal` for the reveal variant of `secret-outputs`.
 *
 * Endpoints:
 *   GET /api/v1/admin/runs                        — list runs with filters
 *   GET /api/v1/admin/runs/:runId                 — run header fields only
 *   GET /api/v1/admin/runs/:runId/jobs            — jobs list (optional steps)
 *   GET /api/v1/admin/runs/:runId/structured      — aggregated run detail
 *   GET /api/v1/admin/runs/:runId/jobs/:jobId/steps/:stepIndex/logs — step logs
 *   GET /api/v1/admin/runs/:runId/ephemeral-key   — scrub status
 *   GET /api/v1/admin/runs/:runId/secret-outputs  — masked by default; ?reveal=true
 *
 * Server side of `kici-admin runs`.
 */

import { setupStepsFirst } from '../reporting/step-display-order.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { createLogger } from '@kici-dev/shared';
import {
  CANONICAL_STATUSES,
  initStepIndex,
  isRunId,
  parseRunIdRef,
  runIdPrefixRange,
  stepPhase,
} from '@kici-dev/engine';
import type { ExpressionBuilder, Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import type { AuditLogger } from '../secrets/audit-logger.js';
import type { ResolvedMasterKeys } from '../secrets/config.js';
import { unsealSecretOutput } from '../secrets/secret-output-crypto.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';
import { groupNeedsByJobName } from '../dashboard/needs-edges.js';
import { aggregateRunDetail } from '../reporting/run-aggregator.js';
import { mapToAgentRunResult } from '../reporting/agent-run-result-mapper.js';
import { readStepLogLines, toAgentStepLogs } from '../reporting/step-log-reader.js';
import type { LogStorage } from '../reporting/log-storage.js';
import { visibleRoutingReason } from '../reporting/run-aggregator.js';
import { jobWorkflowName, loadRunWorkflowNames } from '../reporting/run-workflow-names.js';
import { createBearerAuthMiddleware } from './admin-auth.js';
import { type AdminEnv, createAdminApp } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-runs' });

/**
 * Statuses accepted by the `?status=` filter: the full canonical union, not
 * just `ExecutionRunStatus.options`. Job-only members match no
 * `execution_runs` row but stay accepted, so such a filter returns an empty
 * result rather than a rejected request.
 */
export const RUN_STATUSES: ReadonlySet<string> = new Set<string>(CANONICAL_STATUSES);
/** Parse an ISO-8601 timestamp; `ok: false` lets the caller return a clear 400. */
function parseSince(raw: string | undefined): { ok: true; value: Date | null } | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { ok: false };
  return { ok: true, value: parsed };
}

/** Parse `?status=`: one status or a comma-separated list, duplicates collapsed. */
function parseStatus(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  return Array.from(new Set(parts));
}

/** Parse a boolean flag param: only `true` / `1` are true. */
function parseCountFlag(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export interface AdminRunRoutesDeps {
  db: Kysely<Database>;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /** Required to reveal secret-output plaintext via ?reveal=true. */
  auditLogger?: AuditLogger;
  /**
   * The master key, plus the previous generation during a rotation grace
   * window. Required to reveal secret-output plaintext; a row still sealed
   * under the old key reveals until `rotate-key` has swept the table.
   */
  masterKeys?: ResolvedMasterKeys | null;
  /**
   * Required only by the step-logs endpoint
   * (`/runs/:runId/jobs/:jobId/steps/:stepIndex/logs`), which 503s without it.
   */
  logStorage?: LogStorage;
}

/**
 * Matches a run that spans `workflowName`: its own workflow, or the workflow of
 * one of its jobs (a fixture run spanning several workflows).
 */
function spansWorkflow(workflowName: string) {
  return (eb: ExpressionBuilder<Database, 'execution_runs'>) =>
    eb.or([
      eb('execution_runs.workflow_name', '=', workflowName),
      eb.exists(
        eb
          .selectFrom('execution_jobs')
          .select('execution_jobs.job_id')
          .whereRef('execution_jobs.run_id', '=', 'execution_runs.run_id')
          .where('execution_jobs.workflow_name', '=', workflowName),
      ),
    ]);
}

/**
 * Refuse a `:runId` that is not a full run id before it reaches a UUID column, where
 * Postgres rejects it as a malformed value and the caller learns nothing. A client
 * resolves a short id through `?runIdPrefix=` on the list route first.
 */
const requireFullRunId: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const runId = c.req.param('runId') ?? '';
  if (!isRunId(runId)) {
    return c.json(
      {
        error:
          `Invalid run id '${runId}': a run id is a full UUID. ` +
          `List runs (or filter with ?runIdPrefix=) to find it.`,
      },
      400,
    );
  }
  return next();
};

/**
 * `?runIdPrefix=`: the run ids that start with the given characters, as a UUID range
 * the primary-key index answers. A full run id is its own one-id range.
 */
function parseRunIdPrefixQuery(
  raw: string | undefined,
): { low: string; high: string } | { error: string } | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ref = parseRunIdRef(raw);
  if (ref.kind === 'invalid') return { error: `Invalid "runIdPrefix" '${raw}': ${ref.reason}` };
  return ref.kind === 'uuid' ? { low: ref.runId, high: ref.runId } : runIdPrefixRange(ref.hex);
}

/** Run routes, mounted at /api/v1/admin/runs. */
export function createAdminRunRoutes(deps: AdminRunRoutesDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin-runs',
  });
  app.use('/api/v1/admin/runs', authMiddleware);
  app.use('/api/v1/admin/runs/*', authMiddleware);
  app.use('/api/v1/admin/runs/:runId', requireFullRunId);
  app.use('/api/v1/admin/runs/:runId/*', requireFullRunId);

  app.get('/api/v1/admin/runs', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');

    const statuses = parseStatus(c.req.query('status'));
    const workflowName = c.req.query('workflowName');
    const repo = c.req.query('repo');
    const deliveryId = c.req.query('deliveryId');
    const runIdPrefix = parseRunIdPrefixQuery(c.req.query('runIdPrefix'));
    if (runIdPrefix && 'error' in runIdPrefix) return c.json({ error: runIdPrefix.error }, 400);
    const sinceParsed = parseSince(c.req.query('since'));
    if (!sinceParsed.ok) {
      return c.json({ error: 'Invalid "since" query parameter: expected ISO-8601 timestamp' }, 400);
    }
    const since = sinceParsed.value;
    const countOnly = parseCountFlag(c.req.query('count'));
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;

    if (statuses) {
      for (const s of statuses) {
        if (!RUN_STATUSES.has(s)) {
          return c.json(
            {
              error: `Invalid status "${s}". Allowed: ${Array.from(RUN_STATUSES).join(', ')}`,
            },
            400,
          );
        }
      }
    }

    // A routing-key-scoped token sees only runs with its `routing_key`, forced
    // on both the list and count queries so the totals match what it sees.
    const tokenRoutingKey = c.get('routingKey');

    let countQuery = deps.db
      .selectFrom('execution_runs')
      .select(deps.db.fn.countAll<number>().as('total'));
    if (statuses && statuses.length === 1)
      countQuery = countQuery.where('status', '=', statuses[0]);
    if (statuses && statuses.length > 1) countQuery = countQuery.where('status', 'in', statuses);
    if (workflowName) countQuery = countQuery.where(spansWorkflow(workflowName));
    if (repo) countQuery = countQuery.where('repo_identifier', '=', repo);
    if (deliveryId) countQuery = countQuery.where('delivery_id', '=', deliveryId);
    if (runIdPrefix)
      countQuery = countQuery
        .where('run_id', '>=', runIdPrefix.low)
        .where('run_id', '<=', runIdPrefix.high);
    if (since) countQuery = countQuery.where('created_at', '>', since);
    if (tokenRoutingKey) countQuery = countQuery.where('routing_key', '=', tokenRoutingKey);

    if (countOnly) {
      const countResult = await countQuery.executeTakeFirstOrThrow();
      return c.json(
        {
          total: Number(countResult.total),
          since: since?.toISOString() ?? null,
          status: statuses,
          workflowName: workflowName ?? null,
          repo: repo ?? null,
        },
        200,
      );
    }

    let query = deps.db
      .selectFrom('execution_runs')
      .select([
        'run_id',
        'workflow_name',
        'status',
        'provider',
        'repo_identifier',
        'ref',
        'sha',
        'started_at',
        'completed_at',
        'duration_ms',
        'parent_run_id',
        'triggered_by',
        'failure_reason',
        'context',
        'trust_tier',
        'created_at',
      ]);

    if (statuses && statuses.length === 1) query = query.where('status', '=', statuses[0]);
    if (statuses && statuses.length > 1) query = query.where('status', 'in', statuses);
    if (workflowName) query = query.where(spansWorkflow(workflowName));
    if (repo) query = query.where('repo_identifier', '=', repo);
    if (deliveryId) query = query.where('delivery_id', '=', deliveryId);
    if (runIdPrefix)
      query = query.where('run_id', '>=', runIdPrefix.low).where('run_id', '<=', runIdPrefix.high);
    if (since) query = query.where('created_at', '>', since);
    if (tokenRoutingKey) query = query.where('routing_key', '=', tokenRoutingKey);

    const [runs, countResult] = await Promise.all([
      query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);
    const workflowNames = await loadRunWorkflowNames(deps.db, runs);

    return c.json(
      {
        runs: runs.map((r) => ({
          runId: r.run_id,
          workflowName: r.workflow_name,
          workflowNames: workflowNames.get(r.run_id) ?? [r.workflow_name],
          status: r.status,
          provider: r.provider,
          repoIdentifier: r.repo_identifier,
          ref: r.ref,
          sha: r.sha,
          startedAt: r.started_at?.toISOString() ?? null,
          completedAt: r.completed_at?.toISOString() ?? null,
          durationMs: r.duration_ms,
          parentRunId: r.parent_run_id,
          triggeredBy: r.triggered_by,
          failureReason: r.failure_reason,
          context: r.context,
          trustTier: r.trust_tier,
          createdAt: r.created_at.toISOString(),
        })),
        total: Number(countResult.total),
        limit,
        offset,
      },
      200,
    );
  });

  app.get('/api/v1/admin/runs/:runId', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');

    const runId = c.req.param('runId').toLowerCase();
    const run = await deps.db
      .selectFrom('execution_runs')
      .select([
        'run_id',
        'workflow_name',
        'status',
        'provider',
        'repo_identifier',
        'ref',
        'sha',
        'delivery_id',
        'started_at',
        'completed_at',
        'duration_ms',
        'is_test_run',
        'parent_run_id',
        'original_run_id',
        'triggered_by',
        'cancelled_by',
        'context',
        'trust_tier',
        'lock_file_source',
        'contributor_username',
        'failure_reason',
        'created_at',
        'routing_key',
        'workflow_repo_identifier',
        'workflow_sha',
        'workflow_branch',
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!run) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }

    const denied = enforceRoutingKeyScope(c, run.routing_key);
    if (denied) return denied;
    const workflowNames = await loadRunWorkflowNames(deps.db, [run]);

    return c.json(
      {
        run: {
          runId: run.run_id,
          workflowName: run.workflow_name,
          // Every workflow the run spans; `workflowName` is the first of them.
          workflowNames: workflowNames.get(run.run_id) ?? [run.workflow_name],
          status: run.status,
          provider: run.provider,
          repoIdentifier: run.repo_identifier,
          ref: run.ref,
          sha: run.sha,
          deliveryId: run.delivery_id,
          startedAt: run.started_at?.toISOString() ?? null,
          completedAt: run.completed_at?.toISOString() ?? null,
          durationMs: run.duration_ms,
          isTestRun: run.is_test_run,
          parentRunId: run.parent_run_id,
          originalRunId: run.original_run_id,
          triggeredBy: run.triggered_by,
          cancelledBy: run.cancelled_by,
          context: run.context,
          trustTier: run.trust_tier,
          lockFileSource: run.lock_file_source,
          contributorUsername: run.contributor_username,
          failureReason: run.failure_reason,
          createdAt: run.created_at.toISOString(),
          // Set only on an organization-wide run whose workflow is defined in
          // another repository; null on every run of a repository's own workflow.
          workflowRepoIdentifier: run.workflow_repo_identifier,
          workflowSha: run.workflow_sha,
          workflowBranch: run.workflow_branch,
        },
      },
      200,
    );
  });

  app.get('/api/v1/admin/runs/:runId/jobs', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');

    const runId = c.req.param('runId').toLowerCase();
    const includeSteps = parseCountFlag(c.req.query('includeSteps'));

    // Tells "run missing" (404) apart from "no jobs yet".
    const runExists = await deps.db
      .selectFrom('execution_runs')
      .select(['run_id', 'routing_key', 'workflow_name', 'is_test_run'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!runExists) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }
    const denied = enforceRoutingKeyScope(c, runExists.routing_key);
    if (denied) return denied;

    const jobs = await deps.db
      .selectFrom('execution_jobs')
      .select([
        'job_id',
        'job_name',
        'workflow_name',
        'status',
        'matrix_values',
        'agent_id',
        'started_at',
        'completed_at',
        'duration_ms',
        'error_message',
        'routing_reason',
        'runs_on_labels',
        'created_at',
      ])
      .where('run_id', '=', runId)
      .orderBy('created_at', 'asc')
      .execute();

    // Dependency edges grouped by downstream job_name, with each edge's run-on
    // status set, for operators and the dashboard DAG view.
    const needsRows = await deps.db
      .selectFrom('execution_job_needs')
      .select(['job_name', 'upstream_name', 'run_on'])
      .where('run_id', '=', runId)
      .execute();
    const needsByJob = groupNeedsByJobName(needsRows);

    let stepsByJob: Map<string, Array<Record<string, unknown>>> = new Map();
    if (includeSteps) {
      const steps = await deps.db
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
        ])
        .where('run_id', '=', runId)
        .orderBy(setupStepsFirst())
        .orderBy('step_index', 'asc')
        .execute();
      stepsByJob = new Map();
      for (const step of steps) {
        let jobSteps = stepsByJob.get(step.job_id);
        if (!jobSteps) {
          jobSteps = [];
          stepsByJob.set(step.job_id, jobSteps);
        }
        const initIndex = initStepIndex(step.step_type);
        jobSteps.push({
          stepIndex: step.step_index,
          stepName: step.step_name,
          status: step.status,
          startedAt: step.started_at?.toISOString() ?? null,
          completedAt: step.completed_at?.toISOString() ?? null,
          durationMs: step.duration_ms,
          exitCode: step.exit_code,
          errorMessage: step.error_message,
          stepType: step.step_type,
          // Readers tell init steps apart without parsing `stepType`; `stepIndex` stays raw.
          phase: stepPhase(step.step_type),
          ...(initIndex !== undefined && { initIndex }),
        });
      }
    }

    return c.json(
      {
        jobs: jobs.map((job) => {
          const entry: Record<string, unknown> = {
            jobId: job.job_id,
            jobName: job.job_name,
            workflowName: jobWorkflowName(job.workflow_name, runExists),
            status: job.status,
            // `matrix_values` and `runs_on_labels` are JSONB, already parsed by
            // the driver; a `JSON.parse` here throws on the coerced string and
            // yields null, so every job would report no routing labels.
            matrixValues: job.matrix_values ?? null,
            agentId: job.agent_id,
            startedAt: job.started_at?.toISOString() ?? null,
            completedAt: job.completed_at?.toISOString() ?? null,
            durationMs: job.duration_ms,
            errorMessage: job.error_message,
            routingReason: visibleRoutingReason(job.status, job.routing_reason),
            runsOnLabels: job.runs_on_labels ?? null,
            createdAt: job.created_at.toISOString(),
            needs: needsByJob.get(job.job_name) ?? null,
          };
          if (includeSteps) {
            entry.steps = stepsByJob.get(job.job_id) ?? [];
          }
          return entry;
        }),
      },
      200,
    );
  });

  // Machine-first, provenance-tagged run result: typed job DAG, per-step exit
  // codes / durations / statuses, derived failure category. Untrusted fields
  // (names, refs, error text, job outputs) are envelope-tagged; secret values
  // are never returned (only secret-output key names).
  app.get('/api/v1/admin/runs/:runId/structured', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');
    const runId = c.req.param('runId').toLowerCase();
    const detail = await aggregateRunDetail(deps.db, runId);
    if (!detail) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }
    const denied = enforceRoutingKeyScope(c, detail.routingKey);
    if (denied) return denied;
    return c.json(mapToAgentRunResult(detail), 200);
  });

  // Paginated step log lines, every line tagged untrusted. cursor = line
  // offset; limit capped at 2000.
  app.get('/api/v1/admin/runs/:runId/jobs/:jobId/steps/:stepIndex/logs', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');
    const runId = c.req.param('runId').toLowerCase();
    const jobId = c.req.param('jobId');
    const stepIndex = parseInt(c.req.param('stepIndex'), 10);
    if (Number.isNaN(stepIndex)) {
      return c.json({ error: 'Invalid stepIndex' }, 400);
    }
    if (!deps.logStorage) {
      return c.json({ error: 'Log storage not configured on this orchestrator' }, 503);
    }

    // A global eval round writes NO `execution_runs` row on success (see
    // `buildRoundJobInput` in pipeline/global-eval-round.ts), yet its step logs
    // are stored. `dispatch_queue` carries the same run_id plus the routing_key
    // the scope guard needs, and its rows survive until terminal-status age
    // pruning, so it is the second source. The 404 and the scope guard keep
    // their meaning; only the set of resolving ids widens. The fallback runs
    // only on an `execution_runs` miss, so an ordinary run costs one lookup.
    const run = await deps.db
      .selectFrom('execution_runs')
      .select(['run_id', 'routing_key'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    const queued = run
      ? undefined
      : await deps.db
          .selectFrom('dispatch_queue')
          .select(['run_id', 'routing_key'])
          .where('run_id', '=', runId)
          .executeTakeFirst();
    // Resolve the ROW, not the routing key: `execution_runs.routing_key` is
    // nullable, and a found run with a null key stays a scope decision (403
    // for a scoped token, allowed for an unscoped one), never a 404.
    const scopeSource = run ?? queued;
    if (!scopeSource) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }
    const denied = enforceRoutingKeyScope(c, scopeSource.routing_key);
    if (denied) return denied;

    const limit = Math.min(parseInt(c.req.query('limit') ?? '500', 10) || 500, 2000);
    const raw = await readStepLogLines(
      { db: deps.db, logStorage: deps.logStorage },
      { runId, jobId, stepIndex, cursor: c.req.query('cursor'), limit },
    );
    return c.json(toAgentStepLogs(runId, jobId, stepIndex, raw), 200);
  });

  app.get('/api/v1/admin/runs/:runId/ephemeral-key', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'run.read');

    const runId = c.req.param('runId').toLowerCase();

    const runExists = await deps.db
      .selectFrom('execution_runs')
      .select(['run_id', 'routing_key'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!runExists) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }
    const denied = enforceRoutingKeyScope(c, runExists.routing_key);
    if (denied) return denied;

    const row = await deps.db
      .selectFrom('run_ephemeral_keys')
      .select(['run_id', 'created_at'])
      .where('run_id', '=', runId)
      .executeTakeFirst();

    if (!row) {
      return c.json({ exists: false, createdAt: null }, 200);
    }
    return c.json({ exists: true, createdAt: row.created_at.toISOString() }, 200);
  });

  app.get('/api/v1/admin/runs/:runId/secret-outputs', async (c) => {
    const role = c.get('role');
    deps.rbac.requirePermission(role, 'run.read');

    const runId = c.req.param('runId').toLowerCase();
    const outputKeyFilter = c.req.query('outputKey');
    const reveal = parseCountFlag(c.req.query('reveal'));

    if (reveal) {
      // Reveal requires a stricter permission and an orchestrator master key.
      deps.rbac.requirePermission(role, 'secret.reveal');
      if (!deps.masterKeys || !deps.auditLogger) {
        return c.json(
          {
            error:
              'Reveal is not available on this orchestrator (master key or audit logger missing)',
          },
          503,
        );
      }
    }

    const runExists = await deps.db
      .selectFrom('execution_runs')
      .select(['run_id', 'routing_key'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!runExists) {
      return c.json({ error: `Run ${runId} not found` }, 404);
    }
    const denied = enforceRoutingKeyScope(c, runExists.routing_key);
    if (denied) return denied;

    let query = deps.db
      .selectFrom('run_secret_outputs')
      .select(['id', 'job_id', 'output_key', 'encrypted_value', 'created_at'])
      .where('run_id', '=', runId);
    if (outputKeyFilter) query = query.where('output_key', '=', outputKeyFilter);

    const rows = await query.orderBy('created_at', 'asc').execute();

    if (!reveal) {
      return c.json(
        {
          outputs: rows.map((r) => ({
            id: r.id,
            jobId: r.job_id,
            outputKey: r.output_key,
            createdAt: r.created_at.toISOString(),
            value: null,
            masked: true,
          })),
        },
        200,
      );
    }

    const masterKeys = deps.masterKeys!;
    const outputs: Array<{
      id: string;
      jobId: string;
      outputKey: string;
      createdAt: string;
      value: string | null;
      masked: boolean;
      revealError?: string;
    }> = [];
    for (const r of rows) {
      try {
        const plaintext = unsealSecretOutput(r.encrypted_value, runId, masterKeys);
        outputs.push({
          id: r.id,
          jobId: r.job_id,
          outputKey: r.output_key,
          createdAt: r.created_at.toISOString(),
          value: plaintext,
          masked: false,
        });
      } catch (decryptErr) {
        outputs.push({
          id: r.id,
          jobId: r.job_id,
          outputKey: r.output_key,
          createdAt: r.created_at.toISOString(),
          value: null,
          masked: true,
          revealError: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
        });
      }
    }

    // Audit: non-optional. One row per reveal call, listing the keys exposed.
    await deps.auditLogger!.log({
      action: 'secret-outputs.reveal',
      contextName: `run:${runId}`,
      routingKey: null,
      secretKeys: outputs.map((o) => o.outputKey),
      outcome: 'allowed',
      runId,
      jobId: null,
      userId: c.get('userId'),
      role,
      metadata: {
        outputKeyFilter: outputKeyFilter ?? null,
        revealedCount: outputs.filter((o) => !o.masked).length,
        failedCount: outputs.filter((o) => o.masked).length,
      },
    });

    return c.json({ outputs }, 200);
  });

  return app;
}
