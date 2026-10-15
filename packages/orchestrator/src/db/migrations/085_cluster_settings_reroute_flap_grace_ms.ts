import { type Kysely, sql } from 'kysely';

/**
 * Fleet-wide grace window (ms) in which the recovery sweepers defer a rerouted job while its
 * worker peer flaps. NULL → cluster default (`config.rerouteFlapGraceMs`,
 * `KICI_REROUTE_FLAP_GRACE_MS`).
 *
 * Idempotent: guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'reroute_flap_grace_ms'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN reroute_flap_grace_ms BIGINT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS reroute_flap_grace_ms`.execute(
    db,
  );
}
