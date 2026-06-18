import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogPullHandler, type LogPullHandlerDeps } from './log-pull-handler.js';
import type { LogStorage, LogReadResult } from './log-storage.js';
import type { ExecutionTracker } from './execution-tracker.js';

// -- In-memory LogStorage mock ────────────────────────────────────

class MockLogStorage implements LogStorage {
  private files = new Map<string, string>();

  /** Seed a file in the mock storage. */
  seed(path: string, content: string): void {
    this.files.set(path, content);
  }

  async append(path: string, data: string): Promise<void> {
    const existing = this.files.get(path) ?? '';
    this.files.set(path, existing + data);
  }

  async read(path: string, options?: { cursor?: number; limit?: number }): Promise<LogReadResult> {
    const content = this.files.get(path);
    if (!content) {
      return { data: '', cursor: 0, complete: true };
    }
    const cursor = options?.cursor ?? 0;
    const limit = options?.limit;
    const remaining = content.slice(cursor);
    if (limit !== undefined && remaining.length > limit) {
      return {
        data: remaining.slice(0, limit),
        cursor: cursor + limit,
        complete: false,
      };
    }
    return {
      data: remaining,
      cursor: cursor + remaining.length,
      complete: true,
    };
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
}

// -- Helpers ──────────────────────────────────────────────────────

function createMockTracker(): ExecutionTracker {
  return {
    getJobName: vi.fn(() => undefined),
    onExecutionStarted: vi.fn(),
    onJobStatus: vi.fn(),
    onStepStatus: vi.fn(),
    isRunComplete: vi.fn(() => false),
    getRunStatus: vi.fn(() => 'running' as const),
  } as unknown as ExecutionTracker;
}

function setup() {
  const logStorage = new MockLogStorage();
  const executionTracker = createMockTracker();
  const send = vi.fn();
  const deps: LogPullHandlerDeps = { logStorage, executionTracker, send };
  const handler = new LogPullHandler(deps);
  return { handler, logStorage, executionTracker, send };
}

// -- Tests ────────────────────────────────────────────────────────

describe('LogPullHandler', () => {
  describe('handleRequest', () => {
    it('returns specific job+step logs', async () => {
      const { handler, logStorage, send } = setup();
      logStorage.seed(
        'executions/run-1/job-build/step-0.log',
        '{"ts":"2026-01-01T00:00:00Z","msg":"line 1"}\n{"ts":"2026-01-01T00:00:01Z","msg":"line 2"}\n',
      );

      await handler.handleRequest({
        messageId: 'msg-1',
        executionId: 'run-1',
        jobName: 'build',
        stepIndex: 0,
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('log.response');
      expect(response.messageId).toBe('msg-1');
      expect(response.executionId).toBe('run-1');
      expect(response.chunks).toHaveLength(1);
      expect(response.chunks[0].jobName).toBe('build');
      expect(response.chunks[0].stepIndex).toBe(0);
      expect(response.chunks[0].lines).toHaveLength(2);
      expect(response.complete).toBe(true);
      expect(response.error).toBeUndefined();
    });

    it('returns not_found error for missing job+step', async () => {
      const { handler, send } = setup();

      await handler.handleRequest({
        messageId: 'msg-2',
        executionId: 'run-999',
        jobName: 'nonexistent',
        stepIndex: 0,
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('log.response');
      expect(response.error).toBe('not_found');
      expect(response.chunks).toHaveLength(0);
      expect(response.complete).toBe(true);
    });

    it('returns all steps for a specific job', async () => {
      const { handler, logStorage, send } = setup();
      logStorage.seed(
        'executions/run-1/job-test/step-0.log',
        '{"ts":"2026-01-01T00:00:00Z","msg":"step 0"}\n',
      );
      logStorage.seed(
        'executions/run-1/job-test/step-1.log',
        '{"ts":"2026-01-01T00:00:01Z","msg":"step 1"}\n',
      );

      await handler.handleRequest({
        messageId: 'msg-3',
        executionId: 'run-1',
        jobName: 'test',
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.chunks).toHaveLength(2);
      expect(response.chunks[0].stepIndex).toBe(0);
      expect(response.chunks[1].stepIndex).toBe(1);
      expect(response.complete).toBe(true);
    });

    it('returns all logs for entire execution', async () => {
      const { handler, logStorage, send } = setup();
      logStorage.seed(
        'executions/run-1/job-build/step-0.log',
        '{"ts":"2026-01-01T00:00:00Z","msg":"build step"}\n',
      );
      logStorage.seed(
        'executions/run-1/job-test/step-0.log',
        '{"ts":"2026-01-01T00:00:01Z","msg":"test step"}\n',
      );

      await handler.handleRequest({
        messageId: 'msg-4',
        executionId: 'run-1',
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.chunks).toHaveLength(2);
      const jobNames = response.chunks.map((c: any) => c.jobName).sort();
      expect(jobNames).toEqual(['build', 'test']);
      expect(response.complete).toBe(true);
    });

    it('supports cursor-based pagination', async () => {
      const { handler, logStorage, send } = setup();
      // Create a log file larger than the requested limit
      const largeLine = '{"ts":"2026-01-01T00:00:00Z","msg":"' + 'x'.repeat(100) + '"}\n';
      logStorage.seed('executions/run-1/job-build/step-0.log', largeLine.repeat(10));

      await handler.handleRequest({
        messageId: 'msg-5',
        executionId: 'run-1',
        jobName: 'build',
        stepIndex: 0,
        limit: 50, // Only read 50 bytes
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.complete).toBe(false);
      expect(response.cursor).toBeDefined();
      expect(typeof response.cursor).toBe('number');
      expect(response.cursor).toBeGreaterThan(0);
    });

    it('returns storage_error on LogStorage failure', async () => {
      const { handler, logStorage, send } = setup();
      // Make list() throw
      vi.spyOn(logStorage, 'list').mockRejectedValueOnce(new Error('disk failure'));

      await handler.handleRequest({
        messageId: 'msg-6',
        executionId: 'run-1',
      });

      expect(send).toHaveBeenCalledOnce();
      const response = send.mock.calls[0][0];
      expect(response.type).toBe('log.response');
      expect(response.error).toBe('storage_error');
      expect(response.chunks).toHaveLength(0);
      expect(response.complete).toBe(true);
    });

    it('returns storage_error when exists() throws for job+step', async () => {
      const { handler, logStorage, send } = setup();
      vi.spyOn(logStorage, 'exists').mockRejectedValueOnce(new Error('IO error'));

      await handler.handleRequest({
        messageId: 'msg-7',
        executionId: 'run-1',
        jobName: 'build',
        stepIndex: 0,
      });

      const response = send.mock.calls[0][0];
      expect(response.error).toBe('storage_error');
    });
  });
});
