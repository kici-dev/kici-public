import type { RunsOn } from '@kici-dev/sdk';

function runsOnElementString(el: string | RegExp): string {
  return el instanceof RegExp ? el.toString() : el;
}

/**
 * The comma-joined label string the local/test runners surface as
 * `ctx.job.runsOn`. A `runsOnAll` job has no `runsOn` and runs once locally,
 * so it surfaces the marker `'runsOnAll'`.
 */
export function localRunsOnString(runsOn: RunsOn | undefined): string {
  if (runsOn === undefined) return 'runsOnAll';
  if (typeof runsOn === 'string') return runsOn;
  if (runsOn instanceof RegExp) return runsOn.toString();
  if (Array.isArray(runsOn)) return runsOn.map(runsOnElementString).join(',');
  const labels = Array.isArray(runsOn.labels) ? runsOn.labels : [runsOn.labels];
  return labels.map(runsOnElementString).join(',');
}
