import { describe, expect, it } from 'vitest';
import { STATUS_ID_MAX, jobStatusForwardSchema } from './execution-status.js';
import { INVALID_FRAME_PATHS_MAX, invalidFramePaths } from './frame-issues.js';

const job = {
  type: 'job.status.forward',
  messageId: 'm',
  runId: 'r',
  jobId: 'j',
  jobName: 'build',
  status: 'failed',
  timestamp: 1,
};

function issuesOf(frame: unknown) {
  const parsed = jobStatusForwardSchema.safeParse(frame);
  if (parsed.success) throw new Error('fixture unexpectedly valid');
  return parsed.error.issues;
}

describe('invalidFramePaths', () => {
  it('names the failing field', () => {
    expect(invalidFramePaths(issuesOf({ ...job, jobId: 'J'.repeat(STATUS_ID_MAX + 1) }))).toEqual([
      'jobId',
    ]);
  });

  it('never carries a sender-chosen record key', () => {
    const key = 'K'.repeat(STATUS_ID_MAX + 1);
    const paths = invalidFramePaths(issuesOf({ ...job, matrixValues: { [key]: 1 } }));
    // fails-when: the record key (frame content) is copied into the path
    expect(paths).toEqual(['matrixValues.*']);
    expect(paths.join()).not.toContain('KKKK');
  });

  it('keeps array indexes and names the frame itself for a root failure', () => {
    expect(invalidFramePaths([{ path: ['runsOnLabels', 3] }, { path: [] }])).toEqual([
      'runsOnLabels.3',
      '(frame)',
    ]);
  });

  it('lists at most INVALID_FRAME_PATHS_MAX distinct paths', () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({ path: [`field${i}`] }));
    expect(invalidFramePaths(issues)).toHaveLength(INVALID_FRAME_PATHS_MAX);
    expect(invalidFramePaths([{ path: ['a'] }, { path: ['a'] }])).toEqual(['a']);
  });
});
