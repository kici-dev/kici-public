import { describe, it, expect, beforeEach } from 'vitest';
import { CacheRefScope } from '@kici-dev/engine';
import { DispatchCacheRefTracker } from './dispatch-cache-ref-tracker.js';

describe('DispatchCacheRefTracker', () => {
  let tracker: DispatchCacheRefTracker;

  beforeEach(() => {
    tracker = new DispatchCacheRefTracker();
  });

  it('records and resolves a dispatched job ref', () => {
    tracker.record('job-1', {
      orgId: 'org-1',
      repoId: 'owner/repo',
      cacheRefScope: CacheRefScope.enum.shared,
      runId: 'run-1',
    });
    expect(tracker.get('job-1')).toEqual({
      orgId: 'org-1',
      repoId: 'owner/repo',
      cacheRefScope: 'shared',
      runId: 'run-1',
    });
  });

  it('returns undefined for an unknown job', () => {
    expect(tracker.get('nope')).toBeUndefined();
  });

  it('records an isolated-scope ref with runId', () => {
    tracker.record('job-2', {
      orgId: 'org-1',
      repoId: 'owner/repo',
      cacheRefScope: CacheRefScope.enum.isolated,
      runId: 'run-2',
    });
    expect(tracker.get('job-2')?.cacheRefScope).toBe('isolated');
    expect(tracker.get('job-2')?.runId).toBe('run-2');
  });

  it('records a sourceless ref (no org/repo)', () => {
    tracker.record('job-3', { runId: 'run-3' });
    const ref = tracker.get('job-3');
    expect(ref?.orgId).toBeUndefined();
    expect(ref?.repoId).toBeUndefined();
    expect(ref?.runId).toBe('run-3');
  });

  it('deletes a job ref on cleanup so the map cannot leak', () => {
    tracker.record('job-1', { runId: 'run-1' });
    expect(tracker.size).toBe(1);
    tracker.delete('job-1');
    expect(tracker.get('job-1')).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it('delete of an unknown job is a no-op', () => {
    tracker.record('job-1', { runId: 'run-1' });
    tracker.delete('other');
    expect(tracker.size).toBe(1);
  });

  it('clear drops every ref', () => {
    tracker.record('a', { runId: 'r1' });
    tracker.record('b', { runId: 'r2' });
    expect(tracker.size).toBe(2);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});
