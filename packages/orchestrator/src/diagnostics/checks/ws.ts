/** Platform connectivity check: an HTTP(S) request to the Platform health endpoint. */

import type { DiagnosticDeps, DiagnosticResult } from '../types.js';
import { toErrorMessage } from '@kici-dev/shared';

export async function checkWsToPlatform(deps: DiagnosticDeps): Promise<DiagnosticResult> {
  const start = Date.now();

  if (!deps.platformUrl) {
    return {
      name: 'Platform connectivity',
      status: 'warn',
      message: 'Platform URL not configured (standalone mode)',
      durationMs: Date.now() - start,
    };
  }

  try {
    // ws(s)://…/ws → http(s)://…/health
    const healthUrl = deps.platformUrl
      .replace(/^ws(s?):\/\//, 'http$1://')
      .replace(/\/ws$/, '/health');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const durationMs = Date.now() - start;

      if (res.ok) {
        return {
          name: 'Platform connectivity',
          status: 'pass',
          message: `Platform reachable (${durationMs}ms)`,
          details: { url: healthUrl, statusCode: res.status },
          durationMs,
        };
      }

      return {
        name: 'Platform connectivity',
        status: 'fail',
        message: `Platform returned HTTP ${res.status}`,
        details: { url: healthUrl, statusCode: res.status },
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      name: 'Platform connectivity',
      status: 'fail',
      message: `Platform unreachable: ${toErrorMessage(err)}`,
      durationMs,
    };
  }
}
