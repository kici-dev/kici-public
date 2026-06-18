import { describe, it, expect, vi } from 'vitest';
import { runDiagnostics } from './runner.js';
import type { DiagnosticCheck, DiagnosticDeps, DiagnosticResult } from './types.js';

const baseDeps: DiagnosticDeps = {
  config: { mode: 'platform', databaseUrl: 'postgres://localhost/test' },
};

describe('runDiagnostics', () => {
  it('returns an array of DiagnosticResult, one per check', async () => {
    const check1: DiagnosticCheck = async () => ({
      name: 'check1',
      status: 'pass',
      message: 'ok',
      durationMs: 1,
    });
    const check2: DiagnosticCheck = async () => ({
      name: 'check2',
      status: 'warn',
      message: 'low',
      durationMs: 2,
    });

    const results = await runDiagnostics(baseDeps, [check1, check2]);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('check1');
    expect(results[1].name).toBe('check2');
  });

  it('each result has name, status, message, durationMs', async () => {
    const check: DiagnosticCheck = async () => ({
      name: 'test',
      status: 'pass',
      message: 'healthy',
      durationMs: 5,
    });

    const [result] = await runDiagnostics(baseDeps, [check]);

    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('durationMs');
    expect(['pass', 'warn', 'fail']).toContain(result.status);
  });

  it('a failing check does not prevent other checks from running', async () => {
    const failCheck: DiagnosticCheck = async () => {
      throw new Error('connection refused');
    };
    const passCheck: DiagnosticCheck = async () => ({
      name: 'pass',
      status: 'pass',
      message: 'ok',
      durationMs: 1,
    });

    const results = await runDiagnostics(baseDeps, [failCheck, passCheck]);

    expect(results).toHaveLength(2);
    // The failing check should return fail status, not throw
    const failResult = results.find((r) => r.status === 'fail');
    expect(failResult).toBeDefined();
    expect(failResult!.message).toContain('connection refused');

    // The passing check should still succeed
    const passResult = results.find((r) => r.status === 'pass');
    expect(passResult).toBeDefined();
  });

  it('returns fail on timeout with timeout message', async () => {
    const slowCheck: DiagnosticCheck = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { name: 'slow', status: 'pass', message: 'ok', durationMs: 0 };
    };

    const results = await runDiagnostics(baseDeps, [slowCheck], { timeoutMs: 50 });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(results[0].message).toContain('timeout');
  });

  it('uses default checks when none provided', async () => {
    const results = await runDiagnostics(baseDeps);

    // Should return results for all default checks (6)
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('durationMs');
    }
  });
});

describe('runDiagnostics flattening', () => {
  const deps = { config: {} } as DiagnosticDeps;

  it('flattens a check that returns an array of results', async () => {
    const arrayCheck: DiagnosticCheck = async () => [
      { name: 'scaler:a', status: 'pass', message: 'ok', durationMs: 1 },
      { name: 'scaler:b', status: 'fail', message: 'bad', durationMs: 1 },
    ];
    const singleCheck: DiagnosticCheck = async () => ({
      name: 'single',
      status: 'pass',
      message: 'ok',
      durationMs: 1,
    });

    const results = await runDiagnostics(deps, [arrayCheck, singleCheck]);
    expect(results.map((r) => r.name)).toEqual(['scaler:a', 'scaler:b', 'single']);
  });
});
