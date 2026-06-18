import { describe, it, expect, vi } from 'vitest';
import { checkDbConnectivity } from './db.js';
import type { DiagnosticDeps } from '../types.js';

describe('checkDbConnectivity', () => {
  it('returns pass when query succeeds', async () => {
    const mockDb = {
      selectFrom: () => ({
        select: () => ({
          limit: () => ({
            execute: vi.fn().mockResolvedValue([{ result: 1 }]),
          }),
        }),
      }),
    } as any;

    const result = await checkDbConnectivity({
      config: {},
      db: mockDb,
    } as DiagnosticDeps);

    expect(result.status).toBe('pass');
    expect(result.name).toBe('Database connectivity');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns fail when connection refused', async () => {
    const mockDb = {
      selectFrom: () => ({
        select: () => ({
          limit: () => ({
            execute: vi.fn().mockRejectedValue(new Error('connection refused')),
          }),
        }),
      }),
    } as any;

    const result = await checkDbConnectivity({
      config: {},
      db: mockDb,
    } as DiagnosticDeps);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('connection refused');
  });

  it('returns fail when no DB configured', async () => {
    const result = await checkDbConnectivity({
      config: {},
    } as DiagnosticDeps);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('not configured');
  });
});
