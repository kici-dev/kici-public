import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import {
  WorkflowDeadlineDetector,
  DEADLINE_RECENCY_WINDOW_MS,
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

// ── Scan predicate: deadline-recency bound (the ≥24h-timeout regression) ──────
//
// The mock DB above stubs `.where()` as a no-op, so it can NEVER prove which
// runs the SQL predicate keeps. This block instead compiles the exact query
// scan() runs (Kysely `.compile()`, no live DB) and asserts the boundary math
// that governs whether a long-timeout run is found. This is the unit-level proof
// of the bug fix: the scan must bound the run's DEADLINE recency, not its
// `started_at`. A `started_at > (now - 24h)` guard silently excluded every run
// whose declared workflow timeout was >= 24h (its deadline only lapses once
// started_at has already aged past 24h), so those runs hung forever.
describe('WorkflowDeadlineDetector — scan predicate (deadline-recency bound)', () => {
  const DEADLINE_EXPR = "started_at + (workflow_timeout_ms * interval '1 millisecond')";

  /** Compile the scan's SELECT against a real Kysely (never-touched pool). */
  function compileScanSql(): { sql: string; parameters: readonly unknown[] } {
    const db = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool: {} as unknown as pg.Pool }),
    });
    const detector = new WorkflowDeadlineDetector(
      makeDeps(db as unknown as WorkflowDeadlineDetectorDeps['db'], createDeps()),
    );
    // buildOverdueQuery is private; reach it for the compiled-SQL assertion.
    return (
      detector as unknown as {
        buildOverdueQuery: () => { compile: () => { sql: string; parameters: readonly unknown[] } };
      }
    )
      .buildOverdueQuery()
      .compile();
  }

  it('bounds recency on the DEADLINE, not started_at, so a >=24h-timeout run stays in scope once overdue', () => {
    const compiled = compileScanSql();

    // Overdue predicate: deadline < now().
    expect(compiled.sql).toContain(`${DEADLINE_EXPR} < now()`);

    // Recency predicate is on the DEADLINE (deadline > now() - window) — the fix.
    // A run with started_at = now-25h and workflow_timeout_ms = 24h has a deadline
    // ~1h ago, which satisfies BOTH `deadline < now()` and `deadline > now()-24h`,
    // so it is found and cancelled. The old guard bounded started_at instead, which
    // excluded exactly this row.
    expect(compiled.sql).toContain(`${DEADLINE_EXPR} > now() -`);

    // The removed bug: there must be NO lower bound on started_at itself.
    expect(compiled.sql).not.toContain('"started_at" >');

    // The recency window is the exported 24h constant, bound as a parameter.
    expect(compiled.parameters).toContain(DEADLINE_RECENCY_WINDOW_MS);
    expect(DEADLINE_RECENCY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('still filters by non-terminal status and a non-null workflow timeout', () => {
    const compiled = compileScanSql();

    expect(compiled.sql).toContain('"status" in');
    expect(compiled.sql).toContain('"workflow_timeout_ms" is not null');
    // A short-timeout recent run (e.g. 1s timeout, started 10s ago → deadline 9s ago)
    // still matches deadline < now() AND deadline > now()-24h, so the existing
    // short-timeout behavior is preserved by the same predicate pair.
    expect(compiled.parameters).toContain('pending');
    expect(compiled.parameters).toContain('running');
    expect(compiled.parameters).toContain('cancelling');
  });
});
