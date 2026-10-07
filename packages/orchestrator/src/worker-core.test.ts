import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, type Mock } from 'vitest';

// Mock external dependencies to avoid starting real servers/connections
vi.mock('@hono/node-server', () => ({
  serve: vi.fn(() => ({ close: vi.fn() })),
  upgradeWebSocket: vi.fn(() => vi.fn()),
}));

const mockPeerClientConnect = vi.fn();
const mockPeerClientDisconnect = vi.fn();
const mockPeerClientSend = vi.fn();

class MockPeerClient {
  connect = mockPeerClientConnect;
  disconnect = mockPeerClientDisconnect;
  send = mockPeerClientSend;
  state = 'disconnected';
  targetInstanceId = null;
  constructor(public readonly options: any) {}
}

vi.mock('./cluster/index.js', async () => {
  const actual = await vi.importActual<typeof import('./cluster/index.js')>('./cluster/index.js');
  return {
    ...actual,
    PeerClient: MockPeerClient,
  };
});

vi.mock('./scaler/index.js', () => ({
  ScalerManager: vi.fn(),
  ContainerScalerBackend: { create: vi.fn() },
  BareMetalScalerBackend: vi.fn(),
  FirecrackerScalerBackend: vi.fn(),
  loadScalerConfig: vi.fn(),
  detectLabelSetOverlaps: vi.fn(() => []),
}));

vi.mock('./ws/agent-handler.js', () => ({
  createAgentWsHandler: vi.fn(() => ({})),
}));

class MockAgentHeartbeatMonitor {
  start = vi.fn();
  stop = vi.fn();
  constructor(_opts: any) {}
}

vi.mock('./ws/agent-heartbeat.js', () => ({
  AgentHeartbeatMonitor: MockAgentHeartbeatMonitor,
}));

vi.mock('@kici-dev/shared', async () => {
  const actual = await vi.importActual<typeof import('@kici-dev/shared')>('@kici-dev/shared');
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    initTelemetry: vi.fn(),
    // Prevent accumulating process signal handlers across tests
    setupGracefulShutdown: vi.fn(() => ({ shutdown: vi.fn() })),
  };
});

import type { AppConfig } from './config.js';
import { ScalerReloadOutcome } from '@kici-dev/engine';
import { createAgentWsHandler } from './ws/agent-handler.js';

function createWorkerConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'independent',
    port: 4000,
    // Loopback with `agentAuth: 'none'` below is the one supported pairing:
    // `assertAgentAuthBindSafe` refuses a routable or wildcard bind under it.
    host: '127.0.0.1',
    basePath: '/',
    databaseUrl: '',
    lockfileCacheMax: 500,
    lockfileCacheTtlMs: 3_600_000,
    queueMaxDepth: 1000,
    queueTimeoutMs: 3_600_000,
    workerConcurrency: 5,
    cacheStorageS3Prefix: 'kici-cache/',
    cacheTtlDays: 30,
    cacheBuildTimeoutMs: 600_000,
    cacheMaxTarballBytes: 524_288_000,
    staleDetectorScanIntervalMs: 60_000,
    staleDetectorThresholdMultiplier: 2,
    jobHeartbeatIntervalMs: 60_000,
    agentAuth: 'none',
    agentTokenTtlMs: 3_600_000,
    logLevel: 'info',
    nodeEnv: 'test',
    instanceId: 'test-worker-1',
    cluster: {
      instanceId: 'test-worker-1',
      role: 'worker',
      coordinatorUrls: ['http://coordinator:4000'],
      joinToken: 'test-join-token',
      credentialFile: '/tmp/test-credential',
      autoRotateCredentials: false,
      peers: [],
      raftElectionTimeoutMinMs: 5000,
      raftElectionTimeoutMaxMs: 10000,
      raftHeartbeatMs: 2000,
      peerHeartbeatIntervalMs: 30000,
      peerMaxReconnectDelayMs: 60000,
      peerStaleTimeoutMs: 60000,
    },
    ...overrides,
  } as AppConfig;
}

