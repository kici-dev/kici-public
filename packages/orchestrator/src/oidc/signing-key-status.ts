import { z } from 'zod';

/**
 * Lifecycle of an orchestrator provenance signing key
 * (orchestrator_signing_keys.status). Mirrors the Platform's status model so the
 * rotation / retire / revoke semantics are identical.
 *
 *  - active   — the one current signing key.
 *  - retiring — just rotated out; still in the JWKS during the overlap window
 *               (in-flight short-lived JWTs minted just before rotation verify).
 *  - retired  — no longer signs, but its public half STAYS in the trust root so
 *               historical attestations it signed remain verifiable. retired != removed.
 *  - revoked  — compromised; REMOVED from the trust root; everything it signed is distrusted.
 */
export const SigningKeyStatus = z.enum(['active', 'retiring', 'retired', 'revoked']);
export type SigningKeyStatus = z.infer<typeof SigningKeyStatus>;

/** Statuses served in the JWKS / trusted for verification (everything except revoked). */
export const TRUSTED_STATUSES: readonly SigningKeyStatus[] = ['active', 'retiring', 'retired'];
