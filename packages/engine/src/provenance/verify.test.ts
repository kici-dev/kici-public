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
} from './schema.js';
import { dssePae } from './dsse.js';
import {
  IN_TOTO_PAYLOAD_TYPE,
  KICI_PROVENANCE_AUDIENCE,
  KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
} from './bundle.js';
import { verifyKiciBundle } from './verify.js';
import { computeStatementHash } from './statement-hash.js';

const ISSUER = 'https://issuer.example';
const SUBJECT_DIGEST = 'a'.repeat(64);

/**
 * Build a DEFERRED bundle: the statement is frozen (marked with an
 * `attestationOrigin`) and the identity token — minted later — carries
 * `attestation_origin` + a `statement_hash` binding instead of the build facts.
 */
async function makeDeferredFixture(
  origin: 'deferred' | 'offline-backfill',
  opts: { tamperHash?: boolean } = {},
): Promise<Fixture> {
  const idKp = await generateKeyPair('ES256', { extractable: true });
  const idJwkPub = (await exportJWK(idKp.publicKey)) as JWK;
  idJwkPub.alg = 'ES256';
  idJwkPub.kid = await calculateJwkThumbprint(idJwkPub, 'sha256');
  const jwks: JSONWebKeySet = { keys: [idJwkPub] };

  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'pkg', digest: { sha256: SUBJECT_DIGEST } }],
    predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: KICI_WORKFLOW_BUILD_TYPE,
        externalParameters: {
          workflow: { repository: 'github.com/acme/api', ref: 'refs/heads/main', path: 'ci.ts' },
        },
        internalParameters: {
          commit: 'deadbeef',
          runId: 'run-1',
          jobId: 'job-1',
          attestationOrigin: origin,
        },
      },
      runDetails: { builder: { id: `${ISSUER}/orchestrator/unknown` } },
    },
  };
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));
  const statementHash = await computeStatementHash(statementBytes);

  const identityToken = await new SignJWT({
    kici_run_id: 'run-1',
    kici_job_id: 'job-1',
    attestation_origin: origin,
    statement_hash: opts.tamperHash ? 'f'.repeat(64) : statementHash,
  })
    .setProtectedHeader({ alg: 'ES256', kid: idJwkPub.kid })
    .setIssuer(ISSUER)
    .setAudience(KICI_PROVENANCE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(idKp.privateKey);

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

interface FixtureOverrides {
  tamperStatement?: boolean;
  tamperSignature?: boolean;
  /** Override token-claim values; `null` models a run with no repo/ref/sha/workflow_ref. */
  claims?: Partial<Record<'repository' | 'ref' | 'sha' | 'workflow_ref', string | null>>;
  /**
   * Force explicit statement workflow fields (adversarial cases). Defaults to the
   * producer coercion of `claims` (null → '').
   */
  statementWorkflow?: Partial<Record<'repository' | 'ref' | 'path', string>>;
}

interface Fixture {
  bundle: Record<string, unknown>;
  jwks: JSONWebKeySet;
}

async function makeFixture(overrides: FixtureOverrides = {}): Promise<Fixture> {
  // Identity key (acts as the Platform JWKS key).
  const idKp = await generateKeyPair('ES256', { extractable: true });
  const idJwkPub = (await exportJWK(idKp.publicKey)) as JWK;
  idJwkPub.alg = 'ES256';
  idJwkPub.kid = await calculateJwkThumbprint(idJwkPub, 'sha256');
  const jwks: JSONWebKeySet = { keys: [idJwkPub] };

  const claims: Record<string, string | null> = {
    repository: 'github.com/acme/api',
    ref: 'refs/heads/main',
    sha: 'deadbeef',
    workflow_ref: '.kici/workflows/release.ts@deadbeef',
    kici_run_id: 'run-1',
    kici_job_id: 'job-1',
    orchestrator_id: 'o',
    ...overrides.claims,
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
          // Mirror the producer coercion (statement-builder.ts): null claim → ''.
          workflow: {
            repository:
              overrides.statementWorkflow?.repository ??
              (overrides.tamperStatement ? 'github.com/evil/x' : (claims.repository ?? '')),
            ref: overrides.statementWorkflow?.ref ?? claims.ref ?? '',
            path: overrides.statementWorkflow?.path ?? claims.workflow_ref ?? '',
          },
        },
        internalParameters: {
          // Producer omits `commit` entirely when `sha` is falsy.
          ...(claims.sha ? { commit: claims.sha } : {}),
          runId: claims.kici_run_id,
          jobId: claims.kici_job_id,
        },
      },
      runDetails: { builder: { id: `${ISSUER}/orchestrator/o` } },
    },
  };
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));

  // Ephemeral DSSE signing key.
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
  if (overrides.tamperSignature) sig[0] ^= 0xff;

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

