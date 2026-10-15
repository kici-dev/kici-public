import { ScalerBackendType } from '@kici-dev/engine';
import { sql, type Kysely } from 'kysely';

import type { Database, NewScalerPendingClaimRow, ScalerSpawningAgentRow } from '../db/types.js';
import type { ScalerEvent } from './types.js';

/**
 * A `scaler_spawning_agents` row.
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
  adoptedAt?: Date;
  /** Copied from the scaler at spawn time, as are `provisioningTargets` and `roles`. */
  mandatoryLabels?: string[];
  provisioningTargets?: string[];
  roles?: string[];
  backendType?: string;
}

/** Written by the event scaler's claim store. */
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
   * Live event-scaler spawn rows for this scaler across every coordinator,
   * read inside the advisory-locked transaction so no other lock holder can
   * change it while the caller decides.
   */
  clusterActiveCount: number;
  /**
   * Claim a slot by writing the spawn row in the same transaction the count
   * was read in. Counting without claiming bounds nothing: the spawn row is
   * otherwise written well after the check, so every coordinator arriving in
   * that window reads the same pre-spawn count and admits.
   */
  reserve(snapshot: SpawningAgentSnapshot): Promise<void>;
  /**
   * Whether this scaler holds a spawn row bound to `jobId` on any coordinator,
   * read inside the same locked transaction as the claim.
   */
  hasProvisionForJob(jobId: string): Promise<boolean>;
}

/** A row the event-provision reaper may need to tear down. */
export interface ReapCandidate {
  agentId: string;
  scalerName: string;
  provisioningTargets: string[];
  ownerInstanceId?: string;
  adoptedBy?: string;
  /**
   * The reaper ages every row on this, never on `adopted_at`: a coordinator
   * that re-adopts its own agent refreshes `adopted_at`, so a restart loop on
   * the adopter would keep resetting the clock and the row would never age out.
   */
  spawnedAt: Date;
  /**
   * Set when job-bound, so a teardown of a never-registered provision can be
   * attributed to the waiting job: the reaper is leader-gated, so the
   * condemning coordinator often did not spawn the row and has no in-memory
   * spawning entry to read the identity from.
   */
  runId?: string;
  /** Absent for a warm fill. */
  boundJobId?: string;
}

/** A `scaler_agent_jobs` row. */
export interface AgentJobCorrelationSnapshot {
  agentId: string;
  runId: string;
  jobId: string;
}

/** A `scaler_reservations` row. */
export interface ReservationSnapshot {
  agentId: string;
  scalerName: string;
  cpus: number;
  memBytes: number;
  /** Absent means "unknown owner", never "held by someone else". */
  ownerInstanceId?: string;
}

/**
 * DB persistence for `ScalerManager` HA-critical state.
 *
 * Backed by `scaler_spawning_agents`, `scaler_agent_jobs`,
 * `scaler_reservations` and `scaler_pending_claims`, so a Raft leader switch
 * or coord crash does not:
 *
 *  - orphan a mid-spawn agent (lost `boundJobId` → eager dispatch silently
 *    downgraded to a generic queue drain),
 *  - strand a reservation (counted as used until the backend GC disconnects
 *    the agent, minutes later),
 *  - drop the agent → run/job correlation (execution-tracker loses
 *    scaler-lifecycle events emitted by the new coord).
 *
 * The consumer keeps in-memory Maps as L1 caches, hydrated via `recoverState()`
 * on boot / become-leader.
 *
 * `perScalerUsage` / `globalUsage` are NOT stored: they are recomputed from
 * `SUM(...) FROM scaler_reservations` on recovery, so the reservation rows are
 * the single source of truth for the cap-check critical section.
 *
 * The `eventBuffer` Map is not persisted: a coord crash before
 * `correlateAgentToJob()` loses those events, which are observability, not
 * correctness — nothing downstream waits on them.
 *
 * Ownership columns (`owner_instance_id`, `adopted_by`) let several
 * coordinators behind one shared endpoint divide the same tables between them.
 * A NULL owner means the owner is unknown — it never means "owned by another
 * instance", so no query may read a NULL owner as somebody else's row.
 */
/**
 * Postgres `lock_not_available`: the cap transaction's `lock_timeout` expired
 * with the advisory lock held elsewhere — a contended lock on a healthy
 * database, unlike a database that could not be reached at all.
 */
export const PG_LOCK_NOT_AVAILABLE = '55P03';

