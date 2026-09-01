import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildCheckRunSummary,
  buildAnnotations,
  buildProgressText,
  clampSummaryToLimit,
  SUMMARY_BYTE_LIMIT,
  type StepResultData,
  type StepProgressEntry,
} from './check-run-summary.js';
import { StepLogBuffer } from './step-log-buffer.js';

const traceIds = { requestId: 'req-abc', runId: 'run-xyz' };

describe('buildCheckRunSummary', () => {
  let logBuffer: StepLogBuffer;
  const runId = 'run-1';
  const jobId = 'job-1';

  beforeEach(() => {
    logBuffer = new StepLogBuffer();
  });

  it('all steps pass: shows passed headline and step table with durations', () => {
    const stepResults: StepResultData[] = [
      { name: 'Install deps', status: 'success', durationMs: 1200 },
      { name: 'Build', status: 'success', durationMs: 3400 },
      { name: 'Test', status: 'success', durationMs: 5600 },
    ];

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
      jobDurationMs: 10200,
    });

    expect(summary).toContain("**Job 'ci/test' passed** (3/3 steps passed)");
    expect(summary).toContain('\u2714 success');
    expect(summary).toContain('1.2s');
    expect(summary).toContain('3.4s');
    expect(summary).toContain('5.6s');
    expect(summary).toContain('**Total duration:** 10.2s');
    expect(summary).toContain('Trace: req-abc | Run: run-xyz');
  });

  it('single step fails: shows failed headline with failure details and log lines', () => {
    const stepResults: StepResultData[] = [
      { name: 'Install deps', status: 'success', durationMs: 1200 },
      {
        name: 'Test',
        status: 'failed',
        durationMs: 5600,
        error: 'Test suite failed',
        exitCode: 1,
      },
    ];

    // Add log lines for the failed step (index 1)
    logBuffer.addLines({ runId, jobId, stepIndex: 1 }, [
      'Running test suite...',
      'FAIL src/app.test.ts',
      'Expected: true',
      'Received: false',
    ]);

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain("**Job 'ci/test' failed** (1/2 steps passed)");
    expect(summary).toContain('### \u2716 Test');
    expect(summary).toContain('**Error:** Test suite failed');
    expect(summary).toContain('Running test suite...');
    expect(summary).toContain('FAIL src/app.test.ts');
    expect(summary).toContain('Exit code: 1');
  });

  it('multiple steps fail: ALL failures shown with log context', () => {
    const stepResults: StepResultData[] = [
      { name: 'Install', status: 'success', durationMs: 1000 },
      { name: 'Lint', status: 'failed', durationMs: 2000, error: 'Lint errors', exitCode: 1 },
      { name: 'Test', status: 'failed', durationMs: 3000, error: 'Test failed', exitCode: 2 },
    ];

    logBuffer.addLines({ runId, jobId, stepIndex: 1 }, ['lint error 1', 'lint error 2']);
    logBuffer.addLines({ runId, jobId, stepIndex: 2 }, ['test error 1']);

    const summary = buildCheckRunSummary({
      jobName: 'ci/build',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain("**Job 'ci/build' failed** (1/3 steps passed)");
    expect(summary).toContain('### \u2716 Lint');
    expect(summary).toContain('### \u2716 Test');
    expect(summary).toContain('lint error 1');
    expect(summary).toContain('test error 1');
    expect(summary).toContain('Exit code: 1');
    expect(summary).toContain('Exit code: 2');
  });

  it('timeout failure: shows timeout message', () => {
    const stepResults: StepResultData[] = [
      {
        name: 'Long test',
        status: 'failed',
        durationMs: 30000,
        timedOut: true,
        error: 'Timed out',
        exitCode: 137,
      },
    ];

    logBuffer.addLines({ runId, jobId, stepIndex: 0 }, ['still running...']);

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain('**Step timed out after 30s**');
    expect(summary).toContain('still running...');
  });

  it('shows log truncation indicator when totalCount > 20', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test', status: 'failed', error: 'Failed', exitCode: 1 },
    ];

    // Add 30 lines (default maxLines = 20)
    const lines = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`);
    logBuffer.addLines({ runId, jobId, stepIndex: 0 }, lines);

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain('... (showing last 20 of 30 lines)');
    expect(summary).toContain('log line 11');
    expect(summary).toContain('log line 30');
    expect(summary).not.toContain('log line 1\n');
  });

  it('does not show log output for passing steps', () => {
    const stepResults: StepResultData[] = [{ name: 'Build', status: 'success', durationMs: 2000 }];

    logBuffer.addLines({ runId, jobId, stepIndex: 0 }, ['build output line 1']);

    const summary = buildCheckRunSummary({
      jobName: 'ci/build',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).not.toContain('build output line 1');
    expect(summary).not.toContain('```');
    expect(summary).not.toContain('###');
  });

  it('exit code always shown after log block for failed steps', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test', status: 'failed', exitCode: 42, error: 'Oops' },
    ];

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain('Exit code: 42');
  });

  it('summary byte length stays under 65535 with large log output', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test', status: 'failed', error: 'Lots of output', exitCode: 1 },
    ];

    // Add 20 very long lines (3000 chars each = 60KB just in logs)
    const longLines = Array.from({ length: 20 }, (_, i) => `line ${i}: ${'x'.repeat(3000)}`);
    logBuffer.addLines({ runId, jobId, stepIndex: 0 }, longLines);

    const summary = buildCheckRunSummary({
      jobName: 'ci/test',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    const byteLength = Buffer.byteLength(summary, 'utf-8');
    expect(byteLength).toBeLessThanOrEqual(65535);
  });

  it('trace IDs appear at bottom', () => {
    const stepResults: StepResultData[] = [{ name: 'Build', status: 'success', durationMs: 1000 }];

    const summary = buildCheckRunSummary({
      jobName: 'ci/build',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    const lines = summary.split('\n');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBe('Trace: req-abc | Run: run-xyz');
  });

  it('handles skipped steps', () => {
    const stepResults: StepResultData[] = [
      { name: 'Build', status: 'success', durationMs: 1000 },
      { name: 'Deploy', status: 'skipped' },
    ];

    const summary = buildCheckRunSummary({
      jobName: 'ci/deploy',
      stepResults,
      logBuffer,
      runId,
      jobId,
      traceIds,
    });

    expect(summary).toContain('\u23ED skipped');
    expect(summary).toContain('(1/2 steps passed)');
  });
});

