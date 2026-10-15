import { z } from 'zod';

/**
 * Maximum decompressed WebSocket frame size accepted by every KiCI WS endpoint
 * (Platform, orchestrator, agent — both server-side and client-side).
 *
 * Bounds per-frame memory against `permessage-deflate` compression bombs:
 * `ws@8.x` defaults to 100 MiB, which an unauthenticated attacker can exhaust
 * on the Platform's `/ws` endpoint pre-auth with one crafted compressed frame.
 *
 * 25 MiB matches `WEBHOOK_RELAY_MAX_BODY_BYTES` (and GitHub's own webhook
 * payload cap). The webhook relay chunks bodies into ~85 KiB frames, so this
 * leaves orders-of-magnitude headroom for every other legitimate frame
 * (log.chunk, state.replay, dashboard proxy responses, etc.).
 *
 * MUST be passed as `maxPayload` on every `new WebSocket(...)` constructor and
 * on every `WebSocketServer` `options` object across the three packages.
 */
export const WS_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Heartbeat message sent periodically to keep WebSocket alive.
 *
 * FAST-PATHED: A manual validator exists in
 * packages/orchestrator/src/ws/agent-handler.ts (isValidHeartbeat).
 * If you change this schema, update the manual validator in the same commit.
 */
export const heartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number(),
});

/** Acknowledgment of a received message. */
export const ackSchema = z.object({
  type: z.literal('ack'),
  messageId: z.string(),
});

/**
 * Negative acknowledgment - message received but could not be processed.
 *
 * Doubles as the version-skew signal: a peer that receives a message type it
 * does not understand replies with a NACK naming the `receivedType`, instead of
 * dropping the frame (which surfaces only as a downstream proxy timeout).
 * Both fields are optional, so a fire-and-forget frame with no `messageId`
 * still yields a valid NACK.
 */
export const nackSchema = z.object({
  type: z.literal('nack'),
  /** Correlation id echoed from the offending frame, when it carried one. */
  messageId: z.string().optional(),
  /** The unsupported/unrecognized message type that triggered this NACK. */
  receivedType: z.string().optional(),
  reason: z.string(),
});
export type Nack = z.infer<typeof nackSchema>;

/**
 * Message types that are NEVER answered with an unsupported-message NACK when
 * they fail a direction's recognition chain:
 * - `nack` — loop guard: a malformed NACK must not trigger a NACK-of-NACK.
 * - `log.chunk` / `orch-log.chunk` — pure streaming frames. A NACK cannot be
 *   correlated to a stream and would only add noise; these stay drop-and-warn.
 */
export const NACK_EXEMPT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'nack',
  'log.chunk',
  'orch-log.chunk',
]);

/**
 * Build an unsupported-message NACK for a frame that failed every schema in a
 * direction's recognition chain (version skew).
 *
 * Returns `null` (do not NACK, stay drop-and-warn) when:
 * - `raw` is not an object with a non-empty string `type` (malformed garbage); OR
 * - the `type` is in `NACK_EXEMPT_MESSAGE_TYPES`; OR
 * - the `type` is in `knownTypes`: a KNOWN type that failed the chain is
 *   malformed (e.g. a field past its length bound), not version skew. The
 *   caller must close the connection, never keep it alive with a NACK.
 *
 * `side` names the local peer emitting the NACK (the behind party) for the
 * operator-facing upgrade hint, matching the lock-window "upgrade the
 * orchestrator/Platform" wording. `knownTypes` is the set of types this build
 * recognizes for the direction, derived by the caller from the schema
 * discriminators.
 */
export function buildUnsupportedMessageNack(
  raw: unknown,
  side: 'orchestrator' | 'platform',
  knownTypes: ReadonlySet<string>,
): z.infer<typeof nackSchema> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as { type?: unknown; messageId?: unknown };
  if (typeof frame.type !== 'string' || frame.type.length === 0) return null;
  if (NACK_EXEMPT_MESSAGE_TYPES.has(frame.type)) return null;
  if (knownTypes.has(frame.type)) return null;
  const nack: z.infer<typeof nackSchema> = {
    type: 'nack',
    receivedType: frame.type,
    reason: `unsupported message type "${frame.type}" — this ${side} does not understand it (protocol version skew); upgrade the ${side}`,
  };
  if (typeof frame.messageId === 'string' && frame.messageId.length > 0) {
    nack.messageId = frame.messageId;
  }
  return nack;
}

/** Protocol-level error message. */
export const errorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type Ack = z.infer<typeof ackSchema>;
