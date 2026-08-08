import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_INVALID_NAME_PREFIX,
  ARTIFACT_NAME_MAX_LENGTH,
  ArtifactNameSchema,
  artifactInvalidNameError,
  checkArtifactName,
} from './name.js';

describe('ArtifactNameSchema', () => {
  it('accepts a conforming name', () => {
    expect(ArtifactNameSchema.safeParse('build-out.v1_2').success).toBe(true);
  });

  it('rejects a name with a path separator', () => {
    expect(ArtifactNameSchema.safeParse('a/b').success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(ArtifactNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects a name over the max length', () => {
    expect(ArtifactNameSchema.safeParse('a'.repeat(ARTIFACT_NAME_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('accepts a name exactly at the max length', () => {
    expect(ArtifactNameSchema.safeParse('a'.repeat(ARTIFACT_NAME_MAX_LENGTH)).success).toBe(true);
  });

  it('exposes the max length as 128', () => {
    expect(ARTIFACT_NAME_MAX_LENGTH).toBe(128);
  });

  it('rejects names that would collide on one storage key after sanitization', () => {
    // `a/b` and `a_b` are distinct names but both sanitize to the same storage
    // segment; rejecting the non-conforming one keeps the mapping injective.
    expect(ArtifactNameSchema.safeParse('a/b').success).toBe(false);
    expect(ArtifactNameSchema.safeParse('a_b').success).toBe(true);
  });

  it('rejects an all-dots name', () => {
    // `.` / `..` are path-canonicalized away before reaching the backend, so a
    // storage segment escapes them — which would collide with the literal
    // escaped name (`.` and `_.` both address `_.`).
    expect(ArtifactNameSchema.safeParse('.').success).toBe(false);
    expect(ArtifactNameSchema.safeParse('..').success).toBe(false);
    expect(ArtifactNameSchema.safeParse('...').success).toBe(false);
    expect(ArtifactNameSchema.safeParse('.hidden').success).toBe(true);
  });

  it('rejects a name with whitespace', () => {
    expect(ArtifactNameSchema.safeParse('a b').success).toBe(false);
  });
});

describe('checkArtifactName', () => {
  it('returns null for a conforming name', () => {
    expect(checkArtifactName('build-out.v1_2')).toBeNull();
  });

  it("returns the schema's own message for a charset violation", () => {
    expect(checkArtifactName('a/b')).toBe(
      'artifact name may only contain letters, digits, ".", "_", and "-"',
    );
  });

  it('returns the length message for an over-long name', () => {
    expect(checkArtifactName('a'.repeat(ARTIFACT_NAME_MAX_LENGTH + 1))).toBe(
      `artifact name must be <= ${ARTIFACT_NAME_MAX_LENGTH} chars`,
    );
  });

  it('returns the non-empty message for an empty name', () => {
    expect(checkArtifactName('')).toBe('artifact name must be non-empty');
  });

  it('returns the all-dots message', () => {
    expect(checkArtifactName('..')).toBe('artifact name must contain more than dots');
  });
});

describe('artifactInvalidNameError', () => {
  it('prefixes the detail', () => {
    expect(artifactInvalidNameError('some detail')).toBe('invalid artifact name: some detail');
  });

  it('renders the prefix callers match on', () => {
    expect(artifactInvalidNameError('some detail').startsWith(ARTIFACT_INVALID_NAME_PREFIX)).toBe(
      true,
    );
  });

  it('composes with checkArtifactName into the full customer-visible detail', () => {
    // This is the exact string both the orchestrator and the agent sandbox must
    // produce for the same input. If either tier stops matching it, the drift
    // this definition removed has come back.
    const detail = checkArtifactName('a/b');
    expect(detail).not.toBeNull();
    expect(artifactInvalidNameError(detail!)).toBe(
      'invalid artifact name: artifact name may only contain letters, digits, ".", "_", and "-"',
    );
  });
});
