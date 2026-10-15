import { type Kysely, sql } from 'kysely';

/**
 * Add the per-org reroute tunables to `org_settings` (nullable; NULL is the cluster default; set
 * via `kici-admin org-settings`). Each add is guarded on column existence.
 *
 * - `reroute_spawn_window_ms` — wait after a peer ACKs a reroute before "accepted but no
 *   progress" counts as a spawn failure and re-dispatches (`rerouteSpawnWindowMs`, 90s).
 * - `reroute_ack_timeout_ms` — the reroute `sendAndWaitAck` deadline (`rerouteAckTimeoutMs`, 15s).
 * - `reroute_max_hops` — max peer hops for a rerouted job (`rerouteMaxHops`, 3).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfMissing(db, 'reroute_spawn_window_ms', 'BIGINT');
  await addColumnIfMissing(db, 'reroute_ack_timeout_ms', 'BIGINT');
  await addColumnIfMissing(db, 'reroute_max_hops', 'INTEGER');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS reroute_spawn_window_ms`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS reroute_ack_timeout_ms`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS reroute_max_hops`.execute(db);
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
