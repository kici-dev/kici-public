import { type Kysely, sql } from 'kysely';

/**
 * Add the three reroute-tunable columns to `org_settings` (all nullable):
 *
 * - `reroute_spawn_window_ms BIGINT` — how long the coordinator waits after a
 *   peer ACKs a reroute before treating "accepted but no progress" as a spawn
 *   failure and re-dispatching. NULL falls back to the cluster default
 *   (`rerouteSpawnWindowMs`, 90s).
 * - `reroute_ack_timeout_ms BIGINT` — the reroute `sendAndWaitAck` deadline.
 *   NULL falls back to `rerouteAckTimeoutMs` (15s).
 * - `reroute_max_hops INTEGER` — maximum peer hops for a rerouted job. NULL
 *   falls back to `rerouteMaxHops` (3).
 *
 * Operators tune them per-org via `kici-admin org-settings`.
 *
 * Idempotent: each column add is guarded on column existence, so a re-run on a
 * DB that already has a column is a no-op for that column.
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
