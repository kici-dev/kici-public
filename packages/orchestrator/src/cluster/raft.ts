/**
 * Minimal Raft leader election implementation.
 *
 * Implements only leader election (no log replication) for cluster coordination.
 * State machine: follower -> candidate -> leader. State is persisted to Postgres
 * via RaftStateStore for crash recovery. Election timeout is 5-10s with randomized
 * jitter (WAN-appropriate per research). Leader sends heartbeats every 2s.
 *
 * Dormant mode: When peerRegistry has 0 connected peers, the node self-elects
 * immediately (single-orchestrator deployment). If peers connect later, normal
 * election resumes.
 *
 * Raft heartbeat (raft.append.entries every 2s) is separate from peer inventory
 * heartbeat (peer.heartbeat every 30s). Raft heartbeat is purely for leader
 * liveness detection.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { RaftVoteRequest, RaftVoteResponse, RaftAppendEntries } from '@kici-dev/engine';
import type { PeerRegistry } from './peer-registry.js';
import type { RaftStateStore } from './raft-state.js';

const logger = createLogger({ prefix: 'raft' });

export type RaftRole = 'follower' | 'candidate' | 'leader';

interface RaftNodeDeps {
  instanceId: string;
  stateStore: RaftStateStore;
  peerRegistry: PeerRegistry;
  broadcastToPeers: (msg: RaftVoteRequest | RaftAppendEntries) => void;
  onBecomeLeader: () => void;
  onLoseLeadership: () => void;
  electionTimeoutMinMs?: number; // Default: 5000
  electionTimeoutMaxMs?: number; // Default: 10000
  leaderHeartbeatMs?: number; // Default: 2000
  /** Grace period in ms before dormant-mode self-election. Default: 0 (no grace period). */
  gracePeriodMs?: number;
}

export class RaftNode {
  private readonly instanceId: string;
  private readonly stateStore: RaftStateStore;
  private readonly peerRegistry: PeerRegistry;
  private readonly broadcastToPeers: (msg: RaftVoteRequest | RaftAppendEntries) => void;
  private readonly onBecomeLeader: () => void;
  private readonly onLoseLeadership: () => void;
  private readonly electionTimeoutMinMs: number;
  private readonly electionTimeoutMaxMs: number;
  private readonly leaderHeartbeatMs: number;
  private readonly gracePeriodMs: number;
  private startedAt = 0;

  private currentTerm = 0;
  private votedFor: string | null = null;
  private leaderId: string | null = null;
  private role: RaftRole = 'follower';

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Votes received during the current election as candidate. */
  private votesReceived = new Set<string>();

  /**
   * Consecutive elections where no peer responded with a vote.
   * When this exceeds the threshold, the node force-self-elects as a safety
   * valve against delayed WebSocket close detection (peer appears "connected"
   * but is actually dead).
   */
  private consecutiveUnansweredElections = 0;

  constructor(deps: RaftNodeDeps) {
    this.instanceId = deps.instanceId;
    this.stateStore = deps.stateStore;
    this.peerRegistry = deps.peerRegistry;
    this.broadcastToPeers = deps.broadcastToPeers;
    this.onBecomeLeader = deps.onBecomeLeader;
    this.onLoseLeadership = deps.onLoseLeadership;
    this.electionTimeoutMinMs = deps.electionTimeoutMinMs ?? 5000;
    this.electionTimeoutMaxMs = deps.electionTimeoutMaxMs ?? 10000;
    this.leaderHeartbeatMs = deps.leaderHeartbeatMs ?? 2000;
    this.gracePeriodMs = deps.gracePeriodMs ?? 0;
  }

  /**
   * Start the Raft node. Loads persisted state from DB and starts
   * as follower with election timer.
   */
  async start(): Promise<void> {
    const state = await this.stateStore.load();
    this.currentTerm = state.currentTerm;
    this.votedFor = state.votedFor;
    this.leaderId = state.leaderId;
    this.role = 'follower';
    this.startedAt = Date.now();

    logger.info('Raft node started', {
      instanceId: this.instanceId,
      currentTerm: this.currentTerm,
      leaderId: this.leaderId,
    });

    this.resetElectionTimer();
  }

