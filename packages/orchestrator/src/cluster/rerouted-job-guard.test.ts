import { describe, it, expect } from 'vitest';
import { shouldDeferReroutedJob, DEFAULT_REROUTE_FLAP_GRACE_MS } from './rerouted-job-guard.js';
import type { PeerRegistry } from './peer-registry.js';

/**
 * Minimal PeerRegistry stub exposing only the `getPeer(id)` surface the guard
 * uses. Connected ids resolve to a connected peer; everything else is undefined
 * (absent peer). A fresh `lastHeartbeatAt` keeps connected peers inside any
 * grace window.
 */
function registry(connected: string[]): PeerRegistry {
  return {
    getPeer: (id: string) =>
      connected.includes(id) ? { connected: true, lastHeartbeatAt: Date.now() } : undefined,
  } as unknown as PeerRegistry;
}

/** Stub returning a single fixed peer for the owning id. */
function peerStub(peer: { connected: boolean; lastHeartbeatAt: number } | undefined): PeerRegistry {
  return { getPeer: () => peer } as unknown as PeerRegistry;
}

describe('shouldDeferReroutedJob', () => {
  it('defers when the owning peer is connected', () => {
    expect(shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, registry(['arm-stg']))).toBe(
      true,
    );
  });

  it('does not defer when the owning peer is absent (evicted / dead)', () => {
    expect(shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, registry([]))).toBe(false);
  });

  it('defers a disconnected peer whose last heartbeat is within the flap-grace window', () => {
    // A peer-WS flap (1006) during a coordinator restart marks the peer
    // disconnected but keeps a recent lastHeartbeatAt; the worker reconnects
    // and replays its buffered terminal status, so the run must NOT be failed.
    const now = 1_000_000;
    const reg = peerStub({ connected: false, lastHeartbeatAt: now - 5_000 });
    expect(shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, reg, { nowMs: now })).toBe(true);
  });

  it('does not defer a disconnected peer gone longer than the flap-grace window', () => {
    const now = 1_000_000;
    const reg = peerStub({
      connected: false,
      lastHeartbeatAt: now - DEFAULT_REROUTE_FLAP_GRACE_MS - 1,
    });
    expect(shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, reg, { nowMs: now })).toBe(
      false,
    );
  });

  it('honors an explicit flapGraceMs override', () => {
    const now = 1_000_000;
    const reg = peerStub({ connected: false, lastHeartbeatAt: now - 10_000 });
    expect(
      shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, reg, {
        nowMs: now,
        flapGraceMs: 5_000,
      }),
    ).toBe(false);
    expect(
      shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, reg, {
        nowMs: now,
        flapGraceMs: 30_000,
      }),
    ).toBe(true);
  });

  it('does not defer a disconnected peer with no recorded heartbeat', () => {
    const reg = { getPeer: () => ({ connected: false }) } as unknown as PeerRegistry;
    expect(shouldDeferReroutedJob({ rerouted_to_peer: 'arm-stg' }, reg)).toBe(false);
  });

  it('does not defer a local (non-rerouted) job', () => {
    expect(shouldDeferReroutedJob({ rerouted_to_peer: null }, registry(['arm-stg']))).toBe(false);
  });
});
