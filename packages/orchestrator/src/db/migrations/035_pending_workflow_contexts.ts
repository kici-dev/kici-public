import { type Kysely, sql } from 'kysely';

/**
 * Pending workflow dispatch context — backs resume of a workflow whose install
 * gate held. One row per held run: the serializable dispatch inputs needed to
 * rebuild the WorkflowDispatchContext when the hold releases (reviewer approve,
 * wait-timer expiry, concurrency slot free). The row is deleted once the resume
 * dispatch has been kicked off.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.pending_workflow_contexts (
      run_id     text PRIMARY KEY,
      org_id     text NOT NULL,
      context    jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.pending_workflow_contexts`.execute(db);
}
