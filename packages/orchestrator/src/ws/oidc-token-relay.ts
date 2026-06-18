/**
 * Provenance ID-token relay (orchestrator side).
 *
 * Backs the `oidc.token.request` agent.api method: an agent asks for a
 * short-lived OIDC ID token for a job it is running; the orchestrator verifies
 * the agent owns that job, resolves its runId from its own dispatch state, and
 * relays a mint request to the Platform's token-mint endpoint over HTTPS using
 * the orchestrator's own `KICI_PLATFORM_TOKEN`. The agent never holds Platform
 * credentials and never asserts its own identity claims — the Platform derives
 * every identity claim from its own run/job rows.
 */

import {
  oidcTokenRequestParamsSchema,
  oidcTokenResultSchema,
  type OidcTokenResult,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';

/** 404 / 409: the run/job is missing on the Platform or the job is terminal. */
export class MintRejectedError extends Error {}
/** 503: provenance signing is not configured / the Platform is unavailable. */
export class MintUnavailableError extends Error {}
/** Any other non-2xx from the mint endpoint. */
export class MintRelayError extends Error {}

/**
 * Turn the Platform WS URL (`wss://host[/base]/ws`) into its HTTP base
 * (`https://host[/base]`). Maps the scheme and strips a trailing `/ws` while
 * preserving the host and any basePath in front of it.
 */
export function deriveHttpBaseFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  let path = url.pathname.replace(/\/ws\/?$/, '');
  if (path === '/') path = '';
  return `${url.origin}${path}`;
}

export interface RequestMintArgs {
  httpBase: string;
  token: string;
  orchestratorId: string;
  runId: string;
  jobId: string;
  audience: string;
}

/**
 * Call the Platform token-mint endpoint over HTTPS using the orchestrator's
 * Platform token. Maps non-2xx responses to typed errors so the agent always
 * sees a clear message instead of a raw 5xx body.
 */
export async function requestMint(args: RequestMintArgs): Promise<OidcTokenResult> {
  const res = await fetch(
    `${args.httpBase}/internal/orchestrator/${args.orchestratorId}/mint-id-token`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${args.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: args.runId, job_id: args.jobId, audience: args.audience }),
    },
  );
  if (res.status === 404 || res.status === 409) {
    throw new MintRejectedError(`token mint rejected (${res.status})`);
  }
  if (res.status === 503) {
    throw new MintUnavailableError('provenance signing is not configured on the Platform');
  }
  if (!res.ok) {
    throw new MintRelayError(`token mint failed (${res.status})`);
  }
  const json = (await res.json()) as { token: string; expires_in: number; jti: string };
  return oidcTokenResultSchema.parse({
    token: json.token,
    expiresIn: json.expires_in,
    jti: json.jti,
  });
}

export interface OidcTokenHandlerDeps {
  dispatcher: {
    resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
  };
  platformToken: string;
  platformHttpBase: string;
  orchestratorId: string;
}

/**
 * Build the agent.api handler for `OIDC_TOKEN_REQUEST_METHOD`. Validates the
 * params, verifies the agent owns the named job (resolving its runId from the
 * dispatcher), and relays a mint request to the Platform. A job the agent does
 * not own is rejected without ever contacting the Platform.
 */
export function createOidcTokenHandler(
  deps: OidcTokenHandlerDeps,
): (agentId: string, params: Record<string, unknown>) => Promise<OidcTokenResult> {
  return async (agentId, params) => {
    const { jobId, audience } = oidcTokenRequestParamsSchema.parse(params);
    const owned = deps.dispatcher.resolveOwnedJob(agentId, jobId);
    if (!owned) {
      throw new MintRejectedError(`job ${jobId} not owned by agent ${agentId}`);
    }
    return requestMint({
      httpBase: deps.platformHttpBase,
      token: deps.platformToken,
      orchestratorId: deps.orchestratorId,
      runId: owned.runId,
      jobId,
      audience,
    });
  };
}
