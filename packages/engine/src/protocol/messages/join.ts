import { z } from 'zod';

// --- Join protocol messages (join protocol v2) ---
// A new orchestrator asks an existing one for the cluster configuration bundle. The
// joiner proves it holds the join token without sending the token or its secret; the
// existing orchestrator proves the same back and seals the bundle to a one-time key of
// the joiner. A relay sees the token's routing part, both public keys, both nonces,
// both proofs and the ciphertext, and can open none of it. A frame that carries the
// token itself (version 1) is refused everywhere.

export const JOIN_PROTOCOL_VERSION = 2 as const;
/** `Upgrade` header value on the HTTP 426 that refuses a version-1 join. */
export const JOIN_PROTOCOL_UPGRADE_TOKEN = 'kici-join-v2';

export const JOIN_PROTOCOL_V1_REMOVED_MESSAGE =
  'This kici-admin uses join protocol v1, which orchestrators no longer accept. Upgrade kici-admin, then run kici-admin join again.';
export const JOIN_PROTOCOL_UNSUPPORTED_MESSAGE =
  "The cluster's orchestrators predate join protocol v2. Upgrade them, then join again.";
export const LEGACY_JOINER_AUTH_MESSAGE =
  'This kici-admin cannot join through the Platform. Upgrade kici-admin, then run kici-admin join again.';
export const INVALID_JOIN_REQUEST_MESSAGE = 'Invalid join request';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_PROOF = /^[0-9a-f]{64}$/;
const MAX_MESSAGE_ID = 256;

/** Why a join was refused. Every refusal on the Platform, the orchestrator and the HTTP route sets one. */
export const JoinErrorCode = z.enum([
  'join_protocol_v1_removed',
  'join_protocol_unsupported',
  'invalid_request',
  'invalid_token',
  'token_expired',
  'token_already_used',
  'org_mismatch',
  'no_target',
  'relay_timeout',
]);
export type JoinErrorCode = z.infer<typeof JoinErrorCode>;

export const JoinRequestKind = z.enum(['v2', 'v1_removed', 'invalid']);
export type JoinRequestKind = z.infer<typeof JoinRequestKind>;

/** The decoded routing part of a join token. A lookup key only: the orchestrator trusts its stored row. */
export const joinRoutingSchema = z
  .object({ orgId: z.string().min(1), routingKey: z.string().min(1), expiry: z.number().finite() })
  .passthrough();
export type JoinRouting = z.infer<typeof joinRoutingSchema>;

/** Join request sent by a new orchestrator (through the Platform relay or directly to a peer). */
export const joinRequestSchema = z.object({
  type: z.literal('join.request'),
  /** Correlation ID the Platform injects on relay to route the response back. */
  messageId: z.string().max(MAX_MESSAGE_ID).optional(),
  joinProtocol: z.literal(JOIN_PROTOCOL_VERSION),
  /** The token's base64url routing part, exactly as it appears in the token. */
  routing: z.string().max(2048).regex(BASE64URL),
  /** The joiner's one-time X25519 public key, DER SPKI, base64. */
  joinerPublicKey: z.string().max(128).regex(BASE64),
  /** 32 random bytes, base64. */
  joinerNonce: z.string().max(64).regex(BASE64),
  /** HMAC-SHA256 over the request transcript, lowercase hex. */
  joinerProof: z.string().regex(HEX_PROOF),
});

/** Join response from an existing orchestrator back to the joiner. */
export const joinResponseSchema = z.object({
  type: z.literal('join.response'),
  /** Correlation ID echoed from join.request for Platform relay routing. */
  messageId: z.string().max(MAX_MESSAGE_ID).optional(),
  success: z.boolean(),
  joinProtocol: z.literal(JOIN_PROTOCOL_VERSION).optional(),
  /** The existing orchestrator's one-time X25519 public key, DER SPKI, base64. */
  serverPublicKey: z.string().max(128).regex(BASE64).optional(),
  /** 32 random bytes, base64. */
  serverNonce: z.string().max(64).regex(BASE64).optional(),
  /** HMAC-SHA256 over the response transcript, lowercase hex. */
  serverProof: z.string().regex(HEX_PROOF).optional(),
  /** Base64 AES-256-GCM sealed configuration bundle (on success). */
  encryptedBundle: z.string().optional(),
  /** Error message (on failure). */
  error: z.string().optional(),
  errorCode: JoinErrorCode.optional(),
});

export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type JoinResponse = z.infer<typeof joinResponseSchema>;

export type ClassifiedJoinRequest =
  | { kind: typeof JoinRequestKind.enum.v2; request: JoinRequest }
  | { kind: typeof JoinRequestKind.enum.v1_removed; messageId?: string }
  | { kind: typeof JoinRequestKind.enum.invalid; messageId?: string };

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function messageIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.messageId;
  return typeof id === 'string' && id.length <= MAX_MESSAGE_ID ? id : undefined;
}

/** True for an object whose `type` is `join.request`, whatever else it carries. */
export function isJoinRequestFrame(raw: unknown): boolean {
  return isRecord(raw) && raw.type === 'join.request';
}

/**
 * Classify a join.request frame. A frame that carries `token` is version 1 even when
 * v2 fields are present too: it is checked before the parse, which would strip it.
 */
export function classifyJoinRequest(raw: unknown): ClassifiedJoinRequest {
  const messageId = messageIdOf(raw);
  if (isJoinRequestFrame(raw) && Object.prototype.hasOwnProperty.call(raw, 'token')) {
    return { kind: JoinRequestKind.enum.v1_removed, messageId };
  }
  const parsed = joinRequestSchema.safeParse(raw);
  if (parsed.success) return { kind: JoinRequestKind.enum.v2, request: parsed.data };
  return { kind: JoinRequestKind.enum.invalid, messageId };
}

/** A refused join.response carrying its error code. */
export function buildJoinRefusal(
  messageId: string | undefined,
  errorCode: JoinErrorCode,
  error: string,
): JoinResponse {
  return { type: 'join.response', messageId, success: false, errorCode, error };
}
