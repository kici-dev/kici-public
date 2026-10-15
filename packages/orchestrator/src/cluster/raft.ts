/**
 * Minimal Raft leader election implementation.
 *
 * Implements only leader election (no log replication) for cluster coordination.
 * State machine: follower -> candidate -> leader. State is persisted to Postgres
 * via RaftStateStore for crash recovery. Election timeout is 5-10s with randomized
 * jitter (WAN-appropriate). Leader sends heartbeats every 2s.
 *
 * Dormant mode: When peerRegistry has 0 connected peers, the node self-elects
 * immediately (single-orchestrator deployment). If peers connect later, normal
 * election resumes.
 *
 * `stop()` takes the node out of every election until the next `start()`: it
 * ends the node's leadership and ignores every election input afterwards, so a
 * process that is shutting down cannot be elected again.
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
  /** Grace period in ms before dormant-mode self-election. Default: 0. */
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
  /**
   * Set by {@link stop}. A stopped node takes no further part in any election:
   * it belongs to a process that is shutting down, and an election would restart
   * the leader-only services the shutdown is stopping and write Raft state to a
   * database that is being closed.
   */
  private stopped = false;

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private votesReceived = new Set<string>();

  /**
   * Consecutive elections no peer answered. Past the threshold the node
   * force-self-elects: a safety valve against delayed WebSocket close detection
   * (a dead peer still appears connected).
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

  /** Loads persisted state and starts as a follower with an election timer. */
  async start(): Promise<void> {
    const state = await this.stateStore.load();
    this.currentTerm = state.currentTerm;
    this.votedFor = state.votedFor;
    this.leaderId = state.leaderId;
    this.role = 'follower';
    this.stopped = false;
    this.startedAt = Date.now();

    logger.info('Raft node started', {
      instanceId: this.instanceId,
      currentTerm: this.currentTerm,
      leaderId: this.leaderId,
    });

    this.resetElectionTimer();
  }

  /**
   * Clears the timers, ends leadership (so the leader-only services stop with
   * it), and persists state. Every election input after this is ignored until
   * the next {@link start}. A second call does nothing.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearElectionTimer();
    this.clearLeaderHeartbeat();
    const wasLeader = this.role === 'leader';
    this.role = 'follower';
    if (wasLeader) {
      this.leaderId = null;
      this.onLoseLeadership();
    }

    // The cluster shares one raft_state row, and the remaining coordinators may
    // already have elected a new leader in a newer term: never overwrite it.
    await this.stateStore.saveUnlessNewerTerm({
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      leaderId: this.leaderId,
    });

    logger.info('Raft node stopped', { instanceId: this.instanceId, wasLeader });
  }

  isLeader(): boolean {
    return this.role === 'leader';
  }

  getLeaderId(): string | null {
    return this.leaderId;
  }

  getCurrentTerm(): number {
    return this.currentTerm;
  }

  /** For testing and diagnostics. */
  getRole(): RaftRole {
    return this.role;
  }

  // ── Peer leaving ───────────────────────────────────────────────────

  /**
   * Handle a peer.leaving announcement. If the leaving peer is the leader, clear
   * leaderId and start a new election at once; otherwise do nothing (the caller
   * updates the peer registry first).
   */
  handlePeerLeaving(instanceId: string): void {
    if (this.stopped) return;
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

  /** Restart the election timer with a randomized timeout. */
  resetElectionTimer(): void {
    this.clearElectionTimer();
    if (this.stopped) return;

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
   * Without this, the node waits for the full election timeout (5-10s by default)
   * before discovering all peers are gone.
   */
  onPeerDisconnected(): void {
    if (this.stopped) return;
    if (this.role !== 'leader' && this.peerRegistry.getConnectedCoordinatorPeerCount() === 0) {
      // Within the grace period, use the normal election timer.
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
   * Increment the term, vote for self and request votes. With no peers
   * connected, self-elect at once (dormant mode).
   */
  private startElection(): void {
    if (this.stopped) return;
    this.currentTerm++;
    this.votedFor = this.instanceId;
    this.role = 'candidate';
    this.votesReceived = new Set([this.instanceId]); // Vote for self

    logger.info('Starting election', {
      instanceId: this.instanceId,
      term: this.currentTerm,
    });

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

    // Workers do not vote: quorum counts coordinator peers only.
    const connectedPeerCount = this.peerRegistry.getConnectedCoordinatorPeerCount();

    // Dormant mode: no coordinator peers, so self-elect at once.
    if (connectedPeerCount === 0) {
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

    // Safety valve: unanswered elections mean the peers are likely dead before
    // their WebSocket close is detected; self-elect rather than stay a candidate.
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

    const voteRequest: RaftVoteRequest = {
      type: 'raft.vote.request',
      term: this.currentTerm,
      candidateId: this.instanceId,
      lastLogIndex: 0,
      lastLogTerm: 0,
    };

    this.broadcastToPeers(voteRequest);

    // The self-vote alone may be a majority (with 1 peer, majority is 2).
    this.checkMajority();

    // Retry if the votes fall short.
    this.resetElectionTimer();
  }

  handleVoteRequest(msg: RaftVoteRequest): RaftVoteResponse {
    if (this.stopped) {
      return {
        type: 'raft.vote.response',
        term: this.currentTerm,
        voteGranted: false,
        voterId: this.instanceId,
      };
    }

    if (msg.term > this.currentTerm) {
      this.stepDown(msg.term);
    }

    const voteGranted =
      msg.term >= this.currentTerm && (this.votedFor === null || this.votedFor === msg.candidateId);

    if (voteGranted) {
      this.votedFor = msg.candidateId;

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

  handleVoteResponse(msg: RaftVoteResponse): void {
    if (this.stopped) return;
    if (msg.term > this.currentTerm) {
      this.stepDown(msg.term);
      return;
    }

    if (this.role !== 'candidate' || msg.term !== this.currentTerm) {
      return;
    }

    // Any response, granted or not, proves peers are reachable.
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

  /** Cluster size = connected coordinator peers + self. */
  private checkMajority(): void {
    if (this.role !== 'candidate') return;

    const clusterSize = this.peerRegistry.getConnectedCoordinatorPeerCount() + 1; // +1 for self (coordinator peers only)
    const majority = Math.floor(clusterSize / 2) + 1;

    if (this.votesReceived.size >= majority) {
      this.becomeLeader();
    }
  }

  // ── Leader ──────────────────────────────────────────────────────────

  private becomeLeader(): void {
    if (this.stopped) return;
    this.role = 'leader';
    this.leaderId = this.instanceId;
    this.consecutiveUnansweredElections = 0;
    this.clearElectionTimer();

    logger.info('Became leader', {
      instanceId: this.instanceId,
      term: this.currentTerm,
    });

    this.startLeaderHeartbeat();

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

    this.onBecomeLeader();
  }

  private stepDown(newTerm: number, newLeaderId?: string): void {
    if (this.stopped) return;
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

  /** Periodic leader heartbeats (raft.append.entries). */
  private startLeaderHeartbeat(): void {
    this.clearLeaderHeartbeat();

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

  handleAppendEntries(msg: RaftAppendEntries): void {
    if (this.stopped) return;
    // A heartbeat proves connectivity.
    this.consecutiveUnansweredElections = 0;

    if (msg.term >= this.currentTerm) {
      if (msg.term > this.currentTerm || this.role !== 'follower') {
        this.stepDown(msg.term, msg.leaderId);
      } else {
        this.leaderId = msg.leaderId;
        this.resetElectionTimer();
      }
    }
    // Ignore heartbeats from older terms
  }
}
