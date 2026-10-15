import { type Kysely, sql } from 'kysely';

/**
 * Add `host_roster.s3_reachable`, a fresh-box bring-up delivery hint set via
 * `kici-admin host declare --s3-reachable`. True: the box reaches the orchestrator's object
 * storage, so bring-up uses `s3-direct` (the box pulls the payload via a presigned URL, no 50 MB
 * through the ops agent). NULL / false: the `ssh-push` fallback (the ops agent fetches the
 * payload and scp's it to the box). Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'host_roster'
         AND column_name = 's3_reachable'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.host_roster
      ADD COLUMN s3_reachable BOOLEAN
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.host_roster DROP COLUMN IF EXISTS s3_reachable
  `.execute(db);
}
