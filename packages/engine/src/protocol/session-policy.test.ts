import { describe, it, expect } from 'vitest';
import {
  SESSION_MAX_AGE_MIN_SECONDS,
  SESSION_MAX_AGE_MAX_SECONDS,
  SESSION_MAX_AGE_DEFAULT_SECONDS,
  DASHBOARD_KEYCLOAK_CLIENT_ID,
} from './session-policy.js';

describe('session-policy constants', () => {
  it('has coherent bounds with default inside the range', () => {
    expect(SESSION_MAX_AGE_MIN_SECONDS).toBe(3600);
    expect(SESSION_MAX_AGE_MAX_SECONDS).toBe(2592000);
    expect(SESSION_MAX_AGE_DEFAULT_SECONDS).toBe(604800);
    expect(SESSION_MAX_AGE_DEFAULT_SECONDS).toBeGreaterThanOrEqual(SESSION_MAX_AGE_MIN_SECONDS);
    expect(SESSION_MAX_AGE_DEFAULT_SECONDS).toBeLessThanOrEqual(SESSION_MAX_AGE_MAX_SECONDS);
  });

  it('names the dashboard keycloak client', () => {
    expect(DASHBOARD_KEYCLOAK_CLIENT_ID).toBe('kici-dashboard');
  });
});
