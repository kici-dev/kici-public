import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExecutionTracker,
  type ExecutionTrackerDeps,
  type ExecutionContext,
} from './execution-tracker.js';
import { requestContext } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  InitFailureCategory,
  RunFailureClass,
  ScalerEventType,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
  resolveWhenToRunOn,
} from '@kici-dev/engine';

// Mock Prometheus metrics
vi.mock('../metrics/prometheus.js', () => ({
  executionsTotal: { add: vi.fn() },
  executionDurationSeconds: { record: vi.fn() },
}));

// ── Mock DB helpers ──────────────────────────────────────────────

interface MockRow {
  table: string;
  values: Record<string, unknown>;
}

interface MockUpdate {
  table: string;
  values: Record<string, unknown>;
  where: Array<[string, string, unknown]>;
}

interface MockDelete {
  table: string;
  where: Array<[string, string, unknown]>;
}

/**
 * Create a mock Kysely DB that captures insert/update operations.
 * Sufficient for testing ExecutionTracker's DB write-through behavior.
 *
 * NOTE: This test uses a specialized stateful mock (capturing inserts/updates
 * with per-table tracking and step row simulation) instead of the shared
 * createMockDb() from '../__test-helpers__/mock-db.js' because
 * ExecutionTracker tests verify exact captured DB operations.
 */
