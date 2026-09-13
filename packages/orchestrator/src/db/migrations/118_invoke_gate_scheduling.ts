import { type Kysely, sql } from 'kysely';

/**
 * Scheduling columns for the invoke gate: the pieces the orchestrator needs to
 * summon, bound, and time-out a gate without ever handing it to an agent.
 *
 * - `execution_jobs.timeout_ms` — the gate's own wall-clock timeout (ms), copied
 *   from the lock job. A gate runs no steps on an agent, so the agent-side job
 *   timeout can never fire for it; the orchestrator sweeps this column and fails
 *   a gate whose proxies have not all terminalized in time.
 * - `execution_runs.chain_depth` — how deep this run sits in an invoke chain. A
 *   webhook-triggered run is depth 0; a run summoned by a gate carries its
 *   summoner's depth + 1. Read back when the run fires its own invoke gate so the
 *   chain-depth circuit breaker actually bounds recursion. NOT NULL default 0, so
 *   every pre-existing row reads as a non-summoned root.
 * - `pending_job_contexts.invoke_config` — the gate's invoke parameters (event,
 *   payload, optional, maxParallel, failFast) serialized as JSON, so a gate that
 *   is released later (or after a crash-recovery restore) still summons instead
 *   of being dispatched to an agent.
 *
 * All three are additive. Idempotent: guarded on each column's existence.
 */
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

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_jobs', 'timeout_ms'))) {
    await sql`
      ALTER TABLE public.execution_jobs
        ADD COLUMN timeout_ms integer
    `.execute(db);
  }
  if (!(await colExists(db, 'execution_runs', 'chain_depth'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN chain_depth integer NOT NULL DEFAULT 0
    `.execute(db);
  }
  if (!(await colExists(db, 'pending_job_contexts', 'invoke_config'))) {
    await sql`
      ALTER TABLE public.pending_job_contexts
        ADD COLUMN invoke_config text
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS timeout_ms`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS chain_depth`.execute(db);
  await sql`ALTER TABLE public.pending_job_contexts DROP COLUMN IF EXISTS invoke_config`.execute(
    db,
  );
}
