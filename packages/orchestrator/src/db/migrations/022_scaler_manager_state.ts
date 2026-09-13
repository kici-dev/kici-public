import { type Kysely, sql } from 'kysely';

/**
 * Add three tables persisting `ScalerManager` per-coord state:
 *
 *  - `scaler_spawning_agents`: agents spawned via Docker/Podman/Firecracker
 *    that have not yet registered via WS. Carries the `bound_job_id` so a
 *    replacement coord still issues the eager-dispatch hop on register.
 *
 *  - `scaler_agent_jobs`: agentId → (runId, jobId) correlation for
 *    scaler-lifecycle event routing. Inserted on `correlateAgentToJob`,
 *    deleted on disconnect / job completion.
 *
 *  - `scaler_reservations`: outstanding resource reservations keyed by
 *    agentId. Per-scaler / global usage counters are derived state —
 *    recomputed on coord boot as `SUM(...) GROUP BY scaler_name` so the
 *    cap-check critical section stays correct.
 *
 * Without these tables, a coord crash mid-spawn orphans the agent (eager
 * dispatch lost), strands the reservation (resource leak until backend
 * GC eventually disconnects the WS, minutes later), and loses every
 * scaler-lifecycle event emitted before correlation (execution-tracker
 * sees a hole in the run timeline).
 *
 * Idempotent: a re-run on a DB that already has any of these tables
 * leaves the existing one alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tableExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  if (!(await tableExists('scaler_spawning_agents'))) {
    await sql`
      CREATE TABLE public.scaler_spawning_agents (
        agent_id       TEXT PRIMARY KEY,
        scaler_name    TEXT NOT NULL,
        label_set      JSONB NOT NULL,
        run_id         TEXT,
        job_id         TEXT,
        bound_job_id   TEXT,
        spawned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    // Index for stale-row GC sweep (`WHERE spawned_at < now() - interval`).
    await sql`
      CREATE INDEX idx_scaler_spawning_agents_spawned_at
        ON public.scaler_spawning_agents (spawned_at)
    `.execute(db);
  }

  if (!(await tableExists('scaler_agent_jobs'))) {
    await sql`
      CREATE TABLE public.scaler_agent_jobs (
        agent_id        TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        job_id          TEXT NOT NULL,
        correlated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
  }

  if (!(await tableExists('scaler_reservations'))) {
    await sql`
      CREATE TABLE public.scaler_reservations (
        agent_id      TEXT PRIMARY KEY,
        scaler_name   TEXT NOT NULL,
        cpu_units     DOUBLE PRECISION NOT NULL,
        mem_bytes     BIGINT NOT NULL,
        reserved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);
    // Index for per-scaler usage recomputation on coord boot.
    await sql`
      CREATE INDEX idx_scaler_reservations_scaler_name
        ON public.scaler_reservations (scaler_name)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.scaler_reservations`.execute(db);
  await sql`DROP TABLE IF EXISTS public.scaler_agent_jobs`.execute(db);
  await sql`DROP TABLE IF EXISTS public.scaler_spawning_agents`.execute(db);
}
