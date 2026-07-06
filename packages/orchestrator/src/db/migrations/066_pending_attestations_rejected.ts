import { type Kysely, sql } from 'kysely';

/**
 * Add `rejected_at` to `pending_attestations`: the terminal-rejection marker for
 * a deferred attestation the Platform definitively cannot mint (run/job absent).
 * NULL while the row is still pending a later mint; set once, the row is skipped
 * by the retrier and drops out of the pending-attestations gauge. Re-armed via
 * `kici-admin attestations retry --include-rejected`.
 *
 * Idempotent: guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await columnExists(db, 'pending_attestations', 'rejected_at');
  if (exists) return;
  await sql`
    ALTER TABLE public.pending_attestations
      ADD COLUMN rejected_at TIMESTAMPTZ
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await columnExists(db, 'pending_attestations', 'rejected_at');
  if (!exists) return;
  await sql`
    ALTER TABLE public.pending_attestations
      DROP COLUMN rejected_at
  `.execute(db);
}

async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}
