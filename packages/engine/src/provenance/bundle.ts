/**
 * KiCI provenance bundle: the Mode-A (KiCI-signed) attestation package.
 *
 * A KiCI bundle is the Sigstore model with the KiCI identity JWT standing in
 * for the Fulcio certificate and no transparency log: it carries the DSSE
 * envelope over the in-toto statement, the ephemeral public key that signed it,
 * and the identity JWT that anchors the statement's build context to a
 * KiCI-minted identity (verified offline against the Platform JWKS).
 *
 * Pure schema + constants, browser-safe — the agent producer and the verifier
 * both import it. Exported at `@kici-dev/engine/provenance/bundle`.
 */
import { z } from 'zod';
import { dsseEnvelopeSchema } from './dsse.js';

/** Versioned media type for the KiCI-custom Mode-A bundle (verifier dispatches on it). */
export const KICI_PROVENANCE_BUNDLE_MEDIA_TYPE =
  'application/vnd.kici.provenance.bundle+json;version=0.1';

/** OIDC audience the agent requests for the identity token bound into a bundle. */
export const KICI_PROVENANCE_AUDIENCE = 'kici-provenance';

/** in-toto DSSE payload type for the signed statement. */
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

/** Signing mode of a stored attestation. Mode A = KiCI-signed (the only mode today). */
export const AttestationMode = z.enum(['kici']);
export type AttestationMode = z.infer<typeof AttestationMode>;

/** Object-storage prefix for provenance bundles. */
export const PROVENANCE_STORAGE_PREFIX = 'provenance';

/**
 * Storage key for a provenance bundle:
 * `provenance/{runId}/{jobId}/{subjectDigest}.kici.json`. Shared by the agent
 * producer and the orchestrator persistence path so the two never drift.
 */
export function provenanceStorageKey(runId: string, jobId: string, subjectDigest: string): string {
  return `${PROVENANCE_STORAGE_PREFIX}/${runId}/${jobId}/${subjectDigest}.kici.json`;
}

/**
 * Mode-A (KiCI-signed) bundle: the DSSE envelope over the statement plus the
 * verification material (the ephemeral signing public key as a JWK + the
 * identity JWT).
 */
export const kiciBundleSchema = z.object({
  mediaType: z.literal(KICI_PROVENANCE_BUNDLE_MEDIA_TYPE),
  dsseEnvelope: dsseEnvelopeSchema,
  verificationMaterial: z.object({
    /** JWK of the ephemeral ES256 key that signed the DSSE envelope. */
    publicKey: z.record(z.string(), z.unknown()),
    /** The KiCI ID token (verified against the Platform JWKS). */
    identityToken: z.string(),
  }),
});
export type KiciBundle = z.infer<typeof kiciBundleSchema>;
