import { sql, type Kysely } from 'kysely';

/**
 * held_runs.environment_id becomes nullable with ON DELETE SET NULL, so
 * terminal held-run history survives environment deletion (null = deleted
 * since). Pending held runs still block deletion, in EnvironmentStore.delete.
 *
 * Idempotent: both drops are no-ops on a re-run, and the constraint is
 * re-created with the SET NULL action.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs ALTER COLUMN environment_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE public.held_runs DROP CONSTRAINT IF EXISTS held_runs_environment_id_fkey`.execute(
    db,
  );
  await sql`ALTER TABLE public.held_runs
    ADD CONSTRAINT held_runs_environment_id_fkey
    FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs DROP CONSTRAINT IF EXISTS held_runs_environment_id_fkey`.execute(
    db,
  );
  await sql`ALTER TABLE public.held_runs
    ADD CONSTRAINT held_runs_environment_id_fkey
    FOREIGN KEY (environment_id) REFERENCES public.environments(id)`.execute(db);
  await sql`ALTER TABLE public.held_runs ALTER COLUMN environment_id SET NOT NULL`.execute(db);
}
