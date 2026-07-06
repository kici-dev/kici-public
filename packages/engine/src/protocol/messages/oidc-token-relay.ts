import { z } from 'zod';
import { AttestationOrigin } from '../../provenance/attestation-origin.js';

/**
 * agent.api method name for the provenance ID-token relay.
 *
 * Single source of truth: both the orchestrator's relay-handler registration
 * and the SDK `ctx.kici.oidc.token()` wrapper import this constant, so the
 * wire method name lives in exactly one place.
 */
export const OIDC_TOKEN_REQUEST_METHOD = 'oidc.token.request';

/**
 * Params an agent sends with an OIDC_TOKEN_REQUEST_METHOD call. The agent
 * supplies only the job it is running plus the requested token audience; the
 * orchestrator binds the mint to the job the agent actually owns and derives
 * every identity claim server-side, so the agent never asserts a repo/ref.
 */
export const oidcTokenRequestParamsSchema = z.object({
  jobId: z.string().min(1),
  audience: z.string().min(1).max(255),
});
export type OidcTokenRequestParams = z.infer<typeof oidcTokenRequestParamsSchema>;

// The 3-way mint error contract lives with the WS-RPC mint message
// (`oidc-mint.ts`); re-export it so this file stays the single import surface
// for the relay contract.
export { OidcMintErrorCode } from './oidc-mint.js';
export type { OidcMintErrorCode as OidcMintErrorCodeType } from './oidc-mint.js';

/** A successfully minted ID token bound to a job. */
export const oidcMintedTokenSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
  jti: z.string(),
});
export type OidcMintedToken = z.infer<typeof oidcMintedTokenSchema>;

/**
 * Result the orchestrator returns to the agent: either the minted short-lived
 * JWT, or — when the mint failed transiently (`unavailable`/`failed`, never
 * `rejected`) — a `deferred` signal so the agent freezes the statement and
 * reports it for later fulfilment. A permanent `rejected` is thrown, never
 * returned, so it is not part of this union.
 */
export const oidcTokenResultSchema = z.union([
  oidcMintedTokenSchema,
  z.object({
    deferred: z.literal(true),
    code: z.enum(['unavailable', 'failed']),
  }),
]);
export type OidcTokenResult = z.infer<typeof oidcTokenResultSchema>;

/** Extra fields a deferred *fulfilment* mint carries (orchestrator -> Platform). */
export const deferredMintParamsSchema = z.object({
  statementHash: z.string(),
  origin: AttestationOrigin.extract(['deferred', 'offline-backfill']),
});
export type DeferredMintParams = z.infer<typeof deferredMintParamsSchema>;
