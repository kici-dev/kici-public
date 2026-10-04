import { describe, it, expect, vi } from 'vitest';
import { OrchRole } from '@kici-dev/engine';
import { PeerDiscoveryMode } from '../config/schema.js';
import {
  DISCOVERED_PEER_IDLE_PRUNE_MS,
  MAX_DISCOVERED_PEER_CLIENTS,
  PeerDiscovery,
  type DiscoveredClientHooks,
  type DiscoveryPeerClient,
} from './peer-discovery.js';

class FakeClient implements DiscoveryPeerClient {
  state = 'disconnected';
  connected = 0;
  disconnected = 0;
  constructor(
    readonly address: string,
    readonly expectedInstanceId: string,
    readonly hooks: DiscoveredClientHooks,
  ) {}
  connect(): void {
    this.connected += 1;
    this.state = 'connecting';
  }
  disconnect(): void {
    this.disconnected += 1;
    this.state = 'disconnected';
  }
  authenticate(): void {
    this.hooks.onAuthenticated();
    this.state = 'connected';
  }
  fail(): void {
    this.state = 'disconnected';
    this.hooks.onMutualAuthFailed();
  }
}

function setup(mode: PeerDiscoveryMode = PeerDiscoveryMode.enum.platform, max?: number) {
  let now = 1_000_000;
  const created: FakeClient[] = [];
  const peerClients = new Map<string, DiscoveryPeerClient>();
  const discovery = new PeerDiscovery({
    mode,
    selfInstanceId: 'self',
    peerClients,
    redialAfterFailureMs: 60_000,
    maxClients: max,
    now: () => now,
    createClient: (address, expectedInstanceId, hooks) => {
      const c = new FakeClient(address, expectedInstanceId, hooks);
      created.push(c);
      return c;
    },
  });
  return {
    discovery,
    created,
    peerClients,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const peer = (instanceId: string, address = `http://${instanceId}:1`) => ({ instanceId, address });

describe('PeerDiscovery', () => {
  it('platform mode dials a new peer with its announced instance id', () => {
    // breaks-if-wrong: the default dials
    const { discovery, created, peerClients } = setup();
    discovery.announce(peer('b'));
    expect(created).toHaveLength(1);
    expect(created[0]!.expectedInstanceId).toBe('b');
    expect(created[0]!.connected).toBe(1);
    expect(peerClients.get('b')).toBe(created[0]);
  });

  it('static mode dials nothing', () => {
    // fails-when: the toggle is ignored
    const { discovery, created } = setup(PeerDiscoveryMode.enum.static);
    discovery.announce(peer('b'));
    expect(created).toHaveLength(0);
  });

  it('ignores workers, itself and announcements without an address or id', () => {
    const { discovery, created } = setup();
    discovery.announce({ ...peer('w'), orchRole: OrchRole.enum.worker });
    discovery.announce(peer('self'));
    discovery.announce({ instanceId: 'x', address: null });
    discovery.announce({ address: 'http://y:1' });
    expect(created).toHaveLength(0);
    // An announced coordinator is dialled.
    discovery.announce({ ...peer('c'), orchRole: OrchRole.enum.coordinator });
    expect(created).toHaveLength(1);
  });

  it('a connected client re-announced at the same address is left alone', () => {
    const { discovery, created } = setup();
    discovery.announce(peer('b'));
    created[0]!.authenticate();
    discovery.announce(peer('b'));
    expect(created).toHaveLength(1);
    expect(created[0]!.disconnected).toBe(0);
  });

  it('an unconnected client is replaced at once', () => {
    const { discovery, created, peerClients } = setup();
    discovery.announce(peer('b'));
    discovery.announce(peer('b', 'http://b-new:1'));
    expect(created).toHaveLength(2);
    expect(created[0]!.disconnected).toBe(1);
    expect(peerClients.get('b')).toBe(created[1]);
  });

  it('a different address does not disconnect a connected client until the candidate authenticates', () => {
    // fails-when: teardown on announcement
    const { discovery, created, peerClients } = setup();
    discovery.announce(peer('b'));
    created[0]!.authenticate();
    discovery.announce(peer('b', 'http://b-moved:1'));
    expect(created).toHaveLength(2);
    expect(created[0]!.disconnected).toBe(0);
    expect(peerClients.get('b')).toBe(created[0]);
    // The same candidate address announced again is not dialled twice.
    discovery.announce(peer('b', 'http://b-moved:1'));
    expect(created).toHaveLength(2);
    created[1]!.authenticate();
    expect(created[0]!.disconnected).toBe(1);
    expect(peerClients.get('b')).toBe(created[1]);
  });

  it('a failing candidate is dropped and the working link stays', () => {
    const { discovery, created, peerClients } = setup();
    discovery.announce(peer('b'));
    created[0]!.authenticate();
    discovery.announce(peer('b', 'http://attacker:1'));
    created[1]!.fail();
    expect(peerClients.get('b')).toBe(created[0]);
    expect(created[0]!.disconnected).toBe(0);
    // The failed address is not dialled again within the window.
    discovery.announce(peer('b', 'http://attacker:1'));
    expect(created).toHaveLength(2);
  });

  it('a target that fails mutual auth is removed and not redialled within the window', () => {
    const { discovery, created, peerClients, advance } = setup();
    discovery.announce(peer('b'));
    created[0]!.fail();
    expect(peerClients.has('b')).toBe(false);
    discovery.announce(peer('b'));
    expect(created).toHaveLength(1);
    advance(60_001);
    discovery.announce(peer('b'));
    expect(created).toHaveLength(2);
  });

  it('announcements past the cap are ignored', () => {
    const { discovery, created } = setup(PeerDiscoveryMode.enum.platform, 2);
    discovery.announce(peer('a'));
    discovery.announce(peer('b'));
    // fails-when: no cap
    discovery.announce(peer('c'));
    expect(created).toHaveLength(2);
  });

  it('the default cap is MAX_DISCOVERED_PEER_CLIENTS', () => {
    const { discovery, created } = setup();
    for (let i = 0; i <= MAX_DISCOVERED_PEER_CLIENTS; i++) discovery.announce(peer(`p${i}`));
    expect(created).toHaveLength(64);
  });

  it('the cap counts pending candidates', () => {
    const { discovery, created } = setup(PeerDiscoveryMode.enum.platform, 2);
    discovery.announce(peer('a'));
    created[0]!.authenticate();
    discovery.announce(peer('a', 'http://a-moved:1')); // candidate: 2 of 2
    discovery.announce(peer('b'));
    expect(created).toHaveLength(2);
  });

  it('static owner: an announcement for a peer held by a static client is ignored', () => {
    const { discovery, created, peerClients } = setup();
    const staticClient = { state: 'connected', connect: vi.fn(), disconnect: vi.fn() };
    peerClients.set('b', staticClient);
    discovery.announce(peer('b'));
    expect(created).toHaveLength(0);
    expect(staticClient.disconnect).not.toHaveBeenCalled();
  });

  it('static owner: releaseToStatic drops a discovered duplicate and its candidate', () => {
    const { discovery, created, peerClients } = setup();
    discovery.announce(peer('b'));
    created[0]!.authenticate();
    discovery.announce(peer('b', 'http://b-moved:1'));
    discovery.releaseToStatic('b');
    expect(created[0]!.disconnected).toBe(1);
    expect(created[1]!.disconnected).toBe(1);
    expect(peerClients.has('b')).toBe(false);
  });

  it('prunes a discovered client not connected for the idle window, never a static one', () => {
    const { discovery, created, peerClients, advance } = setup();
    const staticClient = { state: 'disconnected', connect: vi.fn(), disconnect: vi.fn() };
    peerClients.set('http://s:1', staticClient);
    discovery.announce(peer('b'));
    discovery.announce(peer('c'));
    created[1]!.authenticate();
    advance(DISCOVERED_PEER_IDLE_PRUNE_MS + 1);
    discovery.pruneIdle();
    expect(created[0]!.disconnected).toBe(1); // never connected: pruned
    expect(peerClients.has('b')).toBe(false);
    expect(created[1]!.disconnected).toBe(0); // connected: kept
    expect(staticClient.disconnect).not.toHaveBeenCalled();
  });

  it('does not prune a client inside the idle window', () => {
    // breaks-if-wrong: a peer that is reconnecting must keep its client
    const { discovery, created, advance } = setup();
    discovery.announce(peer('b'));
    advance(DISCOVERED_PEER_IDLE_PRUNE_MS - 1);
    discovery.pruneIdle();
    expect(created[0]!.disconnected).toBe(0);
  });

  it('stop disconnects candidates and clears the timer', () => {
    vi.useFakeTimers();
    try {
      const { discovery, created, advance } = setup();
      discovery.start();
      discovery.announce(peer('a'));
      created[0]!.authenticate();
      discovery.announce(peer('a', 'http://a-moved:1'));
      discovery.announce(peer('b')); // never connects
      discovery.stop();
      expect(created[1]!.disconnected).toBe(1); // the candidate
      advance(DISCOVERED_PEER_IDLE_PRUNE_MS + 1);
      vi.advanceTimersByTime(DISCOVERED_PEER_IDLE_PRUNE_MS);
      expect(created[2]!.disconnected).toBe(0); // no prune ran after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('the timer prunes an idle client while started', () => {
    vi.useFakeTimers();
    try {
      const { discovery, created, advance } = setup();
      discovery.start();
      discovery.announce(peer('b'));
      advance(DISCOVERED_PEER_IDLE_PRUNE_MS + 1);
      vi.advanceTimersByTime(DISCOVERED_PEER_IDLE_PRUNE_MS);
      expect(created[0]!.disconnected).toBe(1);
      discovery.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
