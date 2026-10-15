import { type Kysely, sql } from 'kysely';

/**
 * Add `host_roster.scaler_managed`: whether a scaler backend spawned the agent.
 *
 * `runsOnAll` fans a job out across the declared fleet, and every registering agent upserts a
 * roster row, so a pre-spawned warm agent was a fan-out target and a child pinned to it ran at
 * the pool's fixed shape rather than its own.
 *
 * Written from the scaler manager's registration lookup (a spawn record exists for the agent
 * id), NOT from `lifecycle_class`, which snapshots the auth TOKEN's type and is `ephemeral` for
 * every agent in auth mode `none`.
 *
 * DEFAULT false is load-bearing: a pre-existing row reads as not-scaler-managed, so an existing
 * fleet host stays a fan-out target without re-registering. Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'host_roster'
         AND column_name = 'scaler_managed'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.host_roster
      ADD COLUMN scaler_managed boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.host_roster DROP COLUMN IF EXISTS scaler_managed
  `.execute(db);
}
