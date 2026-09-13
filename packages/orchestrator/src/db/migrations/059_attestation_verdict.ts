import { type Kysely, sql } from 'kysely';

/**
 * Add server-side verification verdict columns to `attestations`, plus the
 * lookup indexes the org-wide attestations browser queries against.
 *
 * The orchestrator verifies each provenance bundle at ingest and records the
 * verdict here so the dashboard list shows trustworthy badges with no per-row
 * bundle fetch:
 * - `verify_status` — one of `verified` / `failed` / `unverifiable` / `pending`
 *   (mirrors `attestationVerifyStatusSchema.enum.*` in `@kici-dev/engine`).
 *   `DEFAULT 'pending'` covers rows written before a verdict is computed.
 * - `verify_reason` — first failure code from `verifyKiciBundle` (nullable).
 * - `verified_at` — when the verdict was recorded (nullable).
 *
 * Idempotent: guarded on the `verify_status` column's existence.
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
  if (await colExists(db, 'attestations', 'verify_status')) return;

  // DEFAULT 'pending' mirrors attestationVerifyStatusSchema.enum.pending.
  await sql`
    ALTER TABLE public.attestations
      ADD COLUMN verify_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN verify_reason TEXT,
      ADD COLUMN verified_at TIMESTAMPTZ
  `.execute(db);

  await sql`CREATE INDEX idx_attestations_subject_digest ON public.attestations (subject_digest)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_attestations_subject_name ON public.attestations (subject_name)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_attestations_verify_status ON public.attestations (verify_status)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_attestations_created_at ON public.attestations (created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_attestations_created_at`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_attestations_verify_status`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_attestations_subject_name`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_attestations_subject_digest`.execute(db);
  await sql`
    ALTER TABLE public.attestations
      DROP COLUMN IF EXISTS verify_status,
      DROP COLUMN IF EXISTS verify_reason,
      DROP COLUMN IF EXISTS verified_at
  `.execute(db);
}
