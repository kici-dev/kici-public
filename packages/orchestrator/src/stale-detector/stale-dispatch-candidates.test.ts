import { afterEach, beforeAll, expect, it } from 'vitest';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import { selectStaleDispatchCandidates } from './stale-dispatch-candidates.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const MINUTE = 60_000;

/**
 * Real-Postgres tests for the stale-dispatch sub-scan's predicates: raw SQL (a `COALESCE`
 * over two columns, an acked-dispatch exemption) that a mock records without evaluating, so
 * keying on `created_at` instead of `dispatched_at` (reaping every job that waited behind a
 * busy fleet) stays invisible to one.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
describeWithTestDb<Database>(
  'selectStaleDispatchCandidates (real Postgres)',
  { prefix: 'kici_stale_dispatch_test', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    let db: Kysely<Database>;

    /** `now - 2min` / `now - 30min`, the detector's own bounds. */
    const threshold = (): Date => new Date(Date.now() - 2 * MINUTE);
    const timeBound = (): Date => new Date(Date.now() - 30 * MINUTE);

    const insertDispatch = async (opts: {
      jobName: string;
      createdMinutesAgo: number;
      dispatchedMinutesAgo?: number;
      ackDeadline?: Date | null;
      ackAgentId?: string | null;
    }): Promise<void> => {
      const created = new Date(Date.now() - opts.createdMinutesAgo * MINUTE);
      const dispatched =
        opts.dispatchedMinutesAgo === undefined
          ? null
          : new Date(Date.now() - opts.dispatchedMinutesAgo * MINUTE);
      await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, status, created_at, dispatched_at, ack_deadline, ack_agent_id)
      VALUES (${RUN_ID}, 'ci', ${opts.jobName}, '[]', '{}', 'https://x/y', 'main', 'abc',
              ${opts.jobName}, 'rk', ${DispatchQueueStatus.Dispatched}, ${created}, ${dispatched},
              ${opts.ackDeadline ?? null}, ${opts.ackAgentId ?? null})
    `.execute(db);
    };

    const candidateNames = async (): Promise<string[]> => {
      const rows = await selectStaleDispatchCandidates(db, threshold(), timeBound());
      return rows.map((r) => r.job_name).sort();
    };

    beforeAll(async () => {
      ({ db } = getDb());
      await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${RUN_ID}::uuid, 'ci', 'github', 'owner/repo', 'main', 'abc',
              ${ExecutionRunStatus.enum.running})
    `.execute(db);
    });

    afterEach(async () => {
      await sql`TRUNCATE TABLE dispatch_queue`.execute(db);
      await sql`DELETE FROM execution_jobs`.execute(db);
    });

    it('spares a job enqueued 5 minutes ago but dispatched 30 seconds ago', async () => {
      // Scaler cold start: queued behind a busy fleet, then claimed and cloning. Keyed on
      // `created_at` it would be reaped while the agent ran it to completion for nothing.
      await insertDispatch({
        jobName: 'fresh-dispatch',
        createdMinutesAgo: 5,
        dispatchedMinutesAgo: 0.5,
        ackDeadline: new Date(Date.now() + MINUTE),
        ackAgentId: 'agent-1',
      });

      expect(await candidateNames()).toEqual([]);
    });

    it('reaps a job dispatched 3 minutes ago that never acked', async () => {
      await insertDispatch({
        jobName: 'never-acked',
        createdMinutesAgo: 10,
        dispatchedMinutesAgo: 3,
        ackDeadline: new Date(Date.now() - MINUTE),
        ackAgentId: 'agent-1',
      });

      expect(await candidateNames()).toEqual(['never-acked']);
    });

    it('never reaps a dispatch whose ack landed', async () => {
      // Cleared `ack_deadline` with stamped `ack_agent_id` durably records the ack; the
      // heartbeat sub-scans cover the job going quiet later.
      await insertDispatch({
        jobName: 'acked',
        createdMinutesAgo: 10,
        dispatchedMinutesAgo: 5,
        ackDeadline: null,
        ackAgentId: 'agent-1',
      });

      expect(await candidateNames()).toEqual([]);
    });

    it('keeps the previous behaviour for a pre-migration row with no dispatch time', async () => {
      // Rolling-upgrade bridge: NULL `dispatched_at` falls back to `created_at`, so a
      // pre-upgrade row stays reachable, which makes sparing an unknown-owner row safe.
      await insertDispatch({ jobName: 'legacy', createdMinutesAgo: 5 });

      expect(await candidateNames()).toEqual(['legacy']);
    });

    it('respects the lower time bound on the dispatch clock', async () => {
      await insertDispatch({
        jobName: 'ancient',
        createdMinutesAgo: 120,
        dispatchedMinutesAgo: 90,
      });

      expect(await candidateNames()).toEqual([]);
    });

    it('spares a job the agent already reported running', async () => {
      await insertDispatch({
        jobName: 'running-job',
        createdMinutesAgo: 10,
        dispatchedMinutesAgo: 5,
      });
      await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, status)
      VALUES (${RUN_ID}::uuid, 'job-running', 'running-job', ${ExecutionJobStatus.enum.running})
    `.execute(db);

      expect(await candidateNames()).toEqual([]);
    });
  },
);
