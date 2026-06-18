import type { Kysely } from 'kysely';

import type { Database } from '../db/types.js';
import type { ScalerEvent } from './types.js';

/**
 * Snapshot of a spawning-agent record. Mirrors the row shape in
 * `scaler_spawning_agents`.
 */
export interface SpawningAgentSnapshot {
  agentId: string;
  scalerName: string;
  labelSet: string[];
  runId?: string;
  jobId?: string;
  boundJobId?: string;
  spawnedAt: Date;
}

/**
 * Snapshot of an agent-job correlation. Mirrors the row shape in
 * `scaler_agent_jobs`.
 */
export interface AgentJobCorrelationSnapshot {
  agentId: string;
  runId: string;
  jobId: string;
}

/**
 * Snapshot of a resource reservation. Mirrors the row shape in
 * `scaler_reservations`.
 */
export interface ReservationSnapshot {
  agentId: string;
  scalerName: string;
  cpus: number;
  memBytes: number;
}

/**
 * DB persistence for `ScalerManager` HA-critical state.
 *
 * Backed by three tables — `scaler_spawning_agents`, `scaler_agent_jobs`,
 * `scaler_reservations` — so a Raft leader switch / coord crash no
 * longer:
 *
 *  - orphans an agent that is mid-spawn (lost `boundJobId` → eager
 *    dispatch silently downgraded to a generic queue drain),
 *  - strands a reservation (resource counted as used until the agent's
 *    backend GC eventually disconnects, minutes later),
 *  - drops the agent → run/job correlation (execution-tracker loses
 *    scaler-lifecycle events emitted by the new coord).
 *
 * The consumer keeps the in-memory Maps as L1 caches. On boot /
 * become-leader the caches are hydrated via `recoverState()`.
 *
 * `perScalerUsage` / `globalUsage` are NOT stored — they are derived
 * state recomputed from `SUM(...) FROM scaler_reservations` on
 * recovery, which means the on-disk reservation rows are the single
 * source of truth for the cap-check critical section.
 *
 * The `eventBuffer` Map is also not persisted: events emitted before
 * correlation are observability, not correctness. A coord crash before
 * `correlateAgentToJob()` runs accepts losing those events (see the
 * wishlist for the rationale).
 */
export class ScalerStateStore {
  constructor(private readonly db: Kysely<Database>) {}

  // ── Spawning agents ───────────────────────────────────────────────

  async upsertSpawningAgent(snapshot: SpawningAgentSnapshot): Promise<void> {
    await this.db
      .insertInto('scaler_spawning_agents')
      .values({
        agent_id: snapshot.agentId,
        scaler_name: snapshot.scalerName,
        label_set: JSON.stringify(snapshot.labelSet),
        run_id: snapshot.runId ?? null,
        job_id: snapshot.jobId ?? null,
        bound_job_id: snapshot.boundJobId ?? null,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          scaler_name: snapshot.scalerName,
          label_set: JSON.stringify(snapshot.labelSet),
          run_id: snapshot.runId ?? null,
          job_id: snapshot.jobId ?? null,
          bound_job_id: snapshot.boundJobId ?? null,
        }),
      )
      .execute();
  }

  async deleteSpawningAgent(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_spawning_agents').where('agent_id', '=', agentId).execute();
  }

  async listSpawningAgents(): Promise<SpawningAgentSnapshot[]> {
    const rows = await this.db
      .selectFrom('scaler_spawning_agents')
      .select([
        'agent_id',
        'scaler_name',
        'label_set',
        'run_id',
        'job_id',
        'bound_job_id',
        'spawned_at',
      ])
      .execute();
    return rows.map((row) => {
      const snapshot: SpawningAgentSnapshot = {
        agentId: row.agent_id,
        scalerName: row.scaler_name,
        labelSet: parseLabelSet(row.label_set),
        spawnedAt: row.spawned_at,
      };
      if (row.run_id != null) snapshot.runId = row.run_id;
      if (row.job_id != null) snapshot.jobId = row.job_id;
      if (row.bound_job_id != null) snapshot.boundJobId = row.bound_job_id;
      return snapshot;
    });
  }

  /**
   * Delete every spawning-agent row whose `spawned_at` is older than the
   * given cutoff. Used by the leader-gated GC sweep so a coord that
   * crashed mid-spawn doesn't leave the row blocking the spawn-timeout
   * detection forever. Returns the row count GC'd.
   */
  async sweepStaleSpawningAgents(olderThan: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('scaler_spawning_agents')
      .where('spawned_at', '<', olderThan)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  // ── Agent-job correlation ─────────────────────────────────────────

  async upsertAgentJob(snapshot: AgentJobCorrelationSnapshot): Promise<void> {
    await this.db
      .insertInto('scaler_agent_jobs')
      .values({
        agent_id: snapshot.agentId,
        run_id: snapshot.runId,
        job_id: snapshot.jobId,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          run_id: snapshot.runId,
          job_id: snapshot.jobId,
        }),
      )
      .execute();
  }

  async deleteAgentJob(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_agent_jobs').where('agent_id', '=', agentId).execute();
  }

  async listAgentJobs(): Promise<AgentJobCorrelationSnapshot[]> {
    const rows = await this.db
      .selectFrom('scaler_agent_jobs')
      .select(['agent_id', 'run_id', 'job_id'])
      .execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      runId: row.run_id,
      jobId: row.job_id,
    }));
  }

  // ── Reservations ──────────────────────────────────────────────────

  async upsertReservation(snapshot: ReservationSnapshot): Promise<void> {
    await this.db
      .insertInto('scaler_reservations')
      .values({
        agent_id: snapshot.agentId,
        scaler_name: snapshot.scalerName,
        cpu_units: snapshot.cpus,
        mem_bytes: snapshot.memBytes,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          scaler_name: snapshot.scalerName,
          cpu_units: snapshot.cpus,
          mem_bytes: snapshot.memBytes,
        }),
      )
      .execute();
  }

  async deleteReservation(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_reservations').where('agent_id', '=', agentId).execute();
  }

  async listReservations(): Promise<ReservationSnapshot[]> {
    const rows = await this.db
      .selectFrom('scaler_reservations')
      .select(['agent_id', 'scaler_name', 'cpu_units', 'mem_bytes'])
      .execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      scalerName: row.scaler_name,
      cpus: row.cpu_units,
      memBytes: typeof row.mem_bytes === 'string' ? Number(row.mem_bytes) : row.mem_bytes,
    }));
  }
}

/**
 * Decode the `label_set` column. pg's jsonb columns arrive parsed when
 * the schema-aware driver is in play; defensive string handling keeps
 * mock-DB tests (and any future minimally-typed driver) honest.
 */
function parseLabelSet(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Aggregate event surface for "the scaler manager fully replayed its
 * state from the DB after a leader switch". Kept here (vs in
 * manager.ts) so `ScalerManager.recoverState()` can declare a clean
 * return type. `bufferedEventsLost` always returns 0 today — the
 * `eventBuffer` Map is intentionally not persisted — but the field
 * exists so a future buffer-table addition is type-compatible.
 */
export interface ScalerStateRecovery {
  spawningAgentsRehydrated: number;
  agentJobsRehydrated: number;
  reservationsRehydrated: number;
  bufferedEventsLost: number;
}

/**
 * Re-export for the buffered-events note above; sole reason
 * `ScalerEvent` is imported is to keep that comment compile-checked.
 */
export type { ScalerEvent };
