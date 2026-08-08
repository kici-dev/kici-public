/**
 * Shared diagnostic-result contract used by both `kici doctor` (developer CLI)
 * and `kici-admin diagnose` (operator CLI) so the two agree on the status
 * vocabulary and the 0/1/2 exit-code mapping.
 */

/** The per-check status vocabulary. Single source of truth. */
export const DIAGNOSE_STATUSES = ['pass', 'warn', 'fail'] as const;
export type DiagnoseStatus = (typeof DIAGNOSE_STATUSES)[number];

/** The overall roll-up vocabulary. */
export const DIAGNOSE_OVERALLS = ['healthy', 'degraded', 'unhealthy'] as const;
export type DiagnoseOverall = (typeof DIAGNOSE_OVERALLS)[number];

/** One diagnostic check outcome. */
export interface DiagnoseResult {
  name: string;
  status: DiagnoseStatus;
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

/** A full diagnostic response: a set of checks plus a roll-up. */
export interface DiagnoseResponse {
  status: DiagnoseOverall;
  checks: DiagnoseResult[];
  timestamp: string;
}

/**
 * Map a set of check results to a process exit code:
 *   0 — all pass
 *   1 — at least one warn, no fail
 *   2 — at least one fail
 */
export function diagnoseExitCode(checks: readonly Pick<DiagnoseResult, 'status'>[]): number {
  if (checks.some((c) => c.status === 'fail')) return 2;
  if (checks.some((c) => c.status === 'warn')) return 1;
  return 0;
}

/** Roll a set of check results up to an overall status. */
export function deriveDiagnoseOverall(
  checks: readonly Pick<DiagnoseResult, 'status'>[],
): DiagnoseOverall {
  if (checks.some((c) => c.status === 'fail')) return 'unhealthy';
  if (checks.some((c) => c.status === 'warn')) return 'degraded';
  return 'healthy';
}
