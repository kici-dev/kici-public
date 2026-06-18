import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOrchestratorScheduledJobsForTesting,
  findOrchestratorScheduledJob,
  registerOrchestratorScheduledJob,
} from './scheduled-job.js';

describe('registerOrchestratorScheduledJob', () => {
  afterEach(() => {
    __resetOrchestratorScheduledJobsForTesting();
    vi.useRealTimers();
  });

  it('calls the handler on each interval tick', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 1000,
      handler,
      instanceId: 'orch-1',
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(handler).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('runs synchronously on register when runOnStart is true', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 10_000,
      handler,
      instanceId: 'orch-1',
      runOnStart: true,
    });
    // runOnStart fires via microtask; flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('triggerNow awaits a single additional tick and returns its outcome', async () => {
    const handler = vi.fn(async () => {});
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 60_000,
      handler,
      instanceId: 'orch-1',
    });
    const result = await handle.triggerNow();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('triggerNow surfaces handler errors in the outcome', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 60_000,
      handler,
      instanceId: 'orch-1',
    });
    const result = await handle.triggerNow();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
    handle.stop();
  });

  it('stop clears the interval and unregisters the handle', async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async () => {});
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 1000,
      handler,
      instanceId: 'orch-1',
    });
    expect(findOrchestratorScheduledJob('cleanup')).toBeDefined();
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(0);
    expect(findOrchestratorScheduledJob('cleanup')).toBeUndefined();
  });

  it('rejects duplicate registration of the same name', () => {
    const handler = vi.fn(async () => {});
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 1000,
      handler,
      instanceId: 'orch-1',
    });
    expect(() =>
      registerOrchestratorScheduledJob({
        name: 'cleanup',
        intervalMs: 1000,
        handler,
        instanceId: 'orch-1',
      }),
    ).toThrow(/duplicate registration/);
    handle.stop();
  });

  it('rejects non-positive intervalMs', () => {
    const handler = vi.fn(async () => {});
    expect(() =>
      registerOrchestratorScheduledJob({
        name: 'cleanup',
        intervalMs: 0,
        handler,
        instanceId: 'orch-1',
      }),
    ).toThrow(/intervalMs must be > 0/);
  });

  it('triggerNow while a tick is in flight joins the same run', async () => {
    let resolve: (() => void) | null = null;
    const handler = vi.fn(async () => {
      await new Promise<void>((r) => {
        resolve = r;
      });
    });
    const handle = registerOrchestratorScheduledJob({
      name: 'cleanup',
      intervalMs: 60_000,
      handler,
      instanceId: 'orch-1',
    });
    const p1 = handle.triggerNow();
    const p2 = handle.triggerNow();
    // Both promises share the same underlying run.
    expect(resolve).not.toBeNull();
    resolve!();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(handler).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
