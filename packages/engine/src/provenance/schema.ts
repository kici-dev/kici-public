/**
 * SLSA v1.0 build-provenance schema for KiCI.
 *
 * Models the in-toto Statement v1 envelope and the SLSA v1.0 provenance
 * predicate as Zod schemas, plus a KiCI-specialized statement schema that pins
 * the KiCI literals and types the KiCI-owned build parameters. This is the
 * single source of truth shared by the agent (produces attestations) and the
 * `kici verify-attestation` CLI (consumes them).
 *
 * Pure schema + types — no Node-only dependencies, so the dashboard can import
 * it for typed artifact rendering. Exported at the subpath
 * `@kici-dev/engine/provenance/schema`.
 *
 * Spec references:
 *  - in-toto Statement v1: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
 *  - SLSA v1.0 provenance:  https://slsa.dev/spec/v1.0/provenance
 */
import { z } from 'zod';

// --- Constant URIs (single source of truth; no repeated string literals) ---

/** in-toto Statement `_type` value (pinned). */
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';

/** SLSA v1.0 provenance `predicateType` value (pinned). */
export const SLSA_PROVENANCE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** KiCI workflow `buildType` URI (we own this namespace). */
export const KICI_WORKFLOW_BUILD_TYPE = 'https://kici.dev/buildtypes/workflow/v1';

/**
 * Known digest algorithms KiCI emits or tests reference. The digest map itself
 * (`digestSetSchema`) keeps its keys open for forward-compatibility; this enum
 * documents the common set so producer code and tests don't repeat literals.
 */
export const DigestAlgorithm = z.enum(['sha256', 'sha512', 'sha1', 'gitCommit', 'dirHash']);
export type DigestAlgorithm = z.infer<typeof DigestAlgorithm>;

// --- Layer 1: spec-faithful generic in-toto / SLSA schemas ---

/** Lowercase hex string (in-toto requires lowercase-hex digest encoding). */
const lowercaseHex = z.string().regex(/^[0-9a-f]+$/, 'digest value must be lowercase hex');

/**
 * in-toto digest set: a map of algorithm name → lowercase-hex digest. Keys are
 * open (forward-compat); at least one entry is required.
 */
export const digestSetSchema = z
  .record(z.string().min(1), lowercaseHex)
  .refine((d) => Object.keys(d).length > 0, {
    message: 'digest must contain at least one algorithm',
  });
export type DigestSet = z.infer<typeof digestSetSchema>;

/**
 * in-toto ResourceDescriptor. Reused for `resolvedDependencies` and
 * `byproducts`. Per spec, at least one of name / uri / digest must be present.
 */
