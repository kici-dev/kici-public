import { type Kysely, sql } from 'kysely';

/**
 * `execution_runs.environment_id`, so environment run-history keys off the matched
 * environment's id.
 *
 * For a glob environment, the `environment` name column holds the concrete instance (e.g.
 * `review/PR-123`), which never equals the environment row's label, so a name-keyed query
 * misses. That column stays: it is also the concurrency-group key and the instance label.
 *
 * `ON DELETE SET NULL`: deleting an environment must not delete its run rows.
 *
 * Backfill: `execution_runs` has no `org_id`, so a name match is safe only when exactly one
 * fixed environment carries that name table-wide; that never mis-attributes across tenants.
 * Glob-named rows stay NULL (they were never in history, so nothing regresses).
 *
 * Idempotent: column-exists guarded, `IF NOT EXISTS` index, `WHERE environment_id IS NULL`.
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
  if (!(await colExists(db, 'execution_runs', 'environment_id'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN environment_id uuid
        REFERENCES public.environments(id) ON DELETE SET NULL
    `.execute(db);
  }

  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runs_environment_id
      ON public.execution_runs (environment_id)
  `.execute(db);

  // Backfill unambiguous fixed-environment rows (see the doc comment above).
  await sql`
    UPDATE public.execution_runs er
       SET environment_id = e.id
      FROM public.environments e
     WHERE er.environment_id IS NULL
       AND er.environment IS NOT NULL
       AND e.type = 'fixed'
       AND e.name = er.environment
       AND (SELECT count(*) FROM public.environments e2
             WHERE e2.type = 'fixed' AND e2.name = er.environment) = 1
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_execution_runs_environment_id`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS environment_id`.execute(db);
}
