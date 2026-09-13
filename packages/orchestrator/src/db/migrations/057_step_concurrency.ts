import { type Kysely, sql } from 'kysely';

/**
 * Add parallel step-group concurrency columns to `execution_steps`:
 *
 * - `concurrency_kind text` — the step's concurrency role (`sequential` |
 *   `parallel-child` | `parallel-group`). NULL for an ordinary sequential step.
 * - `group_id text` — the parallel-group correlation id shared by a group's
 *   children (e.g. `g0`). NULL for a sequential step.
 *
 * Both nullable, no backfill. Idempotent: re-running on a DB that already has the
 * columns is a no-op.
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
  if (!(await colExists(db, 'execution_steps', 'concurrency_kind'))) {
    await sql`ALTER TABLE public.execution_steps ADD COLUMN concurrency_kind text`.execute(db);
  }
  if (!(await colExists(db, 'execution_steps', 'group_id'))) {
    await sql`ALTER TABLE public.execution_steps ADD COLUMN group_id text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_steps DROP COLUMN IF EXISTS group_id`.execute(db);
  await sql`ALTER TABLE public.execution_steps DROP COLUMN IF EXISTS concurrency_kind`.execute(db);
}
