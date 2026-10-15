import { z } from 'zod';

/**
 * agent.api method name for the provenance ID-token request, imported by both
 * the orchestrator's mint-handler registration and the SDK `ctx.kici.oidc.token()`.
 */
export const OIDC_TOKEN_REQUEST_METHOD = 'oidc.token.request';

/**
 * The agent sends only its job and the audience; the orchestrator binds the
 * mint to the job the agent owns and derives every identity claim server-side,
 * so the agent never asserts a repo/ref.
 */
export const oidcTokenRequestParamsSchema = z.object({
  jobId: z.string().min(1),
  audience: z.string().min(1).max(255),
});
export type OidcTokenRequestParams = z.infer<typeof oidcTokenRequestParamsSchema>;

/** A successfully minted ID token bound to a job. */
export const oidcMintedTokenSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
  jti: z.string(),
});
export type OidcMintedToken = z.infer<typeof oidcMintedTokenSchema>;

/**
 * The minted short-lived JWT, or `deferred` when the mint failed transiently,
 * so the agent freezes the statement and reports it for later fulfilment. A
 * permanent `rejected` is thrown, never returned.
 */
export const oidcTokenResultSchema = z.union([
  oidcMintedTokenSchema,
  z.object({
    deferred: z.literal(true),
    code: z.enum(['unavailable', 'failed']),
  }),
]);
export type OidcTokenResult = z.infer<typeof oidcTokenResultSchema>;
