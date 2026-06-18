import { describe, it, expect } from 'vitest';
import { checkConfigValidity } from './config.js';
import type { DiagnosticDeps } from '../types.js';

describe('checkConfigValidity', () => {
  it('returns pass for valid config', async () => {
    const result = await checkConfigValidity({
      config: {
        mode: 'independent',
        databaseUrl: 'postgres://localhost/test',
        port: 4000,
      },
    } as DiagnosticDeps);

    expect(result.status).toBe('pass');
    expect(result.name).toBe('Config validity');
  });

  it('returns fail for missing required fields', async () => {
    const result = await checkConfigValidity({
      config: {},
    } as DiagnosticDeps);

    expect(result.status).toBe('fail');
    expect(result.message).toContain('invalid');
  });
});
