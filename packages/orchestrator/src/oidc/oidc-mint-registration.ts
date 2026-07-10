/**
 * Selects which OIDC-mint handler backs `OIDC_TOKEN_REQUEST_METHOD` — the
 * anti-forgery choke point for dev-signed identity.
 *
 * The rule (enforced here, unit-tested in `oidc-mint-registration.test.ts`):
 *
 *  1. **Platform-connected** (platformUrl + token + client) → the **relay**
 *     handler, minting via the hosted Platform exactly as today.
 *  2. **Offline local dev plane** (independent identity + a local signer, AND
 *     NOT Platform-connected) → the **local** dev-signed handler (`kici-local`).
 *  3. Neither → **no** registration (the method returns "unknown method").
 *
 * Case 1 is checked FIRST, so the local signer is UNREACHABLE whenever a
 * Platform connection exists — even if `KICI_INDEPENDENT_IDENTITY` is somehow
 * also set. This guarantees no new forgeable mint path appears on a
 * Platform-connected orchestrator.
 */
import type { Kysely } from 'kysely';
import type { OidcTokenResult } from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import type { Database } from '../db/types.js';
import { createOidcTokenHandler, type MintPlatformClient } from '../ws/oidc-token-relay.js';
import { createLocalOidcTokenHandler, type LocalMintOwnershipResolver } from './local-mint.js';
import type { LocalSigner } from './local-dev-signer.js';

export type OidcMintHandler = (
  agentId: string,
  params: Record<string, unknown>,
) => Promise<OidcTokenResult>;

export interface OidcMintRegistration {
  /** `relay` = Platform-minted; `local` = offline dev-signed (`kici-local`). */
  kind: 'relay' | 'local';
  handler: OidcMintHandler;
}

export interface OidcMintRegistrationInput {
  platformUrl?: string;
  platformToken?: string;
  platformClient?: MintPlatformClient;
  independentIdentity: boolean;
  localOidcSigner?: LocalSigner;
  dispatcher: LocalMintOwnershipResolver & {
    resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined;
  };
  db: Kysely<Database>;
  orchestratorId: string;
  testMode: boolean;
  testMintDeferAudience?: string;
  testMintRejectAudience?: string;
}

/** Decide which mint handler (if any) backs `OIDC_TOKEN_REQUEST_METHOD`. */
export function selectOidcMintRegistration(
  input: OidcMintRegistrationInput,
): OidcMintRegistration | undefined {
  // Platform-connected ALWAYS wins — the local signer is never consulted.
  if (input.platformUrl && input.platformToken && input.platformClient) {
    return {
      kind: 'relay',
      handler: createOidcTokenHandler({
        dispatcher: input.dispatcher,
        platformClient: input.platformClient,
        orchestratorId: input.orchestratorId,
        testMode: input.testMode,
        testMintDeferAudience: input.testMintDeferAudience,
        testMintRejectAudience: input.testMintRejectAudience,
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
