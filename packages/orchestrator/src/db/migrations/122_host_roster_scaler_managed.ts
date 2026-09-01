import { type Kysely, sql } from 'kysely';

/**
 * Add `host_roster.scaler_managed boolean NOT NULL DEFAULT false`.
 *
 * `runsOnAll` fans a job out across the declared fleet. Every registering agent
 * upserts a roster row, auto-scaler-spawned ones included, so a pre-spawned
 * warm agent was a valid fan-out target — and a child pinned to it runs at the
 * pool's fixed shape rather than its own. This column records the one fact that
 * separates the two populations: whether a scaler backend spawned the agent.
 *
 * It is written from the scaler manager's registration lookup (a spawn record
 * exists for the agent id), NOT from `lifecycle_class`. `lifecycle_class`
 * snapshots the auth TOKEN's type and is `ephemeral` for every agent when the
 * auth mode is `none`, so it cannot distinguish a fleet host from a scaler
 * agent in that mode.
 *
 * DEFAULT false is load-bearing: a row written before this migration must read
 * as not-scaler-managed so an existing fleet host stays a fan-out target
 * immediately, without waiting to re-register.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
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
