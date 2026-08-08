import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
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
}

/**
 * Background drain for the durable overflow buffer. A pass runs only while the
 * admission controller is NOT shedding (replaying into a still-overloaded
 * orchestrator just re-sheds), claims the oldest `buffered` rows FIFO up to a
 * bounded batch, and re-injects each through the admission-gated ingest path.
 * A re-shed or error reverts the row to `buffered` (never lost); past the
 * max-attempts ceiling it goes `failed`. Successful rows are swept.
 */
export class IngestOverflowReplayer {
  private readonly db: Kysely<Database>;
  private readonly controller: { isShedding(): boolean };
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
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
    // Replay only when capacity has recovered.
    if (this.controller.isShedding()) return;
    this.running = true;
    try {
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
        .set({ status: OverflowStatus.enum.replaying })
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
      await this.revertOrFail(row, 'no reinjector for source kind');
      return;
    }

    try {
      const outcome = await reinject(delivery);
      if (outcome === WebhookIngestOutcome.enum.shed) {
        await this.revertOrFail(row, 're-shed on replay');
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
      await this.revertOrFail(row, toErrorMessage(err));
    }
  }

  private async revertOrFail(row: OverflowRow, reason: string): Promise<void> {
    const attempts = row.replay_attempts + 1;
    if (attempts >= this.maxAttempts) {
      await this.db
        .updateTable('ingest_overflow_buffer')
        .set({
          status: OverflowStatus.enum.failed,
          replay_attempts: attempts,
          last_error: reason,
        })
        .where('id', '=', row.id)
        .execute();
      ingestOverflowDroppedTotal.add(1, { reason: OverflowDropReason.enum.max_attempts });
      logger.warn('overflow delivery failed past max attempts', {
        deliveryId: row.delivery_id,
        attempts,
        reason,
      });
    } else {
      await this.db
        .updateTable('ingest_overflow_buffer')
        .set({
          status: OverflowStatus.enum.buffered,
          replay_attempts: attempts,
          last_error: reason,
        })
        .where('id', '=', row.id)
        .execute();
    }
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
