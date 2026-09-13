import { describe, it, expect } from 'vitest';
import {
  DIAGNOSE_STATUSES,
  diagnoseExitCode,
  deriveDiagnoseOverall,
} from './diagnostics-contract.js';

describe('diagnostics-contract', () => {
  it('exposes the status vocabulary as a single source of truth', () => {
    expect(DIAGNOSE_STATUSES).toEqual(['pass', 'warn', 'fail']);
  });

  it('diagnoseExitCode returns 0 when all checks pass', () => {
    expect(diagnoseExitCode([{ status: 'pass' }, { status: 'pass' }])).toBe(0);
  });

  it('diagnoseExitCode returns 1 when a warn is present and no fail', () => {
    expect(diagnoseExitCode([{ status: 'pass' }, { status: 'warn' }])).toBe(1);
  });

  it('diagnoseExitCode returns 2 when any check fails (fail dominates warn)', () => {
    expect(diagnoseExitCode([{ status: 'warn' }, { status: 'fail' }])).toBe(2);
  });

  it('deriveDiagnoseOverall maps pass/warn/fail to healthy/degraded/unhealthy', () => {
    expect(deriveDiagnoseOverall([{ status: 'pass' }])).toBe('healthy');
    expect(deriveDiagnoseOverall([{ status: 'pass' }, { status: 'warn' }])).toBe('degraded');
    expect(deriveDiagnoseOverall([{ status: 'warn' }, { status: 'fail' }])).toBe('unhealthy');
  });
});
