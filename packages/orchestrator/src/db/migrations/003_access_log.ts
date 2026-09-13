import { type Kysely, sql } from 'kysely';

/**
 * Access log: one row per read or orchestrator-admin mutation attributable
 * to an ActorPrincipal (dashboard user, api_key, service_account, platform
 * operator break-glass, or system). Backs:
 *
 * - dashboard "Data access" tab (dashboard.access-log.list message)
 * - orchestrator admin HTTP route GET /api/v1/admin/access-log
 * - kici-admin `access-log` CLI subcommand
 *
 * Covers reads + orchestrator-admin mutations uniformly. `secret_audit_log`
 * stays the source of truth for secret *mutation* events (kept separate for
 * historical reasons and different retention expectations); access_log
 * records secret *reveals* with full actor attribution.
 *
 * `source` distinguishes platform_proxy vs admin_http vs admin_cli entry
 * points. `actor_meta` captures the variant-specific extras that don't fit
 * in the flat (actor_type, actor_id) columns — ownerSub for api_key,
 * reason for platform_operator.
 *
 * Retention is TTL-based via expires_at; packages/orchestrator/src/queue/
 * cleanup.ts picks up the prune pass.
 */

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE public.access_log (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id        VARCHAR(12),
      routing_key   TEXT,
      actor_type    TEXT NOT NULL,
      actor_id      TEXT NOT NULL,
      actor_meta    JSONB,
      action        TEXT NOT NULL,
      target_type   TEXT,
      target_id     TEXT,
      request_id    UUID,
      source        TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      error_message TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ NOT NULL
    )
  `.execute(db);

  // Primary query: org-scoped time-descending list (dashboard tab, admin HTTP list).
  await sql`
    CREATE INDEX access_log_org_created_idx
      ON public.access_log (org_id, created_at DESC)
  `.execute(db);

  // Per-target forensic queries ("everything anyone did to this run").
  await sql`
    CREATE INDEX access_log_target_idx
      ON public.access_log (target_type, target_id)
      WHERE target_type IS NOT NULL AND target_id IS NOT NULL
  `.execute(db);

  // TTL sweep.
  await sql`
    CREATE INDEX access_log_expires_idx
      ON public.access_log (expires_at)
  `.execute(db);

  // Actor-scoped queries ("everything this user read").
  await sql`
    CREATE INDEX access_log_actor_idx
      ON public.access_log (actor_type, actor_id, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.access_log`.execute(db);
}
