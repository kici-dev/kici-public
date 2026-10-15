import pg from 'pg';
import { toErrorMessage } from '@kici-dev/core';

/**
 * Collation-drift helpers shared by `kici-admin` (orchestrator DB) and
 * `kici-platform-admin` (Platform DB).
 *
 * `pg_database.datcollversion` stamps the libc collation version at bootstrap,
 * and text b-tree indexes follow those rules. When the running libc differs
 * (commonly after an image rebuild on a newer base), non-ASCII data can be
 * silently misindexed: `LIKE 'foo%'` misses rows, `ORDER BY` turns unstable,
 * rule-equivalent duplicates slip past unique constraints.
 *
 * Detection compares `datcollversion` with
 * `pg_database_collation_actual_version(oid)`. Healing is two operator steps:
 *
 * 1. `REINDEX DATABASE CONCURRENTLY <name>` — non-blocking (short per-index
 *    locks); needs ~2× temp disk while parallel indexes coexist.
 * 2. `ALTER DATABASE <name> REFRESH COLLATION VERSION` — bump the stamp so
 *    future probes report clean.
 *
 * The helpers never own the `pg.Pool` lifecycle; the CLI / probe layer
 * creates and ends it.
 */

export interface CollationDrift {
  /** pg_database.datcollversion, stamped at bootstrap. */
  stamped: string;
  /** Reported by the running libc via pg_database_collation_actual_version. */
  actual: string;
}

/**
 * Returns `null` when stamped === actual, or when stamped is null (benign:
 * Postgres marks template0-style locked databases that way).
 */
export async function getDatabaseCollationDrift(
  pool: pg.Pool,
  dbName: string,
): Promise<CollationDrift | null> {
  const result = await pool.query<{ stamped: string | null; actual: string | null }>(
    `SELECT datcollversion AS stamped,
            pg_database_collation_actual_version(oid) AS actual
       FROM pg_database
      WHERE datname = $1`,
    [dbName],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`getDatabaseCollationDrift: database not found: ${dbName}`);
  }
  if (row.stamped === null) {
    return null;
  }
  if (row.actual === null) {
    // Never expected for a live DB.
    throw new Error(
      `getDatabaseCollationDrift: pg_database_collation_actual_version returned null for ${dbName}`,
    );
  }
  if (row.stamped === row.actual) {
    return null;
  }
  return { stamped: row.stamped, actual: row.actual };
}

/**
 * `pg.escapeIdentifier` quotes a name containing a double-quote (legal in
 * Postgres). REINDEX DATABASE CONCURRENTLY refuses a transaction block, so this
 * is a bare `pool.query` (node-postgres starts no implicit transaction).
 */
export async function reindexDatabaseConcurrently(pool: pg.Pool, dbName: string): Promise<void> {
  const quoted = pg.escapeIdentifier(dbName);
  await pool.query(`REINDEX DATABASE CONCURRENTLY ${quoted}`);
}

/** Metadata-only; safe any time after a REINDEX has rebuilt the indexes. */
export async function refreshDatabaseCollationVersion(
  pool: pg.Pool,
  dbName: string,
): Promise<void> {
  const quoted = pg.escapeIdentifier(dbName);
  await pool.query(`ALTER DATABASE ${quoted} REFRESH COLLATION VERSION`);
}

/** The two-step remediation as one copy-pasteable string, for the startup ERROR line and hard-fail message. */
export function collationDriftRemediation(dbName: string): string {
  const quoted = pg.escapeIdentifier(dbName);
  return (
    `REINDEX DATABASE CONCURRENTLY ${quoted}; ` +
    `ALTER DATABASE ${quoted} REFRESH COLLATION VERSION;`
  );
}

/** `winston.Logger` satisfies this, so no shared winston dependency is needed here. */
export interface CollationDriftStartupLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Env var that turns detected drift into a startup refusal. */
export const FAIL_ON_COLLATION_DRIFT_ENV = 'KICI_DB_FAIL_ON_COLLATION_DRIFT';

/**
 * When `true`, {@link checkCollationDriftAtStartup} throws on drift instead of
 * logging and continuing. Default off (detect + warn loudly).
 */
export function shouldFailOnCollationDrift(env: NodeJS.ProcessEnv): boolean {
  return env[FAIL_ON_COLLATION_DRIFT_ENV] === 'true';
}

/**
 * Boot-time drift guard for the orchestrator and Platform, run after the DB
 * connection + migrations are up and before serving.
 *
 * - **No drift** → one info line; returns `null`.
 * - **Drift** → one structured ERROR line naming the database, both versions,
 *   the remediation and the risk (text index lookups may miss present rows —
 *   the failure that read a present source private key back as absent).
 *   Does NOT crash by default: a drifted DB still serves most traffic, and
 *   crashing every node is worse than an alertable warning. Returns the drift.
 * - **`failOnDrift: true`** (via {@link FAIL_ON_COLLATION_DRIFT_ENV}) → throws
 *   after logging.
 * - **Probe failure** → WARN and `null`. A probe bug must never take down every
 *   node; `failOnDrift` gates confirmed drift only.
 *
 * The caller sets its `kici_db_collation_drift{database=…}` gauge (1 drift, 0 clean).
 */
export async function checkCollationDriftAtStartup(
  pool: pg.Pool,
  dbName: string,
  logger: CollationDriftStartupLogger,
  options: { failOnDrift?: boolean } = {},
): Promise<CollationDrift | null> {
  let drift: CollationDrift | null;
  try {
    drift = await getDatabaseCollationDrift(pool, dbName);
  } catch (err) {
    logger.warn('Collation-drift startup probe failed; skipping drift check', {
      database: dbName,
      error: toErrorMessage(err),
    });
    return null;
  }

  if (!drift) {
    logger.info('Database collation version is consistent', { database: dbName });
    return null;
  }

  logger.error(
    'Database collation drift detected — text-column b-tree indexes may silently miss present rows ' +
      '(e.g. secrets/sources reads reporting present rows as missing). Repair with the remediation below.',
    {
      database: dbName,
      stampedCollationVersion: drift.stamped,
      actualCollationVersion: drift.actual,
      remediation: collationDriftRemediation(dbName),
      risk: 'corrupted-text-btree-index',
    },
  );

  if (options.failOnDrift) {
    throw new Error(
      `Database "${dbName}" has collation drift (stamped=${drift.stamped}, actual=${drift.actual}) ` +
        `and ${FAIL_ON_COLLATION_DRIFT_ENV} is set. Remediate: ${collationDriftRemediation(dbName)}`,
    );
  }

  return drift;
}
