import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import { LocalDevSigner, KICI_LOCAL_ISSUER } from './local-dev-signer.js';
import {
  mintLocalIdToken,
  createLocalOidcTokenHandler,
  LocalMintJobNotActiveError,
  LocalMintRejectedError,
  LOCAL_ORG_ID,
} from './local-mint.js';

// Minimal fake Kysely surface: only the two selects mintLocalIdToken issues.
type Row = Record<string, unknown>;
function fakeDb(runs: Row[], jobs: Row[]): any {
  const table = (rows: Row[]) => {
    const state = { rows, filters: [] as Array<[string, unknown]> };
    const chain: any = {
      select: () => chain,
      where: (col: string, _op: string, val: unknown) => {
        state.filters.push([col, val]);
        return chain;
      },
      executeTakeFirst: async () =>
        state.rows.find((r) => state.filters.every(([c, v]) => r[c] === v)),
    };
    return chain;
  };
  return {
    selectFrom: (t: string) => (t === 'execution_runs' ? table(runs) : table(jobs)),
  };
}

let signer: LocalDevSigner;
let publicJwk: JWK;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  signer = await LocalDevSigner.fromPrivateJwk(privateKey.export({ format: 'jwk' }) as JWK);
  publicJwk = signer.getPublicJwk();
});

const RUN = {
  run_id: 'run-1',
  repo_identifier: 'owner/repo',
  ref: 'refs/heads/main',
  sha: 'abc123',
  workflow_name: 'ci',
  provider: 'local',
  local_working_tree: false,
};
const JOB = { run_id: 'run-1', job_id: 'job-1', status: 'running' };

describe('mintLocalIdToken', () => {
  it('mints a kici-local token verifiable against the signer JWKS', async () => {
    const db = fakeDb([RUN], [JOB]);
    const res = await mintLocalIdToken(
      { db, signer, orchestratorId: 'orch-local' },
      { runId: 'run-1', jobId: 'job-1', audience: 'kici-provenance' },
    );
    expect(res.claims.iss).toBe(KICI_LOCAL_ISSUER);
    expect(res.claims.org_id).toBe(LOCAL_ORG_ID);
    expect(res.claims.kici_run_id).toBe('run-1');
    expect(res.claims.kici_job_id).toBe('job-1');
    expect(res.claims.repository).toBe('owner/repo');
    expect(res.claims.orchestrator_id).toBe('orch-local');

    const { payload, protectedHeader } = await jwtVerify(
      res.token,
      createLocalJWKSet({ keys: [publicJwk as Record<string, unknown>] }),
      { issuer: KICI_LOCAL_ISSUER, audience: 'kici-provenance' },
    );
    expect(protectedHeader.kid).toBe(signer.getKid());
    expect(payload.iss).toBe(KICI_LOCAL_ISSUER);
  });

  it('does NOT verify against the prod issuer (kici-local can never masquerade)', async () => {
    const db = fakeDb([RUN], [JOB]);
    const res = await mintLocalIdToken(
      { db, signer, orchestratorId: 'orch-local' },
      { runId: 'run-1', jobId: 'job-1', audience: 'kici-provenance' },
    );
    await expect(
      jwtVerify(res.token, createLocalJWKSet({ keys: [publicJwk as Record<string, unknown>] }), {
        issuer: 'https://api.kici.dev',
        audience: 'kici-provenance',
      }),
    ).rejects.toThrow(); // issuer-pin mismatch — structural reject-prod
  });

  it('rejects a terminal (completed) job', async () => {
    const db = fakeDb([RUN], [{ ...JOB, status: 'success' }]);
    await expect(
      mintLocalIdToken(
        { db, signer, orchestratorId: 'orch-local' },
        { runId: 'run-1', jobId: 'job-1', audience: 'kici-provenance' },
      ),
    ).rejects.toBeInstanceOf(LocalMintJobNotActiveError);
  });
});

describe('createLocalOidcTokenHandler', () => {
  const dispatcher = {
    resolveOwnedJob: (agentId: string, jobId: string) =>
      agentId === 'agent-1' && jobId === 'job-1' ? { runId: 'run-1' } : undefined,
  };

  it('mints for an owned job', async () => {
    const handler = createLocalOidcTokenHandler({
      dispatcher,
      mint: { db: fakeDb([RUN], [JOB]), signer, orchestratorId: 'orch-local' },
    });
    const result = (await handler('agent-1', { jobId: 'job-1', audience: 'kici-provenance' })) as {
      token: string;
    };
    expect(typeof result.token).toBe('string');
  });

  it('rejects a job the agent does not own without minting', async () => {
    const handler = createLocalOidcTokenHandler({
      dispatcher,
      mint: { db: fakeDb([RUN], [JOB]), signer, orchestratorId: 'orch-local' },
    });
    await expect(
      handler('agent-evil', { jobId: 'job-1', audience: 'kici-provenance' }),
    ).rejects.toBeInstanceOf(LocalMintRejectedError);
  });
});