describe('bootstrapWorker', () => {
  // Warm the heavy worker-core module graph once, outside any per-test timer:
  // the cold dynamic import dominates the first test and would otherwise have
  // to fit inside that test's budget. Generous hook timeout because the cold
  // transform + load can take >10s under concurrent suite load.
  beforeAll(async () => {
    await import('./worker-core.js');
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Run one named step of the graceful shutdown each bootstrap registered. */
  async function runShutdownStep(name: string): Promise<void> {
    const { setupGracefulShutdown } = await import('@kici-dev/shared');
    for (const [opts] of (setupGracefulShutdown as unknown as Mock).mock.calls) {
      const steps = (opts as { steps: Array<{ name: string; fn: () => unknown }> }).steps;
      await steps.find((step) => step.name === name)?.fn();
    }
  }

  // Each bootstrap installs a real SIGHUP listener; its own shutdown step removes it.
  afterEach(() => runShutdownStep('Removing the SIGHUP listener'));

  // fails-when: the worker installs no SIGHUP listener (Node.js then exits on the
  // signal), or wires no answer to a coordinator's scaler reload request
  // breaks-if-wrong: the worker's shutdown still removes the listener
  it('reloads its scaler config on SIGHUP instead of exiting, and answers a reload request', async () => {
    const before = process.listenerCount('SIGHUP');
    const { bootstrapWorker } = await import('./worker-core.js');

    const subsystems = await bootstrapWorker(createWorkerConfig());

    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    const peerClient = subsystems.peerClient as unknown as MockPeerClient;
    expect(await peerClient.options.onScalerReloadRequest()).toEqual({
      outcome: ScalerReloadOutcome.enum['not-configured'],
    });

    await runShutdownStep('Removing the SIGHUP listener');
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });

  it('creates PeerClient with coordinatorUrls from config', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');

    const subsystems = await bootstrapWorker(config);

    // PeerClient was constructed with the coordinator URL
    const peerClient = subsystems.peerClient as unknown as MockPeerClient;
    expect(peerClient.options.url).toBe('ws://coordinator:4000/ws/peer');
    expect(peerClient.options.instanceId).toBe('test-worker-1');
    expect(peerClient.options.joinToken).toBe('test-join-token');
  });

  it('creates InMemoryExecutionTracker, not PG ExecutionTracker', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');
    const { InMemoryExecutionTracker } = await import('./worker/in-memory-execution-tracker.js');

    const subsystems = await bootstrapWorker(config);

    expect(subsystems.executionTracker).toBeInstanceOf(InMemoryExecutionTracker);
  });

  it('creates StaticAgentTokenStore, not PG AgentTokenStore', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');
    const { StaticAgentTokenStore } = await import('./worker/static-agent-token-store.js');

    const subsystems = await bootstrapWorker(config);

    expect(subsystems.tokenStore).toBeInstanceOf(StaticAgentTokenStore);
  });

  it('does not import or construct Kysely pool', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');

    const subsystems = await bootstrapWorker(config);

    // Worker subsystems should not have db or pool properties
    expect(subsystems).not.toHaveProperty('db');
    expect(subsystems).not.toHaveProperty('pool');
  });

  it('creates agent WS handler for local agent connections', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');

    await bootstrapWorker(config);

    expect(createAgentWsHandler).toHaveBeenCalledTimes(1);
    const handlerDeps = (createAgentWsHandler as Mock).mock.calls[0][0];
    expect(handlerDeps.registry).toBeDefined();
    expect(handlerDeps.dispatcher).toBeDefined();
    expect(handlerDeps.agentAuthMode).toBe('none');
  });

  it('onJobReroute acks a duplicate re-dispatch as accepted (idempotent no-op)', async () => {
    // A rerouted job reuses a preassigned jobId; a concurrent reroute (or a
    // replayed job.reroute) can make dispatch report the dispatch_queue row
    // already exists ('duplicate'). The worker must ack accepted:true — reporting
    // accepted:false would wrongly drive the owning coordinator to reroute an
    // already-handled job. Locks in the correct mapping for the duplicate status.
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');
    const subsystems = await bootstrapWorker(config);

    const peerClient = subsystems.peerClient as unknown as MockPeerClient;
    const onJobReroute = peerClient.options.onJobReroute as (msg: unknown) => Promise<void>;

    vi.spyOn(subsystems.dispatcher, 'dispatch').mockResolvedValue({
      status: 'duplicate',
      jobId: 'reroute-job-1',
    });

    mockPeerClientSend.mockClear();
    await onJobReroute({
      type: 'job.reroute',
      messageId: 'm-1',
      jobId: 'reroute-job-1',
      runId: 'run-1',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: [['linux']],
      deliveryId: 'd-1',
      routingKey: 'github:42',
    });

    expect(mockPeerClientSend).toHaveBeenCalledWith({
      type: 'job.reroute.ack',
      messageId: 'm-1',
      accepted: true,
    });
  });

  it('a coordinator cancel removes a rerouted job still queued on the worker', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');
    const subsystems = await bootstrapWorker(config);
    const peerClient = subsystems.peerClient as unknown as MockPeerClient;
    const onJobReroute = peerClient.options.onJobReroute as (msg: unknown) => Promise<void>;
    const onJobCancel = peerClient.options.onJobCancel as (msg: unknown) => void;

    await onJobReroute({
      type: 'job.reroute',
      messageId: 'm-3',
      jobId: 'reroute-job-3',
      runId: 'run-3',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: [['linux']],
      deliveryId: 'd-3',
      routingKey: 'github:42',
    });
    expect(subsystems.jobQueue.isPending('reroute-job-3')).toBe(true);

    mockPeerClientSend.mockClear();
    onJobCancel({ type: 'peer.job.cancel', runId: 'run-3', jobId: 'reroute-job-3', reason: 'x' });

    // fails-when: the worker's cancel receiver is wired without the queued-job release
    await vi.waitFor(() => expect(subsystems.jobQueue.isPending('reroute-job-3')).toBe(false));
    expect(await subsystems.jobQueue.getFullJobById('reroute-job-3')).toBeNull();
    // The coordinator already decided: the worker reports nothing for the job.
    expect(mockPeerClientSend).not.toHaveBeenCalled();
  });

  describe('a rerouted global job carrying only the workflow repo clone token', () => {
    /** Drive one reroute of a global job whose source clone token could not be minted. */
    async function rerouteGlobal(sourceRepoUrl: string) {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dataDir = await mkdtemp(join(tmpdir(), 'kici-worker-refusal-'));
      const { bootstrapWorker } = await import('./worker-core.js');
      const subsystems = await bootstrapWorker(
        createWorkerConfig({ dataDir } as Partial<AppConfig>),
      );
      const peerClient = subsystems.peerClient as unknown as MockPeerClient;
      const onJobReroute = peerClient.options.onJobReroute as (msg: unknown) => Promise<void>;
      const dispatch = vi
        .spyOn(subsystems.dispatcher, 'dispatch')
        .mockResolvedValue({ status: 'dispatched', agentId: 'a1', jobId: 'reroute-job-2' });
      mockPeerClientSend.mockClear();
      await onJobReroute({
        type: 'job.reroute',
        messageId: 'm-2',
        jobId: 'reroute-job-2',
        runId: 'run-2',
        workflowName: 'ci',
        jobName: 'build',
        runsOnLabels: [['linux']],
        deliveryId: 'd-2',
        routingKey: 'github:42',
        repoUrl: sourceRepoUrl,
        workflowCloneToken: 'wf-tok',
        jobConfig: {
          isGlobalWorkflow: true,
          workflowRepoIdentifier: 'org/ci',
          workflowRepoUrl: 'https://github.com/org/ci.git',
        },
      });
      const sent = mockPeerClientSend.mock.calls.map((c) => c[0] as Record<string, any>);
      return { dispatch, sent };
    }

    it('fails the job with an error naming both repos when the source is on another host', async () => {
      // fails-when: the job reaches an agent, which would clone org/app with the org/ci token
      const { dispatch, sent } = await rerouteGlobal('https://git.forge.example/org/app.git');

      expect(dispatch).not.toHaveBeenCalled();
      expect(sent).toContainEqual({ type: 'job.reroute.ack', messageId: 'm-2', accepted: true });
      const failed = sent.find((m) => m.type === 'job.progress' && m.state === 'failed');
      expect(failed?.jobId).toBe('reroute-job-2');
      expect(String(failed?.data?.error)).toContain('org/app');
      expect(String(failed?.data?.error)).toContain('org/ci');
    });

    it('dispatches the job when both repos share a host', async () => {
      // breaks-if-wrong: a same-host global job with only the workflow token must still run
      const { dispatch, sent } = await rerouteGlobal('https://github.com/org/app.git');

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(sent.some((m) => m.type === 'job.progress')).toBe(false);
    });
  });

  it('throws when role is not worker', async () => {
    const config = createWorkerConfig({
      cluster: {
        ...createWorkerConfig().cluster,
        role: 'coordinator' as any,
      },
    });
    const { bootstrapWorker } = await import('./worker-core.js');

    await expect(bootstrapWorker(config)).rejects.toThrow('expected "worker"');
  });

  it('throws when coordinatorUrls is empty', async () => {
    const config = createWorkerConfig({
      cluster: {
        ...createWorkerConfig().cluster,
        coordinatorUrls: [],
      },
    });
    const { bootstrapWorker } = await import('./worker-core.js');

    await expect(bootstrapWorker(config)).rejects.toThrow('cluster.coordinatorUrls');
  });

  it('connects PeerClient as the final step', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');

    await bootstrapWorker(config);

    // PeerClient.connect() should have been called
    expect(mockPeerClientConnect).toHaveBeenCalledTimes(1);
  });
});

