import { type Kysely, sql } from 'kysely';

/**
 * Add `host_roster.identity_source text NOT NULL DEFAULT 'operator'`, limited
 * to `agent`, `operator` and `platform`.
 *
 * It records who last set a host's identity (labels, hostname, properties):
 * the host's own agent registration, a local `kici-admin host declare`, or a
 * Platform-relayed dashboard declare. A `platform` row is an unconfirmed
 * placeholder that fan-out, inventory and the unreachable alarm skip.
 *
 * Backfill: a row whose `platform` column is set has registered at least once
 * (only an agent registration writes `platform`), so it becomes `agent`. Every
 * other row stays `operator`: a dashboard-created row from before this column
 * cannot be told apart from a `kici-admin` declare, and treating it as
 * `platform` would drop every declared, never-connected host out of fan-out.
 *
 * Idempotent: a re-run on a database that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'host_roster'
         AND column_name = 'identity_source'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.host_roster
      ADD COLUMN identity_source text NOT NULL DEFAULT 'operator'
        CONSTRAINT host_roster_identity_source_check
        CHECK (identity_source IN ('agent', 'operator', 'platform'))
  `.execute(db);
  await sql`
    UPDATE public.host_roster SET identity_source = 'agent' WHERE platform IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster DROP COLUMN IF EXISTS identity_source`.execute(db);
}
