import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global ceiling on how long webhook processing waits for a Tier-2
 * global eval round to settle.
 *
 * One additive, nullable column. NULL means the orchestrator's configured
 * default applies (`KICI_GLOBAL_EVAL_WAIT_TIMEOUT_MS` stays the cluster-wide
 * default). It is read fresh per round and applies orchestrator-side — unlike
 * the two agent budgets, which are shipped inside the round's job config — so a
 * change lands on the next push.
 *
 * BIGINT rather than INTEGER: the value is in milliseconds, so an operator
 * raising it leaves INTEGER range with a single generous value.
 *
 * Idempotent: the column is guarded on existence, so a re-run is a no-op.
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

const COLUMNS = ['global_eval_wait_timeout_ms'] as const;

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
