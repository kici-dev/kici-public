import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import {
  OverflowStatus,
  OverflowSourceKind,
  OverflowDropReason,
  type OverflowDelivery,
} from './ingest-overflow-types.js';
import {
  ingestOverflowReplayedTotal,
  ingestOverflowDroppedTotal,
  ingestOverflowReplayRefusedTotal,
  setIngestOverflowBuffered,
} from '../metrics/prometheus.js';
import type { AdmitResult } from './ingest-admission.js';

const logger = createLogger({ prefix: 'orch:ingest-overflow-replayer' });

/**
 * Re-inject one buffered delivery through the ingest pipeline.
 *
 * The caller (this replayer) already holds the admission grant, so an
 * implementation MUST NOT admit again — that second admission is what used to
 * charge a per-org capacity refusal against the delivery's failure budget.
 */
export type ReinjectFn = (d: OverflowDelivery) => Promise<WebhookIngestOutcome>;

/**
 * The admission-controller surface the replayer needs: the pass-level
 * short-circuit and the per-row reservation.
 */
export interface ReplayAdmissionController {
  isShedding(): boolean;
  reserve(key: string, orgCap: number): AdmitResult;
}

/** Resolve a routing key to its fairness key + per-org concurrency cap. */
export type ResolveAdmissionKeyFn = (
  routingKey: string,
) => Promise<{ key: string; orgCap: number }>;

/** The minimum a caller needs to release a claim it holds. */
interface ClaimedRow {
  id: number;
  deliveryId: string;
  attempts: number;
}

function toClaim(row: OverflowRow): ClaimedRow {
  return { id: row.id, deliveryId: row.delivery_id, attempts: row.replay_attempts };
}

interface OverflowRow {
  id: number;
  delivery_id: string;
  routing_key: string;
  source_kind: string;
  provider: string | null;
  event: string;
  action: string | null;
  body: string;
  meta: Record<string, unknown>;
  replay_attempts: number;
  status: string;
}

export interface IngestOverflowReplayerDeps {
  db: Kysely<Database>;
  controller: ReplayAdmissionController;
  /**
   * Resolve a buffered row's routing key to the same fairness key + per-org cap
   * the live ingest paths admit on, so a reservation competes on exactly the
   * terms a fresh delivery would.
   */
  resolveAdmissionKey: ResolveAdmissionKeyFn;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  /**
   * Wall-clock retention bound. A row that has sat `buffered` this long without
   * ever winning a capacity grant is marked `failed` (`max_age`) rather than
   * held forever. This is what keeps the buffer bounded now that a capacity
   * refusal no longer consumes an attempt: without it, a permanently saturated
   * org's rows would fill `ingestOverflowMax` and capture would start dropping
   * FRESH deliveries instead — trading a bounded per-delivery loss for an
   * unbounded new-delivery one.
   */
  maxAgeMs: number;
  /**
   * How long a `replaying` claim may stand before it is reclaimed. Resolved per
   * pass so a fleet-wide `cluster_settings` override takes effect without a
   * restart; the number passed here is the configured cluster default.
   */
  claimTimeoutMs: number;
  /** Fleet-wide override reader for {@link IngestOverflowReplayerDeps.claimTimeoutMs}. */
  clusterSettings?: ClusterSettingsReader;
  /** Injectable clock (default `Date.now`); the retention bound reads it. */
  now?: () => number;
}

/**
 * Background drain for the durable ingest queue. Each pass first reclaims rows
 * whose `replaying` claim went stale — a worker killed mid-pipeline releases
 * nothing, so without this its delivery would sit claimed forever and the
 * durable row it acknowledged would never be worth anything. It then expires
 * rows past the wall-clock retention bound, and finally drains the oldest
 * `buffered` rows FIFO up to a bounded batch.
 *
 * **Reserve, then claim.** The drain takes an admission slot from the same
 * controller the live ingest paths use BEFORE it claims a row, and holds that
 * grant across the whole re-injection. A refusal therefore leaves the row
 * untouched in `buffered` with its attempt counter unmoved — the delivery never
 * entered the pipeline, so there was no delivery failure to charge. Ordering it
 * the other way round is what used to spend a per-delivery failure budget on a
 * transient per-org capacity refusal, killing a whole FIFO cohort in seconds.
 *
 * `replay_attempts` therefore counts genuine failures only: a verify throw, a
 * pipeline throw, a stale claim. Retention is bounded by `maxAgeMs` instead.
 *
 * Refusal is per fairness key: a saturated org's rows are skipped for the rest
 * of the pass while other orgs' rows keep draining, mirroring the fair skip the
 * controller's own queue does. Reclaiming is not gated on load at all: a
 * stranded claim is stranded regardless, and the row it frees waits in
 * `buffered` until a reservation succeeds.
 */
