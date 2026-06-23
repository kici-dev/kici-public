import { describe, it, expect } from 'vitest';
import { resolveRosterAgentPin } from './dispatch-matched-workflow.js';
import type { HostRosterStore } from '../agent/host-roster.js';

function fakeStore(
  rows: Record<string, { connected_instance_id: string | null }>,
): HostRosterStore {
  return {
    get: async (agentId: string) => (rows[agentId] ? (rows[agentId] as any) : null),
  } as unknown as HostRosterStore;
}

describe('resolveRosterAgentPin', () => {
  it('resolves a single exact label matching a roster host to a pin', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: 'orch-b' } });
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toEqual({ pinnedAgentId: 'agent-eu-1', connectedInstanceId: 'orch-b' });
  });

  it('returns null when the single label is not a roster host', async () => {
    const store = fakeStore({});
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['role:db'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null for a multi-label runsOn', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1', 'role:db'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null when a regex pattern is present', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1'],
      runsOnPatterns: [{ kind: 'regex', source: '^x', flags: '' } as any],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null when no roster store is configured', async () => {
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: undefined,
    });
    expect(pin).toBeNull();
  });

  it('carries a null connected_instance_id through (offline host)', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toEqual({ pinnedAgentId: 'agent-eu-1', connectedInstanceId: null });
  });

  it('a resolved pin is meant to clear routing labels at the call site', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: 'orch-b' } });
    const pin = await resolveRosterAgentPin({
      runsOnLabels: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    // resolveGeneratedJobConfigs sets runsOnLabels/runsOnPatterns to [] when pin != null.
    expect(pin).not.toBeNull();
  });
});