export const resourceDescriptorSchema = z
  .object({
    name: z.string().optional(),
    uri: z.string().optional(),
    digest: digestSetSchema.optional(),
    content: z.string().optional(),
    downloadLocation: z.string().optional(),
    mediaType: z.string().optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((rd) => rd.name !== undefined || rd.uri !== undefined || rd.digest !== undefined, {
    message: 'resource descriptor requires at least one of name, uri, or digest',
  });
export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;

/**
 * in-toto Statement subject entry: a resource descriptor that MUST carry a
 * digest (the verifier matches the subject digest against the artifact).
 */
export const subjectSchema = z.object({
  name: z.string().optional(),
  uri: z.string().optional(),
  digest: digestSetSchema,
  mediaType: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type Subject = z.infer<typeof subjectSchema>;

/** SLSA `builder`: identity of the build platform. `id` is a required URI. */
export const builderSchema = z.object({
  id: z.string(),
  builderDependencies: z.array(resourceDescriptorSchema).optional(),
  version: z.record(z.string(), z.string()).optional(),
});
export type Builder = z.infer<typeof builderSchema>;

/** SLSA `metadata`: build-invocation metadata. */
export const buildMetadataSchema = z.object({
  invocationId: z.string().optional(),
  startedOn: z.string().datetime({ offset: true }).optional(),
  finishedOn: z.string().datetime({ offset: true }).optional(),
});
export type BuildMetadata = z.infer<typeof buildMetadataSchema>;

/** SLSA `buildDefinition`. `buildType` + `externalParameters` are required. */
export const buildDefinitionSchema = z.object({
  buildType: z.string(),
  externalParameters: z.record(z.string(), z.unknown()),
  internalParameters: z.record(z.string(), z.unknown()).optional(),
  resolvedDependencies: z.array(resourceDescriptorSchema).optional(),
});
export type BuildDefinition = z.infer<typeof buildDefinitionSchema>;

/** SLSA `runDetails`. `builder` is required. */
export const runDetailsSchema = z.object({
  builder: builderSchema,
  metadata: buildMetadataSchema.optional(),
  byproducts: z.array(resourceDescriptorSchema).optional(),
});
export type RunDetails = z.infer<typeof runDetailsSchema>;

/** SLSA v1.0 provenance predicate. */
export const slsaProvenancePredicateSchema = z.object({
  buildDefinition: buildDefinitionSchema,
  runDetails: runDetailsSchema,
});
export type SlsaProvenancePredicate = z.infer<typeof slsaProvenancePredicateSchema>;

/** Predicate-agnostic in-toto Statement v1 envelope. */
export const inTotoStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(subjectSchema).min(1),
  predicateType: z.string(),
  predicate: z.record(z.string(), z.unknown()),
});
export type InTotoStatement = z.infer<typeof inTotoStatementSchema>;

// --- Layer 2: KiCI-specialized statement (producer ↔ verifier contract) ---

/** KiCI workflow external parameters: the workflow source coordinates. */
export const kiciWorkflowExternalParametersSchema = z
  .object({
    workflow: z.object({
      repository: z.string(),
      ref: z.string(),
      path: z.string(),
    }),
  })
  .passthrough();
export type KiciWorkflowExternalParameters = z.infer<typeof kiciWorkflowExternalParametersSchema>;

/** KiCI workflow internal parameters: run-scoped build context. */
export const kiciWorkflowInternalParametersSchema = z
  .object({
    commit: z.string().optional(),
    runId: z.string().optional(),
    jobId: z.string().optional(),
  })
  .passthrough();
export type KiciWorkflowInternalParameters = z.infer<typeof kiciWorkflowInternalParametersSchema>;

/** KiCI build definition: pins the buildType and types the workflow params. */
export const kiciBuildDefinitionSchema = buildDefinitionSchema.extend({
  buildType: z.literal(KICI_WORKFLOW_BUILD_TYPE),
  externalParameters: kiciWorkflowExternalParametersSchema,
  internalParameters: kiciWorkflowInternalParametersSchema.optional(),
});
export type KiciBuildDefinition = z.infer<typeof kiciBuildDefinitionSchema>;

/** KiCI run details: types builder.version with the KiCI component versions. */
export const kiciRunDetailsSchema = runDetailsSchema.extend({
  builder: builderSchema.extend({
    version: z
      .object({
        'kici-orchestrator': z.string(),
        'kici-agent': z.string(),
      })
      .passthrough()
      .optional(),
  }),
});
export type KiciRunDetails = z.infer<typeof kiciRunDetailsSchema>;

/** KiCI SLSA provenance predicate. */
export const kiciProvenancePredicateSchema = z.object({
  buildDefinition: kiciBuildDefinitionSchema,
  runDetails: kiciRunDetailsSchema,
});
export type KiciProvenancePredicate = z.infer<typeof kiciProvenancePredicateSchema>;

/** KiCI provenance Statement: pins `_type` + `predicateType` + KiCI predicate. */
export const kiciProvenanceStatementSchema = inTotoStatementSchema.extend({
  predicateType: z.literal(SLSA_PROVENANCE_PREDICATE_TYPE),
  predicate: kiciProvenancePredicateSchema,
});
export type KiciProvenanceStatement = z.infer<typeof kiciProvenanceStatementSchema>;
