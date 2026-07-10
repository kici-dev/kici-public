import pg from 'pg';
import { toErrorMessage } from '@kici-dev/core';

/**
 * Collation-drift helpers shared between `kici-admin` (orchestrator DB) and
 * `kici-platform-admin` (Platform DB).
 *
 * Background: `pg_database.datcollversion` records the libc collation version
 * at database-bootstrap time. B-tree indexes on text columns were built under
 * those collation rules. When the running Postgres process's libc collation
 * version differs (commonly after a container image rebuild on a newer libc
 * base), indexes can silently misindex non-ASCII data — `LIKE 'foo%'` may miss
 * rows, `ORDER BY` becomes unstable, rule-equivalent duplicates can sneak past
 * unique constraints.
 *
 * Detection compares `datcollversion` (the version stamped at bootstrap)
 * against `pg_database_collation_actual_version(oid)` (the version the running
 * libc reports). Healing is a two-step operator action:
 *
 * 1. `REINDEX DATABASE CONCURRENTLY <name>` — rebuild every index under the
 *    running libc rules. Non-blocking (short locks per index); needs ~2× temp
 *    disk while parallel indexes coexist.
 * 2. `ALTER DATABASE <name> REFRESH COLLATION VERSION` — bump the metadata
 *    stamp so future probes report clean.
 *
 * All callers pass a `pg.Pool`. The helpers do not own pool lifecycle — the
 * CLI / probe layer creates and ends pools using the standard
 * `createPool` / `pool.end()` pattern from `db.js`.
 */

export interface CollationDrift {
  /** Version stamped into pg_database.datcollversion at bootstrap. */
  stamped: string;
  /** Version the running libc reports via pg_database_collation_actual_version. */
  actual: string;
}

/**
 * Read `pg_database.datcollversion` and
 * `pg_database_collation_actual_version(oid)` for `dbName` and return drift
 * details when they differ. Returns `null` when stamped === actual OR when
 * stamped is null (Postgres marks template0-style locked databases that way —
 * benign, no drift to report).
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
    // template0-style locked DBs leave datcollversion null. Benign.
    return null;
  }
  if (row.actual === null) {
    // Should not happen for a live DB; treat as drift surfaced via empty actual.
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
 * Issue `REINDEX DATABASE CONCURRENTLY <quoted_db>`. Rebuilds every index in
 * the database under the running libc collation rules.
 *
 * Identifier escaping uses `pg.escapeIdentifier` so a database name containing
 * a double-quote (legal in Postgres) is quoted correctly.
 *
 * REINDEX DATABASE CONCURRENTLY refuses to run inside a transaction block, so
 * the helper issues the query directly via `pool.query` (no explicit BEGIN);
 * `node-postgres` does not start an implicit transaction.
 */
export async function reindexDatabaseConcurrently(pool: pg.Pool, dbName: string): Promise<void> {
  const quoted = pg.escapeIdentifier(dbName);
  await pool.query(`REINDEX DATABASE CONCURRENTLY ${quoted}`);
}

/**
 * Issue `ALTER DATABASE <quoted_db> REFRESH COLLATION VERSION`. Updates
 * `pg_database.datcollversion` to match the running libc's reported version.
 * Metadata-only; safe to run any time after a REINDEX has rebuilt the indexes.
 */
export async function refreshDatabaseCollationVersion(
  pool: pg.Pool,
  dbName: string,
): Promise<void> {
  const quoted = pg.escapeIdentifier(dbName);
  await pool.query(`ALTER DATABASE ${quoted} REFRESH COLLATION VERSION`);
}

/**
 * The two-step operator remediation for collation drift on `dbName`, as a
 * single copy-pasteable string. Surfaced in the startup ERROR line and the
 * hard-fail message so an operator sees exactly what to run.
 */
export function collationDriftRemediation(dbName: string): string {
  const quoted = pg.escapeIdentifier(dbName);
  return (
    `REINDEX DATABASE CONCURRENTLY ${quoted}; ` +
    `ALTER DATABASE ${quoted} REFRESH COLLATION VERSION;`
  );
}

/**
 * Minimal structural logger the startup check needs. `winston.Logger`
 * satisfies it, so both the orchestrator and Platform pass their own logger
 * without a shared winston dependency here.
 */
export interface CollationDriftStartupLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Env var name that turns a detected drift into a startup refusal. */
export const FAIL_ON_COLLATION_DRIFT_ENV = 'KICI_DB_FAIL_ON_COLLATION_DRIFT';

/**
 * Read the opt-in hard-fail toggle from an environment map. When set to
 * `true`, {@link checkCollationDriftAtStartup} throws on detected drift instead
 * of logging and continuing. Defaults to off (detect + warn loudly).
 */
export function shouldFailOnCollationDrift(env: NodeJS.ProcessEnv): boolean {
  return env[FAIL_ON_COLLATION_DRIFT_ENV] === 'true';
}

/**
 * Boot-time collation-drift guard shared by the orchestrator and Platform.
 *
 * Runs {@link getDatabaseCollationDrift} after the DB connection + migrations
 * are up and before the service starts serving. Behavior:
 *
 * - **No drift** → logs one info line and returns `null`.
 * - **Drift** → logs a single loud, structured ERROR line naming the database,
 *   the recorded-vs-actual collation versions, the exact remediation command,
 *   and the risk (text index lookups may silently miss present rows — the
 *   failure mode that read a present source private key back as absent). Does
 *   NOT crash by default; a drifted DB still serves most traffic and crashing
 *   every node is worse than a loud, alertable warning. Returns the drift.
 * - **`failOnDrift: true`** (opt-in via {@link FAIL_ON_COLLATION_DRIFT_ENV})
 *   → throws after logging, so strict operators can refuse to boot on drift.
 * - **Probe failure** (the query itself throws) → logs a WARN and returns
 *   `null`. A probe bug must never take down every node; unconfirmed drift is
 *   not a reason to crash, and `failOnDrift` gates confirmed drift only.
 *
 * The caller is responsible for reflecting the result into its
 * `kici_db_collation_drift{database=…}` gauge (1 on drift, 0 clean).
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
