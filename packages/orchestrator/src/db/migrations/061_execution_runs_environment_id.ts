import { type Kysely, sql } from 'kysely';

/**
 * Add `environment_id` to `execution_runs` so environment run-history can be
 * queried by the matched environment's id.
 *
 * The `environment` column stores the job-declared environment name. For a
 * glob environment that is the concrete instance string (e.g. `review/PR-123`),
 * which never equals the environment row's label, so a name-keyed history query
 * always misses. Recording the matched environment id lets the History tab key
 * off a stable id instead. The `environment` name column is untouched (it
 * doubles as the concurrency-group key and the concrete-instance label).
 *
 * `ON DELETE SET NULL`: deleting an environment must not delete its run rows.
 *
 * Backfill: `execution_runs` has no `org_id`, so a name match is only safe when
 * exactly one fixed environment carries that name across the whole table. That
 * backfills 100% of fixed-env history on a single-tenant orchestrator and the
 * unambiguous majority on a shared one, never mis-attributing across tenants.
 * Glob-named rows stay null (they never appeared in history before — that is
 * the bug being fixed — so nothing regresses).
 *
 * Idempotent: guarded on the `environment_id` column's existence; the index and
 * backfill use `IF NOT EXISTS` / `WHERE environment_id IS NULL` so re-running is
 * a no-op.
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
