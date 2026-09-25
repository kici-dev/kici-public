import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { deriveKey } from '@kici-dev/shared';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { JobQueue, type QueuedJobInput } from '../queue/job-queue.js';
import {
  clearPendingJobContextsMap,
  consumePendingJobContext,
  restorePendingJobContexts,
  storePendingJobContext,
} from '../pipeline/processor.js';
import {
  clearPendingWorkflowContextsMap,
  loadPendingWorkflowContext,
  restorePendingWorkflowContexts,
  storePendingWorkflowContext,
  type SerializableWorkflowDispatchInputs,
} from '../pipeline/pending-workflow-context.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import type { ResolvedMasterKeys } from './config.js';
import { configureJobSecretSealing } from './job-secret-seal.js';
import { rotateMasterKeyWrappedTables } from './master-key-rotation.js';

/**
 * Real-Postgres coverage for sealed job secrets: every table a job waits in
 * stores no plaintext secret once a master key is configured, every reader
 * gets the plaintext back, rotation re-seals the rows, and a row written in
 * plaintext (no master key, or before sealing existed) still reads back.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_job_secret_seal_${process.pid}_${Date.now()}`;

const SECRET_VALUE = 'sekrit-value-1';
const NPM_TOKEN = 'npm-token-1';
const CLI_SECRET = 'cli-secret-1';
const OVERLAY_KEY = 'overlay-private-key-1';

function keysOf(current: string, old?: string): ResolvedMasterKeys {
  return {
    material: current,
    materialOld: old,
    current: deriveKey(current),
    old: old === undefined ? undefined : deriveKey(old),
  };
}
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function jobInput(runId: string): QueuedJobInput {
  return {
    runId,
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux'],
    jobConfig: {
      name: 'build',
      secrets: { TOKEN: SECRET_VALUE },
      namespacedSecrets: { prod: { TOKEN: SECRET_VALUE } },
      npmRegistries: [{ url: 'https://npm.example', alwaysAuth: true, token: NPM_TOKEN }],
      containerRegistryAuth: { username: 'u', password: SECRET_VALUE, serveraddress: 'r' },
    },
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: `delivery-${randomUUID()}`,
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
  };
}

function workflowInputs(runId: string): SerializableWorkflowDispatchInputs {
  return {
    runId,
    resolvedOrgId: 'org1',
    repoIdentifier: 'a/b',
    info: { routingKey: 'github:1', deliveryId: 'd1', event: 'push', action: null },
    credentials: { installationId: 42 },
    workflow: { name: 'CI' },
    runWideFlatSecrets: { CLI: CLI_SECRET },
    extraJobConfig: { isTestRun: true, fixtureId: 'fx', orchestratorPrivateKey: OVERLAY_KEY },
  } as unknown as SerializableWorkflowDispatchInputs;
}

describeDb('sealed job secrets (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let queue: JobQueue;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    queue = new JobQueue(db, { maxDepth: 1000, defaultTimeoutMs: 600_000 });
  }, 120_000);

  afterEach(() => {
    configureJobSecretSealing(keysOf(KEY_A));
    clearPendingJobContextsMap();
    clearPendingWorkflowContextsMap();
  });

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  /** Every stored column of the three rows, as text: what an attacker reading the DB sees. */
  async function storedText(runId: string): Promise<string> {
    const q = await sql<{ t: string }>`
      SELECT row_to_json(d)::text AS t FROM dispatch_queue d WHERE run_id = ${runId}
      UNION ALL SELECT row_to_json(p)::text FROM pending_job_contexts p WHERE run_id = ${runId}
      UNION ALL SELECT row_to_json(w)::text FROM pending_workflow_contexts w WHERE run_id = ${runId}
    `.execute(db);
    return q.rows.map((r) => r.t).join('\n');
  }

  /** Write one row to each table for `runId`. */
  async function writeAll(runId: string): Promise<string> {
    const jobId = await queue.enqueue(jobInput(runId));
    await storePendingJobContext(db, runId, 'deploy', {
      jobInput: { ...jobInput(runId), jobName: 'deploy' },
      runsOnLabels: ['linux'],
    });
    await storePendingWorkflowContext(db, workflowInputs(runId));
    clearPendingJobContextsMap();
    clearPendingWorkflowContextsMap();
    return jobId;
  }

  /** Read the three rows back through the production readers. */
  async function readAll(runId: string, jobId: string) {
    return {
      queued: await queue.getFullJobById(jobId),
      pendingJob: await consumePendingJobContext(db, runId, 'deploy'),
      pendingWorkflow: await loadPendingWorkflowContext(db, runId),
    };
  }

  it('stores no plaintext secret in any table, and every reader gets the plaintext back', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const runId = randomUUID();
    const jobId = await writeAll(runId);

    const text = await storedText(runId);
    // fails-when: a store writes a secret field into its plain JSON column
    for (const plaintext of [SECRET_VALUE, NPM_TOKEN, CLI_SECRET, OVERLAY_KEY]) {
      expect(text).not.toContain(plaintext);
    }
    expect(text.match(/"sealed_secrets":"[^"]+"/g)).toHaveLength(3);

    const { queued, pendingJob, pendingWorkflow } = await readAll(runId, jobId);
    // breaks-if-wrong: the dispatch, release and resume readers must see the secrets
    expect(queued?.jobConfig).toEqual(jobInput(runId).jobConfig);
    expect(queued?.secretsUnavailable).toBeUndefined();
    expect(pendingJob?.jobInput.jobConfig).toEqual(jobInput(runId).jobConfig);
    expect(pendingWorkflow?.runWideFlatSecrets).toEqual({ CLI: CLI_SECRET });
    expect(pendingWorkflow?.extraJobConfig).toEqual(workflowInputs(runId).extraJobConfig);
  });

  it('restores a pending job context with its secrets after a restart', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const runId = randomUUID();
    await writeAll(runId);
    await restorePendingJobContexts(db);
    const restored = await consumePendingJobContext(undefined, runId, 'deploy');
    expect(restored?.jobInput.jobConfig.secrets).toEqual({ TOKEN: SECRET_VALUE });
  });

  it('restores a held run context with its secrets after a restart', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const runId = randomUUID();
    await writeAll(runId);
    await restorePendingWorkflowContexts(db);
    // Served from the restored memory entry, not from a fresh DB read.
    const restored = await loadPendingWorkflowContext(undefined, runId);
    // fails-when: the restore puts the sealed row into memory without opening it
    expect(restored?.runWideFlatSecrets).toEqual({ CLI: CLI_SECRET });
    expect(restored?.extraJobConfig).toEqual(workflowInputs(runId).extraJobConfig);
  });

  it('re-seals every table under the new key on rotation', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const runId = randomUUID();
    const jobId = await writeAll(runId);

    const rotating = keysOf(KEY_B, KEY_A);
    configureJobSecretSealing(rotating);
    const result = await rotateMasterKeyWrappedTables(db, rotating, () => {});
    // fails-when: the rotation leaves a table's sealed secrets under the old key
    expect(result.jobSecrets.skipped).toBe(0);
    expect(result.jobSecrets.reEncrypted).toBeGreaterThanOrEqual(3);

    // The old key is dropped: every row must open under the new key alone.
    configureJobSecretSealing(keysOf(KEY_B));
    const { queued, pendingJob, pendingWorkflow } = await readAll(runId, jobId);
    expect(queued?.secretsUnavailable).toBeUndefined();
    expect(queued?.jobConfig.secrets).toEqual({ TOKEN: SECRET_VALUE });
    expect(pendingJob?.secretsUnavailable).toBeUndefined();
    expect(pendingJob?.jobInput.jobConfig.secrets).toEqual({ TOKEN: SECRET_VALUE });
    expect(pendingWorkflow?.secretsUnavailable).toBeUndefined();
    expect(pendingWorkflow?.runWideFlatSecrets).toEqual({ CLI: CLI_SECRET });
  });

  it('marks a row sealed under an unknown key as unavailable instead of throwing', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const runId = randomUUID();
    const jobId = await writeAll(runId);

    configureJobSecretSealing(keysOf(KEY_B));
    const { queued, pendingJob, pendingWorkflow } = await readAll(runId, jobId);
    // fails-when: an undecryptable row reads as a job with no secrets
    expect(queued?.secretsUnavailable).toMatch(/does not hold/);
    expect(queued?.jobConfig).not.toHaveProperty('secrets');
    expect(pendingJob?.secretsUnavailable).toMatch(/does not hold/);
    expect(pendingWorkflow?.secretsUnavailable).toMatch(/does not hold/);
  });

  it('keeps storing and reading plaintext when no master key is configured', async () => {
    configureJobSecretSealing(null);
    const runId = randomUUID();
    const jobId = await writeAll(runId);

    // breaks-if-wrong: an orchestrator with no master key must keep working as before
    const text = await storedText(runId);
    expect(text).toContain(SECRET_VALUE);
    expect(text).not.toMatch(/"sealed_secrets":"/);
    const { queued, pendingJob, pendingWorkflow } = await readAll(runId, jobId);
    expect(queued?.jobConfig).toEqual(jobInput(runId).jobConfig);
    expect(pendingJob?.jobInput.jobConfig).toEqual(jobInput(runId).jobConfig);
    expect(pendingWorkflow?.runWideFlatSecrets).toEqual({ CLI: CLI_SECRET });
  });

  it('reads a plaintext row written before sealing existed, with a key configured', async () => {
    configureJobSecretSealing(null);
    const runId = randomUUID();
    const jobId = await writeAll(runId);

    // breaks-if-wrong: an old row with its secrets in the plain column must still dispatch
    configureJobSecretSealing(keysOf(KEY_A));
    const { queued, pendingJob, pendingWorkflow } = await readAll(runId, jobId);
    expect(queued?.secretsUnavailable).toBeUndefined();
    expect(queued?.jobConfig.secrets).toEqual({ TOKEN: SECRET_VALUE });
    expect(pendingJob?.jobInput.jobConfig.secrets).toEqual({ TOKEN: SECRET_VALUE });
    expect(pendingWorkflow?.runWideFlatSecrets).toEqual({ CLI: CLI_SECRET });
  });

  it('drops the sealed secrets of terminal dispatch_queue rows and keeps live ones', async () => {
    configureJobSecretSealing(keysOf(KEY_A));
    const failed = await queue.enqueue(jobInput(randomUUID()));
    const cancelled = await queue.enqueue(jobInput(randomUUID()));
    const pending = await queue.enqueue(jobInput(randomUUID()));
    const dispatched = await queue.enqueue(jobInput(randomUUID()));
    await queue.markFailed(failed, 'boom');
    // The off-enum status existing databases hold from the test-run cancel.
    await db
      .updateTable('dispatch_queue')
      .set({ status: 'cancelled' })
      .where('id', '=', cancelled)
      .execute();
    await queue.markDispatched(dispatched, 'agent-1');

    await queue.scrubTerminalSealedSecrets();

    const rows = await db
      .selectFrom('dispatch_queue')
      .select(['id', 'sealed_secrets'])
      .where('id', 'in', [failed, cancelled, pending, dispatched])
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r.sealed_secrets]));
    // fails-when: the scrub leaves a terminal row's secrets in place
    expect(byId.get(failed)).toBeNull();
    expect(byId.get(cancelled)).toBeNull();
    // breaks-if-wrong: a pending or dispatched row keeps the secrets its dispatch needs
    expect(byId.get(pending)).not.toBeNull();
    expect(byId.get(dispatched)).not.toBeNull();
  });
});
