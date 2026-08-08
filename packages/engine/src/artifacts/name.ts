/**
 * Artifact name contract, shared by every tier that handles a name.
 *
 * An artifact name is the user-facing key an artifact is uploaded under and
 * downloaded by, and it becomes a path segment of the storage object key. It is
 * therefore restricted to a conservative, filesystem/URL-safe character set
 * (letters, digits, `.`, `_`, `-`) with a bounded length, so names stay portable
 * across storage backends and can never escape their per-run prefix.
 *
 * The schema lives in the engine — not the SDK — because it is a trust-boundary
 * contract, not just an SDK ergonomic. The orchestrator validates every inbound
 * name against it before minting a presigned PUT, the agent sandbox validates it
 * at the call site, and `@kici-dev/sdk` re-exports it so workflow authors keep
 * the same public symbol. One definition, three consumers: a name the SDK
 * accepts is exactly a name the orchestrator accepts.
 *
 * The rejection **message** lives here too, for the same reason: a workflow
 * author must read one sentence whichever tier refused the name.
 *
 * Pure Zod, no `node:*` imports — safe for the browser-facing engine barrel.
 */
import { z } from 'zod';

/** Maximum length of an artifact name, in characters. */
export const ARTIFACT_NAME_MAX_LENGTH = 128;

/**
 * Zod schema validating an artifact name.
 *
 * The character set and the all-dots exclusion together make the mapping from a
 * name to its storage segment the identity, and therefore injective: two
 * distinct accepted names can never produce the same key. A name outside the
 * character set would be sanitized onto some other name's segment (`a/b` and
 * `a_b` both become `a_b`), and an all-dots name has to be escaped away from a
 * path-canonicalizable segment (`.` and `_.` would both become `_.`). Either
 * collision lets a second upload silently overwrite the first object while both
 * records keep their own hash, so both are rejected outright.
 */
export const ArtifactNameSchema = z
  .string()
  .min(1, 'artifact name must be non-empty')
  .max(ARTIFACT_NAME_MAX_LENGTH, `artifact name must be <= ${ARTIFACT_NAME_MAX_LENGTH} chars`)
  .regex(/^[A-Za-z0-9._-]+$/, 'artifact name may only contain letters, digits, ".", "_", and "-"')
  .refine((n) => !/^\.+$/.test(n), 'artifact name must contain more than dots');

/** Prefix every artifact-name rejection carries, so callers can match on it. */
export const ARTIFACT_INVALID_NAME_PREFIX = 'invalid artifact name';

/**
 * Message for a name that fails the {@link ArtifactNameSchema} contract.
 *
 * Lives beside the schema, not in either consumer, because the rejection wording
 * is part of the contract: the agent sandbox validates at the call site and the
 * orchestrator validates at the trust boundary, and a workflow author must read
 * the same sentence whichever tier refused the name. `detail` is one of the
 * schema's own fixed messages (via {@link checkArtifactName}), never caller
 * input.
 */
export function artifactInvalidNameError(detail: string): string {
  return `${ARTIFACT_INVALID_NAME_PREFIX}: ${detail}`;
}

/**
 * Validate a name against the shared contract, returning the schema's own
 * message on failure and `null` when the name conforms.
 *
 * Only the first issue is reported. The schema's checks are ordered and each
 * carries a single fixed message, so one detail fully describes the violation —
 * and rendering exactly one keeps every tier's message identical.
 */
export function checkArtifactName(name: string): string | null {
  const parsed = ArtifactNameSchema.safeParse(name);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? 'artifact name is not permitted';
}
