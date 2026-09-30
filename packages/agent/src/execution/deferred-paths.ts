/**
 * The agent's verdict on `paths` the orchestrator could only match
 * conservatively: decided from the clone's diff. An agent that could not diff
 * either runs the workflow — dropping a real change is worse than a spurious run.
 */
import { matchPathPatterns, type ChangedFilesStatus } from '@kici-dev/engine';

/** True when any deferred `paths` list matches the diff, or the diff is unavailable. */
export function evaluateDeferredPaths(
  deferredPaths: readonly (readonly string[])[],
  diff: { files: string[]; status: ChangedFilesStatus },
): boolean {
  // fails-when: a fetched diff that misses every list returns true
  // breaks-if-wrong: an unavailable diff must still run the workflow
  if (diff.status !== 'fetched') return true;
  return deferredPaths.some((paths) => matchPathPatterns(paths, diff.files, 'fetched'));
}

/** The step-log line recording a paths no-match. */
export function describePathsVerdict(
  deferredPaths: readonly (readonly string[])[],
  diff: { files: string[] },
): string {
  const lists = deferredPaths.map((p) => `[${p.join(', ')}]`).join(' or ');
  return `paths: no match for ${lists} against ${diff.files.length} changed file(s) — workflow does not run`;
}
