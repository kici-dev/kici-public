/**
 * Writes agent log lines as JSONL to LogStorage at executions/{runId}/job-{name}/step-{index}.log.
 *
 * Writes use `appendStreaming`: the filesystem backend appends immediately (no buffering); the
 * S3 backend buffers per step key and seals immutable append-only segments. `drain(runId)`
 * awaits in-flight appends, then finalizes each step path so the S3 tail segment is sealed
 * before a reader declares the stream complete.
 */

import type { LogStorage } from './log-storage.js';
import { stepLogPath } from './step-log-path.js';
import { LogStream } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ObserverRegistry } from '../ws/observer-registry.js';
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'log-writer' });

interface LogWriterDeps {
  logStorage: LogStorage;
  /** Broadcasts log chunks to CLI observers. */
  observerRegistry?: ObserverRegistry;
  /** Only test runs are broadcast to observers. */
  isTestRun?: (runId: string) => boolean;
}

export class LogWriter {
  private readonly logStorage: LogStorage;
  private readonly observerRegistry?: ObserverRegistry;
  private readonly isTestRun?: (runId: string) => boolean;
  /**
   * In-flight appends per runId. The agent WS handler calls `appendChunk` fire-and-forget, so a
   * run can turn terminal while its final chunk's append is pending. `drain(runId)` lets a reader
   * (the test-run logs cursor endpoint) wait for them; otherwise `done` can be `true` before the
   * last log line is on disk, dropping it from a blocking `kici run remote` follow.
   */
  private readonly pendingAppends = new Map<string, Set<Promise<void>>>();
  /** Paths written per run; `drain(runId)` finalizes each (a no-op on the filesystem backend). */
  private readonly runPaths = new Map<string, Set<string>>();

  constructor(deps: LogWriterDeps) {
    this.logStorage = deps.logStorage;
    this.observerRegistry = deps.observerRegistry;
    this.isTestRun = deps.isTestRun;
  }

  /**
   * Await every append for `runId` registered before this call, then seal each step log's S3
   * tail segment. Settles even if an append rejected (`appendChunk` already logged it): the
   * point is ordering, not error propagation. Later appends are not waited on — a terminal run
   * emits no further chunks, so the call-time snapshot is complete.
   */
  async drain(runId: string): Promise<void> {
    // 1) Appends before finalize, so the tail seal includes the last in-flight chunk.
    const pending = this.pendingAppends.get(runId);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);

    // 2) Seal each path's buffered tail segment (S3); a no-op on FS.
    const paths = this.runPaths.get(runId);
    if (paths) {
      for (const path of paths) {
        try {
          await this.logStorage.finalize(path);
        } catch (err) {
          logger.error('Failed to finalize log path', {
            path,
            error: toErrorMessage(err),
          });
        }
      }
      this.runPaths.delete(runId);
    }
  }

  /**
   * Append agent lines as JSONL, one per line:
   * {"ts":"2026-01-01T00:00:00.000Z","level":"stdout","msg":"line content","meta":{}}
   *
   * Also fans chunks out to observers (test runs only, when observerRegistry is configured).
   *
   * @param jobName - Job name (not job ID)
   * @param stepIndex - 0-based
   * @param timestamp - Epoch ms, from the agent message
   * @param jobId - Required for observer broadcasting
   * @param stream - Subprocess stream; absent (not reported) is recorded as `stdout`.
   */
  async appendChunk(
    runId: string,
    jobName: string,
    stepIndex: number,
    lines: string[],
    timestamp: number,
    jobId?: string,
    stepName?: string,
    stream?: LogStream,
  ): Promise<void> {
    if (lines.length === 0) return;

    const path = stepLogPath(runId, jobName, stepIndex);
    let paths = this.runPaths.get(runId);
    if (!paths) {
      paths = new Set();
      this.runPaths.set(runId, paths);
    }
    paths.add(path);
    const isoTimestamp = new Date(timestamp).toISOString();

    const jsonlLines = lines.map(
      (line) =>
        JSON.stringify({
          ts: isoTimestamp,
          // Absent: the agent could not distinguish the two streams.
          level: stream ?? LogStream.enum.stdout,
          msg: line,
          meta: {},
        }) + '\n',
    );

    const data = jsonlLines.join('');

    // Observers FIRST (synchronous WS sends), before the async append: on very fast steps the
    // run-completion broadcast could otherwise reach observers before the chunk, and observers
    // disconnect right after the terminal status, dropping the line.
    if (this.observerRegistry && this.isTestRun?.(runId) && jobId) {
      this.observerRegistry.broadcastLog(
        runId,
        jobId,
        jobName,
        stepIndex,
        stepName ?? `step-${stepIndex}`,
        lines,
      );
    }

    // Tracked for `drain`: the calling handler does not await this method, so the write would
    // otherwise race the run-status transition.
    const appendPromise = (async () => {
      try {
        await this.logStorage.appendStreaming(path, data);
      } catch (err) {
        logger.error('Failed to append log chunk', {
          path,
          lineCount: lines.length,
          error: toErrorMessage(err),
        });
      }
    })();

    this.trackPending(runId, appendPromise);

    await appendPromise;
  }

  /**
   * Make {@link drain} for `runId` wait for `pending` as it waits for an append.
   *
   * For a caller with work left before {@link appendChunk} — resolving the job name that names
   * the storage key. Otherwise a run completing mid-resolve is drained first, the append lands
   * after, and on object storage its segment is never sealed, so the chunk is never readable. A
   * job whose setup fails sends its last setup lines right before its terminal status: exactly
   * that window.
   */
  trackPending(runId: string, pending: Promise<unknown>): void {
    const tracked = pending.then(
      () => undefined,
      () => undefined,
    );
    let runPending = this.pendingAppends.get(runId);
    if (!runPending) {
      runPending = new Set();
      this.pendingAppends.set(runId, runPending);
    }
    runPending.add(tracked);
    runDetached(
      logger,
      'Pending append cleanup',
      () =>
        tracked.then(() => {
          const set = this.pendingAppends.get(runId);
          if (!set) return;
          set.delete(tracked);
          if (set.size === 0) this.pendingAppends.delete(runId);
        }),
      { runId },
    );
  }
}
