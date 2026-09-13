import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.dashboard_verified_issuer` (nullable text).
 *
 * The verified-tier origin the dashboard fetches the orchestrator's X25519
 * dashboard-encryption public key from — and always displays next to a secret /
 * variable entry field — under the `encrypted` dashboard-write posture. Fetching
 * the key straight from the customer's own origin makes TLS to that domain the
 * trust root, so an active hosted-control-plane MITM of the key cannot happen.
 *
 * Cluster-global (one orchestrator identity, one `.well-known`), not per-tenant,
 * so it lives on `cluster_settings` rather than `org_settings`. The tier is
 * explicit opt-in with no environment fallback: NULL ⇒ the verified tier is not
 * offered and the convenient tier is used.
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has the
 * column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'dashboard_verified_issuer'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN dashboard_verified_issuer TEXT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS dashboard_verified_issuer`.execute(
    db,
  );
}
