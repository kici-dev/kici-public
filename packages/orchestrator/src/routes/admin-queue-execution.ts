/**
 * Admin API routes for queue + execution READ operations (5a #3 /).
 *
 *   GET /api/v1/admin/queue                   — list dispatch_queue
 *   GET /api/v1/admin/queue/:id               — show one dispatch_queue row
 *   GET /api/v1/admin/executions              — list execution_runs
 *   GET /api/v1/admin/executions/:runId       — show one run + its jobs
 *
 * All routes are gated by the admin auth middleware mounted in admin.ts
 * and require `secret.read` RBAC (the closest existing read-grade permission).
 */
import { Hono } from 'hono';
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-queue-execution' });

export interface AdminQueueExecutionRoutesDeps {
  db: Kysely<any>;
  rbac: RbacEnforcer;
}

type AdminQEEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

function parsePositiveInt(raw: string | undefined, fallback: number, max = 1000): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) return fallback;
  return Math.min(n, max);
}

export function createAdminQueueExecutionRoutes(
  deps: AdminQueueExecutionRoutesDeps,
): Hono<AdminQEEnv> {
  const app = new Hono<AdminQEEnv>();

  // ── GET /queue ─ list ────────────────────────────────────────────
  app.get('/queue', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const status = c.req.query('status');
      const statusNotInRaw = c.req.query('statusNotIn');
      const statusNotIn = statusNotInRaw
        ? statusNotInRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined;
      const jobNamePrefix = c.req.query('jobNamePrefix');
      const jobName = c.req.query('jobName');
      const jobNameNotLike = c.req.query('jobNameNotLike');
      const workflowName = c.req.query('workflowName');
      const createdAfter = c.req.query('createdAfter');
      const limit = parsePositiveInt(c.req.query('limit'), 100);

      let query = deps.db
        .selectFrom('dispatch_queue')
        .select([
          'id',
          'run_id',
          'workflow_name',
          'job_name',
          'status',
          'routing_key',
          'provider',
          'created_at',
          'expires_at',
          'delivery_id',
          'source_tar_url',
          'deps_url',
          'job_config',
        ]);
      if (status) query = query.where('status', '=', status);
      if (statusNotIn && statusNotIn.length > 0)
        query = query.where('status', 'not in', statusNotIn);
      if (jobNamePrefix) query = query.where('job_name', 'like', `${jobNamePrefix}%`);
      if (jobName) query = query.where('job_name', '=', jobName);
      if (jobNameNotLike) query = query.where('job_name', 'not like', jobNameNotLike);
      if (workflowName) query = query.where('workflow_name', '=', workflowName);
      if (createdAfter) query = query.where('created_at', '>', new Date(createdAfter));
      const tokenRoutingKey = c.get('routingKey');
      if (tokenRoutingKey) query = query.where('routing_key', '=', tokenRoutingKey);
      const entries = await query.orderBy('created_at', 'desc').limit(limit).execute();
      return c.json({ entries });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /queue/:id ─ show ────────────────────────────────────────
  app.get('/queue/:id', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const id = c.req.param('id');
      const entry = await deps.db
        .selectFrom('dispatch_queue')
        .select([
          'id',
          'run_id',
          'workflow_name',
          'job_name',
          'status',
          'routing_key',
          'provider',
          'created_at',
          'expires_at',
          'delivery_id',
          'source_tar_url',
          'deps_url',
          'job_config',
        ])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!entry) return c.json({ error: `queue: entry not found (id=${id})` }, 404);
      const denied = enforceRoutingKeyScope(c, entry.routing_key);
      if (denied) return denied;
      return c.json(entry);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /executions ─ list ──────────────────────────────────────
  app.get('/executions', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const queryRoutingKey = c.req.query('routingKey');
      const tokenRoutingKey = c.get('routingKey');
      // Routing-key-scoped tokens see only their own routing key.
      if (tokenRoutingKey && queryRoutingKey && queryRoutingKey !== tokenRoutingKey) {
        const denied = enforceRoutingKeyScope(c, queryRoutingKey);
        if (denied) return denied;
      }
      const routingKey = tokenRoutingKey ?? queryRoutingKey;
      const status = c.req.query('status');
      const workflowName = c.req.query('workflowName');
      const limit = parsePositiveInt(c.req.query('limit'), 100);

      let query = deps.db
        .selectFrom('execution_runs')
        .select([
          'id',
          'run_id',
          'workflow_name',
          'status',
          'provider',
          'repo_identifier',
          'ref',
          'sha',
          'routing_key',
          'environment',
          'trust_tier',
          'created_at',
          'started_at',
          'completed_at',
          'duration_ms',
        ]);
      if (routingKey) query = query.where('routing_key', '=', routingKey);
      if (status) query = query.where('status', '=', status);
      if (workflowName) query = query.where('workflow_name', '=', workflowName);
      const runs = await query.orderBy('created_at', 'desc').limit(limit).execute();
      return c.json({ runs });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /executions/:runId ─ show + jobs ─────────────────────────
  app.get('/executions/:runId', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'secret.read');
      const runId = c.req.param('runId');
      const runRow = await sql<{
        id: string;
        run_id: string;
        workflow_name: string;
        status: string;
        provider: string;
        repo_identifier: string;
        ref: string;
        sha: string;
        routing_key: string | null;
        environment: string | null;
        trust_tier: string | null;
        created_at: string;
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
      }>`
        SELECT id, run_id, workflow_name, status, provider, repo_identifier,
               ref, sha, routing_key, environment, trust_tier, created_at,
               started_at, completed_at, duration_ms
          FROM execution_runs
         WHERE run_id = ${runId}
      `.execute(deps.db);
      if (runRow.rows.length === 0) {
        return c.json({ error: `execution: run not found (run_id=${runId})` }, 404);
      }
      const run = runRow.rows[0];
      const denied = enforceRoutingKeyScope(c, run.routing_key);
      if (denied) return denied;
      const jobsRows = await sql<{
        id: string;
        run_id: string;
        job_id: string;
        job_name: string;
        status: string;
        agent_id: string | null;
        started_at: string | null;
        completed_at: string | null;
        duration_ms: number | null;
        created_at: string;
      }>`
        SELECT id, run_id, job_id, job_name, status, agent_id,
               started_at, completed_at, duration_ms, created_at
          FROM execution_jobs
         WHERE run_id = ${run.id}::uuid
         ORDER BY created_at ASC
      `.execute(deps.db);
      return c.json({ run, jobs: jobsRows.rows });
    } catch (err) {
      return handleError(c, err);
    }
  });

  return app;
}

function handleError(c: any, err: unknown) {
  logger.error('admin-queue-execution route failed', { error: toErrorMessage(err) });
  return handleAdminError(c, err, logger);
}
