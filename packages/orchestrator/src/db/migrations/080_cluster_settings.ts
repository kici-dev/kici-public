import { type Kysely, sql } from 'kysely';

/**
 * Create `cluster_settings`: a single-row (id='default') table of fleet-wide operator tunables;
 * a NULL knob uses the config.ts default. These knobs have no per-tenant meaning
 * (process-global singletons, pre-org-resolution ingest, per-agent-instance, leader-only
 * sweepers), so they get their own table rather than a magic org_settings customer_id row.
 *
 * Read via ClusterSettingsReader (whole-row, short-TTL cache); written via
 * `/api/v1/admin/cluster-settings` and `kici-admin cluster-settings`. Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.cluster_settings (
      id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
      max_github_payload_bytes           bigint,
      event_log_max_payload_bytes        bigint,
      lock_file_max_bytes                bigint,
      webhook_dedup_ttl_ms               bigint,
      contributor_cache_ttl_ms           bigint,
      event_router_event_ttl_seconds     integer,
      event_router_max_dispatch_attempts integer,
      queue_max_depth                    integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.cluster_settings`.execute(db);
}
