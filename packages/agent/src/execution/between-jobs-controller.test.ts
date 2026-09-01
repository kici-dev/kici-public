import { describe, it, expect, vi } from 'vitest';
import { BetweenJobsController, type AfterJobContext } from './between-jobs-controller.js';

function baseConfig(overrides = {}) {
  return {
    betweenJobsResetCommand: 'reset.sh',
    betweenJobsResetTimeoutMs: 1000,
    betweenJobsResetRunOn: 'always' as const,
    orphanCleanup: true,
    drainOnResetFailure: false,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<AfterJobContext> = {}): AfterJobContext {
  return {
    completionHooksRan: true,
    jobFailed: false,
    backend: 'bare-metal',
    declaresCleanup: false,
    workDir: '/tmp/x',
    reap: vi.fn().mockResolvedValue(0),
    deleteWorkdir: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('BetweenJobsController.afterJob', () => {
  it('runs reap → deleteWorkdir → reset in order (rerun skipped when hooks ran)', async () => {
    const order: string[] = [];
    const reap = vi.fn(async () => {
      order.push('reap');
      return 2;
    });
    const deleteWorkdir = vi.fn(async () => {
      order.push('delete');
    });
    const reset = vi.fn(async () => {
      order.push('reset');
      return { status: 'success' as const, durationMs: 5 };
    });
    const c = new BetweenJobsController({ config: baseConfig(), reset });
    const out = await c.afterJob(baseCtx({ reap, deleteWorkdir }));
    expect(order).toEqual(['reap', 'delete', 'reset']);
    expect(out.rerun).toBe('skipped');
    expect(out.reaped).toBe(2);
    expect(out.reset).toBe('success');
  });

  it('re-runs cleanup out-of-band when completion hooks did not run', async () => {
    const rerun = vi.fn().mockResolvedValue({ status: 'success', durationMs: 10 });
    const reset = vi.fn().mockResolvedValue({ status: 'skipped', durationMs: 0 });
    const c = new BetweenJobsController({ config: baseConfig(), rerun, reset });
    const out = await c.afterJob(
      baseCtx({
        completionHooksRan: false,
        jobFailed: true,
        declaresCleanup: true,
        cleanupSpawn: vi.fn().mockResolvedValue(undefined),
      }),
    );
    expect(rerun).toHaveBeenCalled();
    expect(out.rerun).toBe('success');
  });

  it('does not re-run cleanup when no cleanupSpawn is provided', async () => {
    const rerun = vi.fn();
    const reset = vi.fn().mockResolvedValue({ status: 'skipped', durationMs: 0 });
    const c = new BetweenJobsController({ config: baseConfig(), rerun, reset });
    const out = await c.afterJob(baseCtx({ completionHooksRan: false }));
    expect(rerun).not.toHaveBeenCalled();
    expect(out.rerun).toBe('skipped');
  });

  it('counts consecutive reset failures across calls, resetting on success', async () => {
    const reset = vi.fn().mockResolvedValue({ status: 'failed', durationMs: 5 });
    const c = new BetweenJobsController({ config: baseConfig(), reset });
    const a = await c.afterJob(baseCtx());
    const b = await c.afterJob(baseCtx());
    expect(a.consecutiveResetFailures).toBe(1);
    expect(b.consecutiveResetFailures).toBe(2);
    reset.mockResolvedValue({ status: 'success', durationMs: 5 });
    const d = await c.afterJob(baseCtx());
    expect(d.consecutiveResetFailures).toBe(0);
  });

  it('still runs the operator reset when reap rejects', async () => {
    const reset = vi.fn().mockResolvedValue({ status: 'success', durationMs: 5 });
    const deleteWorkdir = vi.fn().mockResolvedValue(undefined);
    const c = new BetweenJobsController({ config: baseConfig(), reset });
    const out = await c.afterJob(
      baseCtx({ reap: vi.fn().mockRejectedValue(new Error('reap boom')), deleteWorkdir }),
    );
    expect(deleteWorkdir).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
    expect(out.reset).toBe('success');
  });

  it('still runs the operator reset when deleteWorkdir rejects', async () => {
    const reset = vi.fn().mockResolvedValue({ status: 'success', durationMs: 5 });
    const c = new BetweenJobsController({ config: baseConfig(), reset });
    const out = await c.afterJob(
      baseCtx({ deleteWorkdir: vi.fn().mockRejectedValue(new Error('delete boom')) }),
    );
    expect(reset).toHaveBeenCalled();
    expect(out.reset).toBe('success');
  });

  it('skips reaping when orphanCleanup is off', async () => {
    const reap = vi.fn().mockResolvedValue(9);
    const reset = vi.fn().mockResolvedValue({ status: 'skipped', durationMs: 0 });
    const c = new BetweenJobsController({ config: baseConfig({ orphanCleanup: false }), reset });
    const out = await c.afterJob(baseCtx({ reap }));
    expect(reap).not.toHaveBeenCalled();
    expect(out.reaped).toBe(0);
  });
});
