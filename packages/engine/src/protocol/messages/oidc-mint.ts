import { z } from 'zod';
import { AttestationOrigin } from '../../provenance/attestation-origin.js';

/**
 * @deprecated The `oidc.mint.*` RPC pair (Platform-rooted identity mint) is
 * hard-deprecated in favor of orchestrator-owned signing. It is kept
 * wire-compatible for the mixed-version rollout window and removed at v1.0; a
 * fresh orchestrator with its own signer never sends it. See
 * docs/user/deprecations.md.
 */

/**
 * Error discriminator for a failed provenance mint, carried on
 * `oidc.mint.response.error.code`. Mirrors the three orchestrator-side error
 * classes that consume it:
 *   rejected    -> run/job missing or job terminal (MintRejectedError)
 *   unavailable -> the Platform signer/issuer is not configured (MintUnavailableError)
 *   failed      -> any other Platform-side failure (MintRelayError)
 */
export const OidcMintErrorCode = z.enum(['rejected', 'unavailable', 'failed']);
export type OidcMintErrorCode = z.infer<typeof OidcMintErrorCode>;

/** orchestrator -> Platform: request a short-lived OIDC ID token for a job. */
export const oidcMintRequestSchema = z.object({
  type: z.literal('oidc.mint.request'),
  requestId: z.string().min(1),
  orchestratorId: z.string().min(1),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  audience: z.string().min(1).max(255),
  /**
   * Deferred fulfilment (attest-later): when true, the mint knowingly targets a
   * completed job and binds `statementHash` + `origin` into the token. Absent
   * for the live agent path. `orgId` is never on the wire — the Platform derives
   * it from the authenticated connection.
   */
  deferred: z.literal(true).optional(),
  /** SHA-256 of the frozen DSSE statement the deferred token binds to. */
  statementHash: z.string().optional(),
  /** Mint-timing origin for a deferred fulfilment (never `live` here). */
  origin: AttestationOrigin.extract(['deferred', 'offline-backfill']).optional(),
});
export type OidcMintRequest = z.infer<typeof oidcMintRequestSchema>;

/** Platform -> orchestrator: the minted token or a typed error (exactly one). */
export const oidcMintResponseSchema = z
  .object({
    type: z.literal('oidc.mint.response'),
    requestId: z.string().min(1),
    result: z
      .object({
        token: z.string().min(1),
        expiresIn: z.number().int().positive(),
        jti: z.string().min(1),
      })
      .optional(),
    error: z
      .object({
        code: OidcMintErrorCode,
        message: z.string(),
      })
      .optional(),
  })
  .refine((m) => (m.result === undefined) !== (m.error === undefined), {
    message: 'oidc.mint.response must carry exactly one of result | error',
  });
export type OidcMintResponse = z.infer<typeof oidcMintResponseSchema>;
