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
  | { name: string; digest: { sha256?: string; sha512?: string } }
  | { name: string; path: string };

export interface AttestProvenanceOptions {
  subject: ProvenanceSubjectInput;
  /** OIDC audience for the identity token (defaults to 'kici-provenance'). */
  audience?: string;
}

export interface AttestProvenanceResult {
  /** Object-storage key the signed bundle was written to. */
  storageKey: string;
  /** Primary subject digest (lowercase hex). */
  subjectDigest: string;
  /** Media type of the persisted bundle. */
  bundleMediaType: string;
}

/** Discriminate a path subject from a precomputed-digest subject. */
export function provenanceSubjectIsPath(
  s: ProvenanceSubjectInput,
): s is { name: string; path: string } {
  return 'path' in s;
}
