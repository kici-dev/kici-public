import { describe, it, expect, vi } from 'vitest';
import { runDeclaredCleanupOutOfBand } from './cleanup-rerun.js';

const base = {
  workDir: '/tmp/kici-preserved',
  backend: 'bare-metal' as const,
  declaresCleanup: true,
  timeoutMs: 1000,
};

describe('runDeclaredCleanupOutOfBand', () => {
  it('skips when the workflow declares no cleanup', async () => {
    const spawn = vi.fn();
    const r = await runDeclaredCleanupOutOfBand({ ...base, declaresCleanup: false, spawn });
    expect(r.status).toBe('skipped');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips on a non-bare-metal backend', async () => {
    const spawn = vi.fn();
    const r = await runDeclaredCleanupOutOfBand({ ...base, backend: 'container', spawn });
    expect(r.status).toBe('skipped');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips on a non-positive timeout', async () => {
    const spawn = vi.fn();
    const r = await runDeclaredCleanupOutOfBand({ ...base, timeoutMs: 0, spawn });
    expect(r.status).toBe('skipped');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns success when the cleanup-only spawn resolves', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined);
    const r = await runDeclaredCleanupOutOfBand({ ...base, spawn });
    expect(r.status).toBe('success');
    expect(spawn).toHaveBeenCalledWith('/tmp/kici-preserved', expect.any(AbortSignal));
  });

  it('returns failed when the spawn throws', async () => {
    const spawn = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runDeclaredCleanupOutOfBand({ ...base, spawn });
    expect(r.status).toBe('failed');
  });

  it('returns timeout when the spawn outlives the timeout', async () => {
    const spawn = (_w: string, signal: AbortSignal) =>
      new Promise<void>((_res, rej) =>
        signal.addEventListener('abort', () => rej(new Error('aborted'))),
      );
    const r = await runDeclaredCleanupOutOfBand({ ...base, timeoutMs: 50, spawn });
    expect(r.status).toBe('timeout');
  });
});
