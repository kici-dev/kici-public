import { ScalerBackendType } from '@kici-dev/engine';
import { sql, type Kysely } from 'kysely';

import type { Database, NewScalerPendingClaimRow, ScalerSpawningAgentRow } from '../db/types.js';
import type { ScalerEvent } from './types.js';

/**
 * Snapshot of a spawning-agent record. Mirrors the row shape in
 * `scaler_spawning_agents`.
 *
 * The ownership and self-describing fields are optional: a row written before a
 * coordinator instance id was known carries none of them, and an absent
 * `ownerInstanceId` means "unknown owner", never "owned by someone else".
 */
export interface SpawningAgentSnapshot {
  agentId: string;
  scalerName: string;
  labelSet: string[];
  runId?: string;
  jobId?: string;
  boundJobId?: string;
  spawnedAt: Date;
  /** The coordinator instance that spawned the agent. */
  ownerInstanceId?: string;
  /** The coordinator the agent actually reached when it registered. */
  adoptedBy?: string;
  /** When the adopting coordinator claimed the agent. */
  adoptedAt?: Date;
  /** The scaler's mandatory labels, copied onto the row at spawn time. */
  mandatoryLabels?: string[];
  /** The scaler's provisioning targets, copied onto the row at spawn time. */
  provisioningTargets?: string[];
  /** The scaler's roles, copied onto the row at spawn time. */
  roles?: string[];
  /** The scaler backend that spawned the agent. */
  backendType?: string;
}

/** A pending provisioning claim, as written by the event scaler's claim store. */
export interface PendingClaimRow {
  claimHash: string;
  claimPrefix: string;
  agentId: string;
  scalerName: string;
  labels: string[];
  agentTokenTtlMs: number;
  orchestratorUrl: string;
  expiresAt: Date;
}

/** What a successful `redeemClaim` returns. */
export interface RedeemedClaim {
  agentId: string;
  labels: string[];
  agentTokenTtlMs: number;
  orchestratorUrl: string;
}

/**
 * The critical section `withScalerCapLock` hands its caller: the scaler's
 * cluster-wide spawn count, plus the one write that changes it.
 */
export interface ScalerCapSlot {
  /**
   * Live event-scaler spawn rows for this scaler across every coordinator.
   * Read inside the advisory-locked transaction, so no other holder of the
   * lock can change it while the caller decides.
   */
  clusterActiveCount: number;
  /**
   * Claim a slot by writing the spawn row in the same transaction the count
   * was read in. Counting without claiming here bounds nothing: the spawn row
   * is otherwise written well after the check, so every coordinator arriving
   * in that window reads the same pre-spawn count and admits.
   */
  reserve(snapshot: SpawningAgentSnapshot): Promise<void>;
}

/** A row the event-provision reaper may need to tear down. */
export interface ReapCandidate {
  agentId: string;
  scalerName: string;
  provisioningTargets: string[];
  ownerInstanceId?: string;
  adoptedBy?: string;
  /**
   * When the provision was requested. The reaper ages every row on this and
   * never on `adopted_at`: a coordinator that re-adopts its own agent refreshes
   * `adopted_at`, so a restart loop on the adopter would keep resetting the
   * clock on its own stranded provision and the row would never age out.
   */
  spawnedAt: Date;
  /**
   * The run this provision was spawned for, when it was job-bound. Carried so a
   * teardown for a provision that never registered can be attributed back to the
   * job that is still waiting on it — the reaper is leader-gated, so the
   * coordinator that condemns the row is often not the one that spawned it and
   * has no in-memory spawning entry to read the identity from.
   */
  runId?: string;
  /** The queued job this provision was spawned for. Absent for a warm fill. */
  boundJobId?: string;
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
  /**
   * The coordinator instance holding the reservation. Absent means "unknown
   * owner", never "held by someone else".
   */
  ownerInstanceId?: string;
}

