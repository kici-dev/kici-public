import { type Kysely, sql } from 'kysely';

/**
 * Add the `artifacts` table for user-facing build artifacts and the per-org
 * artifact quota + TTL knobs on `org_settings`.
 *
 * When a workflow step calls `ctx.artifacts.upload(name, paths)`, the agent
 * uploads the packed tarball to object storage under
 * `artifacts/{run_id}/{name}-{discriminator}.tar.gz` (the discriminator is a
 * hash of the exact name) and the orchestrator records one row here
 * so a later job (`ctx.artifacts.download`) and the dashboard can resolve it.
 * `UNIQUE (run_id, name)` is the immutability constraint — the first upload of a
 * name within a run wins; a duplicate name fails at the DB layer as a backstop
 * to the handler's pre-mint duplicate check.
 *
 * Idempotent: a re-run on a DB that already has the table / columns is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'artifacts'
    ) AS exists
  `.execute(db);
  if (!tableCheck.rows[0]?.exists) {
    await sql`
      CREATE TABLE public.artifacts (
        id           TEXT PRIMARY KEY,
        customer_id  TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        job_id       TEXT NOT NULL,
        name         TEXT NOT NULL,
        size_bytes   BIGINT NOT NULL,
        sha256       TEXT NOT NULL,
        storage_key  TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (run_id, name)
      )
    `.execute(db);
    await sql`
      CREATE INDEX idx_artifacts_run ON public.artifacts (run_id)
    `.execute(db);
    await sql`
      CREATE INDEX idx_artifacts_customer_created
        ON public.artifacts (customer_id, created_at)
    `.execute(db);
  }

  // Per-org artifact quota + TTL overrides on org_settings (BIGINT, nullable —
  // NULL means "use the cluster-wide default"). Idempotent via IF NOT EXISTS.
  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN IF NOT EXISTS artifact_quota_bytes BIGINT,
      ADD COLUMN IF NOT EXISTS artifact_ttl_ms BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.artifacts`.execute(db);
  await sql`
    ALTER TABLE public.org_settings
      DROP COLUMN IF EXISTS artifact_quota_bytes,
      DROP COLUMN IF EXISTS artifact_ttl_ms
  `.execute(db);
}
