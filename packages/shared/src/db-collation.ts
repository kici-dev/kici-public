import pg from 'pg';

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
