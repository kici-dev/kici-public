import { describe, it, expect, vi } from 'vitest';
import { exitWithStartupBackoff, STARTUP_BACKOFF_MS } from './startup-backoff.js';

describe('exitWithStartupBackoff', () => {
  it('sleeps for the backoff then exits with code 1', async () => {
    const sleep = vi.fn(async () => {});
    const exit = vi.fn(() => undefined as never);

    await exitWithStartupBackoff('boom', { sleep, exit });

    expect(sleep).toHaveBeenCalledWith(STARTUP_BACKOFF_MS);
    expect(exit).toHaveBeenCalledWith(1);
    // sleep happens before exit
    expect(sleep.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  });

  it('honors a custom backoffMs', async () => {
    const sleep = vi.fn(async () => {});
    const exit = vi.fn(() => undefined as never);

    await exitWithStartupBackoff('boom', { backoffMs: 5, sleep, exit });

    expect(sleep).toHaveBeenCalledWith(5);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
