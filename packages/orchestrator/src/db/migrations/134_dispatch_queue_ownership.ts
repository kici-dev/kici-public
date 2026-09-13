import { type Kysely, sql } from 'kysely';

/**
 * Coordinator ownership for the job-dispatch plane.
 *
 * `dispatch_queue` records which **agent** a row went to (`agent_id`,
 * `ack_agent_id`, `recovery_agent_id`, `pinned_agent_id`) but never which
 * **coordinator** is watching it, so every cluster-wide sweep reads the whole
 * shared table and acts on rows a live sibling owns.
 *
 * - `dispatch_queue.owner_instance_id TEXT NULL` — the coordinator that
 *   dispatched the row. A NULL reads as "unknown owner", never as "not mine",
 *   which is the convention migration 119 established for the scaler plane.
 * - `dispatch_queue.dispatched_at TIMESTAMPTZ NULL` — when the row was actually
 *   handed to an agent, as distinct from `created_at`, which is when it was
 *   enqueued. The stale detector's "dispatch never acknowledged" heuristic reads
 *   this; a NULL falls back to `created_at`, so a row written before this column
 *   existed keeps exactly its previous behaviour.
 * - `cluster_instances` — the coordinator heartbeat. Liveness has to come from
 *   the DB rather than the peer registry because the peer registry is empty at
 *   exactly the moment startup recovery runs, and it needs no peer connectivity,
 *   so it works in non-Raft multi-coordinator and standalone deployments alike.
 *   It mirrors what `host_roster` already does for agents.
 * - `execution_runs.cancelling_at TIMESTAMPTZ NULL` — when the run entered
 *   `cancelling`. A cancel can be dropped in transit (a peer blip), leaving the
 *   run cancelling with its jobs still executing; the re-drive sweep needs to
 *   know how long that has been true, and no existing column says.
 * - A partial unique index on `concurrency_groups (routing_key, group_key,
 *   run_id) WHERE status = 'active'` — makes a re-acquire idempotent at the DB
 *   level now that the database, not a process map, arbitrates slots.
 *
 * Both columns are nullable and backfill as NULL, so an in-flight queue survives
 * the upgrade. Idempotent: guarded on each object's existence.
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

  // Startup recovery scans `dispatched` rows by owner, so the index is partial
  // on that status: terminal rows are the bulk of the table and are never read
  // by an ownership predicate.
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
    // The liveness predicate reads "is any row for this instance fresher than
    // now() - grace", so the heartbeat column carries the index.
    await sql`
      CREATE INDEX idx_cluster_instances_last_heartbeat_at
        ON public.cluster_instances (last_heartbeat_at)
    `.execute(db);
  }

  // Collapse pre-existing duplicates before the unique index is built, or the
  // build fails and takes the whole migration — and startup with it — down.
  // Duplicates are the normal state of an upgraded database, not a corruption:
  // the slot was recorded once per `concurrency.report`, and a report arrives
  // per JOB, so any run with two jobs in one group left two `active` rows for
  // the same (routing_key, group_key, run_id). The oldest row is the slot the
  // run actually holds; the rest are records of the same acquisition, so they
  // are marked `completed` rather than deleted.
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
