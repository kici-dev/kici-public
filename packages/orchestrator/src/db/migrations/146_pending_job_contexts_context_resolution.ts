import { type Kysely, sql } from 'kysely';

/**
 * Record, with a held job's pending dispatch context, what the release path
 * resolves the job's context variables and secrets from.
 *
 * `pending_job_contexts.context_resolution` names the contexts that admitted
 * the job, the org, the routing key and the registry-auth inputs. It holds no
 * secret value: the values are resolved when the hold is released.
 *
 * Nullable and unbackfilled: null for every pending job that no context gate
 * held, and on every row written before this column existed. Such a row
 * dispatches its stored input unchanged.
 *
 * Idempotent: guarded on the column's existence, so re-running is a no-op.
 */
async function colExists(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pending_job_contexts'
         AND column_name = 'context_resolution'
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db))) {
    await sql`ALTER TABLE public.pending_job_contexts ADD COLUMN context_resolution jsonb`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.pending_job_contexts DROP COLUMN IF EXISTS context_resolution`.execute(
    db,
  );
}
