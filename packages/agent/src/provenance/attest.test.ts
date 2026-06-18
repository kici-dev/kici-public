import { describe, expect, it, vi } from 'vitest';
import { decodeJwt, importJWK } from 'jose';
import {
  KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
  kiciBundleSchema,
} from '@kici-dev/engine/provenance/bundle';
import { dssePae } from '@kici-dev/engine/provenance/dsse';
import { attestProvenance, subjectDigestString } from './attest.js';

// A minimal unsigned JWT carrying the claims the builder needs (decodeJwt does
// not verify, so an unsigned token is fine for the unit test).
function fakeToken() {
  const claims = {
    iss: 'https://issuer',
    repository: 'github.com/acme/api',
    ref: 'refs/heads/main',
    sha: 'deadbeef',
    workflow_ref: '.kici/workflows/release.ts@deadbeef',
    kici_run_id: 'run-1',
    kici_job_id: 'job-1',
    orchestrator_id: 'o',
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(claims)}.AAAA`;
}

describe('attestProvenance', () => {
  it('builds+signs+persists a bundle and returns its storage key', async () => {
    const getIdToken = vi
      .fn()
      .mockResolvedValue({ token: fakeToken(), expiresIn: 600, jti: 'run-1:job-1' });
    const persist = vi.fn().mockResolvedValue('provenance/run-1/job-1/abc.kici.json');

    const result = await attestProvenance(
      {
        getIdToken,
        persist,
        builderVersions: { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' },
        now: () => '2026-06-11T00:00:00.000Z',
      },
      {
        subject: { name: 'pkg:npm/x@1', digest: { sha256: 'a'.repeat(64) } },
        audience: 'kici-provenance',
      },
    );

    expect(result.storageKey).toBe('provenance/run-1/job-1/abc.kici.json');
    expect(result.subjectDigest).toBe('a'.repeat(64));
    expect(result.bundle.mediaType).toBe(KICI_PROVENANCE_BUNDLE_MEDIA_TYPE);
    expect(() => kiciBundleSchema.parse(result.bundle)).not.toThrow();
    expect(decodeJwt(result.bundle.verificationMaterial.identityToken).kici_run_id).toBe('run-1');
    expect(getIdToken).toHaveBeenCalledWith({ audience: 'kici-provenance' });
    expect(persist).toHaveBeenCalledOnce();

    // The DSSE signature verifies with the bundled ephemeral key.
    const key = (await importJWK(
      result.bundle.verificationMaterial.publicKey,
      'ES256',
    )) as CryptoKey;
    const statementBytes = Buffer.from(result.bundle.dsseEnvelope.payload, 'base64');
    const pae = dssePae(result.bundle.dsseEnvelope.payloadType, statementBytes);
    const sig = Buffer.from(result.bundle.dsseEnvelope.signatures[0].sig, 'base64');
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, pae)).toBe(
      true,
    );
  });

  it('defaults the audience to kici-provenance', async () => {
    const getIdToken = vi.fn().mockResolvedValue({ token: fakeToken(), expiresIn: 600, jti: 'j' });
    await attestProvenance(
      {
        getIdToken,
        persist: vi.fn().mockResolvedValue('k'),
        builderVersions: { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' },
      },
      { subject: { name: 'x', digest: { sha256: 'c'.repeat(64) } } },
    );
    expect(getIdToken).toHaveBeenCalledWith({ audience: 'kici-provenance' });
  });

  it('rejects a subject with an empty digest set without minting a token or persisting', async () => {
    const getIdToken = vi.fn();
    const persist = vi.fn();
    await expect(
      attestProvenance(
        {
          getIdToken,
          persist,
          builderVersions: { 'kici-agent': '0.7.1', 'kici-orchestrator': '0.7.1' },
        },
        { subject: { name: 'x', digest: {} } },
      ),
    ).rejects.toThrow(/digest is empty/);
    // Fails fast: no identity token minted, nothing persisted.
    expect(getIdToken).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('subjectDigestString', () => {
  it('prefers sha256 and falls back to the first available algorithm', () => {
    expect(subjectDigestString({ name: 'x', digest: { sha256: 'a'.repeat(64) } })).toBe(
      'a'.repeat(64),
    );
    expect(subjectDigestString({ name: 'x', digest: { sha512: 'b'.repeat(128) } })).toBe(
      'b'.repeat(128),
    );
  });

  it('throws on an empty digest set instead of returning undefined', () => {
    expect(() => subjectDigestString({ name: 'x', digest: {} })).toThrow(/digest is empty/);
  });
});
