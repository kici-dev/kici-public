import { describe, it, expect } from 'vitest';
import { resolveRosterAgentPin, runsOnSelectorsForLockJob } from './dispatch-matched-workflow.js';
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
      runsOnExact: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toEqual({ pinnedAgentId: 'agent-eu-1', connectedInstanceId: 'orch-b' });
  });

  it('returns null when the single label is not a roster host', async () => {
    const store = fakeStore({});
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['role:db'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null for a multi-label runsOn', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['agent-eu-1', 'role:db'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null when a regex pattern is present', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['agent-eu-1'],
      runsOnPatterns: [{ kind: 'regex', source: '^x', flags: '' } as any],
      hostRosterStore: store,
    });
    expect(pin).toBeNull();
  });

  it('returns null when no roster store is configured', async () => {
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: undefined,
    });
    expect(pin).toBeNull();
  });

  it('carries a null connected_instance_id through (offline host)', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: null } });
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    expect(pin).toEqual({ pinnedAgentId: 'agent-eu-1', connectedInstanceId: null });
  });

  it('a resolved pin is meant to clear routing labels at the call site', async () => {
    const store = fakeStore({ 'agent-eu-1': { connected_instance_id: 'orch-b' } });
    const pin = await resolveRosterAgentPin({
      runsOnExact: ['agent-eu-1'],
      runsOnPatterns: [],
      hostRosterStore: store,
    });
    // resolveGeneratedJobConfigs sets runsOnLabels/runsOnPatterns to [] when pin != null.
    expect(pin).not.toBeNull();
  });

  it('pins a host whose agent id carries capitals, taking the raw selector', async () => {
    // The documented inventory fan-out pattern is `runsOn: [h.agentId]`, and an
    // agent id is not a label: `host_roster.agent_id` is case-sensitive. So the
    // pin reads `runsOnExactRaw`, not the folded routing labels beside it.
    const store = fakeStore({ 'Agent-EU-1': { connected_instance_id: 'orch-b' } });
    const sel = runsOnSelectorsForLockJob({
      runsOn: [{ kind: 'exact', value: 'Agent-EU-1' }],
    });

    // The routing labels beside it ARE folded — both halves in one assertion,
    // so a change that folded the raw values would break this test's premise
    // rather than passing quietly.
    expect(sel.runsOnLabels).toEqual(['agent-eu-1']);
    expect(sel.runsOnExactRaw).toEqual(['Agent-EU-1']);

    const pin = await resolveRosterAgentPin({
      runsOnExact: sel.runsOnExactRaw,
      runsOnPatterns: sel.runsOnPatterns,
      hostRosterStore: store,
    });
    expect(pin).toEqual({ pinnedAgentId: 'Agent-EU-1', connectedInstanceId: 'orch-b' });
  });
});
