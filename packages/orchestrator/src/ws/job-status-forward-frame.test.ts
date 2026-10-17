import { describe, expect, it } from 'vitest';
import {
  ExecutionJobStatus,
  STATUS_FREE_TEXT_MAX,
  TRUNCATION_MARKER,
  jobStatusForwardSchema,
} from '@kici-dev/engine';
import { buildJobStatusForwardFrame } from './job-status-forward-frame.js';

const base = {
  messageId: 'm-1',
  runId: 'run-1',
  jobId: 'job-1',
  jobName: 'build',
  status: ExecutionJobStatus.enum.failed,
  timestamp: 1_700_000_000_000,
  orchestratorId: 'orch-1',
};

describe('buildJobStatusForwardFrame', () => {
  it('clamps a long error to the wire bound at the source', () => {
    const frame = buildJobStatusForwardFrame({
      ...base,
      errorMessage: '\rDownloading toolchain 42%'.repeat(400),
      initFailure: { scope: 'job', category: 'dynamic_eval', message: 'x'.repeat(9_000) },
    });
    // fails-when: the frame carries an error the Platform would have to shorten or refuse
    expect(frame.errorMessage).toHaveLength(STATUS_FREE_TEXT_MAX);
    expect(frame.errorMessage!.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(frame.initFailure!.message).toHaveLength(STATUS_FREE_TEXT_MAX);
    // Property: the frame is already what the wire schema would produce.
    expect(jobStatusForwardSchema.parse(frame)).toEqual(frame);
  });

  it('sends the job contexts under the field the wire schema keeps', () => {
    const frame = buildJobStatusForwardFrame({ ...base, contexts: ['staging', 'prod'] });
    // fails-when: the contexts ride a key the schema strips (the Platform mirror never sees them)
    expect(jobStatusForwardSchema.parse(frame).contexts).toEqual(['staging', 'prod']);
  });

  it('omits every optional field the tracker did not supply', () => {
    const frame = buildJobStatusForwardFrame(base);
    // breaks-if-wrong: an absent field stays absent, so the Platform keeps its stored value
    expect(Object.keys(frame).sort()).toEqual(
      [
        'jobId',
        'jobName',
        'messageId',
        'orchestratorId',
        'runId',
        'status',
        'timestamp',
        'type',
      ].sort(),
    );
    expect(buildJobStatusForwardFrame({ ...base, errorMessage: 'short' }).errorMessage).toBe(
      'short',
    );
  });
});
