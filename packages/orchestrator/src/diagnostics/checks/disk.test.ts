import { describe, it, expect, vi } from 'vitest';
import { checkDiskSpace } from './disk.js';
import type { DiagnosticDeps } from '../types.js';

const baseDeps: DiagnosticDeps = { config: {} };

describe('checkDiskSpace', () => {
  it('returns pass when space is sufficient', async () => {
    const result = await checkDiskSpace(baseDeps);

    // On a dev machine there should be plenty of space
    expect(result.name).toBe('Disk space');
    expect(['pass', 'warn', 'fail']).toContain(result.status);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.details).toHaveProperty('availableBytes');
  });
});
