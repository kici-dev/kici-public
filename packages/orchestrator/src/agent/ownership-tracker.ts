/**
 * Validates that agents only send messages (job.status, log.chunk, step.status,
 * job.heartbeat, cache.upload.request, cache.upload.complete) for jobs
 * dispatched to them. Violations are counted in a window (default: 5 in 60s);
 * reaching the threshold disconnects the agent.
 */

import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'ownership-tracker' });

/**
 * Verdict of the DB-backed ownership lookup. `unknown` (query failure or
 * timeout) is distinct from `not-owned` (evidence of a misrouted or spoofed
 * frame): only `not-owned` is a violation, else one transient database outage
 * would disconnect every connected agent at once.
 */
export type OwnershipDbResult = 'owned' | 'not-owned' | 'unknown';

/** Deadline for a single DB-backed ownership lookup before it resolves `unknown`. */
export const DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS = 5_000;

/**
 * Largest delay `setTimeout` honours: Node silently collapses anything above
 * the signed 32-bit maximum to 1ms, which would refuse every frame.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface OwnershipTrackerOpts {
  /** Check if a job is owned by the given agent (active or in grace window). */
  isJobOwnedByAgent: (agentId: string, jobId: string) => boolean;
  /**
   * Optional DB-backed fallback: `owned` when the DB shows the (agent, job)
   * pair held by this coord OR a sibling — `dispatched`/`recovering` with the
   * same `agent_id` / `recovery_agent_id`, or already terminal. It accepts late
   * frames from draining agents after a Raft leader switch wipes the in-memory
   * `agentJobs` Map on the replacement coord.
   */
  isJobOwnedByAgentInDb?: (agentId: string, jobId: string) => Promise<OwnershipDbResult>;
  /**
   * Per-lookup deadline in ms, read fresh on every call so an operator can
   * retune it without a restart. Bounded and defaulted as `resolveTimeoutMs`
   * describes.
   */
  getTimeoutMs?: () => Promise<number>;
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
   * `(agentId, jobId)` pairs proven by a positive DB fallback, so the next
   * per-message `checkOwnership` on the pair passes while the local Map
   * repopulation lags. Per-agent capped; cleared by `cleanup(agentId)`.
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
   * True when the in-memory dispatcher OR a previously-accepted DB fallback
   * shows ownership. With a DB fallback configured, returns false WITHOUT
   * recording a violation: the caller must run `validateAsync` to decide, so a
   * `log.chunk` on an HA replacement coord with an empty local Map is not
   * counted as a violation.
   */
  checkOwnership(agentId: string, jobId: string, messageType: string): boolean {
    if (this.isJobOwnedByAgent(agentId, jobId)) return true;

    const cached = this.dbAccepted.get(agentId);
    if (cached?.has(jobId)) return true;

    if (this.isJobOwnedByAgentInDb) {
      // Not processed synchronously; the caller's `validateAsync` decides.
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
   * HA-safe acceptance of post-failover frames: true when the DB shows the
   * (agent, job) pair currently or recently owned by any coord. `owned` is
   * cached so later same-pair frames pass `checkOwnership` synchronously.
   * `not-owned` records the violation exactly once (`checkOwnership` skipped
   * it). `unknown` refuses the frame without a violation (see
   * {@link OwnershipDbResult}).
   */
  async validateAsync(agentId: string, jobId: string, messageType: string): Promise<boolean> {
    if (this.isJobOwnedByAgent(agentId, jobId)) return true;
    const cached = this.dbAccepted.get(agentId);
    if (cached?.has(jobId)) return true;

    if (!this.isJobOwnedByAgentInDb) {
      // `checkOwnership` already recorded the violation.
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
   * DB lookup under a deadline. A query that throws or outruns it resolves
   * `unknown`, never `not-owned`, so a sick database never accuses the agent.
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
   * The per-lookup deadline, its read bounded by
   * {@link DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS}: the knob lives in the same
   * database the deadline exists to survive, and an unbounded read would make
   * the agent wait out its own acknowledgment deadline. A read that stalls,
   * throws, or yields a value `setTimeout` cannot honour (non-finite,
   * sub-millisecond, or past {@link MAX_TIMER_DELAY_MS}) uses the default.
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
   * The per-agent set is capped (generously — a typical agent runs a handful
   * of jobs) so a misbehaving agent cannot grow it without bound.
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
   * Record a violation for an agent. Reaching the threshold within the
   * violation window triggers disconnect escalation.
   */
  private recordViolation(agentId: string): void {
    const now = Date.now();
    let entry = this.violations.get(agentId);

    if (!entry) {
      entry = { count: 0, windowStart: now };
      this.violations.set(agentId, entry);
    }

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
   * Clears violations AND the DB-accepted cache for a disconnected agent, so a
   * reused agent id inherits nothing.
   */
  cleanup(agentId: string): void {
    this.violations.delete(agentId);
    this.dbAccepted.delete(agentId);
  }
}
