import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionRunStatus } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ExecutionTracker, type WorkflowRepoProvenance } from './execution-tracker.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * Real-Postgres coverage for the workflow-repository provenance columns on the
 * two upsert paths that can meet an existing run row: a hold landing on a row
 * that already records a commit, and a run start landing on a held row. The
 * conflict sets are SQL `COALESCE` expressions, which only a real database
 * evaluates. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_wf_provenance_${process.pid}_${Date.now()}`;

const SOURCE_REPO = 'acme/app';
const WORKFLOW_REPO = 'acme/ci';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('ExecutionTracker workflow provenance on conflicting writes', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

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
    return tracker.onExecutionStarted(
      runId,
      'org-ci',
      'github',
      SOURCE_REPO,
      'main',
      'headsha',
      null,
      {},
      null,
      [],
      'github:1',
      undefined, // dispatchedContexts
      'push', // triggerEvent
      undefined, // commitMessage
      undefined, // parentRunId
      undefined, // triggeredBy
      undefined, // originalRunId
      undefined, // concurrency
      undefined, // workflowTimeoutMs
      undefined, // checkMode
      undefined, // localWorkingTree
      undefined, // triggerActorUsername
      undefined, // triggerActorUserId
      undefined, // triggeredByAgentLabel
      undefined, // prNumber
      workflowRepo,
    );
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
    expect(await provenanceOf(runId)).toMatchObject({ workflow_sha: null, workflow_branch: null });

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
});
