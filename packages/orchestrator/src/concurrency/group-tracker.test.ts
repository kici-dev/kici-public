import { describe, it, expect, beforeEach } from 'vitest';
import { ConcurrencyGroupTracker } from './group-tracker.js';

describe('ConcurrencyGroupTracker', () => {
  let tracker: ConcurrencyGroupTracker;

  beforeEach(() => {
    tracker = new ConcurrencyGroupTracker();
  });

  describe('acquireSlot', () => {
    it('returns true when no active runs exist', () => {
      const result = tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 1 });
      expect(result).toBe(true);
    });

    it('returns false when at max capacity', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 1 });
      const result = tracker.acquireSlot('deploy-main', 'routing1', 'run-2', { max: 1 });
      expect(result).toBe(false);
    });

    it('returns true when under max capacity', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 3 });
      tracker.acquireSlot('deploy-main', 'routing1', 'run-2', { max: 3 });
      const result = tracker.acquireSlot('deploy-main', 'routing1', 'run-3', { max: 3 });
      expect(result).toBe(true);
    });

    it('does not double-add the same run ID', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 2 });
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 2 });
      expect(tracker.getActiveRuns('deploy-main', 'routing1')).toEqual(['run-1']);
    });
  });

  describe('releaseSlot', () => {
    it('frees a slot after release', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 1 });
      tracker.releaseSlot('deploy-main', 'routing1', 'run-1');
      const result = tracker.acquireSlot('deploy-main', 'routing1', 'run-2', { max: 1 });
      expect(result).toBe(true);
    });

    it('is a no-op for unknown run IDs', () => {
      // Should not throw
      tracker.releaseSlot('deploy-main', 'routing1', 'unknown-run');
    });
  });

  describe('getActiveRuns', () => {
    it('returns list of active run IDs', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 3 });
      tracker.acquireSlot('deploy-main', 'routing1', 'run-2', { max: 3 });
      const active = tracker.getActiveRuns('deploy-main', 'routing1');
      expect(active).toEqual(expect.arrayContaining(['run-1', 'run-2']));
      expect(active).toHaveLength(2);
    });

    it('returns empty array for unknown group', () => {
      expect(tracker.getActiveRuns('unknown', 'routing1')).toEqual([]);
    });
  });

  describe('getOldestRun', () => {
    it('returns the oldest active run', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 3 });
      tracker.acquireSlot('deploy-main', 'routing1', 'run-2', { max: 3 });
      expect(tracker.getOldestRun('deploy-main', 'routing1')).toBe('run-1');
    });

    it('returns null for empty group', () => {
      expect(tracker.getOldestRun('deploy-main', 'routing1')).toBeNull();
    });
  });

  describe('routing key scoping', () => {
    it('groups are independent per routing key', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 1 });
      // Same group key, different routing key -- should be independent
      const result = tracker.acquireSlot('deploy-main', 'routing2', 'run-2', { max: 1 });
      expect(result).toBe(true);
    });

    it('release on one routing key does not affect another', () => {
      tracker.acquireSlot('deploy-main', 'routing1', 'run-1', { max: 1 });
      tracker.acquireSlot('deploy-main', 'routing2', 'run-2', { max: 1 });
      tracker.releaseSlot('deploy-main', 'routing1', 'run-1');
      // routing2 should still be at capacity
      const result = tracker.acquireSlot('deploy-main', 'routing2', 'run-3', { max: 1 });
      expect(result).toBe(false);
    });
  });

  describe('hydrate', () => {
    it('restores active runs from DB records', () => {
      tracker.hydrate([
        { groupKey: 'deploy-main', routingKey: 'routing1', runId: 'run-1' },
        { groupKey: 'deploy-main', routingKey: 'routing1', runId: 'run-2' },
        { groupKey: 'build-pr', routingKey: 'routing2', runId: 'run-3' },
      ]);
      expect(tracker.getActiveRuns('deploy-main', 'routing1')).toHaveLength(2);
      expect(tracker.getActiveRuns('build-pr', 'routing2')).toHaveLength(1);
    });
  });
});
