import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JSONWebKeySet,
} from 'jose';
import {
  IN_TOTO_STATEMENT_TYPE,
  KICI_WORKFLOW_BUILD_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
} from '@kici-dev/engine/provenance/schema';
import { dssePae } from '@kici-dev/engine/provenance/dsse';
import {
  IN_TOTO_PAYLOAD_TYPE,
  KICI_PROVENANCE_AUDIENCE,
  KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
} from '@kici-dev/engine/provenance/bundle';
import { attestationVerifyStatusSchema } from '@kici-dev/engine';
import { createProvenanceTrustRoot } from './trust-root.js';
import { computeAttestationVerdict } from './verify-at-ingest.js';
import type { CacheStorage } from '../storage/types.js';

const ISSUER = 'https://issuer.example';
const SUBJECT_DIGEST = 'a'.repeat(64);
const status = attestationVerifyStatusSchema.enum;

async function makeFixture(tamper = false): Promise<{ bundle: unknown; jwks: JSONWebKeySet }> {
  const idKp = await generateKeyPair('ES256', { extractable: true });
  const idJwkPub = (await exportJWK(idKp.publicKey)) as JWK;
  idJwkPub.alg = 'ES256';
  idJwkPub.kid = await calculateJwkThumbprint(idJwkPub, 'sha256');
  const jwks: JSONWebKeySet = { keys: [idJwkPub] };

  const claims = {
    repository: 'github.com/acme/api',
    ref: 'refs/heads/main',
    sha: 'deadbeef',
    workflow_ref: '.kici/workflows/release.ts@deadbeef',
    kici_run_id: 'run-1',
    kici_job_id: 'job-1',
    orchestrator_id: 'o',
  };
  const identityToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: idJwkPub.kid })
    .setIssuer(ISSUER)
    .setAudience(KICI_PROVENANCE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(idKp.privateKey);

  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'pkg', digest: { sha256: SUBJECT_DIGEST } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KICI_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: {
            repository: tamper ? 'github.com/evil/x' : claims.repository,
            ref: claims.ref,
            path: claims.workflow_ref,
          },
        },
        internalParameters: {
          commit: claims.sha,
          runId: claims.kici_run_id,
          jobId: claims.kici_job_id,
        },
      },
      runDetails: { builder: { id: `${ISSUER}/orchestrator/o` } },
    },
  };
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));

  const ephKp = await generateKeyPair('ES256', { extractable: true });
  const ephPub = (await exportJWK(ephKp.publicKey)) as JWK;
  ephPub.alg = 'ES256';
  ephPub.kid = await calculateJwkThumbprint(ephPub, 'sha256');
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      ephKp.privateKey as unknown as CryptoKey,
      dssePae(IN_TOTO_PAYLOAD_TYPE, statementBytes),
    ),
  );

  const bundle = {
    mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
    dsseEnvelope: {
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      payload: btoa(String.fromCharCode(...statementBytes)),
      signatures: [{ keyid: ephPub.kid, sig: btoa(String.fromCharCode(...sig)) }],
    },
    verificationMaterial: { publicKey: ephPub, identityToken },
  };
  return { bundle, jwks };
}

function storageReturning(bundle: unknown): CacheStorage {
  return {
    get: async () => Buffer.from(JSON.stringify(bundle), 'utf8'),
  } as unknown as CacheStorage;
}

describe('computeAttestationVerdict', () => {
  it('stores a verified verdict when the trust root validates the bundle', async () => {
    const { bundle, jwks } = await makeFixture();
    const trustRoot = createProvenanceTrustRoot({
      issuer: ISSUER,
      fetchImpl: (async () => new Response(JSON.stringify(jwks), { status: 200 })) as typeof fetch,
    });
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage: storageReturning(bundle),
      storageKey: 'k',
    });
    expect(verdict.verifyStatus).toBe(status.verified);
    expect(verdict.verifyReason).toBeNull();
    expect(verdict.verifiedAt).toBeInstanceOf(Date);
  });

  it('stores a failed verdict (with reason) when the bundle fails verification', async () => {
    const { bundle, jwks } = await makeFixture(true); // tampered statement repo
    const trustRoot = createProvenanceTrustRoot({
      issuer: ISSUER,
      fetchImpl: (async () => new Response(JSON.stringify(jwks), { status: 200 })) as typeof fetch,
    });
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage: storageReturning(bundle),
      storageKey: 'k',
    });
    expect(verdict.verifyStatus).toBe(status.failed);
    expect(verdict.verifyReason).toBeTruthy();
    expect(verdict.verifiedAt).toBeInstanceOf(Date);
  });

  it('stores unverifiable when no issuer is configured', async () => {
    const trustRoot = createProvenanceTrustRoot(); // null issuer
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage: storageReturning({}),
      storageKey: 'k',
    });
    expect(verdict.verifyStatus).toBe(status.unverifiable);
    expect(verdict.verifyReason).toBe('no_issuer_configured');
    expect(verdict.verifiedAt).toBeNull();
  });

  it('stores unverifiable when there is no storage backend', async () => {
    const trustRoot = createProvenanceTrustRoot({ issuer: ISSUER });
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage: undefined,
      storageKey: 'k',
    });
    expect(verdict.verifyStatus).toBe(status.unverifiable);
    expect(verdict.verifyReason).toBe('no_storage');
  });

  it('stores unverifiable when the jwks fetch fails', async () => {
    const trustRoot = createProvenanceTrustRoot({
      issuer: ISSUER,
      fetchImpl: (async () => new Response('no', { status: 500 })) as typeof fetch,
    });
    const verdict = await computeAttestationVerdict({
      trustRoot,
      storage: storageReturning({}),
      storageKey: 'k',
    });
    expect(verdict.verifyStatus).toBe(status.unverifiable);
    expect(verdict.verifyReason).toBe('jwks_fetch_failed');
  });

  it('stores unverifiable when the stored bundle is unreadable', async () => {
    const { jwks } = await makeFixture();
    const trustRoot = createProvenanceTrustRoot({
      issuer: ISSUER,
      fetchImpl: (async () => new Response(JSON.stringify(jwks), { status: 200 })) as typeof fetch,
    });
    const storage = { get: async () => null } as unknown as CacheStorage;
    const verdict = await computeAttestationVerdict({ trustRoot, storage, storageKey: 'k' });
    expect(verdict.verifyStatus).toBe(status.unverifiable);
    expect(verdict.verifyReason).toBe('bundle_unreadable');
  });
});
