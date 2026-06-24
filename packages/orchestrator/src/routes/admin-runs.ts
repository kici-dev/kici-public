/**
 * Admin API routes for execution run inspection.
 *
 * Provides read-only endpoints for listing runs and inspecting per-run
 * sub-resources (jobs, ephemeral key status, secret outputs). All routes
 * are protected by Bearer token authentication and an RBAC permission
 * check (`run.read` for most, `secret.reveal` for the reveal variant of
 * `secret-outputs`).
 *
 * Endpoints:
 *   GET /api/v1/admin/runs                        — list runs with filters
 *   GET /api/v1/admin/runs/:runId                 — run header fields only
 *   GET /api/v1/admin/runs/:runId/jobs            — jobs list (optional steps)
 *   GET /api/v1/admin/runs/:runId/ephemeral-key   — scrub status
 *   GET /api/v1/admin/runs/:runId/secret-outputs  — masked by default; ?reveal=true
 *
 * This is the server-side counterpart to `kici-admin runs` — the dogfooded
 * replacement for hand-rolled curl commands and dashboard clicks when
 * verifying execution state.
 */

import { Hono } from 'hono';
import { createLogger } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import type { AuditLogger } from '../secrets/audit-logger.js';
import { decrypt, deriveKey } from '../secrets/crypto.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';
import { groupNeedsByJobName } from '../dashboard/needs-edges.js';

const logger = createLogger({ prefix: 'admin-runs' });

/** Statuses that can appear in `execution_runs.status`. */
const RUN_STATUSES = new Set([
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
  'timed_out_stale',
  'skipped',
]);

/** Safely parse a JSON string, returning null on invalid input. */
function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Parse an ISO-8601 timestamp; return null on invalid input so the caller
 * can turn it into a 400 with a clear message.
 */
function parseSince(raw: string | undefined): { ok: true; value: Date | null } | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { ok: false };
  return { ok: true, value: parsed };
}

/**
 * Parse the `?status=` query param. Accepts a single status or a
 * comma-separated list (e.g. `success,failed`). Duplicates are collapsed.
 */
function parseStatus(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  return Array.from(new Set(parts));
}

/**
 * Parse the `?count=` query param. Treat `true` / `1` as true; everything
 * else (including absence) as false.
 */
