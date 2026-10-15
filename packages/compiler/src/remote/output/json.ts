/** `--json` output for CI integration. */

import type { RunResult } from './summary.js';

interface JsonOutput {
  results: Array<{
    fixtureId: string;
    runId: string;
    status: string;
    totalDurationMs: number;
    jobs: Array<{
      name: string;
      status: string;
      durationMs?: number;
    }>;
  }>;
  summary: {
    passed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
}

export function formatJsonResult(results: RunResult[]): string {
  const passed = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const cancelled = results.filter((r) => r.status === 'cancelled').length;

  const output: JsonOutput = {
    results: results.map((r) => ({
      fixtureId: r.fixtureId,
      runId: r.runId,
      status: r.status,
      totalDurationMs: r.totalDurationMs,
      jobs: r.jobs.map((j) => ({
        name: j.name,
        status: j.status,
        ...(j.durationMs !== undefined && { durationMs: j.durationMs }),
      })),
    })),
    summary: {
      passed,
      failed,
      cancelled,
      total: results.length,
    },
  };

  return JSON.stringify(output, null, 2);
}
