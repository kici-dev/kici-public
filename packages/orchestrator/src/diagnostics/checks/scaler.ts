/**
 * Scaler provisioning check: one row per configured backend from in-process spawn failures
 * over a rolling window. A warm-pool/unbound failure warns (no run impact yet); a job-bound
 * failure fails (a queued run could not get an agent).
 */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';

export const SCALER_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/** Short enough to read in the diagnose table. */
const MAX_DETAIL_LEN = 120;

function truncate(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN - 1)}…` : s;
}

export async function checkScalerProvisioning(deps: DiagnosticDeps): Promise<DiagnosticResult[]> {
  const start = Date.now();
  const mgr = deps.scalerManager;
  const backends = mgr?.getStatus().backends ?? [];

  if (!mgr || backends.length === 0) {
    return [
      {
        name: 'scaler',
        status: 'pass',
        message: 'No scaler backends configured',
        durationMs: Date.now() - start,
      },
    ];
  }

  const recent = mgr.recentSpawnFailures(SCALER_FAILURE_WINDOW_MS, Date.now());

  return backends.map((backend) => {
    const summary = recent.get(backend.name);
    const durationMs = Date.now() - start;
    // A scaler removed from the config drains before it disappears; mark its row. The marker
    // LEADS because the diagnose table truncates messages to a fixed width, which would cut
    // a trailing marker on the rows carrying failure text. `details` stays untruncated.
    const retiringPrefix = backend.retiring
      ? `retiring (${backend.activeCount} agent(s) left) — `
      : '';

    if (!summary || summary.boundCount + summary.unboundCount === 0) {
      return {
        name: `scaler:${backend.name}`,
        status: 'pass' as const,
        message: `${retiringPrefix}0 spawn failures in last 5m`,
        details: {
          windowMs: SCALER_FAILURE_WINDOW_MS,
          backendType: backend.type,
          boundCount: 0,
          unboundCount: 0,
          retiring: backend.retiring,
          activeCount: backend.activeCount,
        },
        durationMs,
      };
    }

    const total = summary.boundCount + summary.unboundCount;
    const status: 'warn' | 'fail' = summary.boundCount > 0 ? 'fail' : 'warn';
    const message = `${retiringPrefix}${total} spawn failures in last 5m (${summary.boundCount} bound, ${summary.unboundCount} warm-pool; last: ${truncate(summary.lastError)})`;

    return {
      name: `scaler:${backend.name}`,
      status,
      message,
      details: {
        windowMs: SCALER_FAILURE_WINDOW_MS,
        backendType: summary.backendType,
        boundCount: summary.boundCount,
        unboundCount: summary.unboundCount,
        lastError: summary.lastError,
        lastAtMs: summary.lastAtMs,
        retiring: backend.retiring,
        activeCount: backend.activeCount,
      },
      durationMs,
    };
  });
}
