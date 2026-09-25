/**
 * Whether this coordinator has a live coordinator peer.
 *
 * `PeerRegistry` flips `connected` the instant a peer WS closes, with no grace
 * of its own, so sampling it alone reads a link blip between two healthy
 * coordinators as a dead peer. That is the same hazard `shouldDeferReroutedJob`
 * and `adopterIsLive` guard against, and it is answered the same way: a
 * coordinator peer counts while it is connected or was last heard from within
 * the flap grace. Worker peers never count: they do not drain the shared queue.
 */
import type { PeerRegistry } from './peer-registry.js';

export function hasLiveCoordinatorPeer(
  peers: Pick<PeerRegistry, 'getCoordinatorPeers'>,
  nowMs: number,
  flapGraceMs: number,
): boolean {
  return peers
    .getCoordinatorPeers()
    .some((peer) => peer.connected || nowMs - peer.lastHeartbeatAt <= flapGraceMs);
}
