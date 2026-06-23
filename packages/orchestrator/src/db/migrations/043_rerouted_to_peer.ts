import { type Kysely, sql } from 'kysely';

/**
 * Add a nullable `rerouted_to_peer text` marker to execution_jobs. Non-null
 * means the job was rerouted to a remote worker peer (the value is that
 * peer's instance id); NULL means the job runs locally. The run-recovery
 * sweepers read it so a rerouted job whose worker is still connected is not
 * prematurely failed.
 *
 * Idempotent: re-running on a DB that already has the column is a no-op.
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
  if (!(await colExists(db, 'execution_jobs', 'rerouted_to_peer'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN rerouted_to_peer text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS rerouted_to_peer`.execute(db);
}
