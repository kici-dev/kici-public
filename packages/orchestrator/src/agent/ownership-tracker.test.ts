import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OwnershipTracker } from './ownership-tracker.js';

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
});
