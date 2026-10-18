/** `--json` output for CI integration. */

import type { RunJobResult, RunResult } from './summary.js';

interface JsonJob {
  name: string;
  status: string;
  durationMs?: number;
  workflowName?: string;
}

interface JsonOutput {
  results: Array<{
    fixtureId: string;
    /** @deprecated The first run of `runs`; read `runs`, one entry per matched workflow. */
    runId: string;
    /** The combined result of every run. */
    status: string;
    totalDurationMs: number;
    jobs: JsonJob[];
    runs?: Array<{ runId: string; workflowName?: string; status: string; jobs: JsonJob[] }>;
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
      jobs: r.jobs.map(jsonJob),
      ...(r.runs && {
        runs: r.runs.map((run) => ({
          runId: run.runId,
          ...(run.workflowName !== undefined && { workflowName: run.workflowName }),
          status: run.status,
          jobs: run.jobs.map(jsonJob),
        })),
      }),
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

function jsonJob(j: RunJobResult): JsonJob {
  return {
    name: j.name,
    status: j.status,
    ...(j.durationMs !== undefined && { durationMs: j.durationMs }),
    ...(j.workflowName !== undefined && { workflowName: j.workflowName }),
  };
}
