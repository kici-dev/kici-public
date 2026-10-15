import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.dashboard_verified_issuer` (nullable text).
 *
 * Under the `encrypted` dashboard-write posture, the verified-tier origin the
 * dashboard fetches the orchestrator's X25519 public key from and always shows
 * next to a secret / variable entry field. TLS to the customer's own origin is
 * the trust root, so the hosted control plane cannot MITM the key.
 *
 * Cluster-global (one orchestrator identity, one `.well-known`), so it lives on
 * `cluster_settings`, not `org_settings`. Explicit opt-in with no environment
 * fallback: NULL ⇒ the verified tier is not offered; the convenient tier is used.
 *
 * Idempotent: guarded on column existence.
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
