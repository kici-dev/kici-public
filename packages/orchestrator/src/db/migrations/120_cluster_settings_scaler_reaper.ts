import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global tunables for the leader-gated event-scaler provision reaper.
 *
 * Four additive, nullable columns. NULL means the orchestrator's configured
 * default applies (the `KICI_SCALER_REAP_*` / `KICI_SCALER_CLAIM_RETENTION_MS`
 * env vars stay as the cluster-wide defaults).
 *
 * - `scaler_reap_interval_ms` — how often the leader sweeps. Re-read at the end
 *   of every sweep, so a change reschedules the timer on the next tick.
 * - `scaler_reap_stranded_timeout_ms` — how long an adopted provision whose
 *   agent is registered on no coordinator may sit before teardown.
 * - `scaler_reap_reattempt_interval_ms` — how long before a provision whose
 *   teardown did not clear its row is retried.
 * - `scaler_claim_retention_ms` — how long an expired provisioning claim is kept
 *   before the same sweep deletes it.
 *
 * The three windows are read per sweep, so a change lands on the next tick with
 * no restart.
 *
 * BIGINT rather than INTEGER: every value is in milliseconds, and a retention
 * window an operator widens to a few weeks leaves INTEGER range.
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
