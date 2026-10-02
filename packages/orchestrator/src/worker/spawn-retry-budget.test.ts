import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SpawnAttemptGate, SpawnRetryBudget } from './spawn-retry-budget.js';

describe('SpawnRetryBudget', () => {
  let queued: Set<string>;
  let redrive: Mock<(jobId: string) => Promise<unknown>>;
  let budget: SpawnRetryBudget;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

  /** Start one attempt that spawns `agentId`, as the worker's scale-request wrapper does. */
  function attempt(agentId: string): void {
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
    budget.setHolder('job-1', agentId);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    queued = new Set(['job-1']);
    redrive = vi.fn<(jobId: string) => Promise<unknown>>().mockResolvedValue(true);
    budget = new SpawnRetryBudget({ isQueued: (id) => queued.has(id), redrive, logger });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an unregistered job is untracked, so its spawn proceeds as before', () => {
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.untracked);
  });

  it('allows one spawn in flight per job', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
    // fails-when: two spawns start for one rerouted job
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum['in-flight']);
    budget.abortAttempt('job-1');
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
  });

  it('refuses a job no longer in the queue', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    queued.delete('job-1');
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum['not-queued']);
  });

  it('does not count a failure for an unregistered or no-longer-queued job', () => {
    expect(budget.recordFailure('job-1', 'a1')).toEqual({ tracked: false });
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    queued.delete('job-1');
    // breaks-if-wrong: a failure after an agent took the job is charged to the spawn budget
    expect(budget.recordFailure('job-1', 'a1')).toEqual({ tracked: false });
  });

  it('counts distinct agents and calls the last attempt final', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 0 });
    attempt('a1');
    expect(budget.recordFailure('job-1', 'a1')).toEqual({
      tracked: true,
      final: false,
      failures: 1,
      maxAttempts: 3,
      duplicate: false,
    });
    attempt('a2');
    expect(budget.recordFailure('job-1', 'a2')).toMatchObject({ final: false, failures: 2 });
    expect(budget.recordFailure('job-1', 'a2')).toMatchObject({
      final: false,
      failures: 2,
      duplicate: true,
    });
    attempt('a3');
    expect(budget.recordFailure('job-1', 'a3')).toMatchObject({
      final: true,
      failures: 3,
      duplicate: false,
    });
  });

  it('a budget of one attempt makes the first failure final', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 1, backoffMs: 1000 });
    attempt('a1');
    expect(budget.recordFailure('job-1', 'a1')).toMatchObject({ final: true, failures: 1 });
    vi.advanceTimersByTime(10_000);
    expect(redrive).not.toHaveBeenCalled();
  });

  it('backs off after a non-final failure and re-drives exactly once when it ends', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    attempt('a1');
    budget.recordFailure('job-1', 'a1');

    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.backoff);
    vi.advanceTimersByTime(999);
    // fails-when: the retry ignores the backoff
    expect(redrive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(redrive).toHaveBeenCalledWith('job-1');
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
    vi.advanceTimersByTime(10_000);
    expect(redrive).toHaveBeenCalledTimes(1);
  });

  it('a release during the backoff cancels the re-drive', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    attempt('a1');
    budget.recordFailure('job-1', 'a1');
    budget.release('job-1');
    vi.advanceTimersByTime(5000);
    // fails-when: a cancelled job is re-driven
    expect(redrive).not.toHaveBeenCalled();
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.untracked);
  });

  it('a failed re-drive is logged, not thrown', async () => {
    redrive.mockRejectedValueOnce(new Error('boom'));
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 10 });
    attempt('a1');
    budget.recordFailure('job-1', 'a1');
    await vi.advanceTimersByTimeAsync(10);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rerouted job spawn retry failed',
      expect.objectContaining({ jobId: 'job-1', error: 'boom' }),
    );
  });

  it('onDelivered frees the attempt and keeps the count for a requeued job', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 2, backoffMs: 0 });
    attempt('a1');
    budget.recordFailure('job-1', 'a1');
    attempt('a2');
    budget.onDelivered('job-1');
    // The job came back: a new attempt spawns a3, and its failure is the second one.
    attempt('a3');
    expect(budget.recordFailure('job-1', 'a3')).toMatchObject({ final: true, failures: 2 });
  });

  it('a scaler deferral frees the attempt, charges nothing and re-drives when it ends', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
    attempt('a1');
    expect(budget.recordFailure('job-1', 'a1')).toMatchObject({ final: false, failures: 1 });
    vi.advanceTimersByTime(1000);
    expect(redrive).toHaveBeenCalledTimes(1);

    // The re-drive's request met the scaler's 30 s launch deferral.
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
    budget.deferAttempt('job-1', 30_000);
    expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.backoff);
    vi.advanceTimersByTime(29_999);
    expect(redrive).toHaveBeenCalledTimes(1);
    // fails-when: the deferred attempt is dropped — nothing asks the scaler again
    vi.advanceTimersByTime(1);
    expect(redrive).toHaveBeenCalledTimes(2);

    // breaks-if-wrong: the deferral is charged as a failed attempt
    attempt('a2');
    expect(budget.recordFailure('job-1', 'a2')).toMatchObject({ final: false, failures: 2 });
  });

  it('register is idempotent', () => {
    budget.register('job-1', 'run-1', { maxAttempts: 1, backoffMs: 0 });
    budget.register('job-1', 'run-1', { maxAttempts: 5, backoffMs: 0 });
    attempt('a1');
    expect(budget.recordFailure('job-1', 'a1')).toMatchObject({ final: true, maxAttempts: 1 });
  });

  describe('only the spawn holding the gate is charged', () => {
    it('a superseded spawn failing late leaves the budget and the gate as they were', () => {
      budget.register('job-1', 'run-1', { maxAttempts: 2, backoffMs: 1000 });
      // a1's agent registered and took the job, then dropped it: the job is back.
      attempt('a1');
      budget.onDelivered('job-1');
      // A newer spawn a2 is in flight when a1's late failure arrives.
      attempt('a2');

      // fails-when: the late failure is charged — with maxAttempts 2 the next a2
      // failure would then be final, and the cleared gate would admit a second
      // concurrent spawn
      expect(budget.recordFailure('job-1', 'a1')).toEqual({ tracked: false });
      expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum['in-flight']);
      vi.advanceTimersByTime(5000);
      expect(redrive).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Ignoring a superseded spawn's failure for a rerouted job",
        expect.objectContaining({ jobId: 'job-1', agentId: 'a1', holder: 'a2' }),
      );

      // breaks-if-wrong: the gate holder's own failure is still charged, as the first one
      expect(budget.recordFailure('job-1', 'a2')).toMatchObject({
        tracked: true,
        final: false,
        failures: 1,
      });
    });

    it('a failure while no attempt is in flight is not charged', () => {
      budget.register('job-1', 'run-1', { maxAttempts: 1, backoffMs: 1000 });
      expect(budget.recordFailure('job-1', 'a1')).toEqual({ tracked: false });
    });

    it('charges the in-flight attempt before the scaler named its agent, and then ignores the late name', () => {
      budget.register('job-1', 'run-1', { maxAttempts: 3, backoffMs: 1000 });
      expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.begun);
      // breaks-if-wrong: a spawn that fails before requestScale returned is still charged
      expect(budget.recordFailure('job-1', 'a1')).toMatchObject({ tracked: true, failures: 1 });
      budget.setHolder('job-1', 'a1');
      expect(budget.beginAttempt('job-1')).toBe(SpawnAttemptGate.enum.backoff);
    });
  });
});