function parseCountFlag(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

/**
 * Dependencies for admin run routes.
 */
export interface AdminRunRoutesDeps {
  db: Kysely<Database>;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /** Required to reveal secret-output plaintext via ?reveal=true. */
  auditLogger?: AuditLogger;
  /**
   * Orchestrator master secret key (raw hex / base64). Required to reveal
   * secret-output plaintext. Derived once per request via deriveKey().
   */
  masterSecretKey?: string;
}

/** Hono env type for admin run routes with context variables. */
type AdminRunEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

/**
 * Create admin API routes for execution run inspection.
 *
 * @param deps - Admin run route dependencies
 * @returns Hono app with run routes mounted at /api/v1/admin/runs
 */
export function createAdminRunRoutes(deps: AdminRunRoutesDeps): Hono<AdminRunEnv> {
  const app = new Hono<AdminRunEnv>();

  // ── Auth middleware ────────────────────────────────────────────
  const authMiddleware = async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const token = authHeader.slice(7);
    const tokenInfo = await deps.tokenManager.validate(token);
    if (!tokenInfo) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    c.set('role', tokenInfo.role);
    c.set('userId', tokenInfo.id);
    c.set('routingKey', tokenInfo.routingKey);
    await next();
  };
  app.use('/api/v1/admin/runs', authMiddleware);
  app.use('/api/v1/admin/runs/*', authMiddleware);

  // ── GET /api/v1/admin/runs — list runs ─────────────────────────
  app.get('/api/v1/admin/runs', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'run.read');

      const statuses = parseStatus(c.req.query('status'));
      const workflowName = c.req.query('workflowName');
      const repo = c.req.query('repo');
      const sinceParsed = parseSince(c.req.query('since'));
      if (!sinceParsed.ok) {
        return c.json(
          { error: 'Invalid "since" query parameter: expected ISO-8601 timestamp' },
          400,
        );
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

      // Routing-key-scoped tokens see only runs whose `routing_key`
      // matches their scope. Forced on both the list and count queries
      // so the totals report the same window the caller sees.
      const tokenRoutingKey = c.get('routingKey');

      // Build the count query once and share filters with the list query.
      let countQuery = deps.db
        .selectFrom('execution_runs')
        .select(deps.db.fn.countAll<number>().as('total'));
      if (statuses && statuses.length === 1)
        countQuery = countQuery.where('status', '=', statuses[0]);
      if (statuses && statuses.length > 1) countQuery = countQuery.where('status', 'in', statuses);
      if (workflowName) countQuery = countQuery.where('workflow_name', '=', workflowName);
      if (repo) countQuery = countQuery.where('repo_identifier', '=', repo);
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
          'environment',
          'trust_tier',
          'created_at',
        ]);

      if (statuses && statuses.length === 1) query = query.where('status', '=', statuses[0]);
      if (statuses && statuses.length > 1) query = query.where('status', 'in', statuses);
      if (workflowName) query = query.where('workflow_name', '=', workflowName);
      if (repo) query = query.where('repo_identifier', '=', repo);
      if (since) query = query.where('created_at', '>', since);
      if (tokenRoutingKey) query = query.where('routing_key', '=', tokenRoutingKey);

      const [runs, countResult] = await Promise.all([
        query.orderBy('created_at', 'desc').limit(limit).offset(offset).execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);

      return c.json(
        {
          runs: runs.map((r) => ({
            runId: r.run_id,
            workflowName: r.workflow_name,
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
            environment: r.environment,
            trustTier: r.trust_tier,
            createdAt: r.created_at.toISOString(),
          })),
          total: Number(countResult.total),
          limit,
          offset,
        },
        200,
      );
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/runs/:runId — run header ─────────────────
  app.get('/api/v1/admin/runs/:runId', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'run.read');

      const runId = c.req.param('runId');
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
          'environment',
          'trust_tier',
          'lock_file_source',
          'contributor_username',
          'failure_reason',
          'created_at',
          'routing_key',
        ])
        .where('run_id', '=', runId)
        .executeTakeFirst();

      if (!run) {
        return c.json({ error: `Run ${runId} not found` }, 404);
      }

      const denied = enforceRoutingKeyScope(c, run.routing_key);
      if (denied) return denied;

      return c.json(
        {
          run: {
            runId: run.run_id,
            workflowName: run.workflow_name,
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
            environment: run.environment,
            trustTier: run.trust_tier,
            lockFileSource: run.lock_file_source,
            contributorUsername: run.contributor_username,
            failureReason: run.failure_reason,
            createdAt: run.created_at.toISOString(),
          },
        },
        200,
      );
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/runs/:runId/jobs — jobs for a run ─────────
  app.get('/api/v1/admin/runs/:runId/jobs', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'run.read');

      const runId = c.req.param('runId');
      const includeSteps = parseCountFlag(c.req.query('includeSteps'));

      // Verify run exists so we can distinguish "run missing" from "no jobs yet".
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

      const jobs = await deps.db
        .selectFrom('execution_jobs')
        .select([
          'job_id',
          'job_name',
          'status',
          'matrix_values',
          'agent_id',
          'started_at',
          'completed_at',
          'duration_ms',
          'error_message',
          'runs_on_labels',
          'created_at',
        ])
        .where('run_id', '=', runId)
        .orderBy('created_at', 'asc')
        .execute();

      // Resolved dependency edges for the run, grouped by downstream job_name.
      // Surfaced so operators (and the dashboard DAG view) see what each job
      // depended on, with the per-edge run-on status-set.
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
          .orderBy('step_index', 'asc')
          .execute();
        stepsByJob = new Map();
        for (const step of steps) {
          let jobSteps = stepsByJob.get(step.job_id);
          if (!jobSteps) {
            jobSteps = [];
            stepsByJob.set(step.job_id, jobSteps);
          }
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
          });
        }
      }

      return c.json(
        {
          jobs: jobs.map((job) => {
            const entry: Record<string, unknown> = {
              jobId: job.job_id,
              jobName: job.job_name,
              status: job.status,
              matrixValues: safeJsonParse(job.matrix_values),
              agentId: job.agent_id,
              startedAt: job.started_at?.toISOString() ?? null,
              completedAt: job.completed_at?.toISOString() ?? null,
              durationMs: job.duration_ms,
              errorMessage: job.error_message,
              runsOnLabels: safeJsonParse(job.runs_on_labels as string | null),
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
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/runs/:runId/ephemeral-key — scrub status ──
  app.get('/api/v1/admin/runs/:runId/ephemeral-key', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'run.read');

      const runId = c.req.param('runId');

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
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/runs/:runId/secret-outputs — masked / reveal ──
  app.get('/api/v1/admin/runs/:runId/secret-outputs', async (c) => {
    try {
      const role = c.get('role');
      deps.rbac.requirePermission(role, 'run.read');

      const runId = c.req.param('runId');
      const outputKeyFilter = c.req.query('outputKey');
      const reveal = parseCountFlag(c.req.query('reveal'));

      if (reveal) {
        // Reveal requires a stricter permission and an orchestrator master key.
        deps.rbac.requirePermission(role, 'secret.reveal');
        if (!deps.masterSecretKey || !deps.auditLogger) {
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

      // Reveal path — decrypt each row with the orchestrator master key.
      const keyBuf = deriveKey(deps.masterSecretKey!);
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
          const plaintext = decrypt(
            { data: r.encrypted_value, keyVersion: 1 },
            keyBuf,
            `secret-output:${runId}`,
          );
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
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
