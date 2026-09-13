import { describe, it, expect, vi } from 'vitest';
import { BuildCoordinator } from './build-coordinator.js';

describe('BuildCoordinator', () => {
  // ── Single build ────────────────────────────────────────────────

  it('calls triggerBuild once and resolves', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });
    const triggerBuild = vi.fn().mockResolvedValue(undefined);

    await coordinator.ensureBuild('hash-1', triggerBuild);

    expect(triggerBuild).toHaveBeenCalledOnce();
  });

  // ── Coalescing ──────────────────────────────────────────────────

  it('coalesces concurrent builds for the same hash', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });

    let resolveManual!: () => void;
    const buildPromise = new Promise<void>((r) => {
      resolveManual = r;
    });
    const triggerBuild = vi.fn().mockReturnValue(buildPromise);

    // Fire two concurrent ensureBuild calls
    const p1 = coordinator.ensureBuild('hash-same', triggerBuild);
    const p2 = coordinator.ensureBuild('hash-same', triggerBuild);

    // triggerBuild should only be called once (coalescing)
    expect(triggerBuild).toHaveBeenCalledOnce();

    // Both should be the same promise reference
    expect(p1).toBe(p2);

    // Resolve the build
    resolveManual();
    await p1;
    await p2;
  });

  // ── Different hashes ──────────────────────────────────────────

  it('runs separate builds for different hashes', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });

    const triggerA = vi.fn().mockResolvedValue(undefined);
    const triggerB = vi.fn().mockResolvedValue(undefined);

    await coordinator.ensureBuild('hash-a', triggerA);
    await coordinator.ensureBuild('hash-b', triggerB);

    expect(triggerA).toHaveBeenCalledOnce();
    expect(triggerB).toHaveBeenCalledOnce();
  });

  // ── Failure propagation ────────────────────────────────────────

  it('propagates build failure to all waiters', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });

    let rejectManual!: (err: Error) => void;
    const buildPromise = new Promise<void>((_, reject) => {
      rejectManual = reject;
    });
    const triggerBuild = vi.fn().mockReturnValue(buildPromise);

    const p1 = coordinator.ensureBuild('hash-fail', triggerBuild);
    const p2 = coordinator.ensureBuild('hash-fail', triggerBuild);

    const buildError = new Error('rolldown compilation failed');
    rejectManual(buildError);

    await expect(p1).rejects.toThrow('rolldown compilation failed');
    await expect(p2).rejects.toThrow('rolldown compilation failed');

    expect(triggerBuild).toHaveBeenCalledOnce();
  });

  // ── Timeout ─────────────────────────────────────────────────────

  it('rejects all waiters on timeout', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 50 }); // 50ms timeout

    // Build that never resolves
    const triggerBuild = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    const p1 = coordinator.ensureBuild('hash-timeout', triggerBuild);
    const p2 = coordinator.ensureBuild('hash-timeout', triggerBuild);

    await expect(p1).rejects.toThrow(/Build timeout.*hash-timeout.*exceeded 50ms/);
    await expect(p2).rejects.toThrow(/Build timeout.*hash-timeout.*exceeded 50ms/);
  });

  // ── Cleanup after completion ───────────────────────────────────

  it('isBuilding returns false after build completes', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });
    const triggerBuild = vi.fn().mockResolvedValue(undefined);

    expect(coordinator.isBuilding('hash-done')).toBe(false);

    await coordinator.ensureBuild('hash-done', triggerBuild);

    // Allow cleanup microtask to run
    await new Promise((r) => setTimeout(r, 10));

    expect(coordinator.isBuilding('hash-done')).toBe(false);
    expect(coordinator.getInFlightCount()).toBe(0);
  });

  it('isBuilding returns true during build', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });

    let resolveManual!: () => void;
    const buildPromise = new Promise<void>((r) => {
      resolveManual = r;
    });
    const triggerBuild = vi.fn().mockReturnValue(buildPromise);

    const ensurePromise = coordinator.ensureBuild('hash-active', triggerBuild);

    expect(coordinator.isBuilding('hash-active')).toBe(true);
    expect(coordinator.getInFlightCount()).toBe(1);

    resolveManual();
    await ensurePromise;
  });

  // ── Re-entry after completion ──────────────────────────────────

  it('allows new build after previous one completes', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 5_000 });
    const triggerBuild = vi.fn().mockResolvedValue(undefined);

    await coordinator.ensureBuild('hash-reentry', triggerBuild);

    // Allow cleanup microtask
    await new Promise((r) => setTimeout(r, 10));

    await coordinator.ensureBuild('hash-reentry', triggerBuild);

    expect(triggerBuild).toHaveBeenCalledTimes(2);
  });

  // ── Timer cleanup ─────────────────────────────────────────────

  it('clears timeout timer when build completes before timeout', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 60_000 });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const triggerBuild = vi.fn().mockResolvedValue(undefined);
    await coordinator.ensureBuild('hash-timer', triggerBuild);

    // The timer should have been cleared via .finally()
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('clears timeout timer when build fails before timeout', async () => {
    const coordinator = new BuildCoordinator({ timeoutMs: 60_000 });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const triggerBuild = vi.fn().mockRejectedValue(new Error('build failed'));
    await expect(coordinator.ensureBuild('hash-timer-fail', triggerBuild)).rejects.toThrow(
      'build failed',
    );

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
