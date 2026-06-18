/**
 * Admin API routes for database migration management.
 *
 * Provides endpoints to run pending migrations and check migration status
 * through the admin API. Uses advisory locking for concurrency safety
 * across multiple orchestrator instances.
 *
 * All routes are mounted under /api/v1/admin/db and protected by
 * the admin auth middleware in admin.ts.
 */
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { runMigrations, getMigrationStatus } from '../db/migrator.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';

const logger = createLogger({ prefix: 'admin-db' });

interface DbRouteDeps {
  db: Kysely<any>;
  pool: pg.Pool;
}

type AdminDbEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

export function createDbRoutes(deps: DbRouteDeps): Hono<AdminDbEnv> {
  const app = new Hono<AdminDbEnv>();

  // DB migrations are orchestrator-wide; routing-key tokens have no
  // legitimate use here.
  app.use('/db/*', async (c, next) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    await next();
  });

  // POST /api/v1/admin/db/migrate -- run pending migrations
  app.post('/db/migrate', async (c) => {
    try {
      const results = await runMigrations(deps);
      const applied = results.filter((r) => r.status === 'Success');
      return c.json({
        applied: applied.length,
        migrations: applied.map((r) => r.migrationName),
      });
    } catch (err) {
      logger.error('Migration failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  // GET /api/v1/admin/db/migrate/status -- show migration status
  app.get('/db/migrate/status', async (c) => {
    try {
      const status = await getMigrationStatus(deps);
      return c.json({ migrations: status });
    } catch (err) {
      logger.error('Failed to get migration status', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  return app;
}