function createMockDb() {
  const inserts: MockRow[] = [];
  const updates: MockUpdate[] = [];
  const deletes: MockDelete[] = [];
  const selects: Array<{ table: string; where: Array<[string, string, unknown]> }> = [];

  /** Accumulated .where() clauses for the current chain. */
  let currentWheres: Array<[string, string, unknown]> = [];

  /** Track step rows for select upsert checks. */
  const stepRows = new Map<string, { id: string }>();
  /** Track execution_jobs rows for upsert + select checks. */
  const jobRows = new Map<string, { id: string; job_name?: string; job_id?: string }>();
  /** Track execution_runs rows so a second write is captured as an update. */
  const runRows = new Map<string, { status?: string }>();

  const db = {
    insertInto: vi.fn((table: string) => {
      let insertValues: Record<string, unknown>[] = [];
      return {
        values: vi.fn((vals: Record<string, unknown> | Record<string, unknown>[]) => {
          insertValues = Array.isArray(vals) ? vals : [vals];
          const executeInsert = async () => {
            for (const v of insertValues) {
              inserts.push({ table, values: v });
              // Track step rows for subsequent upserts
              if (table === 'execution_steps') {
                const key = `${v.run_id}:${v.job_id}:${v.step_index}`;
                stepRows.set(key, { id: `step-${stepRows.size}` });
              }
              // Track execution_jobs rows for subsequent upserts
              if (table === 'execution_jobs') {
                const key = `${v.run_id}:${v.job_id}`;
                jobRows.set(key, {
                  id: `job-${jobRows.size}`,
                  job_name: v.job_name as string | undefined,
                  job_id: v.job_id as string | undefined,
                });
              }
              // Track execution_runs rows for subsequent upserts
              if (table === 'execution_runs') {
                runRows.set(String(v.run_id), { status: v.status as string | undefined });
              }
            }
            return [];
          };
          return {
            execute: vi.fn(executeInsert),
            onConflict: vi.fn((ocFn: (oc: unknown) => unknown) => {
              // Record which conflict resolution the caller chose, so a test can
              // tell an upsert from a doNothing. Without this the mock treats
              // both alike and any assertion about upsert behavior is vacuous.
              let resolution: 'doNothing' | 'doUpdateSet' = 'doNothing';
              // Captured from the production `.where(col, op, values)` guard so
              // the mock applies the caller's condition instead of restating it
              // — deleting the guard from the source must fail a test.
              let guard: [string, string, unknown] | undefined;
              const target = () => ({
                doNothing: () => {
                  resolution = 'doNothing';
                  return {};
                },
                doUpdateSet: (vals: Record<string, unknown>) => {
                  resolution = 'doUpdateSet';
                  const chain: Record<string, unknown> = { __values: vals };
                  chain.where = (col: string, op: string, val: unknown) => {
                    guard = [col, op, val];
                    return chain;
                  };
                  return chain;
                },
              });
              ocFn({ column: target, columns: target });
              // Returns how many rows the upsert actually wrote, so a caller
              // that gates on `numInsertedOrUpdatedRows` (the terminal-clobber
              // guard) sees the guard's real verdict rather than a constant.
              const runUpsert = async (): Promise<number> => {
                const before = inserts.length + updates.length;
                // Simulate upsert: if row exists, record as update; otherwise, record as insert
                for (const v of insertValues) {
                  if (table === 'execution_steps') {
                    const key = `${v.run_id}:${v.job_id}:${v.step_index}`;
                    if (stepRows.has(key)) {
                      updates.push({
                        table,
                        values: v,
                        where: [
                          ['run_id', '=', v.run_id],
                          ['job_id', '=', v.job_id],
                          ['step_index', '=', v.step_index],
                        ],
                      });
                    } else {
                      inserts.push({ table, values: v });
                      stepRows.set(key, { id: `step-${stepRows.size}` });
                    }
                  } else if (table === 'execution_jobs') {
                    const key = `${v.run_id}:${v.job_id}`;
                    if (jobRows.has(key)) {
                      // Row exists (created by onExecutionStarted) -- record as update
                      updates.push({
                        table,
                        values: v,
                        where: [
                          ['run_id', '=', v.run_id],
                          ['job_id', '=', v.job_id],
                        ],
                      });
                    } else {
                      // New row (recovery path) -- record as insert and track
                      inserts.push({ table, values: v });
                      jobRows.set(key, {
                        id: `job-${jobRows.size}`,
                        job_name: v.job_name as string | undefined,
                        job_id: v.job_id as string | undefined,
                      });
                    }
                  } else if (table === 'execution_runs') {
                    const key = String(v.run_id);
                    const existing = runRows.get(key);
                    if (existing) {
                      // A conflicting row exists. `doNothing` leaves it alone;
                      // an upsert rewrites it, but the tracker's guard keeps an
                      // already-terminal row untouched.
                      if (resolution === 'doNothing') continue;
                      if (guard && existing.status !== undefined) {
                        const [col, op, val] = guard;
                        const column = col.split('.').pop();
                        const excluded = Array.isArray(val) ? (val as unknown[]) : [val];
                        if (
                          column === 'status' &&
                          op === 'not in' &&
                          excluded.includes(existing.status)
                        ) {
                          continue;
                        }
                      }
                      updates.push({
                        table,
                        values: v,
                        where: [['run_id', '=', v.run_id]],
                      });
                      runRows.set(key, { status: v.status as string | undefined });
                    } else {
                      inserts.push({ table, values: v });
                      runRows.set(key, { status: v.status as string | undefined });
                    }
                  } else {
                    inserts.push({ table, values: v });
                  }
                }
                return inserts.length + updates.length - before;
              };
              return {
                execute: vi.fn(async () => {
                  await runUpsert();
                  return [];
                }),
                executeTakeFirst: vi.fn(async () => ({
                  numInsertedOrUpdatedRows: BigInt(await runUpsert()),
                })),
              };
            }),
          };
        }),
      };
    }),

    updateTable: vi.fn((table: string) => {
      currentWheres = [];
      return {
        set: vi.fn((vals: Record<string, unknown>) => {
          const buildExecute = () => ({
            where: vi.fn((col: string, op: string, val: unknown) => {
              currentWheres.push([col, op, val]);
              return buildExecute();
            }),
            execute: vi.fn(async () => {
              runUpdate();
              return [];
            }),
            // Mirrors `execute`, but reports the row count so a caller that
            // gates on `numUpdatedRows` (the terminal-clobber guard) sees the
            // guard's real verdict rather than a constant.
            executeTakeFirst: vi.fn(async () => ({
              numUpdatedRows: BigInt(runUpdate()),
            })),
          });
          /**
           * Apply one guarded UPDATE. Honours a `status in [...]` predicate
           * against the tracked run row, so an update whose guard excludes the
           * row's current status is a no-op — the same way Postgres behaves.
           * Without this the mock would apply every write and any assertion
           * about a clobber guard would be vacuous.
           */
          const runUpdate = (): number => {
            const runId = currentWheres.find((w) => w[0] === 'run_id')?.[2];
            const statusGuard = currentWheres.find((w) => w[0] === 'status' && w[1] === 'in');
            if (table === 'execution_runs' && runId && statusGuard) {
              const existing = runRows.get(String(runId));
              const allowed = statusGuard[2] as unknown[];
              if (existing?.status !== undefined && !allowed.includes(existing.status)) return 0;
            }
            updates.push({ table, values: vals, where: [...currentWheres] });
            // Keep the tracked run status current, so a later upsert's guard
            // sees the status the row actually holds.
            if (table === 'execution_runs' && typeof vals.status === 'string' && runId) {
              runRows.set(String(runId), { status: vals.status });
            }
            return 1;
          };
          return buildExecute();
        }),
      };
    }),

    selectFrom: vi.fn((table: string) => {
      currentWheres = [];
      return {
        select: vi.fn(() => ({
          where: vi.fn((col: string, op: string, val: unknown) => {
            currentWheres.push([col, op, val]);
            const buildExecute = () => ({
              where: vi.fn((c: string, o: string, v: unknown) => {
                currentWheres.push([c, o, v]);
                return buildExecute();
              }),
              executeTakeFirst: vi.fn(async () => {
                selects.push({ table, where: [...currentWheres] });
                // Check if a step row exists
                if (table === 'execution_steps' && currentWheres.length >= 3) {
                  const runId = currentWheres.find((w) => w[0] === 'run_id')?.[2];
                  const jobId = currentWheres.find((w) => w[0] === 'job_id')?.[2];
                  const stepIndex = currentWheres.find((w) => w[0] === 'step_index')?.[2];
                  const key = `${runId}:${jobId}:${stepIndex}`;
                  return stepRows.get(key) ?? undefined;
                }
                // findSyntheticJobId fallback: match (run_id, job_name, job_id LIKE)
                if (table === 'execution_jobs') {
                  const runId = currentWheres.find((w) => w[0] === 'run_id')?.[2];
                  const jobName = currentWheres.find((w) => w[0] === 'job_name')?.[2];
                  const likeClause = currentWheres.find(
                    (w) => w[0] === 'job_id' && w[1] === 'like',
                  );
                  const prefix =
                    typeof likeClause?.[2] === 'string'
                      ? likeClause[2].replace(/%$/, '')
                      : undefined;
                  if (runId && jobName && prefix) {
                    for (const [, row] of jobRows) {
                      if (row.job_name === jobName && row.job_id?.startsWith(prefix)) {
                        return { job_id: row.job_id };
                      }
                    }
                  }
                  return undefined;
                }
                // Rehydration path: return the tracked run row so recovery sees
                // the status the DB actually holds.
                if (table === 'execution_runs') {
                  const runId = currentWheres.find((w) => w[0] === 'run_id')?.[2];
                  const row = runId ? runRows.get(String(runId)) : undefined;
                  if (!row) return undefined;
                  return {
                    status: row.status,
                    workflow_name: 'wf',
                    provider: 'github',
                    repo_identifier: 'org/repo',
                    sha: 'deadbeef',
                    ref: 'refs/heads/main',
                    routing_key: 'github:1',
                    provider_context: {},
                    started_at: new Date(),
                    parent_run_id: null,
                    original_run_id: null,
                    triggered_by: null,
                    triggered_by_agent_label: null,
                    trigger_actor_username: null,
                    trigger_actor_user_id: null,
                    check_mode: null,
                    local_working_tree: false,
                  };
                }
                return undefined;
              }),
            });
            return buildExecute();
          }),
        })),
      };
    }),

    deleteFrom: vi.fn((table: string) => {
      currentWheres = [];
      const buildWhere = () => ({
        where: vi.fn((col: string, op: string, val: unknown) => {
          currentWheres.push([col, op, val]);
          return buildWhere();
        }),
        execute: vi.fn(async () => {
          deletes.push({ table, where: [...currentWheres] });
          // Keep jobRows in sync so findSyntheticJobId's DB fallback doesn't
          // return rows that have been deleted.
          if (table === 'execution_jobs') {
            const runId = currentWheres.find((w) => w[0] === 'run_id')?.[2];
            const jobId = currentWheres.find((w) => w[0] === 'job_id')?.[2];
            if (runId && jobId) {
              jobRows.delete(`${runId}:${jobId}`);
            }
          }
          return [];
        }),
      });
      return buildWhere();
    }),
  };

  return {
    db: db as unknown as ExecutionTrackerDeps['db'],
    inserts,
    updates,
    deletes,
    selects,
    stepRows,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ExecutionTracker', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let tracker: ExecutionTracker;
  let onExecutionComplete: ReturnType<typeof vi.fn>;
  let onStepStatusForward: ReturnType<typeof vi.fn>;
  let onWorkflowComplete: ReturnType<typeof vi.fn>;
  let onJobComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDb = createMockDb();
    onExecutionComplete = vi.fn();
    onStepStatusForward = vi.fn();
    onWorkflowComplete = vi.fn();
    onJobComplete = vi.fn();
    tracker = new ExecutionTracker({
      db: mockDb.db,
      onExecutionComplete,
      onStepStatusForward,
      onWorkflowComplete,
      onJobComplete,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseJobs = [
    { jobId: 'job-1', jobName: 'test' },
    { jobId: 'job-2', jobName: 'build' },
  ];

  describe('onExecutionStarted', () => {
    it('inserts execution_runs row in DB', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        { installationId: 42 },
        { matched: true },
        baseJobs,
      );

      const runInsert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(runInsert).toBeDefined();
      expect(runInsert!.values.run_id).toBe('run-1');
      expect(runInsert!.values.workflow_name).toBe('ci');
      expect(runInsert!.values.provider).toBe('github');
      expect(runInsert!.values.repo_identifier).toBe('owner/repo');
      expect(runInsert!.values.ref).toBe('refs/heads/main');
      expect(runInsert!.values.sha).toBe('abc123');
      expect(runInsert!.values.delivery_id).toBe('delivery-1');
      expect(runInsert!.values.provider_context).toBe('{"installationId":42}');
      expect(runInsert!.values.trigger_decision).toBe('{"matched":true}');
    });

    it('populates execution_runs.customer_id from the injected resolveOrgId', async () => {
      const seen: string[] = [];
      const t = new ExecutionTracker({
        db: mockDb.db,
        resolveOrgId: async (rk: string) => {
          seen.push(rk);
          return rk === 'generic:org-a:s1' ? 'org-a' : '__default__';
        },
      });
      await t.onExecutionStarted(
        'run-org',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        'generic:org-a:s1', // routingKey
      );
      const runInsert = mockDb.inserts.find(
        (i) => i.table === 'execution_runs' && i.values.run_id === 'run-org',
      );
      expect(runInsert!.values.customer_id).toBe('org-a');
      expect(seen).toContain('generic:org-a:s1');
    });

    it('falls back to __default__ customer_id when routingKey is undefined', async () => {
      const t = new ExecutionTracker({
        db: mockDb.db,
        resolveOrgId: async () => {
          throw new Error('resolveOrgId must not be called for a null routing key');
        },
      });
      await t.onExecutionStarted(
        'run-nokey',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        undefined, // routingKey
      );
      const runInsert = mockDb.inserts.find(
        (i) => i.table === 'execution_runs' && i.values.run_id === 'run-nokey',
      );
      expect(runInsert!.values.customer_id).toBe('__default__');
    });

    it('falls back to __default__ customer_id when no resolver is injected', async () => {
      // The default `tracker` (beforeEach) has no resolveOrgId dep.
      await tracker.onExecutionStarted(
        'run-noresolver',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        'generic:org-a:s1', // routingKey present, but no resolver wired
      );
      const runInsert = mockDb.inserts.find(
        (i) => i.table === 'execution_runs' && i.values.run_id === 'run-noresolver',
      );
      expect(runInsert!.values.customer_id).toBe('__default__');
    });

    it('persists workflow_timeout_ms when provided', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        undefined, // routingKey
        undefined, // dispatchedContexts
        undefined, // triggerEvent
        undefined, // commitMessage
        undefined, // parentRunId
        undefined, // triggeredBy
        undefined, // originalRunId
        undefined, // concurrency
        1_800_000, // workflowTimeoutMs
      );

      const runInsert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(runInsert).toBeDefined();
      expect(runInsert!.values.workflow_timeout_ms).toBe(1_800_000);
    });

    it('omits workflow_timeout_ms when not provided', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
      );

      const runInsert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(runInsert).toBeDefined();
      expect(runInsert!.values).not.toHaveProperty('workflow_timeout_ms');
    });

    it('persists check_mode when provided', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        undefined, // routingKey
        undefined, // dispatchedContexts
        undefined, // triggerEvent
        undefined, // commitMessage
        undefined, // parentRunId
        undefined, // triggeredBy
        undefined, // originalRunId
        undefined, // concurrency
        undefined, // workflowTimeoutMs
        'check', // checkMode
      );

      const runInsert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(runInsert!.values.check_mode).toBe('check');
    });

    it('omits check_mode when not provided', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
      );

      const runInsert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(runInsert!.values).not.toHaveProperty('check_mode');
    });

    it('onExecutionStarted persists the trigger actor into the run insert + context', async () => {
      const onExecutionStatusChange = vi.fn();
      const t = new ExecutionTracker({ db: mockDb.db as any, onExecutionStatusChange });
      await t.onExecutionStarted(
        'run-actor',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
        undefined, // routingKey
        undefined, // dispatchedContexts
        undefined, // triggerEvent
        undefined, // commitMessage
        undefined, // parentRunId
        undefined, // triggeredBy
        undefined, // originalRunId
        undefined, // concurrency
        undefined, // workflowTimeoutMs
        undefined, // checkMode
        undefined, // localWorkingTree
        'octocat', // triggerActorUsername
        '583231', // triggerActorUserId
      );

      const runInsert = mockDb.inserts.find(
        (i) => i.table === 'execution_runs' && i.values.run_id === 'run-actor',
      );
      expect(runInsert!.values.trigger_actor_provider).toBe('github');
      expect(runInsert!.values.trigger_actor_username).toBe('octocat');
      expect(runInsert!.values.trigger_actor_user_id).toBe('583231');

      const ctx = t.getExecutionContext('run-actor');
      expect(ctx?.triggerActorUsername).toBe('octocat');
      expect(ctx?.triggerActorUserId).toBe('583231');
    });

    it('getRunIdForJob maps a dispatched jobId back to its owning run', async () => {
      await tracker.onExecutionStarted(
        'run-emit',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        {},
        null,
        baseJobs,
      );

      // Both dispatched jobs resolve to the owning run (the agent's event.emit
      // is job-scoped; this is what lets the run-keyed context resolve).
      expect(tracker.getRunIdForJob('job-1')).toBe('run-emit');
      expect(tracker.getRunIdForJob('job-2')).toBe('run-emit');
      // Unknown jobId → undefined (handler returns 'Unknown job context').
      expect(tracker.getRunIdForJob('job-missing')).toBeUndefined();
    });

    it('inserts execution_jobs rows in DB', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        null,
        {},
        null,
        baseJobs,
      );

      const jobInserts = mockDb.inserts.filter((i) => i.table === 'execution_jobs');
      expect(jobInserts).toHaveLength(2);
      expect(jobInserts[0].values.run_id).toBe('run-1');
      expect(jobInserts[0].values.job_id).toBe('job-1');
      expect(jobInserts[0].values.job_name).toBe('test');
      expect(jobInserts[1].values.job_id).toBe('job-2');
      expect(jobInserts[1].values.job_name).toBe('build');
    });

    it('handles jobs with matrix values', async () => {
      const matrixJobs = [
        { jobId: 'job-1', jobName: 'test[node-18]', matrixValues: { node: '18' } },
      ];

      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        null,
        {},
        null,
        matrixJobs,
      );

      const jobInsert = mockDb.inserts.find((i) => i.table === 'execution_jobs');
      expect(jobInsert!.values.matrix_values).toBe('{"node":"18"}');
    });

    it('handles empty jobs array', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        null,
        {},
        null,
        [],
      );

      const jobInserts = mockDb.inserts.filter((i) => i.table === 'execution_jobs');
      expect(jobInserts).toHaveLength(0);
    });
  });

  describe('onJobStatus', () => {
    it('updates job status in DB', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        Date.now(),
        'agent-1',
      );

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'running',
      );
      expect(update).toBeDefined();
      expect(update!.values.agent_id).toBe('agent-1');
      expect(update!.values.started_at).toBeDefined();
    });

    it('sets completed_at on terminal state', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'success',
      );
      expect(update).toBeDefined();
      expect(update!.values.completed_at).toBeDefined();
    });

    it('stores error message from data on failure', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.failed,
        Date.now(),
        undefined,
        {
          error: 'Build failed',
        },
      );

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'failed',
      );
      expect(update!.values.error_message).toBe('Build failed');
    });

    it('does not overwrite started_at on subsequent running messages (build job progress)', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: '__build__hello-world' }],
      );

      const firstRunning = 1000000;
      await tracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        firstRunning,
        'agent-1',
      );

      // Intermediate running messages (deps_installed, bundle_compiled)
      const secondRunning = firstRunning + 4000;
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, secondRunning);

      const thirdRunning = firstRunning + 5000;
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, thirdRunning);

      // Job completes
      const completionTime = firstRunning + 5010;
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, completionTime);

      // DB: started_at should be from the FIRST running message, not the last
      const runningUpdates = mockDb.updates.filter(
        (u) => u.table === 'execution_jobs' && u.values.status === 'running',
      );
      // Only the first running message should set started_at
      const updatesWithStartedAt = runningUpdates.filter((u) => u.values.started_at);
      expect(updatesWithStartedAt).toHaveLength(1);
      expect(updatesWithStartedAt[0].values.started_at).toEqual(new Date(firstRunning));

      // Subsequent running messages should still update last_heartbeat_at
      expect(runningUpdates.length).toBe(3);
      for (const u of runningUpdates) {
        expect(u.values.last_heartbeat_at).toBeDefined();
      }

      // Completion duration should be from first running to completion
      const successUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'success',
      );
      expect(successUpdate!.values.duration_ms).toBe(5010);
    });

    it('forwards startedAt to onJobStatusChange only on first running', async () => {
      const onJobStatusChange = vi.fn();
      const statusTracker = new ExecutionTracker({
        db: mockDb.db,
        onJobStatusChange,
      });

      await statusTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: '__build__hello-world' }],
      );

      const firstRunning = 1000000;
      await statusTracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        firstRunning,
        'agent-1',
      );
      // First running: startedAt should be sent
      expect(onJobStatusChange).toHaveBeenLastCalledWith(
        'run-1',
        'job-1',
        '__build__hello-world',
        'running',
        firstRunning,
        firstRunning, // startedAt
        undefined,
        undefined,
        undefined, // errorMessage
        'agent-1', // agentId
        undefined, // runsOnLabels
        undefined, // logBytes (only set on terminal)
        undefined, // initFailure (only set on synthetic rejected-*/init-failed-* jobs)
        undefined, // contexts (only set for multi-context jobs)
      );

      const secondRunning = firstRunning + 4000;
      await statusTracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        secondRunning,
      );
      // Second running: startedAt should NOT be sent (undefined)
      expect(onJobStatusChange).toHaveBeenLastCalledWith(
        'run-1',
        'job-1',
        '__build__hello-world',
        'running',
        secondRunning,
        undefined, // startedAt NOT sent on subsequent running
        undefined,
        undefined,
        undefined, // errorMessage
        'agent-1', // agentId (set from first running call)
        undefined, // runsOnLabels
        undefined, // logBytes (only set on terminal)
        undefined, // initFailure (only set on synthetic rejected-*/init-failed-* jobs)
        undefined, // contexts (only set for multi-context jobs)
      );
    });

    it('stores duration_ms based on job start time (not run start)', async () => {
      const runStart = Date.now();

      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      // Job starts 2 seconds after run
      const jobStart = runStart + 2000;
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, jobStart);

      // Job completes 5 seconds after job start
      const jobEnd = jobStart + 5000;
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, jobEnd);

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'success',
      );
      expect(update).toBeDefined();
      // duration should be jobEnd - jobStart (5000ms), not jobEnd - runStart (7000ms)
      expect(update!.values.duration_ms).toBe(5000);
    });
  });

  describe('log_bytes aggregation (operator-side capacity-planning gauge)', () => {
    it('accumulates per-step bytes into execution_jobs.log_bytes on job-terminal', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      // Two terminal step events with logBytesStreamed.
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'step-a',
        ExecutionStepStatus.enum.success,
        Date.now(),
        undefined,
        1500,
      );
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        1,
        'step-b',
        ExecutionStepStatus.enum.failed,
        Date.now(),
        undefined,
        500,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const jobUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'success',
      );
      expect(jobUpdate?.values.log_bytes).toBe(2000);
    });

    it('writes summed run total into execution_runs.log_bytes on run-terminal', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [
          { jobId: 'job-1', jobName: 'a' },
          { jobId: 'job-2', jobName: 'b' },
        ],
      );

      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'step-a',
        ExecutionStepStatus.enum.success,
        Date.now(),
        undefined,
        100,
      );
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      await tracker.onStepStatus(
        'run-1',
        'job-2',
        0,
        'step-b',
        ExecutionStepStatus.enum.success,
        Date.now(),
        undefined,
        250,
      );
      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.success, Date.now());

      const runUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.status === 'success',
      );
      expect(runUpdate?.values.log_bytes).toBe(350);
    });

    it('forwards logBytes to onJobStatusChange + onExecutionStatusChange on terminal states', async () => {
      const onJobStatusChange = vi.fn();
      const onExecutionStatusChange = vi.fn();
      const t = new ExecutionTracker({
        db: mockDb.db,
        onJobStatusChange,
        onExecutionStatusChange,
      });

      await t.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'a' }],
      );
      await t.onStepStatus(
        'run-1',
        'job-1',
        0,
        'step-a',
        ExecutionStepStatus.enum.success,
        Date.now(),
        undefined,
        4096,
      );
      await t.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const lastJobCall = onJobStatusChange.mock.calls.at(-1)!;
      // logBytes is index 11 (the 12th positional arg); initFailure is index 12.
      expect(lastJobCall[11]).toBe(4096);

      const lastRunCall = onExecutionStatusChange.mock.calls.at(-1)!;
      // logBytes is index 8 (the 9th positional arg); initFailure (index 9) is
      // not passed by finalizeRunCompletion so it isn't present in mock.calls.
      expect(lastRunCall[8]).toBe(4096);
    });

    it('defaults log_bytes to 0 when no agent telemetry was reported', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'a' }],
      );
      // Job goes terminal without any onStepStatus(logBytesStreamed=…) call.
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const jobUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_jobs' && u.values.status === 'success',
      );
      expect(jobUpdate?.values.log_bytes).toBe(0);

      const runUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.status === 'success',
      );
      expect(runUpdate?.values.log_bytes).toBe(0);
    });
  });

  describe('run completion detection', () => {
    it('detects completion when all jobs are terminal', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      expect(tracker.isRunComplete('run-1')).toBe(false);

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());
      expect(tracker.isRunComplete('run-1')).toBe(false);

      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.success, Date.now());
      expect(tracker.isRunComplete('run-1')).toBe(true);
    });

    it('returns false for unknown run', () => {
      expect(tracker.isRunComplete('unknown')).toBe(false);
    });
  });

  describe('overall status logic', () => {
    async function setupAndCompleteRun(states: string[]): Promise<void> {
      const jobs = states.map((_, i) => ({
        jobId: `job-${i}`,
        jobName: `job${i}`,
      }));

      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        jobs,
      );

      for (let i = 0; i < states.length; i++) {
        await tracker.onJobStatus('run-1', `job-${i}`, states[i], Date.now());
      }
    }

    it('all success -> success', async () => {
      await setupAndCompleteRun(['success', 'success']);
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.success);
    });

    it('any failed -> failed', async () => {
      await setupAndCompleteRun(['success', 'failed']);
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.failed);
    });

    it('any cancelled (no failed) -> cancelled', async () => {
      await setupAndCompleteRun(['success', 'cancelled']);
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.cancelled);
    });

    it('failed takes precedence over cancelled', async () => {
      await setupAndCompleteRun(['failed', 'cancelled']);
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.failed);
    });

    /** Start a single-job run in the given check mode, report a step, complete the job. */
    async function setupCheckModeRun(checkMode: string, stepCheckOutcome: string): Promise<void> {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'deploy' }],
        undefined, // routingKey
        undefined, // dispatchedContexts
        undefined, // triggerEvent
        undefined, // commitMessage
        undefined, // parentRunId
        undefined, // triggeredBy
        undefined, // originalRunId
        undefined, // concurrency
        undefined, // workflowTimeoutMs
        checkMode,
      );
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'cfg',
        ExecutionStepStatus.enum.success,
        Date.now(),
        { durationMs: 5, checkOutcome: stepCheckOutcome },
      );
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());
    }

    it('check-fail-on-drift with a dry-run step -> failed', async () => {
      await setupCheckModeRun('check-fail-on-drift', 'dry-run');
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.failed);
    });

    it('plain check with a dry-run step -> success (report-only)', async () => {
      await setupCheckModeRun('check', 'dry-run');
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.success);
    });

    it('check-fail-on-drift with no drift (applied) -> success', async () => {
      await setupCheckModeRun('check-fail-on-drift', 'applied');
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.success);
    });

    it('returns running for incomplete run', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());
      // job-2 still pending
      expect(tracker.getRunStatus('run-1')).toBe(ExecutionRunStatus.enum.running);
    });

    it('returns running for unknown run', () => {
      expect(tracker.getRunStatus('unknown')).toBe(ExecutionRunStatus.enum.running);
    });

    it('preserves a stamped failure_reason when a cancelled run completes', async () => {
      // A cancelled run carries a reason stamped earlier by the cancel path
      // (e.g. the workflow_timeout reason from cancelRunWithReason). The
      // run-completion UPDATE must NOT clobber it to null — the dashboard reads
      // failure_reason to label the run "timed out".
      await setupAndCompleteRun(['success', 'cancelled']);
      const runCompletionUpdate = mockDb.updates.find(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.status === ExecutionRunStatus.enum.cancelled &&
          u.values.completed_at !== undefined,
      );
      expect(runCompletionUpdate).toBeDefined();
      // failure_reason is OMITTED from the update for a cancelled run with no
      // newly-computed reason, leaving any stamped reason intact.
      expect('failure_reason' in runCompletionUpdate!.values).toBe(false);
    });

    it('clears stale failure_reason when a run completes successfully', async () => {
      await setupAndCompleteRun(['success', 'success']);
      const runCompletionUpdate = mockDb.updates.find(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.status === ExecutionRunStatus.enum.success &&
          u.values.completed_at !== undefined,
      );
      expect(runCompletionUpdate).toBeDefined();
      // On success the column is explicitly set to null to drop any stale
      // premature-fail reason.
      expect(runCompletionUpdate!.values.failure_reason).toBeNull();
    });
  });

  describe('failure_class derivation + forwarding', () => {
    async function completeSingleJobRun(
      jobStatus: string,
      onStatusChange: ReturnType<typeof vi.fn>,
      onWf: ReturnType<typeof vi.fn>,
    ): Promise<void> {
      const t = new ExecutionTracker({
        db: mockDb.db,
        onExecutionStatusChange: onStatusChange,
        onWorkflowComplete: onWf,
      });
      await t.onExecutionStarted(
        'run-fc',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );
      await t.onJobStatus('run-fc', 'job-1', jobStatus, Date.now());
    }

    function terminalRunUpdate(): Record<string, unknown> | undefined {
      return mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.completed_at !== undefined,
      )?.values;
    }

    it('a failed job stamps step_failure on the run row and forwards it', async () => {
      const onStatusChange = vi.fn();
      const onWf = vi.fn();
      await completeSingleJobRun(ExecutionJobStatus.enum.failed, onStatusChange, onWf);
      expect(terminalRunUpdate()!.failure_class).toBe(RunFailureClass.enum.step_failure);
      expect(onStatusChange.mock.calls.at(-1)![2].failureClass).toBe(
        RunFailureClass.enum.step_failure,
      );
      expect(onWf).toHaveBeenCalledWith(
        expect.objectContaining({ failureClass: RunFailureClass.enum.step_failure }),
      );
    });

    it('a timed_out_stale job stamps timed_out (infra class)', async () => {
      const onStatusChange = vi.fn();
      const onWf = vi.fn();
      await completeSingleJobRun(ExecutionJobStatus.enum.timed_out_stale, onStatusChange, onWf);
      expect(terminalRunUpdate()!.failure_class).toBe(RunFailureClass.enum.timed_out);
      expect(onWf).toHaveBeenCalledWith(
        expect.objectContaining({ failureClass: RunFailureClass.enum.timed_out }),
      );
    });

    it('a cancelled run stamps cancelled', async () => {
      const onStatusChange = vi.fn();
      const onWf = vi.fn();
      await completeSingleJobRun(ExecutionJobStatus.enum.cancelled, onStatusChange, onWf);
      expect(terminalRunUpdate()!.failure_class).toBe(RunFailureClass.enum.cancelled);
    });

    it('a successful run stamps null and omits failureClass from the workflow event', async () => {
      const onStatusChange = vi.fn();
      const onWf = vi.fn();
      await completeSingleJobRun(ExecutionJobStatus.enum.success, onStatusChange, onWf);
      expect(terminalRunUpdate()!.failure_class).toBeNull();
      expect(onWf.mock.calls.at(-1)![0].failureClass).toBeUndefined();
    });

    it('failRun stamps never_started on the row, the status context, and the workflow event', async () => {
      const onStatusChange = vi.fn();
      const onWf = vi.fn();
      const t = new ExecutionTracker({
        db: mockDb.db,
        onExecutionStatusChange: onStatusChange,
        onWorkflowComplete: onWf,
      });
      await t.onExecutionStarted(
        'run-if',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );
      await t.failRun('run-if', 'No agents available', {
        scope: 'run',
        category: InitFailureCategory.enum.no_agent,
        message: 'No agents available',
      });
      const failUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.failure_class !== undefined,
      );
      expect(failUpdate!.values.failure_class).toBe(RunFailureClass.enum.never_started);
      expect(onStatusChange.mock.calls.at(-1)![2].failureClass).toBe(
        RunFailureClass.enum.never_started,
      );
      expect(onWf).toHaveBeenCalledWith(
        expect.objectContaining({ failureClass: RunFailureClass.enum.never_started }),
      );
    });

    it('recordInitFailureRun stamps never_started on the inserted row and forward context', async () => {
      const onStatusChange = vi.fn();
      const t = new ExecutionTracker({ db: mockDb.db, onExecutionStatusChange: onStatusChange });
      await t.recordInitFailureRun({
        runId: 'run-init',
        workflowName: 'ci',
        provider: 'github',
        repoIdentifier: 'owner/repo',
        ref: 'main',
        sha: 'abc',
        deliveryId: null,
        providerContext: {},
        routingKey: 'rk',
        initFailure: {
          scope: 'run',
          category: InitFailureCategory.enum.secret_resolution,
          message: 'secret missing',
        },
      });
      const insert = mockDb.inserts.find((i) => i.table === 'execution_runs');
      expect(insert!.values.failure_class).toBe(RunFailureClass.enum.never_started);
      expect(onStatusChange.mock.calls.at(-1)![2].failureClass).toBe(
        RunFailureClass.enum.never_started,
      );
    });
  });

  describe('onExecutionComplete callback', () => {
    it('fires on completion with correct status, context, and no description for success', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        { installationId: 42 },
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-1',
        'success',
        {
          workflowName: 'ci',
          provider: 'github',
          repoIdentifier: 'owner/repo',
          sha: 'abc',
          installationId: 42,
        },
        undefined,
      );
    });

    it('finalizes a run at most once', async () => {
      // Finalization stamps `completedAt` but only prunes the in-memory run on
      // a delay, so the run is still tracked afterwards. A late terminal status
      // arriving in that window finds a complete run, and without the
      // `completedAt` guard rolls it up a second time — a duplicate provider
      // check and a second terminal run status forwarded to the Platform.
      await tracker.onExecutionStarted(
        'run-idem',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        { installationId: 42 },
        null,
        [
          { jobId: 'job-1', jobName: 'test' },
          { jobId: 'job-2', jobName: 'lint' },
        ],
      );

      await tracker.onJobStatus('run-idem', 'job-1', ExecutionJobStatus.enum.success, Date.now());
      // Both jobs terminal: the run is finalized exactly here.
      await tracker.onJobStatus('run-idem', 'job-2', ExecutionJobStatus.enum.success, Date.now());
      expect(onExecutionComplete).toHaveBeenCalledTimes(1);

      // A late terminal status for job-1 in a different state, so the job-level
      // replay guard does not absorb it. The run is still in memory.
      await tracker.onJobStatus('run-idem', 'job-1', ExecutionJobStatus.enum.failed, Date.now());

      expect(onExecutionComplete).toHaveBeenCalledTimes(1);
    });

    it('includes failed job names in description for failed runs', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [
          { jobId: 'job-1', jobName: 'lint' },
          { jobId: 'job-2', jobName: 'test' },
          { jobId: 'job-3', jobName: 'build' },
        ],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.failed, Date.now());
      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.success, Date.now());
      await tracker.onJobStatus('run-1', 'job-3', ExecutionJobStatus.enum.failed, Date.now());

      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ workflowName: 'ci' }),
        'Failed jobs: lint, build',
      );
    });

    it('does not fire for non-terminal states', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, Date.now());

      expect(onExecutionComplete).not.toHaveBeenCalled();
    });

    it('updates execution_runs table on completion', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.failed, Date.now());

      const runUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.status === 'failed',
      );
      expect(runUpdate).toBeDefined();
      expect(runUpdate!.values.completed_at).toBeDefined();
      expect(runUpdate!.values.duration_ms).toBeDefined();
    });

    it('receives requestId from RunState captured at execution start', async () => {
      // Start execution inside a requestContext.run() scope (simulating pipeline)
      await requestContext.run({ requestId: 'test-req-id' }, async () => {
        await tracker.onExecutionStarted(
          'run-1',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc',
          null,
          { installationId: 42 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );
      });

      // Complete the job (outside ALS scope -- requestId should come from stored RunState)
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.objectContaining({ requestId: 'test-req-id' }),
        undefined,
      );
    });

    it('receives undefined requestId when execution started without ALS scope', async () => {
      // Start execution without requestContext.run()
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-1',
        'success',
        expect.objectContaining({ requestId: undefined }),
        undefined,
      );
    });

    it('finalizes a run when the last job finishes before its synthetic→real swap', async () => {
      // Reproduces the failure-propagation race: a downstream job dispatched by
      // the needs scheduler (via dispatchReadyJob → addJobsToRun) can report its
      // terminal status BEFORE addJobsToRun swaps the synthetic placeholder for
      // the real job id. Without the re-check in addJobsToRun the run hangs in
      // `running` forever because the early status update saw the synthetic
      // placeholder (still pending) and bailed, and nothing else drives the
      // completion check afterwards.
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [
          { jobId: 'build-id', jobName: 'build' },
          // The scheduler-gated downstream is tracked as a synthetic placeholder
          // until dispatchReadyJob swaps in the real id.
          { jobId: 'needs-pending-cleanup-xyz', jobName: 'cleanup' },
        ],
      );

      // build fails (terminal). Run is not complete: the synthetic cleanup
      // placeholder is still pending.
      await tracker.onJobStatus('run-1', 'build-id', ExecutionJobStatus.enum.failed, Date.now());
      expect(onExecutionComplete).not.toHaveBeenCalled();

      // The dispatched cleanup agent reports success BEFORE the swap lands. This
      // recovers the real cleanup job into the run with status=success, but the
      // synthetic placeholder still blocks completion.
      await tracker.onJobStatus('run-1', 'cleanup-id', ExecutionJobStatus.enum.success, Date.now());
      expect(onExecutionComplete).not.toHaveBeenCalled();

      // dispatchReadyJob finally performs the synthetic→real swap. With the fix,
      // addJobsToRun preserves cleanup's already-arrived `success` (instead of
      // resetting to `pending`) and re-checks completion → run finalizes failed.
      await tracker.addJobsToRun(
        'run-1',
        [{ jobId: 'cleanup-id', jobName: 'cleanup' }],
        undefined,
        'needs-pending-cleanup-xyz',
      );

      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.objectContaining({ workflowName: 'ci' }),
        'Failed jobs: build',
      );
    });
  });

  describe('onStepStatus', () => {
    it('inserts step row for new step', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.running,
        Date.now(),
      );

      const stepInsert = mockDb.inserts.find((i) => i.table === 'execution_steps');
      expect(stepInsert).toBeDefined();
      expect(stepInsert!.values.run_id).toBe('run-1');
      expect(stepInsert!.values.job_id).toBe('job-1');
      expect(stepInsert!.values.step_index).toBe(0);
      expect(stepInsert!.values.step_name).toBe('setup');
      expect(stepInsert!.values.status).toBe(ExecutionStepStatus.enum.running);
      expect(stepInsert!.values.log_path).toBe('executions/run-1/job-test/step-0.log');
      expect(stepInsert!.values.started_at).toBeDefined();
    });

    it('persists check_outcome / drift_summary / drift from step data', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'cfg',
        ExecutionStepStatus.enum.success,
        Date.now(),
        {
          durationMs: 5,
          checkOutcome: 'dry-run',
          driftSummary: 'would rewrite config',
          drift: { want: 'x' },
        },
      );

      const stepRow = [...mockDb.inserts, ...mockDb.updates].find(
        (r) => r.table === 'execution_steps' && r.values.step_name === 'cfg',
      );
      expect(stepRow!.values.check_outcome).toBe('dry-run');
      expect(stepRow!.values.drift_summary).toBe('would rewrite config');
      expect(stepRow!.values.drift).toBe(JSON.stringify({ want: 'x' }));
    });

    it('updates step row for existing step', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      // First call creates the step (inserts into stepRows tracking)
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.running,
        Date.now(),
      );

      // Second call should update
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.success,
        Date.now(),
        {
          exitCode: 0,
          durationMs: 1500,
        },
      );

      const stepUpdate = mockDb.updates.find(
        (u) => u.table === 'execution_steps' && u.values.status === 'success',
      );
      expect(stepUpdate).toBeDefined();
      expect(stepUpdate!.values.completed_at).toBeDefined();
      expect(stepUpdate!.values.exit_code).toBe(0);
      expect(stepUpdate!.values.duration_ms).toBe(1500);
    });

    it('forwards step status to Platform callback', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      const ts = Date.now();
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.running,
        ts,
      );

      expect(onStepStatusForward).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'test',
        0,
        'setup',
        'running',
        ts,
        undefined,
        undefined, // requestId (none set)
      );
    });

    it('forwards requestId from RunState to step status callback', async () => {
      await requestContext.run({ requestId: 'step-req-id' }, async () => {
        await tracker.onExecutionStarted(
          'run-1',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc',
          null,
          {},
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );
      });

      const ts = Date.now();
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.running,
        ts,
      );

      expect(onStepStatusForward).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'test',
        0,
        'setup',
        'running',
        ts,
        undefined,
        'step-req-id', // requestId from stored RunState
      );
    });

    it('constructs correct log path using job name', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'my-build' }],
      );

      await tracker.onStepStatus(
        'run-1',
        'job-1',
        2,
        'compile',
        ExecutionStepStatus.enum.running,
        Date.now(),
      );

      const stepInsert = mockDb.inserts.find((i) => i.table === 'execution_steps');
      expect(stepInsert!.values.log_path).toBe('executions/run-1/job-my-build/step-2.log');
    });

    it('falls back to jobId when job name is unknown', async () => {
      // No onExecutionStarted -- job name is unknown
      await tracker.onStepStatus(
        'run-1',
        'job-1',
        0,
        'setup',
        ExecutionStepStatus.enum.running,
        Date.now(),
      );

      const stepInsert = mockDb.inserts.find((i) => i.table === 'execution_steps');
      expect(stepInsert!.values.log_path).toBe('executions/run-1/job-job-1/step-0.log');
    });
  });

  describe('getJobName', () => {
    it('returns job name from in-memory state', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      expect(tracker.getJobName('run-1', 'job-1')).toBe('test');
    });

    it('returns undefined for unknown run', () => {
      expect(tracker.getJobName('unknown', 'job-1')).toBeUndefined();
    });

    it('returns undefined for unknown job', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      expect(tracker.getJobName('run-1', 'unknown')).toBeUndefined();
    });
  });

  describe('getExecutionContext', () => {
    it('returns execution context from in-memory state', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc123',
        null,
        { installationId: 42 },
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      const ctx = tracker.getExecutionContext('run-1');
      expect(ctx).toEqual({
        workflowName: 'ci',
        provider: 'github',
        repoIdentifier: 'owner/repo',
        sha: 'abc123',
        installationId: 42,
      });
    });

    it('returns undefined for unknown run', () => {
      expect(tracker.getExecutionContext('unknown')).toBeUndefined();
    });

    it('returns context without installationId when not provided', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      const ctx = tracker.getExecutionContext('run-1');
      expect(ctx).toBeDefined();
      expect(ctx!.installationId).toBeUndefined();
    });
  });

  describe('memory pruning', () => {
    it('removes completed run from memory after 5 minutes', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      // Should still be in memory right after completion
      expect(tracker.getJobName('run-1', 'job-1')).toBe('test');

      // Advance past prune delay (5 min)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Should be pruned
      expect(tracker.getJobName('run-1', 'job-1')).toBeUndefined();
    });
  });

  describe('onWorkflowComplete callback', () => {
    it('fires with correct data when run reaches terminal state (all success)', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
        'github:42',
      );

      const t1 = Date.now();
      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, t1);
      expect(onWorkflowComplete).not.toHaveBeenCalled();

      const t2 = t1 + 5000;
      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.success, t2);

      expect(onWorkflowComplete).toHaveBeenCalledOnce();
      const data = onWorkflowComplete.mock.calls[0][0];
      expect(data.runId).toBe('run-1');
      expect(data.workflowName).toBe('ci');
      expect(data.status).toBe(ExecutionRunStatus.enum.success);
      expect(data.duration).toBeGreaterThanOrEqual(0);
      expect(data.repo).toBe('owner/repo');
      expect(data.routingKey).toBe('github:42');
      expect(data.jobResults).toEqual([
        { name: 'test', status: ExecutionJobStatus.enum.success },
        { name: 'build', status: ExecutionJobStatus.enum.success },
      ]);
    });

    it('fires with failed status when a job fails', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'deploy',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.failed, Date.now());
      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.success, Date.now());

      expect(onWorkflowComplete).toHaveBeenCalledOnce();
      const data = onWorkflowComplete.mock.calls[0][0];
      expect(data.status).toBe(ExecutionRunStatus.enum.failed);
      expect(data.jobResults).toEqual([
        { name: 'test', status: ExecutionJobStatus.enum.failed },
        { name: 'build', status: ExecutionJobStatus.enum.success },
      ]);
    });

    it('does not fire until all jobs are terminal', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, Date.now());
      expect(onWorkflowComplete).not.toHaveBeenCalled();

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());
      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });
  });

  describe('onJobComplete callback', () => {
    it('fires with correct data when a job reaches terminal state', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
        'github:42',
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      expect(onJobComplete).toHaveBeenCalledOnce();
      const data = onJobComplete.mock.calls[0][0];
      expect(data.runId).toBe('run-1');
      expect(data.jobId).toBe('job-1');
      expect(data.jobName).toBe('test');
      expect(data.status).toBe(ExecutionRunStatus.enum.success);
      expect(data.routingKey).toBe('github:42');
      expect(data.repo).toBe('owner/repo');
      expect(data.workflowName).toBe('ci');
    });

    it('fires with failed status', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.failed, Date.now());

      expect(onJobComplete).toHaveBeenCalledOnce();
      expect(onJobComplete.mock.calls[0][0].status).toBe(ExecutionRunStatus.enum.failed);
    });

    it('fires for an orchestrator-set skipped job, carrying the status payload', async () => {
      // The check run is completed from this hook, so a job the orchestrator
      // itself ends (a needs-scheduler skip — no agent message involved) must
      // reach it, or its check run stays queued forever on the commit.
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
        'github:42',
      );

      await tracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.skipped,
        Date.now(),
        undefined,
        { error: 'needs not satisfied' },
      );

      expect(onJobComplete).toHaveBeenCalledOnce();
      const data = onJobComplete.mock.calls[0][0];
      expect(data.status).toBe(ExecutionJobStatus.enum.skipped);
      expect(data.jobName).toBe('test');
      expect(data.data).toMatchObject({ error: 'needs not satisfied' });
    });

    it('fires for a drift-dropped job', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await tracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.drift_dropped,
        Date.now(),
      );

      expect(onJobComplete).toHaveBeenCalledOnce();
      expect(onJobComplete.mock.calls[0][0].status).toBe(ExecutionJobStatus.enum.drift_dropped);
    });

    it('fires independently for each job', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());
      expect(onJobComplete).toHaveBeenCalledTimes(1);
      expect(onJobComplete.mock.calls[0][0].jobName).toBe('test');

      await tracker.onJobStatus('run-1', 'job-2', ExecutionJobStatus.enum.failed, Date.now());
      expect(onJobComplete).toHaveBeenCalledTimes(2);
      expect(onJobComplete.mock.calls[1][0].jobName).toBe('build');
    });

    it('does not fire for non-terminal states', async () => {
      await tracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        baseJobs,
      );

      await tracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, Date.now());
      expect(onJobComplete).not.toHaveBeenCalled();
    });
  });

  describe('callbacks are optional', () => {
    it('omitting onWorkflowComplete and onJobComplete causes no errors', async () => {
      // Create tracker WITHOUT the new callbacks
      const minimalTracker = new ExecutionTracker({
        db: mockDb.db,
        onExecutionComplete,
      });

      await minimalTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      // Should not throw even without callbacks
      await minimalTracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.success,
        Date.now(),
      );

      // onExecutionComplete should still fire
      expect(onExecutionComplete).toHaveBeenCalledOnce();
    });
  });

  describe('run.event emission', () => {
    let onRunEventEmit: ReturnType<typeof vi.fn>;
    let eventTracker: ExecutionTracker;

    beforeEach(() => {
      onRunEventEmit = vi.fn();
      eventTracker = new ExecutionTracker({
        db: mockDb.db,
        onRunEventEmit,
        orgId: 'org-1',
      });
    });

    it('emits orchestrator.dispatch on execution started', async () => {
      await eventTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
        undefined,
        undefined,
        'push',
      );

      // SECURITY: orgId is intentionally absent from emitted run.event
      // payloads (see docs/architecture/security/ws-tenant-isolation.md).
      // Tenant attribution comes from authState.orgId on the Platform side.
      expect(onRunEventEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          eventType: 'orchestrator.dispatch',
          sourceService: 'orchestrator',
          metadata: { workflowName: 'ci', triggerType: 'push' },
        }),
      );
      const emittedEvent = onRunEventEmit.mock.calls[0][0] as Record<string, unknown>;
      expect(emittedEvent).not.toHaveProperty('orgId');
    });

    it('emits orchestrator.job.started on job running', async () => {
      await eventTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await eventTracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        Date.now(),
        'agent-1',
      );

      const events = onRunEventEmit.mock.calls.map(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType,
      );
      expect(events).toContain('orchestrator.agent.assigned');
      expect(events).toContain('orchestrator.job.started');
    });

    it('emits orchestrator.job.completed on terminal state', async () => {
      await eventTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await eventTracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, Date.now());
      await eventTracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const events = onRunEventEmit.mock.calls.map(
        (c: unknown[]) => (c[0] as { eventType: string }).eventType,
      );
      expect(events).toContain('orchestrator.job.completed');
    });

    it('does not emit when orgId is not configured', async () => {
      const noOrgTracker = new ExecutionTracker({
        db: mockDb.db,
        onRunEventEmit,
        // No orgId
      });

      await noOrgTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      expect(onRunEventEmit).not.toHaveBeenCalled();
    });
  });

  describe('orchestration log writing', () => {
    let mockLogStorage: {
      append: ReturnType<typeof vi.fn>;
      read: ReturnType<typeof vi.fn>;
      exists: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
    };
    let logTracker: ExecutionTracker;

    beforeEach(() => {
      mockLogStorage = {
        append: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue({ data: '', cursor: 0, complete: true }),
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockResolvedValue([]),
      };
      logTracker = new ExecutionTracker({
        db: mockDb.db,
        logStorage: mockLogStorage,
        orgId: 'org-1',
      });
    });

    it('writes dispatch log on execution started', async () => {
      await logTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      expect(mockLogStorage.append).toHaveBeenCalledWith(
        'executions/run-1/jobs/job-1/orchestration.jsonl',
        expect.stringContaining('"phase":"dispatch"'),
      );
    });

    it('writes setup log on job started', async () => {
      await logTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await logTracker.onJobStatus(
        'run-1',
        'job-1',
        ExecutionJobStatus.enum.running,
        Date.now(),
        'agent-1',
      );

      // Should have dispatch log + agent assigned log + job started log
      const orchLogCalls = mockLogStorage.append.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('orchestration.jsonl'),
      );
      expect(orchLogCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('writes teardown log on job completed', async () => {
      await logTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await logTracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.running, Date.now());
      await logTracker.onJobStatus('run-1', 'job-1', ExecutionJobStatus.enum.success, Date.now());

      const lastCall =
        mockLogStorage.append.mock.calls[mockLogStorage.append.mock.calls.length - 1];
      expect(lastCall[1]).toContain('"phase":"teardown"');
      expect(lastCall[1]).toContain('Job completed with status success');
    });

    it('forwards dispatch orch-log lines to Platform via onOrchLog', async () => {
      const onOrchLog = vi.fn();
      const forwardTracker = new ExecutionTracker({
        db: mockDb.db,
        logStorage: mockLogStorage,
        orgId: 'org-1',
        onOrchLog,
      });

      await forwardTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      // The dispatch write both persists AND forwards the same line.
      expect(onOrchLog).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          jobId: 'job-1',
          phase: 'dispatch',
          lines: ['Job dispatched to queue'],
          ts: expect.any(Number),
        }),
      );
    });

    it('forwards provisioning orch-log lines via onOrchLog on emitScalerEvent', () => {
      const onOrchLog = vi.fn();
      const forwardTracker = new ExecutionTracker({
        db: mockDb.db,
        logStorage: mockLogStorage,
        orgId: 'org-1',
        onOrchLog,
      });

      forwardTracker.emitScalerEvent('run-1', 'job-1', {
        agentId: 'agent-1',
        eventType: ScalerEventType.enum['scaler.provisioning'],
        detail: 'Provisioning container agent',
        timestampMs: 1234,
      });

      expect(onOrchLog).toHaveBeenCalledWith({
        runId: 'run-1',
        jobId: 'job-1',
        phase: 'provisioning',
        lines: ['Provisioning container agent'],
        ts: 1234,
      });
    });

    it('does not forward orch-log lines when orgId is unset', async () => {
      const onOrchLog = vi.fn();
      const noOrgTracker = new ExecutionTracker({
        db: mockDb.db,
        logStorage: mockLogStorage,
        onOrchLog,
      });

      await noOrgTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      expect(onOrchLog).not.toHaveBeenCalled();
    });
  });

  describe('cancelStepsForJob', () => {
    /**
     * Creates a mock DB that supports cancelStepsForJob's query patterns:
     * - selectFrom('execution_steps').select([...]).where(...).where(...).where('status','not in',...).execute()
     * - updateTable('execution_steps').set({...}).where(...).where(...).where('status','not in',...).execute()
     * Plus the standard patterns needed by onExecutionStarted.
     */
    function createCancelStepsMockDb(
      stepRows: Array<{ step_index: number; step_name: string; status: string }>,
    ) {
      const capturedUpdates: Array<{ table: string; values: Record<string, unknown> }> = [];

      const buildWhereChain = (executeFn: () => Promise<unknown>) => {
        const chain: Record<string, unknown> = {};
        chain.where = vi.fn(() => chain);
        chain.execute = vi.fn(executeFn);
        chain.executeTakeFirst = vi.fn(executeFn);
        return chain;
      };

      const db = {
        insertInto: vi.fn(() => ({
          values: vi.fn(() => ({
            execute: vi.fn(async () => []),
            onConflict: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          })),
        })),
        selectFrom: vi.fn(() => ({
          select: vi.fn(() => {
            return buildWhereChain(async () => stepRows);
          }),
        })),
        updateTable: vi.fn((table: string) => ({
          set: vi.fn((vals: Record<string, unknown>) => {
            capturedUpdates.push({ table, values: vals });
            return buildWhereChain(async () => []);
          }),
        })),
      };

      return { db: db as unknown as ExecutionTrackerDeps['db'], capturedUpdates };
    }

    it('updates running steps to cancelled with error_message and completed_at', async () => {
      const runningSteps = [
        { step_index: 0, step_name: 'checkout', status: ExecutionStepStatus.enum.running },
        { step_index: 1, step_name: 'build', status: ExecutionStepStatus.enum.running },
      ];
      const { db, capturedUpdates } = createCancelStepsMockDb(runningSteps);
      const cancelTracker = new ExecutionTracker({ db });

      // Set up in-memory state so getJobName works
      await cancelTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await cancelTracker.cancelStepsForJob('run-1', 'job-1', 'Job stale: no heartbeat');

      // Should have an update to execution_steps with cancelled status
      const stepUpdates = capturedUpdates.filter((u) => u.table === 'execution_steps');
      expect(stepUpdates.length).toBe(1);
      expect(stepUpdates[0].values.status).toBe(ExecutionJobStatus.enum.cancelled);
      expect(stepUpdates[0].values.error_message).toBe('Job stale: no heartbeat');
      expect(stepUpdates[0].values.completed_at).toBeInstanceOf(Date);
    });

    it('leaves already-terminal steps untouched (no steps returned by select)', async () => {
      // Empty array = no non-terminal steps found
      const { db, capturedUpdates } = createCancelStepsMockDb([]);
      const cancelTracker = new ExecutionTracker({ db });

      await cancelTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await cancelTracker.cancelStepsForJob('run-1', 'job-1', 'Job stale');

      // No updates to execution_steps (only execution_runs/execution_jobs from onExecutionStarted)
      const stepUpdates = capturedUpdates.filter((u) => u.table === 'execution_steps');
      expect(stepUpdates.length).toBe(0);
    });

    it('forwards step status to Platform for each affected step', async () => {
      const runningSteps = [
        { step_index: 0, step_name: 'checkout', status: ExecutionStepStatus.enum.running },
        { step_index: 2, step_name: 'deploy', status: ExecutionJobStatus.enum.pending },
      ];
      const { db } = createCancelStepsMockDb(runningSteps);
      const stepForward = vi.fn();
      const cancelTracker = new ExecutionTracker({ db, onStepStatusForward: stepForward });

      await cancelTracker.onExecutionStarted(
        'run-1',
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'test' }],
      );

      await cancelTracker.cancelStepsForJob('run-1', 'job-1', 'Orphan recovery');

      expect(stepForward).toHaveBeenCalledTimes(2);

      // First step
      expect(stepForward).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'test',
        0,
        'checkout',
        'cancelled',
        expect.any(Number),
        { error: 'Orphan recovery' },
        undefined,
      );

      // Second step
      expect(stepForward).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'test',
        2,
        'deploy',
        'cancelled',
        expect.any(Number),
        { error: 'Orphan recovery' },
        undefined,
      );
    });
  });

  describe('completeRunIfAllJobsTerminal', () => {
    it('should complete a run that transitioned through cancelling state', async () => {
      await requestContext.run({ requestId: 'req-cancel', runId: 'run-cancel' }, async () => {
        await tracker.onExecutionStarted(
          'run-cancel',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc123',
          null,
          { installationId: 1 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );

        // Job goes running
        await tracker.onJobStatus(
          'run-cancel',
          'job-1',
          ExecutionJobStatus.enum.running,
          Date.now(),
        );

        // Job reports cancelling (this transitions the run to cancelling in the DB)
        await tracker.onJobStatus(
          'run-cancel',
          'job-1',
          ExecutionJobStatus.enum.cancelling,
          Date.now(),
        );

        // Job reaches terminal cancelled state. Mirror the production cancel
        // path (`cancel/cancel-run.ts`), which marks the remaining job row
        // directly and then asks the tracker to finish the run — going through
        // `onJobStatus` instead would auto-complete the run first, leaving
        // nothing for the call under test to do.
        tracker.updateInMemoryJob('run-cancel', 'job-1', ExecutionJobStatus.enum.cancelled);

        // Now call completeRunIfAllJobsTerminal (stale detector path)
        await tracker.completeRunIfAllJobsTerminal('run-cancel');

        // The DB update for execution_runs should accept both 'running' and 'cancelling'
        const runUpdates = mockDb.updates.filter(
          (u) =>
            u.table === 'execution_runs' &&
            u.values.status !== undefined &&
            u.where.some((w) => w[0] === 'run_id' && w[2] === 'run-cancel') &&
            u.where.some(
              (w) =>
                w[0] === 'status' &&
                w[1] === 'in' &&
                Array.isArray(w[2]) &&
                (w[2] as string[]).includes('cancelling'),
            ),
        );
        // Should have at least one update that matches both 'running' and 'cancelling'
        expect(runUpdates.length).toBeGreaterThan(0);
      });
    });

    it('clears the test-run marker when the stale detector, not the normal path, finishes the run', async () => {
      await requestContext.run({ requestId: 'req-tr', runId: 'run-tr' }, async () => {
        await tracker.onExecutionStarted(
          'run-tr',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc123',
          null,
          { installationId: 1 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );
        tracker.markTestRun('run-tr');
        expect(tracker.isTestRun('run-tr')).toBe(true);

        // Stale-detector flow (see the sibling tests): mutate the in-memory job
        // directly, then ask the tracker to finish the run.
        await tracker.onJobStatus('run-tr', 'job-1', ExecutionJobStatus.enum.running, Date.now());
        tracker.updateInMemoryJob('run-tr', 'job-1', ExecutionJobStatus.enum.timed_out_stale);
        await tracker.completeRunIfAllJobsTerminal('run-tr');

        // The marker survives the grace period — a late status still broadcasts.
        expect(tracker.isTestRun('run-tr')).toBe(true);

        // ...and is dropped with the rest of the run's in-memory state once the
        // prune fires. Without this, a run finished by the stale detector rather
        // than the normal completion path leaks its marker for the process's
        // lifetime.
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        expect(tracker.isTestRun('run-tr')).toBe(false);
      });
    });

    it('stamps the generic stale reason guarded by failure_reason IS NULL on a failed run', async () => {
      await requestContext.run({ requestId: 'req-fail', runId: 'run-fail' }, async () => {
        await tracker.onExecutionStarted(
          'run-fail',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc123',
          null,
          { installationId: 1 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );

        await tracker.onJobStatus('run-fail', 'job-1', ExecutionJobStatus.enum.running, Date.now());
        // Mirror the production stale-detector flow (`stale-run-detector.ts`):
        // it mutates the in-memory job directly and then asks the tracker to
        // finish the run. Routing this through `onJobStatus` would auto-complete
        // the run first, so the call under test would find an already-terminal
        // row and correctly do nothing.
        tracker.updateInMemoryJob('run-fail', 'job-1', ExecutionJobStatus.enum.timed_out_stale);

        await tracker.completeRunIfAllJobsTerminal('run-fail');

        // The failure_reason write is a SEPARATE, clobber-guarded UPDATE: it
        // sets only failure_reason and carries a `failure_reason IS NULL` guard
        // so a more specific cause (e.g. a scaler provisioning error) is never
        // overwritten.
        const guardedReasonUpdates = mockDb.updates.filter(
          (u) =>
            u.table === 'execution_runs' &&
            u.values.status === undefined &&
            u.values.failure_reason ===
              'Run completed via stale detection (no heartbeat received)' &&
            u.where.some((w) => w[0] === 'run_id' && w[2] === 'run-fail') &&
            u.where.some((w) => w[0] === 'failure_reason' && w[1] === 'is' && w[2] === null),
        );
        expect(guardedReasonUpdates.length).toBe(1);

        // The stale-detector status/timing UPDATE (the one carrying the
        // `status IN (pending, running, cancelling)` guard) must NOT also set
        // failure_reason — the generic reason only flows through the guarded
        // write above.
        const staleStatusUpdates = mockDb.updates.filter(
          (u) =>
            u.table === 'execution_runs' &&
            u.values.status === ExecutionRunStatus.enum.failed &&
            u.where.some(
              (w) =>
                w[0] === 'status' &&
                w[1] === 'in' &&
                Array.isArray(w[2]) &&
                (w[2] as string[]).includes(ExecutionRunStatus.enum.cancelling),
            ),
        );
        expect(staleStatusUpdates.length).toBe(1);
        expect('failure_reason' in staleStatusUpdates[0].values).toBe(false);
      });
    });

    it('does not stamp a stale reason when the run completes successfully', async () => {
      await requestContext.run({ requestId: 'req-ok', runId: 'run-ok' }, async () => {
        await tracker.onExecutionStarted(
          'run-ok',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc123',
          null,
          { installationId: 1 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );

        await tracker.onJobStatus('run-ok', 'job-1', ExecutionJobStatus.enum.running, Date.now());
        // In-memory mutation (not `onJobStatus`) so the run is still open when
        // the call under test runs — otherwise this negative assertion would
        // hold vacuously, for want of any write at all.
        tracker.updateInMemoryJob('run-ok', 'job-1', ExecutionJobStatus.enum.success);

        await tracker.completeRunIfAllJobsTerminal('run-ok');

        // A successful run never produces a stale-reason write at all (the
        // guarded UPDATE only fires for a failed overall status).
        const reasonUpdates = mockDb.updates.filter(
          (u) =>
            u.table === 'execution_runs' &&
            u.values.status === undefined &&
            'failure_reason' in u.values,
        );
        expect(reasonUpdates.length).toBe(0);
      });
    });

    it('does not forward a recomputed status the terminal guard rejected', async () => {
      // A job marked `timed_out_stale` after the run already finished green
      // recomputes the run to `failed`. The DB guard keeps the recorded
      // `success` — and the Platform forward must be suppressed with it, or the
      // Platform mirror reads `failed` for a run this orchestrator reads as
      // `success`, forever (the mirror reconciler only revisits NON-terminal
      // rows, so nothing ever corrects it).
      const onExecutionStatusChange = vi.fn();
      const t = new ExecutionTracker({ db: mockDb.db, onExecutionStatusChange });
      await requestContext.run({ requestId: 'req-late', runId: 'run-late-stale' }, async () => {
        await t.onExecutionStarted(
          'run-late-stale',
          'ci',
          'github',
          'owner/repo',
          'main',
          'abc123',
          null,
          { installationId: 1 },
          null,
          [{ jobId: 'job-1', jobName: 'test' }],
        );
        await t.onJobStatus('run-late-stale', 'job-1', ExecutionJobStatus.enum.running, Date.now());
        // Normal completion: the run finishes green and forwards `success`.
        await t.onJobStatus('run-late-stale', 'job-1', ExecutionJobStatus.enum.success, Date.now());
        expect(onExecutionStatusChange.mock.calls.at(-1)?.[1]).toBe(
          ExecutionRunStatus.enum.success,
        );
        onExecutionStatusChange.mockClear();

        // The stale detector then marks the (already finished) job stale and
        // asks the tracker to complete the run again.
        t.updateInMemoryJob('run-late-stale', 'job-1', ExecutionJobStatus.enum.timed_out_stale);
        await t.completeRunIfAllJobsTerminal('run-late-stale');

        expect(onExecutionStatusChange).not.toHaveBeenCalled();
      });
    });
  });

  describe('completeRunFromDbFallback failure_reason guard', () => {
    /**
     * Mock DB for the DB-fallback completion path (in-memory run state empty):
     * - selectFrom('execution_jobs').select(['status','job_name']).where(...).execute() → jobs
     * - selectFrom('execution_runs').select([...]).where(...).executeTakeFirst() → run row
     * - updateTable('execution_runs').set(...).where(...).execute() captured with where-clauses
     */
    function createDbFallbackMockDb(
      jobs: Array<{ status: string; job_name: string }>,
      runRowInput: Record<string, unknown>,
      /**
       * Status the run row takes on immediately AFTER the fallback's run-state
       * read — simulating a concurrent normal completion landing between that
       * read and the guarded write. Omit for the ordinary case.
       */
      statusAfterRead?: string,
    ) {
      const updates: MockUpdate[] = [];
      // Copy: `apply` below mutates the row's status, and the callers share one
      // literal across tests.
      const runRow = { ...runRowInput };

      const buildSelectChain = (executeFn: () => Promise<unknown>) => {
        const chain: Record<string, unknown> = {};
        chain.where = vi.fn(() => chain);
        chain.execute = vi.fn(executeFn);
        chain.executeTakeFirst = vi.fn(executeFn);
        return chain;
      };

      const db = {
        selectFrom: vi.fn((table: string) => ({
          select: vi.fn(() =>
            buildSelectChain(async () => {
              if (table === 'execution_jobs') return jobs;
              const snapshot = { ...runRow };
              if (statusAfterRead !== undefined) runRow.status = statusAfterRead;
              return snapshot;
            }),
          ),
        })),
        updateTable: vi.fn((table: string) => ({
          set: vi.fn((vals: Record<string, unknown>) => {
            const wheres: Array<[string, string, unknown]> = [];
            const chain: Record<string, unknown> = {};
            chain.where = vi.fn((col: string, op: string, val: unknown) => {
              wheres.push([col, op, val]);
              return chain;
            });
            const apply = (): number => {
              // Honour a `status in [...]` clobber guard against the run row's
              // current status, the way Postgres would: an update whose guard
              // excludes it writes nothing.
              const statusGuard = wheres.find((w) => w[0] === 'status' && w[1] === 'in');
              if (table === 'execution_runs' && statusGuard) {
                const allowed = statusGuard[2] as unknown[];
                if (!allowed.includes(runRow.status)) return 0;
              }
              updates.push({ table, values: vals, where: [...wheres] });
              if (table === 'execution_runs' && typeof vals.status === 'string') {
                runRow.status = vals.status;
              }
              return 1;
            };
            chain.execute = vi.fn(async () => {
              apply();
              return [];
            });
            chain.executeTakeFirst = vi.fn(async () => ({ numUpdatedRows: BigInt(apply()) }));
            return chain;
          }),
        })),
      };

      return { db: db as unknown as ExecutionTrackerDeps['db'], updates };
    }

    const failedJobs = [{ status: ExecutionJobStatus.enum.failed, job_name: 'test' }];
    const runningRunRow = {
      status: ExecutionRunStatus.enum.running,
      workflow_name: 'ci',
      provider: 'github',
      repo_identifier: 'owner/repo',
      sha: 'abc123',
      ref: 'main',
      routing_key: null,
      provider_context: '{}',
      started_at: new Date('2026-01-01T00:00:00Z'),
      parent_run_id: null,
      original_run_id: null,
      triggered_by: null,
    };

    it('stamps the generic orphan reason via a clobber-guarded failure_reason UPDATE', async () => {
      const { db, updates } = createDbFallbackMockDb(failedJobs, runningRunRow);
      // No onExecutionStarted call → no in-memory run state → DB-fallback path.
      const fallbackTracker = new ExecutionTracker({ db });

      await fallbackTracker.completeRunIfAllJobsTerminal('run-orphan');

      // The orphan reason is written by a SEPARATE UPDATE that sets only
      // failure_reason and guards on `failure_reason IS NULL`, so a specific
      // provisioning error already on the row survives.
      const guardedReasonUpdates = updates.filter(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.status === undefined &&
          u.values.failure_reason ===
            'Run recovered from orphaned state (DB-fallback completion)' &&
          u.where.some((w) => w[0] === 'run_id' && w[2] === 'run-orphan') &&
          u.where.some((w) => w[0] === 'failure_reason' && w[1] === 'is' && w[2] === null),
      );
      expect(guardedReasonUpdates.length).toBe(1);

      // The status/timing UPDATE must not also carry failure_reason.
      const statusUpdates = updates.filter(
        (u) => u.table === 'execution_runs' && u.values.status === ExecutionRunStatus.enum.failed,
      );
      expect(statusUpdates.length).toBe(1);
      expect('failure_reason' in statusUpdates[0].values).toBe(false);
    });

    it('fails a DB-fallback run whose only non-success job never ran', async () => {
      // The false-green this guards: `__build__` succeeded and the declared job
      // was settled `unroutable` / `drift_dropped` without ever dispatching. A
      // hand-listed failure set here reported the whole run `success`.
      for (const neverRan of [
        ExecutionJobStatus.enum.unroutable,
        ExecutionJobStatus.enum.drift_dropped,
      ]) {
        const jobs = [
          { status: ExecutionJobStatus.enum.success, job_name: '__build__' },
          { status: neverRan, job_name: 'deploy' },
        ];
        const { db, updates } = createDbFallbackMockDb(jobs, runningRunRow);
        const onExecutionComplete = vi.fn();
        const fallbackTracker = new ExecutionTracker({ db, onExecutionComplete });

        await fallbackTracker.completeRunIfAllJobsTerminal(`run-never-ran-${neverRan}`);

        // The run row is written `failed` — never `success` — and classified as
        // infra (`timed_out`), since no step ever ran to fail.
        const statusUpdates = updates.filter(
          (u) => u.table === 'execution_runs' && u.values.status !== undefined,
        );
        expect(statusUpdates.length).toBe(1);
        expect(statusUpdates[0].values.status).toBe(ExecutionRunStatus.enum.failed);
        expect(statusUpdates[0].values.failure_class).toBe(RunFailureClass.enum.timed_out);

        // ...and the job that never ran is named, so the description is not an
        // empty `Failed jobs:` list.
        expect(onExecutionComplete).toHaveBeenCalledWith(
          `run-never-ran-${neverRan}`,
          ExecutionRunStatus.enum.failed,
          expect.anything(),
          'Failed jobs: deploy',
        );
      }
    });

    it('does not stamp an orphan reason when the DB-fallback run succeeds', async () => {
      const successJobs = [{ status: ExecutionJobStatus.enum.success, job_name: 'test' }];
      const { db, updates } = createDbFallbackMockDb(successJobs, runningRunRow);
      const fallbackTracker = new ExecutionTracker({ db });

      await fallbackTracker.completeRunIfAllJobsTerminal('run-orphan-ok');

      const reasonUpdates = updates.filter(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.status === undefined &&
          'failure_reason' in u.values,
      );
      expect(reasonUpdates.length).toBe(0);
    });

    it('does not forward when a concurrent completion lands between read and write', async () => {
      // The run-state read and the guarded write are not one transaction, so a
      // normal completion can turn the row terminal in between. The guard then
      // rejects the write — and the Platform forward must go with it, or the
      // mirror is left holding a `failed` this orchestrator never recorded.
      const onExecutionStatusChange = vi.fn();
      const { db, updates } = createDbFallbackMockDb(
        failedJobs,
        runningRunRow,
        ExecutionRunStatus.enum.success,
      );
      const fallbackTracker = new ExecutionTracker({ db, onExecutionStatusChange });

      await fallbackTracker.completeRunIfAllJobsTerminal('run-orphan-raced');

      expect(onExecutionStatusChange).not.toHaveBeenCalled();
      expect(
        updates.filter(
          (u) => u.table === 'execution_runs' && u.values.status === ExecutionRunStatus.enum.failed,
        ),
      ).toHaveLength(0);
    });
  });

  describe('synthetic job replacement', () => {
    const syntheticId = 'needs-pending-deploy-fake-uuid-1234';

    async function setupRunWithSyntheticJob() {
      // Create run with one real job
      await tracker.onExecutionStarted(
        'run-synth',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-1',
        { installationId: 42 },
        { matched: true },
        [{ jobId: 'job-real-1', jobName: 'build' }],
      );

      // Add synthetic job entry (simulating what processor does for needs-gated jobs)
      await tracker.addJobsToRun('run-synth', [{ jobId: syntheticId, jobName: 'deploy' }]);
    }

    it('replaces synthetic entry with real jobId in run.jobs and deletes from DB', async () => {
      await setupRunWithSyntheticJob();

      // Verify synthetic entry exists
      expect(tracker.isRunComplete('run-synth')).toBe(false);

      // Now replace the synthetic with a real job ID
      await tracker.addJobsToRun(
        'run-synth',
        [{ jobId: 'real-deploy-job-id', jobName: 'deploy' }],
        undefined,
        syntheticId,
      );

      // The synthetic ID should be gone from the DB (deleteFrom called)
      const deleteOps = mockDb.deletes.filter(
        (d) =>
          d.table === 'execution_jobs' &&
          d.where.some((w) => w[0] === 'job_id' && w[2] === syntheticId),
      );
      expect(deleteOps.length).toBe(1);

      // findSyntheticJobId should no longer find it
      expect(await tracker.findSyntheticJobId('run-synth', 'deploy')).toBeUndefined();
    });

    it('isRunComplete returns true after synthetic replacement and terminal states', async () => {
      await setupRunWithSyntheticJob();

      // Before replacement: isRunComplete false (both jobs pending)
      expect(tracker.isRunComplete('run-synth')).toBe(false);

      // Complete the build job
      await tracker.onJobStatus(
        'run-synth',
        'job-real-1',
        ExecutionJobStatus.enum.success,
        Date.now(),
      );

      // Still false because synthetic deploy is pending
      expect(tracker.isRunComplete('run-synth')).toBe(false);

      // Replace synthetic with real job
      await tracker.addJobsToRun(
        'run-synth',
        [{ jobId: 'real-deploy-job-id', jobName: 'deploy' }],
        undefined,
        syntheticId,
      );

      // Still false -- real deploy job is pending
      expect(tracker.isRunComplete('run-synth')).toBe(false);

      // Complete the real deploy job
      await tracker.onJobStatus(
        'run-synth',
        'real-deploy-job-id',
        ExecutionJobStatus.enum.success,
        Date.now(),
      );

      // NOW it should be complete
      expect(tracker.isRunComplete('run-synth')).toBe(true);
    });

    async function startBuildWindowRun(runId: string) {
      await tracker.onExecutionStarted(
        runId,
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-bw',
        { installationId: 42 },
        { matched: true },
        // A run registered with ONLY the source-pack build job — the shape the
        // dispatch path produces while it awaits the build.
        [{ jobId: 'build-1', jobName: '__build__ci' }],
      );
      tracker.holdRunForPendingJobs(runId);
    }

    it('does not finalize a run while a pending-jobs token is held', async () => {
      await startBuildWindowRun('run-build-window');

      await tracker.onJobStatus(
        'run-build-window',
        'build-1',
        ExecutionJobStatus.enum.success,
        Date.now(),
      );

      // The build finishing is NOT the run finishing: the post-build jobs have
      // not been dispatched yet.
      expect(tracker.isRunComplete('run-build-window')).toBe(false);
      expect(onExecutionComplete).not.toHaveBeenCalled();

      // Post-build jobs land, then the hold is released.
      await tracker.addJobsToRun('run-build-window', [
        { jobId: 'producer-1', jobName: 'producer' },
      ]);
      await tracker.releasePendingJobsHold('run-build-window');
      expect(tracker.isRunComplete('run-build-window')).toBe(false);
      expect(onExecutionComplete).not.toHaveBeenCalled();

      // Only the real job's outcome decides the run's terminal status.
      await tracker.onJobStatus(
        'run-build-window',
        'producer-1',
        ExecutionJobStatus.enum.failed,
        Date.now(),
      );
      expect(tracker.isRunComplete('run-build-window')).toBe(true);
      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-build-window',
        ExecutionRunStatus.enum.failed,
        expect.objectContaining({ workflowName: 'ci' }),
        expect.any(String),
      );
    });

    it('finalizes on release when the token was the only thing keeping the run open', async () => {
      await startBuildWindowRun('run-build-window-noop');

      await tracker.onJobStatus(
        'run-build-window-noop',
        'build-1',
        ExecutionJobStatus.enum.success,
        Date.now(),
      );
      expect(onExecutionComplete).not.toHaveBeenCalled();

      // No post-build job was ever registered (every static job was rejected).
      // Releasing the hold must complete the run rather than leave it
      // hanging in `running` forever.
      await tracker.releasePendingJobsHold('run-build-window-noop');
      expect(tracker.isRunComplete('run-build-window-noop')).toBe(true);
      expect(onExecutionComplete).toHaveBeenCalledWith(
        'run-build-window-noop',
        ExecutionRunStatus.enum.success,
        expect.objectContaining({ workflowName: 'ci' }),
        undefined,
      );
    });

    it('does not expose a pending-jobs token as a job in the replay projection', async () => {
      await startBuildWindowRun('run-build-window-replay');

      // The hold must be invisible to every outward projection: a synthetic job
      // entry here would be mirrored into the Platform's execution_jobs table on
      // reconnect (a phantom pending job on the run page, forever) and would
      // inflate the reported job count for the length of the build.
      const replayed = tracker.getReplayData().find((r) => r.runId === 'run-build-window-replay');
      expect(replayed?.jobs.map((j) => j.jobName)).toEqual(['__build__ci']);
      expect(replayed?.jobCount).toBe(1);
    });

    it('releasePendingJobsHold is a no-op when no token is outstanding', async () => {
      await setupRunWithSyntheticJob();
      await tracker.releasePendingJobsHold('run-synth');
      await tracker.releasePendingJobsHold('run-unknown');
      expect(tracker.isRunComplete('run-synth')).toBe(false);
      expect(onExecutionComplete).not.toHaveBeenCalled();
    });

    it('handles race condition where real entry already exists (upsert)', async () => {
      await setupRunWithSyntheticJob();

      // Simulate race: agent sends status for real job ID before addJobsToRun replaces synthetic
      await tracker.onJobStatus(
        'run-synth',
        'real-deploy-job-id',
        ExecutionJobStatus.enum.running,
        Date.now(),
      );

      // Now replace synthetic -- should delete synthetic, real entry already exists
      await tracker.addJobsToRun(
        'run-synth',
        [{ jobId: 'real-deploy-job-id', jobName: 'deploy' }],
        undefined,
        syntheticId,
      );

      // Synthetic should be deleted from DB
      const deleteOps = mockDb.deletes.filter(
        (d) =>
          d.table === 'execution_jobs' &&
          d.where.some((w) => w[0] === 'job_id' && w[2] === syntheticId),
      );
      expect(deleteOps.length).toBe(1);

      // No synthetic entry should remain
      expect(await tracker.findSyntheticJobId('run-synth', 'deploy')).toBeUndefined();
    });

    it('handles missing synthetic ID gracefully (DB delete is a noop on nonexistent row)', async () => {
      await setupRunWithSyntheticJob();

      // Pass a nonexistent synthetic ID -- should not error. The DB delete
      // runs unconditionally (cluster correctness) but is a noop when the
      // row does not exist, so the original synthetic entry survives.
      await tracker.addJobsToRun(
        'run-synth',
        [{ jobId: 'real-deploy-job-id', jobName: 'deploy' }],
        undefined,
        'nonexistent-synthetic-id',
      );

      // DB delete IS issued (DELETE on a nonexistent row is a safe noop)
      const deleteOps = mockDb.deletes.filter(
        (d) =>
          d.table === 'execution_jobs' &&
          d.where.some((w) => w[0] === 'job_id' && w[2] === 'nonexistent-synthetic-id'),
      );
      expect(deleteOps.length).toBe(1);

      // The original synthetic entry should still exist (different job_id)
      expect(await tracker.findSyntheticJobId('run-synth', 'deploy')).toBe(syntheticId);
    });

    it('cleans up synthetic DB row on rerouted peer with empty in-memory run.jobs', async () => {
      // Simulate cluster: peer B receives onExecutionStarted for just the
      // upstream job via reroute; the synthetic entry lives only in the
      // shared DB (inserted by the ingesting peer). dispatchReadyJob then
      // calls addJobsToRun on peer B with replaceSyntheticId. The DB row
      // must be deleted even though run.jobs has no entry for it.
      await tracker.onExecutionStarted(
        'run-cross-peer',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-3',
        { installationId: 42 },
        { matched: true },
        [{ jobId: 'job-upstream', jobName: 'build' }],
      );

      // Peer B's in-memory run.jobs has no entry for the synthetic ID — only
      // the upstream job. The DB delete must still be issued unconditionally
      // so the orphan synthetic row (inserted by the ingesting peer) is
      // cleaned up when the gated job is dispatched.
      await tracker.addJobsToRun(
        'run-cross-peer',
        [{ jobId: 'real-deploy-x', jobName: 'deploy' }],
        undefined,
        'needs-pending-deploy-xpeer',
      );

      const deleteOps = mockDb.deletes.filter(
        (d) =>
          d.table === 'execution_jobs' &&
          d.where.some((w) => w[0] === 'job_id' && w[2] === 'needs-pending-deploy-xpeer'),
      );
      expect(deleteOps.length).toBe(1);
    });

    it('findSyntheticJobId falls back to DB when another peer inserted the synthetic row', async () => {
      // Simulate cross-peer scenario: this tracker never ingested the webhook,
      // so its in-memory Map has no run entry. The synthetic row exists only in
      // the shared DB (inserted by the peer that ingested the webhook).
      await tracker.onExecutionStarted(
        'run-cross-peer',
        'ci',
        'github',
        'owner/repo',
        'refs/heads/main',
        'abc123',
        'delivery-2',
        { installationId: 42 },
        { matched: true },
        [{ jobId: 'job-real-1', jobName: 'build' }],
      );
      await tracker.addJobsToRun('run-cross-peer', [
        { jobId: 'needs-pending-deploy-cross-peer-uuid', jobName: 'deploy' },
      ]);

      // Drop in-memory state for this run (simulate different peer).
      // @ts-expect-error - access private runs for test setup
      tracker.runs.delete('run-cross-peer');

      // DB fallback should still locate the synthetic row by (run_id, job_name, job_id LIKE prefix)
      expect(await tracker.findSyntheticJobId('run-cross-peer', 'deploy')).toBe(
        'needs-pending-deploy-cross-peer-uuid',
      );
    });
  });

  describe('emitScalerEvent last_provisioning_error persistence', () => {
    it('persists the failure detail to dispatch_queue on scaler.failed', async () => {
      const detail = 'agent process exited 1\n--- captured output ---\nboom';
      tracker.emitScalerEvent('run-1', 'queue-row-1', {
        agentId: 'agent-1',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail,
        timestampMs: Date.now(),
      });

      // The UPDATE is fire-and-forget, so poll the captured updates.
      await vi.waitFor(() => {
        const update = mockDb.updates.find(
          (u) =>
            u.table === 'dispatch_queue' &&
            u.where.some((w) => w[0] === 'id' && w[1] === '=' && w[2] === 'queue-row-1'),
        );
        expect(update).toBeDefined();
        expect(update!.values.last_provisioning_error).toBe(detail);
      });
    });

    it('does not write dispatch_queue on a non-failure scaler event', async () => {
      tracker.emitScalerEvent('run-1', 'queue-row-1', {
        agentId: 'agent-1',
        eventType: ScalerEventType.enum['scaler.ready'],
        detail: 'container started',
        timestampMs: Date.now(),
      });

      // Flush any microtasks a fire-and-forget write might have queued.
      await Promise.resolve();
      await Promise.resolve();

      const update = mockDb.updates.find((u) => u.table === 'dispatch_queue');
      expect(update).toBeUndefined();
    });
  });

  describe('recordInitFailureRun', () => {
    it('creates a failed execution_runs row with init_failure populated', async () => {
      const runId = 'run-init-fail-1';
      await tracker.recordInitFailureRun({
        runId,
        workflowName: 'wf',
        provider: 'github',
        repoIdentifier: 'org/repo',
        ref: 'refs/heads/main',
        sha: 'deadbeef',
        deliveryId: 'd1',
        providerContext: {},
        routingKey: 'github:1',
        initFailure: {
          scope: 'run',
          category: InitFailureCategory.enum.secret_resolution,
          message: 'Failed to resolve workflow secret context',
        },
      });

      const runInsert = mockDb.inserts.find(
        (i) => i.table === 'execution_runs' && i.values.run_id === runId,
      );
      expect(runInsert).toBeDefined();
      expect(runInsert!.values.status).toBe(ExecutionRunStatus.enum.failed);
      expect(runInsert!.values.failure_reason).toBe('Failed to resolve workflow secret context');
      expect(runInsert!.values.init_failure).toBe(
        JSON.stringify({
          scope: 'run',
          category: 'secret_resolution',
          message: 'Failed to resolve workflow secret context',
        }),
      );
    });

    it('also fires onExecutionStatusChange with initFailure', async () => {
      const onExecutionStatusChange = vi.fn();
      const initFailTracker = new ExecutionTracker({
        db: mockDb.db,
        onExecutionStatusChange,
      });

      await initFailTracker.recordInitFailureRun({
        runId: 'run-init-fail-2',
        workflowName: 'wf',
        provider: 'github',
        repoIdentifier: 'org/repo',
        ref: 'refs/heads/main',
        sha: 'deadbeef',
        deliveryId: 'd1',
        providerContext: {},
        routingKey: 'github:1',
        initFailure: {
          scope: 'run',
          category: InitFailureCategory.enum.install_secrets,
          message: '.npmrc resolution rejected',
        },
      });

      expect(onExecutionStatusChange).toHaveBeenCalledOnce();
      const lastCall = onExecutionStatusChange.mock.calls.at(-1)!;
      // Positional args: runId, status, context, jobCount, startedAt,
      // completedAt, durationMs, failureReason, logBytes, initFailure.
      expect(lastCall[1]).toBe(ExecutionRunStatus.enum.failed);
      expect(lastCall[9]).toMatchObject({ category: 'install_secrets' });
    });

    const initFailureArgs = (runId: string) => ({
      runId,
      workflowName: 'wf',
      provider: 'github',
      repoIdentifier: 'org/repo',
      ref: 'refs/heads/main',
      sha: 'deadbeef',
      deliveryId: 'd1',
      providerContext: {},
      routingKey: 'github:1',
      initFailure: {
        scope: 'run' as const,
        category: InitFailureCategory.enum.secret_resolution,
        message: 'init blew up',
      },
    });

    it('overwrites a live run row rather than leaving it mid-flight', async () => {
      const runId = 'run-init-fail-upsert';
      // Dispatch already registered the run before init failed, so the insert
      // conflicts. Leaving the pending row untouched would strand the run.
      await tracker.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await tracker.recordInitFailureRun(initFailureArgs(runId));

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.run_id === runId,
      );
      expect(update).toBeDefined();
      expect(update!.values.status).toBe(ExecutionRunStatus.enum.failed);
    });

    it('a late job status cannot re-finalize an init-failed run', async () => {
      const runId = 'run-init-fail-late-status';
      await tracker.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await tracker.recordInitFailureRun(initFailureArgs(runId));

      // The run is stamped complete, so the late success neither rolls it up nor
      // overwrites the recorded failure.
      await tracker.onJobStatus(runId, 'j1', ExecutionJobStatus.enum.success, Date.now());

      expect(onExecutionComplete).not.toHaveBeenCalled();
      const rewrite = mockDb.updates.find(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.run_id === runId &&
          u.values.status === ExecutionRunStatus.enum.success,
      );
      expect(rewrite).toBeUndefined();
    });

    it('does not overwrite an already-terminal run row', async () => {
      const runId = 'run-init-fail-terminal-guard';
      // A run that genuinely finished must not be rewritten as failed by a late
      // init-failure record.
      await tracker.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await tracker.onJobStatus(runId, 'j1', ExecutionJobStatus.enum.success, Date.now());
      const before = mockDb.updates.filter(
        (u) => u.table === 'execution_runs' && u.values.run_id === runId,
      ).length;

      await tracker.recordInitFailureRun(initFailureArgs(runId));

      const after = mockDb.updates.filter(
        (u) => u.table === 'execution_runs' && u.values.run_id === runId,
      ).length;
      expect(after).toBe(before);
    });

    it('does not forward a failure the terminal guard rejected', async () => {
      // The mirror the Platform serves is whatever it was last told, and it
      // never revisits a terminal mirror row. So a forward the orchestrator's
      // own guard refused to record would leave the Platform reading `failed`
      // for a run this orchestrator reads as `success` — permanently.
      const runId = 'run-init-fail-no-forward';
      const onExecutionStatusChange = vi.fn();
      const t = new ExecutionTracker({ db: mockDb.db, onExecutionStatusChange });
      await t.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await t.onJobStatus(runId, 'j1', ExecutionJobStatus.enum.success, Date.now());
      // Positive control: the genuine completion did forward `success`.
      expect(onExecutionStatusChange.mock.calls.at(-1)?.[1]).toBe(ExecutionRunStatus.enum.success);
      onExecutionStatusChange.mockClear();

      await t.recordInitFailureRun(initFailureArgs(runId));

      expect(onExecutionStatusChange).not.toHaveBeenCalled();
    });
  });

  describe('recordRunHeld', () => {
    const heldArgs = (runId: string) => ({
      runId,
      workflowName: 'wf',
      provider: 'github',
      repoIdentifier: 'org/repo',
      ref: 'refs/heads/main',
      sha: 'deadbeef',
      deliveryId: 'd1',
      providerContext: {},
      routingKey: 'github:1',
      contextName: 'prod',
      reason: 'registries',
    });

    it('overwrites a live run row so the hold is visible', async () => {
      const runId = 'run-held-upsert';
      await tracker.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await tracker.recordRunHeld(heldArgs(runId));

      const update = mockDb.updates.find(
        (u) => u.table === 'execution_runs' && u.values.run_id === runId,
      );
      expect(update).toBeDefined();
      expect(update!.values.status).toBe(ExecutionRunStatus.enum.held);
    });

    it('drops the in-memory run so a held run is not finalized', async () => {
      const runId = 'run-held-delete';
      await tracker.onExecutionStarted(
        runId,
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'deadbeef',
        'd1',
        {},
        { matched: true },
        [{ jobId: 'j1', jobName: 'build' }],
      );
      await tracker.recordRunHeld(heldArgs(runId));

      // The jobs registered before the gate held the run must not satisfy the
      // completion check: the run is paused, not finished.
      await tracker.onJobStatus(runId, 'j1', ExecutionJobStatus.enum.success, Date.now());
      expect(onExecutionComplete).not.toHaveBeenCalledWith(
        runId,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(tracker.getReplayData().find((r) => r.runId === runId)).toBeUndefined();
    });

    it('does not rehydrate a held run from the DB', async () => {
      const runId = 'run-held-no-rehydrate';
      await tracker.recordRunHeld(heldArgs(runId));

      // A late status from the pre-hold dispatch must not resurrect the run:
      // rehydrating it would let the recovered job set roll up as complete
      // while the run is still parked at the install gate.
      await tracker.onJobStatus(runId, 'j1', ExecutionJobStatus.enum.success, Date.now());

      expect(tracker.getReplayData().find((r) => r.runId === runId)).toBeUndefined();
      expect(onExecutionComplete).not.toHaveBeenCalled();
    });
  });

  describe('failRun with initFailure', () => {
    it('persists init_failure on the run row and forwards it', async () => {
      const onExecutionStatusChange = vi.fn();
      const initFailTracker = new ExecutionTracker({
        db: mockDb.db,
        onExecutionStatusChange,
      });

      await initFailTracker.onExecutionStarted(
        'run-fr-1',
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'd1',
        null,
        {},
        null,
        [],
        'github:1',
      );

      await initFailTracker.failRun('run-fr-1', 'No agent for label kici:os:linux', {
        scope: 'run',
        category: InitFailureCategory.enum.no_agent,
        message: 'No agent for label kici:os:linux',
      });

      // The DB update on execution_runs carries the stringified init_failure.
      const runUpdate = mockDb.updates.find(
        (u) =>
          u.table === 'execution_runs' &&
          u.values.status === ExecutionRunStatus.enum.failed &&
          u.where.some(([col, op, val]) => col === 'run_id' && op === '=' && val === 'run-fr-1'),
      );
      expect(runUpdate).toBeDefined();
      expect(runUpdate!.values.init_failure).toBe(
        JSON.stringify({
          scope: 'run',
          category: 'no_agent',
          message: 'No agent for label kici:os:linux',
        }),
      );

      // The callback receives initFailure as the 10th positional arg.
      const lastCall = onExecutionStatusChange.mock.calls.at(-1)!;
      expect(lastCall[1]).toBe(ExecutionRunStatus.enum.failed);
      expect(lastCall[9]).toMatchObject({ category: 'no_agent' });
    });

    it('failRun emits onWorkflowComplete for a never-started run (Plane B parity)', async () => {
      const onExecutionStatusChange = vi.fn();
      const onWorkflowComplete = vi.fn();
      const tracker = new ExecutionTracker({
        db: mockDb.db,
        onExecutionStatusChange,
        onWorkflowComplete,
      });
      await tracker.onExecutionStarted(
        'run-fr-2',
        'wf',
        'github',
        'org/repo',
        'refs/heads/main',
        'd1',
        null,
        {},
        null,
        [],
        'github:1',
      );
      await tracker.failRun('run-fr-2', 'No agent for label kici:os:linux', {
        scope: 'run',
        category: InitFailureCategory.enum.no_agent,
        message: 'No agent for label kici:os:linux',
      });

      expect(onWorkflowComplete).toHaveBeenCalledOnce();
      const data = onWorkflowComplete.mock.calls[0][0];
      expect(data).toMatchObject({
        runId: 'run-fr-2',
        workflowName: 'wf',
        status: ExecutionRunStatus.enum.failed,
        repo: 'org/repo',
        routingKey: 'github:1',
      });
      expect(data.duration).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(data.jobResults)).toBe(true);
    });

    it('failRun without in-memory run state does not emit onWorkflowComplete', async () => {
      const onWorkflowComplete = vi.fn();
      const tracker = new ExecutionTracker({
        db: mockDb.db,
        onWorkflowComplete,
      });
      // No onExecutionStarted → no in-memory run; the emit lives inside the
      // `if (run)` block, so a DB-only failRun must not fire it.
      await tracker.failRun('run-fr-3', 'orphaned failure');
      expect(onWorkflowComplete).not.toHaveBeenCalled();
    });
  });

  describe('onJobStatus with initFailure', () => {
    it('persists init_failure on the execution_jobs row when provided', async () => {
      const onJobStatusChange = vi.fn();
      const initFailJobTracker = new ExecutionTracker({
        db: mockDb.db,
        onJobStatusChange,
      });

      await initFailJobTracker.onExecutionStarted(
        'run-job-init',
        'wf',
        'github',
        'org/repo',
        'main',
        'refs/heads/main',
        'd1',
        {},
        null,
        [{ jobId: 'rejected-xyz', jobName: 'deploy' }],
        'github:1',
      );

      await initFailJobTracker.onJobStatus(
        'run-job-init',
        'rejected-xyz',
        ExecutionJobStatus.enum.failed,
        Date.now(),
        undefined,
        {
          error: 'Rejected by protection rules',
          initFailure: {
            scope: 'job',
            category: InitFailureCategory.enum.context_rules,
            message: 'Rejected by protection rules',
            jobName: 'deploy',
          },
        },
      );

      // The upsert on execution_jobs carries the stringified init_failure
      // alongside error_message.
      const jobUpdate = mockDb.updates.find(
        (u) =>
          u.table === 'execution_jobs' &&
          u.values.status === ExecutionJobStatus.enum.failed &&
          u.where.some(
            ([col, op, val]) => col === 'job_id' && op === '=' && val === 'rejected-xyz',
          ),
      );
      expect(jobUpdate).toBeDefined();
      expect(jobUpdate!.values.error_message).toBe('Rejected by protection rules');
      expect(jobUpdate!.values.init_failure).toBe(
        JSON.stringify({
          scope: 'job',
          category: 'context_rules',
          message: 'Rejected by protection rules',
          jobName: 'deploy',
        }),
      );

      // The onJobStatusChange callback receives initFailure as the second-to-last
      // positional arg (environments is the final one).
      const lastCall = onJobStatusChange.mock.calls.at(-1)!;
      expect(lastCall[3]).toBe(ExecutionJobStatus.enum.failed);
      expect(lastCall.at(-2)).toMatchObject({
        category: 'context_rules',
        scope: 'job',
        jobName: 'deploy',
      });
    });
  });

  // The per-run lock that prevents the synthetic→real job-swap race
  // (addJobsToRun vs a concurrent onJobStatus) from wedging a run in `running`.
  describe('withRunLock (per-run job-swap serialization)', () => {
    // Pure promise-chaining — no timers — so use real timers for deterministic
    // microtask flushing (the suite-wide beforeEach installs fake timers).
    beforeEach(() => {
      vi.useRealTimers();
    });
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    type LockHarness = {
      withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T>;
      runLockTails: Map<string, unknown>;
    };

    it('serializes concurrent acquisitions for the same runId', async () => {
      const t = tracker as unknown as LockHarness;
      const order: string[] = [];
      let release1!: () => void;
      const gate = new Promise<void>((r) => {
        release1 = r;
      });
      const p1 = t.withRunLock('run-x', async () => {
        order.push('1-start');
        await gate;
        order.push('1-end');
      });
      const p2 = t.withRunLock('run-x', async () => {
        order.push('2-start');
        order.push('2-end');
      });
      await tick();
      // op2 must not start until op1 releases — proves serialization.
      expect(order).toEqual(['1-start']);
      release1();
      await Promise.all([p1, p2]);
      expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
    });

    it('allows reentrant acquisition for the same runId without deadlocking', async () => {
      const t = tracker as unknown as LockHarness;
      // A holder re-acquiring its own runId's lock must run inline — this is the
      // onJobStatus → scheduler-hook → addJobsToRun (same runId) path. If the
      // lock were non-reentrant this would hang and the test would time out.
      const result = await t.withRunLock('run-y', () =>
        t.withRunLock('run-y', async () => 'inner-ran'),
      );
      expect(result).toBe('inner-ran');
      expect(t.runLockTails.has('run-y')).toBe(false);
    });

    it('does not serialize across different runIds', async () => {
      const t = tracker as unknown as LockHarness;
      const order: string[] = [];
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });
      const pa = t.withRunLock('run-a', async () => {
        order.push('a-start');
        await gateA;
        order.push('a-end');
      });
      const pb = t.withRunLock('run-b', async () => {
        order.push('b-start');
        order.push('b-end');
      });
      await tick();
      // run-b proceeds while run-a is still held — different runs don't block.
      expect(order).toEqual(['a-start', 'b-start', 'b-end']);
      releaseA();
      await Promise.all([pa, pb]);
    });

    it('removes the per-run tail entry once the last holder releases', async () => {
      const t = tracker as unknown as LockHarness;
      await t.withRunLock('run-gc', async () => {});
      expect(t.runLockTails.has('run-gc')).toBe(false);
    });
  });
});

