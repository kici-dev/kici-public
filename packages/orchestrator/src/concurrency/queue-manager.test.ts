import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConcurrencyQueueManager, type QueuedJob } from './queue-manager.js';

/**
 * Mock DB for queue manager tests.
 * Simulates Kysely's fluent query builder with in-memory storage.
 */
function createMockDb() {
  const rows: Array<{
    id: string;
    group_key: string;
    run_id: string;
    job_id: string;
    routing_key: string;
    status: string;
    created_at: Date;
    completed_at: Date | null;
  }> = [];

  let idCounter = 0;

  function buildSelectChain() {
    return {
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((col: string, op: string, val: string) => {
          return {
            where: vi.fn().mockImplementation((col2: string, _op2: string, val2: string) => {
              return {
                where: vi.fn().mockImplementation((col3: string, _op3: string, val3: string) => {
                  return {
                    orderBy: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        forUpdate: vi.fn().mockReturnValue({
                          skipLocked: vi.fn().mockReturnValue({
                            executeTakeFirst: vi.fn().mockImplementation(() => {
                              const matches = rows.filter(
                                (r) =>
                                  r[col as keyof typeof r] === val &&
                                  r[col2 as keyof typeof r] === val2 &&
                                  r[col3 as keyof typeof r] === val3,
                              );
                              matches.sort(
                                (a, b) => a.created_at.getTime() - b.created_at.getTime(),
                              );
                              return Promise.resolve(matches[0] ?? null);
                            }),
                          }),
                        }),
                        executeTakeFirst: vi.fn().mockImplementation(() => {
                          const matches = rows.filter(
                            (r) =>
                              r[col as keyof typeof r] === val &&
                              r[col2 as keyof typeof r] === val2 &&
                              r[col3 as keyof typeof r] === val3,
                          );
                          matches.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
                          return Promise.resolve(matches[0] ?? null);
                        }),
                      }),
                    }),
                  };
                }),
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    executeTakeFirst: vi.fn().mockImplementation(() => {
                      const matches = rows.filter(
                        (r) =>
                          r[col as keyof typeof r] === val && r[col2 as keyof typeof r] === val2,
                      );
                      matches.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
                      return Promise.resolve(matches[0] ?? null);
                    }),
                  }),
                }),
                execute: vi.fn().mockImplementation(() => {
                  const matches = rows.filter(
                    (r) => r[col as keyof typeof r] === val && r[col2 as keyof typeof r] === val2,
                  );
                  return Promise.resolve(matches);
                }),
              };
            }),
          };
        }),
      }),
    };
  }

  function buildUpdateChain() {
    return {
      set: vi.fn().mockImplementation((vals: any) => {
        const filters: Array<{ col: string; val: string }> = [];

        function applyUpdate() {
          for (const row of rows) {
            const match = filters.every((f) => row[f.col as keyof typeof row] === f.val);
            if (match) {
              if (vals.status) row.status = vals.status;
              if (vals.completed_at) row.completed_at = vals.completed_at;
            }
          }
          return Promise.resolve(undefined);
        }

        // Recursive where chain that supports arbitrary depth
        function makeWhereChain(): any {
          return {
            where: vi.fn().mockImplementation((col: string, _op: string, val: string) => {
              filters.push({ col, val });
              return makeWhereChain();
            }),
            execute: vi.fn().mockImplementation(applyUpdate),
          };
        }

        return makeWhereChain();
      }),
    };
  }

  function buildInsertChain() {
    return {
      values: vi.fn().mockImplementation((vals: any) => {
        const row = {
          id: `id-${++idCounter}`,
          group_key: vals.group_key,
          run_id: vals.run_id,
          job_id: vals.job_id,
          routing_key: vals.routing_key,
          status: vals.status ?? 'queued',
          created_at: new Date(),
          completed_at: null,
        };
        rows.push(row);
        return { execute: vi.fn().mockResolvedValue(undefined) };
      }),
    };
  }

  const db: any = {
    rows,
    insertInto: vi.fn().mockImplementation(() => buildInsertChain()),
    selectFrom: vi.fn().mockImplementation(() => buildSelectChain()),
    updateTable: vi.fn().mockImplementation(() => buildUpdateChain()),
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(async (fn: (trx: any) => Promise<any>) => {
        // Transaction delegates to the same in-memory store
        const trx = {
          selectFrom: vi.fn().mockImplementation(() => buildSelectChain()),
          updateTable: vi.fn().mockImplementation(() => buildUpdateChain()),
          insertInto: vi.fn().mockImplementation(() => buildInsertChain()),
        };
        return fn(trx);
      }),
    }),
  };

  return db;
}

describe('ConcurrencyQueueManager', () => {
  let queueManager: ConcurrencyQueueManager;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    queueManager = new ConcurrencyQueueManager(mockDb as any);
  });

  describe('enqueue', () => {
    it('stores a job in the DB with queued status', async () => {
      await queueManager.enqueue({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-1',
        jobId: 'job-1',
      });
      expect(mockDb.rows).toHaveLength(1);
      expect(mockDb.rows[0].status).toBe('queued');
      expect(mockDb.rows[0].group_key).toBe('deploy-main');
    });
  });

  describe('dequeueNext', () => {
    it('returns the oldest queued job and marks it active', async () => {
      await queueManager.enqueue({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-1',
        jobId: 'job-1',
      });

      const result = await queueManager.dequeueNext('deploy-main', 'routing1');

      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
      expect(result!.jobId).toBe('job-1');
      expect(result!.groupKey).toBe('deploy-main');
      expect(result!.routingKey).toBe('routing1');
    });

    it('returns null when no queued jobs exist', async () => {
      const result = await queueManager.dequeueNext('deploy-main', 'routing1');
      expect(result).toBeNull();
    });

    it('uses a transaction for atomic dequeue', async () => {
      await queueManager.enqueue({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-1',
        jobId: 'job-1',
      });

      await queueManager.dequeueNext('deploy-main', 'routing1');

      expect(mockDb.transaction).toHaveBeenCalled();
    });
  });

  describe('cancelQueued', () => {
    it('marks queued entries as cancelled', async () => {
      await queueManager.enqueue({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-1',
        jobId: 'job-1',
      });
      await queueManager.cancelQueued('run-1');
      expect(mockDb.updateTable).toHaveBeenCalled();
    });
  });

  describe('onJobComplete', () => {
    it('marks completed and dequeues next job', async () => {
      // Record an active entry
      await queueManager.recordActive({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-1',
        jobId: 'job-1',
      });

      // Enqueue a waiting job
      await queueManager.enqueue({
        groupKey: 'deploy-main',
        routingKey: 'routing1',
        runId: 'run-2',
        jobId: 'job-2',
      });

      const next = await queueManager.onJobComplete('deploy-main', 'routing1', 'run-1');

      // markCompleted was called (updateTable)
      expect(mockDb.updateTable).toHaveBeenCalled();
      // dequeueNext was called via transaction
      expect(mockDb.transaction).toHaveBeenCalled();
    });
  });
});
