/**
 * Shared, browser-safe verification core for KiCI provenance bundles (Mode A).
 *
 * Given a KiCI-signed bundle, the Platform JWKS, and an out-of-band trusted
 * issuer, `verifyKiciBundle` establishes the full Mode-A chain offline:
 *
 *  - the identity JWT verifies against the supplied JWKS with `iss` PINNED to
 *    the caller-supplied `expectedIssuer` (never the token's own `iss`) and the
 *    audience checked;
 *  - the DSSE envelope verifies against the ephemeral public key carried in the
 *    bundle, whose `keyid` must equal its RFC 7638 JWK thumbprint;
 *  - the in-toto statement's build context must equal the (server-truth) JWT
 *    claims — a mismatch is a HARD FAIL, the check that makes the agent-built
 *    statement sound;
 *  - when an artifact digest is supplied, a subject digest must match it.
 *
 * The core uses only `jose` (isomorphic) and `crypto.subtle`/`atob`/`TextDecoder`
 * (present in modern browsers and Node 24) — no `node:fs`, no `fetch`, no
 * `Buffer` — so the exact same function runs in the `kici verify-attestation`
 * CLI and the dashboard's verified badge. Exported at the subpath
 * `@kici-dev/engine/provenance/verify`; it is deliberately NOT re-exported from
 * the engine barrel (the barrel must stay free of the `jose` dependency).
 */
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
} from 'jose';
import { KICI_PROVENANCE_BUNDLE_MEDIA_TYPE, kiciBundleSchema } from './bundle.js';
import { dssePae } from './dsse.js';
import { kiciProvenanceStatementSchema, type KiciProvenanceStatement } from './schema.js';

/** Tri-state outcome of a single verification check. */
export type CheckStatus = 'pass' | 'fail' | 'skipped';

/** Per-check verification outcomes. */
export interface VerifyChecks {
  /** Bundle + statement schema validation. */
  schema: CheckStatus;
  /** Identity-token signature, issuer-pin, and audience. */
  jwt: CheckStatus;
  /** DSSE envelope signature over the statement. */
  dsse: CheckStatus;
  /** Statement build context vs. server-truth JWT claims (hard fail on mismatch). */
  buildContext: CheckStatus;
  /** Subject digest vs. the supplied artifact digest (skipped when none given). */
  digest: CheckStatus;
}

/** Structured verification result. Never thrown for a verification failure. */
export interface VerifyResult {
  verified: boolean;
  mode: 'kici' | 'sigstore' | 'unknown';
  checks: VerifyChecks;
  claims?: Record<string, unknown>;
  statement?: KiciProvenanceStatement;
  failures: string[];
}

export interface VerifyKiciBundleOptions {
  /** The bundle to verify (validated against `kiciBundleSchema`). */
  bundle: unknown;
  /** Trusted JWKS (already fetched by the caller). */
  jwks: JSONWebKeySet;
  /** Trusted issuer the token `iss` is pinned to (out-of-band, never the token's own). */
  expectedIssuer: string;
  /** Expected token audience, if any. */
  expectedAudience?: string;
  /** Artifact digest to match against a subject, if any. */
  expectedDigest?: { alg: string; hex: string };
}

/** Browser-safe base64 → bytes (no Buffer — this module is imported by the dashboard). */
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Verify a KiCI provenance bundle offline. Returns a structured result; throws
 * only on a programming-level error, never for a verification failure (a failed
 * verification is `verified:false` with populated `failures`).
 */
