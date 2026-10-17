import { describe, expect, it, vi } from 'vitest';

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mockLogError, debug: vi.fn() }),
  };
});

import {
  ExecutionJobStatus,
  STATUS_FREE_TEXT_MAX,
  STATUS_ID_MAX,
  type OrchestratorToPlatformMessage,
} from '@kici-dev/engine';
import { guardOutboundFrame } from './outbound-frame-guard.js';

const jobFrame = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'job.status.forward',
    messageId: 'm-1',
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'build',
    status: ExecutionJobStatus.enum.failed,
    timestamp: 1,
    ...extra,
  }) as OrchestratorToPlatformMessage;

describe('guardOutboundFrame', () => {
  it('refuses a status frame the Platform would reject, and logs its field paths', () => {
    // fails-when: an invalid frame reaches the wire and costs the connection a strike
    expect(guardOutboundFrame(jobFrame({ jobId: 'J'.repeat(STATUS_ID_MAX + 1) }))).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      'Refusing to send an invalid frame to the Platform',
      expect.objectContaining({ messageType: 'job.status.forward', paths: ['jobId'] }),
    );
  });

  it('returns a valid status frame with its free text clamped', () => {
    const out = guardOutboundFrame(jobFrame({ errorMessage: 'e'.repeat(9_000) })) as {
      errorMessage: string;
    };
    // breaks-if-wrong: a long but valid frame is still sent, shortened
    expect(out.errorMessage).toHaveLength(STATUS_FREE_TEXT_MAX);
  });

  it('passes a log.chunk through untouched', () => {
    const chunk = {
      type: 'log.chunk',
      messageId: 'm-2',
      runId: 'run-1',
      jobId: 'job-1',
      stepIndex: 0,
      lines: ['l'.repeat(50_000)],
      timestamp: 1,
      stream: 'stdout',
    } as OrchestratorToPlatformMessage;
    // breaks-if-wrong: the high-volume log stream is never parsed or rebuilt
    expect(guardOutboundFrame(chunk)).toBe(chunk);
  });
});
