import { describe, it, expect } from 'vitest';
import { DashboardApiErrorCode } from './dashboard-api-errors.js';

describe('DashboardApiErrorCode', () => {
  it('exposes orchestrator_not_found', () => {
    expect(DashboardApiErrorCode.enum.orchestrator_not_found).toBe('orchestrator_not_found');
  });

  it('exposes session_max_age_exceeded', () => {
    expect(DashboardApiErrorCode.enum.session_max_age_exceeded).toBe('session_max_age_exceeded');
  });

  it('rejects an unknown code', () => {
    expect(DashboardApiErrorCode.safeParse('nope').success).toBe(false);
  });
});
