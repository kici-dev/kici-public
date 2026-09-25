import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionJobStatus, JobRejectReason, ScalerBackendType } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DispatchQueueStatus, JobQueue, type QueuedJobInput } from '../queue/job-queue.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';
import { ScalerManager } from '../scaler/manager.js';
import type { ManagedAgent, ScalerBackend, ScaleResult } from '../scaler/types.js';
import { AgentRegistry } from './registry.js';
import { classifyUnroutable, makeCanRouteLabels } from '../queue/terminalize-unroutable.js';
import { containerSpawnFor, Dispatcher, type DispatchMetrics } from './dispatcher.js';

/**
 * Which agents a `container:` job reaches, on every path that hands a queued
 * job to an agent — against a real Postgres queue and the real predicate
 * (`canAgentRunJob`, fed by `ScalerManager.agentView`), so the claim is the one
 * that ships.
 *
 * The defect these pin: a scaler-started pool agent with no container socket
 * finished its job, drained a queued container job, and failed it on
 * `connect ENOENT /var/run/docker.sock`; the agent the scaler had started in
 * that job's own image then found its job gone and drained unrelated jobs, which
 * ran inside an image they never declared.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_container_routing_test_${process.pid}_${Date.now()}`;

const POOL_LABELS = ['linux', 'docker'];
const RUNTIME_LABEL = 'kici:runtime:docker';
const JOB_IMAGE = 'python:3.12-bookworm';

/** The dispatcher's scale hook, as the scaler implements it. */
type ScaleRequest = NonNullable<ConstructorParameters<typeof Dispatcher>[0]['onNoMatchingAgent']>;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** A container backend double: every spawn succeeds and registers nothing by itself. */
function fakeContainerBackend(): ScalerBackend {
  let active = 0;
  return {
    type: ScalerBackendType.enum.container,
    labelSets: [{ labels: POOL_LABELS, image: 'localhost/kici-agent:test' }],
    maxAgents: 20,
    spawnsOnLocalHost: true,
    getActiveCount: () => active,
    spawn: vi.fn(async (labelSet: string[], agentId: string): Promise<ManagedAgent> => {
      active++;
      return {
        id: agentId,
        labelSet,
        backendRef: agentId,
        spawnedAt: Date.now(),
        state: 'running',
      };
    }),
    destroy: vi.fn(async () => {
      active = Math.max(0, active - 1);
    }),
    shutdownAll: vi.fn(async () => {}),
    reload: vi.fn(() => ({ valid: true })),
  } as unknown as ScalerBackend;
}

