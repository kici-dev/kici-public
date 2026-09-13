import { describe, expect, it, vi } from 'vitest';
import { acceptWebhookDelivery, type IngestAcceptDeps } from './ingest-accept.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import type { WebhookInfo } from './handler.js';

const INFO: WebhookInfo = {
  routingKey: 'github:42',
  deliveryId: 'delivery-1',
  event: 'push',
  action: null,
  provider: 'github',
  payload: { ref: 'refs/heads/main' },
};

/**
 * A collector `schedule` so a test can drive the post-acknowledgement work
 * deterministically. `flush()` awaits it; NOT calling `flush()` is how a test
 * asserts that the acknowledgement really did happen without it.
 */
function collector(): { schedule: (w: () => Promise<void>) => void; flush: () => Promise<void> } {
  const queue: Array<() => Promise<void>> = [];
  return {
    schedule: (w) => queue.push(w),
    flush: async () => {
      while (queue.length > 0) await queue.shift()!();
    },
  };
}

function deps(over: Partial<IngestAcceptDeps> = {}): IngestAcceptDeps & {
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  return {
    release,
    admit: vi.fn(async () => release),
    isKnownDelivery: vi.fn(async () => false),
    enqueue: vi.fn(async () => 7),
    claimRow: vi.fn(async () => true),
    markProcessed: vi.fn(async () => {}),
    releaseClaim: vi.fn(async () => true),
    runPipeline: vi.fn(async () => WebhookIngestOutcome.enum.processed),
    ...over,
  } as IngestAcceptDeps & { release: ReturnType<typeof vi.fn> };
}

describe('acceptWebhookDelivery', () => {
  it('acknowledges before the pipeline runs', async () => {
    const c = collector();
    const d = deps({ schedule: c.schedule });

    const outcome = await acceptWebhookDelivery(INFO, d);

    // This is the whole point of the change: the acknowledgement is resolved
    // and the pipeline has not been entered. Against the previous
    // await-the-pipeline route this assertion is impossible to satisfy.
    expect(outcome).toBe(WebhookIngestOutcome.enum.queued);
    expect(d.runPipeline).not.toHaveBeenCalled();

    await c.flush();
    expect(d.runPipeline).toHaveBeenCalledTimes(1);
  });

  it('durably enqueues and claims the row before acknowledging', async () => {
    const order: string[] = [];
    const c = collector();
    const d = deps({
      schedule: c.schedule,
      enqueue: vi.fn(async () => {
        order.push('enqueue');
        return 7;
      }),
      claimRow: vi.fn(async () => {
        order.push('claim');
        return true;
      }),
      runPipeline: vi.fn(async () => {
        order.push('pipeline');
        return WebhookIngestOutcome.enum.processed;
      }),
    });

    await acceptWebhookDelivery(INFO, d);
    // Durability is established at acknowledge time, not afterwards: both the
    // row write and its claim precede the return.
    expect(order).toEqual(['enqueue', 'claim']);

    await c.flush();
    expect(order).toEqual(['enqueue', 'claim', 'pipeline']);
  });

  it('sheds rather than acknowledging when the queue is at capacity', async () => {
    const c = collector();
    const d = deps({ schedule: c.schedule, enqueue: vi.fn(async () => null) });

    const outcome = await acceptWebhookDelivery(INFO, d);

    // Acknowledging a delivery we could not store would convert the old hang
    // into silent data loss, which is strictly worse.
    expect(outcome).toBe(WebhookIngestOutcome.enum.shed);
    await c.flush();
    expect(d.runPipeline).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('reports a known delivery id as a duplicate without writing a row', async () => {
    const d = deps({ isKnownDelivery: vi.fn(async () => true) });

    expect(await acceptWebhookDelivery(INFO, d)).toBe(WebhookIngestOutcome.enum.duplicate);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('sheds when admission rejects, before touching the queue', async () => {
    const d = deps({ admit: vi.fn(async () => null) });

    expect(await acceptWebhookDelivery(INFO, d)).toBe(WebhookIngestOutcome.enum.shed);
    expect(d.isKnownDelivery).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('marks the row processed and releases the admission slot on success', async () => {
    const c = collector();
    const d = deps({ schedule: c.schedule });

    await acceptWebhookDelivery(INFO, d);
    // The slot is held ACROSS the pipeline, so in-flight pipeline concurrency
    // stays bounded exactly as it was when the response waited for it.
    expect(d.release).not.toHaveBeenCalled();

    await c.flush();
    expect(d.markProcessed).toHaveBeenCalledWith(7);
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('hands the claim back for retry when the pipeline throws', async () => {
    const c = collector();
    const d = deps({
      schedule: c.schedule,
      runPipeline: vi.fn(async () => {
        throw new Error('lock file fetch exploded');
      }),
    });

    expect(await acceptWebhookDelivery(INFO, d)).toBe(WebhookIngestOutcome.enum.queued);
    await c.flush();

    // The failure cannot reach the sender, so the row must go back for retry
    // rather than being marked done.
    expect(d.markProcessed).not.toHaveBeenCalled();
    expect(d.releaseClaim).toHaveBeenCalledWith(7, 'lock file fetch exploded');
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('still releases the admission slot when releasing the claim also fails', async () => {
    const c = collector();
    const d = deps({
      schedule: c.schedule,
      runPipeline: vi.fn(async () => {
        throw new Error('pipeline down');
      }),
      releaseClaim: vi.fn(async () => {
        throw new Error('database down');
      }),
    });

    await acceptWebhookDelivery(INFO, d);
    await c.flush();

    // A leaked admission slot would silently shrink ingest capacity for the
    // lifetime of the process; the stranded claim is recovered by the drain
    // pass's reclaim instead.
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('stands down without running the pipeline when the drain pass took the row', async () => {
    const c = collector();
    const d = deps({ schedule: c.schedule, claimRow: vi.fn(async () => false) });

    expect(await acceptWebhookDelivery(INFO, d)).toBe(WebhookIngestOutcome.enum.queued);
    await c.flush();

    // Whoever holds the claim owns the delivery. Running it here too would
    // dispatch the same delivery twice.
    expect(d.runPipeline).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledTimes(1);
  });

  it('runs with no admission controller wired', async () => {
    const c = collector();
    const d = deps({ schedule: c.schedule, admit: vi.fn(async () => undefined) });

    expect(await acceptWebhookDelivery(INFO, d)).toBe(WebhookIngestOutcome.enum.queued);
    await c.flush();
    expect(d.runPipeline).toHaveBeenCalledTimes(1);
  });
});
