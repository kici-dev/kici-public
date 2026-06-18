import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionTracker, type ExecutionTrackerDeps } from './execution-tracker.js';

// Mock Prometheus metrics to avoid pulling in the OTel registry from a peer
// package during this isolated unit test.
vi.mock('../metrics/prometheus.js', () => ({
  executionsTotal: { add: vi.fn() },
  executionDurationSeconds: { record: vi.fn() },
}));

/**
 * Tiny Kysely-shaped mock that only models the queries used by
 * `getReplayDataWithDb`: a single `selectFrom('execution_runs').select(...)
 * .where(...).where(...).orderBy(...).execute()` chain plus a
 * `selectFrom('execution_jobs').select(...).where(...).execute()` chain.
 *
 * The full mock in execution-tracker.test.ts is purpose-built for write-through
 * assertions and would need substantial extensions (orderBy + plain .execute
 * for selects) to cover this method — keeping the replay test isolated avoids
 * polluting that fixture.
 */
function createMockDb(opts: {
  runs: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
}) {
  const db = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'execution_runs') {
        return {
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue(opts.runs),
        };
      }
      if (table === 'execution_jobs') {
        return {
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          execute: vi.fn().mockResolvedValue(opts.jobs),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  } as unknown as ExecutionTrackerDeps['db'];
  return db;
}

describe('ExecutionTracker.getReplayDataWithDb', () => {
  let tracker: ExecutionTracker;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns DB-backed terminal runs when in-memory state is empty', async () => {
    const completedAt = new Date('2026-04-26T12:00:00Z');
    const startedAt = new Date('2026-04-26T11:55:00Z');

    const db = createMockDb({
      runs: [
        {
          run_id: 'run-A',
          workflow_name: 'ci',
          status: 'success',
          routing_key: 'github:1',
          repo_identifier: 'org/repo',
          sha: 'abc123',
          ref: 'main',
          started_at: startedAt,
          completed_at: completedAt,
          duration_ms: 300_000,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: null,
          failure_reason: null,
        },
      ],
      jobs: [
        { run_id: 'run-A', job_id: 'j1', job_name: 'test', status: 'success' },
        { run_id: 'run-A', job_id: 'j2', job_name: 'build', status: 'success' },
      ],
    });

    tracker = new ExecutionTracker({ db });

    const result = await tracker.getReplayDataWithDb(24);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      runId: 'run-A',
      workflowName: 'ci',
      status: 'success',
      routingKey: 'github:1',
      repoIdentifier: 'org/repo',
      sha: 'abc123',
      ref: 'main',
      jobCount: 2,
      durationMs: 300_000,
      completedAt: completedAt.getTime(),
      startedAt: startedAt.getTime(),
    });
    expect(result[0].jobs).toEqual([
      { jobId: 'j1', jobName: 'test', status: 'success' },
      { jobId: 'j2', jobName: 'build', status: 'success' },
    ]);
  });

  it('does not duplicate runs that are already in memory', async () => {
    const completedAt = new Date('2026-04-26T12:00:00Z');
    const db = createMockDb({
      runs: [
        {
          run_id: 'run-shared',
          workflow_name: 'ci',
          status: 'success',
          routing_key: 'github:1',
          repo_identifier: 'org/repo',
          sha: 'a',
          ref: 'main',
          started_at: new Date('2026-04-26T11:55:00Z'),
          completed_at: completedAt,
          duration_ms: 1000,
          parent_run_id: null,
          original_run_id: null,
          triggered_by: null,
          failure_reason: null,
        },
      ],
      jobs: [],
    });

    const tracker = new ExecutionTracker({ db });

    // Stub getReplayData() to simulate an in-memory entry for the same runId
    // (avoids needing a full DB-write-supporting mock to drive onExecutionStarted).
    vi.spyOn(tracker, 'getReplayData').mockReturnValue([
      {
        runId: 'run-shared',
        workflowName: 'ci',
        status: 'success',
        routingKey: 'github:1',
        repoIdentifier: 'org/repo',
        sha: 'a',
        ref: 'main',
        parentRunId: null,
        originalRunId: null,
        triggeredBy: null,
        jobCount: 0,
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 1000,
        jobs: [],
      },
    ]);

    const result = await tracker.getReplayDataWithDb(24);

    const matching = result.filter((r) => r.runId === 'run-shared');
    expect(matching).toHaveLength(1);
  });

  it('falls back to in-memory replay when DB query fails', async () => {
    const failingDb = {
      selectFrom: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        execute: vi.fn().mockRejectedValue(new Error('DB down')),
      })),
    } as unknown as ExecutionTrackerDeps['db'];

    tracker = new ExecutionTracker({ db: failingDb });

    const result = await tracker.getReplayDataWithDb(24);
    expect(result).toEqual([]);
  });
});
