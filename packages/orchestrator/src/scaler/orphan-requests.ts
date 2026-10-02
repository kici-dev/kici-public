/**
 * The node side of a scaler orphan request: answer `list` / `stop` from this
 * node's own host and its own tracking.
 *
 * Shared by the coordinator's admin routes (a request for itself) and by the
 * peer channel (a request a coordinator forwarded to this node).
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  ScalerOrphansAction,
  ScalerVmStopOutcome,
  type PeerScalerOrphansResponse,
} from '@kici-dev/engine';
import type { ScalerManager } from './manager.js';

const logger = createLogger({ prefix: 'scaler-orphans' });

/**
 * The longest a scaler orphan request waits for its node. The `kici-admin`
 * HTTP client stops waiting for response headers after 300 s, so a longer
 * wait could never reach the operator.
 */
export const MAX_SCALER_ORPHANS_TIMEOUT_MS = 240_000;

/** A scaler orphan answer without its peer-message envelope. */
export type ScalerOrphansAnswer = Omit<PeerScalerOrphansResponse, 'type' | 'messageId'>;

/** What one scaler orphan request asks of the node. */
export interface ScalerOrphansRequest {
  action: ScalerOrphansAction;
  /** `stop` only: the VM ids the operator approved. */
  vmIds?: string[];
}

/**
 * Answer a scaler orphan request on this node. A node with no scaler manager
 * runs no Firecracker scaler: it lists nothing and holds none of the VMs a stop
 * names. A failure is answered `ok: false` with its message, never thrown.
 */
export async function answerScalerOrphansRequest(
  manager: Pick<
    ScalerManager,
    'listLiveVms' | 'stopUntrackedVms' | 'firecrackerScalerNames'
  > | null,
  req: ScalerOrphansRequest,
): Promise<ScalerOrphansAnswer> {
  try {
    if (req.action === ScalerOrphansAction.enum.list) {
      if (!manager) return { ok: true, firecrackerScalers: [], vms: [] };
      return {
        ok: true,
        firecrackerScalers: manager.firecrackerScalerNames(),
        vms: await manager.listLiveVms(),
      };
    }
    if (!req.vmIds || req.vmIds.length === 0) return { ok: false, error: 'stop needs vmIds' };
    if (!manager) {
      return {
        ok: true,
        firecrackerScalers: [],
        results: req.vmIds.map((vmId) => ({
          vmId,
          outcome: ScalerVmStopOutcome.enum['not-found'],
          detail: 'this node runs no Firecracker scaler',
        })),
      };
    }
    const results = await manager.stopUntrackedVms(req.vmIds);
    for (const result of results) {
      logger.info('scaler orphan stop result', {
        vmId: result.vmId,
        outcome: result.outcome,
        pid: result.pid,
        detail: result.detail,
      });
    }
    return { ok: true, firecrackerScalers: manager.firecrackerScalerNames(), results };
  } catch (err) {
    logger.error('scaler orphan request failed', {
      action: req.action,
      error: toErrorMessage(err),
    });
    return { ok: false, error: toErrorMessage(err) };
  }
}
