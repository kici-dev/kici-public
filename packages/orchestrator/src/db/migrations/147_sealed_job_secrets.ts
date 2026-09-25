import { type Kysely, sql } from 'kysely';

/**
 * Hold the secret fields of a stored job encrypted under the orchestrator
 * master key, beside the plain JSON column that keeps every other field.
 *
 * Adds a nullable `sealed_secrets text` column to the three tables a job waits
 * in: `dispatch_queue` (its `job_config`), `pending_job_contexts` (its
 * `job_input`), and `pending_workflow_contexts` (its `context`).
 *
 * Nullable and unbackfilled: NULL on every row written before this column
 * existed, and on every row an orchestrator without a master key writes. Such
 * a row keeps its secret fields in the plain column and reads back unchanged.
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
