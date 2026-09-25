import { describe, it, expect, vi } from 'vitest';
import { LogStream } from '@kici-dev/engine';
import { createLogChunkSink, type NormalizedLogChunk } from './log-chunk-sink.js';
import { LogWriter } from './log-writer.js';
import type { LogStorage } from './log-storage.js';
import type { StepLogBuffer } from './step-log-buffer.js';

function makeDeps() {
  return {
    stepLogBuffer: { addLines: vi.fn() },
    logWriter: { appendChunk: vi.fn().mockResolvedValue(undefined), trackPending: vi.fn() },
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

  it("makes the run's drain wait for a chunk whose job name is still resolving", async () => {
    const appended: string[] = [];
    const finalized: string[] = [];
    const storage = {
      appendStreaming: vi.fn(async (path: string) => {
        appended.push(path);
      }),
      finalize: vi.fn(async (path: string) => {
        finalized.push(path);
      }),
    } as unknown as LogStorage;
    const logWriter = new LogWriter({ logStorage: storage });
    let resolveName!: (name: string) => void;
    const sink = createLogChunkSink({
      source: 'local',
      logWriter,
      executionTracker: {
        resolveJobName: () => new Promise<string>((r) => (resolveName = r)),
      },
    });

    // The job's last setup lines arrive, and its terminal status completes the
    // run while the chunk's job name is still being looked up.
    const written = sink({ ...chunk, stepIndex: -1 });
    const drained = logWriter.drain('run-1');
    resolveName('build');
    await Promise.all([written, drained]);

    // fails-when: the drain snapshots before the chunk is registered, seals
    // nothing, and the chunk's segment is never sealed
    const path = 'executions/run-1/job-build/step--1.log';
    expect(appended).toEqual([path]);
    expect(finalized).toEqual([path]);
  });
});
