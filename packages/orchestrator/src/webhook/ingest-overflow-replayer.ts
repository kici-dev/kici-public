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
  setIngestOverflowBuffered,
} from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'orch:ingest-overflow-replayer' });

export type ReinjectFn = (d: OverflowDelivery) => Promise<WebhookIngestOutcome>;

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
  controller: { isShedding(): boolean };
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  /**
   * How long a `replaying` claim may stand before it is reclaimed. Resolved per
   * pass so a fleet-wide `cluster_settings` override takes effect without a
   * restart; the number passed here is the configured cluster default.
   */
  claimTimeoutMs: number;
  /** Fleet-wide override reader for {@link IngestOverflowReplayerDeps.claimTimeoutMs}. */
  clusterSettings?: ClusterSettingsReader;
}

/**
 * Background drain for the durable ingest queue. Each pass first reclaims rows
 * whose `replaying` claim went stale — a worker killed mid-pipeline releases
 * nothing, so without this its delivery would sit claimed forever and the
 * durable row it acknowledged would never be worth anything. It then claims the
 * oldest `buffered` rows FIFO up to a bounded batch and re-injects each through
 * the admission-gated ingest path. A re-shed or error reverts the row to
 * `buffered` (never lost); past the max-attempts ceiling it goes `failed`.
 * Successful rows are swept.
 *
 * Re-injection runs only while the admission controller is NOT shedding
 * (replaying into a still-overloaded orchestrator just re-sheds). Reclaiming is
 * not gated that way: a stranded claim is stranded regardless of load, and the
 * row it frees simply waits in `buffered` until capacity returns.
 */
export class IngestOverflowReplayer {
  private readonly db: Kysely<Database>;
  private readonly controller: { isShedding(): boolean };
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly claimTimeoutMs: number;
  private readonly clusterSettings: ClusterSettingsReader | undefined;
  private reinjectDirect: ReinjectFn | undefined;
  private reinjectRelay: ReinjectFn | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopped = false;

  constructor(deps: IngestOverflowReplayerDeps) {
    this.db = deps.db;
    this.controller = deps.controller;
    this.intervalMs = deps.intervalMs;
    this.batchSize = deps.batchSize;
    this.maxAttempts = deps.maxAttempts;
    this.claimTimeoutMs = deps.claimTimeoutMs;
    this.clusterSettings = deps.clusterSettings;
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
      // Replay only when capacity has recovered.
      if (this.controller.isShedding()) return;
      const claimed = await this.claimBatch();
      for (const row of claimed) {
        await this.replayOne(row);
      }
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
    const cutoff = new Date(Date.now() - timeoutMs);

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

  /** Select the oldest buffered rows and claim each via a conditional update. */
  private async claimBatch(): Promise<OverflowRow[]> {
    const candidates = (await this.db
      .selectFrom('ingest_overflow_buffer')
      .selectAll()
      .where('status', '=', OverflowStatus.enum.buffered)
      .orderBy('captured_at', 'asc')
      .limit(this.batchSize)
      .execute()) as unknown as OverflowRow[];

    const claimed: OverflowRow[] = [];
    for (const c of candidates) {
      const res = await this.db
        .updateTable('ingest_overflow_buffer')
        .set({ status: OverflowStatus.enum.replaying, claimed_at: new Date() })
        .where('id', '=', c.id)
        .where('status', '=', OverflowStatus.enum.buffered)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows ?? 0n) > 0) claimed.push(c);
    }
    return claimed;
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
