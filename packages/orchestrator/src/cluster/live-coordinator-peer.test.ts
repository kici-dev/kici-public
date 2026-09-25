import { describe, expect, it } from 'vitest';
import { PeerRegistry } from './peer-registry.js';
import { hasLiveCoordinatorPeer } from './live-coordinator-peer.js';

const GRACE_MS = 120_000;

function registryWith(role: 'coordinator' | 'worker'): PeerRegistry {
  const registry = new PeerRegistry({});
  registry.addPeer({
    instanceId: 'peer-1',
    connectionId: 'c1',
    address: null,
    routingKeys: [],
    role,
  });
  return registry;
}

describe('hasLiveCoordinatorPeer', () => {
  it('counts a connected coordinator peer', () => {
    expect(hasLiveCoordinatorPeer(registryWith('coordinator'), Date.now(), GRACE_MS)).toBe(true);
  });

  it('keeps counting a coordinator peer through a link blip inside the flap grace', () => {
    const registry = registryWith('coordinator');
    registry.markDisconnected('peer-1');
    // fails-when: a momentary disconnect reads as no peer, failing jobs a peer could open
    expect(hasLiveCoordinatorPeer(registry, Date.now(), GRACE_MS)).toBe(true);
  });

  it('stops counting a coordinator peer gone longer than the flap grace', () => {
    const registry = registryWith('coordinator');
    registry.markDisconnected('peer-1');
    // breaks-if-wrong: a coordinator whose peer is really gone must be treated as alone
    expect(hasLiveCoordinatorPeer(registry, Date.now() + GRACE_MS + 1, GRACE_MS)).toBe(false);
  });

  it('never counts a worker peer', () => {
    expect(hasLiveCoordinatorPeer(registryWith('worker'), Date.now(), GRACE_MS)).toBe(false);
  });

  it('counts no peer on a single node', () => {
    expect(hasLiveCoordinatorPeer(new PeerRegistry({}), Date.now(), GRACE_MS)).toBe(false);
  });
});
