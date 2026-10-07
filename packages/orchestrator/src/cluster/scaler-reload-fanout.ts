/**
 * `kici-admin scaler reload`: reload the scaler config on this orchestrator and,
 * unless the operator asked for one instance only, on every peer it is
 * connected to. Each orchestrator reads its own scaler file, so each one
 * applies its file completely or not at all, and the result lists one outcome
 * per instance.
 */
import { randomUUID } from 'node:crypto';
import {
  ScalerReloadOutcome,
  type PeerScalerReloadRequest,
  type PeerScalerReloadResponse,
  type ScalerReloadInstanceResult,
} from '@kici-dev/engine';
import type { ScalerFileReload } from '../scaler/file-reload.js';
import type { PeerRegistry } from './peer-registry.js';
import { PEER_REQUEST_TIMEOUT } from './peer-request-waiters.js';

/**
 * Sends one scaler reload request to a peer and waits for its answer. Resolves
 * null when no connection reached the peer, and {@link PEER_REQUEST_TIMEOUT}
 * when it did not answer within `timeoutMs`.
 */
export type SendScalerReload = (
  instanceId: string,
  msg: PeerScalerReloadRequest,
  timeoutMs: number,
) => Promise<PeerScalerReloadResponse | null | typeof PEER_REQUEST_TIMEOUT>;

export interface ScalerReloadAcrossClusterOptions {
  selfInstanceId: string;
  selfRole: 'coordinator' | 'worker';
  registry: Pick<PeerRegistry, 'getAllPeers'>;
  local: ScalerFileReload;
  send: SendScalerReload;
  /** Reload this orchestrator only. */
  single: boolean;
  /** How long to wait for each peer's answer. */
  timeoutMs: number;
}

/**
 * Reload this orchestrator and every peer in its registry. A connected peer
 * (coordinator or worker) gets the request; a known peer that is not connected
 * is reported `unreachable` without one. The local reload and the peer
 * requests run at the same time; the first result is this orchestrator's.
 */
export async function reloadScalersAcrossCluster(
  opts: ScalerReloadAcrossClusterOptions,
): Promise<ScalerReloadInstanceResult[]> {
  const local = opts.local().then((result): ScalerReloadInstanceResult => ({
    instanceId: opts.selfInstanceId,
    role: opts.selfRole,
    ...result,
  }));
  if (opts.single) return [await local];

  const peers = opts.registry
    .getAllPeers()
    .filter((peer) => peer.instanceId !== opts.selfInstanceId)
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const remote = peers.map(async (peer): Promise<ScalerReloadInstanceResult> => {
    const identity = { instanceId: peer.instanceId, role: peer.role };
    if (!peer.connected) {
      return {
        ...identity,
        outcome: ScalerReloadOutcome.enum.unreachable,
        detail:
          'not connected to this orchestrator; a worker that moved to another coordinator ' +
          'is reached through that one, and a peer that left the cluster for good is ' +
          `removed with: kici-admin peer forget ${peer.instanceId}`,
      };
    }
    const response = await opts.send(
      peer.instanceId,
      { type: 'peer.scaler.reload.request', messageId: randomUUID() },
      opts.timeoutMs,
    );
    if (response === null || response === PEER_REQUEST_TIMEOUT) {
      return {
        ...identity,
        outcome: ScalerReloadOutcome.enum.unreachable,
        detail:
          response === null
            ? 'no connection reached this orchestrator'
            : `no answer within ${opts.timeoutMs} ms; it may run a version without scaler reload`,
      };
    }
    const { type: _type, messageId: _messageId, ...answer } = response;
    return { ...identity, ...answer };
  });
  return Promise.all([local, ...remote]);
}
