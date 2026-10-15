import { type Kysely, sql } from 'kysely';

/**
 * `remote_sources` anchors a Platform-relayed `kici run remote` to its real org: one row per
 * served org maps `remote:<orgId>` to the canonical org id, so `resolveOrgId` takes the
 * webhook's local-source path with no GitHub App, webhook secret or manual setup.
 * Auto-provisioned on Platform auth from the org id on `auth.success`.
 *
 * Idempotent: an existing table is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'remote_sources'
    ) AS exists
  `.execute(db);
  if (exists.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.remote_sources (
      customer_id  VARCHAR(255) NOT NULL,
      routing_key  VARCHAR(255) NOT NULL,
      cluster_id   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT remote_sources_customer_id_key UNIQUE (customer_id),
      CONSTRAINT remote_sources_routing_key_key UNIQUE (routing_key)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.remote_sources`.execute(db);
}
