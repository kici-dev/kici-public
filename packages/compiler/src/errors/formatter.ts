import pc from 'picocolors';

/**
 * Error code string. Thrown compile errors use `E<digits>` (e.g. 'E001', 'E102');
 * advisory, render-only diagnostics use `W<digits>`. `isCompilerError` only
 * matches the `E<digits>` family — warning codes are never thrown, only rendered.
 */
type ErrorCode = string;

/** Errors abort compilation; warnings are advisory and compilation still succeeds. */
export enum DiagnosticSeverity {
  Error = 'error',
  Warning = 'warning',
}

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface CompilerError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly location?: SourceLocation;
  readonly suggestion?: string;
  readonly severity?: DiagnosticSeverity;
}

/**
 * Formats an error as `file:line:column error [CODE]: message`, close to the
 * GNU standard, with an optional indented suggestion line.
 *
 * Example output:
 * .kici/workflows/ci.ts:15:3 error [E102]: Circular dependency detected
 *   Suggestion: Remove dependency 'build' -> 'test' -> 'build'
 */
export function formatError(error: CompilerError): string {
  const parts: string[] = [];

  if (error.location) {
    parts.push(pc.cyan(`${error.location.file}:${error.location.line}:${error.location.column}`));
  }

  const label =
    error.severity === DiagnosticSeverity.Warning ? pc.yellow('warning') : pc.red('error');
  parts.push(label + pc.gray(` [${error.code}]`) + ': ' + error.message);

  let output = parts.join(' ');

  if (error.suggestion) {
    output += '\n  ' + pc.dim(`Suggestion: ${error.suggestion}`);
  }

  return output;
}

/** Creates a CompilerError and returns it; the caller throws it. */
export function compilerError(
  code: ErrorCode,
  message: string,
  options?: {
    location?: SourceLocation;
    suggestion?: string;
    severity?: DiagnosticSeverity;
  },
): CompilerError {
  return {
    code,
    message,
    location: options?.location,
    suggestion: options?.suggestion,
    severity: options?.severity,
  };
}

/** Matches only `E<digits>` codes (e.g. E001, E102), never a `W` warning. */
export function isCompilerError(error: unknown): error is CompilerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as CompilerError).code === 'string' &&
    /^E\d+$/.test((error as CompilerError).code)
  );
}
