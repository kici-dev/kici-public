/**
 * Auto-migrate module with PostgreSQL advisory lock for HA safety.
 *
 * Uses pg_advisory_lock to ensure only one orchestrator instance runs
 * migrations at a time, preventing conflicts in multi-instance deployments.
 */
import { Migrator, type MigrationResult } from 'kysely/migration';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { computeMigrationsHash, createLogger, storeMigrationContentHash } from '@kici-dev/shared';
import { createMigrationProvider } from './migration-provider.js';

const logger = createLogger({ prefix: 'migrate' });
const ADVISORY_LOCK_KEY = 543210001;

interface MigrateOptions {
  db: Kysely<any>;
  pool: pg.Pool;
}

interface MigrationStatusEntry {
  name: string;
  status: 'applied' | 'pending';
  appliedAt?: Date;
}

/**
 * Run all pending migrations with an advisory lock for concurrency safety.
 *
 * Acquires pg_advisory_lock before migrating to prevent concurrent
 * migration attempts from multiple orchestrator instances. The lock
 * is always released in the finally block, even on error.
 */
export async function runMigrations(opts: MigrateOptions): Promise<MigrationResult[]> {
  const client = await opts.pool.connect();
  try {
    logger.info('Acquiring migration lock...');
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    logger.info('Migration lock acquired');

    const migrator = new Migrator({
      db: opts.db,
      provider: createMigrationProvider(),
    });

    const start = Date.now();
    const { results, error } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        logger.info(`${result.migrationName} ... OK (${Date.now() - start}ms)`);
      } else if (result.status === 'Error') {
        logger.error(`${result.migrationName} ... FAILED`);
      }
      // NotExecuted = already applied, skip silently
    }

    if (error) {
      throw error;
    }

    const applied = (results ?? []).filter((r) => r.status === 'Success');
    if (applied.length === 0) {
      logger.info('Database schema is up to date');
    } else {
      logger.info(`Applied ${applied.length} migration(s)`);
    }

    // Record the content hash on every successful run — including warm DBs
    // where zero migrations were applied. Without this, a long-lived DB whose
    // migrations are all applied keeps reporting "content hash missing" from
    // `db check-schema`, making the freshness gate useless on exactly the
    // databases it matters for.
    const hash = await computeMigrationsHash(createMigrationProvider());
    await storeMigrationContentHash(opts.pool, hash);

    return results ?? [];
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Get migration status (applied/pending) without running anything.
 */
export async function getMigrationStatus(opts: MigrateOptions): Promise<MigrationStatusEntry[]> {
  const migrator = new Migrator({
    db: opts.db,
    provider: createMigrationProvider(),
  });
  const migrations = await migrator.getMigrations();
  return migrations.map((m) => ({
    name: m.name,
    status: m.executedAt ? ('applied' as const) : ('pending' as const),
    appliedAt: m.executedAt ?? undefined,
  }));
}
