import { type Kysely, sql } from 'kysely';

/**
 * Rename the named-policy object from "environment" to "context" across the
 * orchestrator schema. Data-preserving rename-in-place (never drop/recreate):
 *
 * Tables:
 *  - `environments`               → `contexts`
 *  - `environment_bindings`       → `context_bindings`
 *  - `environment_variables`      → `context_variables`
 *  - `environment_source_overrides` → `context_source_overrides`
 *
 * Columns:
 *  - `context_bindings.environment_id`         → `context_id`
 *  - `context_variables.environment_id`        → `context_id`
 *  - `context_source_overrides.environment_id` → `context_id`
 *  - `held_runs.environment_id`                → `context_id`
 *  - `execution_runs.environment`              → `context`
 *  - `execution_runs.environment_id`           → `context_id`
 *  - `execution_jobs.environments`             → `contexts`
 *  - `execution_jobs.skipped_environments`     → `skipped_contexts`
 *
 * Index:
 *  - `idx_execution_runs_environment_id` → `idx_execution_runs_context_id`
 *
 * Held-run enum values + defaults: `held_runs.queue_type` /
 * `held_runs.trigger_source` default `'environment'` → `'context'` and existing
 * `'environment'` rows are migrated to `'context'` (the `HeldRunQueueType` value
 * rename).
 *
 * Foreign keys and remaining constraints/indexes follow the renamed tables and
 * columns automatically (Postgres references them by identity, not name), so
 * only the one hand-named index above needs an explicit rename.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.environments RENAME TO contexts`.execute(db);
  await sql`ALTER TABLE public.environment_bindings RENAME TO context_bindings`.execute(db);
  await sql`ALTER TABLE public.environment_variables RENAME TO context_variables`.execute(db);
  await sql`ALTER TABLE public.environment_source_overrides RENAME TO context_source_overrides`.execute(
    db,
  );

  await sql`ALTER TABLE public.context_bindings RENAME COLUMN environment_id TO context_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.context_variables RENAME COLUMN environment_id TO context_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.context_source_overrides RENAME COLUMN environment_id TO context_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.held_runs RENAME COLUMN environment_id TO context_id`.execute(db);
  await sql`ALTER TABLE public.execution_runs RENAME COLUMN environment TO context`.execute(db);
  await sql`ALTER TABLE public.execution_runs RENAME COLUMN environment_id TO context_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_jobs RENAME COLUMN environments TO contexts`.execute(db);
  await sql`ALTER TABLE public.execution_jobs RENAME COLUMN skipped_environments TO skipped_contexts`.execute(
    db,
  );

  await sql`ALTER INDEX IF EXISTS idx_execution_runs_environment_id RENAME TO idx_execution_runs_context_id`.execute(
    db,
  );

  await sql`UPDATE public.held_runs SET queue_type = 'context' WHERE queue_type = 'environment'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET trigger_source = 'context' WHERE trigger_source = 'environment'`.execute(
    db,
  );
  await sql`ALTER TABLE public.held_runs ALTER COLUMN queue_type SET DEFAULT 'context'`.execute(db);
  await sql`ALTER TABLE public.held_runs ALTER COLUMN trigger_source SET DEFAULT 'context'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs ALTER COLUMN trigger_source SET DEFAULT 'environment'`.execute(
    db,
  );
  await sql`ALTER TABLE public.held_runs ALTER COLUMN queue_type SET DEFAULT 'environment'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET trigger_source = 'environment' WHERE trigger_source = 'context'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET queue_type = 'environment' WHERE queue_type = 'context'`.execute(
    db,
  );

  await sql`ALTER INDEX IF EXISTS idx_execution_runs_context_id RENAME TO idx_execution_runs_environment_id`.execute(
    db,
  );

  await sql`ALTER TABLE public.execution_jobs RENAME COLUMN skipped_contexts TO skipped_environments`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_jobs RENAME COLUMN contexts TO environments`.execute(db);
  await sql`ALTER TABLE public.execution_runs RENAME COLUMN context_id TO environment_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.execution_runs RENAME COLUMN context TO environment`.execute(db);
  await sql`ALTER TABLE public.held_runs RENAME COLUMN context_id TO environment_id`.execute(db);
  await sql`ALTER TABLE public.context_source_overrides RENAME COLUMN context_id TO environment_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.context_variables RENAME COLUMN context_id TO environment_id`.execute(
    db,
  );
  await sql`ALTER TABLE public.context_bindings RENAME COLUMN context_id TO environment_id`.execute(
    db,
  );

  await sql`ALTER TABLE public.context_source_overrides RENAME TO environment_source_overrides`.execute(
    db,
  );
  await sql`ALTER TABLE public.context_variables RENAME TO environment_variables`.execute(db);
  await sql`ALTER TABLE public.context_bindings RENAME TO environment_bindings`.execute(db);
  await sql`ALTER TABLE public.contexts RENAME TO environments`.execute(db);
}
