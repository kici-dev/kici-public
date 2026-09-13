import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.artifact_max_bytes` + `artifact_max_per_run` (both nullable
 * BIGINT).
 *
 * Per-org overrides of the per-artifact size cap and per-run artifact count cap
 * for user-facing artifacts (ctx.artifacts). NULL falls back to the cluster-wide
 * default (`config.artifactMaxBytes` / `config.artifactMaxPerRun`,
 * `KICI_ARTIFACT_MAX_BYTES` / `KICI_ARTIFACT_MAX_PER_RUN`). Operators tune them
 * per tenant via `kici-admin org-settings artifacts set-max-bytes` /
 * `set-max-per-run`.
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has a
 * column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const cols = ['artifact_max_bytes', 'artifact_max_per_run'] as const;
  for (const col of cols) {
    const check = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'org_settings'
           AND column_name = ${col}
      ) AS exists
    `.execute(db);
    if (check.rows[0]?.exists) continue;
    await sql`ALTER TABLE public.org_settings ADD COLUMN ${sql.ref(col)} BIGINT`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS artifact_max_bytes`.execute(db);
  await sql`ALTER TABLE public.org_settings DROP COLUMN IF EXISTS artifact_max_per_run`.execute(db);
}
