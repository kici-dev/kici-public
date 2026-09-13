import { type Kysely, sql } from 'kysely';

/**
 * Denormalize the owning org onto `execution_runs` so the concurrency-gate
 * running count can be scoped per tenant.
 *
 * - `customer_id TEXT NOT NULL DEFAULT '__default__'` — the org that owns the
 *   run, resolved from `routing_key` at insert time. The default mirrors the
 *   orchestrator's own no-source fallback org, so a single-tenant orchestrator
 *   is unchanged (every row shares `__default__`).
 * - Backfill maps each existing row's `routing_key` to a `customer_id` across
 *   the three source tables (`sources`, `generic_webhook_sources`,
 *   `remote_sources`), falling back to `__default__` for unmatched / null keys.
 * - Index `(customer_id, context)` supports the scoped count query in
 *   `applyContextRulesAndSecrets`.
 *
 * Idempotent: re-running skips the column when it already exists.
 */
async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'customer_id'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN customer_id TEXT NOT NULL DEFAULT '__default__'
    `.execute(db);

    // Backfill from the source tables by routing_key; unmatched / null keys
    // keep the '__default__' column default.
    await sql`
      UPDATE public.execution_runs er
      SET customer_id = COALESCE(
        (SELECT s.customer_id FROM public.sources s
           WHERE s.routing_key = er.routing_key),
        (SELECT g.customer_id FROM public.generic_webhook_sources g
           WHERE g.routing_key = er.routing_key),
        (SELECT r.customer_id FROM public.remote_sources r
           WHERE r.routing_key = er.routing_key),
        '__default__')
      WHERE er.routing_key IS NOT NULL
    `.execute(db);
  }

  await sql`
    CREATE INDEX IF NOT EXISTS execution_runs_customer_id_context_idx
      ON public.execution_runs (customer_id, context)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS execution_runs_customer_id_context_idx`.execute(db);
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS customer_id
  `.execute(db);
}
