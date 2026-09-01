/**
 * Selects which OIDC-mint handler backs `OIDC_TOKEN_REQUEST_METHOD` — the
 * anti-forgery choke point for signed identity.
 *
 * The rule (enforced here, unit-tested in `oidc-mint-registration.test.ts`):
 *
 *  1. **Orchestrator-owned signing** (a resolved signer + the orchestrator's own
 *     provenance issuer) → the **orchestrator** handler, minting + signing
 *     locally. Wins whenever signing is configured — even Platform-connected —
 *     because the orchestrator is now the root of trust.
 *  2. **Platform-connected** (platformUrl + token + client), no signer → the
 *     **relay** handler, minting via the hosted Platform (the DEPRECATED path,
 *     kept for orchestrators with no signer configured).
 *  3. **Offline local dev plane** (independent identity + a local signer, AND
 *     NOT Platform-connected) → the **local** dev-signed handler (`kici-local`).
 *  4. None → **no** registration (the method returns "unknown method").
 *
 * The identity claims are always read SERVER-SIDE from the orchestrator's own
 * rows and job ownership from dispatch state — no forgeable agent-asserted mint
 * path appears in any case.
 */
import type { Kysely } from 'kysely';
import type { OidcTokenResult } from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import type { Database } from '../db/types.js';
import { createOidcTokenHandler, type MintPlatformClient } from '../ws/oidc-token-relay.js';
import { createLocalOidcTokenHandler, type LocalMintOwnershipResolver } from './local-mint.js';
import {
  createOrchestratorOidcTokenHandler,
  ORCHESTRATOR_ID_TOKEN_TTL_SECONDS,
} from './orchestrator-mint.js';
import type { LocalSigner } from './local-dev-signer.js';
import type { Signer } from './signer.js';

export type OidcMintHandler = (
  agentId: string,
  params: Record<string, unknown>,
) => Promise<OidcTokenResult>;

export interface OidcMintRegistration {
  /**
   * `orchestrator` = orchestrator-owned signing (the new root of trust);
   * `relay` = Platform-minted (deprecated); `local` = offline dev-signed.
   */
  kind: 'orchestrator' | 'relay' | 'local';
  handler: OidcMintHandler;
}

export interface OidcMintRegistrationInput {
  platformUrl?: string;
  platformToken?: string;
  platformClient?: MintPlatformClient;
  independentIdentity: boolean;
  localOidcSigner?: LocalSigner;
  /**
   * Lazily resolve the orchestrator's own provenance signer (Task 7 reconcile).
   * Present whenever orchestrator-owned signing is configured; the signer itself
   * is resolved on first mint (leader-election-race-safe).
   */
  resolveOrchestratorSigner?: () => Promise<Signer | null>;
  /** The orchestrator's own provenance issuer identity (config.provenanceSigningIssuer). */
  provenanceSigningIssuer?: string;
  dispatcher: LocalMintOwnershipResolver & {
    resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
  };
  db: Kysely<Database>;
  orchestratorId: string;
  /**
   * Test-only fault-injection predicate forwarded to the relay mint handler,
   * supplied only by the build-time test double. Only ever defers — the
   * anti-forgery choke point is preserved. Undefined (the shipped default) means
   * no fault injection.
   */
  initialMintFault?: (audience: string) => boolean;
}

/** Decide which mint handler (if any) backs `OIDC_TOKEN_REQUEST_METHOD`. */
export function selectOidcMintRegistration(
  input: OidcMintRegistrationInput,
): OidcMintRegistration | undefined {
  // Orchestrator-owned signing ALWAYS wins — it is the root of trust now.
  if (input.resolveOrchestratorSigner && input.provenanceSigningIssuer) {
    return {
      kind: 'orchestrator',
      handler: createOrchestratorOidcTokenHandler({
        dispatcher: input.dispatcher,
        resolveSigner: input.resolveOrchestratorSigner,
        mint: {
          db: input.db,
          issuer: input.provenanceSigningIssuer,
          orchestratorId: input.orchestratorId,
          ttlSeconds: ORCHESTRATOR_ID_TOKEN_TTL_SECONDS,
        },
      }),
    };
  }
  // Deprecated Platform relay — only when no orchestrator signer is configured.
  if (input.platformUrl && input.platformToken && input.platformClient) {
    return {
      kind: 'relay',
      handler: createOidcTokenHandler({
        dispatcher: input.dispatcher,
        platformClient: input.platformClient,
        orchestratorId: input.orchestratorId,
        initialMintFault: input.initialMintFault,
      }),
    };
  }
  if (input.independentIdentity && input.localOidcSigner) {
    return {
      kind: 'local',
      handler: createLocalOidcTokenHandler({
        dispatcher: input.dispatcher,
        mint: {
          db: input.db,
          signer: input.localOidcSigner,
          orchestratorId: input.orchestratorId,
        },
      }),
    };
  }
  return undefined;
}
