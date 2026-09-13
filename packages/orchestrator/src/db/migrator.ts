/**
 * Auto-migrate module with PostgreSQL advisory lock for HA safety.
 *
 * Uses pg_advisory_lock to ensure only one orchestrator instance runs
 * migrations at a time, preventing conflicts in multi-instance deployments.
 */
import { Migrator, type MigrationResult, type MigrationProvider } from 'kysely/migration';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { computeMigrationsHash, createLogger, storeMigrationContentHash } from '@kici-dev/shared';
import { createPool, createDb } from './client.js';
import { createMigrationProvider } from './migration-provider.js';

const logger = createLogger({ prefix: 'migrate' });
const ADVISORY_LOCK_KEY = 543210001;

interface MigrateOptions {
  db: Kysely<any>;
  pool: pg.Pool;
}

/**
 * Build a pool reserved for schema work.
 *
 * Migrations run DDL and backfills that legitimately take minutes on a
 * database holding real history, so they must not inherit the hot path's
 * `statement_timeout`. pg treats `0` as "no limit". Kysely's `Migrator`
 * acquires its own connections from whatever pool backs the `Kysely` instance
 * it is given, so the exemption has to be set on the pool — a `SET` issued on
 * one client would not reach the connections that run the migrations.
 *
 * `max: 2` covers the advisory-lock client plus the one Kysely checks out.
 */
export function createMigrationPool(databaseUrl: string): pg.Pool {
  return createPool(databaseUrl, { config: { max: 2, statement_timeout: 0 } });
}

/**
 * Run `fn` against a short-lived timeout-free migration pool, then close it.
 */
export async function withMigrationPool<T>(
  databaseUrl: string,
  fn: (opts: MigrateOptions) => Promise<T>,
): Promise<T> {
  const pool = createMigrationPool(databaseUrl);
  const db = createDb(pool);
  try {
    return await fn({ db, pool });
  } finally {
    // Destroying the Kysely instance ends the pool it wraps.
    await db.destroy();
  }
}

/**
 * Wrap every migration's `up` so each one's own elapsed time is measured,
 * including the one that fails. Kysely reports results only after the whole
 * batch settles and exposes no per-migration hook, so timing has to be
 * attached to the provider.
 */
function instrumentProvider(
  provider: MigrationProvider,
  elapsedMs: Map<string, number>,
): MigrationProvider {
  return {
    async getMigrations() {
      const migrations = await provider.getMigrations();
      return Object.fromEntries(
        Object.entries(migrations).map(([name, migration]) => [
          name,
          {
            ...migration,
            up: async (db: Kysely<any>) => {
              const started = Date.now();
              try {
                await migration.up(db);
              } finally {
                elapsedMs.set(name, Date.now() - started);
              }
            },
          },
        ]),
      );
    },
  };
}

const TIMEOUT_HINT =
  'migration exceeded the statement timeout — re-run with KICI_DB_STATEMENT_TIMEOUT_MS=0 ' +
  'or via kici-admin db migrate';

/** True when a driver error is a cancelled statement rather than bad SQL. */
export function isStatementTimeoutError(message: string): boolean {
  return /statement timeout/i.test(message);
}

/**
 * Restate a migration failure so the log names the migration that failed and,
 * on a cancelled statement, the way out. The bare driver message names
 * neither, which is what left an operator with a boot loop and no next step.
 */
