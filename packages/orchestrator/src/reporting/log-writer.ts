/**
 * Log writer that transforms agent log lines into JSONL and persists to LogStorage.
 *
 * Each log line is formatted as a JSON object with timestamp, level, message,
 * and metadata fields. Lines are written to the standard log path layout:
 * executions/{runId}/job-{name}/step-{index}.log
 *
 * For filesystem storage, data is appended immediately (no buffering).
 * For S3 storage, the LogStorage backend handles read-concat-put.
 */

import type { LogStorage } from './log-storage.js';
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

  constructor(deps: LogWriterDeps) {
    this.logStorage = deps.logStorage;
    this.observerRegistry = deps.observerRegistry;
    this.isTestRun = deps.isTestRun;
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
   */
  async appendChunk(
    runId: string,
    jobName: string,
    stepIndex: number,
    lines: string[],
    timestamp: number,
    jobId?: string,
    stepName?: string,
  ): Promise<void> {
    if (lines.length === 0) return;

    const path = `executions/${runId}/job-${jobName}/step-${stepIndex}.log`;
    const isoTimestamp = new Date(timestamp).toISOString();

    const jsonlLines = lines.map(
      (line) =>
        JSON.stringify({
          ts: isoTimestamp,
          level: 'stdout',
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

    try {
      await this.logStorage.append(path, data);
    } catch (err) {
      logger.error('Failed to append log chunk', {
        path,
        lineCount: lines.length,
        error: toErrorMessage(err),
      });
    }
  }
}
