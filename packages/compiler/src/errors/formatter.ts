import pc from 'picocolors';

/** Error code string (e.g., 'E001', 'E102'). */
type ErrorCode = string;

/** Source location for error reporting */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Compiler error with all context */
export interface CompilerError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly location?: SourceLocation;
  readonly suggestion?: string;
}

/**
 * Format error in GNU standard format: file:line:column: error [CODE]: message
 *
 * Example output:
 * .kici/workflows/ci.ts:15:3 error [E102]: Circular dependency detected
 *   Suggestion: Remove dependency 'build' -> 'test' -> 'build'
 */
export function formatError(error: CompilerError): string {
  const parts: string[] = [];

  // Location prefix (GNU standard)
  if (error.location) {
    parts.push(pc.cyan(`${error.location.file}:${error.location.line}:${error.location.column}`));
  }

  // Error with code
  parts.push(pc.red('error') + pc.gray(` [${error.code}]`) + ': ' + error.message);

  let output = parts.join(' ');

  // Optional suggestion
  if (error.suggestion) {
    output += '\n  ' + pc.dim(`Suggestion: ${error.suggestion}`);
  }

  return output;
}

/** Create a CompilerError and throw it */
export function compilerError(
  code: ErrorCode,
  message: string,
  options?: {
    location?: SourceLocation;
    suggestion?: string;
  },
): CompilerError {
  return {
    code,
    message,
    location: options?.location,
    suggestion: options?.suggestion,
  };
}

/** Check if an error is a CompilerError (codes are E + digits, e.g. E001, E102) */
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
