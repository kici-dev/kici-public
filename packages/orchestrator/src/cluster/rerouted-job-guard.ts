import type { PeerRegistry } from './peer-registry.js';

/**
 * Grace window (ms) during which a rerouted job stays deferred from the
 * recovery sweepers even though its worker peer is momentarily disconnected.
 *
 * A worker that completes a job durably buffers the terminal status in its
 * PeerOutbox and replays it on the next reconnect. A coordinator restart or a
 * leadership transition makes the worker's peer-WS flap (an abnormal 1006
 * close) for a few seconds before it reconnects and replays — so sampling
 * `peer.connected` at the exact instant a sweeper runs can catch the peer
 * mid-flap and wrongly force-fail a run whose job already succeeded.
 *
 * The grace is two peer-stale-timeout windows (peerStaleTimeoutMs default
 * 60_000): a peer that flaps and reconnects inside one stale window is always
 * deferred, while a peer absent for two full windows is treated as dead and
 * its job is failed — so a genuinely dead worker can never hang a run forever.
 */
export const DEFAULT_REROUTE_FLAP_GRACE_MS = 120_000;

/**
 * A non-terminal job that was rerouted to a remote worker peer must NOT be
 * force-failed by the run-recovery sweepers (OrphanRecovery, StaleRunDetector)
 * while that worker peer can still replay the job's terminal status from its
 * durable outbox.
 *
 * Returns `true` (defer the sweeper's force-fail) when the job carries a
 * `rerouted_to_peer` marker AND its peer is either currently connected OR was
 * last seen within the flap-grace window (a transient peer-WS reconnect during
 * a coordinator restart / leadership transition). A rerouted job whose peer has
 * been gone longer than the grace window — or is no longer tracked at all — is
 * NOT deferred, so a dead worker's job is still failed and cannot hang forever.
 * Local (non-rerouted) jobs — `rerouted_to_peer === null` — are never deferred.
 */
export function shouldDeferReroutedJob(
  job: { rerouted_to_peer: string | null },
  peerRegistry: Pick<PeerRegistry, 'getPeer'>,
  opts?: { nowMs?: number; flapGraceMs?: number },
): boolean {
  if (!job.rerouted_to_peer) return false;
  const peer = peerRegistry.getPeer(job.rerouted_to_peer);
  if (!peer) return false;
  if (peer.connected) return true;
  // Momentarily disconnected: defer only while the last heartbeat is recent,
  // giving the worker's durable outbox time to reconnect and replay the
  // buffered terminal status before the sweeper force-fails the run.
  const nowMs = opts?.nowMs ?? Date.now();
  const flapGraceMs = opts?.flapGraceMs ?? DEFAULT_REROUTE_FLAP_GRACE_MS;
  return nowMs - peer.lastHeartbeatAt <= flapGraceMs;
}
