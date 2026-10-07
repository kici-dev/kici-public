import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from './sleep.js';

describe('sleep', () => {
  afterEach(() => vi.useRealTimers());

  // fails-when: the promise resolves before the delay elapses
  it('resolves only after the delay elapses', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});
