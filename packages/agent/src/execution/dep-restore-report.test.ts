import { describe, expect, it, vi } from 'vitest';
import {
  DepRestoreOutcome,
  createDepRestoreReportRelay,
  formatAttemptFailure,
  formatRestoredLine,
  runSetupThenSendDepRestoreReport,
  type DepRestoreReport,
} from './dep-restore-report.js';

const MB = 1024 * 1024;
/** Whole bytes: the report schema only takes integers. */
const mb = (n: number): number => Math.round(n * MB);

const REPORT: DepRestoreReport = {
  outcome: DepRestoreOutcome.enum.restored,
  source: 'https://bucket.s3.amazonaws.com/deps/linux-x64/abc.tar.gz',
  verified: true,
  tarballBytes: mb(53.56),
  attempts: [
    {
      attempt: 1,
      resumeFrom: 0,
      status: 200,
      bytesReceived: mb(53.49),
      bytesOnDisk: mb(53.49),
      expectedBytes: mb(53.56),
      durationMs: 4100,
      error: {
        message: 'terminated',
        causeCode: 'UND_ERR_SOCKET',
        causeMessage: 'other side closed',
      },
    },
    {
      attempt: 2,
      resumeFrom: mb(53.49),
      status: 206,
      bytesReceived: mb(53.56) - mb(53.49),
      bytesOnDisk: mb(53.56),
      expectedBytes: mb(53.56),
      durationMs: 90,
    },
  ],
  downloadMs: 1500,
  verifyMs: 100,
  extractMs: 41_200,
};

describe('formatAttemptFailure', () => {
  it('names the cause, the bytes on disk against the total, the attempt and what happens next', () => {
    expect(
      formatAttemptFailure(REPORT.attempts[0], 3, { resumeFrom: 56087920, delayMs: 500 }),
    ).toBe(
      'Dep tarball download attempt 1/3 failed after 4.1 s: terminated ' +
        '(UND_ERR_SOCKET: other side closed); 53.49 of 53.56 MB on disk; ' +
        'resuming from byte 56087920 in 0.5 s',
    );
  });

  it('says when it gives up', () => {
    expect(formatAttemptFailure(REPORT.attempts[0], 3, undefined)).toMatch(/; giving up$/);
  });
});

describe('formatRestoredLine', () => {
  it('reports size, time, attempts, resume, verification and extraction', () => {
    expect(formatRestoredLine(REPORT)).toBe(
      'Deps restored from cache: 53.56 MB downloaded in 1.5 s (2 attempts, resumed), ' +
        'verified in 0.1 s, extracted in 41.2 s',
    );
  });
});

describe('createDepRestoreReportRelay', () => {
  it('logs the setup report once', () => {
    const sink = vi.fn();
    const relay = createDepRestoreReportRelay('job-1', sink);
    relay.relay(REPORT);
    relay.relay(REPORT);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(REPORT, { jobId: 'job-1', via: 'runner' });
  });

  it('refuses a report sent after the first step started', () => {
    // fails-when: step code's process.send reaches the agent log through the relay
    // breaks-if-wrong: the setup-time report above is still logged
    const sink = vi.fn();
    const relay = createDepRestoreReportRelay('job-1', sink);
    relay.onStepStarted();
    relay.relay(REPORT);
    expect(sink).not.toHaveBeenCalled();
  });

  it('closes on a setup message that carried no report', () => {
    // A job with no restore still ends its setup with the message; a report that
    // workflow code sends afterwards (module load, evaluations) must not be logged.
    // fails-when: the relay stays open until the first step.start when no restore ran
    // breaks-if-wrong: a setup message carrying a report is logged (first test)
    const sink = vi.fn();
    const relay = createDepRestoreReportRelay('job-1', sink);
    relay.relay(undefined);
    relay.relay(REPORT);
    expect(sink).not.toHaveBeenCalled();
  });

  it('refuses a malformed report', () => {
    const sink = vi.fn();
    const relay = createDepRestoreReportRelay('job-1', sink);
    relay.relay({ ...REPORT, outcome: 'owned', source: 'x'.repeat(5000) });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('runSetupThenSendDepRestoreReport', () => {
  it('sends the report setup produced, once', async () => {
    const send = vi.fn();
    await runSetupThenSendDepRestoreReport(async (onReport) => onReport(REPORT), send);
    expect(send.mock.calls).toEqual([[REPORT]]);
  });

  it('sends the closing message without a report when setup throws', async () => {
    // fails-when: a setup failure skips the message and leaves the relay open
    const send = vi.fn();
    await expect(
      runSetupThenSendDepRestoreReport(async () => {
        throw new Error('clone failed');
      }, send),
    ).rejects.toThrow('clone failed');
    expect(send.mock.calls).toEqual([[undefined]]);
  });
});
