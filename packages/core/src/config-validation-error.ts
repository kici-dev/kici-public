/**
 * The error a service throws when its environment configuration fails
 * validation. Each issue names the environment variable an operator sets, so
 * the message is actionable without knowing the internal config field names.
 */

/** One failed configuration field. */
export interface ConfigIssue {
  /** The environment variable behind the field; undefined for a field no variable backs. */
  envVar?: string;
  /** Dotted path of the field inside the parsed config. */
  field: string;
  message: string;
}

/**
 * Brand checked instead of `instanceof`: an install tree can hold two copies of
 * this module, and an error built by one copy must still match in the other.
 */
const CONFIG_VALIDATION_ERROR_BRAND = Symbol.for('kici.configValidationError');

function namesVar(message: string, envVar: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${envVar}($|[^A-Za-z0-9_])`).test(message);
}

function formatIssue(issue: ConfigIssue): string {
  if (issue.envVar !== undefined) {
    return namesVar(issue.message, issue.envVar)
      ? `  - ${issue.message}`
      : `  - ${issue.envVar}: ${issue.message}`;
  }
  return issue.field === '' ? `  - ${issue.message}` : `  - ${issue.field}: ${issue.message}`;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[], hint?: string) {
    const lines = issues.map(formatIssue).join('\n');
    super(`Configuration validation failed:\n${lines}${hint ? `\n${hint}` : ''}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
    Object.defineProperty(this, CONFIG_VALIDATION_ERROR_BRAND, { value: true });
  }
}

export function isConfigValidationError(err: unknown): err is ConfigValidationError {
  return (
    err instanceof Error &&
    (err as unknown as Record<symbol, unknown>)[CONFIG_VALIDATION_ERROR_BRAND] === true
  );
}
