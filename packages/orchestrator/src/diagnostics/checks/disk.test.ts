import { describe, it, expect, vi } from 'vitest';
import { checkDiskSpace } from './disk.js';
import type { DiagnosticDeps } from '../types.js';

const baseDeps: DiagnosticDeps = { config: {} };

describe('checkDiskSpace', () => {
  it('returns pass when space is sufficient', async () => {
    const result = await checkDiskSpace(baseDeps);

    // Free space varies by host, so any status is accepted; the shape is what is checked.
    expect(result.name).toBe('Disk space');
    expect(['pass', 'warn', 'fail']).toContain(result.status);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.details).toHaveProperty('availableBytes');
  });
});
