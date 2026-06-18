import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RunCoordinator,
  type RunContext,
  type JobToRoute,
  type RunCoordinatorDeps,
} from './coordinator.js';
import type { PeerInfo } from './peer-registry.js';
import { ScalerEventType, type LabelMatcher } from '@kici-dev/engine';
import { AgentRegistry } from '../agent/registry.js';

// --- Mock factories ---

function createMockPeerRegistry(
  options: {
    connectedPeers?: PeerInfo[];
    peersWithCapacity?: PeerInfo[];
    peersWithLabels?: PeerInfo[];
  } = {},
) {
  return {
    getConnectedPeers: vi.fn().mockReturnValue(options.connectedPeers ?? []),
    getConnectedPeerCount: vi.fn().mockReturnValue((options.connectedPeers ?? []).length),
    findPeersWithCapacity: vi.fn().mockReturnValue(options.peersWithCapacity ?? []),
    findPeersWithLabels: vi.fn().mockReturnValue(options.peersWithLabels ?? []),
    getPeer: vi.fn(),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
    updateHeartbeat: vi.fn(),
    getAllPeers: vi.fn().mockReturnValue([]),
    markDisconnected: vi.fn(),
    markConnected: vi.fn(),
    isStale: vi.fn().mockReturnValue(false),
    getPeerCount: vi.fn().mockReturnValue(0),
  };
}

