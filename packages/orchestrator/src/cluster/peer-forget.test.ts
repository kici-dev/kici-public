import { describe, expect, it, vi, type Mock } from 'vitest';
import { PeerForgetOutcome } from '@kici-dev/engine';
import { PeerRegistry } from './peer-registry.js';
import {
  disconnectedCoordinatorIds,
  forgetAcrossCoordinators,
  forgetDepartedPeer,
  PEER_FORGET_TIMEOUT,
  PEER_FORGET_UNHANDLED,
  peerForgetGuards,
  peerLivenessWindow,
  PeerLivenessWindowKind,
  replyToPeerForgetRequest,
  type PeerForgetGuards,
  type PeerLivenessSource,
  type SendPeerForget,
} from './peer-forget.js';

const SELF = 'coord-a';

/** Guards for a forget two minutes after every peer was last heard from: past the window, no backstop. */
const PAST: PeerForgetGuards = {
  liveness: { kind: PeerLivenessWindowKind.enum['stale-window'], windowMs: 60_000 },
  backstop: null,
  acknowledgeBackstop: false,
  nowMs: Date.now() + 120_000,
};

function registry(): PeerRegistry {
  const peers = new PeerRegistry();
  for (const [instanceId, role] of [
    ['coord-b', 'coordinator'],
    ['coord-c', 'coordinator'],
    ['worker-1', 'worker'],
  ] as const) {
    peers.addPeer({
      instanceId,
      connectionId: `conn-${instanceId}`,
      address: null,
      routingKeys: [],
      role,
    });
  }
  return peers;
}

describe('forgetDepartedPeer', () => {
  it('drops a disconnected peer from the registry', () => {
    const peers = registry();
    peers.markDisconnected('coord-b');

    expect(forgetDepartedPeer(peers, SELF, 'coord-b', PAST).outcome).toBe(
      PeerForgetOutcome.enum.forgotten,
    );
    expect(peers.getPeer('coord-b')).toBeUndefined();
  });

  // breaks-if-wrong: a connected peer is never forgotten
  it('refuses a connected peer, naming it, and keeps it', () => {
    const peers = registry();

    const result = forgetDepartedPeer(peers, SELF, 'coord-c', PAST);

    expect(result.outcome).toBe(PeerForgetOutcome.enum.connected);
    expect(result.detail).toContain('coord-c');
    expect(peers.getPeer('coord-c')).toBeDefined();
  });

  it('reports an unknown id as not-found', () => {
    const result = forgetDepartedPeer(registry(), SELF, 'nope', PAST);
    expect(result).toEqual({
      outcome: PeerForgetOutcome.enum['not-found'],
      detail: "nope is not in this coordinator's peer registry",
    });
  });

  it('refuses this coordinator itself', () => {
    expect(forgetDepartedPeer(registry(), SELF, SELF, PAST).outcome).toBe(
      PeerForgetOutcome.enum.error,
    );
  });
});

