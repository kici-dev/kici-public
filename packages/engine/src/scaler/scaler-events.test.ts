import { describe, it, expect } from 'vitest';
import { KICI_EVENT_NAME_PREFIX } from './scaler-backend-type.js';
import {
  ScalerScaleUpPayload,
  ScalerScaleDownPayload,
  SCALER_EVENT_NAMES,
  ScaleDownReason,
} from './scaler-events.js';

describe('scaler-events', () => {
  it('parses a scale-up payload', () => {
    const p = ScalerScaleUpPayload.parse({
      scalerName: 'hetzner',
      agentId: 'a1',
      labels: ['x'],
      resources: {},
      orchestratorUrl: 'wss://h/ws',
      claimCode: 'c1',
      requestId: 'r1',
    });
    expect(p.agentId).toBe('a1');
    expect(p.mandatoryLabels).toEqual([]);
    expect(p.resources).toEqual({});
  });

  it('carries an optional jobId on a scale-up payload', () => {
    const p = ScalerScaleUpPayload.parse({
      scalerName: 'hetzner',
      agentId: 'a1',
      labels: ['x'],
      orchestratorUrl: 'wss://h/ws',
      claimCode: 'c1',
      jobId: 'job-9',
      requestId: 'r1',
    });
    expect(p.jobId).toBe('job-9');
  });

  it('parses a scale-down payload with a known reason', () => {
    const p = ScalerScaleDownPayload.parse({
      scalerName: 'hetzner',
      agentId: 'a1',
      reason: ScaleDownReason.enum['job-complete'],
      requestId: 'r1',
    });
    expect(p.reason).toBe('job-complete');
  });

  it('rejects an unknown scale-down reason', () => {
    expect(() =>
      ScalerScaleDownPayload.parse({
        scalerName: 'hetzner',
        agentId: 'a1',
        reason: 'exploded',
        requestId: 'r1',
      }),
    ).toThrow();
  });

  it('exposes the reserved event names, both under the reserved prefix', () => {
    expect(SCALER_EVENT_NAMES.scaleUp).toBe('kici.scaler.scale-up');
    expect(SCALER_EVENT_NAMES.scaleDown).toBe('kici.scaler.scale-down');
    expect(SCALER_EVENT_NAMES.scaleUp.startsWith(KICI_EVENT_NAME_PREFIX)).toBe(true);
    expect(SCALER_EVENT_NAMES.scaleDown.startsWith(KICI_EVENT_NAME_PREFIX)).toBe(true);
  });
});
