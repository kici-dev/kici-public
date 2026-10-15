import { describe, it, expect, vi } from 'vitest';
import { processWebhook, WebhookIngestOutcome } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

function makeInfo(deliveryId: string): WebhookInfo {
  return {
    routingKey: 'github:999',
    deliveryId,
    event: 'push',
    action: null,
    provider: 'github',
    payload: {},
  };
}

/**
 * No provider bundle, so processWebhook short-circuits to 'skipped' AFTER the
 * claim. db undefined => resolveOrgIdSafe returns '__default__'.
 */
function makeDeps(claim: (id: string) => Promise<boolean>) {
  return {
    dedup: { claim: vi.fn(claim), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    // The unknown-provider warn line reads `getRoutingKeys` to name what WAS registered.
    providerRegistry: { getByRoutingKey: () => undefined, getRoutingKeys: () => [] },
  } as unknown as Parameters<typeof processWebhook>[1];
}

describe('processWebhook dedup outcome', () => {
  it('returns "duplicate" when the atomic claim loses', async () => {
    const deps = makeDeps(async () => false);
    const out = await processWebhook(makeInfo('dup-1'), deps);
    expect(out).toBe(WebhookIngestOutcome.enum.duplicate);
  });

  it('claims first, then returns "skipped" for an unknown provider (no double-claim)', async () => {
    const claim = vi.fn(async () => true);
    const deps = makeDeps(claim);
    const out = await processWebhook(makeInfo('new-1'), deps);
    expect(out).toBe(WebhookIngestOutcome.enum.skipped);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