  /**
   * Stop the Raft node. Clears all timers and persists state.
   */
  async stop(): Promise<void> {
    this.clearElectionTimer();
    this.clearLeaderHeartbeat();

    await this.stateStore.save({
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      leaderId: this.leaderId,
    });

    logger.info('Raft node stopped', { instanceId: this.instanceId });
  }

  /** Whether this node is the current leader. */
  isLeader(): boolean {
    return this.role === 'leader';
  }

  /** Get the current known leader's instance ID. */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /** Get the current Raft term. */
  getCurrentTerm(): number {
    return this.currentTerm;
  }

  /** Get the current role (for testing/diagnostics). */
  getRole(): RaftRole {
    return this.role;
  }

  // ── Peer leaving ───────────────────────────────────────────────────

  /**
   * Handle a peer.leaving announcement from a gracefully shutting down peer.
   * If the leaving peer is the current leader, immediately clear leaderId and
   * start a new election. Otherwise, no election action (peer registry update
   * is done by the caller before calling this method).
   */
  handlePeerLeaving(instanceId: string): void {
    if (this.role === 'leader') {
      logger.debug('Ignoring peer.leaving (we are leader)', { leavingPeer: instanceId });
      return;
    }

    if (instanceId === this.leaderId) {
      logger.info('Current leader is leaving, starting immediate election', {
        leavingPeer: instanceId,
        term: this.currentTerm,
      });
      this.leaderId = null;
      this.consecutiveUnansweredElections = 0;
      this.clearElectionTimer(); // Cancel any pending timer from onPeerDisconnected
      this.startElection();
    } else {
      logger.debug('Non-leader peer leaving', { leavingPeer: instanceId });
    }
  }

  // ── Election timer ──────────────────────────────────────────────────

  /**
   * Reset the election timer with a randomized timeout.
   * On expiry, starts an election.
   */
  resetElectionTimer(): void {
    this.clearElectionTimer();

    const timeout =
      this.electionTimeoutMinMs +
      Math.random() * (this.electionTimeoutMaxMs - this.electionTimeoutMinMs);

    this.electionTimer = setTimeout(() => {
      this.startElection();
    }, timeout);
  }

  private clearElectionTimer(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }

  /**
   * Notify Raft that a peer disconnected. If this node is a follower or
   * candidate, reset the election timer to a short value so Raft quickly
   * re-evaluates whether it should self-elect (dormant mode).
   * Without this, the node waits for the full election timeout (3-5s)
   * before discovering all peers are gone.
   */
  onPeerDisconnected(): void {
    if (this.role !== 'leader' && this.peerRegistry.getConnectedCoordinatorPeerCount() === 0) {
      // Respect grace period: if still within grace period, use normal election timer
      if (this.gracePeriodMs > 0 && Date.now() - this.startedAt < this.gracePeriodMs) {
        this.resetElectionTimer();
        return;
      }
      this.clearElectionTimer();
      this.electionTimer = setTimeout(() => {
        this.startElection();
      }, 500);
    }
  }

  // ── Election ────────────────────────────────────────────────────────

