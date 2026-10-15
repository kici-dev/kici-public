/**
 * Wire envelope for a browser-sealed dashboard write. Under the `encrypted`
 * posture the browser seals the value to the orchestrator's published X25519
 * key before it leaves the page, so the hosted Platform relays only opaque
 * ciphertext. The shape is exactly what the orchestrator's
 * `decryptDashboardSealedWrite` consumes. Pure Zod: the dashboard SPA imports it.
 */
import { z } from 'zod';

export const dashboardSealedEnvelopeSchema = z.object({
  /** The `kid` of the orchestrator encryption key the browser sealed to. */
  keyId: z.string().min(1),
  /** Ephemeral X25519 public key, base64-encoded DER-SPKI. */
  ephemeralPublicKey: z.string().min(1),
  /** AES-256-GCM output as base64 `IV(12) || authTag(16) || ciphertext`. */
  encrypted: z.string().min(1),
});

export type DashboardSealedEnvelope = z.infer<typeof dashboardSealedEnvelopeSchema>;

/**
 * The orchestrator's published X25519 dashboard-encryption public key as an
 * OKP JWK: `x` is the raw 32-byte key base64url-encoded, `kid` its RFC 7638
 * thumbprint. `.passthrough()` because a JWK may carry members a peer does not
 * know; only the members the seal needs are validated.
 */
export const dashboardEncryptionJwkSchema = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('X25519'),
    x: z.string().min(1),
    kid: z.string().min(1),
    use: z.literal('enc').optional(),
  })
  .passthrough();

export type DashboardEncryptionJwk = z.infer<typeof dashboardEncryptionJwkSchema>;

/**
 * Error codes in a `.set.response` `error` field when a write cannot be honored
 * under the `encrypted` posture. The dashboard renders a fail-closed affordance
 * keyed on them, never a silent fallback to plaintext through the Platform.
 */
export const DashboardSealedWriteError = z.enum([
  // A plaintext `value` arrived for an `encrypted`-posture op (fail-closed).
  'operation_requires_encryption',
  // The sealed envelope's keyId is not a known/served encryption key.
  'unknown_encryption_key',
  // No active encryption key (KICI_SECRET_KEY unset / key not yet provisioned).
  'encryption_unavailable',
  // The sealed envelope failed to decrypt (tampered / wrong key / bad framing).
  'decryption_failed',
  // Neither value nor sealed resolved a usable plaintext.
  'missing_value',
]);
export type DashboardSealedWriteError = z.infer<typeof DashboardSealedWriteError>;