export function describeMigrationFailure(message: string, migrationName?: string): string {
  const where = migrationName ? `migration ${migrationName} failed: ` : 'migration failed: ';
  const hint = isStatementTimeoutError(message) ? ` — ${TIMEOUT_HINT}` : '';
  return `${where}${message}${hint}`;
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

    const elapsedMs = new Map<string, number>();
    const migrator = new Migrator({
      db: opts.db,
      provider: instrumentProvider(createMigrationProvider(), elapsedMs),
    });

    const { results, error } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      const took = elapsedMs.get(result.migrationName);
      const suffix = took === undefined ? '' : ` (${took}ms)`;
      if (result.status === 'Success') {
        logger.info(`${result.migrationName} ... OK${suffix}`);
      } else if (result.status === 'Error') {
        logger.error(`${result.migrationName} ... FAILED${suffix}`);
      }
      // NotExecuted = already applied, skip silently
    }

    if (error) {
      const failed = (results ?? []).find((r) => r.status === 'Error')?.migrationName;
      const described = describeMigrationFailure(
        error instanceof Error ? error.message : String(error),
        failed,
      );
      logger.error(described);
      throw new Error(described, { cause: error });
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

/** What a `migrateTo` run did. */
export interface MigrateToResult {
  /** The migration the ledger now sits at. */
  target: string;
  /** Migrations applied to reach it (empty when moving backwards). */
  applied: string[];
  /** Migrations reverted to reach it (empty when moving forwards). */
  reverted: string[];
}

/**
 * A provider carrying only the migrations the ledger records as executed.
 *
 * Used to hash what the database actually holds, rather than what the binary
 * ships. Reads the ledger through the migrator that just ran it, so the two
 * can never disagree about which migrations survived.
 */
async function appliedSubsetProvider(
  migrator: Migrator,
  provider: MigrationProvider,
): Promise<MigrationProvider> {
  const executed = new Set(
    (await migrator.getMigrations()).filter((m) => m.executedAt).map((m) => m.name),
  );
  const all = await provider.getMigrations();
  const subset = Object.fromEntries(Object.entries(all).filter(([n]) => executed.has(n)));
  return { getMigrations: async () => subset };
}

/**
 * Migrate the ledger to a named migration, in either direction.
 *
 * The point of this is rollback: a previous release's static provider does not
 * carry the newer migrations' names, so Kysely refuses to start against a
 * ledger that records them (`corrupted migrations: previously executed
 * migration <name> is missing`). Reverting to the head that release was
 * running at is what makes the old binary bootable again.
 *
 * It runs under the same advisory lock as {@link runMigrations}, so a peer
 * cannot be applying migrations while this reverts them.
 */
export async function migrateTo(opts: MigrateOptions, name: string): Promise<MigrateToResult> {
  const client = await opts.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    const provider = createMigrationProvider();
    const known = Object.keys(await provider.getMigrations());
    if (!known.includes(name)) {
      throw new Error(
        `unknown migration "${name}" — this binary carries ${known.length} migration(s), ` +
          `ending at "${known[known.length - 1] ?? '(none)'}". ` +
          `Run "kici-admin db migrate --status" to list them.`,
      );
    }

    const migrator = new Migrator({ db: opts.db, provider });
    const { results, error } = await migrator.migrateTo(name);
    const applied: string[] = [];
    const reverted: string[] = [];
    for (const result of results ?? []) {
      if (result.status !== 'Success') continue;
      (result.direction === 'Down' ? reverted : applied).push(result.migrationName);
    }
    if (error) {
      const failed = (results ?? []).find((r) => r.status === 'Error')?.migrationName;
      const described = describeMigrationFailure(
        error instanceof Error ? error.message : String(error),
        failed,
      );
      logger.error(described);
      throw new Error(described, { cause: error });
    }

    for (const n of reverted) logger.info(`${n} ... REVERTED`);
    for (const n of applied) logger.info(`${n} ... OK`);

    // The content hash follows the LEDGER, not the code: `db check-schema`
    // compares the stored value against a hash of the binary's whole migration
    // set, so storing that same whole-set hash after a revert would report
    // "schema is current" on a database that is deliberately behind. Hashing
    // the applied subset leaves the two unequal, which is the drift the
    // operator needs to see; a move forward to the head applies every
    // migration, so the subset is the whole set and the check goes green on
    // its own.
    await storeMigrationContentHash(
      opts.pool,
      await computeMigrationsHash(await appliedSubsetProvider(migrator, provider)),
    );
    return { target: name, applied, reverted };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
  }
}
