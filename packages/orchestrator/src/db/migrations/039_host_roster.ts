import { type Kysely, sql } from 'kysely';

/**
 * `host_roster` is KiCI's declared inventory: one durable row per agent the
 * cluster has ever enrolled, reconciled from the in-memory AgentRegistry on
 * every register/unregister. `lifecycle_class` (snapshot of the auth token's
 * agent_type) drives reaping — `ephemeral` rows are GC'd past their TTL,
 * `static` rows persist and read as `unreachable` when their heartbeat goes
 * stale. `connected_instance_id` records which orchestrator holds the live WS
 * (cluster liveness + the host-fanout reroute target); NULL = disconnected.
 *
 * The roster lives in the shared cluster DB (one table, all instances). Status
 * is derived at read from the shared `last_seen` + `connected_instance_id`, so
 * every instance agrees regardless of which one holds the agent's live WS.
 *
 * Idempotent: a re-run on a DB that already has the table is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'host_roster'
    ) AS exists
  `.execute(db);
  if (exists.rows[0]?.exists) return;

  await sql`
    CREATE TABLE public.host_roster (
      id                    uuid DEFAULT gen_random_uuid() NOT NULL,
      agent_id              text NOT NULL,
      token_id              uuid,
      lifecycle_class       text NOT NULL,
      labels                text NOT NULL DEFAULT '[]',
      hostname              text,
      platform              text,
      arch                  text,
      connected_instance_id text,
      last_seen             timestamptz NOT NULL DEFAULT now(),
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT host_roster_pkey PRIMARY KEY (id),
      CONSTRAINT host_roster_agent_id_key UNIQUE (agent_id),
      CONSTRAINT host_roster_lifecycle_class_check
        CHECK (lifecycle_class = ANY (ARRAY['static'::text, 'ephemeral'::text]))
    )
  `.execute(db);

  await sql`CREATE INDEX idx_host_roster_reap
              ON public.host_roster (lifecycle_class, last_seen)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.host_roster`.execute(db);
}
