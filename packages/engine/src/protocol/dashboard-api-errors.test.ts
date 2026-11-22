import { describe, it, expect } from 'vitest';
import { DashboardApiErrorCode } from './dashboard-api-errors.js';

describe('DashboardApiErrorCode', () => {
  it('exposes orchestrator_not_found', () => {
    expect(DashboardApiErrorCode.enum.orchestrator_not_found).toBe('orchestrator_not_found');
  });

  it('exposes session_max_age_exceeded', () => {
    expect(DashboardApiErrorCode.enum.session_max_age_exceeded).toBe('session_max_age_exceeded');
  });

  it('exposes run_outside_retention', () => {
    expect(DashboardApiErrorCode.enum.run_outside_retention).toBe('run_outside_retention');
  });

  it('exposes invite_email_mismatch', () => {
    expect(DashboardApiErrorCode.enum.invite_email_mismatch).toBe('invite_email_mismatch');
  });

  it('exposes the org-creation refusals', () => {
    expect(DashboardApiErrorCode.enum.org_creation_disabled).toBe('org_creation_disabled');
    expect(DashboardApiErrorCode.enum.org_limit_reached).toBe('org_limit_reached');
    expect(DashboardApiErrorCode.enum.org_creation_owner_only).toBe('org_creation_owner_only');
  });

  it('exposes client_newer_than_platform', () => {
    expect(DashboardApiErrorCode.enum.client_newer_than_platform).toBe(
      'client_newer_than_platform',
    );
  });

  it('rejects an unknown code', () => {
    expect(DashboardApiErrorCode.safeParse('nope').success).toBe(false);
  });
});
