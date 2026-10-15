import type { Job } from '@kici-dev/sdk';
import type { SourceLocation } from './formatter.js';

/**
 * First step (walking one level into parallel groups) that carries a captured
 * `_sourceLocation`. `step()` records a precise V8 call-site; bare functions and
 * parallel-group wrappers do not, so this returns the first real anchor found.
 */
export function firstStepLocation(job: Job): SourceLocation | undefined {
  for (const entry of job.steps ?? []) {
    const stepLike = entry as { _sourceLocation?: SourceLocation };
    if (stepLike._sourceLocation) return stepLike._sourceLocation;
    // Parallel group: look one level in for a child step's location.
    const group = entry as { steps?: Array<{ _sourceLocation?: SourceLocation }> };
    if (Array.isArray(group.steps)) {
      const inner = group.steps.find((c) => c._sourceLocation)?._sourceLocation;
      if (inner) return inner;
    }
  }
  return undefined;
}

/** The first step's location, else line 1 of the workflow file: `job()` captures no call-site. */
export function locationForJob(job: Job, workflowFile: string): SourceLocation {
  return firstStepLocation(job) ?? { file: workflowFile, line: 1, column: 1 };
}

/** `workflow()` captures no call-site, so the anchor is line 1 of its file. */
export function locationForWorkflow(file: string): SourceLocation {
  return { file, line: 1, column: 1 };
}
