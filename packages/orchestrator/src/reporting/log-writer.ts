/**
 * Log writer that transforms agent log lines into JSONL and persists to LogStorage.
 *
 * Each log line is formatted as a JSON object with timestamp, level, message,
 * and metadata fields. Lines are written to the standard log path layout:
 * executions/{runId}/job-{name}/step-{index}.log
 *
 * Step-log writes go through the high-frequency `appendStreaming` verb: the
 * filesystem backend appends immediately (no buffering); the S3 backend buffers
 * per step key and seals immutable append-only segments. `drain(runId)` awaits
 * the in-flight appends and then finalizes each step path so the S3 tail
 * segment is sealed before a reader declares the stream complete.
 */

import type { LogStorage } from './log-storage.js';
import { LogStream } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { ObserverRegistry } from '../ws/observer-registry.js';

const logger = createLogger({ prefix: 'log-writer' });

interface LogWriterDeps {
  logStorage: LogStorage;
  /** Optional observer registry for broadcasting log chunks to CLI observers. */
  observerRegistry?: ObserverRegistry;
  /** Optional function to check if a run is a test run (for observer broadcasting). */
  isTestRun?: (runId: string) => boolean;
}

export class LogWriter {
  private readonly logStorage: LogStorage;
  private readonly observerRegistry?: ObserverRegistry;
  private readonly isTestRun?: (runId: string) => boolean;
  /**
   * In-flight `logStorage.append` promises, keyed by runId. `appendChunk` is
   * called fire-and-forget from the agent WS handler (it does not await the
   * storage write), so a run can flip to a terminal status while the final
   * log chunk's append is still pending. `drain(runId)` lets a reader (the
   * test-run logs cursor endpoint) wait for those pending writes before it
   * reports the stream as fully drained — without this, the `done` flag can
   * be returned `true` while the last user-visible log line is not yet on
   * disk, dropping it from a blocking `kici run remote` follow.
   */
  private readonly pendingAppends = new Map<string, Set<Promise<void>>>();
  /**
   * Log paths written for each run, populated in `appendChunk`. `drain(runId)`
   * finalizes each one so the S3 backend seals its buffered tail segment before
   * a reader declares the stream complete. The filesystem backend's `finalize`
   * is a no-op.
   */
  private readonly runPaths = new Map<string, Set<string>>();

  constructor(deps: LogWriterDeps) {
    this.logStorage = deps.logStorage;
    this.observerRegistry = deps.observerRegistry;
    this.isTestRun = deps.isTestRun;
  }

  /**
   * Await every in-flight log append for `runId` that was registered before
   * this call, then seal each step log's buffered tail segment so the durable
   * S3 record is complete. Settles even if an append rejected (errors are
   * already logged by `appendChunk`); the point is ordering, not error
   * propagation. New appends started after this call are not waited on — a
   * terminal run emits no further chunks, so the snapshot taken at call time is
   * complete.
   */
  async drain(runId: string): Promise<void> {
    // 1) Await every in-flight append first, so all bytes for this run are
    //    buffered/sealed before we seal the tail. Doing this before finalize
    //    guarantees the tail seal includes the last in-flight chunk.
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
   * Append log lines from an agent to storage in JSONL format.
   *
   * Each line is formatted as:
   * {"ts":"2026-01-01T00:00:00.000Z","level":"stdout","msg":"line content","meta":{}}
   *
   * Also fans log chunks to connected observers for real-time streaming
   * (test runs only, when observerRegistry is configured).
   *
   * @param runId - Execution run ID
   * @param jobName - Job name (not job ID)
   * @param stepIndex - Step index within the job (0-based)
   * @param lines - Raw log lines from the agent
   * @param timestamp - Timestamp from the agent message (epoch ms)
   * @param jobId - Job ID for observer broadcasting (optional)
   * @param stepName - Step name for observer broadcasting (optional)
   * @param stream - Which subprocess stream the lines came from. Absent means
   *   the agent did not report one, which is recorded as `stdout`.
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

    const path = `executions/${runId}/job-${jobName}/step-${stepIndex}.log`;
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
          // An absent stream means the agent could not distinguish the two;
          // stdout is the reading applied to every such line.
          level: stream ?? LogStream.enum.stdout,
          msg: line,
          meta: {},
        }) + '\n',
    );

    const data = jsonlLines.join('');

    // Fan out log chunks to observers FIRST (test runs only, synchronous WS sends).
    // Doing this before the async storage.append avoids a race on very fast steps:
    // the run-completion broadcast can otherwise reach observers before the log
    // chunk does (because observers disconnect right after the terminal status),
    // dropping the user-visible log line.
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

    // Track this append so a terminal-run reader can drain it before claiming
    // the log stream is complete. The handler that calls us does not await this
    // method, so the write would otherwise race the run-status transition.
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

    let runPending = this.pendingAppends.get(runId);
    if (!runPending) {
      runPending = new Set();
      this.pendingAppends.set(runId, runPending);
    }
    runPending.add(appendPromise);
    appendPromise.finally(() => {
      const set = this.pendingAppends.get(runId);
      if (!set) return;
      set.delete(appendPromise);
      if (set.size === 0) this.pendingAppends.delete(runId);
    });

    await appendPromise;
  }
}
