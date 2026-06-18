import { normalizeLineEndings, sha256 } from '@kici-dev/core';

/**
 * Compile schema version -- bump when compilation approach changes
 * (bundler change, bundling config, output format, etc.).
 * This is NOT the lock file schema version.
 *
 * Bumped 3 → 4: the agent artifact switched from a Rolldown-bundled
 * `.compiled.mjs` to a raw `.kici/` source tarball that the agent extracts
 * and imports via the shared oxc-transform ESM loader hook.
 *
 * Bumped 4 → 5: the hash input is now line-ending-normalized (CRLF → LF) so a
 * lockfile produced on Linux (LF) matches the agent's hash on Windows, where
 * Git's `core.autocrlf=true` system default rewrites checked-out text files to
 * CRLF. Old lockfiles must be regenerated via `kici compile`.
 */
export const COMPILE_SCHEMA_VERSION = 5;

/**
 * Compute content hash for a compiled workflow bundle, optionally including asset file contents.
 * Hash = SHA-256(schemaVersion + ":" + bundleSource + "\0" + assetDigest) when assetDigest is provided,
 * otherwise SHA-256(schemaVersion + ":" + bundleSource) for backward compatibility.
 *
 * The schema version is mixed into the hash input so that
 * different compilation approaches produce different hashes
 * even if the source hasn't changed.
 *
 * Line endings in `bundleSource` (and inside `assetDigest`) are normalized to
 * LF before hashing — the agent applies the same normalization, so the hash
 * agrees across platforms even when Git's `core.autocrlf=true` rewrites the
 * working tree on Windows. Callers should not pre-normalize.
 *
 * @param bundleSource - The compiled JS bundle text (without source maps)
 * @param schemaVersion - The compile schema version to mix into the hash
 * @param assetDigest - Optional deterministic encoding of resolved hashFiles (path + content per file, sorted by path). Omit for bundle-only hash.
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