export async function verifyKiciBundle(opts: VerifyKiciBundleOptions): Promise<VerifyResult> {
  const checks: VerifyChecks = {
    schema: 'skipped',
    jwt: 'skipped',
    dsse: 'skipped',
    buildContext: 'skipped',
    digest: 'skipped',
  };
  const failures: string[] = [];

  // Dispatch on media type. Anything that is not the KiCI Mode-A media type is
  // a Sigstore-style bundle this verifier does not yet handle (P1.5b).
  const mediaType = (opts.bundle as { mediaType?: unknown } | null)?.mediaType;
  if (mediaType !== KICI_PROVENANCE_BUNDLE_MEDIA_TYPE) {
    return { verified: false, mode: 'sigstore', checks, failures: ['mode_b_unsupported'] };
  }

  const parsed = kiciBundleSchema.safeParse(opts.bundle);
  if (!parsed.success) {
    checks.schema = 'fail';
    return { verified: false, mode: 'kici', checks, failures: ['bundle_schema_invalid'] };
  }
  const bundle = parsed.data;
  checks.schema = 'pass';

  // Decode + parse the in-toto statement carried in the DSSE payload.
  const statementBytes = b64ToBytes(bundle.dsseEnvelope.payload);
  let statement: KiciProvenanceStatement | undefined;
  const stmt = kiciProvenanceStatementSchema.safeParse(
    JSON.parse(new TextDecoder().decode(statementBytes)),
  );
  if (!stmt.success) {
    checks.schema = 'fail';
    failures.push('statement_schema_invalid');
  } else {
    statement = stmt.data;
  }

  // Identity token: verify against the trusted JWKS, pinning iss + checking aud.
  let claims: Record<string, unknown> | undefined;
  try {
    const { payload } = await jwtVerify(
      bundle.verificationMaterial.identityToken,
      createLocalJWKSet(opts.jwks),
      { issuer: opts.expectedIssuer, audience: opts.expectedAudience },
    );
    claims = payload as Record<string, unknown>;
    checks.jwt = 'pass';
  } catch {
    checks.jwt = 'fail';
    failures.push('identity_token_invalid');
  }

  // DSSE signature over PAE(payloadType, statementBytes) by the ephemeral key,
  // whose keyid must equal its RFC 7638 thumbprint.
  try {
    const pubJwk = bundle.verificationMaterial.publicKey as JWK;
    const thumbprint = await calculateJwkThumbprint(pubJwk, 'sha256');
    if (bundle.dsseEnvelope.signatures[0].keyid !== thumbprint) {
      throw new Error('keyid does not match public-key thumbprint');
    }
    const key = (await importJWK(pubJwk, 'ES256')) as CryptoKey;
    // Web Crypto ECDSA expects the IEEE P1363 raw r||s signature (64 bytes for
    // P-256), the encoding the producer's `crypto.subtle.sign` emits.
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64ToBytes(bundle.dsseEnvelope.signatures[0].sig) as BufferSource,
      dssePae(bundle.dsseEnvelope.payloadType, statementBytes) as BufferSource,
    );
    if (!ok) throw new Error('bad signature');
    checks.dsse = 'pass';
  } catch {
    checks.dsse = 'fail';
    failures.push('dsse_signature_invalid');
  }

  // Build-context cross-check: the statement must agree with the trusted claims.
  if (statement && claims) {
    const ok = crossCheckBuildContext(statement, claims);
    checks.buildContext = ok ? 'pass' : 'fail';
    if (!ok) failures.push('build_context_mismatch');
  } else {
    checks.buildContext = 'fail';
    failures.push('build_context_uncheckable');
  }

  // Optional subject-digest check.
  if (opts.expectedDigest && statement) {
    const ok = checkSubjectDigest(statement, opts.expectedDigest);
    checks.digest = ok ? 'pass' : 'fail';
    if (!ok) failures.push('subject_digest_mismatch');
  }

  const verified =
    checks.schema === 'pass' &&
    checks.jwt === 'pass' &&
    checks.dsse === 'pass' &&
    checks.buildContext === 'pass' &&
    checks.digest !== 'fail';
  return { verified, mode: 'kici', checks, claims, statement, failures };
}

/** The statement's build context must equal the (server-truth) JWT claims. */
function crossCheckBuildContext(
  statement: KiciProvenanceStatement,
  claims: Record<string, unknown>,
): boolean {
  const bd = statement.predicate.buildDefinition;
  const wf = bd.externalParameters.workflow;
  const ip = bd.internalParameters ?? {};
  return (
    wf.repository === claims.repository &&
    wf.ref === claims.ref &&
    wf.path === claims.workflow_ref &&
    ip.commit === claims.sha &&
    ip.runId === claims.kici_run_id &&
    ip.jobId === claims.kici_job_id
  );
}

/** At least one subject must carry a digest matching the supplied artifact digest. */
function checkSubjectDigest(
  statement: KiciProvenanceStatement,
  expected: { alg: string; hex: string },
): boolean {
  return statement.subject.some((s) => s.digest[expected.alg] === expected.hex);
}
