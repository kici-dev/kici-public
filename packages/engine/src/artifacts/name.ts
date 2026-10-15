/**
 * Artifact name contract, shared by every tier that handles a name.
 *
 * An artifact name becomes a path segment of the storage object key, so it is
 * restricted to a filesystem/URL-safe character set (letters, digits, `.`, `_`,
 * `-`) with a bounded length: names stay portable across storage backends and
 * can never escape their per-run prefix.
 *
 * The schema lives in the engine, not the SDK, because it is a trust-boundary
 * contract: the orchestrator validates every inbound name before minting a
 * presigned PUT, the agent sandbox validates at the call site, and
 * `@kici-dev/sdk` re-exports it. A name the SDK accepts is exactly a name the
 * orchestrator accepts. The rejection message lives here for the same reason.
 *
 * Pure Zod, no `node:*` imports — safe for the browser-facing engine barrel.
 */
import { z } from 'zod';

/** Maximum length of an artifact name, in characters. */
export const ARTIFACT_NAME_MAX_LENGTH = 128;

/**
 * Zod schema validating an artifact name.
 *
 * The character set and the all-dots exclusion make the name-to-segment mapping
 * the identity, so two distinct accepted names never produce the same key.
 * Otherwise sanitizing (`a/b` and `a_b` both become `a_b`) or escaping an
 * all-dots name (`.` and `_.` both become `_.`) would collide, letting a second
 * upload silently overwrite the first object while both records keep their own
 * hash.
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
 * The wording is part of the contract: a workflow author reads the same
 * sentence whichever tier refused the name. `detail` is one of the schema's own
 * fixed messages (via {@link checkArtifactName}), never caller input.
 */
export function artifactInvalidNameError(detail: string): string {
  return `${ARTIFACT_INVALID_NAME_PREFIX}: ${detail}`;
}

/**
 * Validate a name against the shared contract, returning the schema's own
 * message on failure and `null` when the name conforms.
 *
 * Only the first issue is reported: the checks are ordered and each carries one
 * fixed message, so one detail describes the violation and every tier's
 * message stays identical.
 */
export function checkArtifactName(name: string): string | null {
  const parsed = ArtifactNameSchema.safeParse(name);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? 'artifact name is not permitted';
}
