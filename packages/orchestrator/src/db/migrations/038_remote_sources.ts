import { type Kysely, sql } from 'kysely';

/**
 * `remote_sources` anchors a Platform-relayed `kici run remote` to its real
 * org. One row per org served by this orchestrator: routing key
 * `remote:<orgId>` maps to the canonical org id, so `resolveOrgId` resolves
 * the real tenant through the same local-source path a webhook takes — no
 * GitHub App, no webhook secret, no manual setup. The row is auto-provisioned
 * on Platform auth from the canonical org id carried on `auth.success`.
 *
 * Idempotent: a re-run on a DB that already has the table is a no-op.
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
