/**
 * Job ownership tracker for agent message validation.
 *
 * Validates that agents only send messages (job.status, log.chunk, step.status,
 * job.heartbeat, cache.upload.request, cache.upload.complete) for jobs that were
 * actually dispatched to them.
 *
 * Includes:
 * - Ownership check via dispatcher's isJobOwnedByAgent
 * - Violation counting with sliding window (default: 5 violations in 60s)
 * - Escalation: disconnect agent after threshold violations
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'ownership-tracker' });

interface OwnershipTrackerOpts {
  /** Check if a job is owned by the given agent (active or in grace window). */
  isJobOwnedByAgent: (agentId: string, jobId: string) => boolean;
  /**
   * Optional DB-backed fallback. Returns true when the orchestrator
   * DB shows the (agent, job) pair as previously owned by this coord
   * OR a sibling coord — i.e. either currently `dispatched`/`recovering`
   * with the same `agent_id` / `recovery_agent_id`, or recently
   * `completed`/`failed`. When a Raft leader switch wipes the
   * in-memory `agentJobs` Map on the replacement coord, this fallback
   * accepts late `log.chunk` / `step.status` chunks from agents that
   * are still draining instead of rejecting them as ownership
   * violations.
   */
  isJobOwnedByAgentInDb?: (agentId: string, jobId: string) => Promise<boolean>;
  /** Callback to disconnect an agent after escalation. */
  onDisconnect: (agentId: string, reason: string) => void;
  /** Number of violations before escalation (default: 5). */
  violationThreshold?: number;
  /** Window in ms for counting violations (default: 60_000). */
  violationWindowMs?: number;
}

interface ViolationEntry {
  count: number;
  windowStart: number;
}

export class OwnershipTracker {
  private readonly isJobOwnedByAgent: (agentId: string, jobId: string) => boolean;
  private readonly isJobOwnedByAgentInDb?:
    | ((agentId: string, jobId: string) => Promise<boolean>)
    | undefined;
  private readonly onDisconnect: (agentId: string, reason: string) => void;
  private readonly violationThreshold: number;
  private readonly violationWindowMs: number;
  private readonly violations = new Map<string, ViolationEntry>();
  /**
   * L1 cache of `(agentId, jobId)` pairs proven by a positive DB
   * fallback. Pre-empts a synchronous warn-and-reject for the very
   * next chunk on the same pair, since `checkOwnership` is called
   * once per inbound message and the local Map repopulation lags
   * behind. The cache is intentionally small (per-agent capped) and
   * is cleaned on agent disconnect via `cleanup(agentId)`.
   */
  private readonly dbAccepted = new Map<string, Set<string>>();

  constructor(opts: OwnershipTrackerOpts) {
    this.isJobOwnedByAgent = opts.isJobOwnedByAgent;
    this.isJobOwnedByAgentInDb = opts.isJobOwnedByAgentInDb;
    this.onDisconnect = opts.onDisconnect;
    this.violationThreshold = opts.violationThreshold ?? 5;
    this.violationWindowMs = opts.violationWindowMs ?? 60_000;
  }

  /**
   * Synchronous ownership check. Returns true if ownership is valid
   * per the in-memory dispatcher OR a previously-accepted DB fallback.
   *
   * Returns false WITHOUT recording a violation when a DB fallback is
   * configured: the caller is expected to invoke `validateAsync` to
   * confirm or reject the ownership before treating it as a real
   * violation. This makes the writer idempotent across HA failover —
   * a `log.chunk` arriving on the replacement coord doesn't get
   * counted as a violation just because the local Map is empty.
   */
  checkOwnership(agentId: string, jobId: string, messageType: string): boolean {
    if (this.isJobOwnedByAgent(agentId, jobId)) return true;

    const cached = this.dbAccepted.get(agentId);
    if (cached?.has(jobId)) return true;

    if (this.isJobOwnedByAgentInDb) {
      // Defer the violation decision to the async validator the caller
      // is expected to run. The synchronous return signals "do not
      // process this message in the synchronous path yet" — the async
      // handler then re-evaluates.
      logger.debug(
        `Ownership pending DB check: ${messageType} from agent ${agentId} for job ${jobId}`,
      );
      return false;
    }

    logger.warn(`Ownership violation: ${messageType} from agent ${agentId} for job ${jobId}`);
    this.recordViolation(agentId);
    return false;
  }

  /**
   * Async fallback used by message handlers that want HA-safe
   * acceptance of post-failover chunks. Returns true if the DB shows
   * the (agent, job) pair as currently or recently owned by any coord
   * in the cluster. On true, caches the result so subsequent same-pair
   * chunks return true synchronously via `checkOwnership`. On false,
   * records a violation exactly once (no recursive recordViolation
   * from the synchronous call site — `checkOwnership` skipped it
   * when the DB fallback was configured).
   */
  async validateAsync(agentId: string, jobId: string, messageType: string): Promise<boolean> {
    if (this.isJobOwnedByAgent(agentId, jobId)) return true;
    const cached = this.dbAccepted.get(agentId);
    if (cached?.has(jobId)) return true;

    if (!this.isJobOwnedByAgentInDb) {
      // No async fallback configured: parity with the legacy
      // synchronous path — violation already recorded by
      // `checkOwnership`.
      return false;
    }

    let owned = false;
    try {
      owned = await this.isJobOwnedByAgentInDb(agentId, jobId);
    } catch (err) {
      logger.warn('DB ownership check failed; treating as miss', {
        agentId,
        jobId,
        error: String(err),
      });
      owned = false;
    }

    if (owned) {
      let set = this.dbAccepted.get(agentId);
      if (!set) {
        set = new Set();
        this.dbAccepted.set(agentId, set);
      }
      set.add(jobId);
      // Cap the per-agent cache to avoid unbounded growth from a
      // misbehaving agent. The cap is generous (1024) — typical
      // agents run a handful of jobs.
      if (set.size > 1024) {
        const first = set.values().next().value;
        if (first !== undefined) set.delete(first);
      }
      return true;
    }

    logger.warn(`Ownership violation: ${messageType} from agent ${agentId} for job ${jobId}`);
    this.recordViolation(agentId);
    return false;
  }

  /**
   * Record a violation for an agent. If threshold is exceeded within the
   * violation window, triggers disconnect escalation.
   */
  private recordViolation(agentId: string): void {
    const now = Date.now();
    let entry = this.violations.get(agentId);

    if (!entry) {
      entry = { count: 0, windowStart: now };
      this.violations.set(agentId, entry);
    }

    // Reset counter if window has expired
    if (entry.windowStart + this.violationWindowMs < now) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count++;

    if (entry.count >= this.violationThreshold) {
      this.violations.delete(agentId);
      this.onDisconnect(agentId, 'Too many ownership violations');
    }
  }

  /**
   * Clean up violation tracking AND the DB-accepted cache for a
   * disconnected agent. Avoids cross-agent leakage when the same
   * agent id is later reused.
   */
  cleanup(agentId: string): void {
    this.violations.delete(agentId);
    this.dbAccepted.delete(agentId);
  }
}
