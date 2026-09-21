/**
 * The deferred re-mint the attestation retrier asks for.
 *
 * A deferred attestation is fulfilled with the orchestrator's own signing key,
 * bound to the frozen statement hash. This module turns the orchestrator's
 * signing configuration into the retrier's `requestMint` dependency.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { Signer } from '../oidc/signer.js';
import {
  mintOrchestratorIdToken,
  OrchestratorMintJobNotFoundError,
  OrchestratorMintRunNotFoundError,
} from '../oidc/orchestrator-mint.js';
import type { AttestationRetrierDeps, RetrierMintResult } from './attestation-retrier.js';

/**
 * What the operator has to do when no provenance signer is configured at all.
 * Surfaced once per retrier drain, never per row — the queue does not shrink
 * until the issuer is set, so a per-row line would repeat every minute.
 */
export const PROVENANCE_ISSUER_UNCONFIGURED_HINT =
  'No provenance signer is configured, so deferred attestations cannot be completed. Set KICI_ORCHESTRATOR_PROVENANCE_ISSUER on the orchestrator.';

export interface RetrierMintDeps {
  db: Kysely<Database>;
  /** `undefined` when the orchestrator has no provenance issuer configured. */
  provenanceSigning: { issuer: string; resolveSigner: () => Promise<Signer | null> } | undefined;
  /**
   * Test-only fault injection: the build-time test double supplies a predicate
   * over the audience that forces a TERMINAL rejection, so an E2E can exercise
   * the markRejected → gauge-exclusion → `--include-rejected` re-arm cycle with
   * a real deferred row. It returns before the real mint, so the signing choke
   * point is preserved. The shipped orchestrator leaves it undefined.
   */
  remintReject?: (audience: string) => boolean;
}

export function createRetrierMintRequest(
  deps: RetrierMintDeps,
): AttestationRetrierDeps['requestMint'] {
  return async (a): Promise<RetrierMintResult> => {
    if (deps.remintReject?.(a.audience)) {
      return { rejected: true, reason: 'test-only mint-reject fault-injection (injected policy)' };
    }
    // No signer configured at all is a standing condition the operator has to
    // fix; a key still being reconciled is a transient defer. Both leave the row
    // queued for the next tick, only the first carries the hint.
    const signing = deps.provenanceSigning;
    if (!signing) {
      return {
        deferred: true,
        code: 'unavailable',
        operatorHint: PROVENANCE_ISSUER_UNCONFIGURED_HINT,
      };
    }
    const signer = await signing.resolveSigner();
    if (!signer) return { deferred: true, code: 'unavailable' };
    try {
      const minted = await mintOrchestratorIdToken(
        { db: deps.db, signer, issuer: signing.issuer, orchestratorId: a.orchestratorId },
        { runId: a.runId, jobId: a.jobId, audience: a.audience, deferred: a.deferred },
      );
      return { token: minted.token, expiresIn: minted.expiresIn, jti: minted.jti };
    } catch (err) {
      // A run or job that no longer exists is terminal — surfaced so the retrier
      // stamps rejected_at and stops re-attempting it. Any other failure is
      // transient and re-thrown, so the retrier records the attempt and retries.
      if (
        err instanceof OrchestratorMintRunNotFoundError ||
        err instanceof OrchestratorMintJobNotFoundError
      ) {
        return { rejected: true, reason: err.message };
      }
      throw err;
    }
  };
}
