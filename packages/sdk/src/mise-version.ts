/** A mise release version, with or without the `v` of its Git tag (`2026.5.1`, `v2026.5.1`). */
const MISE_VERSION_PATTERN = /^v?\d{4}\.\d{1,2}\.\d+$/;

/**
 * The bare release version (`2026.5.1`) of a valid mise pin, or `undefined`
 * when `version` is not a mise release version. The agent substitutes the
 * result into an install script, so the pattern is anchored at both ends.
 */
export function normalizeMiseVersion(version: string): string | undefined {
  return MISE_VERSION_PATTERN.test(version) ? version.replace(/^v/, '') : undefined;
}
