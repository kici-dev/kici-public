import { type Kysely, sql } from 'kysely';

/**
 * Add dispatch_queue `runs_on_patterns` (regex matchers the agent's labels must satisfy) and
 * `exclude_patterns` (matchers that disqualify an agent). Exact labels stay in runs_on_labels /
 * exclude_labels (the SQL @> prefilter); patterns are a JS post-filter at drain time, because
 * Postgres `~` differs from JavaScript `RegExp` and the engine's `matcherSatisfiedBy` is the
 * single matching authority. Idempotent.
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
