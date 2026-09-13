import { describe, it, expect } from 'vitest';
import {
  fleetLogsRequestSchema,
  fleetBundleChunkSchema,
  fleetBundleErrorSchema,
  orchestratorToAgentMessageSchema,
  agentToOrchestratorMessageSchema,
} from './orchestrator-agent.js';

describe('fleet protocol messages', () => {
  it('parses a fleet.logs.request', () => {
    const m = {
      type: 'fleet.logs.request',
      requestId: 'r1',
      logWindowHours: 4,
      maxBytes: 50_000_000,
    };
    expect(fleetLogsRequestSchema.parse(m)).toEqual(m);
    expect(orchestratorToAgentMessageSchema.parse(m).type).toBe('fleet.logs.request');
  });

  it('parses fleet.bundle.chunk + error in the agent→orch union', () => {
    const c = {
      type: 'fleet.bundle.chunk',
      requestId: 'r1',
      seq: 0,
      isLast: true,
      dataB64: 'AA==',
    };
    expect(agentToOrchestratorMessageSchema.parse(c).type).toBe('fleet.bundle.chunk');
    const e = { type: 'fleet.bundle.error', requestId: 'r1', message: 'boom' };
    expect(fleetBundleErrorSchema.parse(e)).toEqual(e);
    expect(agentToOrchestratorMessageSchema.parse(e).type).toBe('fleet.bundle.error');
  });
});