describe('buildAnnotations', () => {
  it('failed step produces failure-level annotation with source location', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test', status: 'failed', error: 'Test failed', exitCode: 1 },
    ];
    const sourceLocations = new Map([[0, { file: '.kici/workflows/ci.ts', line: 42, column: 5 }]]);

    const { annotations, remainingCount } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].annotation_level).toBe('failure');
    expect(annotations[0].path).toBe('.kici/workflows/ci.ts');
    expect(annotations[0].start_line).toBe(42);
    expect(annotations[0].end_line).toBe(42);
    expect(annotations[0].title).toBe('Failed: Test');
    expect(annotations[0].message).toContain("Step 'Test'");
    expect(annotations[0].message).toContain('Test failed');
    expect(remainingCount).toBe(0);
  });

  it('continueOnError failed step produces warning-level annotation', () => {
    const stepResults: StepResultData[] = [
      {
        name: 'Optional lint',
        status: 'failed',
        error: 'Lint warnings',
        continueOnError: true,
      },
    ];
    const sourceLocations = new Map([[0, { file: '.kici/workflows/ci.ts', line: 10, column: 3 }]]);

    const { annotations } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].annotation_level).toBe('warning');
    expect(annotations[0].title).toBe('Warning: Optional lint');
  });

  it('passing steps do not produce annotations', () => {
    const stepResults: StepResultData[] = [
      { name: 'Build', status: 'success', durationMs: 1000 },
      { name: 'Test', status: 'success', durationMs: 2000 },
    ];
    const sourceLocations = new Map([
      [0, { file: '.kici/workflows/ci.ts', line: 5, column: 1 }],
      [1, { file: '.kici/workflows/ci.ts', line: 15, column: 1 }],
    ]);

    const { annotations } = buildAnnotations({ stepResults, sourceLocations });
    expect(annotations).toHaveLength(0);
  });

  it('annotations capped at 50, remaining count returned', () => {
    const stepResults: StepResultData[] = Array.from({ length: 55 }, (_, i) => ({
      name: `Step ${i}`,
      status: 'failed' as const,
      error: `Error ${i}`,
    }));
    const sourceLocations = new Map(
      Array.from(
        { length: 55 },
        (_, i) => [i, { file: '.kici/workflows/ci.ts', line: i + 1, column: 1 }] as const,
      ),
    );

    const { annotations, remainingCount } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations).toHaveLength(50);
    expect(remainingCount).toBe(5);
  });

  it('steps without sourceLocation are skipped', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test 1', status: 'failed', error: 'Error 1' },
      { name: 'Test 2', status: 'failed', error: 'Error 2' },
    ];
    // Only provide source location for step 1 (index 1)
    const sourceLocations = new Map([[1, { file: '.kici/workflows/ci.ts', line: 20, column: 1 }]]);

    const { annotations } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations).toHaveLength(1);
    expect(annotations[0].title).toBe('Failed: Test 2');
  });

  it('annotation message includes step name + error message', () => {
    const stepResults: StepResultData[] = [
      { name: 'My step', status: 'failed', error: 'Something broke' },
    ];
    const sourceLocations = new Map([[0, { file: '.kici/workflows/ci.ts', line: 1, column: 1 }]]);

    const { annotations } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations[0].message).toBe("Step 'My step': Something broke");
  });

  it('raw_details includes exit code and timeout info', () => {
    const stepResults: StepResultData[] = [
      { name: 'Test', status: 'failed', error: 'Timed out', exitCode: 137, timedOut: true },
    ];
    const sourceLocations = new Map([[0, { file: '.kici/workflows/ci.ts', line: 1, column: 1 }]]);

    const { annotations } = buildAnnotations({ stepResults, sourceLocations });

    expect(annotations[0].raw_details).toContain('Timed out');
    expect(annotations[0].raw_details).toContain('Exit code: 137');
    expect(annotations[0].raw_details).toContain('Step timed out');
  });
});