describe('resolveWorkerAgentTokenTtlMs', () => {
  it('returns the pulled agent_token_ttl_ms once a snapshot has landed', async () => {
    const { resolveWorkerAgentTokenTtlMs } = await import('./worker-core.js');
    expect(
      resolveWorkerAgentTokenTtlMs(
        {
          settings: {
            agentTokenTtlMs: 33_000,
            firecrackerApiSocketWaitMs: 1,
            concurrencyWaitTimeoutMs: 1,
          },
        },
        3_600_000,
      ),
    ).toBe(33_000);
  });

  it('falls back to the config default until the first pull lands (null snapshot)', async () => {
    const { resolveWorkerAgentTokenTtlMs } = await import('./worker-core.js');
    expect(resolveWorkerAgentTokenTtlMs(null, 3_600_000)).toBe(3_600_000);
  });
});

describe('resolveWorkerFirecrackerApiSocketWaitMs', () => {
  it('returns the pulled firecracker_api_socket_wait_ms', async () => {
    const { resolveWorkerFirecrackerApiSocketWaitMs } = await import('./worker-core.js');
    expect(
      resolveWorkerFirecrackerApiSocketWaitMs(
        {
          settings: {
            agentTokenTtlMs: 1,
            firecrackerApiSocketWaitMs: 45_000,
            concurrencyWaitTimeoutMs: 1,
          },
        },
        30_000,
      ),
    ).toBe(45_000);
  });

  it('falls back to the config default until the first pull lands', async () => {
    const { resolveWorkerFirecrackerApiSocketWaitMs } = await import('./worker-core.js');
    expect(resolveWorkerFirecrackerApiSocketWaitMs(null, 30_000)).toBe(30_000);
  });
});

