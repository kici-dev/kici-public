import { describe, it, expect } from 'vitest';
import { checkDiskSpace } from './disk.js';
import type { DiagnosticDeps } from '../types.js';

const baseDeps: DiagnosticDeps = { config: {} };
const GB = 1024 * 1024 * 1024;

describe('checkDiskSpace', () => {
  it('reads the real root filesystem with no external tool', async () => {
    // fails-when: the check spawns df, which a distroless orchestrator image does not ship
    const result = await checkDiskSpace(baseDeps);
    expect(result.name).toBe('Disk space');
    expect(result.message).not.toMatch(/Disk check failed/);
    expect(result.details?.availableBytes).toBeGreaterThan(0);
  });

  it('passes, warns and fails on the thresholds', async () => {
    const at = (bytes: number) => checkDiskSpace(baseDeps, async () => bytes);
    expect((await at(5 * GB)).status).toBe('pass');
    expect((await at(0.5 * GB)).status).toBe('warn');
    expect((await at(50 * 1024 * 1024)).status).toBe('fail');
  });

  it('reports a read failure as a failed check', async () => {
    const result = await checkDiskSpace(baseDeps, async () => {
      throw new Error('statfs EACCES');
    });
    expect(result).toMatchObject({ status: 'fail', message: 'Disk check failed: statfs EACCES' });
  });
});
