import { type Kysely, sql } from 'kysely';

/**
 * Org-scope `org_settings` and qualify each glob entry by source.
 *
 * `org_settings` was keyed by `routing_key`, meaning each webhook
 * source had its own independent global-workflow configuration. With multi-
 * source orgs, the dashboard's per-org settings page only ever showed the
 * first source it found and silently hid the rest.
 *
 * This migration:
 *
 *   1. Adds a `customer_id text` column.
 *   2. Backfills `customer_id` from `sources` / `generic_webhook_sources` by
 *      `routing_key`. Rows whose `routing_key` cannot be resolved (orphans
 *      from deleted sources) are dropped — they were already unreachable.
 *   3. Converts the three repo-list `text[]` columns to `jsonb` arrays of
 *      `{routingKey?: string, pattern: string}` entries. Each existing entry
 *      is qualified with its original `routing_key` so semantics are preserved
 *      verbatim — a glob that previously only saw events on `github:42` still
 *      only sees events on `github:42`.
 *   4. Merges rows by `customer_id`. `global_workflows_enabled` collapses with
 *      logical OR; the three list columns concatenate.
 *   5. Drops the old `routing_key` column and PK; new PK is `customer_id`.
 *
 * Idempotent: a re-run on an already-migrated DB sees `customer_id` exists
 * and the list columns are already jsonb, so it is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Quick idempotency check: if customer_id already exists, the migration
  // already ran. Skip the rewrite entirely.
  const colCheck = await sql<{ customer_id_exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'customer_id'
    ) AS customer_id_exists
  `.execute(db);
  if (colCheck.rows[0]?.customer_id_exists) return;

  // 1. Stage a side table that holds (routing_key, customer_id, ...legacy lists).
  //    Backfill customer_id from sources / generic_webhook_sources.
  await sql`
    CREATE TEMP TABLE _org_settings_stage AS
    SELECT os.routing_key,
           COALESCE(s.customer_id, gws.customer_id) AS customer_id,
           os.global_workflows_enabled,
           os.global_workflow_allowed_repos,
           os.global_workflow_denied_repos,
           os.global_workflow_elevated_repos,
           os.created_at,
           os.updated_at
      FROM public.org_settings os
      LEFT JOIN public.sources s
             ON s.routing_key = os.routing_key
      LEFT JOIN public.generic_webhook_sources gws
             ON gws.routing_key = os.routing_key
            AND gws.deleted_at IS NULL
  `.execute(db);

  // 2. Surface orphans (no resolvable customer_id). They were silently
  //    unreachable already; log them for the operator and drop them.
  const orphans = await sql<{ routing_key: string }>`
    SELECT routing_key FROM _org_settings_stage WHERE customer_id IS NULL
  `.execute(db);
  if (orphans.rows.length > 0) {
    // Plain RAISE NOTICE so the deploy log captures the dropped routing keys.
    const list = orphans.rows.map((r) => r.routing_key).join(', ');
    await sql`
      DO $$ BEGIN
        RAISE NOTICE 'org_settings: dropping % orphan rows (routing keys with no source): %',
          ${orphans.rows.length}::int,
          ${list}::text;
      END $$
    `.execute(db);
  }
  await sql`DELETE FROM _org_settings_stage WHERE customer_id IS NULL`.execute(db);

  // 3. Build the merged-by-customer rows in a second temp table. For each
  //    customer_id we OR the enabled flag and concat the qualified lists.
  await sql`
    CREATE TEMP TABLE _org_settings_merged AS
    SELECT customer_id,
           bool_or(global_workflows_enabled) AS global_workflows_enabled,
           NULLIF(
             jsonb_agg(entry) FILTER (WHERE entry IS NOT NULL),
             '[]'::jsonb
           ) AS global_workflow_allowed_repos,
           NULLIF(
             jsonb_agg(entry_d) FILTER (WHERE entry_d IS NOT NULL),
             '[]'::jsonb
           ) AS global_workflow_denied_repos,
           NULLIF(
             jsonb_agg(entry_e) FILTER (WHERE entry_e IS NOT NULL),
             '[]'::jsonb
           ) AS global_workflow_elevated_repos,
           min(created_at) AS created_at,
           max(updated_at) AS updated_at
      FROM (
        SELECT s.customer_id,
               s.global_workflows_enabled,
               s.created_at,
               s.updated_at,
               jsonb_build_object('routingKey', s.routing_key, 'pattern', a) AS entry,
               NULL::jsonb AS entry_d,
               NULL::jsonb AS entry_e
          FROM _org_settings_stage s
          LEFT JOIN LATERAL unnest(s.global_workflow_allowed_repos) AS a ON true
        UNION ALL
        SELECT s.customer_id,
               s.global_workflows_enabled,
               s.created_at,
               s.updated_at,
               NULL::jsonb,
               jsonb_build_object('routingKey', s.routing_key, 'pattern', d),
               NULL::jsonb
          FROM _org_settings_stage s
          LEFT JOIN LATERAL unnest(s.global_workflow_denied_repos) AS d ON true
        UNION ALL
        SELECT s.customer_id,
               s.global_workflows_enabled,
               s.created_at,
               s.updated_at,
               NULL::jsonb,
               NULL::jsonb,
               jsonb_build_object('routingKey', s.routing_key, 'pattern', e)
          FROM _org_settings_stage s
          LEFT JOIN LATERAL unnest(s.global_workflow_elevated_repos) AS e ON true
      ) flat
     GROUP BY customer_id
  `.execute(db);

  // 4. Replace the live table. The cleanest path on Postgres is DROP +
  //    CREATE — the table is small and the migration is single-shot.
  await sql`DROP TABLE public.org_settings`.execute(db);
  await sql`
    CREATE TABLE public.org_settings (
      customer_id text PRIMARY KEY,
      global_workflows_enabled boolean DEFAULT false NOT NULL,
      global_workflow_allowed_repos jsonb,
      global_workflow_denied_repos jsonb,
      global_workflow_elevated_repos jsonb,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `.execute(db);

  // 5. Restore the merged rows.
  await sql`
    INSERT INTO public.org_settings (
      customer_id,
      global_workflows_enabled,
      global_workflow_allowed_repos,
      global_workflow_denied_repos,
      global_workflow_elevated_repos,
      created_at,
      updated_at
    )
    SELECT customer_id,
           global_workflows_enabled,
           global_workflow_allowed_repos,
           global_workflow_denied_repos,
           global_workflow_elevated_repos,
           created_at,
           updated_at
      FROM _org_settings_merged
  `.execute(db);

  await sql`DROP TABLE _org_settings_merged`.execute(db);
  await sql`DROP TABLE _org_settings_stage`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Down is best-effort: we cannot reliably split merged rows back into
  // per-routing-key rows without consulting the source list again, and we
  // do not store the original entries' provenance after the merge. The
  // intent here is to leave the schema in a recoverable shape rather than
  // round-trip the data perfectly.
  const colCheck = await sql<{ customer_id_exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'customer_id'
    ) AS customer_id_exists
  `.execute(db);
  if (!colCheck.rows[0]?.customer_id_exists) return;

  await sql`DROP TABLE public.org_settings`.execute(db);
  await sql`
    CREATE TABLE public.org_settings (
      routing_key text PRIMARY KEY,
      global_workflows_enabled boolean DEFAULT false NOT NULL,
      global_workflow_allowed_repos text[],
      global_workflow_denied_repos text[],
      global_workflow_elevated_repos text[],
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `.execute(db);
}
