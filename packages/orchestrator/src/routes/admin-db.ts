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
import { runMigrations, getMigrationStatus, migrateTo, withMigrationPool } from '../db/migrator.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';

const logger = createLogger({ prefix: 'admin-db' });

interface DbRouteDeps {
  db: Kysely<any>;
  pool: pg.Pool;
  /**
   * Connection string for the timeout-free pool that schema work runs on.
   * Absent in unit tests, which fall back to the shared pool.
   */
  databaseUrl?: string;
}

/**
 * Run `fn` against a pool whose connections carry no statement timeout, so a
 * long backfill is not cancelled mid-migration. Falls back to the shared pool
 * when no connection string was threaded through.
 */
async function onMigrationPool<T>(
  deps: DbRouteDeps,
  fn: (opts: { db: Kysely<any>; pool: pg.Pool }) => Promise<T>,
): Promise<T> {
  if (!deps.databaseUrl) return fn(deps);
  return withMigrationPool(deps.databaseUrl, fn);
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
      const results = await onMigrationPool(deps, runMigrations);
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

  // POST /api/v1/admin/db/migrate/to -- migrate to a named migration.
  //
  // Runs on the CURRENT binary, whose static provider is the only one that
  // carries the newer migrations' down() functions. That is why a rollback has
  // to call this BEFORE the version pointer moves: once the old binary is
  // running, the migrations the ledger records no longer exist in its provider
  // and Kysely refuses to start at all.
  app.post('/db/migrate/to', async (c) => {
    let body: { name?: unknown };
    try {
      body = (await c.req.json()) as { name?: unknown };
    } catch {
      return c.json({ error: 'body must be JSON with a "name" field' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: '"name" is required' }, 400);

    try {
      const result = await onMigrationPool(deps, (opts) => migrateTo(opts, name));
      return c.json(result);
    } catch (err) {
      logger.error('Migration to target failed', { name, error: toErrorMessage(err) });
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
