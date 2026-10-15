/**
 * Answers Platform `log.request` messages for historical logs from LogStorage, with
 * cursor/limit pagination and jobName/stepIndex filtering. Live logs flow via the
 * push-based log.chunk -> BrowserFanOut path, not here.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { LogStorage } from './log-storage.js';
import { stepLogPath } from './step-log-path.js';
import type { ExecutionTracker } from './execution-tracker.js';

const logger = createLogger({ prefix: 'log-pull' });

export interface LogPullHandlerDeps {
  logStorage: LogStorage;
  executionTracker: ExecutionTracker;
  /** Sends response messages back over WS */
  send: (message: unknown) => void;
}

export class LogPullHandler {
  constructor(private readonly deps: LogPullHandlerDeps) {}

  async handleRequest(msg: {
    messageId: string;
    executionId: string;
    jobName?: string;
    stepIndex?: number;
    cursor?: number;
    limit?: number;
  }): Promise<void> {
    try {
      const prefix = `executions/${msg.executionId}`;

      // One job + step
      if (msg.jobName !== undefined && msg.stepIndex !== undefined) {
        const path = stepLogPath(msg.executionId, msg.jobName, msg.stepIndex);
        if (!(await this.deps.logStorage.exists(path))) {
          this.deps.send({
            type: 'log.response',
            messageId: msg.messageId,
            executionId: msg.executionId,
            chunks: [],
            complete: true,
            error: 'not_found',
          });
          return;
        }
        const result = await this.deps.logStorage.read(path, {
          cursor: msg.cursor,
          limit: msg.limit ?? 65536, // 64KB default chunk
        });
        this.deps.send({
          type: 'log.response',
          messageId: msg.messageId,
          executionId: msg.executionId,
          chunks: [
            {
              jobName: msg.jobName,
              stepIndex: msg.stepIndex,
              lines: result.data.split('\n').filter(Boolean),
              timestamp: Date.now(),
            },
          ],
          cursor: result.complete ? undefined : result.cursor,
          complete: result.complete,
        });
        return;
      }

      // One job, all steps
      if (msg.jobName !== undefined) {
        const jobPrefix = `${prefix}/job-${msg.jobName}/`;
        const files = await this.deps.logStorage.list(jobPrefix);
        const chunks = [];
        for (const file of files) {
          // `-?`: a job's workflow-level setup log is step -1 (`step--1.log`).
          const stepMatch = file.match(/step-(-?\d+)\.log$/);
          if (!stepMatch) continue;
          const result = await this.deps.logStorage.read(file, { limit: msg.limit });
          chunks.push({
            jobName: msg.jobName,
            stepIndex: parseInt(stepMatch[1], 10),
            lines: result.data.split('\n').filter(Boolean),
            timestamp: Date.now(),
          });
        }
        this.deps.send({
          type: 'log.response',
          messageId: msg.messageId,
          executionId: msg.executionId,
          chunks,
          complete: true,
        });
        return;
      }

      // Whole execution
      const files = await this.deps.logStorage.list(prefix);
      const chunks = [];
      for (const file of files) {
        const match = file.match(/job-([^/]+)\/step-(-?\d+)\.log$/);
        if (!match) continue;
        const result = await this.deps.logStorage.read(file, { limit: msg.limit });
        chunks.push({
          jobName: match[1],
          stepIndex: parseInt(match[2], 10),
          lines: result.data.split('\n').filter(Boolean),
          timestamp: Date.now(),
        });
      }
      this.deps.send({
        type: 'log.response',
        messageId: msg.messageId,
        executionId: msg.executionId,
        chunks,
        complete: true,
      });
    } catch (err) {
      logger.error('Error handling log request', {
        executionId: msg.executionId,
        error: toErrorMessage(err),
      });
      this.deps.send({
        type: 'log.response',
        messageId: msg.messageId,
        executionId: msg.executionId,
        chunks: [],
        complete: true,
        error: 'storage_error',
      });
    }
  }
}