/**
 * DB persistence for `ScalerManager` HA-critical state.
 *
 * Backed by four tables — `scaler_spawning_agents`, `scaler_agent_jobs`,
 * `scaler_reservations`, `scaler_pending_claims` — so a Raft leader switch /
 * coord crash no longer:
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
 *
 * Ownership columns (`owner_instance_id`, `adopted_by`) let several
 * coordinators behind one shared endpoint divide the same tables between them.
 * A NULL owner means the owner is unknown — it never means "owned by another
 * instance", so no query may read a NULL owner as somebody else's row.
 */
/**
 * Postgres `lock_not_available`. Raised when the `lock_timeout` the cap
 * transaction sets expires with the advisory lock still held elsewhere —
 * a contended lock on a healthy database, which reads very differently from a
 * database that could not be reached at all.
 */
export const PG_LOCK_NOT_AVAILABLE = '55P03';

export class ScalerStateStore {
  /**
   * `lockWaitMs` bounds how long `withScalerCapLock` waits to acquire the
   * advisory lock. It is the orchestrator's existing `dbPoolAcquireTimeoutMs`
   * — the same answer to "how long may a caller block waiting to get hold of a
   * database resource before we fail" — not a timeout of its own. Omitted, the
   * wait is unbounded except by `statement_timeout`, which is the behaviour a
   * store built without it has always had.
   */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly lockWaitMs?: number,
  ) {}

  // ── Spawning agents ───────────────────────────────────────────────

  async upsertSpawningAgent(snapshot: SpawningAgentSnapshot): Promise<void> {
    await upsertSpawningAgentOn(this.db, snapshot);
  }

  /**
   * Run a cap check plus its slot claim for one scaler under a cluster-wide
   * lock.
   *
   * `runWithReservationLock` in the manager is an in-process promise chain:
   * correct within an instance, blind across them. For an event scaler that
   * means N coordinators each provision up to `maxAgents` cloud instances, so
   * the number an operator writes is not the number they are billed for. The
   * advisory lock is transaction-scoped, so it releases on commit or rollback
   * with no unlock path to leak.
   *
   * The count and the claim share the transaction on purpose — see
   * `ScalerCapSlot.reserve`. `fn` therefore runs inside an open transaction:
   * keep it short, and never await anything outside the database in it.
   *
   * READ COMMITTED is pinned rather than inherited. The lock is taken first
   * and the count read second, so each statement needs its own snapshot for
   * the second holder to see the first one's committed row. Under REPEATABLE
   * READ the snapshot is taken at the FIRST statement — before the lock is
   * granted — so both coordinators would read the same pre-claim count and
   * both admit, reintroducing the exact defect this exists to close. Pinning
   * it means a server-side `default_transaction_isolation` change cannot do
   * that silently.
   *
   * A caller that cannot get the lock within `lockWaitMs` fails rather than
   * queuing: the manager holds its process-wide reservation lock across this
   * call, so an unbounded wait here stalls every other backend's scale
   * request too.
   */
  async withScalerCapLock<T>(
    scalerName: string,
    fn: (slot: ScalerCapSlot) => Promise<T> | T,
  ): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // `SET LOCAL` takes no bind parameter, so the value is inlined. The
        // normalisation is an availability guard, not an injection one:
        // `sql.lit` already escapes whatever it is given into a single literal
        // that Postgres rejects as a value, but a NaN or Infinity would render
        // as a well-formed literal Postgres cannot parse as an interval — and
        // since this is the FIRST statement in every cap transaction, that
        // would turn every event spawn into a permanent fail-closed refusal.
        // Postgres reads 0 as "no timeout", which is the operator's own escape
        // hatch on the same knob.
        const lockWait = normalizeLockWaitMs(this.lockWaitMs);
        if (lockWait !== undefined) {
          // `SET LOCAL` so it reverts on commit or rollback rather than
          // riding the pooled connection into whatever runs next on it.
          await sql`SET LOCAL lock_timeout = ${sql.lit(`${lockWait}ms`)}`.execute(trx);
        }
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`kici:scaler:cap|${scalerName}`}))`.execute(
          trx,
        );
        const row = await trx
          .selectFrom('scaler_spawning_agents')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('scaler_name', '=', scalerName)
          .where('backend_type', '=', ScalerBackendType.enum.event)
          .executeTakeFirst();
        return fn({
          clusterActiveCount: row ? Number(row.n) : 0,
          reserve: (snapshot) => upsertSpawningAgentOn(trx, snapshot),
        });
      });
  }

  async deleteSpawningAgent(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_spawning_agents').where('agent_id', '=', agentId).execute();
  }

  /**
   * Delete a spawning-agent row only while no instance has adopted it.
   *
   * The spawning instance is never told that a peer adopted its agent, so its
   * in-memory entry survives adoption and its stale-entry prune fires five
   * minutes later. An unconditional delete there would drop the row whose
   * `adopted_by` is the only durable record of a live provision — and an
   * adopted event agent legitimately runs for hours, so the reaper would find
   * nothing to tear down if the adopting instance then died. The
   * `adopted_by IS NULL` predicate keeps the prune to rows nobody claimed.
   */
  async deleteUnadoptedSpawningAgent(agentId: string): Promise<void> {
    await this.db
      .deleteFrom('scaler_spawning_agents')
      .where('agent_id', '=', agentId)
      .where('adopted_by', 'is', null)
      .execute();
  }

  /**
   * The instance that adopted a provision, or null while nobody has.
   *
   * The counterpart read to `deleteUnadoptedSpawningAgent`'s predicate, for the
   * caller that must not act rather than must not delete: the spawning instance
   * is never told that a peer adopted its agent, so a stale in-memory entry is
   * no evidence the provision failed.
   *
   * Reads the LIVE spawn row first and the durable outcome second, because the
   * spawn row is deleted on teardown and its absence is ambiguous — it is both
   * "never adopted" and "adopted, then torn down". The outcome row survives the
   * delete and answers the second case positively.
   *
   * A provision with neither row still answers null, and the prune treats that
   * as "no evidence" and reports — which is what a single coordinator wants and
   * what keeps every coordinator backing off on a real provisioning outage. See
   * `ScalerManager.reportPrunedProvisionFailure`.
   */
  async provisionAdopter(agentId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('scaler_spawning_agents')
      .select('adopted_by')
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    if (row?.adopted_by != null) return row.adopted_by;
    const outcome = await this.db
      .selectFrom('scaler_provision_outcomes')
      .select('adopted_by')
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    return outcome?.adopted_by ?? null;
  }

  /**
   * Every spawning-agent row in the table, whoever owns it. Not for recovery —
   * hydrating a peer's in-flight spawns as our own lets the spawn-timeout
   * reaper destroy agents that peer is still waiting on. Recovery uses
   * `listSpawningAgentsForOwner`.
   */
  async listSpawningAgents(): Promise<SpawningAgentSnapshot[]> {
    const rows = await this.db.selectFrom('scaler_spawning_agents').selectAll().execute();
    return rows.map(toSpawningSnapshot);
  }

  /**
   * Claim ownership of a spawning agent that registered on this instance.
   * Conditional on the row being unclaimed **or already claimed by this same
   * instance**, so exactly one instance adopts even if the agent flaps between
   * instances behind a load balancer, while a re-registration on the adopter
   * itself still resolves. Without the second arm a restart is a silent leak:
   * recovery rehydrates the row, the stale-spawn prune drops the in-memory
   * entry but spares the row, and the still-live agent's next registration
   * finds neither — it reads as a static agent, so no `scale-down` is ever
   * emitted and the reaper spares it because the agent is registered and its
   * adopter is alive. Gated on `backend_type = 'event'`: a local-backend
   * agent's compute is pinned to another host, so adopting its bookkeeping
   * would be a lie.
   *
   * The adoption is also recorded in `scaler_provision_outcomes`, in the SAME
   * transaction as the stamp. The spawn row is deleted on teardown, so its
   * `adopted_by` is not a durable answer to "was this provision ever adopted?"
   * — and the stale-spawn prune needs exactly that answer to tell a dead
   * external provision from a healthy one it was not told about. Writing
   * it here rather than at the two call sites is deliberate: this method is the
   * single writer of `adopted_by`, so no adoption path can miss the record.
   * Splitting the two writes would let a crash leave an adopted row whose
   * adoption the prune cannot see, which is the very ambiguity being removed.
   */
  async adoptSpawningAgent(
    agentId: string,
    instanceId: string,
  ): Promise<SpawningAgentSnapshot | null> {
    return this.db.transaction().execute(async (trx) => {
      const adoptedAt = new Date();
      const row = await trx
        .updateTable('scaler_spawning_agents')
        .set({ adopted_by: instanceId, adopted_at: adoptedAt })
        .where('agent_id', '=', agentId)
        .where((eb) => eb.or([eb('adopted_by', 'is', null), eb('adopted_by', '=', instanceId)]))
        .where('backend_type', '=', ScalerBackendType.enum.event)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await trx
        .insertInto('scaler_provision_outcomes')
        .values({
          agent_id: agentId,
          scaler_name: row.scaler_name,
          adopted_by: instanceId,
          adopted_at: adoptedAt,
          updated_at: adoptedAt,
        })
        .onConflict((oc) =>
          oc.column('agent_id').doUpdateSet({
            // First adoption wins. `adoptSpawningAgent` also succeeds when the
            // SAME instance re-adopts after a restart, and `adopted_*` record
            // when the provision was FIRST adopted and by whom — a historical
            // fact, not a last-touched stamp — so a re-adopt must not rewrite
            // them. `updated_at` below is the opposite kind of column and is
            // refreshed every time: it is the purge's retention clock, and it
            // cannot be held open by a re-adopt loop because adoption needs the
            // spawn row, whose presence already blocks the purge outright.
            adopted_by: sql`COALESCE(scaler_provision_outcomes.adopted_by, EXCLUDED.adopted_by)`,
            adopted_at: sql`COALESCE(scaler_provision_outcomes.adopted_at, EXCLUDED.adopted_at)`,
            updated_at: adoptedAt,
          }),
        )
        .execute();
      return toSpawningSnapshot(row);
    });
  }

  /**
   * Every spawning-agent row this instance owns. Scopes recovery so an instance
   * rehydrates only its own bookkeeping. A row with a NULL `owner_instance_id`
   * has an unknown owner and is deliberately not returned to anybody.
   */
  async listSpawningAgentsForOwner(instanceId: string): Promise<SpawningAgentSnapshot[]> {
    const rows = await this.db
      .selectFrom('scaler_spawning_agents')
      .selectAll()
      .where('owner_instance_id', '=', instanceId)
      .execute();
    return rows.map(toSpawningSnapshot);
  }

  /**
   * Every event row that is either past its spawn deadline without ever being
   * adopted, or adopted by some instance. The reaper decides which to tear down;
   * this only narrows the scan. Deliberately NOT a blanket `spawned_at < cutoff`
   * delete: an adopted event agent legitimately runs for hours.
   */
  async listReapCandidates(spawnCutoff: Date): Promise<ReapCandidate[]> {
    const rows = await this.db
      .selectFrom('scaler_spawning_agents')
      .select([
        'agent_id',
        'scaler_name',
        'provisioning_targets',
        'owner_instance_id',
        'adopted_by',
        'spawned_at',
        'run_id',
        'bound_job_id',
      ])
      .where('backend_type', '=', ScalerBackendType.enum.event)
      .where((eb) => eb.or([eb('adopted_by', 'is not', null), eb('spawned_at', '<', spawnCutoff)]))
      .execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      scalerName: row.scaler_name,
      provisioningTargets: parseLabelSet(row.provisioning_targets),
      spawnedAt: row.spawned_at,
      ...(row.owner_instance_id != null && { ownerInstanceId: row.owner_instance_id }),
      ...(row.adopted_by != null && { adoptedBy: row.adopted_by }),
      ...(row.run_id != null && { runId: row.run_id }),
      ...(row.bound_job_id != null && { boundJobId: row.bound_job_id }),
    }));
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
    const columns = {
      scaler_name: snapshot.scalerName,
      cpu_units: snapshot.cpus,
      mem_bytes: snapshot.memBytes,
      // Written only when supplied — see `upsertSpawningAgent` for why.
      ...(snapshot.ownerInstanceId !== undefined && {
        owner_instance_id: snapshot.ownerInstanceId,
      }),
    };
    await this.db
      .insertInto('scaler_reservations')
      .values({ agent_id: snapshot.agentId, ...columns })
      .onConflict((oc) => oc.column('agent_id').doUpdateSet(columns))
      .execute();
  }

  async deleteReservation(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_reservations').where('agent_id', '=', agentId).execute();
  }

  /**
   * Every reservation row in the table, whoever holds it. Not for recovery —
   * counting a peer's reservations against our own caps double-books the
   * cluster. Recovery uses `listReservationsForOwner`.
   */
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

  /**
   * Every reservation this instance holds. Scopes recovery so an instance
   * rehydrates only its own usage. A row with a NULL `owner_instance_id` has an
   * unknown owner and is deliberately not returned to anybody.
   */
  async listReservationsForOwner(instanceId: string): Promise<ReservationSnapshot[]> {
    const rows = await this.db
      .selectFrom('scaler_reservations')
      .select(['agent_id', 'scaler_name', 'cpu_units', 'mem_bytes', 'owner_instance_id'])
      .where('owner_instance_id', '=', instanceId)
      .execute();
    return rows.map((row) => ({
      agentId: row.agent_id,
      scalerName: row.scaler_name,
      cpus: row.cpu_units,
      memBytes: typeof row.mem_bytes === 'string' ? Number(row.mem_bytes) : row.mem_bytes,
      ...(row.owner_instance_id != null && { ownerInstanceId: row.owner_instance_id }),
    }));
  }

  // ── Pending claims ────────────────────────────────────────────────

  async registerClaim(row: PendingClaimRow): Promise<void> {
    const values: NewScalerPendingClaimRow = {
      claim_hash: row.claimHash,
      claim_prefix: row.claimPrefix,
      agent_id: row.agentId,
      scaler_name: row.scalerName,
      labels: JSON.stringify(row.labels),
      agent_token_ttl_ms: row.agentTokenTtlMs,
      orchestrator_url: row.orchestratorUrl,
      expires_at: row.expiresAt,
      consumed_at: null,
    };
    await this.db.insertInto('scaler_pending_claims').values(values).execute();
  }

  /**
   * Consume a claim and return its spec, or null when the code is unknown,
   * already consumed, or expired. The UPDATE is the consumption: it commits
   * before any mint is attempted, so two concurrent claims of one code — on the
   * same instance or on different ones — can never both mint.
   */
  async redeemClaim(claimHash: string): Promise<RedeemedClaim | null> {
    const row = await this.db
      .updateTable('scaler_pending_claims')
      .set({ consumed_at: new Date() })
      .where('claim_hash', '=', claimHash)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    return {
      agentId: row.agent_id,
      labels: parseLabelSet(row.labels),
      // BIGINT: node-pg hands this back as a string.
      agentTokenTtlMs: Number(row.agent_token_ttl_ms),
      orchestratorUrl: row.orchestrator_url,
    };
  }

  /**
   * Why a redeem failed. Called ONLY on the failure path, so the happy path
   * stays one round trip.
   */
  async describeClaim(claimHash: string): Promise<{ consumed: boolean; expired: boolean } | null> {
    const row = await this.db
      .selectFrom('scaler_pending_claims')
      .select(['consumed_at', 'expires_at'])
      .where('claim_hash', '=', claimHash)
      .executeTakeFirst();
    if (!row) return null;
    return {
      consumed: row.consumed_at != null,
      expired: row.expires_at.getTime() <= Date.now(),
    };
  }

  async invalidateClaimsForAgent(agentId: string): Promise<void> {
    await this.db.deleteFrom('scaler_pending_claims').where('agent_id', '=', agentId).execute();
  }

  /**
   * Delete every claim whose `expires_at` passed before `cutoff`. Returns how
   * many rows went.
   *
   * Nothing else removes a claim on a timer: `redeemClaim` only marks
   * `consumed_at`, and `invalidateClaimsForAgent` runs on a teardown path a
   * stranded provision never reaches. So a claim outlives its agent whenever a
   * registration unwinds after the claim was written, or whenever the
   * coordinator that would have torn the agent down crashed first — and the row
   * then sits in the table forever. Purging on `expires_at` covers both,
   * consumed or not, because an expired claim can never be redeemed again.
   *
   * The caller subtracts a retention grace from now, so `describeClaim` can
   * still tell a late redeemer "expired" rather than "unknown code" for a while
   * after the deadline. Backed by `idx_scaler_pending_claims_expires_at`.
   */
  async purgeExpiredClaims(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('scaler_pending_claims')
      .where('expires_at', '<', cutoff)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  // ── Provision outcomes ────────────────────────────────────────────

  /**
   * Record the reaper's teardown verdict for one provision.
   *
   * Deliberately additive: it writes only the `condemned_*` columns. A
   * `heartbeat-timeout` condemns a provision that WAS adopted, so clearing the
   * adoption here would put the stale-spawn prune straight back to reporting a
   * healthy provision as a failed one — the exact misattribution this table
   * exists to remove.
   *
   * Called only once the teardown was actually delivered. An emit that reached
   * nobody leaves the spawn row in place for the reaper to retry, so there is
   * no verdict yet to record.
   *
   * The `condemned_*` half is the forensic side of the record and has no
   * production reader: `provisionAdopter` answers from `adopted_by` alone, so
   * the prune's verdict does not depend on it. It is written because the row
   * is the only surviving account of what became of a provision once the spawn
   * row is gone — which is what an operator investigating a torn-down
   * provision, and the E2E that pins this behaviour, read it for.
   */
  async recordProvisionCondemned(
    agentId: string,
    scalerName: string,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto('scaler_provision_outcomes')
      .values({
        agent_id: agentId,
        scaler_name: scalerName,
        condemned_reason: reason,
        condemned_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('agent_id').doUpdateSet({
          condemned_reason: reason,
          condemned_at: now,
          updated_at: now,
        }),
      )
      .execute();
  }

  /**
   * Delete outcome rows that can no longer be asked about; returns rows deleted.
   *
   * Two predicates, and the second is the load-bearing one. The cutoff alone is
   * not safe: recovery rehydrates an in-memory spawning entry from
   * `scaler_spawning_agents`, and a rehydrated entry is immediately stale, so
   * it asks about its provision on the very next prune however old the
   * provision is. While the spawn row exists the outcome must stay. Once the
   * spawn row is gone, nothing can rehydrate an entry for it, and the caller's
   * retention floor covers the one prune window still in flight.
   *
   * Backed by `idx_scaler_provision_outcomes_updated_at`.
   */
  async purgeProvisionOutcomes(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('scaler_provision_outcomes')
      .where('updated_at', '<', cutoff)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('scaler_spawning_agents')
              .select('scaler_spawning_agents.agent_id')
              .whereRef(
                'scaler_spawning_agents.agent_id',
                '=',
                'scaler_provision_outcomes.agent_id',
              ),
          ),
        ),
      )
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}

/**
 * Coerce a configured lock wait to a whole non-negative millisecond count, or
 * `undefined` when there is nothing usable to set.
 *
 * A non-finite value would render as a literal Postgres cannot read as an
 * interval, failing the first statement of every cap transaction — so an
 * unusable setting is dropped rather than sent.
 */
function normalizeLockWaitMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/**
 * Write a spawning-agent row on the given executor.
 *
 * Takes the executor rather than reading `this.db` so the same write serves the
 * ordinary fire-and-forget path and the claim inside `withScalerCapLock`'s
 * transaction — a `Transaction` is a `Kysely`, and one writer means the two can
 * never disagree about which columns a spawn row carries.
 */
async function upsertSpawningAgentOn(
  db: Kysely<Database>,
  snapshot: SpawningAgentSnapshot,
): Promise<void> {
  // `adopted_by` / `adopted_at` are deliberately absent: they belong to
  // `adoptSpawningAgent`, and re-writing them here would let a spawn-time
  // upsert clear an adoption another instance already won.
  const columns = {
    scaler_name: snapshot.scalerName,
    label_set: JSON.stringify(snapshot.labelSet),
    run_id: snapshot.runId ?? null,
    job_id: snapshot.jobId ?? null,
    bound_job_id: snapshot.boundJobId ?? null,
    // Each ownership column is written only when the caller supplied it, so a
    // caller that knows nothing about instance ownership cannot null out a
    // value some other write already established.
    ...(snapshot.ownerInstanceId !== undefined && {
      owner_instance_id: snapshot.ownerInstanceId,
    }),
    ...(snapshot.mandatoryLabels !== undefined && {
      mandatory_labels: JSON.stringify(snapshot.mandatoryLabels),
    }),
    ...(snapshot.provisioningTargets !== undefined && {
      provisioning_targets: JSON.stringify(snapshot.provisioningTargets),
    }),
    ...(snapshot.roles !== undefined && { roles: JSON.stringify(snapshot.roles) }),
    ...(snapshot.backendType !== undefined && { backend_type: snapshot.backendType }),
  };
  await db
    .insertInto('scaler_spawning_agents')
    .values({ agent_id: snapshot.agentId, ...columns })
    .onConflict((oc) => oc.column('agent_id').doUpdateSet(columns))
    .execute();
}

/**
 * Map a `scaler_spawning_agents` row to its snapshot, self-describing fields
 * included. Shared by the plain listing, the owner-scoped listing, and the
 * adoption path so the three cannot drift.
 */
function toSpawningSnapshot(row: ScalerSpawningAgentRow): SpawningAgentSnapshot {
  const snapshot: SpawningAgentSnapshot = {
    agentId: row.agent_id,
    scalerName: row.scaler_name,
    labelSet: parseLabelSet(row.label_set),
    spawnedAt: row.spawned_at,
  };
  if (row.run_id != null) snapshot.runId = row.run_id;
  if (row.job_id != null) snapshot.jobId = row.job_id;
  if (row.bound_job_id != null) snapshot.boundJobId = row.bound_job_id;
  if (row.owner_instance_id != null) snapshot.ownerInstanceId = row.owner_instance_id;
  if (row.adopted_by != null) snapshot.adoptedBy = row.adopted_by;
  if (row.adopted_at != null) snapshot.adoptedAt = row.adopted_at;
  if (row.mandatory_labels != null) snapshot.mandatoryLabels = parseLabelSet(row.mandatory_labels);
  if (row.provisioning_targets != null) {
    snapshot.provisioningTargets = parseLabelSet(row.provisioning_targets);
  }
  if (row.roles != null) snapshot.roles = parseLabelSet(row.roles);
  if (row.backend_type != null) snapshot.backendType = row.backend_type;
  return snapshot;
}

/**
 * Decode a jsonb string-array column. pg's jsonb columns arrive parsed when
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
