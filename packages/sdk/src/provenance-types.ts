/**
 * Types for `ctx.attestProvenance()` — the imperative step helper that builds,
 * signs, and persists a KiCI build-provenance attestation for a produced
 * artifact.
 */

/**
 * The artifact being attested. Either supply a precomputed digest, or a path
 * (relative to the step working directory) the agent will digest with SHA-256.
 */
export type ProvenanceSubjectInput =
  { name: string; digest: { sha256?: string; sha512?: string } } | { name: string; path: string };

export interface AttestProvenanceOptions {
  subject: ProvenanceSubjectInput;
  /** OIDC audience for the identity token (defaults to 'kici-provenance'). */
  audience?: string;
}

export type AttestProvenanceResult =
  | {
      /** Absent/false: the identity token was minted live and the bundle uploaded. */
      deferred?: false;
      /** Object-storage key the signed bundle was written to. */
      storageKey: string;
      /** Primary subject digest (lowercase hex). */
      subjectDigest: string;
      /** Media type of the persisted bundle. */
      bundleMediaType: string;
    }
  | {
      /**
       * The identity-token mint failed transiently, so only the identity token
       * is deferred: the statement was frozen + signed at build time and the
       * token is minted later (automatically when the mint recovers, or via
       * `kici-admin attestations retry`). The job still completes successfully.
       */
      deferred: true;
      /** Primary subject digest (lowercase hex). */
      subjectDigest: string;
      /** SHA-256 of the frozen statement the later token will bind to. */
      statementHash: string;
    };

/** Discriminate a path subject from a precomputed-digest subject. */
export function provenanceSubjectIsPath(
  s: ProvenanceSubjectInput,
): s is { name: string; path: string } {
  return 'path' in s;
}
