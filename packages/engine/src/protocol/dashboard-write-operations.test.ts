import { describe, it, expect } from 'vitest';
import {
  DashboardWriteOperation,
  DashboardWritePolicyState,
  DASHBOARD_WRITE_OPERATIONS,
  DASHBOARD_WRITE_OPERATIONS_BY_NAME,
  DASHBOARD_WRITE_OPERATIONS_BY_WIRE_TYPE,
  DASHBOARD_WRITE_OPERATION_VALUES,
  coerceDashboardWritePolicyValue,
  dashboardWritePolicyMapSchema,
  getDashboardWriteOperationDescriptor,
  getDashboardWriteOperationsByCategory,
  getDashboardWriteOperationsBySensitivity,
  isDashboardWriteOperationEnabled,
  isEncryptedState,
  resolvePolicyState,
  resolveFullPolicyStateView,
} from './dashboard-write-operations.js';

describe('DashboardWriteOperation enum', () => {
  it('has 27 values', () => {
    expect(DashboardWriteOperation.options).toHaveLength(27);
  });

  it('matches DASHBOARD_WRITE_OPERATION_VALUES exactly', () => {
    expect([...DASHBOARD_WRITE_OPERATION_VALUES]).toEqual(DashboardWriteOperation.options);
  });

  it('has exactly one descriptor per enum value', () => {
    expect(DASHBOARD_WRITE_OPERATIONS).toHaveLength(DashboardWriteOperation.options.length);
    for (const op of DashboardWriteOperation.options) {
      expect(DASHBOARD_WRITE_OPERATIONS_BY_NAME.has(op)).toBe(true);
    }
  });

  it('every descriptor name is a valid enum value', () => {
    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      expect(DashboardWriteOperation.options).toContain(descriptor.name);
    }
  });

  it('wire-message types are all distinct', () => {
    const wireTypes = DASHBOARD_WRITE_OPERATIONS.map((d) => d.wireMessageType);
    expect(new Set(wireTypes).size).toBe(wireTypes.length);
    expect(DASHBOARD_WRITE_OPERATIONS_BY_WIRE_TYPE.size).toBe(wireTypes.length);
  });

  it('every wire-message type starts with "dashboard."', () => {
    for (const descriptor of DASHBOARD_WRITE_OPERATIONS) {
      expect(descriptor.wireMessageType.startsWith('dashboard.')).toBe(true);
    }
  });
});

describe('getDashboardWriteOperationDescriptor', () => {
  it('returns the descriptor for a known operation', () => {
    const d = getDashboardWriteOperationDescriptor('secrets.set');
    expect(d.name).toBe('secrets.set');
    expect(d.category).toBe('Secrets');
    expect(d.sensitivity).toBe('plaintext');
    expect(d.wireMessageType).toBe('dashboard.contexts.secrets.set');
  });

  it('throws on an unknown operation', () => {
    expect(() =>
      getDashboardWriteOperationDescriptor('bogus.op' as unknown as DashboardWriteOperation),
    ).toThrow(/No descriptor registered/);
  });
});

describe('category and sensitivity filters', () => {
  it('groups secrets operations together', () => {
    const secrets = getDashboardWriteOperationsByCategory('Secrets');
    expect(secrets.map((d) => d.name)).toEqual([
      'secrets.set',
      'secrets.delete',
      'secrets.scope.create',
      'secrets.scope.rename',
      'secrets.scope.delete',
    ]);
  });

  it('returns plaintext-sensitive operations', () => {
    const plaintext = getDashboardWriteOperationsBySensitivity('plaintext');
    expect(plaintext.map((d) => d.name).sort()).toEqual(['secrets.set', 'variables.set']);
  });

  it('returns dispatch-sensitive operations', () => {
    const dispatch = getDashboardWriteOperationsBySensitivity('dispatch');
    expect(dispatch.length).toBeGreaterThan(0);
    for (const d of dispatch) {
      expect(d.sensitivity).toBe('dispatch');
    }
  });
});

