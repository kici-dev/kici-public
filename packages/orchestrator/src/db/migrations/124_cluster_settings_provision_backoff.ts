import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global tunables for backing off a repeatedly failing external
 * (event) scaler.
 *
 * An external provision is dispatched to a customer workflow that drives a
 * cloud provider. When that provider is unavailable, every dispatch fails the
 * same way and the next one is retried as soon as the spawn timeout elapses —
 * an unbounded dispatch loop against a provider that is already refusing work.
 * These three columns bound it.
 *
 * Three additive, nullable columns. NULL means the orchestrator's configured
 * default applies (the `KICI_SCALER_PROVISION_*` env vars stay as the
 * cluster-wide defaults).
 *
 * - `scaler_provision_backoff_base_ms` — the first deferral after one
 *   consecutive failure. Each further failure doubles it.
 * - `scaler_provision_backoff_max_ms` — the ceiling the doubling is capped at,
 *   so a long outage settles into a steady retry cadence rather than growing
 *   without bound.
 * - `scaler_provision_max_consecutive_failures` — how many consecutive failures
 *   a scaler may record before its refusals name repeated failure as the cause
 *   rather than a single timeout.
 *
 * All three are read per spawn request, so a change lands on the next request
 * with no restart.
 *
 * BIGINT rather than INTEGER: the two windows are in milliseconds, and an
 * operator widening the ceiling to a day leaves INTEGER range. The failure
 * count shares the type so the three read back through one code path.
 *
 * Idempotent: each column is guarded on existence, so a re-run is a no-op.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

const COLUMNS = [
  'scaler_provision_backoff_base_ms',
  'scaler_provision_backoff_max_ms',
  'scaler_provision_max_consecutive_failures',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    if (!(await columnExists(db, 'cluster_settings', column))) {
      await sql`ALTER TABLE public.cluster_settings ADD COLUMN ${sql.ref(column)} BIGINT`.execute(
        db,
      );
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ${sql.ref(column)}`.execute(
      db,
    );
  }
}
