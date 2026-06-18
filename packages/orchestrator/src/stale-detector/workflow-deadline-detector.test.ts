import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkflowDeadlineDetector,
  type WorkflowDeadlineDetectorDeps,
} from './workflow-deadline-detector.js';
import { TimeoutReason } from '@kici-dev/engine';

// ── Chainable mock DB ───────────────────────────────────────────

/**
 * Build a mock that mimics Kysely's chained query builder. Each call to
 * selectFrom/updateTable returns an independent chain resolving to a
 * pre-configured result.
 */
function createChainableMock(opts: {
  executeResult?: unknown[];
  executeTakeFirstResult?: unknown;
}) {
  const chain: Record<string, any> = {};
  for (const m of ['innerJoin', 'leftJoin', 'select', 'where', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.execute = vi.fn(async () => opts.executeResult ?? []);
  chain.executeTakeFirst = vi.fn(async () => opts.executeTakeFirstResult);
  return chain;
}

/**
 * Build a mock Kysely DB where selectFrom and updateTable calls can be
 * configured per-call-index.
 */
function createSequentialDb(config: {
  selects: Array<{ executeResult?: unknown[]; executeTakeFirstResult?: unknown }>;
  updates?: Array<{ executeTakeFirstResult?: unknown }>;
}) {
  let selectIdx = 0;
  let updateIdx = 0;
  const db = {
    selectFrom: vi.fn(() => {
      const idx = selectIdx++;
      return createChainableMock(config.selects[idx] ?? { executeResult: [] });
    }),
    updateTable: vi.fn(() => {
      const idx = updateIdx++;
      const cfg = config.updates?.[idx] ?? { executeTakeFirstResult: { numUpdatedRows: 1n } };
      return createChainableMock({ executeTakeFirstResult: cfg.executeTakeFirstResult });
    }),
  };
  return db as unknown as WorkflowDeadlineDetectorDeps['db'];
}

function createDeps() {
  const cancelRunWithReason = vi.fn().mockResolvedValue(undefined);
  const cancelByRunId = vi.fn().mockResolvedValue(0);
  return { cancelRunWithReason, cancelByRunId };
}

function makeDeps(
  db: WorkflowDeadlineDetectorDeps['db'],
  mocks: ReturnType<typeof createDeps>,
): WorkflowDeadlineDetectorDeps {
  return {
    db,
    cancelRun: mocks.cancelRunWithReason,
    jobQueue: {
      cancelByRunId: mocks.cancelByRunId,
    } as unknown as WorkflowDeadlineDetectorDeps['jobQueue'],
    scanIntervalMs: 30_000,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('WorkflowDeadlineDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels a run past its workflow deadline with the workflow_timeout reason', async () => {
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [
        {
          executeResult: [
            {
              run_id: 'run-overdue',
              workflow_timeout_ms: 1_000,
              started_at: new Date(Date.now() - 10_000),
            },
          ],
        },
      ],
    });

    const detector = new WorkflowDeadlineDetector(makeDeps(db, mocks));
    await detector.scan();

    // Queued dispatch rows cancelled.
    expect(mocks.cancelByRunId).toHaveBeenCalledWith('run-overdue');

    // Canonical cancel path invoked with a reason carrying the distinct enum.
    expect(mocks.cancelRunWithReason).toHaveBeenCalledTimes(1);
    const [runId, reason] = mocks.cancelRunWithReason.mock.calls[0];
    expect(runId).toBe('run-overdue');
    expect(reason).toContain(TimeoutReason.enum.workflow_timeout);
  });

  it('leaves runs that are not past their deadline untouched', async () => {
    const mocks = createDeps();
    // The SQL predicate filters them out, so the SELECT returns nothing.
    const db = createSequentialDb({ selects: [{ executeResult: [] }] });

    const detector = new WorkflowDeadlineDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.cancelByRunId).not.toHaveBeenCalled();
    expect(mocks.cancelRunWithReason).not.toHaveBeenCalled();
  });

  it('cancels every overdue run returned by the scan', async () => {
    const mocks = createDeps();
    const db = createSequentialDb({
      selects: [
        {
          executeResult: [
            {
              run_id: 'run-a',
              workflow_timeout_ms: 1_000,
              started_at: new Date(Date.now() - 5_000),
            },
            {
              run_id: 'run-b',
              workflow_timeout_ms: 2_000,
              started_at: new Date(Date.now() - 9_000),
            },
          ],
        },
      ],
    });

    const detector = new WorkflowDeadlineDetector(makeDeps(db, mocks));
    await detector.scan();

    expect(mocks.cancelRunWithReason).toHaveBeenCalledWith('run-a', expect.any(String));
    expect(mocks.cancelRunWithReason).toHaveBeenCalledWith('run-b', expect.any(String));
    expect(mocks.cancelRunWithReason).toHaveBeenCalledTimes(2);
  });

  it('start() runs an immediate scan and stop() clears the interval', async () => {
    const mocks = createDeps();
    const db = createSequentialDb({ selects: [{ executeResult: [] }] });

    const detector = new WorkflowDeadlineDetector(makeDeps(db, mocks));
    await detector.start();
    expect((db as any).selectFrom).toHaveBeenCalled();

    vi.mocked((db as any).selectFrom).mockClear();
    detector.stop();
    vi.advanceTimersByTime(60_000);
    expect((db as any).selectFrom).not.toHaveBeenCalled();
  });

  it('handles DB errors gracefully (scan never throws)', async () => {
    const mocks = createDeps();
    const db = {
      selectFrom: vi.fn(() => {
        throw new Error('DB connection lost');
      }),
      updateTable: vi.fn(() => createChainableMock({})),
    } as unknown as WorkflowDeadlineDetectorDeps['db'];

    const detector = new WorkflowDeadlineDetector(makeDeps(db, mocks));
    await expect(detector.scan()).resolves.toBeUndefined();
    expect(mocks.cancelRunWithReason).not.toHaveBeenCalled();
  });
});
