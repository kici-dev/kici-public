import { z } from 'zod';

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

/**
 * Result the orchestrator returns to the agent: the minted short-lived JWT
 * plus its lifetime and identifier.
 */
export const oidcTokenResultSchema = z.object({
  token: z.string(),
  expiresIn: z.number().int().positive(),
  jti: z.string(),
});
export type OidcTokenResult = z.infer<typeof oidcTokenResultSchema>;