describe('resolveWorkerConcurrencyWaitTimeoutMs', () => {
  it('returns the pulled concurrency_wait_timeout_ms', async () => {
    // fails-when: a worker ignores the pulled fleet-wide wait.
    const { resolveWorkerConcurrencyWaitTimeoutMs } = await import('./worker-core.js');
    expect(
      resolveWorkerConcurrencyWaitTimeoutMs(
        {
          settings: {
            agentTokenTtlMs: 1,
            firecrackerApiSocketWaitMs: 1,
            concurrencyWaitTimeoutMs: 900_000,
          },
        },
        3_600_000,
      ),
    ).toBe(900_000);
  });

  it('falls back to the config default until the first pull lands', async () => {
    // breaks-if-wrong: a worker with no snapshot yet still sends a wait.
    const { resolveWorkerConcurrencyWaitTimeoutMs } = await import('./worker-core.js');
    expect(resolveWorkerConcurrencyWaitTimeoutMs(null, 3_600_000)).toBe(3_600_000);
  });
});

describe('bootstrapWorker agent-bind guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['0.0.0.0', '::', '192.168.1.40'])(
    'refuses to start with agent auth disabled on bind %s',
    async (host) => {
      // A worker serves the same agent WebSocket endpoint a coordinator does,
      // so a credential-free registration surface here dispatches jobs with
      // resolved secrets to whoever opened the socket.
      const config = createWorkerConfig({ agentAuth: 'none', host });
      const { bootstrapWorker } = await import('./worker-core.js');

      await expect(bootstrapWorker(config)).rejects.toThrow(/KICI_AGENT_AUTH=none/);
    },
  );

  it.each(['127.0.0.1', 'localhost', '::1'])(
    'still starts with agent auth disabled on the machine-local bind %s',
    async (host) => {
      const config = createWorkerConfig({ agentAuth: 'none', host });
      const { bootstrapWorker } = await import('./worker-core.js');

      await expect(bootstrapWorker(config)).resolves.toBeDefined();
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.40', '127.0.0.1'])(
    'starts on bind %s under token auth',
    async (host) => {
      // A guard that refused every wildcard bind would take out every
      // token-authenticated orchestrator in the fleet.
      const config = createWorkerConfig({ agentAuth: 'token', host });
      const { bootstrapWorker } = await import('./worker-core.js');

      await expect(bootstrapWorker(config)).resolves.toBeDefined();
    },
  );
});
