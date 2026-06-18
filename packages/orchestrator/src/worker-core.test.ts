import { describe, it, expect, vi, beforeEach, beforeAll, type Mock } from 'vitest';

// Mock external dependencies to avoid starting real servers/connections
vi.mock('@hono/node-server', () => ({
  serve: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('@hono/node-ws', () => ({
  createNodeWebSocket: vi.fn(() => ({
    injectWebSocket: vi.fn(),
    upgradeWebSocket: vi.fn(() => vi.fn()),
  })),
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
import { createAgentWsHandler } from './ws/agent-handler.js';

function createWorkerConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'independent',
    port: 4000,
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
      coordinatorUrl: 'http://coordinator:4000',
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

  it('creates PeerClient with coordinatorUrl from config', async () => {
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

  it('throws when coordinatorUrl is missing', async () => {
    const config = createWorkerConfig({
      cluster: {
        ...createWorkerConfig().cluster,
        coordinatorUrl: undefined,
      },
    });
    const { bootstrapWorker } = await import('./worker-core.js');

    await expect(bootstrapWorker(config)).rejects.toThrow('cluster.coordinatorUrl');
  });

  it('connects PeerClient as the final step', async () => {
    const config = createWorkerConfig();
    const { bootstrapWorker } = await import('./worker-core.js');

    await bootstrapWorker(config);

    // PeerClient.connect() should have been called
    expect(mockPeerClientConnect).toHaveBeenCalledTimes(1);
  });
});
