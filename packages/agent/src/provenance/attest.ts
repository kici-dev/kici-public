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
import {
  buildProvenanceStatement,
  type ProvenanceSubject,
  type ProvenanceTokenClaims,
} from './statement-builder.js';
import { signStatementDsse } from './sign.js';

export interface AttestDeps {
  /** P1.4 relay: returns a KiCI ID token bound to the current job. */
  getIdToken: (opts: { audience: string }) => Promise<OidcTokenResult>;
  /** Upload the serialized bundle; returns the storage key it was written to. */
  persist: (bundle: KiciBundle, subjectDigest: string) => Promise<string>;
  builderVersions: { 'kici-agent': string; 'kici-orchestrator': string };
  /** Injectable clock for deterministic tests; defaults to wall time. */
  now?: () => string;
}

export interface AttestInput {
  subject: ProvenanceSubject;
  audience?: string;
}

export interface AttestResult {
  storageKey: string;
  bundle: KiciBundle;
  subjectDigest: string;
}

export async function attestProvenance(
  deps: AttestDeps,
  input: AttestInput,
): Promise<AttestResult> {
  const audience = input.audience ?? KICI_PROVENANCE_AUDIENCE;
  // Validate the subject digest up front so a malformed subject fails before we
  // mint an identity token and sign anything.
  const subjectDigest = subjectDigestString(input.subject);
  const { token } = await deps.getIdToken({ audience });

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
