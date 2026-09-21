import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DbSigner } from '../oidc/db-signer.js';
import { createRetrierMintRequest, PROVENANCE_ISSUER_UNCONFIGURED_HINT } from './retrier-mint.js';

const ARGS = {
  orchestratorId: 'orch-1',
  runId: 'run-1',
  jobId: 'job-1',
  audience: 'kici-provenance',
  deferred: { statementHash: 'f'.repeat(64), origin: 'deferred' as const },
};

/** A db that throws on any read: the unconfigured path must never reach it. */
const untouchableDb = new Proxy({} as Kysely<Database>, {
  get: (_t, prop) => {
    throw new Error(`db.${String(prop)} reached from an unconfigured mint`);
  },
});

describe('createRetrierMintRequest', () => {
  it('defers as unavailable with the operator hint when no provenance issuer is configured', async () => {
    // fails-when: the unconfigured case mints, throws, or defers without naming
    // the env var the operator has to set.
    const requestMint = createRetrierMintRequest({
      db: untouchableDb,
      provenanceSigning: undefined,
    });

    await expect(requestMint(ARGS)).resolves.toEqual({
      deferred: true,
      code: 'unavailable',
      operatorHint: PROVENANCE_ISSUER_UNCONFIGURED_HINT,
    });
    expect(PROVENANCE_ISSUER_UNCONFIGURED_HINT).toContain('KICI_ORCHESTRATOR_PROVENANCE_ISSUER');
  });

  it('defers without the hint while a configured signer is still being reconciled', async () => {
    // breaks-if-wrong: a transient key-reconcile defer is not an operator
    // problem, so it must carry no hint and must not touch the database.
    const resolveSigner = vi.fn(async () => null);
    const requestMint = createRetrierMintRequest({
      db: untouchableDb,
      provenanceSigning: { issuer: 'https://orch.example', resolveSigner },
    });

    await expect(requestMint(ARGS)).resolves.toEqual({ deferred: true, code: 'unavailable' });
    expect(resolveSigner).toHaveBeenCalledTimes(1);
  });

  it('short-circuits to a terminal rejection under the test-only fault predicate, before the signer', async () => {
    const { signer } = await DbSigner.generate('0'.repeat(64));
    const resolveSigner = vi.fn(async () => signer);
    const requestMint = createRetrierMintRequest({
      db: untouchableDb,
      provenanceSigning: { issuer: 'https://orch.example', resolveSigner },
      remintReject: (audience) => audience === 'kici-provenance',
    });

    const result = await requestMint(ARGS);
    expect('rejected' in result && result.rejected).toBe(true);
    expect(resolveSigner).not.toHaveBeenCalled();
  });
});
