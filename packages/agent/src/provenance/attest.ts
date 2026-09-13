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
  /** P1.4 relay: returns a minted KiCI ID token or a transient `deferred` signal. */
  getIdToken: (opts: { audience: string }) => Promise<OidcTokenResult>;
  /** Upload the serialized bundle; returns the storage key it was written to. */
  persist: (bundle: KiciBundle, subjectDigest: string) => Promise<string>;
  /**
   * Report a frozen, DSSE-signed statement for later minting (the transient
   * mint-failure path). Required only when the relay may defer; the live path
   * never calls it.
   */
  reportDeferred?: (report: DeferredAttestationReport) => Promise<void>;
  /** Agent-local job facts used to freeze a statement when the mint defers. */
  localContext?: LocalBuildContext;
  builderVersions: { 'kici-agent': string; 'kici-orchestrator': string };
  /** Injectable clock for deterministic tests; defaults to wall time. */
  now?: () => string;
}

export interface AttestInput {
  subject: ProvenanceSubject;
  audience?: string;
}

/** A minted-and-uploaded attestation, or a deferred one captured for later. */
export type AttestResult =
  | { storageKey: string; bundle: KiciBundle; subjectDigest: string }
  | { deferred: true; statementHash: string; subjectDigest: string };

export async function attestProvenance(
  deps: AttestDeps,
  input: AttestInput,
): Promise<AttestResult> {
  const audience = input.audience ?? KICI_PROVENANCE_AUDIENCE;
  // Validate the subject digest up front so a malformed subject fails before we
  // mint an identity token and sign anything.
  const subjectDigest = subjectDigestString(input.subject);
  const tokenResult = await deps.getIdToken({ audience });

  // Transient mint failure: freeze + DSSE-sign the statement from agent-local
  // facts now, report it, and let the job stay green. The identity token is
  // minted later and bound to this statement by its hash.
  if ('deferred' in tokenResult) {
    return deferAttestation(deps, input, subjectDigest, audience);
  }
  const { token } = tokenResult;

  // The token came from the trusted relay this same process just called; the
  // consumer (verifier) is what validates it against the JWKS. We only decode.
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
 * Freeze + DSSE-sign the provenance statement from agent-local job facts and
 * report it for later minting. The step does NOT throw — the job completes
 * green and the attestation surfaces as `deferred`.
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
 * Pick the primary digest (`sha256` preferred) as the storage-key discriminator.
 * Throws when the subject carries no digest: an empty digest set would otherwise
 * yield an `undefined` storage-key segment (`provenance/<run>/<job>/undefined.kici.json`)
 * and an unverifiable statement, since in-toto requires every subject to carry
 * at least one digest. The SDK `ProvenanceSubjectInput` type allows an empty
 * digest map (both `sha256` and `sha512` are optional), so this is the runtime
 * boundary that upholds the engine `digestSetSchema` invariant.
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
