import { type Kysely, sql } from 'kysely';

/**
 * `execution_runs.pr_number` lets `/kici approve|reject` scope hold selection to the comment's
 * PR (and repo) instead of every pending security hold in the org. Non-PR runs leave it NULL;
 * they are never security-held, and NULL never matches the PR-scoped hold query (fail-closed).
 *
 * Idempotent.
 */
async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'pr_number'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN pr_number INTEGER
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS pr_number
  `.execute(db);
}
