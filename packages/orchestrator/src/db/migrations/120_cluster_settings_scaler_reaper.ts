import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global tunables for the leader-gated event-scaler provision reaper: additive, nullable
 * columns where NULL is the configured default (the `KICI_SCALER_REAP_*` /
 * `KICI_SCALER_CLAIM_RETENTION_MS` env vars).
 *
 * - `scaler_reap_interval_ms` — sweep cadence; re-read after every sweep, so a change
 *   reschedules the timer on the next tick.
 * - `scaler_reap_stranded_timeout_ms` — how long an adopted provision whose agent is registered
 *   on no coordinator sits before teardown.
 * - `scaler_reap_reattempt_interval_ms` — delay before retrying a provision whose teardown did
 *   not clear its row.
 * - `scaler_claim_retention_ms` — how long the sweep keeps an expired provisioning claim.
 *
 * The windows are read per sweep, so a change needs no restart. BIGINT because every value is in
 * ms and a retention widened to a few weeks leaves INTEGER range. Each column add is guarded.
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
  'scaler_reap_interval_ms',
  'scaler_reap_stranded_timeout_ms',
  'scaler_reap_reattempt_interval_ms',
  'scaler_claim_retention_ms',
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
