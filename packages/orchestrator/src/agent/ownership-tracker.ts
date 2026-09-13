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

/**
 * Verdict of the DB-backed ownership lookup.
 *
 * `unknown` is the load-bearing member: it separates "the database says this
 * agent does not own the job" (evidence of a misrouted or spoofed frame) from
 * "the lookup could not be answered" (a query failure or a timeout). Only the
 * former is a violation — counting an unanswerable check as evidence would let
 * one transient database outage disconnect every connected agent at once.
 */
export type OwnershipDbResult = 'owned' | 'not-owned' | 'unknown';

/** Deadline for a single DB-backed ownership lookup before it resolves `unknown`. */
export const DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS = 5_000;

/**
 * Largest delay `setTimeout` honours. Node silently collapses anything above
 * the signed 32-bit maximum to 1ms, so a deadline past this point would invert
 * into an instant one and refuse every frame — the opposite of what an
 * operator raising the knob asked for.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface OwnershipTrackerOpts {
  /** Check if a job is owned by the given agent (active or in grace window). */
  isJobOwnedByAgent: (agentId: string, jobId: string) => boolean;
  /**
   * Optional DB-backed fallback. Returns `owned` when the orchestrator DB shows
   * the (agent, job) pair as held by this coord OR a sibling coord — i.e.
   * currently `dispatched`/`recovering` with the same `agent_id` /
   * `recovery_agent_id`, or already terminal. `not-owned` is a decided refusal;
   * `unknown` means the lookup itself could not be answered.
   *
   * When a Raft leader switch wipes the in-memory `agentJobs` Map on the
   * replacement coord, this fallback accepts late frames from agents that are
   * still draining instead of rejecting them as ownership violations.
   */
  isJobOwnedByAgentInDb?: (agentId: string, jobId: string) => Promise<OwnershipDbResult>;
  /**
   * Per-lookup deadline in ms, read fresh on every call so an operator can
   * retune it fleet-wide without a restart. The read is itself bounded by
   * {@link DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS}, which is also the fallback
   * when it stalls, throws, or returns a delay `setTimeout` cannot honour.
   */
  getTimeoutMs?: () => Promise<number>;
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
    ((agentId: string, jobId: string) => Promise<OwnershipDbResult>) | undefined;
  private readonly getTimeoutMs?: (() => Promise<number>) | undefined;
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
    this.getTimeoutMs = opts.getTimeoutMs;
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
   * acceptance of post-failover frames. Returns true if the DB shows
   * the (agent, job) pair as currently or recently owned by any coord
   * in the cluster. On `owned`, caches the result so subsequent
   * same-pair frames return true synchronously via `checkOwnership`.
   * On `not-owned`, records a violation exactly once (no recursive
   * recordViolation from the synchronous call site — `checkOwnership`
   * skipped it when the DB fallback was configured). On `unknown` the
   * frame is refused without a violation: an unanswerable check is not
   * evidence of misbehaviour, and treating it as such would let one
   * database outage disconnect the whole fleet.
   */
  async validateAsync(agentId: string, jobId: string, messageType: string): Promise<boolean> {
    if (this.isJobOwnedByAgent(agentId, jobId)) return true;
    const cached = this.dbAccepted.get(agentId);
    if (cached?.has(jobId)) return true;

    if (!this.isJobOwnedByAgentInDb) {
      // No async fallback configured: parity with the synchronous path,
      // whose `checkOwnership` already recorded the violation.
      return false;
    }

    const result = await this.resolveFromDb(agentId, jobId);

    if (result === 'owned') {
      this.rememberDbAccepted(agentId, jobId);
      return true;
    }

    if (result === 'unknown') {
      logger.warn('Ownership undecided; refusing without recording a violation', {
        agentId,
        jobId,
        messageType,
      });
      return false;
    }

    logger.warn(`Ownership violation: ${messageType} from agent ${agentId} for job ${jobId}`);
    this.recordViolation(agentId);
    return false;
  }

  /**
   * Run the DB-backed lookup under a deadline. A query that throws or outruns
   * the deadline resolves `unknown` — never `not-owned` — so a sick database
   * refuses frames without accusing the agent of anything.
   */
  private async resolveFromDb(agentId: string, jobId: string): Promise<OwnershipDbResult> {
    const lookup = this.isJobOwnedByAgentInDb;
    if (!lookup) return 'unknown';

    const timeoutMs = await this.resolveTimeoutMs();

    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<OwnershipDbResult>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), timeoutMs);
      });
      return await Promise.race([lookup(agentId, jobId), deadline]);
    } catch (err) {
      logger.warn('DB ownership check failed; treating as undecided', {
        agentId,
        jobId,
        error: String(err),
      });
      return 'unknown';
    } finally {
      // Every fast path leaves a pending timer behind without this.
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolve the deadline for one lookup, itself bounded by
   * {@link DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS}.
   *
   * The knob is stored in the same database the deadline exists to survive, so
   * reading it unbounded would stall the very frame the deadline is there to
   * refuse — the agent would wait out its own acknowledgment deadline instead
   * of getting an answer. A read that stalls, throws, or yields a value
   * `setTimeout` cannot honour (non-finite, sub-millisecond, or past
   * {@link MAX_TIMER_DELAY_MS}) falls back to the compile-time default.
   */
  private async resolveTimeoutMs(): Promise<number> {
    const read = this.getTimeoutMs;
    if (!read) return DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    try {
      const fallback = new Promise<number>((resolve) => {
        timer = setTimeout(
          () => resolve(DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS),
          DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS,
        );
      });
      const value = await Promise.race([read(), fallback]);
      if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
        logger.warn('Unusable ownership DB check timeout; using the default', { value });
        return DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS;
      }
      return value;
    } catch (err) {
      logger.warn('Failed to read the ownership DB check timeout; using the default', {
        error: String(err),
      });
      return DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Cache a DB-proven (agent, job) pair so the next frame on the same pair
   * short-circuits in `checkOwnership`. The per-agent set is capped (generously
   * — a typical agent runs a handful of jobs) so a misbehaving agent cannot
   * grow it without bound.
   */
  private rememberDbAccepted(agentId: string, jobId: string): void {
    let set = this.dbAccepted.get(agentId);
    if (!set) {
      set = new Set();
      this.dbAccepted.set(agentId, set);
    }
    set.add(jobId);
    if (set.size > 1024) {
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
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
