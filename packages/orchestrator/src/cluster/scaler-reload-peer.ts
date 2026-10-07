/**
 * The peer-channel half of `kici-admin scaler reload`: answering a
 * peer.scaler.reload.request with this node's own scaler file reload, and
 * correlating the response with the request that is waiting for it. Shared by
 * the outgoing `PeerClient` and the incoming peer handler, which carry the same
 * message pair.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  ScalerReloadOutcome,
  type PeerScalerReloadRequest,
  type PeerScalerReloadResponse,
} from '@kici-dev/engine';
import type { ScalerFileReload } from '../scaler/file-reload.js';
import { PeerRequestWaiters } from './peer-request-waiters.js';

const logger = createLogger({ prefix: 'scaler-reload-peer' });

/** The answer of a peer that has no reload wired. */
const SCALER_RELOAD_UNHANDLED_DETAIL = 'scaler reload requests are not handled by this peer';

/** The answer to a request a worker sent: a worker never directs another node's scalers. */
export const SCALER_RELOAD_COORDINATORS_ONLY_DETAIL =
  'scaler reload requests are accepted from coordinators only';

/**
 * Answer one request through `send`. A missing handler and a handler failure
 * are both answered `rejected`, so the requester never waits out its timeout
 * for a peer that cannot answer.
 */
export function replyToScalerReloadRequest(
  msg: PeerScalerReloadRequest,
  handler: ScalerFileReload | undefined,
  send: (response: PeerScalerReloadResponse) => void,
  logFields: Record<string, unknown> = {},
): void {
  const base = { type: 'peer.scaler.reload.response' as const, messageId: msg.messageId };
  if (!handler) {
    send({
      ...base,
      outcome: ScalerReloadOutcome.enum.rejected,
      detail: SCALER_RELOAD_UNHANDLED_DETAIL,
    });
    return;
  }
  handler().then(
    (result) => send({ ...base, ...result }),
    (err: unknown) => {
      logger.error('Error answering a scaler reload request', {
        ...logFields,
        error: toErrorMessage(err),
      });
      send({
        ...base,
        outcome: ScalerReloadOutcome.enum.rejected,
        errors: [toErrorMessage(err)],
      });
    },
  );
}

/** Pending scaler reload requests; a close answers each `unreachable` naming the reason. */
export class ScalerReloadWaiters extends PeerRequestWaiters<PeerScalerReloadResponse> {
  constructor() {
    super((messageId, reason) => ({
      type: 'peer.scaler.reload.response',
      messageId,
      outcome: ScalerReloadOutcome.enum.unreachable,
      detail: reason,
    }));
  }
}
