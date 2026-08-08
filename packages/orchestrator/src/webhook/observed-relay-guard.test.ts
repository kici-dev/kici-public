import { describe, it, expect, vi } from 'vitest';
import { WebhookRelayResult } from '@kici-dev/engine';
import {
  observedRelayVerify,
  observedRelayReject,
  ObservedRelayRefusedError,
  OBSERVED_RELAY_REFUSAL_REASON,
} from './observed-relay-guard.js';

describe('observed relay guard', () => {
  it('verify refuses with rejected_misconfigured and an explanatory reason', () => {
    expect(observedRelayVerify()).toEqual({
      result: WebhookRelayResult.enum.rejected_misconfigured,
      reason: OBSERVED_RELAY_REFUSAL_REASON,
    });
    expect(OBSERVED_RELAY_REFUSAL_REASON).toContain('observed');
  });

  it('reject logs a warning and rejects with ObservedRelayRefusedError', async () => {
    const warn = vi.fn();
    await expect(
      observedRelayReject({ warn }, { routingKey: 'generic:o:s', deliveryId: 'd1' }),
    ).rejects.toBeInstanceOf(ObservedRelayRefusedError);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ routingKey: 'generic:o:s', deliveryId: 'd1' });
  });

  it('names the routing key in the refusal error', async () => {
    await expect(
      observedRelayReject({ warn: () => {} }, { routingKey: 'github:42' }),
    ).rejects.toThrow(/github:42/);
  });
});
