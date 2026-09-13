import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS,
  OwnershipTracker,
  type OwnershipDbResult,
} from './ownership-tracker.js';

describe('OwnershipTracker', () => {
  let isJobOwnedByAgent: ReturnType<typeof vi.fn>;
  let onDisconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    isJobOwnedByAgent = vi.fn().mockReturnValue(false);
    onDisconnect = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTracker(opts: { threshold?: number; windowMs?: number } = {}) {
    return new OwnershipTracker({
      isJobOwnedByAgent,
      onDisconnect,
      violationThreshold: opts.threshold,
      violationWindowMs: opts.windowMs,
    });
  }

  describe('checkOwnership', () => {
    it('returns true for owned jobs', () => {
      isJobOwnedByAgent.mockReturnValue(true);
      const tracker = createTracker();

      const result = tracker.checkOwnership('agent-1', 'job-1', 'job.status');

      expect(result).toBe(true);
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('returns false for unowned jobs', () => {
      isJobOwnedByAgent.mockReturnValue(false);
      const tracker = createTracker();

      const result = tracker.checkOwnership('agent-1', 'job-1', 'job.status');

      expect(result).toBe(false);
    });

    it('does not disconnect on single violation', () => {
      const tracker = createTracker();

      tracker.checkOwnership('agent-1', 'job-1', 'job.status');

      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('violation counting and escalation', () => {
    it('disconnects after threshold violations within window', () => {
      const tracker = createTracker({ threshold: 3 });

      tracker.checkOwnership('agent-1', 'job-1', 'job.status');
      tracker.checkOwnership('agent-1', 'job-2', 'log.chunk');
      expect(onDisconnect).not.toHaveBeenCalled();

      tracker.checkOwnership('agent-1', 'job-3', 'step.status');
      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
    });

    it('uses default threshold of 5', () => {
      const tracker = createTracker();

      for (let i = 0; i < 4; i++) {
        tracker.checkOwnership('agent-1', `job-${i}`, 'job.status');
      }
      expect(onDisconnect).not.toHaveBeenCalled();

      tracker.checkOwnership('agent-1', 'job-4', 'job.status');
      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
    });

    it('tracks violations per agent independently', () => {
      const tracker = createTracker({ threshold: 3 });

      tracker.checkOwnership('agent-1', 'job-1', 'job.status');
      tracker.checkOwnership('agent-2', 'job-2', 'job.status');
      tracker.checkOwnership('agent-1', 'job-3', 'job.status');
      tracker.checkOwnership('agent-2', 'job-4', 'job.status');

      expect(onDisconnect).not.toHaveBeenCalled();

      tracker.checkOwnership('agent-1', 'job-5', 'job.status');
      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('resets counter when window expires', () => {
      const tracker = createTracker({ threshold: 3, windowMs: 60_000 });

      // Two violations
      tracker.checkOwnership('agent-1', 'job-1', 'job.status');
      tracker.checkOwnership('agent-1', 'job-2', 'job.status');

      // Advance past window
      vi.advanceTimersByTime(61_000);

      // Two more violations -- counter should reset
      tracker.checkOwnership('agent-1', 'job-3', 'job.status');
      tracker.checkOwnership('agent-1', 'job-4', 'job.status');
      expect(onDisconnect).not.toHaveBeenCalled();

      // Third after reset -> triggers disconnect
      tracker.checkOwnership('agent-1', 'job-5', 'job.status');
      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
    });
  });

  describe('cleanup', () => {
    it('removes violation state for agent', () => {
      const tracker = createTracker({ threshold: 3 });

      // Two violations
      tracker.checkOwnership('agent-1', 'job-1', 'job.status');
      tracker.checkOwnership('agent-1', 'job-2', 'job.status');

      // Cleanup
      tracker.cleanup('agent-1');

      // Next violations start fresh -- need 3 more
      tracker.checkOwnership('agent-1', 'job-3', 'job.status');
      tracker.checkOwnership('agent-1', 'job-4', 'job.status');
      expect(onDisconnect).not.toHaveBeenCalled();

      tracker.checkOwnership('agent-1', 'job-5', 'job.status');
      expect(onDisconnect).toHaveBeenCalledOnce();
    });

    it('does not affect other agents', () => {
      const tracker = createTracker({ threshold: 3 });

      tracker.checkOwnership('agent-1', 'job-1', 'job.status');
      tracker.checkOwnership('agent-2', 'job-2', 'job.status');

      tracker.cleanup('agent-1');

      // agent-2 still has 1 violation
      tracker.checkOwnership('agent-2', 'job-3', 'job.status');
      tracker.checkOwnership('agent-2', 'job-4', 'job.status');
      expect(onDisconnect).toHaveBeenCalledWith('agent-2', 'Too many ownership violations');
    });
  });

  describe('validateAsync with a DB fallback', () => {
    function createDbTracker(
      lookup: (agentId: string, jobId: string) => Promise<OwnershipDbResult>,
      opts: { threshold?: number; getTimeoutMs?: () => Promise<number> } = {},
    ) {
      return new OwnershipTracker({
        isJobOwnedByAgent,
        isJobOwnedByAgentInDb: lookup,
        onDisconnect,
        violationThreshold: opts.threshold ?? 3,
        ...(opts.getTimeoutMs ? { getTimeoutMs: opts.getTimeoutMs } : {}),
      });
    }

    it('accepts an `owned` verdict and caches it for the next frame', async () => {
      const lookup = vi.fn().mockResolvedValue('owned' as OwnershipDbResult);
      const tracker = createDbTracker(lookup);

      await expect(tracker.validateAsync('agent-1', 'job-1', 'job.status')).resolves.toBe(true);
      // The cached pair short-circuits the synchronous check, so the DB is not
      // consulted a second time.
      expect(tracker.checkOwnership('agent-1', 'job-1', 'job.status')).toBe(true);
      expect(lookup).toHaveBeenCalledOnce();
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('records a violation for a decided `not-owned` verdict', async () => {
      const lookup = vi.fn().mockResolvedValue('not-owned' as OwnershipDbResult);
      const tracker = createDbTracker(lookup, { threshold: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(tracker.validateAsync('agent-1', `job-${i}`, 'job.status')).resolves.toBe(
          false,
        );
      }

      expect(onDisconnect).toHaveBeenCalledWith('agent-1', 'Too many ownership violations');
    });

    it('refuses an `unknown` verdict WITHOUT recording a violation', async () => {
      const lookup = vi.fn().mockResolvedValue('unknown' as OwnershipDbResult);
      const tracker = createDbTracker(lookup, { threshold: 3 });

      // Far past the escalation threshold: an unanswerable check is not
      // evidence, so one database outage must not disconnect the fleet.
      for (let i = 0; i < 10; i++) {
        await expect(tracker.validateAsync('agent-1', `job-${i}`, 'job.status')).resolves.toBe(
          false,
        );
      }

      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('treats a throwing lookup as undecided, not as a violation', async () => {
      const lookup = vi.fn().mockRejectedValue(new Error('connection reset'));
      const tracker = createDbTracker(lookup, { threshold: 3 });

      for (let i = 0; i < 10; i++) {
        await expect(tracker.validateAsync('agent-1', `job-${i}`, 'job.status')).resolves.toBe(
          false,
        );
      }

      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('resolves `unknown` when the lookup outruns the deadline', async () => {
      // A lookup that never settles: without the deadline race this assertion
      // could not resolve at all, so the test fails loudly if the bound is
      // removed rather than passing vacuously.
      const lookup = vi.fn().mockReturnValue(new Promise<OwnershipDbResult>(() => {}));
      const tracker = createDbTracker(lookup, {
        threshold: 3,
        getTimeoutMs: async () => 250,
      });

      const pending = tracker.validateAsync('agent-1', 'job-1', 'job.status');
      // Flush the `await getTimeoutMs()` microtask, then cross the deadline.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('reads the deadline fresh on every lookup', async () => {
      const getTimeoutMs = vi.fn().mockResolvedValue(1_000);
      const lookup = vi.fn().mockResolvedValue('owned' as OwnershipDbResult);
      const tracker = createDbTracker(lookup, { getTimeoutMs });

      await tracker.validateAsync('agent-1', 'job-1', 'job.status');
      await tracker.validateAsync('agent-1', 'job-2', 'job.status');

      expect(getTimeoutMs).toHaveBeenCalledTimes(2);
    });

    it('leaves no pending timer behind after a fast lookup', async () => {
      const lookup = vi.fn().mockResolvedValue('owned' as OwnershipDbResult);
      const tracker = createDbTracker(lookup, { getTimeoutMs: async () => 60_000 });

      await tracker.validateAsync('agent-1', 'job-1', 'job.status');

      // A leaked deadline timer would still be armed here; the `finally` clear
      // is what makes the count zero.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('falls back to the default deadline when the knob read itself stalls', async () => {
      // The knob lives in the same database the deadline exists to survive, so
      // an unbounded read would hang the frame instead of refusing it.
      const lookup = vi.fn().mockReturnValue(new Promise<OwnershipDbResult>(() => {}));
      const tracker = createDbTracker(lookup, {
        getTimeoutMs: () => new Promise<number>(() => {}),
      });

      const pending = tracker.validateAsync('agent-1', 'job-1', 'job.status');
      await vi.advanceTimersByTimeAsync(0);
      // First the bounded knob read gives up, then the lookup deadline runs.
      await vi.advanceTimersByTimeAsync(DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS);

      await expect(pending).resolves.toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('falls back to the default deadline when the knob read throws', async () => {
      const lookup = vi.fn().mockReturnValue(new Promise<OwnershipDbResult>(() => {}));
      const tracker = createDbTracker(lookup, {
        getTimeoutMs: async () => {
          throw new Error('cluster_settings unreadable');
        },
      });

      const pending = tracker.validateAsync('agent-1', 'job-1', 'job.status');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS);

      await expect(pending).resolves.toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('ignores a deadline larger than setTimeout can honour', async () => {
      // Node collapses a delay past the signed 32-bit maximum to 1ms, so an
      // unclamped knob would invert a generous override into an instant one.
      const lookup = vi.fn().mockReturnValue(new Promise<OwnershipDbResult>(() => {}));
      const tracker = createDbTracker(lookup, { getTimeoutMs: async () => 5_000_000_000 });

      let settled = false;
      const pending = tracker.validateAsync('agent-1', 'job-1', 'job.status').then((v) => {
        settled = true;
        return v;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(DEFAULT_OWNERSHIP_DB_CHECK_TIMEOUT_MS);
      await expect(pending).resolves.toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });
});
