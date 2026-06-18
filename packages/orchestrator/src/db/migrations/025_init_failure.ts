import { type Kysely, sql } from 'kysely';

/**
 * Add `init_failure jsonb` columns to `execution_runs` and `execution_jobs`.
 *
 * Presence of this column on a row means the run/job never executed a step
 * because of an init-phase failure; absence (NULL) means a normal run.
 * Shape on the wire is `InitFailure` from `@kici-dev/engine`. The dashboard
 * reads this column directly so it can render the right banner without
 * round-tripping to the orchestrator (which may be offline).
 *
 * Idempotent: re-running on a DB that already has either column is a no-op
 * for that column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colExists = async (table: string, name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ${table}
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  if (!(await colExists('execution_runs', 'init_failure'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN init_failure JSONB DEFAULT NULL
    `.execute(db);
  }

  if (!(await colExists('execution_jobs', 'init_failure'))) {
    await sql`
      ALTER TABLE public.execution_jobs
        ADD COLUMN init_failure JSONB DEFAULT NULL
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS init_failure
  `.execute(db);
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS init_failure
  `.execute(db);
}
