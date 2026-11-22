/**
 * Scaler provisioning check: one row per configured backend from in-process spawn failures
 * over a rolling window, plus the scaler's live consecutive-failure backoff. A warm-pool/unbound
 * failure warns (no run impact yet); a job-bound failure fails (a queued run could not get an
 * agent). A scaler still deferred warns even when its last failure has left the window: the
 * backoff ceiling is longer than the window, so the window alone would read a broken scaler as
 * healthy. Only a live deferral counts: once it runs out, or after a failure that is retried at
 * once, the row reads the window alone.
 */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import type { ProvisionBackoffStatus } from '../../scaler/manager.js';

export const SCALER_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/** Short enough to read in the diagnose table. */
const MAX_DETAIL_LEN = 120;

function truncate(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN - 1)}…` : s;
}

/**
 * A scaler's backoff while a deferral is still running, or undefined. The manager keeps the
 * failure count until an agent registers, which can be hours after a single failure when
 * nothing spawns again; that count alone says nothing is being held back.
 */
function liveBackoff(
  backoff: ProvisionBackoffStatus | undefined,
  nowMs: number,
): ProvisionBackoffStatus | undefined {
  // fails-when: a count with an expired or zero deferral reads as `failing … next try in 0s`
  // breaks-if-wrong: a deferral still running must keep the marker
  return backoff && backoff.deferUntilMs > nowMs ? backoff : undefined;
}

/**
 * The leading marker for a scaler with a live backoff. It LEADS the message, like the
 * retirement marker, because the diagnose table cuts messages at a fixed width.
 */
function backoffPrefix(backoff: ProvisionBackoffStatus | undefined, nowMs: number): string {
  if (!backoff) return '';
  const waitS = Math.max(0, Math.ceil((backoff.deferUntilMs - nowMs) / 1000));
  return `failing (${backoff.consecutiveFailures} in a row, next try in ${waitS}s) — `;
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

  const nowMs = Date.now();
  const recent = mgr.recentSpawnFailures(SCALER_FAILURE_WINDOW_MS, nowMs);
  const backoffs = mgr.provisionBackoffStatus();

  return backends.map((backend) => {
    const summary = recent.get(backend.name);
    const backoff = liveBackoff(backoffs.get(backend.name), nowMs);
    const durationMs = Date.now() - start;
    // A scaler removed from the config drains before it disappears; mark its row. The marker
    // LEADS because the diagnose table truncates messages to a fixed width, which would cut
    // a trailing marker on the rows carrying failure text. `details` stays untruncated.
    const retiringPrefix = backend.retiring
      ? `retiring (${backend.activeCount} agent(s) left) — `
      : '';
    const prefix = `${retiringPrefix}${backoffPrefix(backoff, nowMs)}`;
    const backoffDetails = backoff
      ? {
          consecutiveFailures: backoff.consecutiveFailures,
          deferUntilMs: backoff.deferUntilMs,
        }
      : {};

    if (!summary || summary.boundCount + summary.unboundCount === 0) {
      return {
        name: `scaler:${backend.name}`,
        // fails-when: a scaler deferred past the 5-minute window reads `pass` with no marker
        status: backoff ? ('warn' as const) : ('pass' as const),
        message: `${prefix}0 spawn failures in last 5m`,
        details: {
          windowMs: SCALER_FAILURE_WINDOW_MS,
          backendType: backend.type,
          boundCount: 0,
          unboundCount: 0,
          retiring: backend.retiring,
          activeCount: backend.activeCount,
          ...backoffDetails,
        },
        durationMs,
      };
    }

    const total = summary.boundCount + summary.unboundCount;
    const status: 'warn' | 'fail' = summary.boundCount > 0 ? 'fail' : 'warn';
    const message = `${prefix}${total} spawn failures in last 5m (${summary.boundCount} bound, ${summary.unboundCount} warm-pool; last: ${truncate(summary.lastError)})`;

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
        ...backoffDetails,
      },
      durationMs,
    };
  });
}