describeDb('container-job routing across dispatch paths (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let queue: JobQueue;
  let registry: AgentRegistry;
  let scaler: ScalerManager;
  let dispatcher: Dispatcher;
  let sent: Array<{ agentId: string; jobId: string }>;
  let onNoMatchingAgent: Mock<ScaleRequest>;
  const adminUrl = ADMIN_URL!;

  const jobInput = (overrides: Partial<QueuedJobInput> = {}): QueuedJobInput => ({
    runId: 'run-1',
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux'],
    jobConfig: { timeout: 300 },
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: `delivery-${Math.random()}`,
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
    ...overrides,
  });
  const containerJob = (jobName = 'containerized'): QueuedJobInput =>
    jobInput({ jobName, jobConfig: { timeout: 300, container: JOB_IMAGE } });

  const statusOf = async (jobId: string): Promise<{ status: string; agentId: string | null }> => {
    const row = await db
      .selectFrom('dispatch_queue')
      .select(['status', 'agent_id'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    return { status: row.status, agentId: row.agent_id ?? null };
  };

  /**
   * Start a scaler agent bound to `boundJobId` and register it on both sides —
   * the scaler (which records the binding) and the agent registry (which holds
   * the labels the agent reported). `jobImage` spawns it for a job that names
   * its own image, which the container backend starts inside that image.
   */
  async function scalerAgent(opts: {
    boundJobId: string;
    labels: string[];
    jobImage?: boolean;
  }): Promise<string> {
    await scaler.requestScale(
      POOL_LABELS,
      opts.boundJobId,
      'run-1',
      [],
      undefined,
      undefined,
      opts.jobImage ? { image: JOB_IMAGE } : undefined,
    );
    const spawning = (scaler as unknown as { spawningAgents: Map<string, { boundJobId?: string }> })
      .spawningAgents;
    const agentId = [...spawning].find(([, e]) => e.boundJobId === opts.boundJobId)![0];
    const info = await scaler.onAgentRegistered(agentId, opts.labels);
    registry.register(agentId, mockWs(), opts.labels, 'linux', 'x64', undefined, 1, {
      scalerManaged: true,
      mandatoryLabels: info?.mandatoryLabels ?? [],
    });
    return agentId;
  }

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

  beforeEach(async () => {
    await sql`TRUNCATE TABLE dispatch_queue`.execute(db);
    registry = new AgentRegistry();
    scaler = new ScalerManager({
      instanceId: 'orch-test',
      config: {
        version: 1,
        globalMaxAgents: 20,
        scalers: [
          {
            name: 'pool',
            type: ScalerBackendType.enum.container,
            maxAgents: 20,
            maxConcurrentSpawns: 4,
            labelSets: [{ labels: POOL_LABELS, image: 'localhost/kici-agent:test' }],
          },
        ],
      } as never,
      backends: [{ name: 'pool', backend: fakeContainerBackend() }],
      spawnTimeoutMs: 300_000,
    });
    sent = [];
    onNoMatchingAgent = vi.fn<ScaleRequest>(async (): Promise<ScaleResult> => ({
      action: 'at-capacity',
    }));
    const metrics: DispatchMetrics = {
      incJobsDispatched: vi.fn(),
      setQueueDepth: vi.fn(),
      incScalerRedispatch: vi.fn(),
    };
    dispatcher = new Dispatcher({
      registry,
      queue,
      metrics,
      onDispatch: (agentId, job) => {
        sent.push({ agentId, jobId: job.id });
      },
      onNoMatchingAgent,
      scalerAgentView: (agentId) => scaler.agentView(agentId),
      // Long enough that no deadline fires inside a test.
      getAckTimeoutMs: async () => 3_600_000,
    });
  });

  afterEach(() => {
    for (const { agentId, jobId } of sent) dispatcher.onJobAcked(agentId, jobId);
  });

  describe('drain on a freed slot', () => {
    it('a pool agent with no container runtime leaves a queued container job pending', async () => {
      const jobId = await queue.enqueue(containerJob());
      const agentId = await scalerAgent({ boundJobId: 'earlier-job', labels: POOL_LABELS });

      await dispatcher.onAgentAvailable(agentId);

      // fails-when: the drain hands the container job to a runtime-less pool
      // agent, which fails it on `connect ENOENT /var/run/docker.sock`
      expect(sent).toEqual([]);
      expect(await statusOf(jobId)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });

    it('the same agent still drains a plain job queued behind the container job', async () => {
      const blocked = await queue.enqueue(containerJob());
      const plain = await queue.enqueue(jobInput({ jobName: 'plain' }));
      const agentId = await scalerAgent({ boundJobId: 'earlier-job', labels: POOL_LABELS });

      await dispatcher.onAgentAvailable(agentId);

      // breaks-if-wrong: a non-container job keeps reaching any label match
      expect(sent).toEqual([{ agentId, jobId: plain }]);
      expect(await statusOf(blocked)).toEqual({
        status: DispatchQueueStatus.Pending,
        agentId: null,
      });
    });

    it('a pool agent that reports a container runtime drains the container job', async () => {
      const jobId = await queue.enqueue(containerJob());
      const agentId = await scalerAgent({
        boundJobId: 'earlier-job',
        labels: [...POOL_LABELS, RUNTIME_LABEL],
      });

      await dispatcher.onAgentAvailable(agentId);

      expect(sent).toEqual([{ agentId, jobId }]);
      expect(await statusOf(jobId)).toEqual({ status: DispatchQueueStatus.Dispatched, agentId });
    });

    it('an agent started in a job image drains its own job before an older unrelated one', async () => {
      const unrelated = await queue.enqueue(jobInput({ jobName: 'unrelated' }));
      const own = await queue.enqueue(containerJob());
      const agentId = await scalerAgent({ boundJobId: own, labels: POOL_LABELS, jobImage: true });

      await dispatcher.onAgentAvailable(agentId);

      expect(sent).toEqual([{ agentId, jobId: own }]);
      expect(await statusOf(unrelated)).toEqual({
        status: DispatchQueueStatus.Pending,
        agentId: null,
      });
    });

    it('an agent started in a job image drains nothing once its job is gone', async () => {
      const own = await queue.enqueue(containerJob());
      const unrelated = await queue.enqueue(jobInput({ jobName: 'unrelated' }));
      const runtimeAgent = await scalerAgent({
        boundJobId: 'earlier-job',
        labels: [...POOL_LABELS, RUNTIME_LABEL],
      });
      const imageAgent = await scalerAgent({
        boundJobId: own,
        labels: POOL_LABELS,
        jobImage: true,
      });
      // Another agent took the image agent's job before it registered.
      expect(await dispatcher.dispatchBoundJob(runtimeAgent, own)).toBe(true);

      expect(await dispatcher.dispatchBoundJob(imageAgent, own)).toBe(false);
      await dispatcher.onAgentAvailable(imageAgent);

      // fails-when: the image agent falls back to the generic drain and runs
      // an unrelated job inside a customer image that job never declared
      expect(sent).toEqual([{ agentId: runtimeAgent, jobId: own }]);
      expect(await statusOf(unrelated)).toEqual({
        status: DispatchQueueStatus.Pending,
        agentId: null,
      });
    });
  });

  describe("an operator's own agent", () => {
    /** Register an agent no scaler started, with `labels` and `version`. */
    function operatorAgent(agentId: string, labels: string[], version?: string): string {
      registry.register(agentId, mockWs(), labels, 'linux', 'x64', version);
      return agentId;
    }

    it('leaves a container job pending when the agent reports runtime facts but no runtime', async () => {
      const jobId = await queue.enqueue(containerJob());
      const agentId = operatorAgent('static-new', POOL_LABELS, '0.10.0');

      await dispatcher.onAgentAvailable(agentId);

      // fails-when: an operator's 0.10.0 agent with no socket drains the job
      // and fails it on `connect ENOENT`
      expect(sent).toEqual([]);
      expect(await statusOf(jobId)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });

    it('still hands the container job to a 0.9.1 agent that reports no docker label', async () => {
      // A released 0.9.x agent pointed at a remote DOCKER_HOST reports no
      // docker label and runs container jobs through its client.
      const jobId = await queue.enqueue(containerJob());
      const agentId = operatorAgent('static-old', POOL_LABELS, '0.9.1');

      await dispatcher.onAgentAvailable(agentId);

      // breaks-if-wrong: an agent whose missing label proves nothing keeps the job
      expect(sent).toEqual([{ agentId, jobId }]);
    });

    it('gives an agent that says it runs in a job image no job, with no scaler record', async () => {
      // An image agent the scaler no longer tracks reconnects: only its own
      // `kici:runtime:job-image` label says what it is.
      const plain = await queue.enqueue(jobInput({ jobName: 'plain' }));
      const agentId = operatorAgent('scaler-container-orphan', [
        ...POOL_LABELS,
        'kici:runtime:job-image',
      ]);

      await dispatcher.onAgentAvailable(agentId);
      expect(await dispatcher.redrivePendingToConnectedAgents()).toBe(0);

      // fails-when: the orphaned image agent drains an unrelated job into the
      // customer image it runs in
      expect(sent).toEqual([]);
      expect(await statusOf(plain)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });
  });

  describe('unroutable reporting on an orchestrator with no scaler', () => {
    /** The routability predicate the probe and the expiry sweep share, with no scaler wired. */
    const canRoute = () => makeCanRouteLabels({ registry });

    it('names the missing runtime on a container job no connected agent can start', async () => {
      const jobId = await queue.enqueue(containerJob());
      registry.register('static-new', mockWs(), POOL_LABELS, 'linux', 'x64', '0.10.0');

      const [candidate] = await queue.listUnroutableCandidates(10);
      const verdict = classifyUnroutable(candidate!, canRoute());

      // fails-when: the probe reads the job routable because an agent matches
      // its labels, and the job waits silently for the queue timeout
      expect(candidate!.id).toBe(jobId);
      expect(verdict.unroutable).toBe(true);
      expect(verdict.errorMessage).toContain(
        'report neither kici:runtime:docker nor kici:runtime:podman',
      );
    });

    it('settles the same job unroutable at queue expiry', async () => {
      const jobId = await queue.enqueue(containerJob());
      registry.register('static-new', mockWs(), POOL_LABELS, 'linux', 'x64', '0.10.0');
      await db
        .updateTable('dispatch_queue')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', jobId)
        .execute();

      const [expired] = await queue.markExpired();
      const verdict = classifyUnroutable(expired!, canRoute());

      expect(verdict.status).toBe(ExecutionJobStatus.enum.unroutable);
      expect(verdict.errorMessage).toContain("No connected agent can start this job's container");
    });

    it("names other jobs' images when the only matching agent runs inside one", async () => {
      await queue.enqueue(jobInput({ jobName: 'plain' }));
      registry.register(
        'scaler-container-orphan',
        mockWs(),
        [...POOL_LABELS, 'kici:runtime:job-image'],
        'linux',
        'x64',
        '0.10.0',
      );

      const [candidate] = await queue.listUnroutableCandidates(10);
      const verdict = classifyUnroutable(candidate!, canRoute());

      // fails-when: the plain job is told that no connected agent matches its
      // runsOn, while an agent carrying those labels is connected
      expect(verdict.status).toBe(ExecutionJobStatus.enum.unroutable);
      expect(verdict.errorMessage).toContain("were each started inside another job's image");

      // breaks-if-wrong: an ordinary agent carrying the labels routes the job
      registry.register('static-plain', mockWs(), POOL_LABELS, 'linux', 'x64', '0.10.0');
      const [again] = await queue.listUnroutableCandidates(10);
      expect(classifyUnroutable(again!, canRoute()).unroutable).toBe(false);
    });

    it('reads a container job routable once an agent reports a runtime', async () => {
      await queue.enqueue(containerJob());
      registry.register('static-new', mockWs(), POOL_LABELS, 'linux', 'x64', '0.10.0');
      registry.register(
        'static-docker',
        mockWs(),
        [...POOL_LABELS, RUNTIME_LABEL],
        'linux',
        'x64',
        '0.10.0',
      );

      const [candidate] = await queue.listUnroutableCandidates(10);

      // breaks-if-wrong: a fleet that can run the job is never reported unroutable
      expect(classifyUnroutable(candidate!, canRoute()).unroutable).toBe(false);
    });
  });

  describe('bound claim at registration', () => {
    it('the agent started in a job image claims its own job with no runtime label', async () => {
      const own = await queue.enqueue(containerJob());
      const agentId = await scalerAgent({ boundJobId: own, labels: POOL_LABELS, jobImage: true });

      // breaks-if-wrong: the job-image agent reports no runtime (it runs the
      // steps itself), and the gate must still let it run its own job
      expect(await dispatcher.dispatchBoundJob(agentId, own)).toBe(true);
      expect(await statusOf(own)).toEqual({ status: DispatchQueueStatus.Dispatched, agentId });
    });
  });

  describe('direct dispatch', () => {
    it('skips a runtime-less pool agent and asks the scaler for the job image', async () => {
      const agentId = await scalerAgent({ boundJobId: 'earlier-job', labels: POOL_LABELS });

      const result = await dispatcher.dispatch(containerJob());

      expect(result.status).toBe('queued');
      expect(sent).toEqual([]);
      // The 7th argument is the per-job-image spawn: the job gets its own agent.
      expect(onNoMatchingAgent.mock.calls[0][6]).toEqual(
        containerSpawnFor({ container: JOB_IMAGE }),
      );
      expect(registry.get(agentId)?.activeJobs).toBe(0);
    });

    it('dispatches a plain job to the same agent', async () => {
      const agentId = await scalerAgent({ boundJobId: 'earlier-job', labels: POOL_LABELS });

      const result = await dispatcher.dispatch(jobInput({ jobName: 'plain' }));

      expect(result).toMatchObject({ status: 'dispatched', agentId });
    });
  });

  describe('periodic re-drive onto connected agents', () => {
    it('does not place a container job on a runtime-less pool agent', async () => {
      const jobId = await queue.enqueue(containerJob());
      await scalerAgent({ boundJobId: 'earlier-job', labels: POOL_LABELS });

      expect(await dispatcher.redrivePendingToConnectedAgents()).toBe(0);
      expect(await statusOf(jobId)).toEqual({ status: DispatchQueueStatus.Pending, agentId: null });
    });

    it('places it on an agent that reports a container runtime', async () => {
      const jobId = await queue.enqueue(containerJob());
      const agentId = await scalerAgent({
        boundJobId: 'earlier-job',
        labels: [...POOL_LABELS, RUNTIME_LABEL],
      });

      expect(await dispatcher.redrivePendingToConnectedAgents()).toBe(1);
      expect(await statusOf(jobId)).toEqual({ status: DispatchQueueStatus.Dispatched, agentId });
    });
  });

  describe('redispatch after a rejection', () => {
    it('re-offers a rejected container job to the scaler, not to a runtime-less pool agent', async () => {
      const jobId = await queue.enqueue(containerJob());
      const runtimeAgent = await scalerAgent({
        boundJobId: 'earlier-job-a',
        labels: [...POOL_LABELS, RUNTIME_LABEL],
      });
      await scalerAgent({ boundJobId: 'earlier-job-b', labels: POOL_LABELS });
      expect(await dispatcher.dispatchBoundJob(runtimeAgent, jobId)).toBe(true);

      // The runtime agent refuses it busy and is held out of routing.
      await dispatcher.onJobRejected(runtimeAgent, jobId, JobRejectReason.enum.busy);

      // fails-when: the requeued job is claimed by the runtime-less pool agent
      expect(sent).toEqual([{ agentId: runtimeAgent, jobId }]);
      expect(await statusOf(jobId)).toMatchObject({ status: DispatchQueueStatus.Pending });
      const scaleCall = onNoMatchingAgent.mock.calls.find((call) => call[1] === jobId);
      expect(scaleCall?.[6]).toEqual(containerSpawnFor({ container: JOB_IMAGE }));
    });
  });
});