export class ScalerStateStore {
  /**
   * `lockWaitMs` bounds how long `withScalerCapLock` waits for the advisory
   * lock. It is the orchestrator's `dbPoolAcquireTimeoutMs`, not a timeout of
   * its own. Omitted, the wait is bounded only by `statement_timeout`.
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
   * The manager's `runWithReservationLock` is an in-process promise chain,
   * blind across instances: N coordinators would each provision up to
   * `maxAgents` cloud instances. The advisory lock is transaction-scoped, so it
   * releases on commit or rollback with no unlock path to leak.
   *
   * The count and the claim share the transaction (see `ScalerCapSlot.reserve`),
   * so `fn` runs inside an open transaction: keep it short, and never await
   * anything outside the database in it.
   *
   * READ COMMITTED is pinned, not inherited: the lock is taken before the count
   * is read, so each statement needs its own snapshot to see the previous
   * holder's committed row. Under REPEATABLE READ the snapshot is taken at the
   * FIRST statement, before the lock is granted, so both coordinators would
   * read the same pre-claim count and admit. Pinning it means a server-side
   * `default_transaction_isolation` change cannot do that silently.
   *
   * A caller that cannot get the lock within `lockWaitMs` fails rather than
   * queuing: the manager holds its process-wide reservation lock across this
   * call, so an unbounded wait would stall every other backend's scale request.
   */
  async withScalerCapLock<T>(
    scalerName: string,
    fn: (slot: ScalerCapSlot) => Promise<T> | T,
  ): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // `SET LOCAL` takes no bind parameter, so the value is inlined.
        // Normalising is an availability guard, not an injection one (`sql.lit`
        // already escapes): a NaN or Infinity renders a literal Postgres cannot
        // parse as an interval, and as the FIRST statement of every cap
        // transaction it would fail-close every event spawn. Postgres reads 0
        // as "no timeout", the operator's escape hatch on the same knob.
        const lockWait = normalizeLockWaitMs(this.lockWaitMs);
        if (lockWait !== undefined) {
          // `SET LOCAL` reverts on commit or rollback, so it never rides the
          // pooled connection into whatever runs next.
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
          hasProvisionForJob: async (jobId) =>
            (await trx
              .selectFrom('scaler_spawning_agents')
              .select('agent_id')
              .where('scaler_name', '=', scalerName)
              .where('bound_job_id', '=', jobId)
              .limit(1)
              .executeTakeFirst()) !== undefined,
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
   * stale-entry prune fires five minutes later regardless. An unconditional
   * delete would drop the row whose `adopted_by` is the only durable record of
   * a live provision; an adopted event agent can run for hours, so the reaper
   * would find nothing to tear down if the adopting instance then died.
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
   * The read counterpart of `deleteUnadoptedSpawningAgent`'s predicate, for a
   * caller that must not act: a stale in-memory entry on the spawning instance
   * is no evidence the provision failed.
   *
   * Reads the LIVE spawn row first, then the durable outcome: the spawn row is
   * deleted on teardown, so its absence means either "never adopted" or
   * "adopted, then torn down", and the outcome row answers the second case.
   *
   * Neither row answers null; the prune treats that as "no evidence" and
   * reports, which keeps every coordinator backing off on a real provisioning
   * outage. See `ScalerManager.reportPrunedProvisionFailure`.
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
   * Every row, whoever owns it. Not for recovery (use
   * `listSpawningAgentsForOwner`): hydrating a peer's in-flight spawns as our
   * own lets the spawn-timeout reaper destroy agents that peer still awaits.
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
   * finds neither — it reads as a static agent, so no `scale-down` is emitted
   * and the reaper spares it (registered, adopter alive). Gated on
   * `backend_type = 'event'`: a local-backend agent's compute is pinned to
   * another host, so adopting its bookkeeping would be a lie.
   *
   * The adoption is also recorded in `scaler_provision_outcomes`, in the SAME
   * transaction: the spawn row is deleted on teardown, and the stale-spawn
   * prune needs a durable "was this ever adopted?" to tell a dead external
   * provision from a healthy one it was not told about. This method is the
   * single writer of `adopted_by`, so no adoption path can miss the record;
   * splitting the writes would let a crash hide an adoption from the prune.
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
            // First adoption wins: `adopted_*` record the FIRST adoption, so a
            // same-instance re-adopt after a restart must not rewrite them.
            // `updated_at` is refreshed every time as the purge's retention
            // clock; a re-adopt loop cannot hold it open, because adoption needs
            // the spawn row, whose presence already blocks the purge.
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
   * Scopes recovery to this instance's own bookkeeping. A NULL-owner row is
   * deliberately returned to nobody.
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
   * Whether `instanceId` adopted an event provision whose spawn row is live —
   * a row the reaper judges by its adopter's liveness, not its deadline.
   * `peer forget` reads it, so forgetting such an adopter never cuts the
   * reaper's grace short.
   */
  async hasAdoptedProvisions(instanceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('scaler_spawning_agents')
      .select('agent_id')
      .where('backend_type', '=', ScalerBackendType.enum.event)
      .where('adopted_by', '=', instanceId)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Event rows either adopted, or past the spawn deadline unadopted. The reaper
   * decides what to tear down; this only narrows the scan. NOT a blanket
   * `spawned_at < cutoff` delete: an adopted event agent can run for hours.
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
   * Every row, whoever holds it. Not for recovery (use
   * `listReservationsForOwner`): counting a peer's reservations against our
   * own caps double-books the cluster.
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
   * Scopes recovery to this instance's own usage. A NULL-owner row is
   * deliberately returned to nobody.
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
   * Null when the code is unknown, consumed or expired. The UPDATE is the
   * consumption and commits before any mint, so two concurrent claims of one
   * code, on one instance or several, can never both mint.
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

  /** Why a redeem failed; called ONLY on failure, so the happy path stays one round trip. */
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
   * Delete every claim whose `expires_at` is before `cutoff`; returns rows deleted.
   *
   * Nothing else removes a claim on a timer: `redeemClaim` only marks
   * `consumed_at`, and `invalidateClaimsForAgent` runs on a teardown path a
   * stranded provision never reaches (a registration unwound after the claim
   * was written, or the tearing-down coordinator crashed first). An expired
   * claim can never be redeemed, so purging covers both, consumed or not.
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
   * Writes only the `condemned_*` columns: a `heartbeat-timeout` condemns a
   * provision that WAS adopted, and clearing the adoption would make the
   * stale-spawn prune report a healthy provision as failed.
   *
   * Called only once the teardown was delivered; an emit that reached nobody
   * leaves the spawn row for the reaper to retry, so there is no verdict yet.
   *
   * `condemned_*` is forensic, with no production reader (`provisionAdopter`
   * reads `adopted_by` alone): once the spawn row is gone, this row is the only
   * account an operator has of what became of a torn-down provision.
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
   * The cutoff alone is not safe: a spawning entry rehydrated by recovery is
   * immediately stale, so it asks about its provision on the next prune however
   * old the provision is. So the outcome stays while the spawn row exists; once
   * it is gone nothing can rehydrate an entry, and the caller's retention floor
   * covers the one prune window still in flight.
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
 * Coerce a lock wait to whole non-negative milliseconds. A non-finite value is
 * dropped (`undefined`): Postgres cannot read it as an interval, so it would
 * fail the first statement of every cap transaction.
 */
function normalizeLockWaitMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/**
 * Takes the executor so one writer serves both the fire-and-forget path and
 * the claim inside `withScalerCapLock`'s transaction, and the two never
 * disagree about which columns a spawn row carries.
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
    // Ownership columns are written only when supplied, so a caller unaware of
    // ownership cannot null out a value another write established.
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

/** Shared by both listings and the adoption path so they cannot drift. */
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
 * Decode a jsonb string-array column. pg delivers jsonb parsed; the string
 * branch serves mock-DB tests and any minimally-typed driver.
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
 * Kept here, not in manager.ts, so `recoverState()` can declare a clean return
 * type. Result of `ScalerManager.recoverState()` replaying state from the DB after a
 * leader switch. `bufferedEventsLost` is always 0 (the `eventBuffer` Map is not
 * persisted); the field keeps a future buffer table type-compatible.
 */
export interface ScalerStateRecovery {
  spawningAgentsRehydrated: number;
  /**
   * Spawn rows released during recovery because their backend is local
   * (container / firecracker / bare-metal): such a spawn cannot outlive the
   * process that started it, and rehydrating it would hold its reservation
   * until the stale prune.
   */
  spawningDropped: number;
  agentJobsRehydrated: number;
  reservationsRehydrated: number;
  /**
   * Reservation rows no rehydrated spawn backs, discarded during recovery;
   * counted apart so a deployment with orphaned rows says so on every boot.
   */
  reservationsDropped: number;
  bufferedEventsLost: number;
}

/** Keeps the `ScalerEvent` import, and the buffered-events note, compile-checked. */
export type { ScalerEvent };
