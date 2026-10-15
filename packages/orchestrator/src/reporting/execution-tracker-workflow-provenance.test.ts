import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker, type WorkflowRepoProvenance } from './execution-tracker.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { startRun } from '../__test-helpers__/tracker.js';

const SOURCE_REPO = 'acme/app';
const WORKFLOW_REPO = 'acme/ci';

/**
 * Real-Postgres coverage of the workflow-repository provenance columns on the upsert paths that
 * can meet an existing run row: a hold on a row that records a commit, and a run start on a held
 * row. The conflict sets are SQL `COALESCE`s only a real database evaluates. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'ExecutionTracker workflow provenance on conflicting writes',
  { prefix: 'kici_wf_provenance', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    function hold(
      tracker: ExecutionTracker,
      runId: string,
      provenance: { workflowSha?: string | null; workflowBranch?: string | null },
    ): Promise<void> {
      return tracker.recordRunHeld({
        runId,
        workflowName: 'org-ci',
        provider: 'github',
        repoIdentifier: SOURCE_REPO,
        workflowRepoIdentifier: WORKFLOW_REPO,
        ref: 'main',
        sha: 'headsha',
        deliveryId: null,
        providerContext: {},
        routingKey: 'github:1',
        reason: 'registries',
        ...provenance,
      });
    }

    function start(
      tracker: ExecutionTracker,
      runId: string,
      workflowRepo: WorkflowRepoProvenance,
    ): Promise<void> {
      return startRun(tracker, {
        runId,
        workflowName: 'org-ci',
        repoIdentifier: SOURCE_REPO,
        ref: 'main',
        sha: 'headsha',
        deliveryId: null,
        routingKey: 'github:1',
        triggerEvent: 'push',
        workflowRepo,
      });
    }

    async function provenanceOf(runId: string) {
      return db
        .selectFrom('execution_runs')
        .select(['status', 'workflow_repo_identifier', 'workflow_sha', 'workflow_branch'])
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow();
    }

    it('a hold with no commit or branch keeps the ones the row already records', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await start(tracker, runId, { identifier: WORKFLOW_REPO, sha: 'a1', branch: 'main' });
      // Control: the start really recorded them, so what follows is about the hold.
      expect(await provenanceOf(runId)).toMatchObject({
        workflow_sha: 'a1',
        workflow_branch: 'main',
      });

      await hold(tracker, runId, {});

      // fails-when: the hold's conflict set writes its omitted sha/branch as NULL
      expect(await provenanceOf(runId)).toMatchObject({
        status: ExecutionRunStatus.enum.held,
        workflow_repo_identifier: WORKFLOW_REPO,
        workflow_sha: 'a1',
        workflow_branch: 'main',
      });
    });

    it('a hold that supplies a commit and branch records them on an existing row', async () => {
      // breaks-if-wrong: never-clear must not become never-set — a supplied value still lands
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await start(tracker, runId, { identifier: WORKFLOW_REPO, sha: null, branch: null });

      await hold(tracker, runId, { workflowSha: 'b2', workflowBranch: 'release' });

      expect(await provenanceOf(runId)).toMatchObject({
        workflow_sha: 'b2',
        workflow_branch: 'release',
      });
    });

    it('a run start fills the commit and branch a held row lacks', async () => {
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await hold(tracker, runId, {});
      expect(await provenanceOf(runId)).toMatchObject({
        workflow_sha: null,
        workflow_branch: null,
      });

      await start(tracker, runId, { identifier: WORKFLOW_REPO, sha: 'c3', branch: 'main' });

      // fails-when: the start's conflict set leaves the held row's NULL provenance in place
      expect(await provenanceOf(runId)).toMatchObject({
        workflow_repo_identifier: WORKFLOW_REPO,
        workflow_sha: 'c3',
        workflow_branch: 'main',
      });
    });

    it('a run start keeps the commit a held row already records', async () => {
      // breaks-if-wrong: the start fills gaps only, matching the event-context columns
      const tracker = new ExecutionTracker({ db });
      const runId = randomUUID();
      await hold(tracker, runId, { workflowSha: 'd4', workflowBranch: 'main' });

      await start(tracker, runId, { identifier: WORKFLOW_REPO, sha: 'other', branch: 'other' });

      expect(await provenanceOf(runId)).toMatchObject({
        workflow_sha: 'd4',
        workflow_branch: 'main',
      });
    });
  },
);
