import type { ProviderType } from '@kici-dev/engine';
import type { AdmitResult } from './ingest-admission.js';
import type { WebhookInfo } from './handler.js';
import { WebhookIngestOutcome } from '../pipeline/process-webhook.js';
import type { OverflowDelivery } from './ingest-overflow-types.js';
import type { ReinjectFn } from './ingest-overflow-replayer.js';

/** Verify outcome shape the reinject cares about (subset of VerifyOutcome). */
export interface RelayVerifyResult {
  result: string;
}

/**
 * Collaborator seams for {@link buildRelayReinject}. Injected so the reinject
 * orchestration + payload parsing can be unit-tested without the DB / secret
 * store / provider registry. server.ts wires these to the real subsystems.
 */
export interface RelayReinjectSeams {
  /**
   * Re-admit on the routing key (allowQueue:false — same non-queueing gate the
   * live relay path uses). A re-shed maps the reinject to `shed` so the replayer
   * reverts the row to `buffered`.
   */
  admit: (routingKey: string) => Promise<AdmitResult>;
  /** Re-verify the raw body against the stored headers. */
  verify: (d: OverflowDelivery, body: Buffer) => Promise<RelayVerifyResult>;
  /** Resolve the provider string for a routing key (bundle → prefix fallback). */
  resolveProvider: (routingKey: string) => string;
  /** Process a verified, normalized delivery through the relay ingest pipeline. */
  process: (info: WebhookInfo) => Promise<WebhookIngestOutcome>;
}

/**
 * Parse a captured relay body into a payload object, mirroring the live relay
 * path's content-type handling: JSON (or empty content-type) → parsed object;
 * anything else → `{ rawBody, contentType }`. An empty body is an empty object.
 */
export function parseRelayPayload(
  body: Buffer,
  headers: Record<string, string>,
): Record<string, unknown> {
  const contentType = headers['content-type'] ?? 'application/octet-stream';
  if (contentType.includes('application/json') || contentType === '') {
    return body.length === 0 ? {} : (JSON.parse(body.toString('utf8')) as Record<string, unknown>);
  }
  return { rawBody: body.toString('utf8'), contentType };
}

/**
 * Build the relay-origin overflow re-injector. Re-admits on the routing key,
 * re-verifies the stored raw body (relay deliveries are captured pre-verify),
 * normalizes it, and processes it through the admission-gated relay pipeline.
 * A re-shed maps to `shed` (revert); a verify miss maps to `skipped` (terminal
 * — the delivery is no longer routable, so it is not retried forever).
 */
export function buildRelayReinject(seams: RelayReinjectSeams): ReinjectFn {
  return async (d: OverflowDelivery): Promise<WebhookIngestOutcome> => {
    const admit = await seams.admit(d.routingKey);
    if (!admit.admitted) return WebhookIngestOutcome.enum.shed;
    try {
      const body = Buffer.from(d.body, 'base64');
      const outcome = await seams.verify(d, body);
      if (outcome.result !== 'accepted') return WebhookIngestOutcome.enum.skipped;

      const provider = seams.resolveProvider(d.routingKey);
      const info: WebhookInfo = {
        routingKey: d.routingKey,
        deliveryId: d.deliveryId,
        event: d.event,
        action: d.action,
        provider: provider as ProviderType,
        payload: parseRelayPayload(body, d.meta.headers),
      };
      return await seams.process(info);
    } finally {
      admit.release();
    }
  };
}
