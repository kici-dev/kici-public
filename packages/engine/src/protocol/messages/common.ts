import { z } from 'zod';

/**
 * Maximum decompressed WebSocket frame size accepted by every KiCI WS endpoint
 * (Platform, orchestrator, agent — both server-side and client-side).
 *
 * Bounds per-frame memory allocation against `permessage-deflate`
 * compression-bomb DoS. Without this cap, `ws@8.x` defaults to 100 MiB,
 * which an unauthenticated attacker can exhaust on the Platform's
 * `/ws` endpoint pre-auth via a single crafted compressed frame.
 *
 * 25 MiB matches `WEBHOOK_RELAY_MAX_BODY_BYTES` (and GitHub's own webhook
 * payload cap). The chunked webhook-relay protocol breaks bodies into ~85 KiB
 * frames anyway, so this leaves orders-of-magnitude headroom for every other
 * legitimate WS frame in the system (log.chunk, state.replay, dashboard
 * proxy responses, etc.).
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
 * See CLAUDE.md rule: "Zod fast-path sync invariant".
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

/** Negative acknowledgment - message received but could not be processed. */
export const nackSchema = z.object({
  type: z.literal('nack'),
  messageId: z.string(),
  reason: z.string(),
});

/** Protocol-level error message. */
export const errorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

/** Inferred types from schemas. */
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type Ack = z.infer<typeof ackSchema>;
