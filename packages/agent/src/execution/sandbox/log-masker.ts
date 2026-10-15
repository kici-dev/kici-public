/**
 * Replaces registered secret values with '***' in the workflow runner's IPC log
 * messages. One combined regex scans each line in a single pass.
 */

import type { JobExecutionRequest, RunnerToAgentMessage } from './ipc-protocol.js';

/** Shorter values are not masked, to avoid false positives. */
const MIN_MASK_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ```ts
 * const masker = new LogMasker();
 * masker.registerSecrets({ TOKEN: 'abc123', SHORT: 'ab' });
 * masker.mask('Token is abc123'); // 'Token is ***'
 * // 'ab' is NOT masked (< 3 chars)
 * ```
 */
export class LogMasker {
  private pattern: RegExp | null = null;
  /** Every value registered so far, raw and base64-encoded. */
  private readonly values = new Set<string>();

  /**
   * Skips values under 3 characters. Also registers each value's base64 form
   * (Authorization: Basic headers, base64 config values). Longer values match
   * first, so a secret that is a substring of another never half-masks it.
   *
   * Log output is split into lines before masking, so a multi-line value (a PEM
   * key, a kubeconfig) also registers each line. Deliberately, that masks short
   * structural lines (a `---` YAML separator, a bare `{` of a service-account
   * JSON) and PEM header/footer lines everywhere in the job's logs: safer than
   * leaking the body, and no heuristic separates structural from body lines
   * without risking the reverse mistake.
   *
   * Registrations accumulate: a later call (a mounted file, an OIDC token)
   * extends the set and earlier values stay masked.
   */
  registerSecrets(secrets: Record<string, string>): void {
    const add = (candidate: string): void => {
      if (candidate.length < MIN_MASK_LENGTH) return;
      this.values.add(candidate);

      const b64 = Buffer.from(candidate).toString('base64');
      if (b64.length >= MIN_MASK_LENGTH) this.values.add(b64);
    };

    for (const value of Object.values(secrets)) {
      add(value);

      // Trailing \r is stripped so a CRLF-delimited secret matches the log line.
      if (value.includes('\n')) {
        for (const rawLine of value.split('\n')) {
          add(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        }
      }
    }

    if (this.values.size === 0) {
      this.pattern = null;
      return;
    }

    const values = [...this.values].sort((a, b) => b.length - a.length);

    this.pattern = new RegExp(values.map((v) => escapeRegExp(v)).join('|'), 'g');
  }

  mask(line: string): string {
    if (!this.pattern) {
      return line;
    }
    // A global regex is stateful.
    this.pattern.lastIndex = 0;
    return line.replace(this.pattern, '***');
  }

  hasSecrets(): boolean {
    return this.pattern !== null;
  }
}

/**
 * A masker over the request's flat and namespaced secrets. The runner child and
 * the agent-side fork runner both build one from the same request, so the crash
 * tail the agent assembles from the child's stderr is masked with the child's
 * value set.
 */
export function createSecretMasker(request: JobExecutionRequest): LogMasker {
  const masker = new LogMasker();
  const allSecrets: Record<string, string> = {};

  if (request.secrets) {
    Object.assign(allSecrets, request.secrets);
  }

  if (request.namespacedSecrets) {
    for (const contextSecrets of Object.values(request.namespacedSecrets)) {
      Object.assign(allSecrets, contextSecrets);
    }
  }

  masker.registerSecrets(allSecrets);
  return masker;
}

/**
 * Masks every operator-visible text field of an outbound runner message. Each
 * text-bearing type is named here, so a new one is a visible omission rather
 * than a silent leak; `step.complete` errors and the `job.complete` reason
 * persist on the rows the dashboard renders.
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
    case 'dep-restore.report': {
      const maskError = <T extends { message: string; causeMessage?: string }>(e: T): T => ({
        ...e,
        message: masker.mask(e.message),
        ...(e.causeMessage !== undefined && { causeMessage: masker.mask(e.causeMessage) }),
      });
      const r = msg.report;
      if (!r) return msg;
      return {
        ...msg,
        report: {
          ...r,
          ...(r.error && { error: maskError(r.error) }),
          attempts: r.attempts.map((a) => (a.error ? { ...a, error: maskError(a.error) } : a)),
        },
      };
    }
    default:
      return msg;
  }
}
