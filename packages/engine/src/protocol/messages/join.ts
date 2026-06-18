import { z } from 'zod';

// --- Join protocol messages ---
// Used for zero-knowledge cluster join flow: new orchestrator sends join.request
// with a kici_join_v1 token, existing orchestrator validates and responds with
// an encrypted config bundle. Platform relay sees only the routing part (orgId, routingKey)
// and opaque ciphertext.

/** Join request sent by a new orchestrator (via Platform relay or direct peer). */
export const joinRequestSchema = z.object({
  type: z.literal('join.request'),
  /** Correlation ID for Platform relay routing. Platform injects this on relay to match
   *  join.response back to the correct joining orchestrator when multiple joiners
   *  are active concurrently. */
  messageId: z.string().optional(),
  /** The full join token: kici_join_v1.<base64url_routing>.<secret_hex> */
  token: z.string(),
});

/** Join response from an existing orchestrator back to the joiner. */
export const joinResponseSchema = z.object({
  type: z.literal('join.response'),
  /** Correlation ID echoed from join.request for Platform relay routing. */
  messageId: z.string().optional(),
  success: z.boolean(),
  /** Base64-encoded AES-256-GCM encrypted config bundle (present on success). */
  encryptedBundle: z.string().optional(),
  /** Error message (present on failure). */
  error: z.string().optional(),
});

// --- Inferred types ---

export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type JoinResponse = z.infer<typeof joinResponseSchema>;