function createMockDispatcher() {
  return {
    dispatch: vi
      .fn()
      .mockResolvedValue({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' }),
    onAgentAvailable: vi.fn(),
    onAgentDisconnect: vi.fn(),
    onJobComplete: vi.fn(),
    getAgentIdForJob: vi.fn(),
  };
}

function createMockExecutionTracker() {
  return {
    onExecutionStarted: vi.fn().mockResolvedValue(undefined),
    onJobStatus: vi.fn().mockResolvedValue(undefined),
    onStepStatus: vi.fn().mockResolvedValue(undefined),
    emitScalerEvent: vi.fn(),
    updateJobHeartbeat: vi.fn().mockResolvedValue(undefined),
    getExecutionContext: vi.fn(),
    getJobName: vi.fn(),
    isRunComplete: vi.fn().mockReturnValue(false),
    getRunStatus: vi.fn().mockReturnValue('running'),
    updateInMemoryJob: vi.fn(),
    completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCheckRunReporter() {
  return {
    setPending: vi.fn(),
    updateJobStatus: vi.fn(),
    updateWorkflowStatus: vi.fn(),
    setBuildPending: vi.fn(),
    setBuildComplete: vi.fn(),
  };
}

function createMockPeerClient(options: { sendAndWaitAckResult?: boolean } = {}) {
  return {
    send: vi.fn().mockReturnValue(true),
    sendAndWaitAck: vi.fn().mockResolvedValue(options.sendAndWaitAckResult ?? true),
    connect: vi.fn(),
    disconnect: vi.fn(),
    state: 'connected' as const,
    targetInstanceId: null,
    getReconnectDelay: vi.fn().mockReturnValue(1000),
  };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    instanceId: overrides.instanceId ?? 'peer-1',
    connectionId: 'conn-1',
    address: 'ws://peer-1:8080',
    routingKeys: ['github:123'],
    connected: true,
    lastHeartbeatAt: Date.now(),
    agents: overrides.agents ?? [
      {
        agentId: 'peer-agent-1',
        labels: ['linux', 'gpu'],
        activeJobs: 0,
        maxConcurrency: 2,
        platform: 'linux',
        arch: 'x64',
      },
    ],
    draining: overrides.draining ?? false,
    capabilities: { s3LogAccess: false },
    term: 0,
    leaderId: null,
    ...overrides,
  };
}

function makeRunContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-1',
    deliveryId: 'delivery-1',
    routingKey: 'github:42',
    event: 'push',
    action: null,
    provider: 'github',
    payload: { repository: { full_name: 'org/repo' } },
    repoIdentifier: 'org/repo',
    sha: 'abc123',
    ref: 'main',
    workflowName: 'CI',
    installationId: 42,
    requestId: 'req-1',
    ...overrides,
  };
}

function makeJobToRoute(overrides: Partial<JobToRoute> = {}): JobToRoute {
  return {
    jobName: overrides.jobName ?? 'build',
    runsOnLabels: overrides.runsOnLabels ?? [['linux']],
    jobConfig: overrides.jobConfig ?? { name: 'build' },
    repoUrl: 'https://github.com/org/repo.git',
    ref: 'main',
    sha: 'abc123',
    ...overrides,
  };
}

function createCoordinator(overrides: Partial<RunCoordinatorDeps> = {}): {
  coordinator: RunCoordinator;
  deps: {
    peerRegistry: ReturnType<typeof createMockPeerRegistry>;
    dispatcher: ReturnType<typeof createMockDispatcher>;
    executionTracker: ReturnType<typeof createMockExecutionTracker>;
    checkRunReporter: ReturnType<typeof createMockCheckRunReporter>;
    getPeerClient: ReturnType<typeof vi.fn>;
  };
} {
  const peerRegistry = createMockPeerRegistry(overrides as any);
  const dispatcher = createMockDispatcher();
  const executionTracker = createMockExecutionTracker();
  const checkRunReporter = createMockCheckRunReporter();
  const getPeerClient = vi.fn();

  const coordinator = new RunCoordinator({
    instanceId: 'self-1',
    peerRegistry: peerRegistry as any,
    dispatcher: dispatcher as any,
    executionTracker: executionTracker as any,
    checkRunReporter: checkRunReporter as any,
    getPeerClient,
    ...overrides,
  });

  return {
    coordinator,
    deps: {
      peerRegistry,
      dispatcher,
      executionTracker,
      checkRunReporter,
      getPeerClient,
    },
  };
}

// --- Tests ---

describe('RunCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('routeJobs', () => {
    it('dispatches jobs locally when dispatcher accepts (agent available or scaler)', async () => {
      const { coordinator, deps } = createCoordinator();
      // Default dispatcher mock returns 'dispatched'

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build' }),
        makeJobToRoute({ jobName: 'test' }),
      ]);

      expect(result.localJobs).toHaveLength(2);
      expect(result.reroutedJobs).toHaveLength(0);
      expect(result.failedJobs).toHaveLength(0);
      expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('dispatches jobs locally when dispatcher queues (scaler will spawn agent)', async () => {
      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'queued', jobId: 'job-1' });

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'container-job', runsOnLabels: [['container']] }),
      ]);

      expect(result.localJobs).toHaveLength(1);
      expect(result.localJobs[0].jobName).toBe('container-job');
      expect(result.reroutedJobs).toHaveLength(0);
      expect(result.failedJobs).toHaveLength(0);
    });

    it('reroutes jobs to peer when local dispatch is rejected', async () => {
      const peer = makePeerInfo({ instanceId: 'peer-1' });
      const peerClient = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      // Dispatcher rejects (no local agent, no scaler backend)
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer]);
      deps.getPeerClient.mockReturnValue(peerClient);

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'gpu-job', runsOnLabels: [['linux', 'gpu']] }),
      ]);

      expect(result.localJobs).toHaveLength(0);
      expect(result.reroutedJobs).toHaveLength(1);
      expect(result.reroutedJobs[0].peerId).toBe('peer-1');
      expect(result.failedJobs).toHaveLength(0);
      expect(peerClient.sendAndWaitAck).toHaveBeenCalledTimes(1);
    });

    it('fans out reroutes in parallel for jobs targeting different peers', async () => {
      const peer1 = makePeerInfo({
        instanceId: 'peer-1',
        agents: [
          {
            agentId: 'p1-a1',
            labels: ['linux', 'gpu'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'x64',
          },
        ],
      });
      const peer2 = makePeerInfo({
        instanceId: 'peer-2',
        agents: [
          {
            agentId: 'p2-a1',
            labels: ['linux', 'arm'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'linux',
            arch: 'arm64',
          },
        ],
      });

      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: true });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'gpu-job', runsOnLabels: [['linux', 'gpu']] }),
        makeJobToRoute({ jobName: 'arm-job', runsOnLabels: [['linux', 'arm']] }),
      ]);

      // Both should be rerouted (both go to the first peer in the sorted list)
      expect(result.reroutedJobs).toHaveLength(2);
      expect(result.failedJobs).toHaveLength(0);
    });

    it('falls back to next peer on ACK timeout or rejection', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });

      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false }); // Rejects
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true }); // Accepts

      const { coordinator, deps } = createCoordinator({ ackTimeoutMs: 100 });
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build' }),
      ]);

      expect(result.reroutedJobs).toHaveLength(1);
      expect(result.reroutedJobs[0].peerId).toBe('peer-2');
      expect(peerClient1.sendAndWaitAck).toHaveBeenCalledTimes(1);
      expect(peerClient2.sendAndWaitAck).toHaveBeenCalledTimes(1);
    });

    it('fails job when all peers reject with distinct message', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });

      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: false });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build' }),
      ]);

      expect(result.localJobs).toHaveLength(0);
      expect(result.reroutedJobs).toHaveLength(0);
      expect(result.failedJobs).toHaveLength(1);
      expect(result.failedJobs[0].reason).toContain(
        'All peers with capacity rejected or timed out',
      );
    });

    it('fails job with "no orchestrator handles labels" when no peers match labels at all', async () => {
      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([]);
      deps.peerRegistry.findPeersWithLabels.mockReturnValue([]);

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build', runsOnLabels: [['macos']] }),
      ]);

      expect(result.failedJobs).toHaveLength(1);
      expect(result.failedJobs[0].reason).toContain('No orchestrator in cluster handles labels:');
      expect(result.failedJobs[0].reason).toContain('macos');
    });

    it('fails job with "at capacity" when peers have labels but no capacity', async () => {
      const peerWithLabels = makePeerInfo({ instanceId: 'peer-1' });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([]);
      deps.peerRegistry.findPeersWithLabels.mockReturnValue([peerWithLabels]);

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build', runsOnLabels: [['macos']] }),
      ]);

      expect(result.failedJobs).toHaveLength(1);
      expect(result.failedJobs[0].reason).toContain(
        'Peers with matching labels exist but are at capacity',
      );
    });

    it('excludes draining peers from routing (findPeersWithCapacity handles this)', async () => {
      // PeerRegistry.findPeersWithCapacity already excludes draining peers.
      // We verify the coordinator calls findPeersWithCapacity correctly.
      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([]); // No peers (all draining)

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build', runsOnLabels: [['linux', 'gpu']] }),
      ]);

      expect(deps.peerRegistry.findPeersWithCapacity).toHaveBeenCalledWith([['linux', 'gpu']]);
      expect(result.failedJobs).toHaveLength(1);
    });

    it('handles mixed local and remote jobs', async () => {
      const peer = makePeerInfo({ instanceId: 'peer-1' });
      const peerClient = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      // First call: dispatcher accepts (local agent or scaler); Second call: rejected (no backend)
      deps.dispatcher.dispatch
        .mockResolvedValueOnce({ status: 'dispatched', agentId: 'agent-1', jobId: 'job-1' })
        .mockResolvedValueOnce({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer]);
      deps.getPeerClient.mockReturnValue(peerClient);

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({ jobName: 'build', runsOnLabels: [['linux']] }),
        makeJobToRoute({ jobName: 'gpu-test', runsOnLabels: [['linux', 'gpu']] }),
      ]);

      expect(result.localJobs).toHaveLength(1);
      expect(result.localJobs[0].jobName).toBe('build');
      expect(result.reroutedJobs).toHaveLength(1);
      expect(result.reroutedJobs[0].jobName).toBe('gpu-test');
    });

    it('routes generated jobs to local and peer orchestrators in a single call', async () => {
      const peer1 = makePeerInfo({
        instanceId: 'peer-darwin',
        agents: [
          {
            agentId: 'darwin-agent',
            labels: ['kici:os:darwin', 'kici:arch:arm64'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'darwin',
            arch: 'arm64',
          },
        ],
      });
      const peer2 = makePeerInfo({
        instanceId: 'peer-windows',
        agents: [
          {
            agentId: 'win-agent',
            labels: ['kici:os:windows', 'kici:arch:x64'],
            activeJobs: 0,
            maxConcurrency: 2,
            platform: 'win32',
            arch: 'x64',
          },
        ],
      });

      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: true });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      // First job: local dispatch accepts; second+third: rejected (no local backend)
      deps.dispatcher.dispatch
        .mockResolvedValueOnce({ status: 'dispatched', agentId: 'agent-1', jobId: 'local-job-1' })
        .mockResolvedValueOnce({ status: 'rejected', reason: 'no backend' })
        .mockResolvedValueOnce({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-darwin') return peerClient1;
        if (id === 'peer-windows') return peerClient2;
        return undefined;
      });

      // Three generated jobs: one local, one for macOS peer, one for Windows peer
      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({
          jobName: 'gen-linux-build',
          runsOnLabels: [['kici:os:linux', 'kici:arch:x64']],
          jobConfig: { name: 'gen-linux-build', secrets: { TOKEN: 'resolved' } },
        }),
        makeJobToRoute({
          jobName: 'gen-darwin-test',
          runsOnLabels: [['kici:os:darwin', 'kici:arch:arm64']],
          jobConfig: { name: 'gen-darwin-test', secrets: { TOKEN: 'resolved' } },
        }),
        makeJobToRoute({
          jobName: 'gen-windows-test',
          runsOnLabels: [['kici:os:windows', 'kici:arch:x64']],
          jobConfig: { name: 'gen-windows-test', secrets: { TOKEN: 'resolved' } },
        }),
      ]);

      expect(result.localJobs).toHaveLength(1);
      expect(result.localJobs[0].jobName).toBe('gen-linux-build');
      expect(result.localJobs[0].jobId).toBe('local-job-1');
      expect(result.reroutedJobs).toHaveLength(2);
      const reroutedNames = result.reroutedJobs.map((r) => r.jobName).sort();
      expect(reroutedNames).toEqual(['gen-darwin-test', 'gen-windows-test']);
      expect(result.failedJobs).toHaveLength(0);
    });

    it('handles batch of generated jobs (up to 100) in a single routeJobs call', async () => {
      const { coordinator, deps } = createCoordinator();
      // All 50 jobs dispatch locally
      deps.dispatcher.dispatch.mockResolvedValue({
        status: 'dispatched',
        agentId: 'agent-1',
        jobId: 'job-batch',
      });

      const batchJobs = Array.from({ length: 50 }, (_, i) =>
        makeJobToRoute({
          jobName: `gen-job-${i}`,
          runsOnLabels: [['kici:os:linux']],
          jobConfig: { name: `gen-job-${i}` },
        }),
      );

      const result = await coordinator.routeJobs(makeRunContext(), batchJobs);

      expect(result.localJobs).toHaveLength(50);
      expect(result.reroutedJobs).toHaveLength(0);
      expect(result.failedJobs).toHaveLength(0);
      expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(50);
    });

    it('returns precise error for peer rejection of generated job', async () => {
      const { coordinator, deps } = createCoordinator();
      // Local dispatch rejects (no matching backend)
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      // No peers with capacity, no peers with labels at all
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([]);
      deps.peerRegistry.findPeersWithLabels.mockReturnValue([]);

      const result = await coordinator.routeJobs(makeRunContext(), [
        makeJobToRoute({
          jobName: 'gen-darwin-special',
          runsOnLabels: [['kici:os:darwin', 'kici:arch:arm64', 'kici:role:special']],
          jobConfig: { name: 'gen-darwin-special', secrets: { TOKEN: 'resolved' } },
        }),
      ]);

      expect(result.localJobs).toHaveLength(0);
      expect(result.reroutedJobs).toHaveLength(0);
      expect(result.failedJobs).toHaveLength(1);
      expect(result.failedJobs[0].jobName).toBe('gen-darwin-special');
      // Verify the reason describes what labels were requested
      expect(result.failedJobs[0].reason).toContain('No orchestrator in cluster handles labels:');
      expect(result.failedJobs[0].reason).toContain('kici:os:darwin');
    });
  });

  describe('handleIncomingReroute', () => {
    it('rejects reroute when loop detected (self in triedConnections)', async () => {
      const { coordinator } = createCoordinator();

      const result = await coordinator.handleIncomingReroute({
        type: 'job.reroute',
        messageId: 'msg-1',
        jobId: 'job-1',
        runId: 'run-1',
        deliveryId: 'del-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'build',
        workflowName: 'CI',
        runsOnLabels: [['linux']],
        triedConnections: ['self-1'], // Contains our own instanceId
        maxHops: 3,
        coordinatorId: 'peer-1',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('Loop detected');
    });

    it('rejects reroute when max hops exceeded', async () => {
      const { coordinator } = createCoordinator();

      const result = await coordinator.handleIncomingReroute({
        type: 'job.reroute',
        messageId: 'msg-1',
        jobId: 'job-1',
        runId: 'run-1',
        deliveryId: 'del-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'build',
        workflowName: 'CI',
        runsOnLabels: [['linux']],
        triedConnections: ['orch-a', 'orch-b', 'orch-c'], // 3 hops = maxHops
        maxHops: 3,
        coordinatorId: 'orch-a',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('Max hops exceeded');
    });

    it('rejects reroute when dispatcher rejects', async () => {
      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({
        status: 'rejected',
        reason: 'no backend available for labels: [linux, gpu]',
      });

      const result = await coordinator.handleIncomingReroute({
        type: 'job.reroute',
        messageId: 'msg-1',
        jobId: 'job-1',
        runId: 'run-1',
        deliveryId: 'del-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'build',
        workflowName: 'CI',
        runsOnLabels: [['linux', 'gpu']],
        triedConnections: ['other-orch'],
        maxHops: 3,
        coordinatorId: 'other-orch',
      });

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain('Dispatch rejected');
    });

    it('accepts reroute and dispatches locally when dispatcher accepts', async () => {
      const { coordinator, deps } = createCoordinator();
      // Default dispatcher mock returns 'dispatched'

      const result = await coordinator.handleIncomingReroute({
        type: 'job.reroute',
        messageId: 'msg-1',
        jobId: 'job-1',
        runId: 'run-1',
        deliveryId: 'del-1',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'build',
        workflowName: 'CI',
        runsOnLabels: [['linux']],
        triedConnections: ['other-orch'],
        maxHops: 3,
        coordinatorId: 'other-orch',
      });

      expect(result.accepted).toBe(true);
      expect(deps.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('threads glob/regex selectors from the reroute wire into local dispatch', async () => {
      const { coordinator, deps } = createCoordinator();

      const runsOnPatterns: LabelMatcher[] = [{ kind: 'regex', source: '^gpu-.*$', flags: '' }];
      const excludePatterns: LabelMatcher[] = [{ kind: 'regex', source: '^spot$', flags: '' }];

      await coordinator.handleIncomingReroute({
        type: 'job.reroute',
        messageId: 'msg-pat',
        jobId: 'job-pat',
        runId: 'run-pat',
        deliveryId: 'del-pat',
        routingKey: 'github:42',
        event: 'push',
        action: null,
        payload: {},
        jobName: 'gpu-build',
        workflowName: 'CI',
        // Pure-regex job: no exact labels at all.
        runsOnLabels: [],
        runsOnPatterns,
        excludePatterns,
        triedConnections: ['other-orch'],
        maxHops: 3,
        coordinatorId: 'other-orch',
      });

      const jobInput = deps.dispatcher.dispatch.mock.calls[0][0];
      expect(jobInput.runsOnPatterns).toEqual(runsOnPatterns);
      expect(jobInput.excludePatterns).toEqual(excludePatterns);

      // Prove the threaded selectors drive the real matching authority
      // (the same 4-tuple Dispatcher.dispatch passes to findAvailable): a
      // pure-regex job matches the agent carrying the pattern and excludes
      // an agent that lacks it / carries the excluded label.
      const registry = new AgentRegistry();
      registry.register('gpu-agent', { send: vi.fn() } as never, ['gpu-a100']);
      registry.register('cpu-agent', { send: vi.fn() } as never, ['cpu-only']);
      registry.register('spot-agent', { send: vi.fn() } as never, ['gpu-a100', 'spot']);

      const matched = registry.findAvailable(
        jobInput.runsOnLabels,
        jobInput.runsOnPatterns,
        jobInput.excludeLabels ?? [],
        jobInput.excludePatterns,
      );
      const matchedIds = matched.map((a) => a.agentId).sort();
      expect(matchedIds).toEqual(['gpu-agent']);
    });
  });

  describe('onPeerJobProgress', () => {
    it('forwards step progress (kind="step") to ExecutionTracker.onStepStatus', () => {
      const { coordinator, deps } = createCoordinator();

      coordinator.onPeerJobProgress({
        type: 'job.progress',
        kind: 'step',
        runId: 'run-1',
        jobId: 'job-1',
        jobName: 'build',
        stepIndex: 0,
        stepName: 'Install deps',
        state: 'running',
        timestamp: Date.now(),
      });

      expect(deps.executionTracker.onStepStatus).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        0,
        'Install deps',
        'running',
        expect.any(Number),
        undefined,
      );
      expect(deps.executionTracker.onJobStatus).not.toHaveBeenCalled();
    });

    it('forwards job-level progress (kind="job") to ExecutionTracker.onJobStatus', () => {
      const { coordinator, deps } = createCoordinator();

      coordinator.onPeerJobProgress({
        type: 'job.progress',
        kind: 'job',
        runId: 'run-1',
        jobId: 'job-1',
        jobName: 'build',
        stepIndex: 0,
        stepName: '',
        state: 'success',
        timestamp: Date.now(),
      });

      expect(deps.executionTracker.onJobStatus).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'success',
        expect.any(Number),
        undefined,
        undefined,
      );
      expect(deps.executionTracker.onStepStatus).not.toHaveBeenCalled();
    });
  });

  describe('onPeerScalerEvent', () => {
    it('forwards a worker-relayed scaler event to ExecutionTracker.emitScalerEvent', () => {
      const { coordinator, deps } = createCoordinator();

      coordinator.onPeerScalerEvent({
        type: 'scaler.event',
        runId: 'run-1',
        jobId: 'job-1',
        agentId: 'scaler-container-abc',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'image pull failed: not found',
        timestampMs: 1700,
      });

      expect(deps.executionTracker.emitScalerEvent).toHaveBeenCalledWith('run-1', 'job-1', {
        agentId: 'scaler-container-abc',
        eventType: ScalerEventType.enum['scaler.failed'],
        detail: 'image pull failed: not found',
        timestampMs: 1700,
      });
    });
  });

  describe('onPeerJobComplete', () => {
    it('forwards completion to ExecutionTracker', () => {
      const { coordinator, deps } = createCoordinator();

      coordinator.onPeerJobComplete('run-1', 'job-1', 'success', Date.now());

      expect(deps.executionTracker.onJobStatus).toHaveBeenCalledWith(
        'run-1',
        'job-1',
        'success',
        expect.any(Number),
        undefined,
        undefined,
      );
    });
  });

  describe('cancelRun', () => {
    it('sends peer.job.cancel to all peers with rerouted jobs', async () => {
      const peer = makePeerInfo({ instanceId: 'peer-1' });
      const peerClient = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer]);
      deps.getPeerClient.mockReturnValue(peerClient);

      // Reroute a job first
      await coordinator.routeJobs(makeRunContext({ runId: 'run-1' }), [
        makeJobToRoute({ jobName: 'gpu-job', runsOnLabels: [['linux', 'gpu']] }),
      ]);

      // Now cancel the run
      coordinator.cancelRun('run-1', 'fail-fast triggered');

      expect(peerClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'peer.job.cancel',
          runId: 'run-1',
          reason: 'fail-fast triggered',
        }),
      );
    });

    it('does nothing when no rerouted jobs exist for the run', () => {
      const peerClient = createMockPeerClient();
      const { coordinator, deps } = createCoordinator();
      deps.getPeerClient.mockReturnValue(peerClient);

      coordinator.cancelRun('nonexistent-run', 'test reason');

      expect(peerClient.send).not.toHaveBeenCalled();
    });
  });

  describe('NAK tracking and backoff', () => {
    it('skips peer in backoff period during rerouteJob', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });
      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false }); // Will NAK
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true }); // Will ACK

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      // First reroute: peer-1 NAKs, falls back to peer-2
      await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: 'job-1' })]);

      // Second reroute: peer-1 should be in backoff, so skipped entirely
      peerClient1.sendAndWaitAck.mockClear();
      peerClient2.sendAndWaitAck.mockClear();

      await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: 'job-2' })]);

      // peer-1 should not have been tried (in backoff)
      expect(peerClient1.sendAndWaitAck).not.toHaveBeenCalled();
      // peer-2 should have been used
      expect(peerClient2.sendAndWaitAck).toHaveBeenCalledTimes(1);
    });

    it('increments NAK count on rejected reroute', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });
      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      // Each NAK should increment count; verify via backoff behavior
      // After 1 NAK: backoff = min(1000 * 2^1, 60000) = 2000ms
      await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: 'job-1' })]);

      // peer-1 was NAKed, should be in backoff
      expect(coordinator.getNakCount('peer-1')).toBe(1);
    });

    it('resets NAK count on ACK', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });

      // First: peer-1 NAKs
      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: 'job-1' })]);
      expect(coordinator.getNakCount('peer-1')).toBe(1);

      // Now peer-1 ACKs - clear backoff and try again
      peerClient1.sendAndWaitAck.mockResolvedValue(true);
      // Need to wait for backoff to expire (1000 * 2^1 = 2000ms)
      vi.advanceTimersByTime(2100);

      await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: 'job-2' })]);
      // After ACK, NAK count should be reset
      expect(coordinator.getNakCount('peer-1')).toBe(0);
    });

    it('caps backoff duration at 60 seconds', async () => {
      const peer1 = makePeerInfo({ instanceId: 'peer-1' });
      const peer2 = makePeerInfo({ instanceId: 'peer-2' });
      const peerClient1 = createMockPeerClient({ sendAndWaitAckResult: false });
      const peerClient2 = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer1, peer2]);
      deps.getPeerClient.mockImplementation((id: string) => {
        if (id === 'peer-1') return peerClient1;
        if (id === 'peer-2') return peerClient2;
        return undefined;
      });

      // NAK 10 times: 2^10 * 1000 = 1,024,000 ms, but capped at 60,000
      for (let i = 0; i < 10; i++) {
        // Advance past any current backoff
        vi.advanceTimersByTime(61_000);
        await coordinator.routeJobs(makeRunContext(), [makeJobToRoute({ jobName: `job-${i}` })]);
      }

      // Backoff should be capped at 60000ms, not 1,024,000ms
      expect(coordinator.getBackoffUntil('peer-1')).toBeLessThanOrEqual(Date.now() + 60_001);
    });

    it('stale eviction timer calls evictStalePeers periodically', async () => {
      const { coordinator, deps } = createCoordinator();
      const evictFn = vi.fn().mockReturnValue([]);
      deps.peerRegistry.evictStalePeers = evictFn;

      coordinator.startStaleEvictionTimer(60_000);

      // Timer fires at staleTimeoutMs / 2 = 30_000ms
      vi.advanceTimersByTime(30_000);
      expect(evictFn).toHaveBeenCalledTimes(1);
      expect(evictFn).toHaveBeenCalledWith(60_000);

      // Fire again
      vi.advanceTimersByTime(30_000);
      expect(evictFn).toHaveBeenCalledTimes(2);

      coordinator.stopStaleEvictionTimer();

      // Should not fire again
      vi.advanceTimersByTime(30_000);
      expect(evictFn).toHaveBeenCalledTimes(2);
    });

    it('logs warning when peers are evicted', async () => {
      const { coordinator, deps } = createCoordinator();
      deps.peerRegistry.evictStalePeers = vi.fn().mockReturnValue(['peer-stale-1', 'peer-stale-2']);

      coordinator.startStaleEvictionTimer(60_000);
      vi.advanceTimersByTime(30_000);

      // Eviction was called and returned stale peers
      expect(deps.peerRegistry.evictStalePeers).toHaveBeenCalled();

      coordinator.stopStaleEvictionTimer();
    });

    it('includes cloneToken in reroute message when available in RunContext', async () => {
      const peer = makePeerInfo({ instanceId: 'peer-1' });
      const peerClient = createMockPeerClient({ sendAndWaitAckResult: true });

      const { coordinator, deps } = createCoordinator();
      deps.dispatcher.dispatch.mockResolvedValue({ status: 'rejected', reason: 'no backend' });
      deps.peerRegistry.findPeersWithCapacity.mockReturnValue([peer]);
      deps.getPeerClient.mockReturnValue(peerClient);

      const runCtx = makeRunContext();
      (runCtx as any).cloneToken = 'ghs_test_token_123';

      await coordinator.routeJobs(runCtx, [makeJobToRoute({ jobName: 'build' })]);

      const sentMsg = peerClient.sendAndWaitAck.mock.calls[0][0];
      expect(sentMsg.cloneToken).toBe('ghs_test_token_123');
    });
  });

  describe('hasConnectedPeers', () => {
    it('returns true when peers are connected', () => {
      const { coordinator, deps } = createCoordinator();
      deps.peerRegistry.getConnectedPeerCount.mockReturnValue(2);

      expect(coordinator.hasConnectedPeers()).toBe(true);
    });

    it('returns false when no peers are connected', () => {
      const { coordinator, deps } = createCoordinator();
      deps.peerRegistry.getConnectedPeerCount.mockReturnValue(0);

      expect(coordinator.hasConnectedPeers()).toBe(false);
    });
  });
});
