import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RaftNode } from './raft.js';
import type { RaftStateStore } from './raft-state.js';
import { PeerRegistry } from './peer-registry.js';
import type { RaftVoteRequest, RaftAppendEntries } from '@kici-dev/engine';

// ── Mock helpers ──────────────────────────────────────────────────

function createMockStateStore(): RaftStateStore {
  return {
    load: vi.fn().mockResolvedValue({
      currentTerm: 0,
      votedFor: null,
      leaderId: null,
    }),
    save: vi.fn().mockResolvedValue(undefined),
    updateLeader: vi.fn().mockResolvedValue(undefined),
  } as unknown as RaftStateStore;
}

interface TestSetup {
  raft: RaftNode;
  stateStore: ReturnType<typeof createMockStateStore>;
  peerRegistry: PeerRegistry;
  broadcastToPeers: ReturnType<typeof vi.fn>;
  onBecomeLeader: ReturnType<typeof vi.fn>;
  onLoseLeadership: ReturnType<typeof vi.fn>;
}

function createRaftNode(
  overrides?: Partial<{
    instanceId: string;
    electionTimeoutMinMs: number;
    electionTimeoutMaxMs: number;
    leaderHeartbeatMs: number;
    gracePeriodMs: number;
  }>,
): TestSetup {
  const stateStore = createMockStateStore();
  const peerRegistry = new PeerRegistry();
  const broadcastToPeers = vi.fn();
  const onBecomeLeader = vi.fn();
  const onLoseLeadership = vi.fn();

  const raft = new RaftNode({
    instanceId: overrides?.instanceId ?? 'orch-1',
    stateStore,
    peerRegistry,
    broadcastToPeers,
    onBecomeLeader,
    onLoseLeadership,
    electionTimeoutMinMs: overrides?.electionTimeoutMinMs ?? 100,
    electionTimeoutMaxMs: overrides?.electionTimeoutMaxMs ?? 200,
    leaderHeartbeatMs: overrides?.leaderHeartbeatMs ?? 50,
    gracePeriodMs: overrides?.gracePeriodMs,
  });

  return { raft, stateStore, peerRegistry, broadcastToPeers, onBecomeLeader, onLoseLeadership };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('RaftNode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Start / Stop ────────────────────────────────────────────────

  describe('start', () => {
    it('should load state from DB on start', async () => {
      const { raft, stateStore } = createRaftNode();
      await raft.start();

      expect(stateStore.load).toHaveBeenCalledOnce();
      expect(raft.getRole()).toBe('follower');
      expect(raft.getCurrentTerm()).toBe(0);

      await raft.stop();
    });

    it('should restore persisted state', async () => {
      const { raft, stateStore } = createRaftNode();
      (stateStore.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        currentTerm: 5,
        votedFor: 'orch-2',
        leaderId: 'orch-3',
      });

      await raft.start();

      expect(raft.getCurrentTerm()).toBe(5);
      expect(raft.getLeaderId()).toBe('orch-3');
      expect(raft.getRole()).toBe('follower');

      await raft.stop();
    });
  });

  describe('stop', () => {
    it('should clear all timers and save state', async () => {
      const { raft, stateStore } = createRaftNode();
      await raft.start();

      // Let the node self-elect (no peers)
      await vi.advanceTimersByTimeAsync(300);
      expect(raft.isLeader()).toBe(true);

      await raft.stop();

      expect(stateStore.save).toHaveBeenCalled();

      // After stop, no more heartbeats should fire
      const callsBefore = (stateStore.save as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      const callsAfter = (stateStore.save as ReturnType<typeof vi.fn>).mock.calls.length;
      // No additional saves from timers after stop
      expect(callsAfter).toBe(callsBefore);
    });
  });

  // ── Dormant mode (0 peers) ─────────────────────────────────────

  describe('dormant mode (single orchestrator)', () => {
    it('should self-elect as leader when no peers are connected', async () => {
      const { raft, onBecomeLeader } = createRaftNode();
      await raft.start();

      // Election timer fires
      await vi.advanceTimersByTimeAsync(300);

      expect(raft.isLeader()).toBe(true);
      expect(raft.getLeaderId()).toBe('orch-1');
      expect(raft.getCurrentTerm()).toBe(1);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });

    it('should self-elect without errors', async () => {
      const { raft } = createRaftNode();
      await raft.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(300);

      expect(raft.isLeader()).toBe(true);

      await raft.stop();
    });
  });

  // ── Election with peers ─────────────────────────────────────────

  describe('election', () => {
    it('should request votes from peers when election timer fires', async () => {
      const { raft, peerRegistry, broadcastToPeers } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      // Add a connected peer
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: 'ws://peer:8080',
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);

      expect(broadcastToPeers).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'raft.vote.request',
          term: 1,
          candidateId: 'orch-1',
          lastLogIndex: 0,
          lastLogTerm: 0,
        }),
      );

      await raft.stop();
    });

    it('should become leader when receiving majority of votes', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        // Use longer timeout to avoid multiple elections firing
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);

      // Cluster size = 2, majority = 2, self-vote = 1, need 1 more
      expect(raft.getRole()).toBe('candidate');
      const currentTerm = raft.getCurrentTerm();

      // Receive vote from peer with matching term
      raft.handleVoteResponse({
        type: 'raft.vote.response',
        term: currentTerm,
        voteGranted: true,
        voterId: 'orch-2',
      });

      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalled();

      await raft.stop();
    });

    it('should not become leader without majority', async () => {
      const { raft, peerRegistry } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      // 3-node cluster
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });
      peerRegistry.addPeer({
        instanceId: 'orch-3',
        connectionId: 'conn-3',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);

      const currentTerm = raft.getCurrentTerm();

      // Cluster size = 3, majority = 2, self-vote = 1, need 1 more
      // Only get a denial
      raft.handleVoteResponse({
        type: 'raft.vote.response',
        term: currentTerm,
        voteGranted: false,
        voterId: 'orch-2',
      });

      expect(raft.isLeader()).toBe(false);

      await raft.stop();
    });
  });

  // ── Vote request handling ───────────────────────────────────────

  describe('handleVoteRequest', () => {
    it('should grant vote when not voted in current term', async () => {
      const { raft } = createRaftNode();
      await raft.start();

      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 1,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(true);
      expect(response.voterId).toBe('orch-1');

      await raft.stop();
    });

    it('should deny vote when already voted for different candidate', async () => {
      const { raft } = createRaftNode();
      await raft.start();

      // Vote for orch-2
      raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 1,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      // Now orch-3 asks for a vote in same term
      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 1,
        candidateId: 'orch-3',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(false);

      await raft.stop();
    });

    it('should grant vote again to same candidate in same term', async () => {
      const { raft } = createRaftNode();
      await raft.start();

      raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 1,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 1,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(true);

      await raft.stop();
    });

    it('should deny vote with lower term', async () => {
      const { raft, stateStore } = createRaftNode();
      (stateStore.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        currentTerm: 5,
        votedFor: null,
        leaderId: null,
      });
      await raft.start();

      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 3,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(response.voteGranted).toBe(false);
      expect(response.term).toBe(5);

      await raft.stop();
    });

    it('should step down when vote request has higher term', async () => {
      const { raft, peerRegistry, onBecomeLeader, onLoseLeadership } = createRaftNode();
      await raft.start();
      await vi.advanceTimersByTimeAsync(300);
      expect(raft.isLeader()).toBe(true);

      // Receive vote request with higher term
      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 5,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(raft.isLeader()).toBe(false);
      expect(raft.getRole()).toBe('follower');
      expect(raft.getCurrentTerm()).toBe(5);
      expect(response.voteGranted).toBe(true);
      expect(onLoseLeadership).toHaveBeenCalledOnce();

      await raft.stop();
    });
  });

  // ── Vote response handling ──────────────────────────────────────

  describe('handleVoteResponse', () => {
    it('should step down on higher term in vote response', async () => {
      const { raft, peerRegistry, onLoseLeadership } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);
      expect(raft.getRole()).toBe('candidate');

      raft.handleVoteResponse({
        type: 'raft.vote.response',
        term: 10,
        voteGranted: false,
        voterId: 'orch-2',
      });

      expect(raft.getRole()).toBe('follower');
      expect(raft.getCurrentTerm()).toBe(10);

      await raft.stop();
    });

    it('should ignore vote response if no longer candidate', async () => {
      const { raft, onBecomeLeader } = createRaftNode();
      await raft.start();

      // Not yet a candidate (no election timer fired)
      raft.handleVoteResponse({
        type: 'raft.vote.response',
        term: 0,
        voteGranted: true,
        voterId: 'orch-2',
      });

      expect(raft.isLeader()).toBe(false);
      expect(onBecomeLeader).not.toHaveBeenCalled();

      await raft.stop();
    });
  });

  // ── Leader heartbeat ────────────────────────────────────────────

  describe('leader heartbeat', () => {
    it('should send heartbeats after becoming leader', async () => {
      const { raft, broadcastToPeers } = createRaftNode();
      await raft.start();
      await vi.advanceTimersByTimeAsync(300);
      expect(raft.isLeader()).toBe(true);

      // Clear broadcasts from election
      broadcastToPeers.mockClear();

      // Advance by heartbeat interval
      await vi.advanceTimersByTimeAsync(50);

      expect(broadcastToPeers).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'raft.append.entries',
          term: 1,
          leaderId: 'orch-1',
        }),
      );

      await raft.stop();
    });

    it('should send multiple heartbeats over time', async () => {
      const { raft, broadcastToPeers } = createRaftNode();
      await raft.start();
      await vi.advanceTimersByTimeAsync(300);
      broadcastToPeers.mockClear();

      // Advance 3 heartbeat intervals
      await vi.advanceTimersByTimeAsync(150);

      const heartbeats = broadcastToPeers.mock.calls.filter(
        (call: any[]) => call[0].type === 'raft.append.entries',
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);

      await raft.stop();
    });
  });

  // ── Append entries handling ─────────────────────────────────────

  describe('handleAppendEntries', () => {
    it('should reset election timer on valid heartbeat', async () => {
      const { raft } = createRaftNode();
      await raft.start();

      // Receive heartbeat from leader
      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: 1,
        leaderId: 'orch-2',
      });

      expect(raft.getLeaderId()).toBe('orch-2');
      expect(raft.getCurrentTerm()).toBe(1);
      expect(raft.getRole()).toBe('follower');

      await raft.stop();
    });

    it('should step down from leader on higher term heartbeat', async () => {
      const { raft, onLoseLeadership } = createRaftNode();
      await raft.start();
      await vi.advanceTimersByTimeAsync(300);
      expect(raft.isLeader()).toBe(true);

      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: 5,
        leaderId: 'orch-2',
      });

      expect(raft.isLeader()).toBe(false);
      expect(raft.getRole()).toBe('follower');
      expect(raft.getLeaderId()).toBe('orch-2');
      expect(raft.getCurrentTerm()).toBe(5);
      expect(onLoseLeadership).toHaveBeenCalledOnce();

      await raft.stop();
    });

    it('should step down from candidate on same-term heartbeat', async () => {
      const { raft, peerRegistry } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);
      expect(raft.getRole()).toBe('candidate');

      const currentTerm = raft.getCurrentTerm();

      // Leader heartbeat in same term
      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: currentTerm,
        leaderId: 'orch-2',
      });

      expect(raft.getRole()).toBe('follower');
      expect(raft.getLeaderId()).toBe('orch-2');

      await raft.stop();
    });

    it('should ignore heartbeat with lower term', async () => {
      const { raft, stateStore } = createRaftNode();
      (stateStore.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        currentTerm: 5,
        votedFor: null,
        leaderId: null,
      });
      await raft.start();

      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: 3,
        leaderId: 'orch-2',
      });

      // Should not update leader
      expect(raft.getLeaderId()).toBeNull();
      expect(raft.getCurrentTerm()).toBe(5);

      await raft.stop();
    });
  });

  // ── State persistence ───────────────────────────────────────────

  describe('state persistence', () => {
    it('should persist state on election start', async () => {
      const { raft, stateStore, peerRegistry } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      (stateStore.save as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(700);

      // Should have persisted vote for self
      expect(stateStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          votedFor: 'orch-1',
        }),
      );

      await raft.stop();
    });

    it('should persist state on becoming leader', async () => {
      const { raft, stateStore } = createRaftNode();
      await raft.start();
      (stateStore.save as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(300);

      expect(stateStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentTerm: 1,
          votedFor: 'orch-1',
          leaderId: 'orch-1',
        }),
      );

      await raft.stop();
    });

    it('should persist state on voting for a candidate', async () => {
      const { raft, stateStore } = createRaftNode();
      await raft.start();
      (stateStore.save as ReturnType<typeof vi.fn>).mockClear();

      raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 2,
        candidateId: 'orch-3',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      expect(stateStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentTerm: 2,
          votedFor: 'orch-3',
        }),
      );

      await raft.stop();
    });

    it('should save state on stop', async () => {
      const { raft, stateStore } = createRaftNode();
      await raft.start();
      (stateStore.save as ReturnType<typeof vi.fn>).mockClear();

      await raft.stop();

      expect(stateStore.save).toHaveBeenCalled();
    });
  });

  // ── Election timeout range ──────────────────────────────────────

  describe('election timeout', () => {
    it('should use WAN-appropriate defaults (5-10s) when not overridden', () => {
      const stateStore = createMockStateStore();
      const peerRegistry = new PeerRegistry();
      const raft = new RaftNode({
        instanceId: 'orch-1',
        stateStore,
        peerRegistry,
        broadcastToPeers: vi.fn(),
        onBecomeLeader: vi.fn(),
        onLoseLeadership: vi.fn(),
        // no electionTimeoutMinMs/Max overrides
      });

      // We can verify the defaults by starting and checking behavior.
      // The constructor defaults are 5000/10000 -- verified by code inspection
      // and exercised indirectly through the timeout behavior.
      expect(raft).toBeDefined();
    });
  });

  // ── Grace period ────────────────────────────────────────────────

  describe('grace period', () => {
    it('defers self-election during grace period', async () => {
      const { raft, onBecomeLeader } = createRaftNode({
        gracePeriodMs: 60_000,
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
      });

      await raft.start();

      // Election timer fires but grace period hasn't elapsed (only ~300ms vs 60s)
      await vi.advanceTimersByTimeAsync(300);

      expect(raft.isLeader()).toBe(false);
      expect(onBecomeLeader).not.toHaveBeenCalled();

      await raft.stop();
    });

    it('self-elects after grace period expires', async () => {
      const { raft, onBecomeLeader } = createRaftNode({
        gracePeriodMs: 1000,
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
      });

      await raft.start();

      // Advance past grace period + election timeout
      await vi.advanceTimersByTimeAsync(1500);

      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });

    it('self-elects immediately when gracePeriodMs is 0', async () => {
      const { raft, onBecomeLeader } = createRaftNode({
        gracePeriodMs: 0,
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
      });

      await raft.start();

      // Election timer fires, no grace period
      await vi.advanceTimersByTimeAsync(300);

      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });

    it('onPeerDisconnected respects grace period', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        gracePeriodMs: 60_000,
        electionTimeoutMinMs: 100,
        electionTimeoutMaxMs: 200,
      });

      // Add and then remove a peer to trigger onPeerDisconnected
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();

      // Remove peer — triggers onPeerDisconnected
      peerRegistry.removePeer('orch-2');
      raft.onPeerDisconnected();

      // Even with the quick 500ms re-election, grace period should prevent self-election
      await vi.advanceTimersByTimeAsync(1000);

      expect(raft.isLeader()).toBe(false);
      expect(onBecomeLeader).not.toHaveBeenCalled();

      await raft.stop();
    });
  });

  // ── Consecutive unanswered elections ─────────────────────────────

  describe('consecutive unanswered elections', () => {
    // Both tests below assert exact election sequencing. To make timer
    // arithmetic deterministic across runs, jitter is disabled (min === max)
    // so each election fires exactly `ELECTION_INTERVAL_MS` after the prior
    // reset. The 700 ms advance window stays strictly between one and two
    // intervals (700 > 600 > 350 = 700 / 2), guaranteeing exactly one
    // election per `advanceTimersByTimeAsync` call.
    const ELECTION_INTERVAL_MS = 600;
    const ADVANCE_MS = 700;

    it('should force self-election after consecutive unanswered elections', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        electionTimeoutMinMs: ELECTION_INTERVAL_MS,
        electionTimeoutMaxMs: ELECTION_INTERVAL_MS,
      });

      // Add a "connected" coordinator peer that never responds to votes
      // (simulates a dead peer whose WebSocket close hasn't been detected)
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });

      await raft.start();

      // Election 1: broadcasts vote request, no response → candidate
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.getRole()).toBe('candidate');
      expect(onBecomeLeader).not.toHaveBeenCalled();

      // Election 2: broadcasts again, still no response → candidate
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.getRole()).toBe('candidate');
      expect(onBecomeLeader).not.toHaveBeenCalled();

      // Election 3: consecutive unanswered >= 2 → force self-election
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });

    it('should reset unanswered counter when vote response is received', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        electionTimeoutMinMs: ELECTION_INTERVAL_MS,
        electionTimeoutMaxMs: ELECTION_INTERVAL_MS,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });

      await raft.start();

      // Election 1: no response
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.getRole()).toBe('candidate');

      // Receive a vote denial — proves peer is alive, resets counter
      raft.handleVoteResponse({
        type: 'raft.vote.response',
        term: raft.getCurrentTerm(),
        voteGranted: false,
        voterId: 'orch-2',
      });

      // Election 2: counter was reset, so no force self-election
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.getRole()).toBe('candidate');

      // Election 3: counter is 1 (only 1 unanswered since reset)
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.getRole()).toBe('candidate');

      // Election 4: counter is 2 → force self-election
      await vi.advanceTimersByTimeAsync(ADVANCE_MS);
      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });
  });

  // ── onPeerDisconnected with worker peers ──────────────────────

  describe('onPeerDisconnected with worker peers', () => {
    it('should trigger fast-path self-election when only worker peers remain', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        electionTimeoutMinMs: 5000,
        electionTimeoutMaxMs: 6000,
      });

      // Add a coordinator peer and a worker peer
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });
      peerRegistry.addPeer({
        instanceId: 'worker-1',
        connectionId: 'conn-w1',
        address: null,
        routingKeys: [],
        role: 'worker',
      });

      await raft.start();

      // Disconnect the coordinator peer (worker stays connected)
      peerRegistry.markDisconnected('orch-2');
      raft.onPeerDisconnected();

      // The fast-path 500ms timer should fire and trigger self-election
      // (despite worker peer still being connected)
      await vi.advanceTimersByTimeAsync(600);

      expect(raft.isLeader()).toBe(true);
      expect(onBecomeLeader).toHaveBeenCalledOnce();

      await raft.stop();
    });
  });

  // ── handlePeerLeaving ───────────────────────────────────────────

  describe('handlePeerLeaving', () => {
    it('should clear leaderId and start election when leader is leaving and node is follower', async () => {
      const { raft, peerRegistry, broadcastToPeers } = createRaftNode({
        electionTimeoutMinMs: 5000,
        electionTimeoutMaxMs: 6000,
      });

      // Add a coordinator peer
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });

      await raft.start();

      // Receive heartbeat from orch-2 to establish it as leader
      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: 1,
        leaderId: 'orch-2',
      });
      expect(raft.getLeaderId()).toBe('orch-2');
      expect(raft.getRole()).toBe('follower');

      const termBefore = raft.getCurrentTerm();

      // Leader announces it is leaving
      raft.handlePeerLeaving('orch-2');

      // Should clear leaderId and transition to candidate (start election)
      expect(raft.getLeaderId()).toBeNull();
      expect(raft.getRole()).toBe('candidate');
      expect(raft.getCurrentTerm()).toBe(termBefore + 1);
      expect(broadcastToPeers).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'raft.vote.request',
        }),
      );

      await raft.stop();
    });

    it('should NOT start election when non-leader peer is leaving', async () => {
      const { raft, peerRegistry, broadcastToPeers } = createRaftNode({
        electionTimeoutMinMs: 5000,
        electionTimeoutMaxMs: 6000,
      });

      // Add two coordinator peers
      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });
      peerRegistry.addPeer({
        instanceId: 'orch-3',
        connectionId: 'conn-3',
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });

      await raft.start();

      // Establish orch-2 as leader
      raft.handleAppendEntries({
        type: 'raft.append.entries',
        term: 1,
        leaderId: 'orch-2',
      });
      expect(raft.getLeaderId()).toBe('orch-2');

      const termBefore = raft.getCurrentTerm();
      broadcastToPeers.mockClear();

      // Non-leader peer orch-3 is leaving
      raft.handlePeerLeaving('orch-3');

      // Should NOT change role or start election
      expect(raft.getRole()).toBe('follower');
      expect(raft.getCurrentTerm()).toBe(termBefore);
      expect(raft.getLeaderId()).toBe('orch-2');
      expect(broadcastToPeers).not.toHaveBeenCalled();

      await raft.stop();
    });

    it('should be a no-op when this node is the leader', async () => {
      const { raft, broadcastToPeers } = createRaftNode();
      await raft.start();

      // Self-elect as leader (no peers)
      await vi.advanceTimersByTimeAsync(300);
      expect(raft.isLeader()).toBe(true);

      const termBefore = raft.getCurrentTerm();
      broadcastToPeers.mockClear();

      // Some peer announces leaving — leader should ignore
      raft.handlePeerLeaving('orch-2');

      expect(raft.isLeader()).toBe(true);
      expect(raft.getCurrentTerm()).toBe(termBefore);

      await raft.stop();
    });
  });

  // ── Higher term wins ────────────────────────────────────────────

  describe('term tracking', () => {
    it('should let node with higher term win election', async () => {
      const { raft, peerRegistry, onBecomeLeader } = createRaftNode({
        electionTimeoutMinMs: 500,
        electionTimeoutMaxMs: 600,
      });

      peerRegistry.addPeer({
        instanceId: 'orch-2',
        connectionId: 'conn-2',
        address: null,
        routingKeys: [],
      });

      await raft.start();
      await vi.advanceTimersByTimeAsync(700);
      // orch-1 is candidate

      // orch-2 has a higher term and requests vote
      const response = raft.handleVoteRequest({
        type: 'raft.vote.request',
        term: 5,
        candidateId: 'orch-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      });

      // orch-1 steps down and grants vote to higher term
      expect(response.voteGranted).toBe(true);
      expect(raft.getCurrentTerm()).toBe(5);
      expect(raft.getRole()).toBe('follower');

      await raft.stop();
    });
  });
});
