import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.dispatch_routing_key TEXT NULL` — the source whose
 * credentials a run's `provider_context` actually holds.
 *
 * `routing_key` records the source the event ARRIVED on. For a cross-provider
 * global workflow those are two different sources: the lock file resolves
 * through another source's bundle, and `provider_context` is written from that
 * source's credentials. Anything that pairs the inbound routing key with the
 * stored context therefore hands one source's credentials to another source's
 * API client — the re-run of a failed evaluation round did exactly that, and
 * the resulting fetch either fails or reads the wrong tree.
 *
 * Nullable, with no default: NULL means "the same source the event arrived on",
 * which is true of every run except a cross-provider dispatch and of every row
 * written before this column existed. A default would have to name a routing
 * key, and there is no cluster-wide one to name.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'dispatch_routing_key'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN dispatch_routing_key TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS dispatch_routing_key
  `.execute(db);
}
