import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrphanRecovery } from './orphan-recovery.js';
import { PeerRegistry } from './peer-registry.js';
import type { RaftNode } from './raft.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * Cluster-settings reader stub. `getNumber` returns `override` when provided,
 * else the caller's `fallback` (the config.ts default) — mirroring the real
 * reader's null-column behavior.
 */
function makeClusterSettingsStub(override?: number): ClusterSettingsReader {
  return {
    getNumber: async (_col: string, fallback: number) => override ?? fallback,
  } as unknown as ClusterSettingsReader;
}

function createMockRaft(isLeader = false): RaftNode {
  return {
    isLeader: vi.fn(() => isLeader),
    getLeaderId: vi.fn(),
    getCurrentTerm: vi.fn(() => 1),
  } as unknown as RaftNode;
}

function createMockExecutionTracker(): ExecutionTracker {
  return {
    updateInMemoryJob: vi.fn(),
    forwardJobTerminalStatus: vi.fn(),
    emitInfraEvent: vi.fn(),
    completeRunIfAllJobsTerminal: vi.fn().mockResolvedValue(undefined),
    cancelStepsForJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as ExecutionTracker;
}

/**
 * Create a mock Kysely DB with configurable query results.
 * Each selectFrom call creates a fresh chain so query results are
 * delivered in the correct order regardless of method chaining.
 *
 * NOTE: This test uses a specialized mock (sequential selectFrom results
 * via a call counter) instead of the shared createMockDb() from
 * '../__test-helpers__/mock-db.js' because OrphanRecovery calls selectFrom
 * multiple times in a single scan and needs different results each time.
 */
function createMockDb(config: {
  staleRuns?: any[];
  jobs?: any[];
  /**
   * Row returned by the `hasRecentProgress` aggregate (the 2nd `selectFrom` of
   * a recovery pass). Undefined (the default) means "no progress recorded", so
   * the run stays orphan-eligible — the shape every pre-existing test assumes.
   */
  progress?: {
    last_heartbeat_at?: Date | null;
    completed_at?: Date | null;
    started_at?: Date | null;
  };
}) {
  const staleRuns = config.staleRuns ?? [];
  const jobs = config.jobs ?? [];

  // Per recovery pass the orchestrator issues three reads in order:
  //   0 — the stale-run candidate list (`execute`)
  //   1 — the run's last-progress aggregate (`executeTakeFirst`)
  //   2 — the run's jobs (`execute`)
  const queryResults = [staleRuns, [], jobs];
  let selectFromCallIndex = 0;

  const selectFromFn = vi.fn(() => {
    const resultIndex = selectFromCallIndex++;
    const results = queryResults[resultIndex] ?? [];
    const takeFirst = resultIndex === 1 ? config.progress : undefined;

    const chain: any = {};
    for (const method of ['select', 'where', 'execute', 'executeTakeFirst']) {
      chain[method] = vi.fn((..._args: any[]) => {
        if (method === 'execute') return Promise.resolve(results);
        if (method === 'executeTakeFirst') return Promise.resolve(takeFirst);
        return chain;
      });
    }
    return chain;
  });

  const updateTableFn = vi.fn(() => {
    const chain: any = {};
    for (const method of ['set', 'where', 'execute']) {
      chain[method] = vi.fn((..._args: any[]) => {
        if (method === 'execute') return Promise.resolve([]);
        return chain;
      });
    }
    return chain;
  });

  const db: any = {
    selectFrom: selectFromFn,
    updateTable: updateTableFn,
  };

  return {
    db,
    selectFrom: selectFromFn,
    updateTable: updateTableFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('OrphanRecovery', () => {
  let peerRegistry: PeerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T12:00:00Z'));
    peerRegistry = new PeerRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Non-leader guard ────────────────────────────────────────────

  describe('non-leader behavior', () => {
    it('should skip scan entirely when not leader', async () => {
      const raft = createMockRaft(false);
      const mockDb = createMockDb({ staleRuns: [] });
      const tracker = createMockExecutionTracker();

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      expect(raft.isLeader).toHaveBeenCalled();
      // DB should NOT be queried
      expect(mockDb.selectFrom).not.toHaveBeenCalled();

      recovery.stop();
    });
  });

  // ── Orphan detection ────────────────────────────────────────────

  describe('orphan detection', () => {
    it('does NOT reap a healthy long run on a single-node orchestrator (no peers)', async () => {
      // The candidate query selects on `started_at`, so ANY run longer than the
      // stale threshold lands in `recoverRun`, and a single-node orchestrator
      // has no peer that can vouch for its own coordinator. Recent job progress
      // is what keeps the run alive.
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-live',
            routing_key: 'generic:__default__:src-1',
            workflow_name: 'deploy-stg',
            provider: 'generic',
            repo_identifier: '.',
            sha: 'HEAD',
          },
        ],
        // A job finished seconds ago — the run is progressing, not orphaned.
        progress: { last_heartbeat_at: null, completed_at: new Date(), started_at: null },
        jobs: [
          { job_id: 'job-1', job_name: 'pending', status: 'pending', last_heartbeat_at: null },
        ],
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      // Nothing was force-failed and the run was not finalized.
      expect(mockDb.updateTable).not.toHaveBeenCalled();
      expect(tracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();
      expect(tracker.emitInfraEvent).not.toHaveBeenCalled();

      recovery.stop();
    });

    it('still reaps a run whose last progress predates the stale window', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-dead',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        // Last movement 30 minutes ago — genuinely stuck.
        progress: {
          last_heartbeat_at: new Date(Date.now() - 30 * 60_000),
          completed_at: null,
          started_at: new Date(Date.now() - 30 * 60_000),
        },
        jobs: [{ job_id: 'job-1', job_name: 'test', status: 'success', last_heartbeat_at: null }],
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      expect(tracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-dead');

      recovery.stop();
    });

    it('should find and finalize orphan run (coordinator disconnected)', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      // All jobs are terminal
      const terminalJobs = [
        { job_id: 'job-1', job_name: 'test', status: 'success', last_heartbeat_at: null },
        { job_id: 'job-2', job_name: 'lint', status: 'success', last_heartbeat_at: null },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: terminalJobs,
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      // No peers connected with the routing key -- coordinator is dead
      await recovery.scanForOrphans();

      // Should delegate run completion to executionTracker
      expect(tracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');
      expect(tracker.emitInfraEvent).toHaveBeenCalledWith(
        'run-1',
        'orchestrator.run.orphan_recovered',
        expect.objectContaining({
          metadata: { routingKey: 'github:42', workflowName: 'ci' },
        }),
      );

      recovery.stop();
    });

    it('should mark orphan run with stuck jobs as failed', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const stuckJobs = [
        {
          job_id: 'job-1',
          job_name: 'test',
          status: 'running',
          last_heartbeat_at: new Date('2026-02-18T11:50:00Z'), // 10 min ago = stale
        },
        { job_id: 'job-2', job_name: 'lint', status: 'success', last_heartbeat_at: null },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: stuckJobs,
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
        jobStuckThresholdMs: 3 * 60 * 1000, // 3 min
      });

      await recovery.scanForOrphans();

      // Should have updated the stuck job to failed
      expect(tracker.updateInMemoryJob).toHaveBeenCalledWith('run-1', 'job-1', 'failed');
      // Should delegate run completion to executionTracker
      expect(tracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');

      recovery.stop();
    });

    it('should defer failing a stuck job rerouted to a still-connected worker peer', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      // A stuck (stale-heartbeat) job that was rerouted to worker peer 'arm-stg'.
      const stuckRerouted = [
        {
          job_id: 'job-1',
          job_name: 'test',
          status: 'running',
          last_heartbeat_at: new Date('2026-02-18T11:50:00Z'), // 10 min ago = stale
          rerouted_to_peer: 'arm-stg',
        },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: stuckRerouted,
      });

      // The worker peer is currently connected (different routing key from the
      // coordinator, so the run is still considered orphaned).
      peerRegistry.addPeer({
        instanceId: 'arm-stg',
        connectionId: 'conn-arm',
        address: 'ws://arm:8080',
        routingKeys: ['github:99'],
        role: 'worker',
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
        jobStuckThresholdMs: 3 * 60 * 1000,
      });

      await recovery.scanForOrphans();

      // The rerouted job's worker is still connected -> must NOT be failed.
      expect(tracker.updateInMemoryJob).not.toHaveBeenCalled();
      expect(tracker.forwardJobTerminalStatus).not.toHaveBeenCalled();

      recovery.stop();
    });

    it('should defer a stuck job whose rerouted peer is flapping (disconnected but recently seen)', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const stuckRerouted = [
        {
          job_id: 'job-1',
          job_name: 'test',
          status: 'running',
          last_heartbeat_at: new Date('2026-02-18T11:50:00Z'), // stale heartbeat
          rerouted_to_peer: 'arm-stg',
        },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: stuckRerouted,
      });

      // The peer connected (recent lastHeartbeatAt = now) then its WS flapped:
      // markDisconnected flips connected=false but keeps the fresh heartbeat,
      // so it is within the flap-grace window and the job must NOT be failed —
      // the worker will reconnect and replay its buffered terminal status.
      peerRegistry.addPeer({
        instanceId: 'arm-stg',
        connectionId: 'conn-arm',
        address: 'ws://arm:8080',
        routingKeys: ['github:99'],
        role: 'worker',
      });
      peerRegistry.markDisconnected('arm-stg');

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
        jobStuckThresholdMs: 3 * 60 * 1000,
      });

      await recovery.scanForOrphans();

      expect(tracker.updateInMemoryJob).not.toHaveBeenCalled();
      expect(tracker.forwardJobTerminalStatus).not.toHaveBeenCalled();

      recovery.stop();
    });

    it('should still fail a stuck job rerouted to a DISCONNECTED worker peer', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      // Rerouted to 'arm-stg', but that peer is absent from the registry.
      const stuckRerouted = [
        {
          job_id: 'job-1',
          job_name: 'test',
          status: 'running',
          last_heartbeat_at: new Date('2026-02-18T11:50:00Z'), // 10 min ago = stale
          rerouted_to_peer: 'arm-stg',
        },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: stuckRerouted,
      });

      // No peer named 'arm-stg' is connected -> a dead worker must not hang the job.
      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
        jobStuckThresholdMs: 3 * 60 * 1000,
      });

      await recovery.scanForOrphans();

      expect(tracker.updateInMemoryJob).toHaveBeenCalledWith('run-1', 'job-1', 'failed');

      recovery.stop();
    });

    /**
     * A flapping peer last seen 60s ago sits inside the 120s cluster default but
     * outside a 30s cluster override. Proves the reroute-flap grace is resolved
     * live from cluster_settings at the read site (override wins, else fallback).
     */
    function makeFlappingScan(override?: number) {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();
      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: [
          {
            job_id: 'job-1',
            job_name: 'test',
            status: 'running',
            last_heartbeat_at: new Date('2026-02-18T11:50:00Z'),
            rerouted_to_peer: 'arm-stg',
          },
        ],
      });
      // Peer disconnected but its last heartbeat was 60s ago.
      const fakePeerRegistry = {
        getPeer: () => ({ connected: false, lastHeartbeatAt: Date.now() - 60_000 }),
        getConnectedPeers: () => [],
      } as unknown as PeerRegistry;
      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry: fakePeerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(override),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
        jobStuckThresholdMs: 3 * 60 * 1000,
      });
      return { recovery, tracker };
    }

    it('defers a flapping rerouted job under the cluster-default flap grace', async () => {
      const { recovery, tracker } = makeFlappingScan(); // fallback 120s > 60s -> defer
      await recovery.scanForOrphans();
      expect(tracker.updateInMemoryJob).not.toHaveBeenCalled();
      recovery.stop();
    });

    it('fails a flapping rerouted job when a cluster override shrinks the flap grace', async () => {
      const { recovery, tracker } = makeFlappingScan(30_000); // 30s < 60s -> fail
      await recovery.scanForOrphans();
      expect(tracker.updateInMemoryJob).toHaveBeenCalledWith('run-1', 'job-1', 'failed');
      recovery.stop();
    });

    it('should not recover run when coordinator is still connected', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: 'github:42',
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: [],
      });

      // Coordinator is still connected as a peer
      peerRegistry.addPeer({
        instanceId: 'coordinator-1',
        connectionId: 'conn-1',
        address: 'ws://coordinator:8080',
        routingKeys: ['github:42'],
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      // Should NOT finalize -- coordinator is alive
      expect(tracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();

      recovery.stop();
    });

    it('should handle orphan run with all completed jobs -> success', async () => {
      const raft = createMockRaft(true);
      const tracker = createMockExecutionTracker();

      const allSuccessJobs = [
        { job_id: 'job-1', job_name: 'test', status: 'success', last_heartbeat_at: null },
        { job_id: 'job-2', job_name: 'lint', status: 'success', last_heartbeat_at: null },
        { job_id: 'job-3', job_name: 'build', status: 'skipped', last_heartbeat_at: null },
      ];

      const mockDb = createMockDb({
        staleRuns: [
          {
            run_id: 'run-1',
            routing_key: null,
            workflow_name: 'ci',
            provider: 'github',
            repo_identifier: 'owner/repo',
            sha: 'abc123',
          },
        ],
        jobs: allSuccessJobs,
      });

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      // Should delegate run completion to executionTracker
      expect(tracker.completeRunIfAllJobsTerminal).toHaveBeenCalledWith('run-1');

      recovery.stop();
    });
  });

  // ── Scan interval lifecycle ─────────────────────────────────────

  describe('scan interval', () => {
    it('should start and stop cleanly', () => {
      const raft = createMockRaft(false);
      const mockDb = createMockDb({});
      const tracker = createMockExecutionTracker();

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      recovery.start();

      // Advance time to trigger scan
      vi.advanceTimersByTime(1000);

      // isLeader is called by the scan
      expect(raft.isLeader).toHaveBeenCalled();

      recovery.stop();

      // Reset the mock
      (raft.isLeader as ReturnType<typeof vi.fn>).mockClear();

      // After stop, advancing time should NOT trigger more scans
      vi.advanceTimersByTime(5000);
      expect(raft.isLeader).not.toHaveBeenCalled();
    });

    it('should not start twice', () => {
      const raft = createMockRaft(false);
      const mockDb = createMockDb({});
      const tracker = createMockExecutionTracker();

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      recovery.start();
      recovery.start(); // second call is no-op

      vi.advanceTimersByTime(1000);

      // Should only have been called once (one interval, not two)
      expect(raft.isLeader).toHaveBeenCalledTimes(1);

      recovery.stop();
    });
  });

  // ── No stale runs ───────────────────────────────────────────────

  describe('no orphans', () => {
    it('should do nothing when no stale runs found', async () => {
      const raft = createMockRaft(true);
      const mockDb = createMockDb({ staleRuns: [] });
      const tracker = createMockExecutionTracker();

      const recovery = new OrphanRecovery({
        db: mockDb.db,
        raft,
        peerRegistry,
        executionTracker: tracker,
        clusterSettings: makeClusterSettingsStub(),
        rerouteFlapGraceFallbackMs: 120_000,
        scanIntervalMs: 1000,
      });

      await recovery.scanForOrphans();

      expect(tracker.completeRunIfAllJobsTerminal).not.toHaveBeenCalled();
      // Only the stale runs query should have been made
      expect(mockDb.selectFrom).toHaveBeenCalledTimes(1);

      recovery.stop();
    });
  });
});
