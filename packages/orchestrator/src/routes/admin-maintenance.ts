/**
 * Admin API routes for ops-grade maintenance operations that don't fit
 * cleanly under a single resource namespace:
 *
 *   POST /api/v1/admin/queue/clear             — TRUNCATE dispatch_queue
 *   POST /api/v1/admin/execution/purge-stale   — DELETE execution runs + jobs
 *   POST /api/v1/admin/sources/purge-stale     — DELETE orphan sources + scoped secrets
 *   POST /api/v1/admin/secrets/purge           — DELETE scoped_secrets (bulk)
 *
 * Each endpoint accepts a minimal JSON body for scoping (e.g. routing key,
 * org ID) and supports a "dry run" mode where applicable. All mutations are
 * gated by the admin auth middleware in admin.ts, so unauthenticated access
 * is impossible.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { enforceRoutingKeyScope, requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';

const logger = createLogger({ prefix: 'admin-maintenance' });

interface MaintenanceRouteDeps {
  db: Kysely<any>;
}

type AdminMaintenanceEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

const purgeStaleSourcesSchema = z.object({
  routingKey: z.string().min(1),
  dryRun: z.boolean().optional(),
});

const purgeStaleExecutionSchema = z.object({
  routingKey: z.string().min(1),
});

const purgeSecretsSchema = z.object({
  orgId: z.string().min(1).optional(),
});

export function createMaintenanceRoutes(deps: MaintenanceRouteDeps): Hono<AdminMaintenanceEnv> {
  const app = new Hono<AdminMaintenanceEnv>();

  // POST /api/v1/admin/queue/clear — TRUNCATE dispatch_queue.
  app.post('/queue/clear', async (c) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    try {
      await sql`TRUNCATE dispatch_queue`.execute(deps.db);
      logger.info('dispatch_queue cleared');
      return c.json({ cleared: true });
    } catch (err) {
      logger.error('queue clear failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // POST /api/v1/admin/execution/purge-stale — DELETE execution runs/jobs
  // whose routing_key is not the current cluster's routing key (or is null).
  app.post('/execution/purge-stale', async (c) => {
    try {
      const body = purgeStaleExecutionSchema.parse(await c.req.json());
      const denied = enforceRoutingKeyScope(c, body.routingKey);
      if (denied) return denied;
      const jobsResult = await sql`
        DELETE FROM execution_jobs
         WHERE run_id IN (
           SELECT run_id FROM execution_runs
            WHERE routing_key != ${body.routingKey}
               OR routing_key IS NULL
         )
      `.execute(deps.db);
      const runsResult = await sql`
        DELETE FROM execution_runs
         WHERE routing_key != ${body.routingKey}
            OR routing_key IS NULL
      `.execute(deps.db);
      const jobsDeleted = Number(jobsResult.numAffectedRows ?? 0n);
      const runsDeleted = Number(runsResult.numAffectedRows ?? 0n);
      logger.info('execution data purged', {
        routingKey: body.routingKey,
        jobsDeleted,
        runsDeleted,
      });
      return c.json({ jobsDeleted, runsDeleted });
    } catch (err) {
      logger.error('execution purge-stale failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 400);
    }
  });

  // POST /api/v1/admin/sources/purge-stale — DELETE orphan source secrets and
  // source rows for routing keys other than the current cluster's. Also
  // clears `generic_webhook_sources` wholesale — that table is single-tenant
  // per orchestrator deployment and the expected consumer (deploy.ts warm
  // path) wants a clean slate for the new deploy.
  app.post('/sources/purge-stale', async (c) => {
    try {
      const body = purgeStaleSourcesSchema.parse(await c.req.json());
      const denied = enforceRoutingKeyScope(c, body.routingKey);
      if (denied) return denied;
      if (body.dryRun) {
        const staleSources = await sql<{ count: number }>`
          SELECT COUNT(*)::int AS count FROM sources WHERE routing_key != ${body.routingKey}
        `.execute(deps.db);
        const staleSecrets = await sql<{ count: number }>`
          SELECT COUNT(*)::int AS count FROM scoped_secrets
           WHERE org_id = '__system__'
             AND scope LIKE '__source__/%'
             AND scope NOT IN (
               SELECT '__source__/' || id::text FROM sources
                WHERE routing_key = ${body.routingKey}
             )
        `.execute(deps.db);
        const genericCount = await sql<{ count: number }>`
          SELECT COUNT(*)::int AS count FROM generic_webhook_sources
        `.execute(deps.db);
        const orphanRegsCount = await sql<{ count: number }>`
          SELECT COUNT(*)::int AS count FROM workflow_registrations
           WHERE routing_key != ${body.routingKey}
             AND routing_key NOT IN (SELECT routing_key FROM generic_webhook_sources)
        `.execute(deps.db);
        return c.json({
          dryRun: true,
          staleSecrets: staleSecrets.rows[0]?.count ?? 0,
          staleSources: staleSources.rows[0]?.count ?? 0,
          genericSources: genericCount.rows[0]?.count ?? 0,
          orphanRegistrations: orphanRegsCount.rows[0]?.count ?? 0,
        });
      }
      const secretsResult = await sql`
        DELETE FROM scoped_secrets
         WHERE org_id = '__system__'
           AND scope LIKE '__source__/%'
           AND scope NOT IN (
             SELECT '__source__/' || id::text FROM sources
              WHERE routing_key = ${body.routingKey}
           )
      `.execute(deps.db);
      const sourcesResult = await sql`
        DELETE FROM sources WHERE routing_key != ${body.routingKey}
      `.execute(deps.db);
      const genericResult = await sql`DELETE FROM generic_webhook_sources`.execute(deps.db);
      // Delete workflow_registrations rows whose routing_key no longer points
      // at a live source (generic_webhook_sources was wiped above; only real
      // provider rows remain in `sources`). Without this, cross-source dispatch
      // fans out to long-dead repo identifiers from earlier tests and breaks
      // subsequent runs.
      const registrationsResult = await sql`
        DELETE FROM workflow_registrations
         WHERE routing_key != ${body.routingKey}
           AND routing_key NOT IN (SELECT routing_key FROM sources)
      `.execute(deps.db);
      const secretsDeleted = Number(secretsResult.numAffectedRows ?? 0n);
      const sourcesDeleted = Number(sourcesResult.numAffectedRows ?? 0n);
      const genericDeleted = Number(genericResult.numAffectedRows ?? 0n);
      const registrationsDeleted = Number(registrationsResult.numAffectedRows ?? 0n);
      logger.info('sources purged', {
        routingKey: body.routingKey,
        secretsDeleted,
        sourcesDeleted,
        genericDeleted,
        registrationsDeleted,
      });
      return c.json({ secretsDeleted, sourcesDeleted, genericDeleted, registrationsDeleted });
    } catch (err) {
      logger.error('sources purge-stale failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 400);
    }
  });

  // POST /api/v1/admin/secrets/purge — bulk-delete scoped_secrets. Intended
  // for ops recovery after encryption-key rotation leaves undecryptable rows,
  // or for resetting per-source secrets in test setups. Scope is org-wide by
  // default; pass orgId to constrain.
  app.post('/secrets/purge', async (c) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    try {
      const body = purgeSecretsSchema.parse(await c.req.json());
      const query = body.orgId
        ? sql`DELETE FROM scoped_secrets WHERE org_id = ${body.orgId}`
        : sql`DELETE FROM scoped_secrets`;
      const result = await query.execute(deps.db);
      const deleted = Number(result.numAffectedRows ?? 0n);
      logger.info('secrets purged', { orgId: body.orgId ?? '<all>', deleted });
      return c.json({ deleted });
    } catch (err) {
      logger.error('secrets purge failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 400);
    }
  });

  return app;
}
