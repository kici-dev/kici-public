import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.dispatch_routing_key TEXT NULL` — the source whose
 * credentials a run's `provider_context` actually holds.
 *
 * `routing_key` is the source the event ARRIVED on. For a cross-provider global
 * workflow the lock file resolves through another source's bundle, whose
 * credentials fill `provider_context`. Pairing the inbound routing key with that
 * context hands one source's credentials to another's API client (as the re-run
 * of a failed evaluation round did): the fetch fails or reads the wrong tree.
 *
 * Nullable, no default: NULL means the arrival source, true of every run except
 * a cross-provider dispatch and of every older row. There is no cluster-wide
 * routing key a default could name.
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