describe('forgetAcrossCoordinators', () => {
  /** coord-b departed; coord-c and coord-d are connected siblings; worker-1 is a worker. */
  function cluster(): PeerRegistry {
    const peers = registry();
    peers.addPeer({
      instanceId: 'coord-d',
      connectionId: 'conn-coord-d',
      address: null,
      routingKeys: [],
      role: 'coordinator',
    });
    peers.markDisconnected('coord-b');
    return peers;
  }

  const answer =
    (outcome: PeerForgetOutcome, detail = 'ok'): SendPeerForget =>
    async (_sibling, msg) => ({
      type: 'peer.forget.response',
      messageId: msg.messageId,
      outcome,
      detail,
    });

  // fails-when: a connected sibling coordinator is never asked, so it keeps the departed peer
  it('forgets here first, then asks every connected sibling coordinator and nothing else', async () => {
    const peers = cluster();
    const send = vi.fn(answer(PeerForgetOutcome.enum.forgotten));

    const results = await forgetAcrossCoordinators(peers, SELF, 'coord-b', 5_000, PAST, send);

    expect(peers.getPeer('coord-b')).toBeUndefined();
    expect(send.mock.calls.map(([sibling]) => sibling).sort()).toEqual(['coord-c', 'coord-d']);
    for (const [, msg, timeoutMs] of send.mock.calls) {
      expect(msg).toMatchObject({ type: 'peer.forget.request', instanceId: 'coord-b' });
      expect(timeoutMs).toBe(5_000);
    }
    expect(new Set(send.mock.calls.map(([, msg]) => msg.messageId)).size).toBe(2);
    expect(results.map((r) => [r.coordinator, r.outcome])).toEqual([
      [SELF, PeerForgetOutcome.enum.forgotten],
      ['coord-c', PeerForgetOutcome.enum.forgotten],
      ['coord-d', PeerForgetOutcome.enum.forgotten],
    ]);
  });

  // breaks-if-wrong: a peer this coordinator still has connected is refused and never fanned out
  it('refuses a peer connected here without asking any sibling', async () => {
    const peers = cluster();
    const send = vi.fn(answer(PeerForgetOutcome.enum.forgotten));

    const results = await forgetAcrossCoordinators(peers, SELF, 'coord-c', 5_000, PAST, send);

    expect(results).toEqual([
      expect.objectContaining({ coordinator: SELF, outcome: PeerForgetOutcome.enum.connected }),
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(peers.getPeer('coord-c')).toBeDefined();
  });

  it('still asks the siblings about a peer unknown here', async () => {
    const send = vi.fn(answer(PeerForgetOutcome.enum.forgotten));

    const results = await forgetAcrossCoordinators(cluster(), SELF, 'coord-x', 5_000, PAST, send);

    expect(results[0]!.outcome).toBe(PeerForgetOutcome.enum['not-found']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports a sibling that cannot be reached, or does not answer, as an error', async () => {
    const send: SendPeerForget = async (sibling) =>
      sibling === 'coord-c' ? null : PEER_FORGET_TIMEOUT;

    const results = await forgetAcrossCoordinators(cluster(), SELF, 'coord-b', 1_000, PAST, send);

    expect(results.slice(1)).toEqual([
      {
        coordinator: 'coord-c',
        outcome: PeerForgetOutcome.enum.error,
        detail: 'no connection reached this coordinator',
      },
      {
        coordinator: 'coord-d',
        outcome: PeerForgetOutcome.enum.error,
        detail: expect.stringContaining('no answer within 1000 ms'),
      },
    ]);
  });
});

describe('disconnectedCoordinatorIds', () => {
  it('lists the disconnected coordinators, never workers or the coordinator itself', () => {
    const peers = registry();
    peers.markDisconnected('coord-b');
    peers.markDisconnected('worker-1');

    expect(disconnectedCoordinatorIds(peers, SELF)).toEqual(['coord-b']);
  });

  // fails-when: a forgotten coordinator is still reported missing
  it('no longer lists a coordinator once it is forgotten', () => {
    const peers = registry();
    peers.markDisconnected('coord-b');
    forgetDepartedPeer(peers, SELF, 'coord-b', PAST);

    expect(disconnectedCoordinatorIds(peers, SELF)).toEqual([]);
  });
});

describe('forget guards', () => {
  /** coord-b, the only coordinator peer, silent since `heardAt`; no connected coordinator. */
  function lone(heardAt: number): PeerRegistry {
    const peers = new PeerRegistry();
    peers.addPeer({
      instanceId: 'coord-b',
      connectionId: 'conn-b',
      address: null,
      routingKeys: [],
      role: 'coordinator',
    });
    peers.markDisconnected('coord-b');
    peers.getPeer('coord-b')!.lastHeartbeatAt = heardAt;
    return peers;
  }
  const now = 1_800_000_000_000;

  // fails-when: a peer heard from inside the stale window is forgotten
  it('keeps a peer heard from inside the stale window, naming when', () => {
    const peers = lone(now - 30_000);
    const result = forgetDepartedPeer(peers, SELF, 'coord-b', {
      ...PAST,
      nowMs: now,
    });
    expect(result.outcome).toBe(PeerForgetOutcome.enum.recent);
    expect(result.detail).toContain('coord-b was last heard from 30 s ago');
    expect(result.detail).toContain(new Date(now - 30_000).toISOString());
    expect(result.detail).toContain('the 60 s stale window');
    expect(peers.getPeer('coord-b')).toBeDefined();
  });

  // breaks-if-wrong: a peer silent past the window is still forgotten
  it('forgets a peer silent past the stale window', () => {
    const peers = lone(now - 61_000);
    expect(forgetDepartedPeer(peers, SELF, 'coord-b', { ...PAST, nowMs: now }).outcome).toBe(
      PeerForgetOutcome.enum.forgotten,
    );
  });

  // fails-when: forgetting the last known coordinator switches the backstop on unacknowledged
  it('keeps the last known coordinator until the backstop consequence is acknowledged', () => {
    const peers = lone(now - 61_000);
    const guards = { ...PAST, nowMs: now, backstop: { configuredPeerCount: 0 } };

    const refused = forgetDepartedPeer(peers, SELF, 'coord-b', guards);
    expect(refused.outcome).toBe(PeerForgetOutcome.enum['acknowledgement-required']);
    expect(refused.detail).toContain('event-provision backstop back on');
    expect(peers.getPeer('coord-b')).toBeDefined();

    expect(
      forgetDepartedPeer(peers, SELF, 'coord-b', { ...guards, acknowledgeBackstop: true }).outcome,
    ).toBe(PeerForgetOutcome.enum.forgotten);
  });

  // breaks-if-wrong: a forget with no backstop impact needs no acknowledgement
  it('needs no acknowledgement when the backstop stays as it is', () => {
    // Another coordinator is still known: the backstop stays off either way.
    const peers = lone(now - 61_000);
    peers.addPeer({
      instanceId: 'coord-c',
      connectionId: 'conn-c',
      address: null,
      routingKeys: [],
      role: 'coordinator',
    });
    peers.markDisconnected('coord-c');
    const guards = { ...PAST, nowMs: now, backstop: { configuredPeerCount: 0 } };
    expect(forgetDepartedPeer(peers, SELF, 'coord-b', guards).outcome).toBe(
      PeerForgetOutcome.enum.forgotten,
    );
    // A configured peer list keeps the backstop off too (independent mode).
    const configured = lone(now - 61_000);
    expect(
      forgetDepartedPeer(configured, SELF, 'coord-b', {
        ...guards,
        backstop: { configuredPeerCount: 1 },
      }).outcome,
    ).toBe(PeerForgetOutcome.enum.forgotten);
    // And a coordinator that runs no backstop never asks.
    expect(
      forgetDepartedPeer(lone(now - 61_000), SELF, 'coord-b', { ...guards, backstop: null })
        .outcome,
    ).toBe(PeerForgetOutcome.enum.forgotten);
  });

  it('does not fan a locally refused forget out, and forwards the acknowledgement', async () => {
    const send = vi.fn<SendPeerForget>(async (sibling, msg) => ({
      type: 'peer.forget.response',
      messageId: msg.messageId,
      outcome: PeerForgetOutcome.enum.forgotten,
      detail: sibling,
    }));
    const peers = lone(now - 30_000);
    peers.addPeer({
      instanceId: 'coord-c',
      connectionId: 'conn-c',
      address: null,
      routingKeys: [],
      role: 'coordinator',
    });
    const recent = await forgetAcrossCoordinators(
      peers,
      SELF,
      'coord-b',
      1_000,
      { ...PAST, nowMs: now },
      send,
    );
    expect(recent.map((r) => r.outcome)).toEqual([PeerForgetOutcome.enum.recent]);
    expect(send).not.toHaveBeenCalled();

    await forgetAcrossCoordinators(
      peers,
      SELF,
      'coord-b',
      1_000,
      { ...PAST, nowMs: now + 60_000, acknowledgeBackstop: true },
      send,
    );
    expect(send).toHaveBeenCalledWith(
      'coord-c',
      expect.objectContaining({ instanceId: 'coord-b', acknowledgeBackstop: true }),
      1_000,
    );
  });
});

describe('peer liveness window', () => {
  const STALE = 60_000;
  /** What a coordinator reads: the reroute flap grace, and a backstop reading `adopters` (or none). */
  function source(
    rerouteFlapGraceMs: number,
    adopters: string[] | null,
  ): PeerLivenessSource & { backstop: { holdsAdoptedProvisions: Mock } | null } {
    return {
      staleTimeoutMs: STALE,
      rerouteFlapGraceMs: vi.fn(async () => rerouteFlapGraceMs),
      backstop: adopters
        ? { holdsAdoptedProvisions: vi.fn(async (id: string) => adopters.includes(id)) }
        : null,
    };
  }

  it('gives a peer that adopted provisions the backstop flap grace, floored at two stale windows', async () => {
    // fails-when: an adopter gets the plain stale window
    expect(await peerLivenessWindow('coord-b', source(120_000, ['coord-b']))).toEqual({
      kind: PeerLivenessWindowKind.enum['adopter-grace'],
      windowMs: 120_000,
    });
    // A lowered setting does not lower the grace below the backstop's own floor.
    expect((await peerLivenessWindow('coord-b', source(30_000, ['coord-b']))).windowMs).toBe(
      2 * STALE,
    );
    // A raised setting is honoured as-is, as the backstop honours it.
    expect((await peerLivenessWindow('coord-b', source(300_000, ['coord-b']))).windowMs).toBe(
      300_000,
    );
  });

  it('gives any other peer the reroute flap grace when it is longer than the stale window', async () => {
    // fails-when: a non-adopter gets only the stale window under the default grace
    expect(await peerLivenessWindow('coord-c', source(120_000, ['coord-b']))).toEqual({
      kind: PeerLivenessWindowKind.enum['reroute-grace'],
      windowMs: 120_000,
    });
    // A raised setting raises the window.
    expect((await peerLivenessWindow('coord-c', source(300_000, []))).windowMs).toBe(300_000);
    // A coordinator that runs no backstop still applies the grace, and never reads adoption.
    expect(await peerLivenessWindow('coord-b', source(120_000, null))).toEqual({
      kind: PeerLivenessWindowKind.enum['reroute-grace'],
      windowMs: 120_000,
    });
  });

  it('gives any other peer the stale window when the grace is shorter', async () => {
    // breaks-if-wrong: a grace lowered below the stale window does not shrink it
    expect(await peerLivenessWindow('coord-c', source(30_000, []))).toEqual({
      kind: PeerLivenessWindowKind.enum['stale-window'],
      windowMs: STALE,
    });
  });

  describe('forgetting against the window', () => {
    const now = 1_800_000_000_000;
    /** coord-b, silent since `heardAt`, beside a connected coord-c so the backstop guard stays out. */
    function silent(heardAt: number): PeerRegistry {
      const peers = registry();
      peers.markDisconnected('coord-b');
      peers.getPeer('coord-b')!.lastHeartbeatAt = heardAt;
      return peers;
    }
    async function forget(peers: PeerRegistry, src: PeerLivenessSource) {
      const guards = await peerForgetGuards(
        'coord-b',
        { peerStaleTimeoutMs: STALE, peers: [] },
        src,
        false,
      );
      return forgetDepartedPeer(peers, SELF, 'coord-b', { ...guards, nowMs: now });
    }

    // fails-when: a peer that adopted provisions, last heard 90 s ago, is forgotten
    it('keeps a peer that adopted provisions inside the backstop grace, naming the grace', async () => {
      const peers = silent(now - 90_000);
      const result = await forget(peers, source(120_000, ['coord-b']));
      expect(result.outcome).toBe(PeerForgetOutcome.enum.recent);
      expect(result.detail).toContain('coord-b was last heard from 90 s ago');
      expect(result.detail).toContain(new Date(now - 90_000).toISOString());
      expect(result.detail).toContain(
        'the 120 s grace the event-provision backstop gives a peer that adopted provisions',
      );
      expect(peers.getPeer('coord-b')).toBeDefined();
    });

    // breaks-if-wrong: the same peer past its grace is forgotten
    it('forgets a peer that adopted provisions once its grace has passed', async () => {
      const peers = silent(now - 121_000);
      expect((await forget(peers, source(120_000, ['coord-b']))).outcome).toBe(
        PeerForgetOutcome.enum.forgotten,
      );
      expect(peers.getPeer('coord-b')).toBeUndefined();
    });

    // fails-when: a non-adopter last heard 90 s ago, with the default 120 s grace, is forgotten
    it('keeps a peer with no adopted provisions inside the reroute flap grace, naming it', async () => {
      for (const src of [source(120_000, []), source(120_000, null)]) {
        const peers = silent(now - 90_000);
        const result = await forget(peers, src);
        expect(result.outcome).toBe(PeerForgetOutcome.enum.recent);
        expect(result.detail).toContain('coord-b was last heard from 90 s ago');
        expect(result.detail).toContain(
          'the 120 s reroute flap grace (reroute_flap_grace_ms) a coordinator gives a disconnected peer',
        );
        expect(peers.getPeer('coord-b')).toBeDefined();
      }
    });

    // breaks-if-wrong: the same non-adopter at 121 s is forgotten
    it('forgets a peer with no adopted provisions once the reroute flap grace has passed', async () => {
      for (const src of [source(120_000, []), source(120_000, null)]) {
        const peers = silent(now - 121_000);
        expect((await forget(peers, src)).outcome).toBe(PeerForgetOutcome.enum.forgotten);
      }
    });

    it('keeps a peer for a raised reroute flap grace', async () => {
      expect((await forget(silent(now - 200_000), source(300_000, []))).outcome).toBe(
        PeerForgetOutcome.enum.recent,
      );
      expect((await forget(silent(now - 301_000), source(300_000, []))).outcome).toBe(
        PeerForgetOutcome.enum.forgotten,
      );
    });
  });
});

describe('replyToPeerForgetRequest', () => {
  const msg = { type: 'peer.forget.request' as const, messageId: 'm-1', instanceId: 'coord-b' };

  it('answers with the handler outcome', async () => {
    const send = vi.fn();
    replyToPeerForgetRequest(
      msg,
      async () => ({ outcome: PeerForgetOutcome.enum.forgotten, detail: 'coord-b forgotten' }),
      send,
    );
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'peer.forget.response',
        messageId: 'm-1',
        outcome: PeerForgetOutcome.enum.forgotten,
        detail: 'coord-b forgotten',
      }),
    );
  });

  // fails-when: a guard that cannot read adopted provisions lets the peer go, or never answers
  it('answers error, keeping the peer, when the handler fails', async () => {
    const send = vi.fn();
    replyToPeerForgetRequest(
      msg,
      async () => {
        throw new Error('database unavailable');
      },
      send,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toMatchObject({
      messageId: 'm-1',
      outcome: PeerForgetOutcome.enum.error,
      detail: 'could not check coord-b, so it is kept: database unavailable',
    });
  });

  it('answers unhandled with no handler', () => {
    const send = vi.fn();
    replyToPeerForgetRequest(msg, undefined, send);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: PeerForgetOutcome.enum.error,
        detail: PEER_FORGET_UNHANDLED,
      }),
    );
  });
});
