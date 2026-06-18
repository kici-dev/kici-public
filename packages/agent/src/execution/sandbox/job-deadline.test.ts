import { describe, it, expect, vi } from 'vitest';
import { armJobDeadline } from './job-deadline.js';
import { TimeoutReason } from '@kici-dev/engine';

describe('armJobDeadline', () => {
  it('fires onTimeout with the job_timeout reason after the deadline', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = armJobDeadline(100, onTimeout);
    vi.advanceTimersByTime(101);
    expect(onTimeout).toHaveBeenCalledWith(TimeoutReason.enum.job_timeout, 100);
    handle.clear();
    vi.useRealTimers();
  });

  it('does not fire when timeoutMs is undefined', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = armJobDeadline(undefined, onTimeout);
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
    handle.clear();
    vi.useRealTimers();
  });

  it('does not fire after clear()', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const handle = armJobDeadline(100, onTimeout);
    handle.clear();
    vi.advanceTimersByTime(200);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