describe('buildProgressText', () => {
  it('running step shows hourglass prefix with trailing dots', () => {
    const steps: StepProgressEntry[] = [{ name: 'Run tests', status: 'running' }];

    const text = buildProgressText({ steps, traceIds });

    expect(text).toContain('\u231B Run tests...');
  });

  it('completed step shows check mark with duration', () => {
    const steps: StepProgressEntry[] = [
      { name: 'Install deps', status: 'success', durationMs: 1200 },
    ];

    const text = buildProgressText({ steps, traceIds });

    expect(text).toContain('\u2714 Install deps (1.2s)');
  });

  it('failed step shows X mark with duration', () => {
    const steps: StepProgressEntry[] = [{ name: 'Test', status: 'failed', durationMs: 5600 }];

    const text = buildProgressText({ steps, traceIds });

    expect(text).toContain('\u2716 Test (5.6s)');
  });

  it('pending step shows circle', () => {
    const steps: StepProgressEntry[] = [{ name: 'Deploy', status: 'pending' }];

    const text = buildProgressText({ steps, traceIds });

    expect(text).toContain('\u25CB Deploy');
  });

  it('mix of states renders correctly', () => {
    const steps: StepProgressEntry[] = [
      { name: 'Install', status: 'success', durationMs: 1200 },
      { name: 'Build', status: 'success', durationMs: 3400 },
      { name: 'Test', status: 'running' },
      { name: 'Deploy', status: 'pending' },
    ];

    const text = buildProgressText({ steps, traceIds });

    const lines = text.split('\n');
    expect(lines[0]).toBe('\u2714 Install (1.2s)');
    expect(lines[1]).toBe('\u2714 Build (3.4s)');
    expect(lines[2]).toBe('\u231B Test...');
    expect(lines[3]).toBe('\u25CB Deploy');
    expect(text).toContain('Trace: req-abc | Run: run-xyz');
  });

  it('skipped step shows skip emoji', () => {
    const steps: StepProgressEntry[] = [{ name: 'Deploy', status: 'skipped' }];

    const text = buildProgressText({ steps, traceIds });

    expect(text).toContain('\u23ED Deploy');
  });
});

