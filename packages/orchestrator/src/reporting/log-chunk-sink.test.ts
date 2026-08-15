import { describe, it, expect, vi } from 'vitest';
import { LogStream } from '@kici-dev/engine';
import { createLogChunkSink, type NormalizedLogChunk } from './log-chunk-sink.js';
import type { LogWriter } from './log-writer.js';
import type { StepLogBuffer } from './step-log-buffer.js';

function makeDeps() {
  return {
    stepLogBuffer: { addLines: vi.fn() },
    logWriter: { appendChunk: vi.fn().mockResolvedValue(undefined) },
    executionTracker: {
      resolveJobName: vi.fn<(runId: string, jobId: string) => Promise<string>>(),
    },
    forwardToPlatform: vi.fn(),
  };
}

/** Narrow the vi.fn() doubles above onto the sink's dep types. */
function sinkDeps(deps: ReturnType<typeof makeDeps>, source: 'local' | 'peer') {
  return {
    source,
    stepLogBuffer: deps.stepLogBuffer as unknown as StepLogBuffer,
    logWriter: deps.logWriter as unknown as LogWriter,
    executionTracker: deps.executionTracker,
    forwardToPlatform: deps.forwardToPlatform,
  };
}

const chunk: NormalizedLogChunk = {
  runId: 'run-1',
  jobId: 'job-1',
  stepIndex: 2,
  lines: ['hello', 'world'],
  timestamp: 1_700_000_000_000,
  stream: LogStream.enum.stderr,
};

describe('createLogChunkSink', () => {
  it('buffers, persists with the resolved job name, and forwards', async () => {
    const deps = makeDeps();
    deps.executionTracker.resolveJobName.mockResolvedValue('build');
    await createLogChunkSink(sinkDeps(deps, 'peer'))(chunk);

    expect(deps.stepLogBuffer.addLines).toHaveBeenCalledWith(
      { runId: 'run-1', jobId: 'job-1', stepIndex: 2 },
      ['hello', 'world'],
    );
    expect(deps.logWriter.appendChunk).toHaveBeenCalledWith(
      'run-1',
      'build',
      2,
      ['hello', 'world'],
      1_700_000_000_000,
      'job-1',
      undefined,
      LogStream.enum.stderr,
    );
    expect(deps.forwardToPlatform).toHaveBeenCalledWith(chunk);
  });

  it('falls back to the job id when the job name is unknown', async () => {
    const deps = makeDeps();
    // The resolver itself performs the durable fallback, returning the job id
    // when neither in-memory state nor dispatch_queue names the job.
    deps.executionTracker.resolveJobName.mockResolvedValue('job-1');
    await createLogChunkSink(sinkDeps(deps, 'local'))(chunk);

    expect(deps.logWriter.appendChunk).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      2,
      ['hello', 'world'],
      1_700_000_000_000,
      'job-1',
      undefined,
      LogStream.enum.stderr,
    );
  });

  it('works with every optional dep absent', () => {
    expect(() => createLogChunkSink({ source: 'peer' })(chunk)).not.toThrow();
  });

  it('does nothing for an empty line array', () => {
    const deps = makeDeps();
    createLogChunkSink(sinkDeps(deps, 'peer'))({ ...chunk, lines: [] });

    expect(deps.stepLogBuffer.addLines).not.toHaveBeenCalled();
    expect(deps.logWriter.appendChunk).not.toHaveBeenCalled();
    expect(deps.forwardToPlatform).not.toHaveBeenCalled();
  });

  it('persists without a tracker, using the job id', () => {
    const deps = makeDeps();
    const sink = createLogChunkSink({
      source: 'peer',
      logWriter: deps.logWriter as unknown as LogWriter,
    });
    sink(chunk);

    expect(deps.logWriter.appendChunk).toHaveBeenCalledWith(
      'run-1',
      'job-1',
      2,
      ['hello', 'world'],
      1_700_000_000_000,
      'job-1',
      undefined,
      LogStream.enum.stderr,
    );
  });
});
