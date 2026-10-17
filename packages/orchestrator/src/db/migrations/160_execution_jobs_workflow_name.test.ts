import { beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { down, up } from './160_execution_jobs_workflow_name.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 160. Seeds a job row BEFORE the migration,
 * the way an upgraded database carries it, then asserts the row survives with
 * no workflow and a new row records one. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<unknown>(
  'migration 160_execution_jobs_workflow_name',
  { prefix: 'kici_mig160_test' },
  (getDb) => {
    let db: Kysely<unknown>;

    async function workflowNameColumn(): Promise<unknown[]> {
      const rows = await sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'execution_jobs'
           AND column_name = 'workflow_name'
      `.execute(db);
      return rows.rows;
    }

    beforeAll(async () => {
      db = getDb().db;
      const before = await migrateToPreviousMigration(db, import.meta.url);
      if (before.error) throw before.error;
      await sql`
        INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, ref, sha)
        VALUES ('00000000-0000-4000-8000-000000000160', 'hello-world', 'github', 'acme/app', 'main', 'abc')
      `.execute(db);
      await sql`
        INSERT INTO public.execution_jobs (run_id, job_id, job_name)
        VALUES ('00000000-0000-4000-8000-000000000160', 'job-old', 'build')
      `.execute(db);
      const after = await migrateToOwnMigration(db, import.meta.url);
      if (after.error) throw after.error;
    }, 60_000);

    it('adds a nullable text column', async () => {
      // fails-when: the column is missing, or NOT NULL (an existing row could not exist)
      expect(await workflowNameColumn()).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    });

    it('keeps an existing job row, with no workflow recorded', async () => {
      const rows = await sql<{ job_id: string; workflow_name: string | null }>`
        SELECT job_id, workflow_name FROM public.execution_jobs WHERE run_id = '00000000-0000-4000-8000-000000000160'
      `.execute(db);
      // breaks-if-wrong: the upgrade must not drop or rewrite an existing job row
      expect(rows.rows).toEqual([{ job_id: 'job-old', workflow_name: null }]);
    });

    it('is idempotent, and down removes the column', async () => {
      await up(db);
      expect(await workflowNameColumn()).toHaveLength(1);
      await down(db);
      expect(await workflowNameColumn()).toEqual([]);
      await up(db);
      expect(await workflowNameColumn()).toHaveLength(1);
    });
  },
);
