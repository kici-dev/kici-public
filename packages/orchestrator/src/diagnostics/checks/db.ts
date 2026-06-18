/**
 * Database connectivity diagnostic check.
 *
 * Runs a simple SELECT 1 query to verify the database is reachable
 * and reports latency.
 */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

export async function checkDbConnectivity(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  if (!deps.db) {
    return {
      name: 'Database connectivity',
      status: 'fail',
      message: 'Database not configured',
      durationMs: Date.now() - start,
    };
  }

  try {
    await deps.db.selectFrom('dedup_cache').select('delivery_id').limit(1).execute();
    const durationMs = Date.now() - start;
    return {
      name: 'Database connectivity',
      status: 'pass',
      message: `Connected (${durationMs}ms latency)`,
      details: { latencyMs: durationMs },
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      name: 'Database connectivity',
      status: 'fail',
      message: `Database error: ${toErrorMessage(err)}`,
      durationMs,
    };
  }
}
