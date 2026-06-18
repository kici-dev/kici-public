import { describe, expect, it } from 'vitest';
import {
  browserAuthRequestSchema,
  browserAuthRefreshSchema,
  browserLogSubscribeSchema,
  browserLogUnsubscribeSchema,
  browserStatusSubscribeSchema,
  browserStatusUnsubscribeSchema,
  browserAuthSuccessSchema,
  browserAuthFailureSchema,
  browserLogLinesSchema,
  browserGapSchema,
  browserLogStreamTerminatedSchema,
  browserRunStatusSchema,
  browserJobStatusSchema,
  browserStepStatusSchema,
  browserRunNewSchema,
  browserJobNewSchema,
  browserErrorSchema,
  browserPingSchema,
  browserPongSchema,
  browserToPlatformMessageSchema,
  platformToBrowserMessageSchema,
} from './browser.js';

// --- Browser -> Platform schemas ---

describe('browserAuthRequestSchema', () => {
  const valid = { type: 'auth.request', token: 'eyJhbGciOiJSUzI1NiJ9.test' };

  it('validates a well-formed auth request', () => {
    expect(browserAuthRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects empty token', () => {
    expect(() => browserAuthRequestSchema.parse({ type: 'auth.request', token: '' })).toThrow();
  });

  it('rejects missing token', () => {
    expect(() => browserAuthRequestSchema.parse({ type: 'auth.request' })).toThrow();
  });
});

describe('browserAuthRefreshSchema', () => {
  const valid = { type: 'auth.refresh', token: 'new-jwt-token' };

  it('validates a well-formed auth refresh', () => {
    expect(browserAuthRefreshSchema.parse(valid)).toEqual(valid);
  });

  it('rejects empty token', () => {
    expect(() => browserAuthRefreshSchema.parse({ type: 'auth.refresh', token: '' })).toThrow();
  });
});

describe('browserLogSubscribeSchema', () => {
  const valid = { type: 'log.subscribe', runId: 'run-1', jobId: 'job-1', stepIndex: 0 };

  it('validates a well-formed subscribe message', () => {
    expect(browserLogSubscribeSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional afterLineCount', () => {
    const msg = { ...valid, afterLineCount: 42 };
    expect(browserLogSubscribeSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing runId', () => {
    const { runId, ...rest } = valid;
    expect(() => browserLogSubscribeSchema.parse(rest)).toThrow();
  });

  it('rejects missing jobId', () => {
    const { jobId, ...rest } = valid;
    expect(() => browserLogSubscribeSchema.parse(rest)).toThrow();
  });

  it('rejects missing stepIndex', () => {
    const { stepIndex, ...rest } = valid;
    expect(() => browserLogSubscribeSchema.parse(rest)).toThrow();
  });
});

describe('browserLogUnsubscribeSchema', () => {
  const valid = { type: 'log.unsubscribe', runId: 'run-1', jobId: 'job-1', stepIndex: 0 };

  it('validates a well-formed unsubscribe message', () => {
    expect(browserLogUnsubscribeSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing runId', () => {
    const { runId, ...rest } = valid;
    expect(() => browserLogUnsubscribeSchema.parse(rest)).toThrow();
  });
});

describe('browserStatusSubscribeSchema', () => {
  const valid = { type: 'status.subscribe', scope: 'org', orgId: 'org-1' };

  it('validates a well-formed status subscribe', () => {
    expect(browserStatusSubscribeSchema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid scope', () => {
    expect(() =>
      browserStatusSubscribeSchema.parse({
        type: 'status.subscribe',
        scope: 'invalid',
        orgId: 'org-1',
      }),
    ).toThrow();
  });

  it('rejects missing orgId', () => {
    expect(() =>
      browserStatusSubscribeSchema.parse({ type: 'status.subscribe', scope: 'org' }),
    ).toThrow();
  });

  it('rejects empty orgId', () => {
    expect(() =>
      browserStatusSubscribeSchema.parse({
        type: 'status.subscribe',
        scope: 'org',
        orgId: '',
      }),
    ).toThrow();
  });
});

describe('browserStatusUnsubscribeSchema', () => {
  const valid = { type: 'status.unsubscribe' };

  it('validates a well-formed status unsubscribe', () => {
    expect(browserStatusUnsubscribeSchema.parse(valid)).toEqual(valid);
  });
});

// --- Platform -> Browser schemas ---

describe('browserAuthSuccessSchema', () => {
  const valid = { type: 'auth.success', connectionId: 'conn-abc-123' };

  it('validates a well-formed auth success', () => {
    expect(browserAuthSuccessSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing connectionId', () => {
    expect(() => browserAuthSuccessSchema.parse({ type: 'auth.success' })).toThrow();
  });
});

describe('browserAuthFailureSchema', () => {
  const valid = { type: 'auth.failure', reason: 'Invalid token' };

  it('validates a well-formed auth failure', () => {
    expect(browserAuthFailureSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing reason', () => {
    expect(() => browserAuthFailureSchema.parse({ type: 'auth.failure' })).toThrow();
  });
});

describe('browserLogLinesSchema', () => {
  const valid = {
    type: 'log.lines',
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    lines: ['Installing...', 'Done'],
    lineCount: 42,
  };

  it('validates a well-formed log lines message', () => {
    expect(browserLogLinesSchema.parse(valid)).toEqual(valid);
  });

  it('accepts empty lines array', () => {
    const msg = { ...valid, lines: [], lineCount: 0 };
    expect(browserLogLinesSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing lineCount', () => {
    const { lineCount, ...rest } = valid;
    expect(() => browserLogLinesSchema.parse(rest)).toThrow();
  });

  it('preserves ANSI escape codes', () => {
    const msg = { ...valid, lines: ['\x1b[32mSuccess\x1b[0m'] };
    const parsed = browserLogLinesSchema.parse(msg);
    expect(parsed.lines[0]).toContain('\x1b[32m');
  });
});

describe('browserLogStreamTerminatedSchema', () => {
  const valid = {
    type: 'log.stream.terminated',
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    reason: 'plan_limit_live_log_minutes',
  };

  it('validates a well-formed terminated message', () => {
    expect(browserLogStreamTerminatedSchema.parse(valid)).toEqual(valid);
  });

  it('accepts an optional human-readable message', () => {
    const msg = { ...valid, message: 'Daily live-log minute cap reached' };
    expect(browserLogStreamTerminatedSchema.parse(msg)).toEqual(msg);
  });

  it('rejects an unknown reason', () => {
    expect(() =>
      browserLogStreamTerminatedSchema.parse({ ...valid, reason: 'something_else' }),
    ).toThrow();
  });

  it('rejects missing reason', () => {
    const { reason, ...rest } = valid;
    expect(() => browserLogStreamTerminatedSchema.parse(rest)).toThrow();
  });
});

describe('browserGapSchema', () => {
  const valid = {
    type: 'log.gap',
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    droppedLineCount: 150,
  };

  it('validates a well-formed gap message', () => {
    expect(browserGapSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing droppedLineCount', () => {
    const { droppedLineCount, ...rest } = valid;
    expect(() => browserGapSchema.parse(rest)).toThrow();
  });
});

describe('browserRunStatusSchema', () => {
  const valid = { type: 'run.status', runId: 'run-1', status: 'success' };

  it('validates a well-formed run status', () => {
    expect(browserRunStatusSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional completedAt and durationMs', () => {
    const msg = { ...valid, completedAt: 1000, durationMs: 5000 };
    expect(browserRunStatusSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing status', () => {
    expect(() => browserRunStatusSchema.parse({ type: 'run.status', runId: 'run-1' })).toThrow();
  });
});

describe('browserJobStatusSchema', () => {
  const valid = {
    type: 'job.status',
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'test',
    status: 'running',
  };

  it('validates a well-formed job status', () => {
    expect(browserJobStatusSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional timing fields', () => {
    const msg = { ...valid, startedAt: 100, completedAt: 200, durationMs: 100 };
    expect(browserJobStatusSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing jobName', () => {
    const { jobName, ...rest } = valid;
    expect(() => browserJobStatusSchema.parse(rest)).toThrow();
  });
});

describe('browserStepStatusSchema', () => {
  const valid = {
    type: 'step.status',
    runId: 'run-1',
    jobId: 'job-1',
    stepIndex: 0,
    stepName: 'Install',
    state: 'running',
    timestamp: 1234567890,
  };

  it('validates a well-formed step status', () => {
    expect(browserStepStatusSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing stepName', () => {
    const { stepName, ...rest } = valid;
    expect(() => browserStepStatusSchema.parse(rest)).toThrow();
  });

  it('rejects missing timestamp', () => {
    const { timestamp, ...rest } = valid;
    expect(() => browserStepStatusSchema.parse(rest)).toThrow();
  });
});

describe('browserErrorSchema', () => {
  const valid = { type: 'error', code: 'INVALID_SUBSCRIPTION', message: 'Bad request' };

  it('validates a well-formed error message', () => {
    expect(browserErrorSchema.parse(valid)).toEqual(valid);
  });

  it('rejects missing code', () => {
    expect(() => browserErrorSchema.parse({ type: 'error', message: 'test' })).toThrow();
  });

  it('rejects missing message', () => {
    expect(() => browserErrorSchema.parse({ type: 'error', code: 'ERR' })).toThrow();
  });
});

describe('browserPingSchema', () => {
  it('validates a well-formed ping', () => {
    expect(browserPingSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('rejects extra fields via strip', () => {
    const result = browserPingSchema.parse({ type: 'ping', extra: true });
    expect(result).toEqual({ type: 'ping' });
  });
});

describe('browserPongSchema', () => {
  it('validates a well-formed pong', () => {
    expect(browserPongSchema.parse({ type: 'pong' })).toEqual({ type: 'pong' });
  });
});

// --- Discriminated unions ---

describe('browserToPlatformMessageSchema', () => {
  it('accepts auth.request', () => {
    const msg = { type: 'auth.request', token: 'jwt-token' };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts auth.refresh', () => {
    const msg = { type: 'auth.refresh', token: 'new-jwt-token' };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.subscribe', () => {
    const msg = { type: 'log.subscribe', runId: 'r1', jobId: 'j1', stepIndex: 0 };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.unsubscribe', () => {
    const msg = { type: 'log.unsubscribe', runId: 'r1', jobId: 'j1', stepIndex: 0 };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts status.subscribe', () => {
    const msg = { type: 'status.subscribe', scope: 'org', orgId: 'org-1' };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts status.unsubscribe', () => {
    const msg = { type: 'status.unsubscribe' };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts ping', () => {
    const msg = { type: 'ping' };
    expect(browserToPlatformMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects Platform-to-browser message types', () => {
    const msg = {
      type: 'log.lines',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      lines: [],
      lineCount: 0,
    };
    expect(() => browserToPlatformMessageSchema.parse(msg)).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => browserToPlatformMessageSchema.parse({ type: 'unknown' })).toThrow();
  });
});

describe('platformToBrowserMessageSchema', () => {
  it('accepts auth.success', () => {
    const msg = { type: 'auth.success', connectionId: 'c1' };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts auth.failure', () => {
    const msg = { type: 'auth.failure', reason: 'expired' };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.lines', () => {
    const msg = {
      type: 'log.lines',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      lines: ['hello'],
      lineCount: 1,
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.gap', () => {
    const msg = {
      type: 'log.gap',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      droppedLineCount: 50,
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts log.stream.terminated', () => {
    const msg = {
      type: 'log.stream.terminated',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      reason: 'plan_limit_live_log_minutes',
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts run.status', () => {
    const msg = { type: 'run.status', runId: 'r1', status: 'success' };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.status', () => {
    const msg = {
      type: 'job.status',
      runId: 'r1',
      jobId: 'j1',
      jobName: 'test',
      status: 'running',
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts step.status', () => {
    const msg = {
      type: 'step.status',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      stepName: 'Install',
      state: 'running',
      timestamp: 1234,
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts error', () => {
    const msg = { type: 'error', code: 'ERR', message: 'something broke' };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts pong', () => {
    const msg = { type: 'pong' };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects browser-to-platform message types', () => {
    const msg = { type: 'log.subscribe', runId: 'r1', jobId: 'j1', stepIndex: 0 };
    expect(() => platformToBrowserMessageSchema.parse(msg)).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => platformToBrowserMessageSchema.parse({ type: 'unknown' })).toThrow();
  });
});

// --- New schemas: run.new and job.new ---

describe('browserRunNewSchema', () => {
  const valid = {
    type: 'run.new',
    runId: 'run-1',
    status: 'running',
    workflowName: 'ci',
    repoIdentifier: 'owner/repo',
    sha: 'abc123',
    ref: 'main',
    triggerEvent: 'push',
    commitMessage: 'fix: stuff',
    jobCount: 3,
    startedAt: 1234567890,
    orgId: 'org-1',
  };

  it('validates a well-formed run.new message', () => {
    expect(browserRunNewSchema.parse(valid)).toEqual(valid);
  });

  it('accepts minimal run.new (optional fields omitted)', () => {
    const minimal = {
      type: 'run.new',
      runId: 'run-1',
      status: 'running',
      workflowName: 'ci',
      jobCount: 3,
      startedAt: 1234567890,
      orgId: 'org-1',
    };
    expect(browserRunNewSchema.parse(minimal)).toEqual(minimal);
  });

  it('rejects missing runId', () => {
    const { runId, ...rest } = valid;
    expect(() => browserRunNewSchema.parse(rest)).toThrow();
  });

  it('rejects missing orgId', () => {
    const { orgId, ...rest } = valid;
    expect(() => browserRunNewSchema.parse(rest)).toThrow();
  });

  it('rejects missing jobCount', () => {
    const { jobCount, ...rest } = valid;
    expect(() => browserRunNewSchema.parse(rest)).toThrow();
  });
});

describe('browserJobNewSchema', () => {
  const valid = {
    type: 'job.new',
    runId: 'run-1',
    jobId: 'job-1',
    jobName: 'build',
    status: 'queued',
    matrixValues: { os: 'linux' },
    startedAt: 1234567890,
  };

  it('validates a well-formed job.new message', () => {
    expect(browserJobNewSchema.parse(valid)).toEqual(valid);
  });

  it('accepts minimal job.new (optional fields omitted)', () => {
    const minimal = {
      type: 'job.new',
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status: 'queued',
    };
    expect(browserJobNewSchema.parse(minimal)).toEqual(minimal);
  });

  it('accepts null matrixValues', () => {
    const msg = { ...valid, matrixValues: null };
    expect(browserJobNewSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing jobId', () => {
    const { jobId, ...rest } = valid;
    expect(() => browserJobNewSchema.parse(rest)).toThrow();
  });

  it('rejects missing jobName', () => {
    const { jobName, ...rest } = valid;
    expect(() => browserJobNewSchema.parse(rest)).toThrow();
  });
});

// --- Enhanced step.status with timing fields ---

describe('browserStepStatusSchema (enhanced)', () => {
  it('accepts optional startedAt, completedAt, durationMs', () => {
    const msg = {
      type: 'step.status',
      runId: 'run-1',
      jobId: 'job-1',
      stepIndex: 0,
      stepName: 'Install',
      state: 'success',
      timestamp: 1234567890,
      startedAt: 1234567800,
      completedAt: 1234567890,
      durationMs: 90000,
    };
    expect(browserStepStatusSchema.parse(msg)).toEqual(msg);
  });

  it('still works without timing fields', () => {
    const msg = {
      type: 'step.status',
      runId: 'run-1',
      jobId: 'job-1',
      stepIndex: 0,
      stepName: 'Install',
      state: 'running',
      timestamp: 1234567890,
    };
    expect(browserStepStatusSchema.parse(msg)).toEqual(msg);
  });
});

// --- platformToBrowserMessageSchema includes new types ---

describe('platformToBrowserMessageSchema (new types)', () => {
  it('accepts run.new', () => {
    const msg = {
      type: 'run.new',
      runId: 'run-1',
      status: 'running',
      workflowName: 'ci',
      jobCount: 1,
      startedAt: 1234,
      orgId: 'org-1',
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });

  it('accepts job.new', () => {
    const msg = {
      type: 'job.new',
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status: 'queued',
    };
    expect(platformToBrowserMessageSchema.parse(msg)).toEqual(msg);
  });
});

// --- JSON serialization round-trips ---

describe('JSON round-trip', () => {
  it('browserLogSubscribeSchema survives JSON.parse(JSON.stringify())', () => {
    const msg = {
      type: 'log.subscribe',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      afterLineCount: 10,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(browserLogSubscribeSchema.parse(roundTripped)).toEqual(msg);
  });

  it('browserLogLinesSchema survives JSON.parse(JSON.stringify())', () => {
    const msg = {
      type: 'log.lines',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      lines: ['test'],
      lineCount: 1,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(browserLogLinesSchema.parse(roundTripped)).toEqual(msg);
  });

  it('browserStepStatusSchema survives JSON.parse(JSON.stringify())', () => {
    const msg = {
      type: 'step.status',
      runId: 'r1',
      jobId: 'j1',
      stepIndex: 0,
      stepName: 'Install',
      state: 'running',
      timestamp: 1234,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(browserStepStatusSchema.parse(roundTripped)).toEqual(msg);
  });
});
