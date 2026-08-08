/**
 * Client-side half of the `observed`-mode "no relay, ever" guarantee.
 *
 * An `observed` orchestrator ingests only its OWN webhooks — providers post
 * straight to its public URL and nothing transits the hosted Platform. The
 * Platform never selects an observed connection as a relay target, so a relay
 * reaching one is a defect somewhere upstream. These handlers make that case
 * loud and inert instead of silently processing the payload.
 */

import { WebhookRelayResult } from '@kici-dev/engine';

/** Thrown when a Platform relay reaches an observed-mode orchestrator. */
export class ObservedRelayRefusedError extends Error {
  constructor(routingKey: string) {
    super(`observed-mode orchestrator refuses relayed webhook for routing key ${routingKey}`);
    this.name = 'ObservedRelayRefusedError';
  }
}

/** Reason string returned on both the verify and the refusal paths. */
export const OBSERVED_RELAY_REFUSAL_REASON =
  'orchestrator is in observed mode and does not accept Platform-relayed webhooks';

/** Minimal logger surface the guard needs (keeps the module test-friendly). */
type WarnLogger = { warn: (message: string, meta?: Record<string, unknown>) => void };

/**
 * `onVerifyInbound` for observed mode: refuse every relayed webhook at verify
 * time, so the Platform gets a definitive `rejected_misconfigured` ack instead
 * of a timeout.
 */
export function observedRelayVerify(): {
  result: WebhookRelayResult;
  reason: string;
} {
  return {
    result: WebhookRelayResult.enum.rejected_misconfigured,
    reason: OBSERVED_RELAY_REFUSAL_REASON,
  };
}

/**
 * `onWebhookRelay` for observed mode: log loudly and reject so nothing is
 * processed. Rejecting (rather than returning) keeps the failure visible in the
 * Platform client's relay error path.
 */
export function observedRelayReject(
  logger: WarnLogger,
  meta: { routingKey: string; deliveryId?: string },
): Promise<void> {
  logger.warn('Refused a Platform relay in observed mode', {
    routingKey: meta.routingKey,
    deliveryId: meta.deliveryId,
  });
  return Promise.reject(new ObservedRelayRefusedError(meta.routingKey));
}
