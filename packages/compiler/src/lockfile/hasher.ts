import { normalizeLineEndings, sha256 } from '@kici-dev/core';

/**
 * Defined beside the digest it qualifies, so the compiler that writes a
 * `contentHash` and the agent that re-verifies it cannot drift apart.
 */
export { COMPILE_SCHEMA_VERSION } from '@kici-dev/core/kici-source-digest';

/**
 * SHA-256(schemaVersion + ":" + bundleSource + "\0" + assetDigest), or without
 * the asset part when assetDigest is absent (backward compatible). The schema
 * version makes a new compilation approach change the hash for unchanged source.
 *
 * Line endings are normalized to LF before hashing, as the agent does, so the
 * hash agrees across platforms even under Git's `core.autocrlf=true` on
 * Windows. Callers should not pre-normalize.
 *
 * @param bundleSource - Compiled JS bundle text, without source maps
 * @param assetDigest - Deterministic encoding of resolved hashFiles (path + content per file, sorted by path)
 * @returns 64-character lowercase hex SHA-256 digest
 */
export function computeContentHash(
  bundleSource: string,
  schemaVersion: number,
  assetDigest?: string,
): string {
  let input = `${schemaVersion}:${normalizeLineEndings(bundleSource)}`;
  if (assetDigest !== undefined && assetDigest.length > 0) {
    input += `\0${normalizeLineEndings(assetDigest)}`;
  }
  return sha256(input);
}
