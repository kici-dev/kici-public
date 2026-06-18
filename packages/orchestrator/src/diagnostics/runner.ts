/**
 * Diagnostic check runner.
 *
 * Executes all diagnostic checks in parallel with timeout safety.
 * Each check runs independently -- a failing or timing out check
 * does not prevent other checks from completing.
 */

import type { DiagnosticCheck, DiagnosticDeps, DiagnosticResult } from './types.js';
import { defaultChecks } from './checks/index.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Options for the diagnostic runner. */
export interface RunDiagnosticsOptions {
  /** Timeout per check in milliseconds. Default: 5000. */
  timeoutMs?: number;
}

/**
 * Run all diagnostic checks and return results.
 *
 * @param deps - Dependencies available to checks
 * @param checks - Array of check functions (defaults to all 6 checks)
 * @param options - Runner options (timeout, etc.)
 * @returns Array of diagnostic results, one per check
 */
export async function runDiagnostics(
  deps: DiagnosticDeps,
  checks?: DiagnosticCheck[],
  options?: RunDiagnosticsOptions,
): Promise<DiagnosticResult[]> {
  const checksToRun = checks ?? defaultChecks;
  const timeoutMs = options?.timeoutMs ?? 5000;

  const results = await Promise.allSettled(
    checksToRun.map((check) => runWithTimeout(check, deps, timeoutMs)),
  );

  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return Array.isArray(result.value) ? result.value : [result.value];
    }

    // Promise.allSettled rejected -- this shouldn't happen since runWithTimeout catches,
    // but handle defensively
    return [
      {
        name: `Check ${index + 1}`,
        status: 'fail' as const,
        message: `Unexpected error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        durationMs: 0,
      },
    ];
  });
}

/**
 * Run a single check with a timeout.
 * If the check throws or times out, return a fail result.
 */
async function runWithTimeout(
  check: DiagnosticCheck,
  deps: DiagnosticDeps,
  timeoutMs: number,
): Promise<DiagnosticResult | DiagnosticResult[]> {
  const start = Date.now();

  return new Promise<DiagnosticResult | DiagnosticResult[]>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        name: 'Unknown check',
        status: 'fail',
        message: `Check timeout after ${timeoutMs}ms`,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);

    check(deps)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({
          name: 'Unknown check',
          status: 'fail',
          message: `Check error: ${toErrorMessage(err)}`,
          durationMs: Date.now() - start,
        });
      });
  });
}
