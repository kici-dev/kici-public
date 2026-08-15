import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global tunables for the Tier-2 global eval round — the pre-run job
 * that evaluates each candidate global workflow's `filter` and generators on one
 * shared checkout of the source and workflow repos.
 *
 * Three additive, nullable columns. NULL means the orchestrator's configured
 * default applies (the `KICI_GLOBAL_EVAL_*` env vars stay as the cluster-wide
 * defaults). The two budgets are read per round and shipped to the agent in the
 * round's job config, so a change lands on the next push; `global_eval_cache_max`
 * sizes an LRU built once at boot and therefore applies at the next restart.
 *
 * BIGINT rather than INTEGER: the budgets are in milliseconds, so an operator
 * raising one leaves INTEGER range with a single generous value.
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
  'global_eval_round_timeout_ms',
  'global_eval_candidate_timeout_ms',
  'global_eval_cache_max',
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
