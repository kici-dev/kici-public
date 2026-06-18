import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrphanRecovery } from './orphan-recovery.js';
import { PeerRegistry } from './peer-registry.js';
import type { RaftNode } from './raft.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';

// ── Mock helpers ──────────────────────────────────────────────────

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
function createMockDb(config: { staleRuns?: any[]; jobs?: any[] }) {
  const staleRuns = config.staleRuns ?? [];
  const jobs = config.jobs ?? [];

  const queryResults = [staleRuns, jobs];
  let selectFromCallIndex = 0;

  const selectFromFn = vi.fn(() => {
    const resultIndex = selectFromCallIndex++;
    const results = queryResults[resultIndex] ?? [];

    const chain: any = {};
    for (const method of ['select', 'where', 'execute']) {
      chain[method] = vi.fn((..._args: any[]) => {
        if (method === 'execute') return Promise.resolve(results);
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
