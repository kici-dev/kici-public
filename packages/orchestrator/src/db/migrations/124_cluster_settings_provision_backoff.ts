import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global tunables for backing off a repeatedly failing external (event) scaler.
 *
 * An external provision dispatches a customer workflow that drives a cloud provider. When the
 * provider is down, every dispatch fails and the next retries as soon as the spawn timeout
 * elapses: an unbounded loop these columns bound. Additive and nullable; NULL is the configured
 * default (the `KICI_SCALER_PROVISION_*` env vars).
 *
 * - `scaler_provision_backoff_base_ms` — the deferral after one failure; each further failure
 *   doubles it.
 * - `scaler_provision_backoff_max_ms` — the doubling's ceiling, so a long outage settles into a
 *   steady retry cadence.
 * - `scaler_provision_max_consecutive_failures` — consecutive failures before refusals name
 *   repeated failure, rather than a single timeout, as the cause.
 *
 * Read per spawn request, so a change needs no restart. BIGINT because the windows are in ms and
 * a ceiling widened to a day leaves INTEGER range; the count shares the type so all read back
 * through one code path. Each column add is guarded.
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
