import { describe, expect, it } from 'vitest';
import type { OrchestratorSigningKeyRow } from '../db/types.js';
import { createVerifyAttestationRoutes } from './verify-attestation.js';

function repoWith(rows: OrchestratorSigningKeyRow[]): {
  listTrusted: () => Promise<OrchestratorSigningKeyRow[]>;
} {
  return { listTrusted: async () => rows };
}

describe('createVerifyAttestationRoutes', () => {
  it('503s when signing is disabled', async () => {
    const app = createVerifyAttestationRoutes({
      issuer: undefined,
      repo: repoWith([]),
      enabled: false,
    });
    const res = await app.request('/v1/verify-attestation', {
      method: 'POST',
      body: JSON.stringify({ bundle: {} }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(503);
  });

  it('400s on missing bundle', async () => {
    const app = createVerifyAttestationRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([]),
      enabled: true,
    });
    const res = await app.request('/v1/verify-attestation', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('returns a structured verified:false for a bogus bundle (never throws)', async () => {
    const app = createVerifyAttestationRoutes({
      issuer: 'https://orch.example',
      repo: repoWith([]),
      enabled: true,
    });
    const res = await app.request('/v1/verify-attestation', {
      method: 'POST',
      body: JSON.stringify({ bundle: { not: 'a bundle' } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean; failures: string[] };
    expect(body.verified).toBe(false);
    expect(body.failures.length).toBeGreaterThan(0);
  });
});
