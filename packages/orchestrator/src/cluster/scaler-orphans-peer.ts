/**
 * The peer-channel half of `kici-admin scaler orphans --target`: answering a
 * forwarded peer.scaler.orphans.request, and correlating the response with
 * the request that is waiting for it. Shared by the outgoing `PeerClient` and
 * the incoming peer handler, which carry the same message pair.
 */
import { z } from 'zod';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { PeerScalerOrphansRequest, PeerScalerOrphansResponse } from '@kici-dev/engine';
import type { ScalerOrphansAnswer } from '../scaler/orphan-requests.js';
import { PeerRequestWaiters } from './peer-request-waiters.js';

const logger = createLogger({ prefix: 'scaler-orphans-peer' });

/** Answers a forwarded request from this node's own host and tracking. */
export type ScalerOrphansRequestHandler = (
  msg: PeerScalerOrphansRequest,
) => Promise<ScalerOrphansAnswer>;

/** The answer of a peer that has no handler wired. */
export const SCALER_ORPHANS_UNHANDLED_ERROR = 'scaler orphan requests are not handled by this peer';

/** The answer to a request a worker sent: a worker never stops another node's VMs. */
export const SCALER_ORPHANS_COORDINATORS_ONLY_ERROR =
  'scaler orphan requests are accepted from coordinators only';

/** A forward that reached no peer, or a peer that did not answer in time. */
export const ScalerOrphansForwardFailure = z.enum(['not-connected', 'timeout']);
export type ScalerOrphansForwardFailure = z.infer<typeof ScalerOrphansForwardFailure>;

/** A wait that ended without a response. */
export const SCALER_ORPHANS_TIMEOUT = ScalerOrphansForwardFailure.enum.timeout;

/**
 * Answer one forwarded request through `send`. A missing handler and a
 * handler failure are both answered `ok: false`, so the requester never waits
 * out its timeout for a peer that cannot answer.
 */
export function replyToScalerOrphansRequest(
  msg: PeerScalerOrphansRequest,
  handler: ScalerOrphansRequestHandler | undefined,
  send: (response: PeerScalerOrphansResponse) => void,
  logFields: Record<string, unknown> = {},
): void {
  const reply = (answer: ScalerOrphansAnswer): void => {
    send({ type: 'peer.scaler.orphans.response', messageId: msg.messageId, ...answer });
  };
  if (!handler) {
    reply({ ok: false, error: SCALER_ORPHANS_UNHANDLED_ERROR });
    return;
  }
  handler(msg).then(reply, (err: unknown) => {
    logger.error('Error answering a scaler orphan request', {
      ...logFields,
      action: msg.action,
      error: toErrorMessage(err),
    });
    reply({ ok: false, error: toErrorMessage(err) });
  });
}

/** Pending scaler orphan requests; a close answers each `ok: false` naming the reason. */
export class ScalerOrphansWaiters extends PeerRequestWaiters<PeerScalerOrphansResponse> {
  constructor() {
    super((messageId, reason) => ({
      type: 'peer.scaler.orphans.response',
      messageId,
      ok: false,
      error: reason,
    }));
  }
}
