import { type Kysely, sql } from 'kysely';

/**
 * Coordinator ownership for the job-dispatch plane.
 *
 * `dispatch_queue` records which **agent** a row went to but not which **coordinator** watches
 * it, so every cluster-wide sweep acted on rows a live sibling owns.
 *
 * - `dispatch_queue.owner_instance_id` — the dispatching coordinator. NULL reads as "unknown
 *   owner", never "not mine" (the scaler-plane convention from migration 119).
 * - `dispatch_queue.dispatched_at` — when the row was handed to an agent (`created_at` is
 *   enqueue time); read by the stale detector's "dispatch never acknowledged" heuristic. NULL
 *   falls back to `created_at`, so older rows keep their behaviour.
 * - `cluster_instances` — the coordinator heartbeat, as `host_roster` is for agents. Liveness
 *   comes from the DB because the peer registry is empty when startup recovery runs; it needs
 *   no peer connectivity, so it works in non-Raft multi-coordinator and standalone deployments.
 * - `execution_runs.cancelling_at` — when the run entered `cancelling`. A cancel dropped in
 *   transit leaves jobs executing; the re-drive sweep needs to know for how long.
 * - A partial unique index on `concurrency_groups (routing_key, group_key, run_id) WHERE
 *   status = 'active'`, making a re-acquire idempotent now that the DB arbitrates slots.
 *
 * The new columns are nullable and backfill as NULL, so an in-flight queue survives the
 * upgrade. Idempotent: guarded on each object's existence.
 */
async function tableExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

const DISPATCH_QUEUE_COLUMNS: Array<[string, string]> = [
  ['owner_instance_id', 'TEXT'],
  ['dispatched_at', 'TIMESTAMPTZ'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [name, type] of DISPATCH_QUEUE_COLUMNS) {
    if (!(await colExists(db, 'dispatch_queue', name))) {
      await sql`
        ALTER TABLE public.dispatch_queue
          ADD COLUMN ${sql.raw(name)} ${sql.raw(type)}
      `.execute(db);
    }
  }

  // Partial on `dispatched`: startup recovery scans those by owner, and terminal rows (the
  // bulk) are never read by an ownership predicate.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_owner_dispatched
      ON public.dispatch_queue (owner_instance_id)
     WHERE status = 'dispatched'
  `.execute(db);
  // The stale detector bounds its sub-scan on the dispatch clock.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_dispatched_at
      ON public.dispatch_queue (dispatched_at)
     WHERE status = 'dispatched'
  `.execute(db);

  if (!(await colExists(db, 'execution_runs', 'cancelling_at'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN cancelling_at TIMESTAMPTZ
    `.execute(db);
  }
  // The re-drive sweep scans oldest-first for runs stuck in `cancelling`.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runs_cancelling_at
      ON public.execution_runs (cancelling_at)
     WHERE status = 'cancelling'
  `.execute(db);

  if (!(await tableExists(db, 'cluster_instances'))) {
    await sql`
      CREATE TABLE public.cluster_instances (
        instance_id       TEXT PRIMARY KEY,
        role              TEXT,
        version           TEXT,
        started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    // The liveness predicate is "heartbeat fresher than now() - grace".
    await sql`
      CREATE INDEX idx_cluster_instances_last_heartbeat_at
        ON public.cluster_instances (last_heartbeat_at)
    `.execute(db);
  }

  // Collapse duplicates first, or the unique index build fails the migration and startup.
  // Duplicates are normal on an upgraded database: a slot was recorded per `concurrency.report`,
  // which arrives per JOB, so a run with several jobs in one group left several `active` rows.
  // The oldest is the held slot; the rest record the same acquisition and become `completed`,
  // not deleted.
  await sql`
    UPDATE public.concurrency_groups cg
       SET status = 'completed',
           completed_at = COALESCE(cg.completed_at, NOW())
     WHERE cg.status = 'active'
       AND cg.id <> (
         SELECT keep.id
           FROM public.concurrency_groups keep
          WHERE keep.status = 'active'
            AND keep.routing_key = cg.routing_key
            AND keep.group_key = cg.group_key
            AND keep.run_id = cg.run_id
          ORDER BY keep.created_at ASC, keep.id ASC
          LIMIT 1
       )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_concurrency_groups_active_unique
      ON public.concurrency_groups (routing_key, group_key, run_id)
     WHERE status = 'active'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_concurrency_groups_active_unique`.execute(db);
  await sql`DROP TABLE IF EXISTS public.cluster_instances`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS cancelling_at`.execute(db);
  // Dropping a column drops the indexes that reference it.
  for (const [name] of DISPATCH_QUEUE_COLUMNS) {
    await sql`
      ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS ${sql.raw(name)}
    `.execute(db);
  }
}
