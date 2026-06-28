import { describe, expect, it } from 'vitest';
import {
  orchCapabilitiesSchema,
  OrchRole,
  ORCH_CAPABILITIES,
  hasOrchCapability,
} from './capabilities.js';

describe('OrchRole', () => {
  it('has coordinator and worker values', () => {
    expect(OrchRole.enum.coordinator).toBe('coordinator');
    expect(OrchRole.enum.worker).toBe('worker');
  });

  it('parses valid values', () => {
    expect(OrchRole.parse('coordinator')).toBe('coordinator');
    expect(OrchRole.parse('worker')).toBe('worker');
  });

  it('rejects invalid values', () => {
    expect(() => OrchRole.parse('invalid')).toThrow();
    expect(() => OrchRole.parse('')).toThrow();
  });
});

describe('orchCapabilitiesSchema', () => {
  it('accepts empty object (backward compat with pre-capability orchestrators)', () => {
    const result = orchCapabilitiesSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts full capabilities object', () => {
    const caps = { orchRole: 'coordinator' };
    const result = orchCapabilitiesSchema.parse(caps);
    expect(result).toEqual(caps);
  });

  it('accepts worker role', () => {
    const result = orchCapabilitiesSchema.parse({ orchRole: 'worker' });
    expect(result.orchRole).toBe('worker');
  });

  it('rejects invalid orchRole', () => {
    expect(() => orchCapabilitiesSchema.parse({ orchRole: 'invalid' })).toThrow();
  });

  it('preserves unknown flags via passthrough', () => {
    const result = orchCapabilitiesSchema.parse({
      orchRole: 'coordinator',
      futureFlag: true,
      anotherFlag: 42,
    });
    expect(result).toEqual({ orchRole: 'coordinator', futureFlag: true, anotherFlag: 42 });
  });
});

describe('ORCH_CAPABILITIES', () => {
  it('has orchRole set to coordinator', () => {
    expect(ORCH_CAPABILITIES.orchRole).toBe('coordinator');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ORCH_CAPABILITIES)).toBe(true);
  });
});

describe('hasOrchCapability', () => {
  it('returns false for undefined capabilities', () => {
    expect(hasOrchCapability(undefined, 'someFlag')).toBe(false);
  });

  it('returns false for missing flag', () => {
    expect(hasOrchCapability({}, 'someFlag')).toBe(false);
  });

  it('returns false for non-true value (enum fields like orchRole)', () => {
    const caps = orchCapabilitiesSchema.parse({ orchRole: 'coordinator' });
    expect(hasOrchCapability(caps, 'orchRole')).toBe(false);
  });

  it('returns true for flag set to true', () => {
    const caps = orchCapabilitiesSchema.parse({ futureFlag: true });
    expect(hasOrchCapability(caps, 'futureFlag')).toBe(true);
  });

  it('returns false for flag set to false', () => {
    const caps = orchCapabilitiesSchema.parse({ futureFlag: false });
    expect(hasOrchCapability(caps, 'futureFlag')).toBe(false);
  });
});

describe('orch capabilities dashboard-request manifest', () => {
  it('advertises the supported dashboard request set', () => {
    expect(ORCH_CAPABILITIES.supportedDashboardRequests).toContain(
      'dashboard.environments.bindings.set',
    );
  });
  it('parses a capabilities object carrying the manifest', () => {
    const parsed = orchCapabilitiesSchema.parse({
      orchRole: 'coordinator',
      supportedDashboardRequests: ['dashboard.environments.bindings.set'],
    });
    expect(parsed.supportedDashboardRequests).toHaveLength(1);
  });
});
