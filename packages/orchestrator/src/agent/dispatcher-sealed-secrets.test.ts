import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionJobStatus, ExecutionRunStatus } from '@kici-dev/engine';
import { deriveKey } from '@kici-dev/shared';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import {
  DispatchQueueStatus,
  JobQueue,
  MAX_DISPATCH_ATTEMPTS,
  type QueuedJobInput,
} from '../queue/job-queue.js';
import { classifyUnroutable } from '../queue/terminalize-unroutable.js';
import { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';
import type { ResolvedMasterKeys } from '../secrets/config.js';
import { configureJobSecretSealing } from '../secrets/job-secret-seal.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { Dispatcher, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';

/**
 * Real-Postgres coverage for a queued job whose sealed secrets the claiming
 * coordinator cannot open: it was sealed with a master key this coordinator
 * does not hold. During a rolling key rotation a coordinator holding the key
 * can take the job; when no coordinator holds it, the job must still fail with
 * the key-mismatch error rather than wait forever. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_dispatch_sealed_${process.pid}_${Date.now()}`;
const KEY_MISMATCH = /finish the key rotation on every coordinator/;

const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);

function keysOf(current: string, old?: string): ResolvedMasterKeys {
  return {
    material: current,
    materialOld: old,
    current: deriveKey(current),
    old: old === undefined ? undefined : deriveKey(old),
  };
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function mockMetrics(): DispatchMetrics {
  return { incJobsDispatched: vi.fn(), setQueueDepth: vi.fn(), incScalerRedispatch: vi.fn() };
}

describeDb('a queued job this coordinator cannot open (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
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
  }, 120_000);

  // Every coordinator below registers the same agent id, and a drain claims a
  // job pinned to that id before any label match. A row left by an earlier test
  // would be claimed in place of the one under test, so each test starts empty.
  beforeEach(async () => {
    await db.deleteFrom('dispatch_queue').execute();
    await db.deleteFrom('cluster_settings').execute();
  });

  afterEach(() => configureJobSecretSealing(keysOf(NEW_KEY, OLD_KEY)));

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

  /**
   * Queue a job with a secret, sealed by a coordinator already on the new key
   * unless `sealKeys` names other keys. `config` adds job config fields.
   */
  async function queueSealedJob(
    label: string,
    routing: Partial<Pick<QueuedJobInput, 'runsOnPatterns' | 'pinnedAgentId'>> = {},
    config: Record<string, unknown> = {},
    sealKeys: ResolvedMasterKeys = keysOf(NEW_KEY, OLD_KEY),
  ): Promise<string> {
    configureJobSecretSealing(sealKeys);
    const input: QueuedJobInput = {
      ...routing,
      runId: randomUUID(),
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: routing.runsOnPatterns ? [] : [label],
      jobConfig: { name: 'build', secrets: { TOKEN: 'sekrit' }, ...config },
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: `delivery-${randomUUID()}`,
      provider: 'github',
      providerContext: { installationId: 42 },
      routingKey: 'github:42',
    };
    return new JobQueue(db, { maxDepth: 1000, defaultTimeoutMs: 600_000 }).enqueue(input);
  }

  /** A coordinator on the old key alone, with one agent serving `label` (unless `agent: false`). */
  function staleCoordinator(
    label: string,
    opts: {
      peers: boolean;
      backoffMs?: number;
      agent?: boolean;
      clusterSettings?: boolean;
      /** Replaces the peer check, which runs between a claim and its put-back. */
      hasPeers?: () => Promise<boolean>;
    },
  ) {
    configureJobSecretSealing(keysOf(OLD_KEY));
    const queue = new JobQueue(db, {
      maxDepth: 1000,
      defaultTimeoutMs: 600_000,
      ...(opts.backoffMs !== undefined && { sealedSecretsRetryBackoffMs: opts.backoffMs }),
      ...(opts.clusterSettings && { clusterSettings: new ClusterSettingsReader(db, 0) }),
    });
    const registry = new AgentRegistry();
    if (opts.agent !== false) registry.register('agent-1', mockWs(), [label]);
    const onDispatch = vi.fn(async () => undefined);
    const onJobFailedPermanently = vi.fn();
    const onNoMatchingAgent = vi
      .fn<NonNullable<ConstructorParameters<typeof Dispatcher>[0]['onNoMatchingAgent']>>()
      .mockResolvedValue({ action: 'at-capacity' });
    const dispatcher = new Dispatcher({
      registry,
      queue,
      metrics: mockMetrics(),
      onDispatch,
      onJobFailedPermanently,
      onNoMatchingAgent,
      hasPeerCoordinators: opts.hasPeers ?? (() => opts.peers),
    });
    return { queue, dispatcher, registry, onDispatch, onJobFailedPermanently, onNoMatchingAgent };
  }

  async function rowOf(jobId: string) {
    return db
      .selectFrom('dispatch_queue')
      .select(['status', 'dispatch_attempts', 'last_provisioning_error'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
  }

  it('puts the job back for a peer, and leaves it alone for the back-off', async () => {
    const jobId = await queueSealedJob('seal-peer');
    const stale = staleCoordinator('seal-peer', { peers: true });

    await stale.dispatcher.onAgentAvailable('agent-1');

    const row = await rowOf(jobId);
    expect(row.status).toBe(DispatchQueueStatus.Pending);
    expect(row.dispatch_attempts).toBe(1);
    // An expiry reports the key mismatch, not a generic queue timeout.
    expect(row.last_provisioning_error).toMatch(KEY_MISMATCH);
    expect(stale.onDispatch).not.toHaveBeenCalled();
    expect(stale.onJobFailedPermanently).not.toHaveBeenCalled();

    // fails-when: the coordinator re-claims the job inside its back-off, spending the budget
    await stale.dispatcher.onAgentAvailable('agent-1');
    expect((await rowOf(jobId)).dispatch_attempts).toBe(1);

    // breaks-if-wrong: a coordinator holding the key claims the job with its secrets
    configureJobSecretSealing(keysOf(NEW_KEY, OLD_KEY));
    const current = new JobQueue(db, { maxDepth: 1000, defaultTimeoutMs: 600_000 });
    const taken = await current.dequeueForLabels(['seal-peer']);
    expect(taken?.id).toBe(jobId);
    expect(taken?.jobConfig.secrets).toEqual({ TOKEN: 'sekrit' });
  });

  it('fails a job no coordinator can open once its attempts run out', async () => {
    const jobId = await queueSealedJob('seal-nobody');
    // A zero back-off lets each drain re-claim at once, as each would after it.
    const stale = staleCoordinator('seal-nobody', { peers: true, backoffMs: 0 });

    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS + 2; i++) {
      await stale.dispatcher.onAgentAvailable('agent-1');
    }

    // fails-when: the skip is permanent, so the job stays pending with one attempt spent
    expect((await rowOf(jobId)).status).toBe(DispatchQueueStatus.Failed);
    expect(stale.onJobFailedPermanently).toHaveBeenCalledTimes(1);
    expect(stale.onJobFailedPermanently.mock.calls[0][3]).toMatch(KEY_MISMATCH);
    expect(stale.onDispatch).not.toHaveBeenCalled();
  });

  it('fails the job at once on a coordinator with no peer coordinator', async () => {
    const jobId = await queueSealedJob('seal-single');
    const stale = staleCoordinator('seal-single', { peers: false });

    await stale.dispatcher.onAgentAvailable('agent-1');

    // fails-when: a single node puts back a job no coordinator will ever open
    expect((await rowOf(jobId)).status).toBe(DispatchQueueStatus.Failed);
    expect(stale.onJobFailedPermanently.mock.calls[0][3]).toMatch(KEY_MISMATCH);
    expect(stale.onDispatch).not.toHaveBeenCalled();
  });

  it('reports the key mismatch when a put-back job expires in the queue', async () => {
    const jobId = await queueSealedJob('seal-expiry');
    const stale = staleCoordinator('seal-expiry', { peers: true });
    await stale.dispatcher.onAgentAvailable('agent-1');

    await db
      .updateTable('dispatch_queue')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', jobId)
      .execute();
    const expired = await stale.queue.markExpired();
    const info = expired.find((e) => e.id === jobId);

    // fails-when: the expiry reports the generic queue-timeout message
    expect(info).toBeDefined();
    expect(classifyUnroutable(info!).errorMessage).toMatch(KEY_MISMATCH);
  });

  it('ends a job no coordinator can open through the periodic re-drive alone', async () => {
    const jobId = await queueSealedJob('seal-redrive-fail');
    const stale = staleCoordinator('seal-redrive-fail', { peers: true, backoffMs: 0 });

    // No agent drain is triggered by hand: only the periodic connected-agent re-drive runs.
    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS + 2; i++) {
      await stale.dispatcher.redrivePendingToConnectedAgents();
    }

    // fails-when: the re-drive skips a job it cannot open, so it is never claimed again
    expect((await rowOf(jobId)).status).toBe(DispatchQueueStatus.Failed);
    expect(stale.onJobFailedPermanently.mock.calls[0][3]).toMatch(KEY_MISMATCH);
  });

  it('neither scales for nor re-offers a job inside its back-off, and claims it again after it', async () => {
    const deferredId = await queueSealedJob('seal-redrive-defer');
    const deferred = staleCoordinator('seal-redrive-defer', { peers: true });
    await deferred.dispatcher.onAgentAvailable('agent-1');
    await deferred.dispatcher.retryPendingScaleRequests(100);
    await deferred.dispatcher.redrivePendingToConnectedAgents(100);
    // fails-when: a re-drive re-offers a job inside its back-off, spending the budget
    expect(deferred.onNoMatchingAgent.mock.calls.map((c) => c[1])).not.toContain(deferredId);
    expect((await rowOf(deferredId)).dispatch_attempts).toBe(1);

    const lapsedId = await queueSealedJob('seal-redrive-lapsed');
    const lapsed = staleCoordinator('seal-redrive-lapsed', { peers: true, backoffMs: 0 });
    await lapsed.dispatcher.onAgentAvailable('agent-1');
    lapsed.registry.unregister('agent-1');
    await lapsed.dispatcher.retryPendingScaleRequests(100);
    // breaks-if-wrong: a job past its back-off is claimed again, so it keeps spending its attempts
    expect((await rowOf(lapsedId)).dispatch_attempts).toBe(2);
    expect(lapsed.onNoMatchingAgent).not.toHaveBeenCalled();
  });

  /** A job that runs in its own private image; the registry credentials are sealed with its secrets. */
  const PRIVATE_IMAGE = {
    container: { image: 'registry.example.com/team/private:1' },
    containerRegistryAuth: {
      username: 'ci-bot',
      password: 'registry-sekrit',
      serveraddress: 'registry.example.com',
    },
  };

  it('never scales for a private-image job it cannot open, and fails it on a single node', async () => {
    const jobId = await queueSealedJob('seal-scale-single', {}, PRIVATE_IMAGE);
    // A scaler-only fleet: no agent is connected, so only the scale re-drive offers the job.
    const stale = staleCoordinator('seal-scale-single', { peers: false, agent: false });
    // The premise: what this coordinator reads carries no registry credentials to spawn with.
    const [listed] = await stale.queue.listPending(10);
    expect(listed.secretsUnavailable).toMatch(KEY_MISMATCH);
    expect(listed.jobConfig.container).toEqual(PRIVATE_IMAGE.container);
    expect(listed.jobConfig.containerRegistryAuth).toBeUndefined();

    await stale.dispatcher.retryPendingScaleRequests(100);

    // fails-when: the re-drive spawns the private image without the registry credentials
    expect(stale.onNoMatchingAgent).not.toHaveBeenCalled();
    expect((await rowOf(jobId)).status).toBe(DispatchQueueStatus.Failed);
    expect(stale.onJobFailedPermanently).toHaveBeenCalledTimes(1);
    expect(stale.onJobFailedPermanently.mock.calls[0][3]).toMatch(KEY_MISMATCH);
  });

  it('fails a private-image job no coordinator can open through the scale re-drive alone', async () => {
    const jobId = await queueSealedJob('seal-scale-nobody', {}, PRIVATE_IMAGE);
    // A zero back-off lets each re-drive claim at once, as each would after it.
    const stale = staleCoordinator('seal-scale-nobody', {
      peers: true,
      backoffMs: 0,
      agent: false,
    });

    await stale.dispatcher.retryPendingScaleRequests(100);
    // One claim spends one attempt, and an expiry would report the key mismatch.
    // fails-when: the re-drive scales instead of claiming, so no attempt is ever spent
    const first = await rowOf(jobId);
    expect([first.status, first.dispatch_attempts]).toEqual([DispatchQueueStatus.Pending, 1]);
    expect(first.last_provisioning_error).toMatch(KEY_MISMATCH);

    for (let i = 1; i < MAX_DISPATCH_ATTEMPTS + 2; i++) {
      await stale.dispatcher.retryPendingScaleRequests(100);
    }

    expect(stale.onNoMatchingAgent).not.toHaveBeenCalled();
    expect((await rowOf(jobId)).status).toBe(DispatchQueueStatus.Failed);
    expect(stale.onJobFailedPermanently).toHaveBeenCalledTimes(1);
    expect(stale.onJobFailedPermanently.mock.calls[0][3]).toMatch(KEY_MISMATCH);
  });

  it('claims for no agent only a pending job outside its back-off, of a run still going', async () => {
    const jobId = await queueSealedJob('seal-claim-guards');
    const stale = staleCoordinator('seal-claim-guards', { peers: true, agent: false });
    // breaks-if-wrong: a pending job of a live run, outside any back-off, is claimed
    expect(await stale.queue.claimUnopenableById(jobId)).toBe(true);
    const claimed = await db
      .selectFrom('dispatch_queue')
      .select(['status', 'agent_id'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(claimed).toEqual({ status: DispatchQueueStatus.Dispatched, agent_id: null });
    // fails-when: a row another claimant already took is claimed again
    expect(await stale.queue.claimUnopenableById(jobId)).toBe(false);

    await stale.queue.deferUnopenable(jobId);
    await stale.queue.requeue(jobId, { countAttempt: true });
    // fails-when: the claim ignores this coordinator's back-off
    expect(await stale.queue.claimUnopenableById(jobId)).toBe(false);

    const stoppedId = await queueSealedJob('seal-claim-stopped');
    const { run_id: runId } = await db
      .selectFrom('dispatch_queue')
      .select('run_id')
      .where('id', '=', stoppedId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: 'github:42',
        workflow_name: 'ci',
        status: ExecutionRunStatus.enum.cancelled,
        provider: 'github',
        repo_identifier: 'owner/repo',
        ref: 'main',
        sha: 'abc123',
        started_at: new Date(),
      })
      .execute();
    // fails-when: a job of a cancelled run is claimed and spends an attempt
    expect(await stale.queue.claimUnopenableById(stoppedId)).toBe(false);
    expect((await rowOf(stoppedId)).status).toBe(DispatchQueueStatus.Pending);

    const expiredId = await queueSealedJob('seal-claim-expired');
    await db
      .updateTable('dispatch_queue')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', expiredId)
      .execute();
    // fails-when: an expired job is claimed instead of being left to the expiry sweep
    expect(await stale.queue.claimUnopenableById(expiredId)).toBe(false);
  });

  it('settles the claimed row when the run stops between the claim and the put-back', async () => {
    const jobId = await queueSealedJob('seal-stop-race');
    const { run_id: runId } = await db
      .selectFrom('dispatch_queue')
      .select('run_id')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        routing_key: 'github:42',
        workflow_name: 'ci',
        status: ExecutionRunStatus.enum.running,
        provider: 'github',
        repo_identifier: 'owner/repo',
        ref: 'main',
        sha: 'abc123',
        started_at: new Date(),
      })
      .execute();
    await db
      .insertInto('execution_jobs')
      .values({
        run_id: runId,
        job_id: jobId,
        routing_key: 'github:42',
        job_name: 'build',
        status: ExecutionJobStatus.enum.pending,
      })
      .execute();
    // The peer check runs after the claim and before the put-back: a cancel lands there.
    const stale = staleCoordinator('seal-stop-race', {
      peers: true,
      agent: false,
      hasPeers: async () => {
        await db
          .updateTable('execution_runs')
          .set({ status: ExecutionRunStatus.enum.cancelling })
          .where('run_id', '=', runId)
          .execute();
        return true;
      },
    });

    await stale.dispatcher.retryPendingScaleRequests(100);

    // fails-when: the refused requeue leaves the row dispatched with no agent for a sweep to find
    expect(
      await db
        .selectFrom('dispatch_queue')
        .select(['status', 'agent_id'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: DispatchQueueStatus.Expired, agent_id: null });
    const job = await db
      .selectFrom('execution_jobs')
      .select('status')
      .where('run_id', '=', runId)
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(job.status).toBe(ExecutionJobStatus.enum.cancelled);
    expect(stale.onJobFailedPermanently).not.toHaveBeenCalled();
    expect(stale.onNoMatchingAgent).not.toHaveBeenCalled();
  });

  it('still scales for a private-image job it can open, with the registry credentials', async () => {
    const jobId = await queueSealedJob('seal-scale-open', {}, PRIVATE_IMAGE, keysOf(OLD_KEY));
    const stale = staleCoordinator('seal-scale-open', { peers: true, agent: false });

    await stale.dispatcher.retryPendingScaleRequests(100);

    // breaks-if-wrong: a job whose secrets opened is scaled for with its image and credentials
    expect(stale.onNoMatchingAgent).toHaveBeenCalledTimes(1);
    expect(stale.onNoMatchingAgent.mock.calls[0][1]).toBe(jobId);
    expect(stale.onNoMatchingAgent.mock.calls[0][6]).toEqual({
      image: PRIVATE_IMAGE.container.image,
      authconfig: PRIVATE_IMAGE.containerRegistryAuth,
    });
    expect((await rowOf(jobId)).dispatch_attempts).toBe(0);
  });

  it('honours the cluster_settings back-off override, and falls back without one', async () => {
    const overriddenId = await queueSealedJob('seal-knob-set');
    await db
      .insertInto('cluster_settings')
      .values({ id: 'default', sealed_secrets_retry_backoff_ms: 3_600_000 })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ sealed_secrets_retry_backoff_ms: 3_600_000 }),
      )
      .execute();
    const overridden = staleCoordinator('seal-knob-set', {
      peers: true,
      backoffMs: 0,
      clusterSettings: true,
    });
    await overridden.dispatcher.onAgentAvailable('agent-1');
    await overridden.dispatcher.onAgentAvailable('agent-1');
    // fails-when: the stored override is ignored and the zero fallback lets the job be re-claimed
    expect((await rowOf(overriddenId)).dispatch_attempts).toBe(1);

    await db
      .updateTable('cluster_settings')
      .set({ sealed_secrets_retry_backoff_ms: null })
      .where('id', '=', 'default')
      .execute();
    const fallbackId = await queueSealedJob('seal-knob-unset');
    const fallback = staleCoordinator('seal-knob-unset', {
      peers: true,
      backoffMs: 0,
      clusterSettings: true,
    });
    await fallback.dispatcher.onAgentAvailable('agent-1');
    await fallback.dispatcher.onAgentAvailable('agent-1');
    // breaks-if-wrong: with no stored value the configured default applies
    expect((await rowOf(fallbackId)).dispatch_attempts).toBe(2);
  });

  it('applies the back-off to the by-id and pinned claims', async () => {
    const boundId = await queueSealedJob('seal-by-id');
    const bound = staleCoordinator('seal-by-id', { peers: true });
    // The scaler-bound claim takes the job first, and puts it back: claimed, not sent.
    expect(await bound.dispatcher.dispatchBoundJob('agent-1', boundId)).toBe(false);
    const boundRow = await rowOf(boundId);
    expect([boundRow.status, boundRow.dispatch_attempts]).toEqual([DispatchQueueStatus.Pending, 1]);
    // fails-when: the by-id claim ignores the back-off
    expect(await bound.queue.dequeueById(boundId, ['seal-by-id'], [], 'agent-1')).toBeNull();

    const pinnedId = await queueSealedJob('seal-pinned', { pinnedAgentId: 'agent-1' });
    const pinned = staleCoordinator('seal-pinned', { peers: true });
    await pinned.dispatcher.onAgentAvailable('agent-1');
    expect((await rowOf(pinnedId)).dispatch_attempts).toBe(1);
    // fails-when: the pinned claim ignores the back-off
    expect(await pinned.queue.dequeueByPinnedAgent('agent-1', ['seal-pinned'])).toBeNull();
  });

  it('puts back a job claimed through the pattern and post-filter paths', async () => {
    const patternId = await queueSealedJob('seal-pattern', {
      runsOnPatterns: [{ kind: 'regex', source: '^seal-pattern-host$', flags: '' }],
    });
    const pattern = staleCoordinator('seal-pattern-host', { peers: true });
    await pattern.dispatcher.onAgentAvailable('agent-1');
    await pattern.dispatcher.onAgentAvailable('agent-1');
    // Claimed once through the pattern path, then left alone for the back-off.
    // fails-when: the pattern path ignores the back-off, so the second drain claims it again
    const patternRow = await rowOf(patternId);
    expect([patternRow.status, patternRow.dispatch_attempts]).toEqual([
      DispatchQueueStatus.Pending,
      1,
    ]);

    const postFilterId = await queueSealedJob('seal-post-filter');
    const postFilter = staleCoordinator('seal-post-filter', { peers: true });
    const claimed = await postFilter.queue.dequeueForLabels(
      ['seal-post-filter'],
      [],
      'agent-1',
      () => true,
    );
    // fails-when: the post-filter path hands the dispatcher a job it cannot open without saying so
    expect(claimed?.id).toBe(postFilterId);
    expect(claimed?.secretsUnavailable).toMatch(KEY_MISMATCH);
    await postFilter.queue.deferUnopenable(postFilterId);
    await postFilter.queue.requeue(postFilterId, { countAttempt: true });
    expect(
      await postFilter.queue.dequeueForLabels(['seal-post-filter'], [], 'agent-1', () => true),
    ).toBeNull();
  });

  it('lets the pattern path claim the job again once its back-off lapses', async () => {
    const patternId = await queueSealedJob('seal-pattern-lapsed', {
      runsOnPatterns: [{ kind: 'regex', source: '^seal-pattern-lapsed-host$', flags: '' }],
    });
    // A zero back-off is the input that disables the deferral the test above relies on.
    const pattern = staleCoordinator('seal-pattern-lapsed-host', { peers: true, backoffMs: 0 });
    await pattern.dispatcher.onAgentAvailable('agent-1');
    await pattern.dispatcher.onAgentAvailable('agent-1');
    // breaks-if-wrong: the pattern path still re-claims the job after the back-off, so it can fail
    expect((await rowOf(patternId)).dispatch_attempts).toBe(2);
  });
});