describe('isDashboardWriteOperationEnabled', () => {
  it('returns true when policy is null', () => {
    expect(isDashboardWriteOperationEnabled(null, 'secrets.set')).toBe(true);
  });

  it('returns true when policy is undefined', () => {
    expect(isDashboardWriteOperationEnabled(undefined, 'secrets.set')).toBe(true);
  });

  it('returns true when the operation is not in the policy map', () => {
    expect(isDashboardWriteOperationEnabled({}, 'secrets.set')).toBe(true);
    expect(isDashboardWriteOperationEnabled({ 'variables.set': 'disabled' }, 'secrets.set')).toBe(
      true,
    );
  });

  it('returns true unless the operation is disabled', () => {
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'disabled' }, 'secrets.set')).toBe(
      false,
    );
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'permissive' }, 'secrets.set')).toBe(
      true,
    );
    expect(isDashboardWriteOperationEnabled({ 'secrets.set': 'encrypted' }, 'secrets.set')).toBe(
      true,
    );
  });
});

describe('three-state policy', () => {
  it('enum has exactly permissive/encrypted/disabled', () => {
    expect(DashboardWritePolicyState.options).toEqual(['permissive', 'encrypted', 'disabled']);
  });

  it('defaults an absent op to permissive', () => {
    expect(resolvePolicyState({}, 'secrets.set')).toBe('permissive');
    expect(resolvePolicyState(null, 'secrets.set')).toBe('permissive');
  });

  it('isEncryptedState true only for encrypted', () => {
    expect(isEncryptedState({ 'secrets.set': 'encrypted' }, 'secrets.set')).toBe(true);
    expect(isEncryptedState({ 'secrets.set': 'permissive' }, 'secrets.set')).toBe(false);
    expect(isEncryptedState({ 'secrets.set': 'disabled' }, 'secrets.set')).toBe(false);
  });

  it('rejects encrypted on a non-plaintext op', () => {
    const r = dashboardWritePolicyMapSchema.safeParse({ 'held_runs.approve': 'encrypted' });
    expect(r.success).toBe(false);
  });

  it('accepts encrypted on a plaintext op', () => {
    expect(dashboardWritePolicyMapSchema.safeParse({ 'secrets.set': 'encrypted' }).success).toBe(
      true,
    );
    expect(dashboardWritePolicyMapSchema.safeParse({ 'variables.set': 'encrypted' }).success).toBe(
      true,
    );
  });

  it('coerces legacy boolean values (true→permissive, false→disabled)', () => {
    expect(coerceDashboardWritePolicyValue(true)).toBe('permissive');
    expect(coerceDashboardWritePolicyValue(false)).toBe('disabled');
    expect(coerceDashboardWritePolicyValue('encrypted')).toBe('encrypted');
    expect(dashboardWritePolicyMapSchema.parse({ 'secrets.set': false })).toEqual({
      'secrets.set': 'disabled',
    });
    expect(dashboardWritePolicyMapSchema.parse({ 'secrets.set': true })).toEqual({
      'secrets.set': 'permissive',
    });
  });

  it('resolveFullPolicyStateView expands sparse map to all ops', () => {
    const view = resolveFullPolicyStateView({ 'secrets.set': 'encrypted' });
    expect(view['secrets.set']).toBe('encrypted');
    expect(view['held_runs.approve']).toBe('permissive');
    expect(Object.keys(view)).toHaveLength(DashboardWriteOperation.options.length);
  });
});

describe('dashboardWritePolicyMapSchema', () => {
  it('accepts an empty object', () => {
    expect(dashboardWritePolicyMapSchema.parse({})).toEqual({});
  });

  it('accepts a partial map of known operations', () => {
    const policy = { 'secrets.set': 'disabled', 'variables.set': 'disabled' } as const;
    expect(dashboardWritePolicyMapSchema.parse(policy)).toEqual(policy);
  });

  it('rejects unknown operation keys', () => {
    expect(() => dashboardWritePolicyMapSchema.parse({ 'bogus.op': 'disabled' })).toThrow();
  });

  it('rejects invalid state values', () => {
    expect(() => dashboardWritePolicyMapSchema.parse({ 'secrets.set': 'no' })).toThrow();
  });

  it('defaults to empty object when input is undefined', () => {
    expect(dashboardWritePolicyMapSchema.parse(undefined)).toEqual({});
  });
});
