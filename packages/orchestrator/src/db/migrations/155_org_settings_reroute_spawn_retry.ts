import { type Kysely, sql } from 'kysely';

/**
 * Add the two per-org spawn-retry columns a worker applies to a rerouted job (both nullable):
 *
 * - `reroute_spawn_max_attempts INTEGER` — agent spawns a worker attempts for one rerouted
 *   job before it gives the job back to its coordinator. NULL falls back to the cluster
 *   default (`rerouteSpawnMaxAttempts`, 3).
 * - `reroute_spawn_retry_backoff_ms BIGINT` — wait after a failed spawn before the next
 *   attempt. NULL falls back to `rerouteSpawnRetryBackoffMs` (5 s).
 *
 * Operators tune them per org via `kici-admin org-settings reroute set`.
 *
 * Idempotent: each add is guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfMissing(db, 'reroute_spawn_max_attempts', 'INTEGER');
  await addColumnIfMissing(db, 'reroute_spawn_retry_backoff_ms', 'BIGINT');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS reroute_spawn_max_attempts`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS reroute_spawn_retry_backoff_ms`.execute(
    db,
  );
}

async function addColumnIfMissing(
  db: Kysely<unknown>,
  column: string,
  type: 'BIGINT' | 'INTEGER',
): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;
  // `column` and `type` are internal literals (never user input); safe to inline.
  await sql`ALTER TABLE public.org_settings ADD COLUMN ${sql.ref(column)} ${sql.raw(type)}`.execute(
    db,
  );
}
