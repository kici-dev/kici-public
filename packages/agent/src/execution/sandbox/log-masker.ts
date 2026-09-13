/**
 * Secret value masking for log lines.
 *
 * Replaces all occurrences of registered secret values with '***' in log output.
 * Used by the workflow runner to prevent secret leaks in IPC log messages.
 *
 * Performance: Builds a single combined regex from all secret values, so each
 * log line is scanned in a single pass (not O(secrets * lines)).
 */

import type { JobExecutionRequest, RunnerToAgentMessage } from './ipc-protocol.js';

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
   *
   * Multi-line values additionally register each of their individual lines.
   * Log output is split into lines before it reaches the masker, so a value
   * containing a newline can never match as a whole — a PEM private key or a
   * kubeconfig would otherwise stream in clear text. Two consequences of the
   * per-line registration are deliberate:
   *
   * - `MIN_MASK_LENGTH` is 3, so short structural lines of a structured secret
   *   are registered too. A `---` YAML separator or a bare `{` from a
   *   service-account JSON is masked wherever it appears in that job's logs.
   * - PEM header and footer lines (`-----BEGIN OPENSSH PRIVATE KEY-----`) are
   *   not secret on their own and are masked as a side effect.
   *
   * Both are strictly safer than leaking the body, and no heuristic separates a
   * structural line from a body line without risking the reverse mistake.
   */
  registerSecrets(secrets: Record<string, string>): void {
    // Collect unique values that qualify for masking
    const seen = new Set<string>();
    const values: string[] = [];

    const add = (candidate: string): void => {
      if (candidate.length < MIN_MASK_LENGTH || seen.has(candidate)) return;
      seen.add(candidate);
      values.push(candidate);

      // Also register the base64-encoded variant
      const b64 = Buffer.from(candidate).toString('base64');
      if (b64.length >= MIN_MASK_LENGTH && !seen.has(b64)) {
        seen.add(b64);
        values.push(b64);
      }
    };

    for (const value of Object.values(secrets)) {
      add(value);

      // A multi-line value never matches a single log line, so register each of
      // its lines as well. Trailing \r is stripped so a CRLF-delimited secret
      // still matches the line the log carries.
      if (value.includes('\n')) {
        for (const rawLine of value.split('\n')) {
          add(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
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

/**
 * Create a LogMasker initialized with all secret values from the request.
 *
 * Collects values from both flat secrets and all namespaced context secrets,
 * deduplicating before registration.
 *
 * Both the runner child and the agent-side fork runner build a masker from the
 * same request, so the crash tail the agent assembles from the child's stderr is
 * masked with the same value set the child used for its own log lines.
 */
export function createSecretMasker(request: JobExecutionRequest): LogMasker {
  const masker = new LogMasker();
  const allSecrets: Record<string, string> = {};

  // Collect flat secrets
  if (request.secrets) {
    Object.assign(allSecrets, request.secrets);
  }

  // Collect all namespaced secret values
  if (request.namespacedSecrets) {
    for (const contextSecrets of Object.values(request.namespacedSecrets)) {
      Object.assign(allSecrets, contextSecrets);
    }
  }

  masker.registerSecrets(allSecrets);
  return masker;
}

/**
 * Mask every operator-visible text field of an outbound runner message.
 *
 * Each message type carrying free text is named here, so a new text-bearing
 * message type is a visible omission rather than a silent leak. `step.complete`
 * error text and the `job.complete` failure reason are persisted on the step and
 * run rows the dashboard renders, so they need the same masking `log.line` gets.
 *
 * Returns the message unchanged when no secrets are registered.
 */
export function maskMessageText(
  msg: RunnerToAgentMessage,
  masker: LogMasker,
): RunnerToAgentMessage {
  if (!masker.hasSecrets()) return msg;

  switch (msg.type) {
    case 'log.line':
      return { ...msg, line: masker.mask(msg.line) };
    case 'step.complete':
      return msg.error
        ? { ...msg, error: { ...msg.error, message: masker.mask(msg.error.message) } }
        : msg;
    case 'job.complete': {
      const masked = { ...msg };
      if (masked.error !== undefined) masked.error = masker.mask(masked.error);
      if (masked.droppedJobs) masked.droppedJobs = masked.droppedJobs.map((j) => masker.mask(j));
      return masked;
    }
    default:
      return msg;
  }
}
