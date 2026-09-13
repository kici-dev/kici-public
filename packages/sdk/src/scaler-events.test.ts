import { describe, it, expect } from 'vitest';
import {
  SCALER_EVENT_NAMES,
  ScaleDownReason,
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
} from './index.js';

// Imports from './index.js', not from '@kici-dev/engine': the point of these
// tests is that the four symbols reach a workflow author through the SDK
// barrel, which is the only package a workflow file may import.
describe('scaler events on the SDK barrel', () => {
  it('exposes the reserved event names', () => {
    expect(SCALER_EVENT_NAMES.scaleUp).toBe('kici.scaler.scale-up');
    expect(SCALER_EVENT_NAMES.scaleDown).toBe('kici.scaler.scale-down');
  });

  it('parses a scale-up payload and defaults the optional fields', () => {
    const payload = ScalerScaleUpPayload.parse({
      scalerName: 'hetzner',
      agentId: 'agent-1',
      labels: ['default'],
      orchestratorUrl: 'wss://orchestrator/ws',
      claimCode: 'claim-1',
      requestId: 'req-1',
    });
    expect(payload.agentId).toBe('agent-1');
    expect(payload.mandatoryLabels).toEqual([]);
    expect(payload.resources).toEqual({});
  });

  it('parses a scale-down payload and narrows the reason', () => {
    const payload = ScalerScaleDownPayload.parse({
      scalerName: 'hetzner',
      agentId: 'agent-1',
      reason: 'spawn-timeout',
      requestId: 'req-1',
    });
    expect(payload.reason).toBe('spawn-timeout');
    expect(ScaleDownReason.options).toContain('spawn-timeout');
  });

  it('rejects an unknown scale-down reason', () => {
    expect(() =>
      ScalerScaleDownPayload.parse({
        scalerName: 'hetzner',
        agentId: 'agent-1',
        reason: 'exploded',
        requestId: 'req-1',
      }),
    ).toThrow();
  });
});
