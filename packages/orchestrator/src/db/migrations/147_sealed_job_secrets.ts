import { type Kysely, sql } from 'kysely';

/**
 * `sealed_secrets` holds a stored job's secret fields under the orchestrator master key, beside
 * the plain JSON column (`dispatch_queue.job_config`, `pending_job_contexts.job_input`,
 * `pending_workflow_contexts.context`) that keeps every other field.
 *
 * Nullable and unbackfilled: NULL on older rows and on rows an orchestrator without a master
 * key writes; such a row keeps its secrets in the plain column and reads back unchanged.
 *
 * Idempotent: each column is added only when missing.
 */
export const SEALED_SECRETS_TABLES = [
  'dispatch_queue',
  'pending_job_contexts',
  'pending_workflow_contexts',
] as const;

async function colExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = 'sealed_secrets'
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of SEALED_SECRETS_TABLES) {
    if (!(await colExists(db, table))) {
      await sql`ALTER TABLE ${sql.table(`public.${table}`)} ADD COLUMN sealed_secrets text`.execute(
        db,
      );
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of SEALED_SECRETS_TABLES) {
    await sql`ALTER TABLE ${sql.table(`public.${table}`)} DROP COLUMN IF EXISTS sealed_secrets`.execute(
      db,
    );
  }
}
