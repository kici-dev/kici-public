import { sql, type Kysely } from 'kysely';

/**
 * held_runs.environment_id becomes nullable with ON DELETE SET NULL so
 * terminal held-run history survives environment deletion (a null
 * environment_id means the environment was since deleted). Pending held
 * runs still block deletion — enforced in EnvironmentStore.delete.
 *
 * Idempotent: dropping the NOT NULL and the constraint are both no-ops on a
 * re-run, and the constraint is re-created with the SET NULL action.
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
