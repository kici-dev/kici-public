import { type Kysely, sql } from 'kysely';

/**
 * Add pattern columns to dispatch_queue. Exact labels stay in runs_on_labels /
 * exclude_labels (the SQL @> prefilter); regex matchers go here and are applied
 * as a JS post-filter at drain time, since Postgres `~` regex semantics differ
 * from JavaScript `RegExp` and the engine's `matcherSatisfiedBy` is the single
 * matching authority.
 *
 * - `runs_on_patterns jsonb NOT NULL DEFAULT '[]'` — regex matchers the agent's
 *   labels must satisfy.
 * - `exclude_patterns jsonb NOT NULL DEFAULT '[]'` — regex matchers that
 *   disqualify an agent.
 *
 * Idempotent: re-running on a DB that already has the columns is a no-op.
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
  if (!(await colExists(db, 'dispatch_queue', 'runs_on_patterns'))) {
    await sql`ALTER TABLE public.dispatch_queue ADD COLUMN runs_on_patterns jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(
      db,
    );
  }
  if (!(await colExists(db, 'dispatch_queue', 'exclude_patterns'))) {
    await sql`ALTER TABLE public.dispatch_queue ADD COLUMN exclude_patterns jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS exclude_patterns`.execute(db);
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS runs_on_patterns`.execute(db);
}
