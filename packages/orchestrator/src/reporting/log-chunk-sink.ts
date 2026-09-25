/**
 * The single place that decides what happens to a step-log chunk.
 *
 * Both ingresses feed this sink: the local agent WebSocket handler and the
 * coordinator's peer handler, which receives chunks relayed by a worker
 * orchestrator. Keeping the policy in one place is what makes the two paths
 * behave identically — a worker-dispatched job's logs are persisted, counted
 * and forwarded exactly like a locally-dispatched one's.
 *
 * The storage key is derived from `executionTracker.resolveJobName`, the same
 * call `ExecutionTracker.onStepStatus` uses to fill `execution_steps.log_path`,
 * so the reader and the writer cannot disagree about the naming rule — the
 * resolver falls back to `dispatch_queue.job_name` during the dispatch window
 * before in-memory job state is populated, which is what stops an early chunk
 * from being persisted under an unreadable `job-{jobId}` path.
 */
import type { LogStream } from '@kici-dev/engine';
import type { LogWriter } from './log-writer.js';
import type { StepLogBuffer } from './step-log-buffer.js';
import { logChunksReceivedTotal, logBytesStoredTotal } from '../metrics/prometheus.js';

/** A chunk whose lines all share one timestamp and one originating stream. */
export interface NormalizedLogChunk {
  runId: string;
  jobId: string;
  stepIndex: number;
  lines: string[];
  timestamp: number;
  stream?: LogStream;
}

/** Which ingress produced the chunk. Stamped onto the two log counters. */
export type LogChunkSource = 'local' | 'peer';

export interface LogChunkSinkDeps {
  /** Ingress this sink instance serves; becomes the `source` metric attribute. */
  source: LogChunkSource;
  /** Short in-memory tail feeding the GitHub check-run summary. */
  stepLogBuffer?: StepLogBuffer;
  /** Durable step-log persistence. Absent when the orchestrator has no database. */
  logWriter?: LogWriter;
  /** Resolves the job name that names the storage path (durable fallback). */
  executionTracker?: { resolveJobName(runId: string, jobId: string): Promise<string> };
  /**
   * Forward to the Platform for browser fan-out. Absent in independent mode.
   * The caller wraps the chunk in the `log.chunk` envelope, which keeps this
   * module free of Platform-protocol knowledge.
   */
  forwardToPlatform?: (chunk: NormalizedLogChunk) => void;
}

export function createLogChunkSink(
  deps: LogChunkSinkDeps,
): (chunk: NormalizedLogChunk) => Promise<void> {
  const attrs = { source: deps.source };

  // Async so the storage path can resolve the job name through the durable
  // resolver. The returned promise is the chunk's write: the agent handler
  // awaits it, and a caller that does not may ignore it. The synchronous side
  // effects — metrics, the in-memory tail buffer, Platform fan-out — all run
  // before the first `await`, so making the sink async does not delay them.
  return async (chunk) => {
    if (chunk.lines.length === 0) return;

    logChunksReceivedTotal.add(1, attrs);

    deps.stepLogBuffer?.addLines(
      { runId: chunk.runId, jobId: chunk.jobId, stepIndex: chunk.stepIndex },
      chunk.lines,
    );

    deps.forwardToPlatform?.(chunk);

    if (deps.logWriter) {
      const logWriter = deps.logWriter;
      const write = (async () => {
        const jobName = deps.executionTracker
          ? await deps.executionTracker.resolveJobName(chunk.runId, chunk.jobId)
          : chunk.jobId;
        await logWriter.appendChunk(
          chunk.runId,
          jobName,
          chunk.stepIndex,
          chunk.lines,
          chunk.timestamp,
          chunk.jobId,
          undefined,
          chunk.stream,
        );
      })();
      // Registered before the job name is resolved, not once the append
      // starts: the run can complete while the name is being looked up, and
      // its drain has to wait for this chunk and seal it.
      // fails-when: a drain that starts during the name lookup seals the run
      // without this chunk, and the chunk's segment is never sealed
      logWriter.trackPending(chunk.runId, write);

      // Approximate: sum of line lengths plus one newline each.
      const byteCount = chunk.lines.reduce((sum, line) => sum + line.length + 1, 0);
      logBytesStoredTotal.add(byteCount, attrs);
      await write;
    }
  };
}