/**
 * Cross-file guard: the run roll-up (`computeRunStatus`, orchestrator) and the
 * `on-failure` needs-edge expansion (`resolveWhenToRunOn`, engine) are two
 * separate answers to one question — "did this job fail?" — and both read
 * `STATUS_FAILURE_CLASS`. This pins them to the same answer for every terminal
 * status, across the package boundary that separates them: a run that fails on
 * a given status must be exactly a run whose status releases an `on-failure`
 * downstream. Nothing else in either package checks the two agree.
 */
describe('run rollup agrees with the on-failure needs edge', () => {
  const onFailure = new Set<string>(resolveWhenToRunOn('on-failure'));

  for (const status of TERMINAL_JOB_STATES) {
    it(`a run whose only job is ${status} fails iff on-failure covers ${status}`, async () => {
      const db = createMockDb();
      const onComplete = vi.fn();
      const t = new ExecutionTracker({ db: db.db, onExecutionComplete: onComplete });

      await t.onExecutionStarted(
        `run-${status}`,
        'ci',
        'github',
        'owner/repo',
        'main',
        'abc',
        null,
        {},
        null,
        [{ jobId: 'job-1', jobName: 'only' }],
      );
      await t.onJobStatus(`run-${status}`, 'job-1', status as ExecutionJobStatus, Date.now());

      expect(onComplete).toHaveBeenCalled();
      const runStatus = onComplete.mock.calls[0][1] as string;
      expect(runStatus === ExecutionRunStatus.enum.failed).toBe(onFailure.has(status));
    });
  }
});
