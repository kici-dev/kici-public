import { type Kysely, sql } from 'kysely';

/**
 * Durable per-provision outcome, keyed by agent id.
 *
 * A `scaler_spawning_agents` row is deleted at teardown, so its absence cannot separate "never
 * adopted" (a real provisioning failure every coordinator must back off on) from "adopted, then
 * torn down" (healthy; never reported). The stale-spawn prune needs exactly that split.
 *
 * The adoption is written in the same transaction that stamps `adopted_by` and outlives the
 * spawn row. A separate table, not a column, because the per-coordinator provisioning backoff
 * depends on the spawn row's delete.
 *
 * `adopted_*` and `condemned_*` are independent: a provision adopted and later condemned
 * carries BOTH, and the condemn write never touches the adoption columns, or the
 * misattribution returns.
 *
 * The leader-gated reaper purges rows once the spawn row is gone and the retention floor has
 * passed (`ScalerStateStore.purgeProvisionOutcomes`).
 *
 * Idempotent: each statement is IF NOT EXISTS, covering a database with the table but not the
 * index, which a table-existence probe would skip.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.scaler_provision_outcomes (
      agent_id          TEXT PRIMARY KEY,
      scaler_name       TEXT        NOT NULL,
      adopted_by        TEXT,
      adopted_at        TIMESTAMPTZ,
      condemned_reason  TEXT,
      condemned_at      TIMESTAMPTZ,
      recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  // The purge filters on `updated_at`; unindexed, every reaper sweep would seq-scan a table
  // holding one row per provision the cluster ever made.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scaler_provision_outcomes_updated_at
      ON public.scaler_provision_outcomes (updated_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.scaler_provision_outcomes`.execute(db);
}
