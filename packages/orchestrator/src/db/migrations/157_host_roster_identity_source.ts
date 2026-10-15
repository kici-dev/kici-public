import { type Kysely, sql } from 'kysely';

/**
 * `host_roster.identity_source` (`agent` | `operator` | `platform`): who last set a host's
 * identity (labels, hostname, properties) — its agent registration, a local
 * `kici-admin host declare`, or a Platform-relayed dashboard declare. A `platform` row is an
 * unconfirmed placeholder that fan-out, inventory and the unreachable alarm skip.
 *
 * Backfill: only an agent registration writes the `platform` column, so a row with it set
 * becomes `agent`. Others stay `operator`: an older dashboard-created row is indistinguishable
 * from a `kici-admin` declare, and `platform` would drop every declared, never-connected host
 * out of fan-out.
 *
 * Idempotent.
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
