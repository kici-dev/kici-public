import type { RunsOn } from '@kici-dev/sdk';

/** Render one selector element (string label or RegExp) for the local display string. */
function runsOnElementString(el: string | RegExp): string {
  return el instanceof RegExp ? el.toString() : el;
}

/**
 * Render a job's `runsOn` to the comma-joined label string the local/test
 * runners surface as `ctx.job.runsOn`. A `runsOnAll` job has no `runsOn` —
 * locally it runs once on this machine, so we surface the marker `'runsOnAll'`.
 * RegExp selectors render via their `/source/flags` literal.
 */
export function localRunsOnString(runsOn: RunsOn | undefined): string {
  if (runsOn === undefined) return 'runsOnAll';
  if (typeof runsOn === 'string') return runsOn;
  if (runsOn instanceof RegExp) return runsOn.toString();
  if (Array.isArray(runsOn)) return runsOn.map(runsOnElementString).join(',');
  const labels = Array.isArray(runsOn.labels) ? runsOn.labels : [runsOn.labels];
  return labels.map(runsOnElementString).join(',');
}
