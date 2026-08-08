import { describe, expect, it } from 'vitest';
import { decodeJwt, importJWK } from 'jose';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DbSigner } from './db-signer.js';
import {
  createOrchestratorOidcTokenHandler,
  mintOrchestratorIdToken,
  OrchestratorMintJobNotActiveError,
} from './orchestrator-mint.js';

const KEY = '0'.repeat(64);
const ISSUER = 'https://orch.example';

/**
 * A tiny fake Kysely returning canned rows. `execution_runs` → the run; a
 * `sources` row supplies the org (resolveOrgId reads customer_id by routing_key);
 * `execution_jobs` → the job. Unmapped tables (generic_webhook_sources,
 * remote_sources) return undefined so resolveOrgId falls through in order.
 */
function fakeDb(rows: {
  run?: unknown;
  job?: unknown;
  sourceCustomerId?: string;
}): Kysely<Database> {
  const chain = (row: unknown): unknown => {
    const c: Record<string, unknown> = {
      select: () => c,
      where: () => c,
      executeTakeFirst: async () => row,
    };
    return c;
  };
  return {
    selectFrom: (table: string) => {
      if (table === 'execution_runs') return chain(rows.run);
      if (table === 'execution_jobs') return chain(rows.job);
      if (table === 'sources')
        return chain(rows.sourceCustomerId ? { customer_id: rows.sourceCustomerId } : undefined);
      return chain(undefined);
    },
  } as unknown as Kysely<Database>;
}

const RUN = {
  run_id: 'run-1',
  routing_key: 'github:1',
  repo_identifier: 'acme/app',
  ref: 'refs/heads/main',
  sha: 'abc123',
  workflow_name: 'build',
  provider: 'github',
  local_working_tree: false,
};

async function verifySignature(token: string, signer: DbSigner): Promise<boolean> {
  const [h, p, s] = token.split('.');
  const pub = (await importJWK(await signer.getPublicJwk(), 'ES256')) as CryptoKey;
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pub,
    Buffer.from(s, 'base64url') as unknown as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as unknown as BufferSource,
  );
}

describe('mintOrchestratorIdToken', () => {
  it('mints a token signed by the orchestrator key with server-truth claims (real issuer + org)', async () => {
    const { signer } = await DbSigner.generate(KEY);
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'running' },
      sourceCustomerId: 'org-acme',
    });
    const { token, claims } = await mintOrchestratorIdToken(
      { db, signer, issuer: ISSUER, orchestratorId: 'orch-1' },
      { runId: 'run-1', jobId: 'job-1', audience: 'kici-provenance' },
    );

    expect(await verifySignature(token, signer)).toBe(true);
    const decoded = decodeJwt(token);
    expect(decoded.iss).toBe(ISSUER);
    expect(decoded.kici_run_id).toBe('run-1');
    expect(decoded.kici_job_id).toBe('job-1');
    expect(decoded.org_id).toBe('org-acme'); // real org, NOT __default__
    expect(decoded.repository).toBe('acme/app');
    expect(claims.attestation_origin).toBe('live');
    expect(claims.statement_hash).toBeNull();
  });

  it('rejects a terminal job for a live mint', async () => {
    const { signer } = await DbSigner.generate(KEY);
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'success' },
      sourceCustomerId: 'org-acme',
    });
    await expect(
      mintOrchestratorIdToken(
        { db, signer, issuer: ISSUER, orchestratorId: 'orch-1' },
        { runId: 'run-1', jobId: 'job-1', audience: 'kici-provenance' },
      ),
    ).rejects.toBeInstanceOf(OrchestratorMintJobNotActiveError);
  });

  it('a deferred fulfilment mints for a terminal job and stamps the origin + statement hash', async () => {
    const { signer } = await DbSigner.generate(KEY);
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'success' },
      sourceCustomerId: 'org-acme',
    });
    const { claims } = await mintOrchestratorIdToken(
      { db, signer, issuer: ISSUER, orchestratorId: 'orch-1' },
      {
        runId: 'run-1',
        jobId: 'job-1',
        audience: 'kici-provenance',
        deferred: { statementHash: 'f'.repeat(64), origin: 'deferred' },
      },
    );
    expect(claims.attestation_origin).toBe('deferred');
    expect(claims.statement_hash).toBe('f'.repeat(64));
  });

  it('handler rejects a job the agent does not own without minting', async () => {
    const { signer } = await DbSigner.generate(KEY);
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'running' },
      sourceCustomerId: 'org-acme',
    });
    const handler = createOrchestratorOidcTokenHandler({
      dispatcher: { resolveOwnedJob: () => undefined },
      resolveSigner: async () => signer,
      mint: { db, issuer: ISSUER, orchestratorId: 'orch-1' },
    });
    await expect(
      handler('agent-x', { jobId: 'job-1', audience: 'kici-provenance' }),
    ).rejects.toThrow(/not owned/);
  });

  it('handler mints for an owned job', async () => {
    const { signer } = await DbSigner.generate(KEY);
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'running' },
      sourceCustomerId: 'org-acme',
    });
    const handler = createOrchestratorOidcTokenHandler({
      dispatcher: { resolveOwnedJob: () => ({ runId: 'run-1' }) },
      resolveSigner: async () => signer,
      mint: { db, issuer: ISSUER, orchestratorId: 'orch-1' },
    });
    const result = await handler('agent-x', { jobId: 'job-1', audience: 'kici-provenance' });
    expect('token' in result && result.token).toBeTruthy();
  });

  it('handler defers (never crashes) when the signer is not yet resolvable', async () => {
    const db = fakeDb({
      run: RUN,
      job: { run_id: 'run-1', job_id: 'job-1', status: 'running' },
      sourceCustomerId: 'org-acme',
    });
    const handler = createOrchestratorOidcTokenHandler({
      dispatcher: { resolveOwnedJob: () => ({ runId: 'run-1' }) },
      resolveSigner: async () => null,
      mint: { db, issuer: ISSUER, orchestratorId: 'orch-1' },
    });
    const result = await handler('agent-x', { jobId: 'job-1', audience: 'kici-provenance' });
    expect(result).toEqual({ deferred: true, code: 'unavailable' });
  });
});
