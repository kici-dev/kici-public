import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import {
  DispatchQueueStatus,
  JobQueue,
  STOPPED_RUN_DISPATCH_REASON,
  type QueuedJobInput,
} from './job-queue.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import { Dispatcher, type DispatchMetrics } from '../agent/dispatcher.js';
import { AgentRegistry } from '../agent/registry.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';

const LABELS = ['linux'];

function mockMetrics(): DispatchMetrics {
  return { incJobsDispatched: vi.fn(), setQueueDepth: vi.fn(), incScalerRedispatch: vi.fn() };
}

/**
 * Real-Postgres coverage for the stopped-run guard on the direct dispatch
 * paths: `insertDispatched`, `dequeueById` and `dequeueByPinnedAgent`, and the
 * job rows a stopped run registers after its dispatch was refused. The guard is
 * a correlated `NOT EXISTS` over `execution_runs`, which only a real database
 * evaluates. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'direct dispatch for a stopped run (real Postgres)',
  { prefix: 'kici_queue_stopped_run', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    let db: Kysely<Database>;
    let queue: JobQueue;

    beforeAll(() => {
      ({ db } = getDb());
      queue = new JobQueue(db, { maxDepth: 1000, defaultTimeoutMs: 600_000 });
    });

    const jobInput = (runId: string, overrides: Partial<QueuedJobInput> = {}): QueuedJobInput => ({
      runId,
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: LABELS,
      jobConfig: { timeout: 300 },
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: `delivery-${randomUUID()}`,
      provider: 'github',
      providerContext: { installationId: 42 },
      routingKey: 'github:42',
      ...overrides,
    });

    /** A run row in `status`, started with no job rows, as an early start writes it. */
    async function runIn(status: ExecutionRunStatus, tracker = new ExecutionTracker({ db })) {
      const runId = randomUUID();
      await startRun(tracker, {
        runId,
        ref: 'main',
        deliveryId: null,
        routingKey: 'github:42',
      });
      if (status !== ExecutionRunStatus.enum.pending) {
        await db
          .updateTable('execution_runs')
          .set({ status })
          .where('run_id', '=', runId)
          .execute();
      }
      return { runId, tracker };
    }

    async function queueRow(id: string) {
      return db
        .selectFrom('dispatch_queue')
        .select(['status', 'agent_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    }

    async function jobStatus(runId: string, jobId: string) {
      const row = await db
        .selectFrom('execution_jobs')
        .select(['status', 'error_message'])
        .where('run_id', '=', runId)
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow();
      return row;
    }

    describe('JobQueue.insertDispatched', () => {
      it('refuses a job of a cancelled run: row expired with no agent, job row cancelled', async () => {
        const { runId, tracker } = await runIn(ExecutionRunStatus.enum.pending);
        const jobId = randomUUID();
        await tracker.addJobsToRun(runId, [{ jobId, jobName: 'build' }]);
        await db
          .updateTable('execution_runs')
          .set({ status: ExecutionRunStatus.enum.cancelled })
          .where('run_id', '=', runId)
          .execute();

        const result = await queue.insertDispatched(jobInput(runId, { jobId }), 'agent-a');

        // fails-when: the stopped-run guard is missing, so the row stays dispatched to agent-a
        expect(result).toEqual({ id: jobId, inserted: true, runStopped: true });
        expect(await queueRow(jobId)).toEqual({
          status: DispatchQueueStatus.Expired,
          agent_id: null,
        });
        expect(await jobStatus(runId, jobId)).toEqual({
          status: ExecutionJobStatus.enum.cancelled,
          error_message: STOPPED_RUN_DISPATCH_REASON,
        });
      });

      it('refuses a job of a cancelling run', async () => {
        const { runId } = await runIn(ExecutionRunStatus.enum.cancelling);
        const result = await queue.insertDispatched(jobInput(runId), 'agent-a');
        expect(result.runStopped).toBe(true);
      });

      it('dispatches a job of a pending run', async () => {
        // breaks-if-wrong: the guard must not refuse a run that is still live
        const { runId } = await runIn(ExecutionRunStatus.enum.pending);
        const jobId = randomUUID();

        const result = await queue.insertDispatched(jobInput(runId, { jobId }), 'agent-a');

        expect(result).toEqual({ id: jobId, inserted: true });
        expect(await queueRow(jobId)).toEqual({
          status: DispatchQueueStatus.Dispatched,
          agent_id: 'agent-a',
        });
      });
    });

    describe('the eager claims', () => {
      it('dequeueById does not claim a pending row of a cancelled run', async () => {
        const { runId } = await runIn(ExecutionRunStatus.enum.running);
        const id = await queue.enqueue(jobInput(runId));
        await db
          .updateTable('execution_runs')
          .set({ status: ExecutionRunStatus.enum.cancelled })
          .where('run_id', '=', runId)
          .execute();

        // fails-when: dequeueById carries no stopped-run guard and claims the row
        expect(await queue.dequeueById(id, LABELS, [], 'agent-a')).toBeNull();
        expect((await queueRow(id)).status).toBe(DispatchQueueStatus.Pending);
      });

      it('dequeueById claims a pending row of a running run', async () => {
        // breaks-if-wrong: the eager bound claim must still work for a live run
        const { runId } = await runIn(ExecutionRunStatus.enum.running);
        const id = await queue.enqueue(jobInput(runId));
        expect((await queue.dequeueById(id, LABELS, [], 'agent-a'))?.id).toBe(id);
      });

      it('dequeueByPinnedAgent does not claim a pinned row of a cancelled run', async () => {
        const { runId } = await runIn(ExecutionRunStatus.enum.running);
        const id = await queue.enqueue(jobInput(runId, { pinnedAgentId: 'agent-p' }));
        await db
          .updateTable('execution_runs')
          .set({ status: ExecutionRunStatus.enum.cancelled })
          .where('run_id', '=', runId)
          .execute();

        // fails-when: the pinned claim carries no stopped-run guard and claims the row
        expect(await queue.dequeueByPinnedAgent('agent-p', LABELS)).toBeNull();
        expect((await queueRow(id)).status).toBe(DispatchQueueStatus.Pending);
      });

      it('dequeueByPinnedAgent claims a pinned row of a running run', async () => {
        // breaks-if-wrong: the pin-aware drain must still deliver a live run's job
        const { runId } = await runIn(ExecutionRunStatus.enum.running);
        const id = await queue.enqueue(jobInput(runId, { pinnedAgentId: 'agent-q' }));
        expect((await queue.dequeueByPinnedAgent('agent-q', LABELS))?.id).toBe(id);
      });
    });

    describe('job rows registered after the refused dispatch', () => {
      it('a job registered under a cancelled run is cancelled', async () => {
        const { runId, tracker } = await runIn(ExecutionRunStatus.enum.pending);
        await db
          .updateTable('execution_runs')
          .set({ status: ExecutionRunStatus.enum.cancelled })
          .where('run_id', '=', runId)
          .execute();
        const jobId = randomUUID();

        await tracker.addJobsToRun(runId, [{ jobId, jobName: 'build' }]);

        // fails-when: the registration writes the job pending under a terminal run
        expect(await jobStatus(runId, jobId)).toEqual({
          status: ExecutionJobStatus.enum.cancelled,
          error_message: STOPPED_RUN_DISPATCH_REASON,
        });
      });

      it('a job registered under a live run stays pending', async () => {
        // breaks-if-wrong: an ordinary registration must not cancel its own jobs
        const { runId, tracker } = await runIn(ExecutionRunStatus.enum.pending);
        const jobId = randomUUID();
        await tracker.addJobsToRun(runId, [{ jobId, jobName: 'build' }]);
        expect((await jobStatus(runId, jobId)).status).toBe(ExecutionJobStatus.enum.pending);
      });
    });

    describe('Dispatcher.dispatch', () => {
      function dispatcherFor(agentId: string) {
        const registry = new AgentRegistry();
        registry.register(agentId, mockWs(), LABELS);
        const onDispatch = vi.fn();
        const dispatcher = new Dispatcher({ registry, queue, metrics: mockMetrics(), onDispatch });
        return { registry, onDispatch, dispatcher };
      }

      it('never sends a job of a cancelled run to the agent and frees its slot', async () => {
        const { runId } = await runIn(ExecutionRunStatus.enum.cancelled);
        const { registry, onDispatch, dispatcher } = dispatcherFor('agent-d');

        const result = await dispatcher.dispatch(jobInput(runId));

        // fails-when: the dispatcher sends the refused job to the agent it picked
        expect(onDispatch).not.toHaveBeenCalled();
        expect(result.status).toBe('queued');
        expect(registry.get('agent-d')?.activeJobs).toBe(0);
      });

      it('never sends a pinned job of a cancelled run to its agent', async () => {
        const { runId } = await runIn(ExecutionRunStatus.enum.cancelled);
        const { registry, onDispatch, dispatcher } = dispatcherFor('agent-e');

        const result = await dispatcher.dispatch(jobInput(runId, { pinnedAgentId: 'agent-e' }));

        expect(onDispatch).not.toHaveBeenCalled();
        expect(result.status).toBe('queued');
        expect(registry.get('agent-e')?.activeJobs).toBe(0);
      });

      it('sends a job of a running run to the agent', async () => {
        // breaks-if-wrong: an ordinary direct dispatch must still reach its agent
        const { runId } = await runIn(ExecutionRunStatus.enum.running);
        const { onDispatch, dispatcher } = dispatcherFor('agent-f');

        const result = await dispatcher.dispatch(jobInput(runId));

        expect(result.status).toBe('dispatched');
        expect(onDispatch).toHaveBeenCalledTimes(1);
      });
    });
  },
);
