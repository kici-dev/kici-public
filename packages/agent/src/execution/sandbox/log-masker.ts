/**
 * Secret value masking for log lines.
 *
 * Replaces all occurrences of registered secret values with '***' in log output.
 * Used by the workflow runner to prevent secret leaks in IPC log messages.
 *
 * Performance: Builds a single combined regex from all secret values, so each
 * log line is scanned in a single pass (not O(secrets * lines)).
 */

/** Minimum length for a secret value to be maskable (avoids false positives). */
const MIN_MASK_LENGTH = 3;

/**
 * Escape regex special characters in a string.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masks secret values in log lines.
 *
 * Usage:
 * ```ts
 * const masker = new LogMasker();
 * masker.registerSecrets({ TOKEN: 'abc123', SHORT: 'ab' });
 * masker.mask('Token is abc123'); // 'Token is ***'
 * // 'ab' is NOT masked (< 3 chars)
 * ```
 */
export class LogMasker {
  private pattern: RegExp | null = null;

  /**
   * Register secret values to be masked in log output.
   *
   * Values shorter than 3 characters are skipped to avoid false positives.
   * Base64-encoded variants of each qualifying secret are also registered,
   * preventing leaks when secrets appear base64-encoded in logs (e.g.,
   * Authorization: Basic headers, base64-encoded config values).
   * Values are sorted by length descending so longer values are matched first
   * (prevents partial masking when one secret is a substring of another).
   */
  registerSecrets(secrets: Record<string, string>): void {
    // Collect unique values that qualify for masking
    const seen = new Set<string>();
    const values: string[] = [];

    for (const value of Object.values(secrets)) {
      if (value.length >= MIN_MASK_LENGTH && !seen.has(value)) {
        seen.add(value);
        values.push(value);

        // Also register the base64-encoded variant
        const b64 = Buffer.from(value).toString('base64');
        if (b64.length >= MIN_MASK_LENGTH && !seen.has(b64)) {
          seen.add(b64);
          values.push(b64);
        }
      }
    }

    if (values.length === 0) {
      this.pattern = null;
      return;
    }

    // Sort by length descending to mask longer values first
    values.sort((a, b) => b.length - a.length);

    // Build a single combined regex using alternation
    this.pattern = new RegExp(values.map((v) => escapeRegExp(v)).join('|'), 'g');
  }

  /**
   * Mask all registered secret values in a log line.
   *
   * Returns the line unchanged if no secrets are registered.
   */
  mask(line: string): string {
    if (!this.pattern) {
      return line;
    }
    // Reset lastIndex for global regex (stateful)
    this.pattern.lastIndex = 0;
    return line.replace(this.pattern, '***');
  }

  /**
   * Returns true if any maskable secrets are registered.
   */
  hasSecrets(): boolean {
    return this.pattern !== null;
  }
}
