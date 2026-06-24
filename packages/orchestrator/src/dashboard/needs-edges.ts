import type { ExecutionJobStatus } from '@kici-dev/engine';

/** A single resolved upstream dependency edge for a job. */
export interface JobNeedEdge {
  upstreamName: string;
  /** Upstream terminal statuses that satisfy this edge (the run-on set). */
  runOn: ExecutionJobStatus[];
}

const SUCCESS_ONLY: ExecutionJobStatus[] = ['success'];

/** Parse a persisted run_on JSON column into a status-set array. */
function parseRunOn(json: string): ExecutionJobStatus[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as ExecutionJobStatus[];
  } catch {
    // Malformed value falls back to success-only below.
  }
  return SUCCESS_ONLY;
}

/** Group raw execution_job_needs rows by downstream job_name. */
export function groupNeedsByJobName(
  rows: ReadonlyArray<{ job_name: string; upstream_name: string; run_on: string }>,
): Map<string, JobNeedEdge[]> {
  const byJob = new Map<string, JobNeedEdge[]>();
  for (const r of rows) {
    const list = byJob.get(r.job_name) ?? [];
    list.push({
      upstreamName: r.upstream_name,
      runOn: parseRunOn(r.run_on),
    });
    byJob.set(r.job_name, list);
  }
  return byJob;
}
