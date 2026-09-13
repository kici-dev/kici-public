import { type Kysely, sql } from 'kysely';

/**
 * Durable per-provision outcome, keyed by agent id.
 *
 * `scaler_spawning_agents` is deleted the moment a provision is torn down, so
 * its absence cannot tell "this provision was never adopted" from "this
 * provision was adopted and has since been torn down". The stale-spawn prune
 * has to separate exactly those two, because the first is a real external
 * provisioning failure every coordinator must back off on, and the second is a
 * healthy provision that must not be reported at all.
 *
 * This table carries the positive signal the spawn row cannot: the adoption is
 * written in the same transaction that stamps `adopted_by`, and it outlives the
 * spawn row's delete. Deliberately a separate table rather than a column on
 * `scaler_spawning_agents`: that row's delete is what the per-coordinator
 * provisioning backoff depends on, so it is left exactly as it is.
 *
 * `adopted_*` and `condemned_*` are independent. A provision that was adopted
 * and later condemned by the reaper carries BOTH, and the condemn write never
 * touches the adoption columns — losing the adoption fact would restore the
 * misattribution this table exists to remove.
 *
 * Rows are purged by the leader-gated reaper once the spawn row is gone and the
 * retention floor has passed; see `ScalerStateStore.purgeProvisionOutcomes`.
 *
 * Idempotent: both statements are guarded by IF NOT EXISTS, so a re-run is a
 * no-op — including a re-run over a database that has the table but not the
 * index, which an existence probe over the table alone would skip.
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

  // The purge scans on `updated_at` (`WHERE updated_at < cutoff AND NOT EXISTS
  // (the spawn row)`), so without this it is a sequential scan on every reaper
  // sweep of a table that holds one row per provision the cluster ever made.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_scaler_provision_outcomes_updated_at
      ON public.scaler_provision_outcomes (updated_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.scaler_provision_outcomes`.execute(db);
}
