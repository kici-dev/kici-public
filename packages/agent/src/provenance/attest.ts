/**
 * Provenance attestation orchestration (Mode A): request the identity token,
 * build the in-toto statement from its claims, DSSE-sign it with an ephemeral
 * key, assemble the KiCI bundle, and persist it.
 */
import { decodeJwt } from 'jose';
import {
  IN_TOTO_PAYLOAD_TYPE,
  KICI_PROVENANCE_AUDIENCE,
  KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
  type KiciBundle,
} from '@kici-dev/engine/provenance/bundle';
import type { OidcTokenResult } from '@kici-dev/engine/protocol/messages/oidc-token-relay';
import { computeStatementHash } from '@kici-dev/engine/provenance/statement-hash';
import {
  buildLocalProvenanceStatement,
  buildProvenanceStatement,
  type LocalBuildContext,
  type ProvenanceSubject,
  type ProvenanceTokenClaims,
} from './statement-builder.js';
import { signStatementDsse } from './sign.js';

/** The frozen, DSSE-signed attestation the agent reports for later fulfilment. */
export interface DeferredAttestationReport {
  subjectName: string;
  subjectDigest: string;
  audience: string;
  mediaType: string;
  statementHash: string;
  dsseEnvelope: KiciBundle['dsseEnvelope'];
  publicKey: Record<string, unknown>;
}

export interface AttestDeps {
  /** Relay: returns a minted KiCI ID token or a transient `deferred` signal. */
  getIdToken: (opts: { audience: string }) => Promise<OidcTokenResult>;
  /** Returns the storage key the bundle was written to. */
  persist: (bundle: KiciBundle, subjectDigest: string) => Promise<string>;
  /** Transient mint-failure path only; required only when the relay may defer. */
  reportDeferred?: (report: DeferredAttestationReport) => Promise<void>;
  /** Agent-local job facts used to freeze a statement when the mint defers. */
  localContext?: LocalBuildContext;
  builderVersions: { 'kici-agent': string; 'kici-orchestrator': string };
  /** Injectable for tests; defaults to wall time. */
  now?: () => string;
}

export interface AttestInput {
  subject: ProvenanceSubject;
  audience?: string;
}

export type AttestResult =
  | { storageKey: string; bundle: KiciBundle; subjectDigest: string }
  | { deferred: true; statementHash: string; subjectDigest: string };

export async function attestProvenance(
  deps: AttestDeps,
  input: AttestInput,
): Promise<AttestResult> {
  const audience = input.audience ?? KICI_PROVENANCE_AUDIENCE;
  // Validates the subject before minting or signing anything.
  const subjectDigest = subjectDigestString(input.subject);
  const tokenResult = await deps.getIdToken({ audience });

  // Transient mint failure: the job stays green; the identity token is minted
  // later and bound to the frozen statement by its hash.
  if ('deferred' in tokenResult) {
    return deferAttestation(deps, input, subjectDigest, audience);
  }
  const { token } = tokenResult;

  // From the trusted relay this process just called; the verifier validates it
  // against the JWKS, so only decode here.
  const claims = decodeJwt(token) as unknown as ProvenanceTokenClaims;

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const statement = buildProvenanceStatement({
    tokenClaims: claims,
    subject: input.subject,
    builderVersions: deps.builderVersions,
    startedOn: now,
    finishedOn: now,
  });
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));
  const { envelope, publicJwk } = await signStatementDsse(IN_TOTO_PAYLOAD_TYPE, statementBytes);

  const bundle: KiciBundle = {
    mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
    dsseEnvelope: envelope,
    verificationMaterial: {
      publicKey: publicJwk as unknown as Record<string, unknown>,
      identityToken: token,
    },
  };

  const storageKey = await deps.persist(bundle, subjectDigest);
  return { storageKey, bundle, subjectDigest };
}

/**
 * Freezes + DSSE-signs the statement from agent-local facts for later minting.
 * The job completes green and the attestation surfaces as `deferred`.
 */
async function deferAttestation(
  deps: AttestDeps,
  input: AttestInput,
  subjectDigest: string,
  audience: string,
): Promise<{ deferred: true; statementHash: string; subjectDigest: string }> {
  if (!deps.reportDeferred || !deps.localContext) {
    throw new Error(
      'provenance mint deferred but no reportDeferred/localContext wired to capture it',
    );
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const statement = buildLocalProvenanceStatement({
    context: deps.localContext,
    subject: input.subject,
    builderVersions: deps.builderVersions,
    startedOn: now,
    finishedOn: now,
  });
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));
  const { envelope, publicJwk } = await signStatementDsse(IN_TOTO_PAYLOAD_TYPE, statementBytes);
  const statementHash = await computeStatementHash(statementBytes);
  await deps.reportDeferred({
    subjectName: input.subject.name,
    subjectDigest,
    audience,
    mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
    statementHash,
    dsseEnvelope: envelope,
    publicKey: publicJwk as unknown as Record<string, unknown>,
  });
  return { deferred: true, statementHash, subjectDigest };
}

/**
 * The primary digest (`sha256` preferred), the storage-key discriminator. The
 * SDK `ProvenanceSubjectInput` allows an empty digest map, so this runtime
 * boundary upholds the engine `digestSetSchema` invariant: an empty set would
 * give an `undefined.kici.json` storage key and an in-toto statement no
 * verifier accepts.
 */
export function subjectDigestString(subject: ProvenanceSubject): string {
  const digest = subject.digest.sha256 ?? Object.values(subject.digest)[0];
  if (digest === undefined) {
    throw new Error(
      'provenance subject digest is empty: at least one digest algorithm is required',
    );
  }
  return digest;
}
