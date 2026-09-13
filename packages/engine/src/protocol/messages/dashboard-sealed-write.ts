/**
 * Wire envelope for a browser-sealed dashboard write.
 *
 * Under the `encrypted` dashboard-write posture the browser seals the plaintext
 * value to the orchestrator's published X25519 encryption key before it leaves
 * the page, so the hosted Platform relays only opaque ciphertext. The envelope
 * is the exact shape the orchestrator's `decryptDashboardSealedWrite` consumes:
 * an ephemeral X25519 public key (base64 DER-SPKI) and the AES-256-GCM output
 * packed as `IV || authTag || ciphertext` (base64), plus the `keyId` (`kid`)
 * naming which published encryption key the browser sealed to.
 *
 * Browser-safe: pure Zod, no node built-ins, so the dashboard SPA imports it
 * directly.
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
 * The orchestrator's published X25519 dashboard-encryption public key, as an
 * OKP JWK (`kty:'OKP'`, `crv:'X25519'`, `use:'enc'`, `x` = the raw 32-byte
 * public key base64url-encoded, `kid` = its RFC 7638 thumbprint).
 *
 * `.passthrough()` because a JWK may legitimately carry members a given peer
 * does not know; only the members the seal actually needs are validated.
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
 * Structured error codes the orchestrator returns (in a `.set.response`
 * `error` field) when a sealed / plaintext write cannot be honored under the
 * `encrypted` posture. The dashboard renders a fail-closed affordance keyed on
 * these codes — never a silent fallback to plaintext-through-Platform.
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