  /**
   * Start a new election. Increment term, vote for self, request votes
   * from peers. If no peers are connected, self-elect immediately
   * (dormant mode for single-orchestrator deployments).
   */
  private startElection(): void {
    this.currentTerm++;
    this.votedFor = this.instanceId;
    this.role = 'candidate';
    this.votesReceived = new Set([this.instanceId]); // Vote for self

    logger.info('Starting election', {
      instanceId: this.instanceId,
      term: this.currentTerm,
    });

    // Persist state (term + vote)
    this.stateStore
      .save({
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
        leaderId: this.leaderId,
      })
      .catch((err) => {
        logger.error('Failed to persist election state', {
          error: toErrorMessage(err),
        });
      });

    // Use coordinator peer count for Raft quorum — workers don't vote
    const connectedPeerCount = this.peerRegistry.getConnectedCoordinatorPeerCount();

    // Dormant mode: single coordinator (no coordinator peers) = immediate self-election
    if (connectedPeerCount === 0) {
      // Grace period: don't self-elect until grace period has elapsed
      if (this.gracePeriodMs > 0 && Date.now() - this.startedAt < this.gracePeriodMs) {
        logger.info('Dormant mode: deferring self-election (grace period active)', {
          instanceId: this.instanceId,
          elapsedMs: Date.now() - this.startedAt,
          gracePeriodMs: this.gracePeriodMs,
        });
        this.resetElectionTimer();
        return;
      }

      logger.info('No peers connected, self-electing as leader', {
        instanceId: this.instanceId,
        term: this.currentTerm,
      });
      this.becomeLeader();
      return;
    }

    // Safety valve: if consecutive elections got zero vote responses from peers,
    // the peers are likely dead but WebSocket close hasn't been detected yet.
    // Force self-election to avoid indefinite candidate state.
    if (this.consecutiveUnansweredElections >= 2) {
      logger.warn('No vote responses after consecutive elections, forcing self-election', {
        instanceId: this.instanceId,
        term: this.currentTerm,
        consecutiveUnanswered: this.consecutiveUnansweredElections,
        connectedCoordinatorPeers: connectedPeerCount,
      });
      this.consecutiveUnansweredElections = 0;
      this.becomeLeader();
      return;
    }
    this.consecutiveUnansweredElections++;

    // Request votes from all connected peers
    const voteRequest: RaftVoteRequest = {
      type: 'raft.vote.request',
      term: this.currentTerm,
      candidateId: this.instanceId,
      lastLogIndex: 0,
      lastLogTerm: 0,
    };

    this.broadcastToPeers(voteRequest);

    // Check if self-vote alone gives majority
    // (e.g., 1 peer connected: cluster size = 2, majority = 2, need both votes)
    this.checkMajority();

    // Reset election timer in case we don't get enough votes
    this.resetElectionTimer();
  }

  /**
   * Handle an incoming vote request from another candidate.
   */
  handleVoteRequest(msg: RaftVoteRequest): RaftVoteResponse {
    // Step down if message has higher term
    if (msg.term > this.currentTerm) {
      this.stepDown(msg.term);
    }

    const voteGranted =
      msg.term >= this.currentTerm && (this.votedFor === null || this.votedFor === msg.candidateId);

    if (voteGranted) {
      this.votedFor = msg.candidateId;

      // Persist vote
      this.stateStore
        .save({
          currentTerm: this.currentTerm,
          votedFor: this.votedFor,
          leaderId: this.leaderId,
        })
        .catch((err) => {
          logger.error('Failed to persist vote', {
            error: toErrorMessage(err),
          });
        });

      // Reset election timer when granting a vote
      this.resetElectionTimer();

      logger.info('Vote granted', {
        candidateId: msg.candidateId,
        term: msg.term,
      });
    } else {
      logger.info('Vote denied', {
        candidateId: msg.candidateId,
        term: msg.term,
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
      });
    }

    return {
      type: 'raft.vote.response',
      term: this.currentTerm,
      voteGranted,
      voterId: this.instanceId,
    };
  }

  /**
   * Handle a vote response from a peer.
   */
  handleVoteResponse(msg: RaftVoteResponse): void {
    // Higher term: step down
    if (msg.term > this.currentTerm) {
      this.stepDown(msg.term);
      return;
    }

    // Only process if still a candidate for this term
    if (this.role !== 'candidate' || msg.term !== this.currentTerm) {
      return;
    }

    // Any response (granted or not) proves peers are reachable —
    // reset the unanswered election counter.
    this.consecutiveUnansweredElections = 0;

    if (msg.voteGranted) {
      this.votesReceived.add(msg.voterId);
      logger.info('Vote received', {
        from: msg.voterId,
        term: msg.term,
        totalVotes: this.votesReceived.size,
      });

      this.checkMajority();
    }
  }

