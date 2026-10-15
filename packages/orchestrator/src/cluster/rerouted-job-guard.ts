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
 * Whether the run-recovery sweepers (OrphanRecovery, StaleRunDetector) must defer
 * force-failing a non-terminal rerouted job, because its worker peer can still
 * replay the terminal status from its durable outbox.
 *
 * True when the job has a `rerouted_to_peer` AND that peer is connected or was
 * last seen within the flap grace. A peer gone longer than the grace, or no
 * longer tracked, is not deferred, so a dead worker cannot hang a run. Local
 * jobs (`rerouted_to_peer === null`) are never deferred.
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
  // Momentarily disconnected: defer while the last heartbeat is within the grace.
  const nowMs = opts?.nowMs ?? Date.now();
  const flapGraceMs = opts?.flapGraceMs ?? DEFAULT_REROUTE_FLAP_GRACE_MS;
  return nowMs - peer.lastHeartbeatAt <= flapGraceMs;
}
