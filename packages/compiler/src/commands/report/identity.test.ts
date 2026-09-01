import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from '@kici-dev/engine';
import type { ProbeOutcome } from '../doctor.js';
import { collectIdentity } from './identity.js';

function okProbe(over: Record<string, unknown> = {}): ProbeOutcome {
  return {
    ok: true,
    infra: {
      orchestrators: [
        {
          connectionId: 'c1',
          clusterName: 'prod-cluster',
          instanceId: 'i1',
          routingKeys: [],
          connected: true,
          version: '0.1.27',
          mode: 'platform',
          agents: [],
        },
        {
          connectionId: 'c2',
          clusterName: 'edge-cluster',
          instanceId: 'i2',
          routingKeys: [],
          connected: false,
          agents: [],
        },
      ],
      alerts: [],
      ...over,
    },
  } as unknown as ProbeOutcome;
}

describe('collectIdentity', () => {
  it('always reports the client-side context', () => {
    const id = collectIdentity(null);
    expect(id.nodeVersion).toBe(process.version);
    expect(id.platform).toBe(process.platform);
    expect(id.arch).toBe(process.arch);
    expect(id.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(id.kiciCliVersion).toBeTruthy();
  });

  it('explains the gap rather than silently omitting versions when unauthenticated', () => {
    const id = collectIdentity(null);
    expect(id.orchestrators).toEqual([]);
    expect(id.probeError).toMatch(/not authenticated/i);
  });

  it('records the probe failure reason so a reader knows why versions are absent', () => {
    const id = collectIdentity({
      ok: false,
      kind: 'unauthorized',
      message: 'Authentication failed.',
    } as ProbeOutcome);
    expect(id.probeError).toBe('unauthorized: Authentication failed.');
    expect(id.orchestrators).toEqual([]);
  });

  it('folds in every orchestrator the probe saw, not just the first', () => {
    const id = collectIdentity(okProbe());
    expect(id.orchestrators).toHaveLength(2);
    expect(id.orchestrators[0]).toEqual({
      clusterName: 'prod-cluster',
      version: '0.1.27',
      mode: 'platform',
      connected: true,
    });
    expect(id.probeError).toBeUndefined();
  });

  it('normalises a missing orchestrator version to null rather than dropping the entry', () => {
    const id = collectIdentity(okProbe());
    const edge = id.orchestrators.find((o) => o.clusterName === 'edge-cluster');
    expect(edge).toBeDefined();
    expect(edge!.version).toBeNull();
    expect(edge!.connected).toBe(false);
  });

  it('carries the latest-known version when the Platform reported one', () => {
    expect(collectIdentity(okProbe({ latestVersion: '9.9.9' })).latestKnownVersion).toBe('9.9.9');
  });

  it('omits the latest-known version rather than inventing one', () => {
    expect(collectIdentity(okProbe({ latestVersion: null })).latestKnownVersion).toBeUndefined();
    expect(collectIdentity(okProbe()).latestKnownVersion).toBeUndefined();
  });
});