  /**
   * Check if we have a majority of votes to become leader.
   * Cluster size = connected peers + self.
   */
  private checkMajority(): void {
    if (this.role !== 'candidate') return;

    const clusterSize = this.peerRegistry.getConnectedCoordinatorPeerCount() + 1; // +1 for self (coordinator peers only)
    const majority = Math.floor(clusterSize / 2) + 1;

    if (this.votesReceived.size >= majority) {
      this.becomeLeader();
    }
  }

  // ── Leader ──────────────────────────────────────────────────────────

  /**
   * Transition to leader role. Start heartbeat timer, persist state,
   * call onBecomeLeader callback.
   */
  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.instanceId;
    this.consecutiveUnansweredElections = 0;
    this.clearElectionTimer();

    logger.info('Became leader', {
      instanceId: this.instanceId,
      term: this.currentTerm,
    });

    // Start leader heartbeat
    this.startLeaderHeartbeat();

    // Persist leader state
    this.stateStore
      .save({
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
        leaderId: this.leaderId,
      })
      .catch((err) => {
        logger.error('Failed to persist leader state', {
          error: toErrorMessage(err),
        });
      });

    // Notify callback
    this.onBecomeLeader();
  }

  /**
   * Step down from leader/candidate to follower.
   */
  private stepDown(newTerm: number, newLeaderId?: string): void {
    const wasLeader = this.role === 'leader';

    this.currentTerm = newTerm;
    this.votedFor = null;
    this.role = 'follower';
    this.consecutiveUnansweredElections = 0;

    if (newLeaderId !== undefined) {
      this.leaderId = newLeaderId;
    }

    this.clearLeaderHeartbeat();
    this.resetElectionTimer();

    // Persist state
    this.stateStore
      .save({
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
        leaderId: this.leaderId,
      })
      .catch((err) => {
        logger.error('Failed to persist step-down state', {
          error: toErrorMessage(err),
        });
      });

    if (wasLeader) {
      logger.info('Lost leadership', {
        instanceId: this.instanceId,
        newTerm,
        newLeaderId,
      });
      this.onLoseLeadership();
    } else {
      logger.info('Stepped down', {
        instanceId: this.instanceId,
        newTerm,
        newLeaderId,
      });
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  /**
   * Start sending periodic leader heartbeats (raft.append.entries).
   */
  private startLeaderHeartbeat(): void {
    this.clearLeaderHeartbeat();

    // Send an immediate heartbeat
    this.sendHeartbeat();

    this.leaderHeartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.leaderHeartbeatMs);
  }

  private sendHeartbeat(): void {
    const msg: RaftAppendEntries = {
      type: 'raft.append.entries',
      term: this.currentTerm,
      leaderId: this.instanceId,
    };
    this.broadcastToPeers(msg);
  }

  private clearLeaderHeartbeat(): void {
    if (this.leaderHeartbeatTimer) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }
  }

  /**
   * Handle an incoming append entries (heartbeat) from a leader.
   */
  handleAppendEntries(msg: RaftAppendEntries): void {
    // Receiving a heartbeat proves connectivity — reset unanswered counter
    this.consecutiveUnansweredElections = 0;

    // If message has higher or equal term, accept leader
    if (msg.term >= this.currentTerm) {
      if (msg.term > this.currentTerm || this.role !== 'follower') {
        this.stepDown(msg.term, msg.leaderId);
      } else {
        // Same term, already follower: just update leader and reset timer
        this.leaderId = msg.leaderId;
        this.resetElectionTimer();
      }
    }
    // Ignore heartbeats from older terms
  }
}
