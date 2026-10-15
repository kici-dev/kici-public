import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { findActiveJobBindings } from './vm-job-bindings.js';

const RUN_ID = '55555555-5555-4555-8555-555555555555';

/**
 * Real-Postgres coverage of which dispatch_queue rows bind a VM's agent. Gated on
 * KICI_TEST_ADMIN_DATABASE_URL, which the shared globalSetup (scripts/db-test-postgres.ts) sets.
 */
describeWithTestDb<Database>(
  'findActiveJobBindings (real Postgres)',
  { prefix: 'kici_vm_job_bindings_test', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    let db: Kysely<Database>;

    /** One dispatch_queue row; returns its id, the job id the queue dispatches by. */
    async function insertJob(
      status: string,
      agentId: string | null,
      recoveryAgentId: string | null = null,
    ): Promise<string> {
      const jobName = `job-${status}-${agentId ?? 'none'}-${recoveryAgentId ?? 'none'}`;
      const result = await sql<{ id: string }>`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, job_config, repo_url, ref, sha,
         delivery_id, routing_key, status, agent_id, recovery_agent_id)
      VALUES (${RUN_ID}, 'ci', ${jobName}, '[]', '{}', 'https://x/y', 'main', 'abc',
              ${jobName}, 'rk', ${status}, ${agentId}, ${recoveryAgentId})
      RETURNING id
    `.execute(db);
      return result.rows[0]!.id;
    }

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await sql`DELETE FROM public.dispatch_queue`.execute(db);
    });

    it('binds an agent to the job it was dispatched', async () => {
      const jobId = await insertJob(DispatchQueueStatus.Dispatched, 'vm-a');

      expect(await findActiveJobBindings(db, ['vm-a', 'vm-free'])).toEqual(
        new Map([['vm-a', jobId]]),
      );
    });

    it('binds an agent to the job waiting for it to reconnect', async () => {
      const jobId = await insertJob(DispatchQueueStatus.Recovering, null, 'vm-b');

      expect(await findActiveJobBindings(db, ['vm-b'])).toEqual(new Map([['vm-b', jobId]]));
    });

    // fails-when: a terminal row binds, so a VM whose job ended can never be reclaimed
    it('a terminal row binds nothing', async () => {
      for (const status of [
        DispatchQueueStatus.Completed,
        DispatchQueueStatus.Failed,
        DispatchQueueStatus.Expired,
        'cancelled',
      ]) {
        await insertJob(status, 'vm-c');
      }
      // Positive control: the same agent with one live row is bound.
      const live = await insertJob(DispatchQueueStatus.Dispatched, 'vm-d');

      expect(await findActiveJobBindings(db, ['vm-c', 'vm-d'])).toEqual(new Map([['vm-d', live]]));
    });

    it('answers an empty id list without a query', async () => {
      const throwing = new Proxy(db, {
        get: () => {
          throw new Error('queried');
        },
      });
      expect(await findActiveJobBindings(throwing, [])).toEqual(new Map());
    });
  },
);