export class IngestOverflowReplayer {
  private readonly db: Kysely<Database>;
  private readonly controller: ReplayAdmissionController;
  private readonly resolveAdmissionKey: ResolveAdmissionKeyFn;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly claimTimeoutMs: number;
  private readonly clusterSettings: ClusterSettingsReader | undefined;
  private readonly now: () => number;
  private reinjectDirect: ReinjectFn | undefined;
  private reinjectRelay: ReinjectFn | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopped = false;

  constructor(deps: IngestOverflowReplayerDeps) {
    this.db = deps.db;
    this.controller = deps.controller;
    this.resolveAdmissionKey = deps.resolveAdmissionKey;
    this.intervalMs = deps.intervalMs;
    this.batchSize = deps.batchSize;
    this.maxAttempts = deps.maxAttempts;
    this.maxAgeMs = deps.maxAgeMs;
    this.claimTimeoutMs = deps.claimTimeoutMs;
    this.clusterSettings = deps.clusterSettings;
    this.now = deps.now ?? Date.now;
  }

  setReinjectDirect(fn: ReinjectFn): void {
    this.reinjectDirect = fn;
  }
  setReinjectRelay(fn: ReinjectFn): void {
    this.reinjectRelay = fn;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass().catch((err) =>
        logger.warn('overflow replay pass failed', { error: toErrorMessage(err) }),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One drain pass. Test-drivable. */
  async runPass(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      // Free stranded claims first, so a row a dead worker was holding is
      // eligible for the very same pass rather than waiting for the next one.
      await this.reclaimStaleClaims();
      // Retention runs regardless of load: an over-age row must not be replayed,
      // and holding one back until the gate opens is what fills the cap.
      await this.expireAgedRows();
      // A latched loop-lag / CoDel shed refuses every reservation below anyway;
      // short-circuiting here just skips the candidate SELECT while the process
      // is the thing under pressure. The reservation, not this boolean, is the
      // gate — this check has never been able to observe the per-key
      // `queue_full` refusal that is the common case.
      if (!this.controller.isShedding()) await this.drain();
      // Sweep + gauge unconditionally: an operator watching the buffer depth
      // during an overload needs it to keep tracking, not to freeze.
      await this.sweepReplayed();
      await this.refreshDepthGauge();
    } catch (err) {
      // A DB-health blip (count/select failed): skip this pass, retry next tick.
      logger.warn('overflow replay pass aborted', { error: toErrorMessage(err) });
    } finally {
      this.running = false;
    }
  }

  /**
   * Revert `replaying` rows whose claim went stale to `buffered`, counting the
   * abandoned attempt so a row that keeps stranding eventually goes `failed`
   * instead of looping forever.
   *
   * A row claimed before the claim clock shipped has a null `claimed_at`; it is
   * aged off `captured_at` instead, which is a safe over-estimate of how long
   * it has been claimed.
   */
  private async reclaimStaleClaims(): Promise<void> {
    const timeoutMs =
      (await this.clusterSettings?.getNumber(
        'ingest_overflow_claim_timeout_ms',
        this.claimTimeoutMs,
      )) ?? this.claimTimeoutMs;
    const cutoff = new Date(this.now() - timeoutMs);

    const stale = (await this.db
      .selectFrom('ingest_overflow_buffer')
      .select(['id', 'delivery_id', 'replay_attempts'])
      .where('status', '=', OverflowStatus.enum.replaying)
      .where((eb) =>
        eb.or([
          eb('claimed_at', '<', cutoff),
          eb.and([eb('claimed_at', 'is', null), eb('captured_at', '<', cutoff)]),
        ]),
      )
      .limit(this.batchSize)
      .execute()) as unknown as Array<{
      id: number;
      delivery_id: string;
      replay_attempts: number;
    }>;

    for (const row of stale) {
      const released = await this.releaseClaim(
        row.id,
        `claim went stale after ${timeoutMs}ms (worker did not release it)`,
      );
      if (released) {
        logger.warn('reclaimed a stale ingest-queue claim', {
          deliveryId: row.delivery_id,
          rowId: row.id,
          attempts: row.replay_attempts + 1,
          timeoutMs,
        });
      }
    }
  }

  /**
   * Release a claim: revert the row to `buffered` so the drain retries it, or
   * mark it `failed` once the attempt ceiling is hit. Returns false when the
   * row is gone or is no longer `replaying` — another worker owns it now, so
   * this caller must not touch it.
   *
   * Public because the accept path's background worker holds a claim it did not
   * take through {@link claimBatch} and must release it the same way on failure.
   */
  async releaseClaim(id: number, reason: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('ingest_overflow_buffer')
      .select(['id', 'delivery_id', 'replay_attempts', 'status'])
      .where('id', '=', id)
      .where('status', '=', OverflowStatus.enum.replaying)
      .executeTakeFirst();
    if (!row) return false;
    return await this.revertOrFail(
      { id: Number(row.id), deliveryId: row.delivery_id, attempts: Number(row.replay_attempts) },
      reason,
    );
  }

  /**
   * Mark every `buffered` row past the retention bound `failed`. Only
   * `buffered` rows are eligible, so a row a worker is actively holding is
   * never expired out from under it — the stale-claim reclaim above hands that
   * row back to `buffered` first, and the next pass expires it there. That is
   * why the two bounds compose rather than race even when `maxAgeMs` equals
   * `claimTimeoutMs`.
   */
  private async expireAgedRows(): Promise<void> {
    const cutoff = new Date(this.now() - this.maxAgeMs);
    const aged = (await this.db
      .selectFrom('ingest_overflow_buffer')
      .select(['id', 'delivery_id', 'replay_attempts'])
      .where('status', '=', OverflowStatus.enum.buffered)
      .where('captured_at', '<', cutoff)
      .limit(this.batchSize)
      .execute()) as unknown as Array<{
      id: number;
      delivery_id: string;
      replay_attempts: number;
    }>;

    for (const row of aged) {
      const reason = `expired after ${this.maxAgeMs}ms buffered without a capacity grant`;
      const res = await this.db
        .updateTable('ingest_overflow_buffer')
        .set({
          status: OverflowStatus.enum.failed,
          last_error: reason,
          claimed_at: null,
        })
        .where('id', '=', row.id)
        .where('status', '=', OverflowStatus.enum.buffered)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows ?? 0n) === 0) continue;

      ingestOverflowDroppedTotal.add(1, { reason: OverflowDropReason.enum.max_age });
      // Error, not warn, for the same reason the max-attempts line is: the
      // delivery was already acknowledged to the sender, so this line is the
      // only place a human learns the work never happened.
      logger.error('ingest-queue delivery abandoned past max age', {
        deliveryId: row.delivery_id,
        attempts: row.replay_attempts,
        maxAgeMs: this.maxAgeMs,
        reason,
        remedy:
          'the orchestrator never regained capacity for this org within the retention window — check kici_orch_ingest_inflight against kici_orch_ingest_org_max_concurrency, then redeliver from the provider',
      });
    }
  }

  /**
   * Reserve-then-claim drain. For each candidate, oldest first: resolve its
   * fairness key, take an admission slot, and only then claim the row. A
   * refusal skips that key for the rest of the pass and leaves the row exactly
   * as it was — `buffered`, same attempt count, no `last_error`.
   */
  private async drain(): Promise<void> {
    const candidates = (await this.db
      .selectFrom('ingest_overflow_buffer')
      .selectAll()
      .where('status', '=', OverflowStatus.enum.buffered)
      .orderBy('captured_at', 'asc')
      .limit(this.batchSize)
      .execute()) as unknown as OverflowRow[];

    // Fair skip: one org at its cap must not stall the rows behind it, and
    // re-reserving on a key already known refused this pass buys nothing.
    const refusedKeys = new Set<string>();

    for (const row of candidates) {
      const { key, orgCap } = await this.resolveAdmissionKey(row.routing_key);
      if (refusedKeys.has(key)) continue;

      const grant = this.controller.reserve(key, orgCap);
      if (!grant.admitted) {
        refusedKeys.add(key);
        ingestOverflowReplayRefusedTotal.add(1, { reason: grant.reason });
        continue;
      }

      try {
        const res = await this.db
          .updateTable('ingest_overflow_buffer')
          .set({ status: OverflowStatus.enum.replaying, claimed_at: new Date() })
          .where('id', '=', row.id)
          .where('status', '=', OverflowStatus.enum.buffered)
          .executeTakeFirst();
        // Lost the race to another worker (or the row was expired): it is not
        // ours, so do not touch it.
        if (Number(res.numUpdatedRows ?? 0n) === 0) continue;
        await this.replayOne(row);
      } finally {
        grant.release();
      }
    }
  }

  private toDelivery(row: OverflowRow): OverflowDelivery {
    const meta = (row.meta ?? {}) as Partial<OverflowDelivery['meta']>;
    return {
      deliveryId: row.delivery_id,
      routingKey: row.routing_key,
      sourceKind: row.source_kind as OverflowDelivery['sourceKind'],
      provider: row.provider,
      event: row.event,
      action: row.action,
      body: row.body,
      meta: {
        signatureHeaderName: meta.signatureHeaderName ?? null,
        signatureHeader: meta.signatureHeader ?? null,
        clientIp: meta.clientIp ?? null,
        headers: meta.headers ?? {},
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
      },
    };
  }

  private async replayOne(row: OverflowRow): Promise<void> {
    const delivery = this.toDelivery(row);
    const reinject =
      delivery.sourceKind === OverflowSourceKind.enum.relay
        ? this.reinjectRelay
        : this.reinjectDirect;

    if (!reinject) {
      // No re-injector wired for this origin (e.g. a relay row in an entry with
      // no relay path). Revert so it is not stranded in `replaying`.
      await this.revertOrFail(toClaim(row), 'no reinjector for source kind');
      return;
    }

    try {
      const outcome = await reinject(delivery);
      if (outcome === WebhookIngestOutcome.enum.shed) {
        // The drain holds the admission grant for this delivery, so a
        // re-injector that still reports `shed` admitted a second time — a
        // wiring bug, not a capacity refusal, and therefore a genuine failure
        // that consumes an attempt like any other.
        await this.revertOrFail(toClaim(row), 're-shed on replay');
        return;
      }
      // processed | duplicate | skipped are all terminal success — the delivery
      // has passed back through the admission-gated pipeline (dedup claim owns
      // idempotency), so the buffer copy is done.
      await this.db
        .updateTable('ingest_overflow_buffer')
        .set({ status: OverflowStatus.enum.replayed, last_error: null })
        .where('id', '=', row.id)
        .execute();
      ingestOverflowReplayedTotal.add(1);
    } catch (err) {
      await this.revertOrFail(toClaim(row), toErrorMessage(err));
    }
  }

  /**
   * Move a claimed row back to `buffered` (or to `failed` at the attempt
   * ceiling). Every update is conditional on the row still being `replaying`,
   * so a caller whose claim was reclaimed underneath it cannot yank a row a
   * different worker now owns. Returns whether this call moved the row.
   */
  private async revertOrFail(claim: ClaimedRow, reason: string): Promise<boolean> {
    const attempts = claim.attempts + 1;
    const terminal = attempts >= this.maxAttempts;
    const res = await this.db
      .updateTable('ingest_overflow_buffer')
      .set({
        status: terminal ? OverflowStatus.enum.failed : OverflowStatus.enum.buffered,
        replay_attempts: attempts,
        last_error: reason,
        claimed_at: null,
      })
      .where('id', '=', claim.id)
      .where('status', '=', OverflowStatus.enum.replaying)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0n) === 0) return false;

    if (terminal) {
      ingestOverflowDroppedTotal.add(1, { reason: OverflowDropReason.enum.max_attempts });
      // Error, not warn: past the ceiling the delivery is abandoned. It was
      // already acknowledged to the sender on the accept path, so this line is
      // the only place a human learns the work never happened.
      logger.error('ingest-queue delivery abandoned past max attempts', {
        deliveryId: claim.deliveryId,
        attempts,
        reason,
        remedy:
          'inspect the failed row in ingest_overflow_buffer (last_error) and redeliver from the provider',
      });
    }
    return true;
  }

  private async sweepReplayed(): Promise<void> {
    await this.db
      .deleteFrom('ingest_overflow_buffer')
      .where('status', '=', OverflowStatus.enum.replayed)
      .execute();
  }

  private async refreshDepthGauge(): Promise<void> {
    const row = await this.db
      .selectFrom('ingest_overflow_buffer')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', '=', OverflowStatus.enum.buffered)
      .executeTakeFirstOrThrow();
    setIngestOverflowBuffered(Number(row.count));
  }
}
