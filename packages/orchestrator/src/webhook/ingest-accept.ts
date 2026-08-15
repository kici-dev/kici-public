import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { WebhookInfo } from './handler.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import { webhookPipelineFailuresTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'orch:ingest-accept' });

/**
 * Seams the accept path needs. Each is a narrow function rather than the
 * concrete collaborator so the sequencing below can be driven in a unit test
 * without a database, an admission controller, or a pipeline.
 */
export interface IngestAcceptDeps {
  /**
   * Reserve an admission slot. Resolves to a release function when admitted, to
   * `null` when the controller shed, or to `undefined` when no controller is
   * wired (tests / minimal wirings — no gate).
   */
  admit: () => Promise<(() => void) | null | undefined>;
  /**
   * Advisory duplicate probe. Non-claiming: the atomic claim stays inside the
   * pipeline, where it has always been. See {@link acceptWebhookDelivery}.
   */
  isKnownDelivery: (deliveryId: string) => Promise<boolean>;
  /** Durably store the delivery; resolves to the row id, or null at the cap. */
  enqueue: (info: WebhookInfo) => Promise<number | null>;
  /** Take the row's claim (`buffered` → `replaying`). False when someone else has it. */
  claimRow: (rowId: number) => Promise<boolean>;
  /** Mark the row done so the drain pass sweeps it. */
  markProcessed: (rowId: number) => Promise<void>;
  /** Hand the claim back on failure so the drain pass retries the delivery. */
  releaseClaim: (rowId: number, reason: string) => Promise<boolean>;
  /** Run the match-and-dispatch pipeline. */
  runPipeline: (info: WebhookInfo) => Promise<WebhookIngestOutcome>;
  /**
   * Schedule the post-acknowledgement work. Defaults to a detached microtask;
   * a test passes a collector so it can await the work deterministically.
   */
  schedule?: (work: () => Promise<void>) => void;
}

/**
 * Detached by default: the caller must not await the pipeline. The `catch` is
 * load-bearing, not defensive tidiness — a detached rejection with no handler
 * reaches the process-level unhandled-rejection path, and losing the whole
 * orchestrator over one bad delivery is a strictly worse failure than the one
 * this change removes.
 */
function detach(work: () => Promise<void>): void {
  void work().catch((err: unknown) => {
    logger.error('queued webhook worker rejected outside its own handler', {
      error: toErrorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}

/**
 * Accept an inbound delivery and run its pipeline afterwards.
 *
 * The acknowledgement a caller receives means **the delivery is durably
 * queued**, not that it was matched or dispatched. That is the whole point: a
 * provider's delivery attempt times out in seconds (GitHub's is 10), while one
 * matched workflow's build phase alone may legitimately take ten minutes, so a
 * response that waited for the pipeline turned a slow build into a failed
 * delivery for work that usually succeeded.
 *
 * Ordering is load-bearing and each step earns its place:
 *
 * 1. **Admit.** A shed delivery never reaches the queue, so admission stays the
 *    first gate and a saturated orchestrator still answers 429 immediately.
 * 2. **Probe for a duplicate.** Advisory only — a redelivery the orchestrator
 *    already knows about is reported as one without a row being written. The
 *    *authoritative* claim is still the pipeline's atomic
 *    `INSERT … ON CONFLICT`, so a genuine cross-instance race is arbitrated
 *    exactly where it always was; the loser simply learns after acknowledging.
 * 3. **Enqueue durably.** Nothing is acknowledged before this row exists. At the
 *    row cap the delivery is shed rather than acknowledged — answering 202 for
 *    a delivery we did not store would turn a hang into silent data loss, which
 *    is strictly worse than the hang this change removes.
 * 4. **Claim the row**, then acknowledge, then run the pipeline detached. The
 *    claim is what stops the drain pass re-injecting a delivery already in
 *    flight; releasing it on failure is what makes the row a retry rather than
 *    a tombstone. The admission slot is held across the pipeline, so in-flight
 *    pipeline concurrency stays bounded exactly as it was when the response
 *    waited for it.
 *
 * Returns `queued` on the acknowledge path, or `duplicate` / `shed` for the two
 * pre-queue exits.
 */
export async function acceptWebhookDelivery(
  info: WebhookInfo,
  deps: IngestAcceptDeps,
): Promise<WebhookIngestOutcome> {
  const schedule = deps.schedule ?? detach;

  const release = await deps.admit();
  if (release === null) return WebhookIngestOutcome.enum.shed;

  let handedOff = false;
  try {
    if (await deps.isKnownDelivery(info.deliveryId)) {
      return WebhookIngestOutcome.enum.duplicate;
    }

    const rowId = await deps.enqueue(info);
    if (rowId === null) {
      // The queue is at its cap. Shed rather than acknowledge: the sender can
      // redeliver, and a 429 is the one honest answer for work we did not take.
      logger.warn('ingest queue at capacity — shedding rather than acknowledging', {
        deliveryId: info.deliveryId,
        routingKey: info.routingKey,
        event: info.event,
        remedy: 'raise KICI_INGEST_OVERFLOW_MAX or drain the backlog; the sender must redeliver',
      });
      return WebhookIngestOutcome.enum.shed;
    }

    if (!(await deps.claimRow(rowId))) {
      // A drain pass beat us to our own row. It owns the delivery now, so the
      // work still happens — acknowledge and stay out of its way.
      return WebhookIngestOutcome.enum.queued;
    }

    handedOff = true;
    schedule(() => runQueuedDelivery(info, rowId, deps, release ?? undefined));
    return WebhookIngestOutcome.enum.queued;
  } finally {
    // The background worker owns the slot once the hand-off happened; every
    // other exit releases here.
    if (!handedOff) release?.();
  }
}

/**
 * Run the pipeline for an already-acknowledged delivery, then settle its row.
 *
 * Nothing this function decides can reach the sender — the response is long
 * gone — so every outcome has to land somewhere a human or a test can find it:
 * the event log carries the per-delivery record (the pipeline writes a `failed`
 * row on a throw), this function emits one structured line naming the delivery
 * and a remedy, and the queue row itself either clears or reverts to `buffered`
 * for the drain pass to retry.
 */
async function runQueuedDelivery(
  info: WebhookInfo,
  rowId: number,
  deps: IngestAcceptDeps,
  release: (() => void) | undefined,
): Promise<void> {
  try {
    await deps.runPipeline(info);
    await deps.markProcessed(rowId);
  } catch (err) {
    const message = toErrorMessage(err);
    webhookPipelineFailuresTotal.add(1, { phase: 'post_ack' });
    // The delivery was already acknowledged, so this line is the sender-facing
    // failure that never got sent. Log it aggregated and self-describing —
    // delivery, routing key, event, and where to look next.
    logger.error('webhook pipeline failed after the delivery was acknowledged', {
      deliveryId: info.deliveryId,
      routingKey: info.routingKey,
      event: info.event,
      action: info.action,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
      remedy:
        'the delivery is queued for retry in ingest_overflow_buffer; the event log carries a failed row for this deliveryId',
    });
    try {
      await deps.releaseClaim(rowId, message);
    } catch (releaseErr) {
      // The claim is now stranded. The drain pass reclaims it once the claim
      // timeout elapses, so this degrades to a delay rather than a loss.
      logger.error('failed to release an ingest-queue claim after a pipeline failure', {
        deliveryId: info.deliveryId,
        rowId,
        error: toErrorMessage(releaseErr),
        remedy: 'the drain pass reclaims the row once ingest_overflow_claim_timeout_ms elapses',
      });
    }
  } finally {
    release?.();
  }
}
