import { IfFailedPolicy } from '@kici-dev/engine';

/** A single resolved upstream dependency edge for a job. */
export interface JobNeedEdge {
  upstreamName: string;
  ifFailed: IfFailedPolicy;
}

/** Group raw execution_job_needs rows by downstream job_name. */
export function groupNeedsByJobName(
  rows: ReadonlyArray<{ job_name: string; upstream_name: string; if_failed: string }>,
): Map<string, JobNeedEdge[]> {
  const byJob = new Map<string, JobNeedEdge[]>();
  for (const r of rows) {
    const list = byJob.get(r.job_name) ?? [];
    list.push({
      upstreamName: r.upstream_name,
      ifFailed:
        r.if_failed === IfFailedPolicy.enum.run
          ? IfFailedPolicy.enum.run
          : IfFailedPolicy.enum.skip,
    });
    byJob.set(r.job_name, list);
  }
  return byJob;
}
