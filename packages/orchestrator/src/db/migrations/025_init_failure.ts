import { type Kysely, sql } from 'kysely';

/**
 * `init_failure` on `execution_runs` / `execution_jobs`: non-NULL means the run/job never
 * executed a step because of an init-phase failure. Shape: `InitFailure` from
 * `@kici-dev/engine`. The dashboard reads it directly, so it renders the banner without a
 * round-trip to a possibly offline orchestrator.
 *
 * Idempotent per column.
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
