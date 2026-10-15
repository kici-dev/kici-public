import { type Kysely, sql } from 'kysely';

/**
 * Triggering-actor columns on `execution_runs`:
 *
 *  - `trigger_actor_provider` — origin provider of the identity (`github`;
 *    provider-generic).
 *  - `trigger_actor_username` — provider login of who triggered the run (e.g.
 *    the GitHub pusher / PR author).
 *  - `trigger_actor_user_id` — immutable provider user id (mirrors
 *    `identity_links.provider_user_id`), preferred over the mutable username
 *    when resolving the actor to a KiCI user.
 *
 * Captured for ALL event types (push/tag/PR/comment), unlike the PR-only
 * `contributor_username`. All nullable, no backfill, idempotent.
 */
async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_runs', 'trigger_actor_provider'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN trigger_actor_provider text`.execute(db);
  }
  if (!(await colExists(db, 'execution_runs', 'trigger_actor_username'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN trigger_actor_username text`.execute(db);
  }
  if (!(await colExists(db, 'execution_runs', 'trigger_actor_user_id'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN trigger_actor_user_id text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS trigger_actor_provider`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS trigger_actor_username`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS trigger_actor_user_id`.execute(
    db,
  );
}