describe('the summary byte budget', () => {
  /**
   * Step results whose rendered summary lands just under the cap — 64751 bytes,
   * 784 of headroom. That is the only band where a caller's own bytes decide
   * whether the update is accepted, so it is the band the reservation governs.
   * The fixture carries no log lines, so every truncation tier renders the same
   * string: a reservation the builder honours can only be met by falling
   * through to the minimal summary, which is exactly what the assertions read.
   */
  function nearCapSteps(): StepResultData[] {
    return Array.from({ length: 32 }, (_, i) => ({
      name: `step-${i}`,
      status: 'failed' as const,
      error: 'e'.repeat(1960),
    }));
  }

  const base = {
    jobName: 'test',
    logBuffer: new StepLogBuffer(),
    runId: 'run-1',
    jobId: 'job-1',
    traceIds,
  };

  it('spends the whole cap when nothing is reserved', () => {
    const summary = buildCheckRunSummary({ ...base, stepResults: nearCapSteps() });
    const size = Buffer.byteLength(summary, 'utf-8');
    // Non-vacuity for the reservation case below: without a reservation the
    // builder really does return something inside the last kilobyte of the
    // cap, which is the only band where reserving changes the answer.
    expect(size).toBeLessThanOrEqual(SUMMARY_BYTE_LIMIT);
    expect(size).toBeGreaterThan(SUMMARY_BYTE_LIMIT - 1024);
  });

  it('leaves room for a caller that will wrap the result', () => {
    const reservedBytes = 1024;
    const summary = buildCheckRunSummary({
      ...base,
      stepResults: nearCapSteps(),
      reservedBytes,
    });
    expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(
      SUMMARY_BYTE_LIMIT - reservedBytes,
    );
  });
});

describe('clampSummaryToLimit', () => {
  it('returns a summary that already fits, unchanged', () => {
    expect(clampSummaryToLimit('short')).toBe('short');
  });

  it('cuts an over-cap summary down to the cap and says so', () => {
    const clamped = clampSummaryToLimit('x'.repeat(SUMMARY_BYTE_LIMIT + 500));
    expect(Buffer.byteLength(clamped, 'utf-8')).toBeLessThanOrEqual(SUMMARY_BYTE_LIMIT);
    expect(clamped).toContain('Summary truncated due to size limits.');
  });

  it('does not leave a replacement character from a split multi-byte sequence', () => {
    // A cut through a 4-byte emoji yields U+FFFD, which is both wrong to show
    // and larger than the bytes it replaced — so it can put the result back
    // over the very cap it was cut to fit.
    // The truncation notice is 41 bytes, so a limit of 43 leaves two bytes of
    // head — landing inside a 4-byte emoji. Node renders each orphaned byte as
    // its own 3-byte U+FFFD, so an untrimmed head would be 6 bytes and the
    // result 47: over the 43 it was cut to fit.
    const clamped = clampSummaryToLimit('🙂'.repeat(40), 43);
    expect(Buffer.byteLength(clamped, 'utf-8')).toBeLessThanOrEqual(43);
    expect(clamped).not.toContain('\uFFFD');

    // A limit too small even for the notice still respects the limit.
    expect(Buffer.byteLength(clampSummaryToLimit('🙂'.repeat(40), 6), 'utf-8')).toBeLessThanOrEqual(
      6,
    );
  });
});