describe('verifyKiciBundle', () => {
  it('verifies a valid bundle (all checks pass)', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
      expectedDigest: { alg: 'sha256', hex: SUBJECT_DIGEST },
    });
    expect(res.verified).toBe(true);
    expect(res.mode).toBe('kici');
    expect(res.checks).toMatchObject({
      schema: 'pass',
      jwt: 'pass',
      dsse: 'pass',
      buildContext: 'pass',
      digest: 'pass',
    });
    expect(res.failures).toEqual([]);
    expect(res.claims?.repository).toBe('github.com/acme/api');
  });

  it('verifies a deferred bundle via statement-hash binding and surfaces the origin', async () => {
    const { bundle, jwks } = await makeDeferredFixture('offline-backfill');
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(true);
    expect(res.attestationOrigin).toBe('offline-backfill');
    expect(res.checks.buildContext).toBe('pass'); // satisfied by the hash binding
    expect(res.failures).toEqual([]);
  });

  it('HARD FAILS a deferred bundle whose token binds a different statement hash', async () => {
    const { bundle, jwks } = await makeDeferredFixture('deferred', { tamperHash: true });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.failures).toContain('statement_hash_mismatch');
  });

  it('surfaces attestationOrigin=live for a normal bundle', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.attestationOrigin).toBe('live');
  });

  it('verifies without a digest check (digest skipped)', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(true);
    expect(res.checks.digest).toBe('skipped');
  });

  it('fails on a wrong issuer', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: 'https://evil',
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.jwt).toBe('fail');
    expect(res.failures).toContain('identity_token_invalid');
  });

  it('fails on a wrong audience', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: 'some-other-audience',
    });
    expect(res.verified).toBe(false);
    expect(res.checks.jwt).toBe('fail');
  });

  it('fails on a corrupted DSSE signature', async () => {
    const { bundle, jwks } = await makeFixture({ tamperSignature: true });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.dsse).toBe('fail');
    expect(res.failures).toContain('dsse_signature_invalid');
  });

  it('fails on a build-context mismatch (HARD FAIL)', async () => {
    const { bundle, jwks } = await makeFixture({ tamperStatement: true });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.buildContext).toBe('fail');
    expect(res.failures).toContain('build_context_mismatch');
  });

  it('verifies a live bundle whose repository and sha claims are null', async () => {
    const { bundle, jwks } = await makeFixture({ claims: { repository: null, sha: null } });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
      expectedDigest: { alg: 'sha256', hex: SUBJECT_DIGEST },
    });
    expect(res.verified).toBe(true);
    expect(res.checks.buildContext).toBe('pass');
    expect(res.failures).toEqual([]);
  });

  it('verifies a live bundle whose ref and workflow_ref claims are null', async () => {
    const { bundle, jwks } = await makeFixture({ claims: { ref: null, workflow_ref: null } });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(true);
    expect(res.checks.buildContext).toBe('pass');
  });

  it('HARD FAILS when the repository claim is null but the statement asserts a real repo', async () => {
    const { bundle, jwks } = await makeFixture({
      claims: { repository: null },
      statementWorkflow: { repository: 'github.com/evil/x' },
    });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.failures).toContain('build_context_mismatch');
  });

  it('HARD FAILS when the repository claim is set but the statement field is empty', async () => {
    const { bundle, jwks } = await makeFixture({
      claims: { repository: 'github.com/acme/api' },
      statementWorkflow: { repository: '' },
    });
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.failures).toContain('build_context_mismatch');
  });

  it('fails on a digest mismatch', async () => {
    const { bundle, jwks } = await makeFixture();
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
      expectedDigest: { alg: 'sha256', hex: 'b'.repeat(64) },
    });
    expect(res.verified).toBe(false);
    expect(res.checks.digest).toBe('fail');
    expect(res.failures).toContain('subject_digest_mismatch');
  });

  it('fails on a malformed bundle (schema)', async () => {
    const res = await verifyKiciBundle({
      bundle: { mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE, dsseEnvelope: {} },
      jwks: { keys: [] },
      expectedIssuer: ISSUER,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.schema).toBe('fail');
    expect(res.failures).toContain('bundle_schema_invalid');
  });

  it('returns verified:false (never throws) on a non-base64 DSSE payload', async () => {
    const { bundle, jwks } = await makeFixture();
    // A non-base64 payload makes atob() throw inside b64ToBytes; the never-throw
    // contract requires this to resolve as a failure, not reject the promise.
    (bundle.dsseEnvelope as { payload: string }).payload = 'not valid base64 !!!';
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.schema).toBe('fail');
    expect(res.failures).toContain('statement_payload_invalid');
  });

  it('returns verified:false (never throws) on a base64 payload of non-JSON bytes', async () => {
    const { bundle, jwks } = await makeFixture();
    // Valid base64, but decodes to bytes that are not JSON — JSON.parse throws.
    (bundle.dsseEnvelope as { payload: string }).payload = btoa('this is not json');
    const res = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: ISSUER,
      expectedAudience: KICI_PROVENANCE_AUDIENCE,
    });
    expect(res.verified).toBe(false);
    expect(res.checks.schema).toBe('fail');
    expect(res.failures).toContain('statement_payload_invalid');
  });

  it('reports mode_b_unsupported for a Sigstore media type', async () => {
    const res = await verifyKiciBundle({
      bundle: { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3' },
      jwks: { keys: [] },
      expectedIssuer: ISSUER,
    });
    expect(res.verified).toBe(false);
    expect(res.mode).toBe('sigstore');
    expect(res.failures).toContain('mode_b_unsupported');
  });

  it('reports unknown mode for a missing media type', async () => {
    const res = await verifyKiciBundle({
      bundle: {},
      jwks: { keys: [] },
      expectedIssuer: ISSUER,
    });
    expect(res.verified).toBe(false);
    expect(res.failures).toContain('mode_b_unsupported');
  });
});
