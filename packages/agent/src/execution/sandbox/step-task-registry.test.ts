import { describe, it, expect, vi } from 'vitest';
import { StepTaskRegistry } from './step-task-registry.js';

const slot = (log: string[], dispose = vi.fn().mockResolvedValue(undefined)) => ({
  secrets: {
    getAccessLog: () => log,
    getMountRecords: () => [],
  } as never,
  dispose,
});

describe('StepTaskRegistry', () => {
  it('keeps two concurrent slots independent (no single-slot clobber)', () => {
    const reg = new StepTaskRegistry();
    reg.set(0, slot(['SECRET_A']));
    reg.set(1, slot(['SECRET_B']));
    expect(reg.getAccessLog(0)).toEqual(['SECRET_A']);
    expect(reg.getAccessLog(1)).toEqual(['SECRET_B']);
  });

  it('disposes only the named index and forgets it', async () => {
    const reg = new StepTaskRegistry();
    const dA = vi.fn().mockResolvedValue(undefined);
    const dB = vi.fn().mockResolvedValue(undefined);
    reg.set(0, slot([], dA));
    reg.set(1, slot([], dB));
    await reg.dispose(0);
    expect(dA).toHaveBeenCalledOnce();
    expect(dB).not.toHaveBeenCalled();
    expect(reg.getAccessLog(0)).toEqual([]); // gone
  });

  it('returns empty audit data for an unknown index', () => {
    const reg = new StepTaskRegistry();
    expect(reg.getAccessLog(99)).toEqual([]);
    expect(reg.getMountRecords(99)).toEqual([]);
  });

  it('dispose of an unknown index is a no-op', async () => {
    const reg = new StepTaskRegistry();
    await expect(reg.dispose(42)).resolves.toBeUndefined();
  });
});
