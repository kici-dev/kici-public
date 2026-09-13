/**
 * Provenance ID-token relay (orchestrator side).
 *
 * @deprecated The Platform-rooted identity mint is hard-deprecated in favor of
 * orchestrator-owned signing (`oidc/orchestrator-mint.ts`). This relay is
 * registered ONLY when the orchestrator has NO provenance signer configured
 * (`selectOidcMintRegistration` prefers the orchestrator-owned mint whenever
 * `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` is set). It is kept wire-compatible for
 * the mixed-version rollout window; the `oidc.mint.*` RPC shim is removed at
 * v1.0. Existing Platform-signed bundles keep verifying forever (the Platform
 * JWKS stays published). See docs/user/deprecations.md.
 *
 * Backs the `oidc.token.request` agent.api method: an agent asks for a
 * short-lived OIDC ID token for a job it is running; the orchestrator verifies
 * the agent owns that job, resolves its runId from its own dispatch state, and
 * relays a mint request to the Platform over the authenticated orchestrator↔
 * Platform WebSocket (orchestrator-initiated RPC). The agent never holds
 * Platform credentials and never asserts its own identity claims — the Platform
 * derives every identity claim from its own run/job rows.
 */

import {
  oidcTokenRequestParamsSchema,
  oidcTokenResultSchema,
  type OidcTokenResult,
  type DeferredMintParams,
} from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import type { OidcMintResponse } from '@kici-dev/engine/protocol/messages/oidc-mint';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'oidc-token-relay' });

/** rejected: the run/job is missing on the Platform or the job is terminal. */
export class MintRejectedError extends Error {}
/** unavailable: provenance signing is not configured / the Platform is unavailable. */
export class MintUnavailableError extends Error {}
/** Any other failure (transport or Platform-side). */
export class MintRelayError extends Error {}

/** Minimal surface the relay needs from the Platform WS client. */
export interface MintPlatformClient {
  sendRequestAndAwait<Res>(
    type: 'oidc.mint.request',
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Res>;
}

export interface RequestMintArgs {
  platformClient: MintPlatformClient;
  orchestratorId: string;
  runId: string;
  jobId: string;
  audience: string;
  /**
   * Deferred *fulfilment* mint: when set, the request knowingly targets a
   * completed (terminal) job and binds the frozen statement hash + origin so
   * the Platform relaxes its live-job check and stamps the mint-timing marker.
   * The live agent path never sets this.
   */
  deferred?: DeferredMintParams;
}

/**
 * Send a mint request over the WS and map the typed response to either a result
 * or one of the three error classes. The user-facing strings are produced here
 * (client-side) so they stay stable regardless of Platform wording.
 */
export async function requestMint(args: RequestMintArgs): Promise<OidcTokenResult> {
  let res: OidcMintResponse;
  try {
    res = await args.platformClient.sendRequestAndAwait<OidcMintResponse>('oidc.mint.request', {
      orchestratorId: args.orchestratorId,
      runId: args.runId,
      jobId: args.jobId,
      audience: args.audience,
      ...(args.deferred
        ? {
            deferred: true,
            statementHash: args.deferred.statementHash,
            origin: args.deferred.origin,
          }
        : {}),
    });
  } catch (err) {
    throw new MintRelayError(
      `token mint relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.error) {
    if (res.error.code === 'rejected') throw new MintRejectedError(res.error.message);
    if (res.error.code === 'unavailable') {
      throw new MintUnavailableError('provenance signing is not configured on the Platform');
    }
    throw new MintRelayError(res.error.message);
  }
  if (!res.result) throw new MintRelayError('token mint response missing result');
  return oidcTokenResultSchema.parse({
    token: res.result.token,
    expiresIn: res.result.expiresIn,
    jti: res.result.jti,
  });
}

export interface OidcTokenHandlerDeps {
  dispatcher: {
    resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
  };
  platformClient: MintPlatformClient;
  orchestratorId: string;
  /**
   * Test-only fault-injection predicate over the requested OIDC `audience`,
   * supplied only by the build-time test double. Returning `true` short-circuits
   * the *initial* mint to a transient defer BEFORE the real Platform relay is
   * contacted — it can only defer/reject, never forge or weaken a signature.
   * Undefined (the shipped default) means no fault injection.
   */
  initialMintFault?: (audience: string) => boolean;
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
    // Test-only fault injection: the build-time test double supplies
    // `initialMintFault` to force the initial agent mint to defer for a marker
    // audience, so an E2E can exercise the deferred-attestation retry path with
    // a REAL run. The predicate can only defer/reject BEFORE the real Platform
    // relay is contacted — never forge or weaken a signature. The shipped
    // orchestrator leaves it undefined, so this branch is never reached.
    if (deps.initialMintFault?.(audience)) {
      logger.warn('mint-defer fault-injection ACTIVE via injected policy.', {
        jobId,
        audience,
      });
      return { deferred: true, code: 'unavailable' };
    }
    try {
      return await requestMint({
        platformClient: deps.platformClient,
        orchestratorId: deps.orchestratorId,
        runId: owned.runId,
        jobId,
        audience,
      });
    } catch (err) {
      // A transient mint failure DEFERS: the agent freezes + DSSE-signs the
      // statement and the job stays green. A permanent rejection still fails
      // the step (rethrown below).
      if (err instanceof MintUnavailableError) return { deferred: true, code: 'unavailable' };
      if (err instanceof MintRelayError) return { deferred: true, code: 'failed' };
      throw err;
    }
  };
}
